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
import { AI_UNAVAILABLE, Assistant } from "./agent.js";
import { FileAuditLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { Drive } from "./drive.js";
import { configKey, dueSchedules, hkParts, isDue, TaskStore, type Timing } from "./schedule.js";
import { extractText, findStaff, groupAllowed, isAddressedToBot, stripAddress, userPart } from "./route.js";
import { SmtpMailer } from "./email.js";
import { alertMatches, alertText, ImapMailReader, MailStateFile } from "./mailbox.js";
import { isApprovalRequest, OrderBook, parseOrderDecision } from "./inbox.js";
import { Outbox } from "./outbox.js";
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

// Reading the mailbox uses the same app password over IMAP (IMAP must be on in Gmail for this account).
const mailReader = config.emailFrom && process.env.EMAIL_APP_PASSWORD ? new ImapMailReader(config.emailFrom, process.env.EMAIL_APP_PASSWORD) : undefined;
if (mailReader) {
  const who = config.emailReaders.map((p) => findStaff(config, p)?.name ?? p).join(", ") || "nobody";
  console.log(`Email inbox: ${config.emailFrom} (read-only), for ${who}${config.emailAlerts.to ? `; new-mail alerts to ${config.emailAlerts.to}` : ""}`);
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
}, undefined, tasks, mailer(), config.pmsUrl ? new Pms(config.pmsUrl) : undefined, skills, mailReader);

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

/** ISO time in Hong Kong, e.g. 2026-11-16T05:50:00+08:00. */
function hkIso(d: Date): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 19) + "+08:00";
}

// Trading program order approvals (see inbox.ts).
const orders = config.orderInboxDir ? new OrderBook(config.orderInboxDir, path.join(config.dataDir, "orders.json")) : undefined;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Handles "APPROVE XXXX" / "REJECT XXXX". Returns false if the message isn't one for the trading program. */
async function handleOrderDecision(
  msg: WAMessage, chatId: string, isGroup: boolean, order: { id: string; decision: "approve" | "reject" },
): Promise<boolean> {
  if (!orders) return false;
  const tradingGroup = config.outboxDefaultTo;
  if (isGroup && !(tradingGroup && sameName(await groupName(chatId), tradingGroup))) return false;
  const phone = await senderPhone(msg);
  const reply = (text: string) => sock.sendMessage(chatId, { text }, { quoted: msg });
  const who = (p: string) => findStaff(config, p)?.name ?? p;
  if (!phone || !config.orderApprovers.includes(phone)) {
    audit.record("order_decision_refused", { ...order, chatId, phone, pushName: msg.pushName });
    await reply(`Only ${config.orderApprovers.map(who).join(" or ")} can approve or reject orders.`);
    return true;
  }
  const decision = { ...order, from: who(phone), time: hkIso(new Date()) };
  let result;
  try {
    result = orders.decide(decision);
  } catch (err) {
    audit.record("error", { where: "order_decision", ...decision, error: String(err) });
    await reply(`I couldn't pass ${order.decision} ${order.id} to the trading program: ${String(err)}`);
    return true;
  }
  if (result.status === "already") {
    const e = result.earlier;
    audit.record("order_decision_duplicate", { ...decision, earlier: e });
    await reply(`${order.id} was already ${e.decision === "approve" ? "approved" : "rejected"} by ${e.from} at ${e.time.slice(11, 16)}. Nothing changed.`);
    return true;
  }
  audit.record("order_decision", { ...decision, file: result.file });
  const text = `${order.decision === "approve" ? "✅ Approved" : "❌ Rejected"} ${order.id} (${decision.from}). Passed to the trading program.`;
  await reply(text);
  // Tell the other place too: the trading group and Leo's private chat.
  const others = new Set<string>();
  if (config.approvers[0]) others.add(`${config.approvers[0]}@s.whatsapp.net`);
  if (tradingGroup) {
    const id = (await groupIdsByName().catch(() => new Map<string, string>())).get(tradingGroup.trim().toLowerCase());
    if (id) others.add(id);
  }
  if (!isGroup && phone !== config.approvers[0]) others.add(`${phone}@s.whatsapp.net`);
  others.delete(chatId);
  for (const other of others) await sock.sendMessage(other, { text }).catch((err) => audit.record("error", { where: "order_notify", chatId: other, error: String(err) }));
  return true;
}

async function onMessage(msg: WAMessage): Promise<void> {
  const chatId = msg.key.remoteJid;
  if (!chatId || msg.key.fromMe || isJidBroadcast(chatId) || chatId.endsWith("@newsletter") || !msg.message) return;
  const isGroup = Boolean(isJidGroup(chatId));
  const parsed = extractText(msg.message);
  const bot = { ids: [sock.user?.id, sock.user?.lid].filter((x): x is string => Boolean(x)) };

  // APPROVE/REJECT for the trading program counts in the trading group even without "Eileen" in front.
  const order = parseOrderDecision(parsed.text) ?? (isGroup ? parseOrderDecision(stripAddress(parsed.text, bot, config)) : undefined);
  if (order && orders && (await handleOrderDecision(msg, chatId, isGroup, order))) return;

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

// A task that hit an AI service outage is tried again after this long, while it is still inside its catch-up window.
const RETRY_MS = 10 * 60_000;
const retryAfter = new Map<string, number>();

/** Runs a scheduled task. Returns false if it will be retried later. */
async function runTask(
  key: string, chatId: string, chatName: string,
  task: Timing & { name: string; prompt: string; createdBy: string; createdByPhone?: string; id: string },
): Promise<boolean> {
  if (runningTasks.has(key) || (retryAfter.get(key) ?? 0) > Date.now()) return false;
  runningTasks.add(key);
  // Marked before running, so a crash part-way can't post the same report twice.
  tasks.markRun(key, hkParts(new Date()).date);
  audit.record("task_run", { key, chat: chatName, chatId, name: task.name });
  try {
    const reply = await assistant.handle({
      chatId, chatName, isGroup: Boolean(isJidGroup(chatId)), senderName: "Scheduled task", senderPhone: "", text: task.prompt,
      scheduled: { id: task.id, name: task.name, createdBy: task.createdBy, createdByPhone: task.createdByPhone },
    });
    if (reply === AI_UNAVAILABLE) {
      const retryAt = new Date(Date.now() + RETRY_MS);
      if (isDue(task, retryAt, undefined)) {
        tasks.unmarkRun(key);
        retryAfter.set(key, retryAt.getTime());
        audit.record("task_retry", { key, chat: chatName, name: task.name, at: retryAt.toISOString() });
        return false;
      }
      retryAfter.delete(key);
      audit.record("task_failed", { key, chat: chatName, name: task.name });
      await sock.sendMessage(chatId, { text: `"${task.name}" didn't run today: the AI service was unavailable for the last 2 hours. Ask me to run it now once I'm answering again.` });
      return true;
    }
    retryAfter.delete(key);
    await sock.sendMessage(chatId, { text: reply });
    return true;
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
      .then((done) => { if (done && t.date) tasks.remove(t.id); })
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
    runTask(configKey(s), chatId, s.group, { ...s, id: "config", createdBy: "config.json" })
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

// Outbox: messages from other programs on this PC, checked every 10 seconds while connected.
let outboxStarted = false;
function startOutbox(): void {
  if (outboxStarted || !config.outboxDir) return;
  outboxStarted = true;
  const leo = config.approvers[0] ?? config.staff[0]?.phone;
  if (!leo) {
    console.warn("Outbox is off: config.json has no approver to tell about undeliverable messages.");
    return;
  }
  const outbox = new Outbox(config.outboxDir, {
    async resolve(to) {
      const person = config.staff.find((s) => s.name.trim().toLowerCase() === to.trim().toLowerCase());
      if (person) return { chatId: `${person.phone}@s.whatsapp.net`, name: person.name };
      const groups = await sock.groupFetchAllParticipating();
      const g = Object.values(groups).find((x) => x.subject.trim().toLowerCase() === to.trim().toLowerCase());
      return g ? { chatId: g.id, name: g.subject } : undefined;
    },
    async sendText(chatId, text) {
      await sock.sendMessage(chatId, { text });
    },
    fallbackChatId: `${leo}@s.whatsapp.net`,
    // Order approval requests go to Leo privately and to the trading group, so either can answer.
    alsoTo: (m) => (isApprovalRequest(m.text) ? [findStaff(config, leo)?.name ?? "", config.outboxDefaultTo] : []),
    defaultTo: config.outboxDefaultTo,
    audit,
  });
  console.log(`Outbox: posting messages dropped in ${config.outboxDir}${config.outboxDefaultTo ? ` (default: ${config.outboxDefaultTo})` : ""}`);
  setInterval(() => {
    if (!sock?.user) return;
    outbox.check().catch((err) => audit.record("error", { where: "outbox", error: String(err) }));
  }, 10_000);
}

// New-mail alerts: the inbox is checked every few minutes while connected.
let mailAlertsStarted = false;
function startMailAlerts(): void {
  const alert = config.emailAlerts;
  if (mailAlertsStarted || !mailReader || !alert.to) return;
  mailAlertsStarted = true;
  const stateFile = new MailStateFile(path.join(config.dataDir, "mail-state.json"));
  let checking = false;
  const check = async () => {
    if (checking || !sock?.user) return;
    checking = true;
    try {
      const { state, messages } = await mailReader.newMail(stateFile.load());
      const matching = messages.filter((m) => alertMatches(alert, m));
      if (matching.length) {
        const person = config.staff.find((s) => s.name.trim().toLowerCase() === alert.to.trim().toLowerCase());
        const chatId = person ? `${person.phone}@s.whatsapp.net` : (await groupIdsByName()).get(alert.to.trim().toLowerCase());
        if (!chatId) {
          console.warn(`Email alerts: no staff member or group called "${alert.to}".`);
          audit.record("email_alert_skipped", { to: alert.to, reason: "not found", count: matching.length });
        } else {
          await sock.sendMessage(chatId, { text: alertText(mailReader.address, matching) });
          audit.record("email_alert", { to: alert.to, emails: matching.map((m) => ({ uid: m.uid, from: m.from, subject: m.subject })) });
        }
      }
      stateFile.save(state); // saved after sending, so a failed send is tried again next time
    } catch (err) {
      audit.record("error", { where: "email_alerts", error: String(err) });
    } finally {
      checking = false;
    }
  };
  console.log(`Email alerts: checking ${mailReader.address} every ${alert.everyMinutes} min, telling ${alert.to}.`);
  check();
  setInterval(check, alert.everyMinutes * 60_000);
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
      startOutbox();
      startMailAlerts();
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
