// Order approvals for Leo's trading program (quant-platform). The program posts "OMS APPROVAL NEEDED" with a
// 4-character code through the outbox (to Leo privately and to the trading group); an order approver replies
// "APPROVE XXXX" or "REJECT XXXX" in either place, and the assistant writes the decision as a JSON file the
// program picks up. The first answer for a code wins. This is separate from the assistant's own YES codes.

import fs from "node:fs";
import path from "node:path";

export interface OrderDecision {
  id: string;
  decision: "approve" | "reject";
  from: string;
  time: string;
}

/** Reads "APPROVE AB12" / "reject ab12". Returns undefined for anything else. */
export function parseOrderDecision(text: string): { id: string; decision: "approve" | "reject" } | undefined {
  const m = /^\s*\*?(approve|reject)\*?\s+([A-Za-z0-9]{4})\s*[.!]?\s*$/i.exec(text);
  if (!m) return undefined;
  return { id: m[2].toUpperCase(), decision: m[1].toLowerCase() as "approve" | "reject" };
}

/** Writes the decision as <dir>/<id>-<decision>-<time>.json, via a .tmp file and a rename. Returns the path. */
export function writeOrderDecision(dir: string, d: OrderDecision): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = d.time.replace(/[:.]/g, "-");
  const file = path.join(dir, `${d.id}-${d.decision}-${stamp}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

/** Remembers which order codes have been decided, so the first approver's answer wins. Kept in a file across restarts. */
export class OrderBook {
  private decided: Record<string, OrderDecision> = {};

  constructor(private inboxDir: string, private stateFile?: string) {
    if (!stateFile) return;
    try {
      this.decided = JSON.parse(fs.readFileSync(stateFile, "utf8")) ?? {};
    } catch {
      // first run
    }
  }

  /** Records the decision and writes it for the trading program, unless the code was already decided. */
  decide(d: OrderDecision): { status: "written"; file: string } | { status: "already"; earlier: OrderDecision } {
    const earlier = this.decided[d.id];
    if (earlier) return { status: "already", earlier };
    const file = writeOrderDecision(this.inboxDir, d);
    this.decided[d.id] = d;
    this.prune();
    this.save();
    return { status: "written", file };
  }

  // Codes are only 4 characters and will be reused eventually; forget decisions older than 7 days.
  private prune(): void {
    const cutoff = Date.now() - 7 * 86400_000;
    for (const [id, d] of Object.entries(this.decided)) if (Date.parse(d.time) < cutoff) delete this.decided[id];
  }

  private save(): void {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.decided, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }
}

/** Whether an outbox message is an order approval request from the trading program. */
export const isApprovalRequest = (text: string) => /OMS APPROVAL NEEDED/i.test(text);
