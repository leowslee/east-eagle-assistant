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
import { describeTiming, dueSchedules, isDue, TaskStore, validateSchedules } from "../src/schedule.js";
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
    schedules: [{ name: "Morning", group: "Ops team", time: "08:30", days: ["mon", "tue", "wed", "thu", "fri"], prompt: "Summarise positions" }],
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

// 2026-11-09 is a Monday. 00:30 UTC = 08:30 HKT.
const hk = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`);

test("schedule: due times, days, catch-up and once a day", () => {
  const s = [{ name: "Morning", group: "Ops", time: "08:30", days: ["mon", "tue", "wed", "thu", "fri"], prompt: "x" }];
  assert.equal(dueSchedules(s, hk("2026-11-09", "08:29"), {}).length, 0);
  assert.equal(dueSchedules(s, hk("2026-11-09", "08:30"), {}).length, 1);
  assert.equal(dueSchedules(s, hk("2026-11-09", "10:00"), {}).length, 1); // PC was asleep, catches up
  assert.equal(dueSchedules(s, hk("2026-11-09", "10:31"), {}).length, 0); // too late
  assert.equal(dueSchedules(s, hk("2026-11-09", "09:00"), { "config:Morning": "2026-11-09" }).length, 0);
  assert.equal(dueSchedules(s, hk("2026-11-08", "08:30"), {}).length, 0); // Sunday
  assert.ok(isDue({ time: "23:59", date: "2026-11-09" }, hk("2026-11-09", "23:59")));
  assert.ok(!isDue({ time: "09:00", date: "2026-11-10" }, hk("2026-11-09", "09:00")));
  assert.equal(describeTiming({ time: "08:30", days: ["fri", "mon", "tue", "wed", "thu"] }), "every weekday at 08:30");
  assert.throws(() => validateSchedules([{ name: "a", group: "g", time: "8:30", prompt: "x" }]), /HH:MM/);
  assert.throws(() => validateSchedules([{ name: "a", group: "g", time: "08:30", days: ["monday"], prompt: "x" }]), /unknown day/);
});

test("agent: members can schedule, list and cancel tasks", async () => {
  const { root } = tempDrive();
  const tasks = new TaskStore();
  const { client, requests } = fakeClaude([
    { content: [{ type: "tool_use", id: "t1", name: "schedule_task", input: { name: "Positions", instruction: "Summarise X:\\Trading positions", time: "08:30", days: ["mon", "tue", "wed", "thu", "fri"] } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Scheduled." }], stop_reason: "end_turn" },
  ]);
  const { messenger } = fakeMessenger();
  const a = new Assistant(config(root), new Drive([{ name: "X drive", path: root }]), new MemoryStore(), new MemoryAuditLog(), messenger, client, tasks);
  await a.handle(incoming("every weekday 8:30 summarise positions"));
  assert.equal(tasks.forChat("group1@g.us").length, 1);
  const task = tasks.tasks[0];
  assert.match(requests[1].at(-1).content[0].content, /every weekday at 08:30/);
  assert.equal(task.createdByPhone, "85290000002");

  // Someone else can't cancel it; the approver can.
  const { client: c2, requests: r2 } = fakeClaude([
    { content: [{ type: "tool_use", id: "t2", name: "cancel_scheduled_task", input: { code: task.id } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "No." }], stop_reason: "end_turn" },
    { content: [{ type: "tool_use", id: "t3", name: "list_scheduled_tasks", input: {} }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "List." }], stop_reason: "end_turn" },
    { content: [{ type: "tool_use", id: "t4", name: "cancel_scheduled_task", input: { code: task.id } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Cancelled." }], stop_reason: "end_turn" },
  ]);
  const b = new Assistant(config(root), new Drive([{ name: "X drive", path: root }]), new MemoryStore(), new MemoryAuditLog(), messenger, c2, tasks);
  await b.handle(incoming("cancel it", "Bob", "85290000009"));
  assert.equal(r2[1].at(-1).content[0].is_error, true);
  await b.handle(incoming("what's scheduled?", "Bob", "85290000009"));
  const listed = JSON.parse(r2[3].at(-1).content[0].content);
  assert.equal(listed.tasks[0].code, task.id);
  assert.equal(listed.fromConfig[0].name, "Morning");
  await b.handle(incoming("cancel it", "Leo", "85290000001"));
  assert.equal(tasks.tasks.length, 0);
});

test("agent: a scheduled run can't create more tasks", async () => {
  const { root } = tempDrive();
  const tasks = new TaskStore();
  const { client, requests } = fakeClaude([
    { content: [{ type: "tool_use", id: "t1", name: "schedule_task", input: { name: "Loop", instruction: "x", time: "09:00" } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Report." }], stop_reason: "end_turn" },
  ]);
  const { messenger } = fakeMessenger();
  const a = new Assistant(config(root), new Drive([{ name: "X drive", path: root }]), new MemoryStore(), new MemoryAuditLog(), messenger, client, tasks);
  await a.handle({ ...incoming("Summarise positions"), scheduled: { id: "T1234", name: "Morning", createdBy: "Amy" } });
  assert.match(requests[0].at(-1).content, /Scheduled task "Morning"/);
  assert.equal(requests[1].at(-1).content[0].is_error, true);
  assert.equal(tasks.tasks.length, 0);
});

test("schedule: task store saves to disk and survives a restart", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tasks-")), "schedules.json");
  const s = new TaskStore(file);
  const t = s.add({ name: "Once", chatId: "c", chatName: "C", time: "09:00", date: "2026-11-09", prompt: "x", createdBy: "Amy", createdByPhone: "1" });
  assert.equal(s.due(hk("2026-11-09", "09:01"))[0].id, t.id);
  s.markRun(t.id, "2026-11-09");
  const again = new TaskStore(file);
  assert.equal(again.due(hk("2026-11-09", "09:02")).length, 0);
  assert.equal(again.expired(hk("2026-11-10", "09:00")).length, 1);
});
