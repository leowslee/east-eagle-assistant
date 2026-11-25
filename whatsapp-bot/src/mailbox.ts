// Reads the assistant's own mailbox (Gmail / Google Workspace IMAP with the same app password used to send).
// Read-only: every folder is opened with EXAMINE, so nothing is deleted, moved, or even marked as read.

import fs from "node:fs";
import path from "node:path";
import { ImapFlow, type FetchMessageObject, type MessageAddressObject, type MessageStructureObject } from "imapflow";
import { simpleParser } from "mailparser";

export type MailFolder = "inbox" | "all" | "sent";

export interface EmailSummary {
  uid: number;
  folder: MailFolder;
  date: string;
  from: string;
  to: string;
  subject: string;
  unread: boolean;
  attachments: string[];
}

export interface EmailMessage extends Omit<EmailSummary, "attachments"> {
  cc: string;
  text: string;
  totalChars: number;
  note?: string;
  attachments: { index: number; name: string; type: string; size: number }[];
}

export interface EmailAttachment {
  name: string;
  type: string;
  data: Buffer;
}

export interface MailSearch {
  query?: string; // Gmail search syntax, e.g. "from:apex has:attachment newer_than:7d"
  folder?: MailFolder;
  unreadOnly?: boolean;
  max?: number;
}

export interface MailReader {
  readonly address: string;
  search(s: MailSearch): Promise<EmailSummary[]>;
  read(uid: number, folder?: MailFolder, startChar?: number): Promise<EmailMessage>;
  attachment(uid: number, index: number, folder?: MailFolder): Promise<EmailAttachment>;
  /** Inbox messages newer than the last check. The first call only remembers where the inbox is. */
  newMail(state: MailState): Promise<{ state: MailState; messages: EmailSummary[] }>;
}

export interface MailState {
  uidValidity?: string;
  lastUid?: number;
}

export class MailError extends Error {}

const MAX_TEXT_CHARS = 30_000;
const MAX_LIST = 50;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const addresses = (list?: MessageAddressObject[]) =>
  (list ?? []).map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : a.address ?? a.name ?? "")).filter(Boolean).join(", ");

const isoDate = (d?: Date | string) => (d ? new Date(d).toISOString() : "");

/** File names of a message's attachments, from its MIME structure (no download needed). */
export function attachmentNames(node?: MessageStructureObject): string[] {
  if (!node) return [];
  const own = node.dispositionParameters?.filename ?? node.parameters?.name;
  const names = own && (node.disposition === "attachment" || !node.type.startsWith("text/")) && !node.type.startsWith("multipart/") ? [own] : [];
  for (const child of node.childNodes ?? []) names.push(...attachmentNames(child));
  return names;
}

export class ImapMailReader implements MailReader {
  constructor(
    readonly address: string,
    private appPassword: string,
    private server: { host: string; port: number; secure: boolean } = { host: "imap.gmail.com", port: 993, secure: true },
  ) {}

  private async withFolder<T>(folder: MailFolder, work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      ...this.server,
      auth: { user: this.address, pass: this.appPassword.replace(/\s/g, "") },
      logger: false,
      disableAutoIdle: true,
    });
    client.on("error", () => {}); // a dropped connection is reported by the command that was running
    try {
      await client.connect();
    } catch (err) {
      const e = err as { authenticationFailed?: boolean; responseText?: string };
      if (e.authenticationFailed)
        throw new MailError("Gmail refused the login. Check the app password in .env, and that IMAP is turned on for this mailbox.");
      throw new MailError(`Couldn't connect to the mailbox: ${e.responseText ?? String(err)}`);
    }
    try {
      const lock = await client.getMailboxLock(await this.folderPath(client, folder), { readOnly: true });
      try {
        return await work(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  private async folderPath(client: ImapFlow, folder: MailFolder): Promise<string> {
    if (folder === "inbox") return "INBOX";
    const use = folder === "all" ? "\\All" : "\\Sent";
    const found = (await client.list()).find((m) => m.specialUse === use);
    if (!found) throw new MailError(`This mailbox has no "${folder}" folder.`);
    return found.path;
  }

  private summary(m: FetchMessageObject, folder: MailFolder): EmailSummary {
    return {
      uid: m.uid,
      folder,
      date: isoDate(m.envelope?.date ?? m.internalDate),
      from: addresses(m.envelope?.from),
      to: addresses(m.envelope?.to),
      subject: m.envelope?.subject ?? "",
      unread: !m.flags?.has("\\Seen"),
      attachments: attachmentNames(m.bodyStructure),
    };
  }

  async search({ query, folder = "inbox", unreadOnly, max = 15 }: MailSearch): Promise<EmailSummary[]> {
    return this.withFolder(folder, async (client) => {
      const criteria: Record<string, unknown> = query?.trim() ? { gmraw: query.trim() } : { all: true };
      if (unreadOnly) criteria.seen = false;
      const uids = (await client.search(criteria, { uid: true })) || [];
      const newest = uids.sort((a, b) => b - a).slice(0, Math.min(Math.max(1, max), MAX_LIST));
      if (!newest.length) return [];
      const found = await client.fetchAll(newest.join(","), { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true }, { uid: true });
      return found.map((m) => this.summary(m, folder)).sort((a, b) => b.uid - a.uid);
    });
  }

  private async parsed(client: ImapFlow, uid: number) {
    const m = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
    if (!m || !m.source) throw new MailError(`There's no email ${uid} in that folder.`);
    return { flags: m.flags, mail: await simpleParser(m.source) };
  }

  async read(uid: number, folder: MailFolder = "inbox", startChar = 0): Promise<EmailMessage> {
    return this.withFolder(folder, async (client) => {
      const { flags, mail } = await this.parsed(client, uid);
      const addr = (a: typeof mail.from | typeof mail.to) => (Array.isArray(a) ? a.map((x) => x.text).join(", ") : a?.text ?? "");
      const full = (mail.text || (mail.html ? htmlToText(mail.html) : "")).trim();
      const text = full.slice(startChar, startChar + MAX_TEXT_CHARS);
      const more = startChar + text.length < full.length;
      return {
        uid,
        folder,
        date: isoDate(mail.date),
        from: addr(mail.from),
        to: addr(mail.to),
        cc: addr(mail.cc),
        subject: mail.subject ?? "",
        unread: !flags?.has("\\Seen"),
        text,
        totalChars: full.length,
        ...(more ? { note: `Showing characters ${startChar}-${startChar + text.length} of ${full.length}. Call again with start_char ${startChar + text.length} for more.` } : {}),
        attachments: mail.attachments
          .filter((a) => a.contentDisposition === "attachment" || a.filename)
          .map((a, index) => ({ index, name: a.filename ?? `attachment-${index + 1}`, type: a.contentType, size: a.size })),
      };
    });
  }

  async attachment(uid: number, index: number, folder: MailFolder = "inbox"): Promise<EmailAttachment> {
    return this.withFolder(folder, async (client) => {
      const { mail } = await this.parsed(client, uid);
      const list = mail.attachments.filter((a) => a.contentDisposition === "attachment" || a.filename);
      const a = list[index];
      if (!a) throw new MailError(`Email ${uid} has ${list.length} attachment(s); there's no number ${index}.`);
      if (a.size > MAX_ATTACHMENT_BYTES) throw new MailError("That attachment is over 50 MB.");
      return { name: safeFileName(a.filename ?? `attachment-${index + 1}`), type: a.contentType, data: a.content };
    });
  }

  async newMail(state: MailState): Promise<{ state: MailState; messages: EmailSummary[] }> {
    return this.withFolder("inbox", async (client) => {
      const box = client.mailbox;
      if (!box) throw new MailError("The inbox didn't open.");
      const validity = String(box.uidValidity);
      const top = box.uidNext - 1;
      // First run, or Gmail renumbered the inbox: start from now without alerting about old mail.
      if (state.uidValidity !== validity || state.lastUid === undefined) return { state: { uidValidity: validity, lastUid: top }, messages: [] };
      if (top <= state.lastUid) return { state, messages: [] };
      const found = await client.fetchAll(`${state.lastUid + 1}:*`, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true }, { uid: true });
      const messages = found.filter((m) => m.uid > state.lastUid!).map((m) => this.summary(m, "inbox")).sort((a, b) => a.uid - b.uid);
      const lastUid = Math.max(state.lastUid, top, ...messages.map((m) => m.uid));
      return { state: { uidValidity: validity, lastUid }, messages };
    });
  }
}

export function safeFileName(name: string): string {
  const cleaned = path.basename(name.replace(/\\/g, "/")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned.slice(0, 180) : "attachment";
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n");
}

/** Which new emails to tell people about, and where. */
export interface EmailAlertConfig {
  // A staff name (private chat) or a WhatsApp group name. Empty turns alerts off.
  to: string;
  // Only alert for senders containing one of these (e.g. "apexgroup.com"). Empty means every new email.
  from: string[];
  // Only alert when the subject contains one of these words (case-insensitive). Empty means any subject.
  subjectContains: string[];
  everyMinutes: number;
}

export function alertMatches(alert: EmailAlertConfig, m: EmailSummary): boolean {
  const has = (hay: string, needles: string[]) => !needles.length || needles.some((n) => hay.toLowerCase().includes(n.trim().toLowerCase()));
  return has(m.from, alert.from) && has(m.subject, alert.subjectContains);
}

export function alertText(address: string, messages: EmailSummary[]): string {
  const lines = messages.slice(0, 10).map((m) => {
    const files = m.attachments.length ? `\n  Attachments: ${m.attachments.join(", ")}` : "";
    return `- *${m.subject || "(no subject)"}*\n  From ${m.from}${files}`;
  });
  const more = messages.length > 10 ? `\n...and ${messages.length - 10} more.` : "";
  return `📧 New email for ${address}:\n${lines.join("\n")}${more}\n\nAsk me to read or summarise it.`;
}

/** Remembers where the last new-mail check got to, so a restart doesn't repeat alerts. */
export class MailStateFile {
  constructor(private file: string) {}
  load(): MailState {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as MailState;
    } catch {
      return {};
    }
  }
  save(state: MailState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(state));
  }
}
