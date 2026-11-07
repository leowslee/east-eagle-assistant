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
import { extractText, findStaff, groupAllowed, isAddressedToBot, stripAddress, userPart } from "./route.js";
import { FileStore } from "./store.js";

const config = loadConfig(process.argv[2] ?? "config.json");
const audit = new FileAuditLog(config.logDir);
const drive = new Drive(config.driveRoots);
const logger = pino({ level: "warn" });

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

const assistant = new Assistant(config, drive, new FileStore(path.join(config.dataDir, "conversations")), audit, {
  async sendText(chatId, text) {
    await sock.sendMessage(chatId, { text });
  },
  async sendFile(chatId, filePath, fileName) {
    const mimetype = MIME[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
    await sock.sendMessage(chatId, { document: { url: filePath }, fileName, mimetype });
  },
});

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
