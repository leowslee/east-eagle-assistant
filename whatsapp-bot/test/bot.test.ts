import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { Assistant, type Messenger } from "../src/agent.js";
import { MemoryAuditLog } from "../src/audit.js";
import type { Config } from "../src/config.js";
import { Drive, DriveError } from "../src/drive.js";
import { extractText, isAddressedToBot, stripAddress } from "../src/route.js";
import { MemoryStore } from "../src/store.js";

function tempDrive() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
  fs.mkdirSync(path.join(root, "Trading", "NAV"), { recursive: true });
  fs.writeFileSync(path.join(root, "Trading", "NAV", "NAV pack Oct 2026.txt"), "NAV per share 123.45");
  fs.writeFileSync(path.join(root, "Trading", "notes.md"), "hello");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  return { root, outside };
}

function config(root: string): Config {
  return {
    assistantName: "Eileen",
    triggerWords: ["eileen"],
    driveRoots: [{ name: "X drive", path: root }],
    staff: [
      { name: "Leo", phone: "85290000001" },
      { name: "Amy", phone: "85290000002" },
    ],
    approvers: ["85290000001"],
    allowedGroups: [],
    answerAnyGroupMember: false,
    dataDir: "data",
    logDir: "logs",
    model: "claude-opus-5-5",
    effort: "medium",
    conversationIdleHours: 4,
  };
}

test("drive: search, list, read", async () => {
  const { root } = tempDrive();
  const drive = new Drive([{ name: "X drive", path: root }]);
  const found = await drive.searchFiles("nav oct");
  assert.equal(found.results.length, 1);
  assert.match(found.results[0].path, /NAV pack Oct 2026\.txt$/);
  const listing = await drive.listFolder("X drive/Trading");
  assert.deepEqual(listing.entries.map((e) => e.type), ["folder", "file"]);
  const read = await drive.readFile(found.results[0].path);
  assert.equal(read.text, "NAV per share 123.45");
});

test("drive: reads Excel sheets as rows", async () => {
  const { root } = tempDrive();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Positions");
  ws.addRow(["Ticker", "Qty"]);
  ws.addRow(["700 HK", 1000]);
  await wb.xlsx.writeFile(path.join(root, "positions.xlsx"));
  const drive = new Drive([{ name: "X drive", path: root }]);
  const read = await drive.readFile(path.join(root, "positions.xlsx"));
  assert.match(read.text, /## Sheet: Positions/);
  assert.match(read.text, /2: 700 HK,1000/);
});

test("drive: refuses paths outside the allowed folders", async () => {
  const { root, outside } = tempDrive();
  const drive = new Drive([{ name: "X drive", path: root }]);
  await assert.rejects(drive.readFile(path.join(outside, "secret.txt")), DriveError);
  await assert.rejects(drive.readFile(path.join(root, "..", path.basename(outside), "secret.txt")), DriveError);
  fs.symlinkSync(outside, path.join(root, "link"));
  await assert.rejects(drive.readFile(path.join(root, "link", "secret.txt")), DriveError);
  await assert.rejects(drive.writeTextFile(path.join(outside, "x.txt"), "x", false), DriveError);
});

test("drive: write operations", async () => {
  const { root } = tempDrive();
  const drive = new Drive([{ name: "X drive", path: root }]);
  await drive.createFolder(path.join(root, "Reports"));
  await drive.writeTextFile(path.join(root, "Reports", "a.csv"), "x,y", false);
  await assert.rejects(drive.writeTextFile(path.join(root, "Reports", "a.csv"), "x,y", false));
  await assert.rejects(drive.writeTextFile(path.join(root, "Reports", "a.exe"), "x", false), DriveError);
  await drive.copyFile(path.join(root, "Reports", "a.csv"), path.join(root, "Reports", "b.csv"));
  await drive.moveFile(path.join(root, "Reports", "b.csv"), path.join(root, "Reports", "c.csv"));
  assert.deepEqual(fs.readdirSync(path.join(root, "Reports")).sort(), ["a.csv", "c.csv"]);
});

test("routing: mentions, replies and trigger words", () => {
  const cfg = config("/x");
  const bot = { ids: ["85299999999:3@s.whatsapp.net", "123456789@lid"] };
  const mention = extractText({ extendedTextMessage: { text: "@123456789 where is the NAV pack?", contextInfo: { mentionedJid: ["123456789@lid"] } } });
  assert.ok(isAddressedToBot(mention, bot, cfg));
  assert.equal(stripAddress(mention.text, bot, cfg), "where is the NAV pack?");
  const byName = extractText({ conversation: "Eileen, find the Oct NAV" });
  assert.ok(isAddressedToBot(byName, bot, cfg));
  assert.equal(stripAddress(byName.text, bot, cfg), "find the Oct NAV");
  const reply = extractText({
    extendedTextMessage: { text: "and September?", contextInfo: { participant: "85299999999@s.whatsapp.net", quotedMessage: { conversation: "Oct NAV is 123" } } },
  });
  assert.ok(isAddressedToBot(reply, bot, cfg));
  assert.equal(reply.quotedText, "Oct NAV is 123");
  assert.ok(!isAddressedToBot(extractText({ conversation: "lunch at 1?" }), bot, cfg));
  assert.ok(!isAddressedToBot(extractText({ conversation: "eileenx test" }), bot, cfg));
});

// Fake Claude: returns scripted responses and records the messages it was sent.
function fakeClaude(responses: { content: any[]; stop_reason: string }[]) {
  const requests: any[] = [];
  return {
    requests,
    client: {
      beta: {
        messages: {
          create: async (params: any) => {
            requests.push(structuredClone(params.messages));
            const next = responses.shift();
            if (!next) throw new Error("no more scripted responses");
            return { ...next, stop_details: null };
          },
        },
      },
    } as any,
  };
}

function fakeMessenger() {
  const sent: { chatId: string; text?: string; file?: string }[] = [];
  const messenger: Messenger = {
    async sendText(chatId, text) {
      sent.push({ chatId, text });
    },
    async sendFile(chatId, file) {
      sent.push({ chatId, file });
    },
  };
  return { sent, messenger };
}

const incoming = (text: string, sender = "Amy", phone = "85290000002") => ({
  chatId: "group1@g.us", chatName: "Ops team", isGroup: true, senderName: sender, senderPhone: phone, text,
});

test("agent: searches the drive and answers", async () => {
  const { root } = tempDrive();
  const { client, requests } = fakeClaude([
    { content: [{ type: "tool_use", id: "t1", name: "search_files", input: { query: "nav oct" } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "NAV per share is 123.45 (NAV pack Oct 2026.txt)." }], stop_reason: "end_turn" },
  ]);
  const store = new MemoryStore();
  const audit = new MemoryAuditLog();
  const { messenger } = fakeMessenger();
  const a = new Assistant(config(root), new Drive([{ name: "X drive", path: root }]), store, audit, messenger, client);
  const reply = await a.handle(incoming("what's the Oct NAV?"));
  assert.match(reply, /123\.45/);
  const toolResult = requests[1].at(-1).content[0];
  assert.equal(toolResult.tool_use_id, "t1");
  assert.match(toolResult.content, /NAV pack Oct 2026/);
  assert.deepEqual(store.load("group1@g.us")!.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.ok(audit.entries.some((e) => e.event === "tool_call"));
});

test("agent: changes wait for the approver's YES", async () => {
  const { root } = tempDrive();
  const { client } = fakeClaude([
    { content: [{ type: "tool_use", id: "t1", name: "create_folder", input: { folder: path.join(root, "Reports") } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "I've asked Leo to approve it." }], stop_reason: "end_turn" },
  ]);
  const { sent, messenger } = fakeMessenger();
  const a = new Assistant(config(root), new Drive([{ name: "X drive", path: root }]), new MemoryStore(), new MemoryAuditLog(), messenger, client);
  await a.handle(incoming("make a Reports folder"));
  assert.ok(!fs.existsSync(path.join(root, "Reports")));
  const request = sent.find((s) => s.chatId === "85290000001@s.whatsapp.net")!;
  const code = request.text!.match(/YES (\d{4})/)![1];

  assert.equal(await a.handleApproval("85290000002", "Amy", `YES ${code}`), undefined); // not an approver
  assert.ok(!fs.existsSync(path.join(root, "Reports")));
  assert.match((await a.handleApproval("85290000001", "Leo", `YES ${code}`))!, /Approved/);
  assert.ok(fs.existsSync(path.join(root, "Reports")));
  assert.match(sent.at(-1)!.text!, /Done, approved by Leo/);
  assert.equal(sent.at(-1)!.chatId, "group1@g.us");
});

test("agent: NO rejects, and plain chat isn't taken as approval", async () => {
  const { root } = tempDrive();
  const { client } = fakeClaude([
    { content: [{ type: "tool_use", id: "t1", name: "write_text_file", input: { path: path.join(root, "a.txt"), content: "hi" } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Waiting for approval." }], stop_reason: "end_turn" },
  ]);
  const { sent, messenger } = fakeMessenger();
  const a = new Assistant(config(root), new Drive([{ name: "X drive", path: root }]), new MemoryStore(), new MemoryAuditLog(), messenger, client);
  await a.handle(incoming("save a note"));
  assert.equal(await a.handleApproval("85290000001", "Leo", "what's on today?"), undefined);
  assert.match((await a.handleApproval("85290000001", "Leo", "no"))!, /Rejected/);
  assert.ok(!fs.existsSync(path.join(root, "a.txt")));
  assert.match(sent.at(-1)!.text!, /didn't approve/);
});

test("agent: API error leaves stored history untouched", async () => {
  const { root } = tempDrive();
  const { client } = fakeClaude([]);
  const store = new MemoryStore();
  const { messenger } = fakeMessenger();
  const a = new Assistant(config(root), new Drive([{ name: "X drive", path: root }]), store, new MemoryAuditLog(), messenger, client);
  const reply = await a.handle(incoming("hello"));
  assert.match(reply, /couldn't reach/);
  assert.equal(store.load("group1@g.us"), undefined);
});
