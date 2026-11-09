# East Eagle WhatsApp group assistant

An AI assistant that sits in East Eagle's WhatsApp groups as a normal member. When a colleague mentions it, it searches and reads the network drive (`X:\`), answers in the chat, and can send files from the drive into the chat. It runs on an office Windows PC that is linked to the assistant's WhatsApp number in the same way WhatsApp Web is.

## Important: this is not an official WhatsApp integration

The bot connects through the WhatsApp Web protocol, which WhatsApp does not offer to businesses for automation. This breaks WhatsApp's terms of service. WhatsApp may **ban the assistant's number without warning**, and an update from WhatsApp can stop the bot working until the library is updated. Use a number the firm can afford to lose. Don't use the bot for client communications.

## What it does

- **In groups** it only reacts when someone @mentions it, replies to one of its messages, or starts a message with its name ("Eileen, where's the October NAV pack?"). Other group messages are not read, stored or sent anywhere.
- **In private chats** it answers every message from staff on the list.
- **Only people on the staff list get answers.** Anyone else is ignored and logged.
- **The internet.** She can search the web and read public web pages (news, announcements, prices). Set `"webSearch": false` in config.json to turn this off. Searches go through Anthropic's web search, so she is told never to put client or position details into a search.
- **Roles.** Eileen works as the team's financial analyst (news, announcements, filings), administrative staff (records, forms, letters, emails) and compliance officer (SFC rules, CPT, accounting standards, citing official sources). Her analysis is internal research, and compliance judgements stay with the Responsible Officers.
- **Records and forms.** She can add a row to a records spreadsheet (.xlsx or .csv, for example a CPT attendance log), and fill in a Word (.docx) form by saving a completed copy, which she can also send into the chat. The original form is never changed. Records go in `recordsFolder`. These are changes, so they need the approver's YES, unless you set `"recordsNeedApproval": false`. Then adding records and saving new filled forms *inside the records folder only* happens without asking.
- **Email.** With `emailFrom` set and a Google app password for that mailbox in `.env` as `EMAIL_APP_PASSWORD=...`, she can send email. Every email goes to the approver in full first and is sent only after `YES <code>`. To create the app password, sign in to Google as the mailbox, turn on 2-Step Verification, then visit myaccount.google.com/apppasswords.
- **Posting in other groups.** Ask Eileen to post a message (or a drive file) in another group she belongs to, e.g. "Eileen, post this in East Eagle AM Inv: …". When an approver asks, it goes straight away; anyone else's request needs the approver's YES first.
- **Live P&L from the PMS.** Ask "Eileen, what's the P&L now?" and she reads the CDF PMS server on this PC (`pmsUrl`, default `http://127.0.0.1:8765`), the same numbers the PMS page shows, read-only. Set `"pmsUrl": ""` to turn it off. If the bot runs on a different PC from the PMS, use the PMS PC's address, e.g. `http://192.168.101.239:8765`.
- **Skills.** Eileen can read Claude skills saved on this PC, so she knows the firm's systems the way Claude does. In config.json set `"skills": { "dir": "C:\\Users\\Leo\\.claude\\skills", "include": ["cdf-pms", "cdf-middle-office"] }`. Only the folders in `include` are used, and staff can see what's in them, so leave personal skills out. To add one, put its name in `include` (it must be a folder with a SKILL.md in `dir`) and restart. She reads skills as know-how only: she can't run their scripts.
- **Read receipts.** Every incoming message in her chats is marked as read (blue ticks), so the assistant's phone doesn't fill up with unread chats. This is only the read mark: ordinary group chatter is still not processed or logged. Set `"markAllRead": false` to turn it off.
- **Reading the drive is always allowed.** It searches file names and folders, lists folders, and reads PDF, Word (.docx), Excel (.xlsx) and text files.
- **Changes need approval.** Creating folders, saving text files, and copying or moving files are never done directly. The approver (Leo) gets a private WhatsApp message describing the exact change and a 4-digit code, and the change happens only after the reply `YES 1234`. `NO 1234` rejects it. The bot can't delete files or edit Word, Excel or PDF files.
- **Audit log.** Every message the bot handles, every reply, file read, file sent and change is written to `logs\YYYY-MM-DD.jsonl`, one line per event.
- **Scheduled tasks.** Anyone on the staff list can ask Eileen to do something at set times, in a group or a private chat: "Eileen, every weekday at 8:30 summarise the latest positions file in X:\Trading" or "Eileen, tomorrow at 5pm remind us to check the NAV pack". She confirms with a code such as `T4821` and posts the result in that chat at the time (Hong Kong time). "Eileen, what's scheduled?" lists them. "Eileen, cancel T4821" removes one; only the person who set it up or an approver can cancel. A scheduled task follows the same rules: drive changes still need the approver's YES. If the PC was asleep at the time, the task still runs if the bot is back within 2 hours.
- **Fixed reports in config.json.** You can also list reports under `schedules` in config.json (see `config.example.json`): `group` is the group name exactly as in WhatsApp, `time` is `HH:MM` Hong Kong time, and `days` is optional (leave it out for every day). These can only be changed by editing the file and restarting.
- Send `new` to start a fresh conversation. Conversations also restart after 4 hours of quiet.

## Install on the office PC

You need: the PC that can see `X:\`, the spare phone with WhatsApp on the assistant's number, and the Anthropic API key.

1. **Install Node.js.** Download the LTS Windows installer from [nodejs.org](https://nodejs.org) and run it with the default options.
2. **Get the code.** On GitHub, open the repository, click **Code > Download ZIP**, and unzip it to `C:\EastEagleBot`.
3. **Install the bot's packages.** In File Explorer open `C:\EastEagleBot\whatsapp-bot`, type `powershell` in the address bar and press Enter. In the blue window run:
   ```
   npm install
   ```
4. **Settings.** Copy `config.example.json` to `config.json` and open it in Notepad:
   - `staff`: everyone who may use the bot, with WhatsApp numbers including `852`.
   - `approvers`: the numbers that approve changes (yours).
   - `driveRoots`: the folders it may read. To limit it, replace `X:\\` with specific folders, for example `X:\\Trading` (note the double backslashes).
   - `allowedGroups`: leave empty to answer in any group it is added to, or list group names.
5. **API key.** Create a file named `.env` in the same folder containing one line:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
6. **Start it and link WhatsApp.** Run:
   ```
   npm start
   ```
   A QR code appears. On the spare phone open **WhatsApp > Settings > Linked devices > Link a device** and scan it. The window then says `Connected`.
7. **Add the assistant's number to your groups**, then try: `@Eileen what's in X:\Trading?`

Leave the window open. Closing it stops the bot.

## Keep it running

- **Start automatically:** open **Task Scheduler > Create Task**. On *General*, choose *Run only when user is logged on*. This matters because a mapped `X:` drive is only visible to the logged-in user. On *Triggers*, add *At log on*. On *Actions*, add *Start a program* with Program `C:\EastEagleBot\whatsapp-bot\start.bat`. On *Settings*, tick *If the task fails, restart every 1 minute*.
- **Power:** set Windows to never sleep (Settings > System > Power).
- **The phone:** keep it charged and connected to the internet. WhatsApp unlinks devices if the phone is offline for about 14 days.
- **If it gets unlinked:** delete the `data\auth` folder and run `npm start` again to scan a new QR code.

## Safety options

- **Read-only at Windows level.** For extra protection, run the bot under a Windows account that only has read access to `X:\`. Approved changes will then fail with an "access denied" message instead of being made.
- **Fewer folders.** List only the folders the bot needs in `driveRoots`.
- **Logs.** `logs\` holds the audit records. Back the folder up with the firm's other records. Files there can be edited by anyone with access to the PC, so they are not tamper-proof.

## Files

| Path | What it is |
|---|---|
| `src/index.ts` | WhatsApp connection, QR code, deciding which messages to answer |
| `src/route.ts` | Mention, reply and name detection; staff and group checks |
| `src/agent.ts` | Claude conversation, tools and the approval flow |
| `src/drive.ts` | Search, list, read, and the approved change operations, limited to `driveRoots` |
| `src/email.ts` | Sending approved email |
| `src/schedule.ts` | Scheduled tasks and reports |
| `src/audit.ts` | Daily audit log files |
| `test/` | Tests (`npm test`) |
