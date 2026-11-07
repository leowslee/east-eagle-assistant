// Read-only access to the company network drive, limited to the folders in config.driveRoots.

import fs from "node:fs/promises";
import path from "node:path";
import type { DriveRoot } from "./config.js";

const MAX_TEXT_CHARS = 60_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_SHEET_ROWS = 400;
const SEARCH_MAX_ENTRIES = 60_000;
const SEARCH_MAX_MS = 20_000;
const SKIP_DIRS = new Set(["$recycle.bin", "system volume information", "node_modules", ".git"]);

export class DriveError extends Error {}

export interface FileEntry {
  path: string;
  type: "file" | "folder";
  size?: number;
  modified: string;
}

export class Drive {
  readonly roots: { name: string; path: string }[];

  constructor(roots: DriveRoot[]) {
    this.roots = roots.map((r) => ({ name: r.name, path: path.resolve(r.path) }));
  }

  describeRoots(): string {
    return this.roots.map((r) => `${r.name}: ${r.path}`).join("\n");
  }

  /** Resolves a path and checks it stays inside an allowed root, symlinks included. */
  async resolve(input: string): Promise<string> {
    let candidate = input.trim();
    for (const root of this.roots) {
      // Accept "X drive/Trading" as well as "X:\Trading".
      if (candidate.toLowerCase() === root.name.toLowerCase()) candidate = root.path;
      else if (candidate.toLowerCase().startsWith(root.name.toLowerCase() + "/") || candidate.toLowerCase().startsWith(root.name.toLowerCase() + "\\"))
        candidate = path.join(root.path, candidate.slice(root.name.length + 1));
    }
    if (!path.isAbsolute(candidate)) candidate = path.join(this.roots[0].path, candidate);
    const resolved = path.resolve(candidate);
    let real: string;
    try {
      real = await fs.realpath(resolved);
    } catch {
      throw new DriveError(`Not found: ${input}`);
    }
    // Compare real paths with the roots' real paths: on Windows a mapped drive's real path is its \\server\share form.
    if (!this.inside(resolved) || !within(await this.realRoots(), real))
      throw new DriveError(`Outside the folders I'm allowed to read: ${input}`);
    return resolved;
  }

  private realRootPaths?: string[];

  private async realRoots(): Promise<string[]> {
    if (!this.realRootPaths) {
      this.realRootPaths = await Promise.all(this.roots.map((r) => fs.realpath(r.path).catch(() => r.path)));
    }
    return this.realRootPaths;
  }

  private inside(p: string): boolean {
    return within(this.roots.map((r) => r.path), p);
  }

  async listFolder(folder: string): Promise<{ folder: string; entries: FileEntry[]; note?: string }> {
    const dir = await this.resolve(folder);
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const d of dirents) {
      if (SKIP_DIRS.has(d.name.toLowerCase()) || d.name.startsWith("~$")) continue;
      const full = path.join(dir, d.name);
      try {
        const st = await fs.stat(full);
        entries.push({
          path: full,
          type: st.isDirectory() ? "folder" : "file",
          size: st.isDirectory() ? undefined : st.size,
          modified: st.mtime.toISOString(),
        });
      } catch {
        // Unreadable entry (permissions, broken link): leave it out.
      }
    }
    entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "folder" ? -1 : 1));
    const limit = 300;
    return {
      folder: dir,
      entries: entries.slice(0, limit),
      note: entries.length > limit ? `Showing ${limit} of ${entries.length} entries. Use search_files to narrow down.` : undefined,
    };
  }

  /** Finds files whose name (or folder path) contains every word of the query. Newest first. */
  async searchFiles(
    query: string,
    opts: { folder?: string; extension?: string; modifiedAfter?: string; maxResults?: number } = {},
  ): Promise<{ results: FileEntry[]; note?: string }> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const ext = opts.extension?.toLowerCase().replace(/^\.?/, ".");
    const after = opts.modifiedAfter ? new Date(opts.modifiedAfter).getTime() : undefined;
    const maxResults = Math.min(opts.maxResults ?? 30, 100);
    const starts = opts.folder ? [await this.resolve(opts.folder)] : this.roots.map((r) => r.path);

    const results: FileEntry[] = [];
    const queue = [...starts];
    const began = Date.now();
    let scanned = 0;
    let stopped = "";
    while (queue.length) {
      if (scanned > SEARCH_MAX_ENTRIES) {
        stopped = "entry limit";
        break;
      }
      if (Date.now() - began > SEARCH_MAX_MS) {
        stopped = "time limit";
        break;
      }
      const dir = queue.shift()!;
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        scanned++;
        const name = d.name.toLowerCase();
        if (SKIP_DIRS.has(name) || name.startsWith("~$")) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          queue.push(full);
          continue;
        }
        if (!d.isFile()) continue;
        if (ext && !name.endsWith(ext)) continue;
        const haystack = full.toLowerCase();
        if (!words.every((w) => name.includes(w) || haystack.includes(w))) continue;
        try {
          const st = await fs.stat(full);
          if (after && st.mtime.getTime() < after) continue;
          results.push({ path: full, type: "file", size: st.size, modified: st.mtime.toISOString() });
        } catch {
          // skip
        }
      }
    }
    results.sort((a, b) => b.modified.localeCompare(a.modified));
    const notes = [];
    if (results.length > maxResults) notes.push(`${results.length} matches; showing the ${maxResults} most recently modified.`);
    if (stopped) notes.push(`Search stopped early (${stopped}) after ${scanned} entries. Give a folder to search a smaller area.`);
    return { results: results.slice(0, maxResults), note: notes.join(" ") || undefined };
  }

  async readFile(file: string, startChar = 0): Promise<{ path: string; text: string; totalChars: number; note?: string }> {
    const full = await this.resolve(file);
    const st = await fs.stat(full);
    if (st.isDirectory()) throw new DriveError("That's a folder. Use list_folder.");
    if (st.size > MAX_FILE_BYTES) throw new DriveError(`File is too large to read (${Math.round(st.size / 1e6)} MB).`);
    const text = await extractText(full, await fs.readFile(full));
    const slice = text.slice(startChar, startChar + MAX_TEXT_CHARS);
    const end = startChar + slice.length;
    return {
      path: full,
      text: slice,
      totalChars: text.length,
      note: end < text.length ? `Showing characters ${startChar}-${end} of ${text.length}. Call again with start_char=${end} for more.` : undefined,
    };
  }

  // Changes. The agent only calls these after an approver has replied YES.

  /** Resolves a path that may not exist yet: its parent folder must exist inside an allowed root. */
  async resolveForWrite(input: string): Promise<string> {
    const target = path.resolve(path.isAbsolute(input.trim()) ? input.trim() : path.join(this.roots[0].path, input.trim()));
    const parent = await this.resolve(path.dirname(target));
    const full = path.join(parent, path.basename(target));
    if (!this.inside(full) || full === parent) throw new DriveError(`Outside the folders I'm allowed to change: ${input}`);
    return full;
  }

  async createFolder(folder: string): Promise<string> {
    const full = await this.resolveForWrite(folder);
    await fs.mkdir(full);
    return full;
  }

  async writeTextFile(file: string, content: string, overwrite: boolean): Promise<string> {
    const full = await this.resolveForWrite(file);
    if (!WRITABLE_EXTENSIONS.has(path.extname(full).toLowerCase()))
      throw new DriveError(`I can only write text files (${[...WRITABLE_EXTENSIONS].join(", ")}).`);
    await fs.writeFile(full, content, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
    return full;
  }

  async copyFile(from: string, to: string): Promise<string> {
    const src = await this.resolve(from);
    const dest = await this.resolveForWrite(to);
    await fs.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
    return dest;
  }

  async moveFile(from: string, to: string): Promise<string> {
    const src = await this.resolve(from);
    const dest = await this.resolveForWrite(to);
    if (await exists(dest)) throw new DriveError(`Something already exists at ${dest}`);
    await fs.rename(src, dest);
    return dest;
  }

  /** For sending a file into the chat. */
  async fileForSending(file: string): Promise<{ path: string; name: string; size: number }> {
    const full = await this.resolve(file);
    const st = await fs.stat(full);
    if (!st.isFile()) throw new DriveError("Only files can be sent.");
    if (st.size > MAX_FILE_BYTES) throw new DriveError("File is too large to send (over 50 MB).");
    return { path: full, name: path.basename(full), size: st.size };
  }
}

function within(roots: string[], p: string): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

const WRITABLE_EXTENSIONS = new Set([".txt", ".csv", ".md", ".json"]);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const TEXT_EXTENSIONS = new Set([".txt", ".csv", ".md", ".json", ".log", ".xml", ".html", ".htm", ".tsv", ".ini", ".sql", ".py", ".js", ".ts"]);

export async function extractText(file: string, data: Buffer): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return data.toString("utf8");
  if (ext === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(data) });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ buffer: data })).value;
  }
  if (ext === ".xlsx" || ext === ".xlsm") {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(data as unknown as ArrayBuffer);
    const parts: string[] = [];
    workbook.eachSheet((sheet) => {
      const rows: string[] = [];
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rows.length >= MAX_SHEET_ROWS) return;
        const values = (row.values as unknown[]).slice(1).map((_v, i) => csvCell(row.getCell(i + 1).text));
        rows.push(`${rowNumber}: ${values.join(",")}`);
      });
      const more = sheet.actualRowCount > MAX_SHEET_ROWS ? `\n[Only the first ${MAX_SHEET_ROWS} of ${sheet.actualRowCount} rows shown.]` : "";
      parts.push(`## Sheet: ${sheet.name}\n${rows.join("\n")}${more}`);
    });
    return parts.join("\n\n");
  }
  throw new DriveError(`Can't read ${ext || "this"} files as text. Supported: PDF, Word (.docx), Excel (.xlsx), and text files. The file can still be sent with send_file.`);
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
