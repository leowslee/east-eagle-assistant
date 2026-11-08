// Read-only access to Claude skills saved on this PC (folders containing SKILL.md), limited to a chosen list.

import fs from "node:fs";
import path from "node:path";

export interface SkillsConfig {
  dir: string; // e.g. C:\Users\Leo\.claude\skills
  include: string[]; // skill folder names Eileen may use; staff can see them, so leave out personal ones
}

export interface SkillInfo {
  name: string;
  description: string;
  folder: string;
}

const MAX_CHARS = 60_000;

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

export class Skills {
  readonly list: SkillInfo[];

  constructor(cfg: SkillsConfig) {
    const wanted = new Set(cfg.include.map((s) => s.toLowerCase()));
    this.list = [];
    if (!cfg.dir || !fs.existsSync(cfg.dir)) return;
    for (const d of fs.readdirSync(cfg.dir, { withFileTypes: true })) {
      if (!d.isDirectory() || !wanted.has(d.name.toLowerCase())) continue;
      const folder = path.join(cfg.dir, d.name);
      const file = path.join(folder, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const fm = frontmatter(fs.readFileSync(file, "utf8"));
      this.list.push({ name: fm.name || d.name, description: fm.description || "", folder });
    }
    this.list.sort((a, b) => a.name.localeCompare(b.name));
  }

  describe(): string {
    return this.list.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  }

  /** Reads SKILL.md, or another file inside the skill's folder (e.g. references/records.md). */
  read(name: string, file = "SKILL.md"): { text: string; files?: string[]; note?: string } {
    const skill = this.list.find((s) => s.name.toLowerCase() === name.trim().toLowerCase() || path.basename(s.folder).toLowerCase() === name.trim().toLowerCase());
    if (!skill) throw new Error(`No skill called "${name}". Available: ${this.list.map((s) => s.name).join(", ") || "none"}.`);
    const full = path.resolve(skill.folder, file);
    const rel = path.relative(skill.folder, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("That file is outside the skill's folder.");
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`No file ${file} in skill ${skill.name}.`);
    const text = fs.readFileSync(full, "utf8");
    const files = file === "SKILL.md" ? listFiles(skill.folder).filter((f) => f !== "SKILL.md") : undefined;
    return {
      text: text.slice(0, MAX_CHARS),
      files,
      note: text.length > MAX_CHARS ? `Only the first ${MAX_CHARS} of ${text.length} characters shown.` : undefined,
    };
  }
}

function listFiles(root: string, sub = ""): string[] {
  const out: string[] = [];
  for (const d of fs.readdirSync(path.join(root, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...listFiles(root, rel));
    else if (/\.(md|txt|csv|json)$/i.test(d.name)) out.push(rel);
  }
  return out.slice(0, 200);
}
