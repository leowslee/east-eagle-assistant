// Decides which WhatsApp messages the assistant answers. Pure functions, so they can be tested.

import type { proto } from "baileys";
import type { Config, StaffMember } from "./config.js";
import { digitsOnly } from "./config.js";

export interface BotIdentity {
  ids: string[]; // the assistant's own user ids, phone-number form and LID form, without device suffix
}

/** "85291234567:12@s.whatsapp.net" -> "85291234567" (works for @lid ids too). */
export const userPart = (jid: string | null | undefined) => (jid ?? "").split("@")[0].split(":")[0];

export interface MessageText {
  text: string;
  mentioned: string[];
  quotedText?: string;
  quotedParticipant?: string;
  hasMedia: boolean;
}

export function extractText(message: proto.IMessage | null | undefined): MessageText {
  const m = message ?? {};
  const ext = m.extendedTextMessage;
  const context = ext?.contextInfo ?? m.imageMessage?.contextInfo ?? m.documentMessage?.contextInfo ?? m.videoMessage?.contextInfo;
  const quoted = context?.quotedMessage;
  const text =
    m.conversation ??
    ext?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    "";
  return {
    text: text ?? "",
    mentioned: context?.mentionedJid ?? [],
    quotedText: quoted ? (extractText(quoted).text || undefined) : undefined,
    quotedParticipant: context?.participant ?? undefined,
    hasMedia: Boolean(m.imageMessage || m.videoMessage || m.documentMessage || m.audioMessage || m.documentWithCaptionMessage),
  };
}

/** True if a group message is meant for the assistant: an @mention, a reply to it, or its name first. */
export function isAddressedToBot(msg: MessageText, bot: BotIdentity, config: Config): boolean {
  const mine = new Set(bot.ids.map(userPart));
  if (msg.mentioned.some((j) => mine.has(userPart(j)))) return true;
  if (msg.quotedParticipant && mine.has(userPart(msg.quotedParticipant))) return true;
  const first = msg.text.trim().toLowerCase().replace(/^@/, "");
  return config.triggerWords.some((w) => first === w || new RegExp(`^${escapeRegex(w)}\\b`).test(first));
}

/** Removes the @mention or the leading name so Claude sees the question itself. */
export function stripAddress(text: string, bot: BotIdentity, config: Config): string {
  let t = text;
  for (const id of bot.ids) t = t.replaceAll(`@${userPart(id)}`, "");
  t = t.trim();
  for (const w of config.triggerWords) {
    const re = new RegExp(`^@?${escapeRegex(w)}\\b[\\s,:.!-]*`, "i");
    if (re.test(t)) {
      t = t.replace(re, "");
      break;
    }
  }
  return t.trim();
}

export function findStaff(config: Config, phone: string | undefined): StaffMember | undefined {
  if (!phone) return undefined;
  const digits = digitsOnly(phone);
  return config.staff.find((s) => s.phone === digits);
}

export function groupAllowed(config: Config, groupName: string): boolean {
  if (config.allowedGroups.length === 0) return true;
  return config.allowedGroups.some((g) => g.trim().toLowerCase() === groupName.trim().toLowerCase());
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
