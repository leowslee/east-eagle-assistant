import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { Assistant, type Messenger } from "../src/agent.js";
import { MemoryAuditLog } from "../src/audit.js";
import type { Config } from "../src/config.js";
import { Drive, DriveError, extractText as driveText } from "../src/drive.js";
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
    webSearch: true,
    emailFrom: "eileen@example.com",
    recordsFolder: path.join(root, "Records"),
    recordsNeedApproval: true,
    pmsUrl: "",
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

test("agent: a rejected saved conversation restarts and retries", async () => {
  const { root } = tempDrive();
  const store = new MemoryStore();
  store.save("group1@g.us", { messages: [{ role: "user", content: "old" }, { role: "assistant", content: [{ type: "text", text: "old reply" }] }], updated: Date.now() });
  let calls = 0;
  const client: any = { beta: { messages: { create: async (p: any) => {
    calls++;
    if (p.messages.length > 1) throw Object.assign(new Error("400 Invalid `signature` in `thinking` block"), { status: 400 });
    return { content: [{ type: "text", text: "Hi!" }], stop_reason: "end_turn", stop_details: null };
  } } } };
  const { messenger } = fakeMessenger();
  const a = new Assistant(config(root), new Drive([{ name: "X drive", path: root }]), store, new MemoryAuditLog(), messenger, client);
  assert.equal(await a.handle(incoming("hi")), "Hi!");
  assert.equal(calls, 2);
  assert.equal(store.load("group1@g.us")!.messages.length, 2);
});

test("agent: a paused web search turn is continued", async () => {
  const { root } = tempDrive();
  const { client, requests } = fakeClaude([
    { content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "HSI close" } }], stop_reason: "pause_turn" },
    { content: [{ type: "text", text: "The HSI closed at 26,000 (source: HKEX)." }], stop_reason: "end_turn" },
  ]);
  const { messenger } = fakeMessenger();
  const a = new Assistant(config(root), new Drive([{ name: "X drive", path: root }]), new MemoryStore(), new MemoryAuditLog(), messenger, client);
  assert.match(await a.handle(incoming("where did the HSI close?")), /26,000/);
  assert.equal(requests[1].at(-1).role, "assistant");
});

test("drive: add records to csv and xlsx", async () => {
  const { root } = tempDrive();
  const drive = new Drive([{ name: "X drive", path: root }]);
  fs.mkdirSync(path.join(root, "Records"));
  const csv = path.join(root, "Records", "cpt.csv");
  await drive.addRecord(csv, { Name: "Leo", Course: "AML, 2026", Hours: "3" });
  await drive.addRecord(csv, { name: "Amy", course: "Ethics", hours: "2" });
  assert.equal(fs.readFileSync(csv, "utf8"), 'Name,Course,Hours\r\nLeo,"AML, 2026",3\r\nAmy,Ethics,2\r\n');
  await assert.rejects(drive.addRecord(csv, { Provider: "HKSI" }), /no column "Provider"/);

  const xlsx = path.join(root, "Records", "cpt.xlsx");
  await drive.addRecord(xlsx, { Name: "Leo", Hours: "3" });
  await drive.addRecord(xlsx, { Name: "Amy", Provider: "HKSI" });
  const text = await driveText(xlsx, fs.readFileSync(xlsx));
  assert.match(text, /1: Name,Hours,Provider/);
  assert.match(text, /3: Amy,,HKSI/);
  await assert.rejects(drive.addRecord(path.join(outsideDir(), "x.csv"), { a: "1" }), DriveError);
});

function outsideDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
}

async function makeDocx(file: string, paragraphsXml: string) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphsXml}</w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

test("drive: fill a Word form into a new copy, even when Word split the text", async () => {
  const { root } = tempDrive();
  const drive = new Drive([{ name: "X drive", path: root }]);
  const form = path.join(root, "form.docx");
  await makeDocx(form, '<w:p><w:r><w:t>Name: </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>____</w:t></w:r></w:p><w:p><w:r><w:t>Date: {{da</w:t></w:r><w:r><w:t>te}}</w:t></w:r></w:p><w:p><w:r><w:t>Unchanged &amp; kept</w:t></w:r></w:p>');
  const out = path.join(root, "filled.docx");
  const r = await drive.fillWordTemplate(form, out, [
    { find: "Name: ____", replace: "Name: Leo & Co" },
    { find: "{{date}}", replace: "7 Nov 2026" },
    { find: "Signature", replace: "x" },
  ]);
  assert.deepEqual(r.missing, ["Signature"]);
  const text = await driveText(out, fs.readFileSync(out));
  assert.match(text, /Name: Leo & Co/);
  assert.match(text, /Date: 7 Nov 2026/);
  assert.match(text, /Unchanged & kept/);
  assert.match(await driveText(form, fs.readFileSync(form)), /Name: ____/); // original untouched
  await assert.rejects(drive.fillWordTemplate(form, out, []), /already exists/);
});

test("agent: email waits for YES, then is sent", async () => {
  const { root } = tempDrive();
  const { client } = fakeClaude([
    { content: [{ type: "tool_use", id: "t1", name: "send_email", input: { to: ["ops@example.com"], subject: "NAV", body: "Hi,\nNAV attached.\nEileen", attachments: [path.join(root, "Trading", "notes.md")] } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Waiting for Leo." }], stop_reason: "end_turn" },
  ]);
  const { sent, messenger } = fakeMessenger();
  const emails: any[] = [];
  const mailer = { from: "eileen@example.com", async send(e: any) { emails.push(e); return "id1"; } };
  const a = new Assistant(config(root), new Drive([{ name: "X drive", path: root }]), new MemoryStore(), new MemoryAuditLog(), messenger, client, undefined, mailer);
  await a.handle(incoming("email ops the NAV"));
  assert.equal(emails.length, 0);
  const request = sent.find((s) => s.chatId === "85290000001@s.whatsapp.net")!;
  assert.match(request.text!, /To: ops@example.com[\s\S]*NAV attached/);
  const code = request.text!.match(/YES (\d{4})/)![1];
  assert.match((await a.handleApproval("85290000001", "Leo", `YES ${code}`))!, /sent to ops@example.com/);
  assert.equal(emails[0].attachments[0].filename, "notes.md");
});

test("agent: records folder can skip approval when configured", async () => {
  const { root } = tempDrive();
  fs.mkdirSync(path.join(root, "Records"));
  const cfg = { ...config(root), recordsNeedApproval: false };
  const { client } = fakeClaude([
    { content: [{ type: "tool_use", id: "t1", name: "add_record", input: { path: path.join(root, "Records", "cpt.csv"), values: { Name: "Amy" } } }], stop_reason: "tool_use" },
    { content: [{ type: "tool_use", id: "t2", name: "add_record", input: { path: path.join(root, "Trading", "other.csv"), values: { Name: "Amy" } } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Recorded." }], stop_reason: "end_turn" },
  ]);
  const { sent, messenger } = fakeMessenger();
  const a = new Assistant(cfg, new Drive([{ name: "X drive", path: root }]), new MemoryStore(), new MemoryAuditLog(), messenger, client);
  await a.handle(incoming("log my CPT"));
  assert.ok(fs.existsSync(path.join(root, "Records", "cpt.csv")));
  assert.ok(!fs.existsSync(path.join(root, "Trading", "other.csv"))); // outside the records folder: waits for YES
  assert.equal(sent.filter((s) => s.chatId === "85290000001@s.whatsapp.net").length, 1);
});

test("agent: post to another group — straight away for the approver, YES for others", async () => {
  const { root } = tempDrive();
  const script = () => fakeClaude([
    { content: [{ type: "tool_use", id: "t1", name: "post_to_group", input: { group: "east eagle am inv", text: "P&L posted" } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "OK." }], stop_reason: "end_turn" },
  ]);
  const { sent, messenger } = fakeMessenger();
  messenger.findGroup = async (name) => (name.toLowerCase() === "east eagle am inv" ? { id: "inv@g.us", name: "East Eagle AM Inv" } : undefined);

  const leo = new Assistant(config(root), new Drive([{ name: "X drive", path: root }]), new MemoryStore(), new MemoryAuditLog(), messenger, script().client);
  await leo.handle({ ...incoming("post it", "Leo", "85290000001"), chatId: "leo@s.whatsapp.net", isGroup: false });
  assert.deepEqual(sent.filter((s) => s.chatId === "inv@g.us").map((s) => s.text), ["P&L posted"]);

  const amy = new Assistant(config(root), new Drive([{ name: "X drive", path: root }]), new MemoryStore(), new MemoryAuditLog(), messenger, script().client);
  await amy.handle(incoming("post it"));
  assert.equal(sent.filter((s) => s.chatId === "inv@g.us").length, 1); // not yet
  const request = sent.find((s) => s.chatId === "85290000001@s.whatsapp.net")!;
  assert.match(request.text!, /Post in WhatsApp group "East Eagle AM Inv"/);
  const code = request.text!.match(/YES (\d{4})/)![1];
  await amy.handleApproval("85290000001", "Leo", `YES ${code}`);
  assert.equal(sent.filter((s) => s.chatId === "inv@g.us").length, 2);
});

test("pms: compact live portfolio, largest P&L first, lines for a named group", async () => {
  const { Pms } = await import("../src/pms.js");
  const body = {
    as_of: "2026-11-08T11:02:00+08:00", nav: 23944653.69,
    pnl_cutoff: { date: "2026-11-06", local: "05:00 HKT" },
    totals: { pnl_us: -81825.013, delta_usd: 5712772.8, extra: { nested: 1 } },
    groups: [
      { name: "BRK B", pnl_us: 22478.67, rows: [{ symbol: "BRK B", pnl_us: 22478.67 }] },
      { label: "RTY options", pnl_us: -29629.03, rows: [{ symbol: "RTY 2675 P", pnl_us: -26250 }] },
    ],
  };
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => { urls.push(url); return new Response(JSON.stringify(body)); }) as unknown as typeof fetch;
  const pms = new Pms("http://127.0.0.1:8765/", fakeFetch);
  const p = (await pms.portfolio("rty")) as any;
  assert.equal(urls[0], "http://127.0.0.1:8765/api/portfolio");
  assert.equal(p.totals.pnl_us, -81825.01);
  assert.equal(p.totals.extra, undefined);
  assert.deepEqual(p.groups.map((g: any) => g.name), ["RTY options", "BRK B"]);
  assert.equal(p.groups[0].rows[0].pnl_us, -26250);
  assert.equal(p.groups[1].rows, undefined);
  const bad = new Pms("http://x", (async () => new Response("no", { status: 403 })) as unknown as typeof fetch);
  await assert.rejects(bad.portfolio(), /403/);
});
