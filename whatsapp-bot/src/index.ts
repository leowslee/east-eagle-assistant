// Connects to WhatsApp as a linked device of the assistant's number and answers staff.

import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isPnUser,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { Assistant } from "./agent.js";
import { FileAuditLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { Drive } from "./drive.js";
import { configKey, dueSchedules, hkParts, TaskStore } from "./schedule.js";
import { extractText, findStaff, groupAllowed, isAddressedToBot, stripAddress, userPart } from "./route.js";
import { SmtpMailer } from "./email.js";
import { Pms } from "./pms.js";
import { Skills } from "./skills.js";
import { FileStore } from "./store.js";

const config = loadConfig(process.argv[2] ?? "config.json");
const audit = new FileAuditLog(config.logDir);
const drive = new Drive(config.driveRoots);
// Baileys logs routine sync warnings (for example missing app-state keys after linking); show only errors.
const logger = pino({ level: "error" });

let sock: WASocket;
let retryDelayMs = 5000;
const groupNames = new Map<string, { name: string; at: number }>();

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".zip": "application/zip",
};

function mailer(): SmtpMailer | undefined {
  const pass = process.env.EMAIL_APP_PASSWORD;
  if (!config.emailFrom) return undefined;
  if (!pass) {
    console.warn(`Email is off: add EMAIL_APP_PASSWORD to .env to let ${config.assistantName} send from ${config.emailFrom}.`);
    return undefined;
  }
  return new SmtpMailer(config.emailFrom, pass, config.assistantName);
}

const skills = new Skills(config.skills);
if (config.skills.dir) console.log(`Skills: ${skills.list.map((s) => s.name).join(", ") || "none found"} (from ${config.skills.dir})`);

const tasks = new TaskStore(path.join(config.dataDir, "schedules.json"));

const assistant = new Assistant(config, drive, new FileStore(path.join(config.dataDir, "conversations")), audit, {
  async sendText(chatId, text) {
    await sock.sendMessage(chatId, { text });
  },
  async sendFile(chatId, filePath, fileName) {
    const mimetype = MIME[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
    await sock.sendMessage(chatId, { document: { url: filePath }, fileName, mimetype });
  },
  async findGroup(name) {
    const groups = await sock.groupFetchAllParticipating();
    const match = Object.values(groups).find((g) => g.subject.trim().toLowerCase() === name.trim().toLowerCase());
    return match ? { id: match.id, name: match.subject } : undefined;
  },
}, undefined, tasks, mailer(), config.pmsUrl ? new Pms(config.pmsUrl) : undefined, skills);

async function groupName(jid: string): Promise<string> {
  const cached = groupNames.get(jid);
  if (cached && Date.now() - cached.at < 3600_000) return cached.name;
  try {
    const meta = await sock.groupMetadata(jid);
    groupNames.set(jid, { name: meta.subject, at: Date.now() });
    return meta.subject;
  } catch {
    return cached?.name ?? jid;
  }
}

/** The sender's phone number. Newer WhatsApp versions may only give a privacy id (LID). */
async function senderPhone(msg: WAMessage): Promise<string | undefined> {
  const k = msg.key;
  const candidates = isJidGroup(k.remoteJid ?? "") ? [k.participant, k.participantAlt] : [k.remoteJid, k.remoteJidAlt];
  for (const jid of candidates) if (jid && isPnUser(jid)) return userPart(jid);
  for (const jid of candidates) {
    if (!jid) continue;
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
      if (pn) return userPart(pn);
    } catch {
      // fall through
    }
  }
  return undefined;
}

async function onMessage(msg: WAMessage): Promise<void> {
  const chatId = msg.key.remoteJid;
  if (!chatId || msg.key.fromMe || isJidBroadcast(chatId) || chatId.endsWith("@newsletter") || !msg.message) return;
  const isGroup = Boolean(isJidGroup(chatId));
  const parsed = extractText(msg.message);
  const bot = { ids: [sock.user?.id, sock.user?.lid].filter((x): x is string => Boolean(x)) };

  if (isGroup && !isAddressedToBot(parsed, bot, config)) return; // ordinary group chatter is not read or logged
  const phone = await senderPhone(msg);
  const staff = findStaff(config, phone);
  const name = staff?.name ?? msg.pushName ?? phone ?? "Unknown";
  const chatName = isGroup ? await groupName(chatId) : name;

  if (isGroup && !groupAllowed(config, chatName)) {
    audit.record("ignored", { reason: "group not allowed", chat: chatName, chatId, phone });
    return;
  }
  if (!staff && !(isGroup && config.answerAnyGroupMember)) {
    audit.record("ignored", { reason: "not on staff list", chat: chatName, chatId, phone, pushName: msg.pushName, text: parsed.text });
    return;
  }

  if (!isGroup && phone) {
    const approvalReply = await assistant.handleApproval(phone, name, parsed.text);
    if (approvalReply !== undefined) {
      audit.record("approval_reply", { chatId, phone, text: parsed.text, reply: approvalReply });
      await sock.sendMessage(chatId, { text: approvalReply }, { quoted: msg });
      return;
    }
  }

  let text = isGroup ? stripAddress(parsed.text, bot, config) : parsed.text.trim();
  if (parsed.hasMedia) text += "\n(They also attached a file or image, which I can't open.)";
  if (!text.trim()) text = "(No question, just a mention.)";

  await sock.sendPresenceUpdate("composing", chatId).catch(() => {});
  try {
    const reply = await assistant.handle({
      chatId, chatName, isGroup, senderName: name, senderPhone: phone ?? "", text, quotedText: parsed.quotedText,
    });
    await sock.sendMessage(chatId, { text: reply }, { quoted: msg });
  } finally {
    await sock.sendPresenceUpdate("paused", chatId).catch(() => {});
  }
}

// Scheduled tasks: checked every 30 seconds while connected.
let schedulerStarted = false;
const runningTasks = new Set<string>();

async function groupIdsByName(): Promise<Map<string, string>> {
  const groups = await sock.groupFetchAllParticipating();
  const byName = new Map<string, string>();
  for (const [id, meta] of Object.entries(groups)) byName.set(meta.subject.toLowerCase(), id);
  return byName;
}

async function runTask(key: string, chatId: string, chatName: string, task: { name: string; prompt: string; createdBy: string; id: string }) {
  if (runningTasks.has(key)) return;
  runningTasks.add(key);
  // Marked before running, so a crash part-way can't post the same report twice.
  tasks.markRun(key, hkParts(new Date()).date);
  audit.record("task_run", { key, chat: chatName, chatId, name: task.name });
  try {
    const reply = await assistant.handle({
      chatId, chatName, isGroup: Boolean(isJidGroup(chatId)), senderName: "Scheduled task", senderPhone: "", text: task.prompt,
      scheduled: { id: task.id, name: task.name, createdBy: task.createdBy },
    });
    await sock.sendMessage(chatId, { text: reply });
  } finally {
    runningTasks.delete(key);
  }
}

async function checkSchedules(): Promise<void> {
  const now = new Date();
  for (const t of tasks.expired(now)) {
    tasks.remove(t.id);
    audit.record("task_missed", { chat: t.chatName, chatId: t.chatId, task: t });
  }
  for (const t of tasks.due(now)) {
    runTask(t.id, t.chatId, t.chatName, t)
      .then(() => { if (t.date) tasks.remove(t.id); })
      .catch((err) => audit.record("error", { where: "task", task: t.id, error: String(err) }));
  }
  const due = dueSchedules(config.schedules, now, tasks.lastRuns);
  if (!due.length) return;
  const groups = await groupIdsByName();
  for (const s of due) {
    const chatId = groups.get(s.group.toLowerCase());
    if (!chatId) {
      tasks.markRun(configKey(s), hkParts(now).date);
      audit.record("task_skipped", { name: s.name, reason: "group not found", group: s.group });
      console.warn(`Scheduled report "${s.name}": I'm not in a group called "${s.group}".`);
      continue;
    }
    runTask(configKey(s), chatId, s.group, { id: "config", name: s.name, prompt: s.prompt, createdBy: "config.json" })
      .catch((err) => audit.record("error", { where: "schedule", name: s.name, error: String(err) }));
  }
}

function startScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  setInterval(() => {
    if (!sock?.user) return;
    checkSchedules().catch((err) => audit.record("error", { where: "scheduler", error: String(err) }));
  }, 30_000);
}

async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(config.dataDir, "auth"));
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger, markOnlineOnConnect: false, syncFullHistory: false });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\nOn the assistant's phone: WhatsApp > Settings > Linked devices > Link a device, then scan this code:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      retryDelayMs = 5000;
      console.log(`Connected as ${sock.user?.id}. Listening for messages.`);
      audit.record("connected", { user: sock.user?.id });
      startScheduler();
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      audit.record("disconnected", { code, error: String(lastDisconnect?.error ?? "") });
      if (code === DisconnectReason.loggedOut) {
        console.error(`This computer was unlinked from WhatsApp. Delete the folder ${path.join(config.dataDir, "auth")} and start again to scan a new code.`);
        process.exit(1);
      }
      console.warn(`Connection closed (${code ?? "unknown"}). Reconnecting in ${retryDelayMs / 1000} seconds.`);
      setTimeout(() => connect().catch((e) => console.error("Reconnect failed", e)), retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 120_000);
    }
  });
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    if (config.markAllRead) {
      const keys = messages
        .map((m) => m.key)
        .filter((k) => k.remoteJid && !k.fromMe && !isJidBroadcast(k.remoteJid) && !k.remoteJid.endsWith("@newsletter"));
      if (keys.length) sock.readMessages(keys).catch(() => {});
    }
    for (const m of messages) {
      onMessage(m).catch((err) => {
        console.error("Failed to handle a message", err);
        audit.record("error", { where: "onMessage", chatId: m.key.remoteJid, error: String(err) });
      });
    }
  });
}

console.log(`Starting ${config.assistantName}. Drive folders:\n${drive.describeRoots()}`);
connect().catch((err) => {
  console.error(err);
  process.exit(1);
});
