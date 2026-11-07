// Scheduled tasks: at set times (Hong Kong time) the assistant runs an instruction and posts the result in a chat.
// Tasks come from two places: "schedules" in config.json (by group name), and tasks that staff set up by asking
// the assistant in a chat (stored in data/schedules.json, tied to that chat).

import fs from "node:fs";
import path from "node:path";

export interface Schedule {
  name: string; // unique, e.g. "Morning positions"
  group: string; // WhatsApp group name, exactly as shown in WhatsApp
  time: string; // "HH:MM", Hong Kong time
  days?: string[]; // e.g. ["mon","tue","wed","thu","fri"]; leave out for every day
  prompt: string; // what to do
}

/** A task set up from a chat. */
export interface ChatTask {
  id: string; // short code, e.g. "T4821"
  name: string;
  chatId: string;
  chatName: string;
  time: string;
  days?: string[];
  date?: string; // "YYYY-MM-DD" for a one-off task; it is removed after it runs
  prompt: string;
  createdBy: string;
  createdByPhone: string;
  created: string;
}

/** What the timing check needs. */
export interface Timing {
  time: string;
  days?: string[];
  date?: string;
}

// If the PC was off or asleep at the scheduled time, the task still runs if the bot is back within this window.
const CATCH_UP_MS = 2 * 3600_000;
export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const MAX_TASKS_PER_CHAT = 20;

/** Hong Kong date parts for a moment in time. */
export function hkParts(now: Date): { date: string; day: string; minutes: number } {
  const hk = new Date(now.getTime() + 8 * 3600_000);
  return {
    date: hk.toISOString().slice(0, 10),
    day: DAY_NAMES[hk.getUTCDay()],
    minutes: hk.getUTCHours() * 60 + hk.getUTCMinutes(),
  };
}

/** Returns a problem with the timing, or undefined if it is fine. */
export function timingProblem(t: Timing): string | undefined {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time ?? "")) return `time must be HH:MM in 24-hour Hong Kong time, e.g. 08:30`;
  for (const d of t.days ?? []) if (!DAY_NAMES.includes(String(d).toLowerCase())) return `unknown day "${d}" (use mon, tue, wed, thu, fri, sat, sun)`;
  if (t.date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date) || Number.isNaN(Date.parse(t.date))) return `date must be YYYY-MM-DD`;
    if (t.days?.length) return `give either a date (one-off) or days (repeating), not both`;
  }
  return undefined;
}

export function validateSchedules(schedules: Schedule[]): void {
  const names = new Set<string>();
  for (const s of schedules) {
    if (!s.name || !s.group || !s.prompt) throw new Error(`config.json: each schedule needs name, group and prompt`);
    const problem = timingProblem(s);
    if (problem) throw new Error(`config.json: schedule "${s.name}": ${problem}`);
    if (names.has(s.name)) throw new Error(`config.json: two schedules are called "${s.name}"`);
    names.add(s.name);
  }
}

/** Whether a task should run now. lastRun is the HK date it last ran. */
export function isDue(t: Timing, now: Date, lastRun?: string): boolean {
  const { date, day, minutes } = hkParts(now);
  if (t.date && t.date !== date) return false;
  if (t.days && t.days.length && !t.days.map((d) => d.toLowerCase()).includes(day)) return false;
  if (lastRun === date) return false;
  const [h, m] = t.time.split(":").map(Number);
  const late = (minutes - (h * 60 + m)) * 60_000;
  return late >= 0 && late < CATCH_UP_MS;
}

/** Config schedules that should run now and haven't run today. */
export function dueSchedules(schedules: Schedule[], now: Date, lastRuns: Record<string, string>): Schedule[] {
  return schedules.filter((s) => isDue(s, now, lastRuns[configKey(s)]));
}

export const configKey = (s: Schedule) => `config:${s.name}`;

/** Describes when a task runs, e.g. "every weekday at 08:30". */
export function describeTiming(t: Timing): string {
  if (t.date) return `once on ${t.date} at ${t.time}`;
  const days = (t.days ?? []).map((d) => d.toLowerCase());
  if (!days.length || days.length === 7) return `every day at ${t.time}`;
  const weekdays = ["mon", "tue", "wed", "thu", "fri"];
  if (days.length === 5 && weekdays.every((d) => days.includes(d))) return `every weekday at ${t.time}`;
  return `every ${DAY_NAMES.filter((d) => days.includes(d)).join(", ")} at ${t.time}`;
}

interface StoredState {
  tasks: ChatTask[];
  lastRuns: Record<string, string>;
}

/** Chat tasks and the date each task last ran, so a restart doesn't run a task twice. */
export class TaskStore {
  private state: StoredState;

  constructor(private file?: string) {
    this.state = { tasks: [], lastRuns: {} };
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      this.state = { tasks: Array.isArray(raw.tasks) ? raw.tasks : [], lastRuns: raw.lastRuns ?? {} };
    } catch {
      // first run
    }
  }

  get lastRuns(): Record<string, string> {
    return this.state.lastRuns;
  }

  get tasks(): ChatTask[] {
    return this.state.tasks;
  }

  forChat(chatId: string): ChatTask[] {
    return this.state.tasks.filter((t) => t.chatId === chatId);
  }

  add(task: Omit<ChatTask, "id" | "created">): ChatTask {
    const ids = new Set(this.state.tasks.map((t) => t.id));
    let id: string;
    do id = `T${Math.floor(1000 + Math.random() * 9000)}`;
    while (ids.has(id));
    const full: ChatTask = { ...task, id, created: new Date().toISOString() };
    this.state.tasks.push(full);
    this.save();
    return full;
  }

  remove(id: string): ChatTask | undefined {
    const i = this.state.tasks.findIndex((t) => t.id.toLowerCase() === id.trim().toLowerCase());
    if (i < 0) return undefined;
    const [task] = this.state.tasks.splice(i, 1);
    delete this.state.lastRuns[task.id];
    this.save();
    return task;
  }

  due(now: Date): ChatTask[] {
    return this.state.tasks.filter((t) => isDue(t, now, this.state.lastRuns[t.id]));
  }

  /** One-off tasks whose date has passed without running (e.g. the PC was off). */
  expired(now: Date): ChatTask[] {
    const { date } = hkParts(now);
    return this.state.tasks.filter((t) => t.date && t.date < date);
  }

  markRun(key: string, date: string): void {
    this.state.lastRuns[key] = date;
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
