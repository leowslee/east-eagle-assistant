// Order approvals for Leo's trading program (quant-platform). The program posts "OMS APPROVAL NEEDED" with a
// 4-character code through the outbox; Leo replies privately "APPROVE XXXX" or "REJECT XXXX", and the assistant
// writes the decision as a JSON file the program picks up. This is separate from the assistant's own YES codes.

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
