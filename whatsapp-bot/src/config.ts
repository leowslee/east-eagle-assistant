import fs from "node:fs";
import path from "node:path";
import { validateSchedules, type Schedule } from "./schedule.js";
import type { SkillsConfig } from "./skills.js";

export interface DriveRoot {
  name: string; // what staff and Claude call it, e.g. "X drive"
  path: string; // e.g. "X:\\" or "\\\\server\\share\\Trading"
}

export interface StaffMember {
  name: string;
  phone: string; // country code + number, digits only, e.g. "85291234567"
}

export interface Config {
  assistantName: string;
  triggerWords: string[];
  driveRoots: DriveRoot[];
  staff: StaffMember[];
  // Phone numbers allowed to approve changes to the drive (they get a private message and reply YES).
  approvers: string[];
  // Group names the assistant answers in. Empty means any group it has been added to.
  allowedGroups: string[];
  // When false, only people on the staff list get answers, in groups as well as private chats.
  answerAnyGroupMember: boolean;
  dataDir: string;
  logDir: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  conversationIdleHours: number;
  // Let the assistant search the internet and read public web pages.
  webSearch: boolean;
  // The assistant's mailbox. Sending needs EMAIL_APP_PASSWORD in .env and an approver's YES for every email.
  emailFrom: string;
  // Folder for records (attendance logs, filled forms).
  recordsFolder: string;
  // When false, adding records and saving new filled forms inside recordsFolder doesn't need an approver's YES.
  recordsNeedApproval: boolean;
  // The CDF PMS server (live portfolio page). Empty turns the pms_live tool off.
  pmsUrl: string;
  // Claude skills on this PC that the assistant may read (only the listed folders).
  skills: SkillsConfig;
  // Mark every incoming message as read (blue ticks), so the assistant's phone doesn't pile up unread chats.
  markAllRead: boolean;
  // Reports the assistant posts in a group at set times (Hong Kong time).
  schedules: Schedule[];
}

const DEFAULTS: Omit<Config, "staff" | "approvers"> = {
  assistantName: "Eileen",
  triggerWords: ["eileen"],
  driveRoots: [{ name: "X drive", path: "X:\\" }],
  allowedGroups: [],
  answerAnyGroupMember: false,
  dataDir: "data",
  logDir: "logs",
  model: "claude-opus-5-5",
  effort: "medium",
  conversationIdleHours: 4,
  webSearch: true,
  emailFrom: "",
  recordsFolder: "",
  recordsNeedApproval: true,
  pmsUrl: "http://127.0.0.1:8765",
  skills: { dir: "", include: [] },
  markAllRead: true,
  schedules: [],
};

export const digitsOnly = (s: string) => s.replace(/\D/g, "");

export function loadConfig(file = "config.json"): Config {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>;
  const config: Config = { ...DEFAULTS, staff: [], approvers: [], ...raw };
  config.staff = config.staff.map((s) => ({ name: s.name, phone: digitsOnly(s.phone) }));
  config.approvers = config.approvers.map(digitsOnly);
  config.triggerWords = config.triggerWords.map((w) => w.toLowerCase().replace(/^@/, ""));
  config.dataDir = path.resolve(config.dataDir);
  config.logDir = path.resolve(config.logDir);
  validateSchedules(config.schedules);
  if (config.driveRoots.length === 0) throw new Error("config.json: driveRoots is empty");
  return config;
}
