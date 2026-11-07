// Conversation history per chat, saved as JSON so it survives restarts.

import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

export interface Conversation {
  messages: Anthropic.Beta.BetaMessageParam[];
  updated: number;
}

export interface Store {
  load(chatId: string): Conversation | undefined;
  save(chatId: string, conversation: Conversation): void;
  remove(chatId: string): void;
}

export class FileStore implements Store {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(chatId: string) {
    return path.join(this.dir, chatId.replace(/[^\w.-]/g, "_") + ".json");
  }

  load(chatId: string): Conversation | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file(chatId), "utf8"));
    } catch {
      return undefined;
    }
  }

  save(chatId: string, conversation: Conversation): void {
    const tmp = this.file(chatId) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(conversation));
    fs.renameSync(tmp, this.file(chatId));
  }

  remove(chatId: string): void {
    fs.rmSync(this.file(chatId), { force: true });
  }
}

export class MemoryStore implements Store {
  data = new Map<string, Conversation>();
  load(chatId: string) {
    const c = this.data.get(chatId);
    return c ? structuredClone(c) : undefined;
  }
  save(chatId: string, conversation: Conversation) {
    this.data.set(chatId, structuredClone(conversation));
  }
  remove(chatId: string) {
    this.data.delete(chatId);
  }
}
