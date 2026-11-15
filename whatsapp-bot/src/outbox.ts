// Outbox: other programs on this PC (such as Leo's trading program) drop messages as JSON files in a folder,
// and the assistant posts them to WhatsApp at once, without an approval code.
//
// Each file: { "id", "time", "source", "to", "level", "text" }. "to" is a staff name such as "Leo" (private
// message) or the name of a group the assistant is in; left out, it goes to outboxDefaultTo from config.json. Files ending .tmp are ignored, so a program can write
// "x.json.tmp" and rename it to "x.json" when it is complete. A posted file moves to outbox\sent; a file that
// can't be read moves to outbox\failed and Leo is told why.

import fs from "node:fs";
import path from "node:path";
import type { AuditLog } from "./audit.js";

export interface OutboxMessage {
  id: string;
  time: string;
  source: string;
  to: string;
  level: string;
  text: string;
}

export interface OutboxDeps {
  /** Finds the chat for a "to" value: a staff member's private chat or a group. */
  resolve(to: string): Promise<{ chatId: string; name: string } | undefined>;
  sendText(chatId: string, text: string): Promise<void>;
  /** The chat to tell when a message can't be delivered as asked (Leo's private chat). */
  fallbackChatId: string;
  /** Where a message goes when its file has no "to", e.g. "East Eagle Quant Trading". */
  defaultTo?: string;
  audit: AuditLog;
}

// A file that doesn't parse yet may still be being written; give it this long before calling it broken.
const SETTLE_MS = 5_000;

export class Outbox {
  private running = false;
  private sendErrors = new Set<string>();
  // Posted but couldn't be moved (e.g. the file was still open): don't post again, just retry the move.
  private delivered = new Set<string>();

  constructor(private dir: string, private deps: OutboxDeps) {}

  /** Posts every waiting message. Safe to call on a timer: overlapping calls do nothing. */
  async check(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let names: string[];
      try {
        names = fs.readdirSync(this.dir).filter((n) => n.toLowerCase().endsWith(".json")).sort();
      } catch {
        return; // folder not there yet
      }
      for (const name of names) await this.handle(name, now);
    } finally {
      this.running = false;
    }
  }

  private async handle(name: string, now: number): Promise<void> {
    const file = path.join(this.dir, name);
    if (this.delivered.has(name)) {
      if (this.move(file, "sent")) this.delivered.delete(name);
      return;
    }
    let msg: OutboxMessage;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return;
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
      } catch (err) {
        if (now - stat.mtimeMs < SETTLE_MS) return; // probably still being written
        throw new Error(`it isn't valid JSON (${(err as Error).message})`);
      }
      msg = parse(raw, this.deps.defaultTo);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // moved away meanwhile
      const reason = (err as Error).message;
      this.deps.audit.record("outbox_bad_file", { file: name, reason });
      await this.tellFallback(`Outbox file ${name} couldn't be sent: ${reason}. I moved it to the "failed" folder.`);
      this.move(file, "failed");
      return;
    }

    try {
      const target = await this.deps.resolve(msg.to);
      if (target) {
        await this.deps.sendText(target.chatId, msg.text);
        this.deps.audit.record("outbox_sent", { file: name, id: msg.id, source: msg.source, level: msg.level, to: target.name, chatId: target.chatId, text: msg.text });
      } else {
        const why = `I couldn't post this to "${msg.to}": that isn't a staff member's name or a group I'm in.`;
        await this.deps.sendText(this.deps.fallbackChatId, `${why}\n\nFrom ${msg.source || "the outbox"}${msg.level ? ` (${msg.level})` : ""}:\n${msg.text}`);
        this.deps.audit.record("outbox_unknown_target", { file: name, id: msg.id, source: msg.source, to: msg.to, text: msg.text });
      }
    } catch (err) {
      // WhatsApp hiccup: leave the file and try again next time. Log it once per file.
      if (!this.sendErrors.has(name)) this.deps.audit.record("outbox_send_error", { file: name, id: msg.id, to: msg.to, error: String(err) });
      this.sendErrors.add(name);
      return;
    }
    this.sendErrors.delete(name);
    if (!this.move(file, "sent")) this.delivered.add(name);
  }

  private async tellFallback(text: string): Promise<void> {
    try {
      await this.deps.sendText(this.deps.fallbackChatId, text);
    } catch (err) {
      this.deps.audit.record("error", { where: "outbox", error: String(err) });
    }
  }

  private move(file: string, sub: "sent" | "failed"): boolean {
    const dest = path.join(this.dir, sub);
    fs.mkdirSync(dest, { recursive: true });
    let target = path.join(dest, path.basename(file));
    if (fs.existsSync(target)) {
      const ext = path.extname(file);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      target = path.join(dest, `${path.basename(file, ext)}.${stamp}${ext}`);
    }
    try {
      fs.renameSync(file, target);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      this.deps.audit.record("error", { where: "outbox_move", file, error: String(err) });
      return false;
    }
  }
}

function parse(raw: unknown, defaultTo = ""): OutboxMessage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`it should be one JSON object`);
  const o = raw as Record<string, unknown>;
  const str = (k: string) => (o[k] === undefined || o[k] === null ? "" : String(o[k]));
  const msg: OutboxMessage = { id: str("id"), time: str("time"), source: str("source"), to: str("to").trim() || defaultTo.trim(), level: str("level"), text: str("text") };
  if (!msg.to) throw new Error(`"to" is missing`);
  if (!msg.text.trim()) throw new Error(`"text" is missing`);
  return msg;
}
