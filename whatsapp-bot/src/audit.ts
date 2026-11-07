// Append-only audit log: one JSON line per event, one file per day (logs/2026-11-07.jsonl).

import fs from "node:fs";
import path from "node:path";

export interface AuditLog {
  record(event: string, details: Record<string, unknown>): void;
}

function hkTime(date = new Date()): string {
  // ISO-like timestamp in Hong Kong time, e.g. 2026-11-07T16:54:05+08:00
  const hk = new Date(date.getTime() + 8 * 3600_000).toISOString().replace("Z", "");
  return hk.slice(0, 19) + "+08:00";
}

export class FileAuditLog implements AuditLog {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  record(event: string, details: Record<string, unknown>): void {
    const time = hkTime();
    const line = JSON.stringify({ time, event, ...details }) + "\n";
    fs.appendFileSync(path.join(this.dir, `${time.slice(0, 10)}.jsonl`), line, "utf8");
  }
}

export class MemoryAuditLog implements AuditLog {
  entries: Record<string, unknown>[] = [];
  record(event: string, details: Record<string, unknown>): void {
    this.entries.push({ event, ...details });
  }
}

export { hkTime };
