# East Eagle WhatsApp group assistant

An AI assistant that sits in East Eagle's WhatsApp groups as a normal member. When a colleague mentions it, it searches and reads the network drive (`X:\`), answers in the chat, and can send files from the drive into the chat. It runs on an office Windows PC that is linked to the assistant's WhatsApp number in the same way WhatsApp Web is.

## Important: this is not an official WhatsApp integration

The bot connects through the WhatsApp Web protocol, which WhatsApp does not offer to businesses for automation. This breaks WhatsApp's terms of service. WhatsApp may **ban the assistant's number without warning**, and an update from WhatsApp can stop the bot working until the library is updated. Use a number the firm can afford to lose. Don't use the bot for client communications.

## What it does

- **In groups** it only reacts when someone @mentions it, replies to one of its messages, or starts a message with its name ("Eileen, where's the October NAV pack?"). Other group messages are not read, stored or sent anywhere.
- **In private chats** it answers every message from staff on the list.
- **Only people on the staff list get answers.** Anyone else is ignored and logged.
- **Reading the drive is always allowed.** It searches file names and folders, lists folders, and reads PDF, Word (.docx), Excel (.xlsx) and text files.
- **Changes need approval.** Creating folders, saving text files, and copying or moving files are never done directly. The approver (Leo) gets a private WhatsApp message describing the exact change and a 4-digit code, and the change happens only after the reply `YES 1234`. `NO 1234` rejects it. The bot can't delete files or edit Word, Excel or PDF files.
- **Audit log.** Every message the bot handles, every reply, file read, file sent and change is written to `logs\YYYY-MM-DD.jsonl`, one line per event.
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
| `src/audit.ts` | Daily audit log files |
| `test/` | Tests (`npm test`) |
