"""Gmail, Calendar and Drive access for the assistant mailbox, plus the tool definitions Claude sees."""

import base64
import html
import io
import json
import re
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Any, Callable

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive.readonly",
]

MAX_EMAIL_CHARS = 40_000
MAX_FILE_CHARS = 100_000


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n\n[Truncated: {len(text) - limit} more characters not shown. Ask for a specific part if needed.]"


def _decode(data: str) -> str:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", errors="replace")


def _html_to_text(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style).*?</\1>", "", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", raw)
    return html.unescape(re.sub(r"<[^>]+>", "", raw)).strip()


def _body_text(payload: dict) -> str:
    """Prefer text/plain parts; fall back to HTML converted to text."""
    plain, rich = [], []

    def walk(part):
        mime = part.get("mimeType", "")
        data = part.get("body", {}).get("data")
        if data and mime == "text/plain":
            plain.append(_decode(data))
        elif data and mime == "text/html":
            rich.append(_html_to_text(_decode(data)))
        for sub in part.get("parts", []) or []:
            walk(sub)

    walk(payload)
    return "\n".join(plain) if plain else "\n".join(rich)


def _attachments(payload: dict) -> list[str]:
    names = []

    def walk(part):
        if part.get("filename"):
            names.append(part["filename"])
        for sub in part.get("parts", []) or []:
            walk(sub)

    walk(payload)
    return names


def _headers(payload: dict) -> dict[str, str]:
    return {h["name"].lower(): h["value"] for h in payload.get("headers", [])}


class GoogleWorkspace:
    """Thin wrapper over the Google APIs, acting as one mailbox (the assistant mailbox)."""

    def __init__(self, gmail, calendar, drive, mailbox: str):
        self.gmail = gmail
        self.calendar = calendar
        self.drive = drive
        self.mailbox = mailbox

    @classmethod
    def from_token_json(cls, token_json: str, mailbox: str) -> "GoogleWorkspace":
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        creds = Credentials.from_authorized_user_info(json.loads(token_json), SCOPES)
        return cls(
            gmail=build("gmail", "v1", credentials=creds, cache_discovery=False),
            calendar=build("calendar", "v3", credentials=creds, cache_discovery=False),
            drive=build("drive", "v3", credentials=creds, cache_discovery=False),
            mailbox=mailbox,
        )

    # Gmail

    def gmail_search(self, query: str, max_results: int = 10) -> dict:
        resp = self.gmail.users().messages().list(userId="me", q=query, maxResults=min(max_results, 25)).execute()
        results = []
        for ref in resp.get("messages", []):
            msg = (
                self.gmail.users()
                .messages()
                .get(userId="me", id=ref["id"], format="metadata", metadataHeaders=["From", "To", "Subject", "Date"])
                .execute()
            )
            h = _headers(msg.get("payload", {}))
            results.append(
                {
                    "message_id": msg["id"],
                    "thread_id": msg.get("threadId"),
                    "from": h.get("from", ""),
                    "to": h.get("to", ""),
                    "subject": h.get("subject", ""),
                    "date": h.get("date", ""),
                    "snippet": html.unescape(msg.get("snippet", "")),
                }
            )
        return {"messages": results}

    def _message_view(self, msg: dict) -> dict:
        payload = msg.get("payload", {})
        h = _headers(payload)
        return {
            "message_id": msg["id"],
            "thread_id": msg.get("threadId"),
            "from": h.get("from", ""),
            "to": h.get("to", ""),
            "cc": h.get("cc", ""),
            "subject": h.get("subject", ""),
            "date": h.get("date", ""),
            "attachments": _attachments(payload),
            "body": _body_text(payload),
        }

    def gmail_read_message(self, message_id: str) -> dict:
        msg = self.gmail.users().messages().get(userId="me", id=message_id, format="full").execute()
        view = self._message_view(msg)
        view["body"] = _truncate(view["body"], MAX_EMAIL_CHARS)
        return view

    def gmail_read_thread(self, thread_id: str) -> dict:
        thread = self.gmail.users().threads().get(userId="me", id=thread_id, format="full").execute()
        messages = [self._message_view(m) for m in thread.get("messages", [])]
        budget = MAX_EMAIL_CHARS
        for view in reversed(messages):  # keep the newest messages whole
            view["body"] = _truncate(view["body"], max(budget, 2_000))
            budget = max(budget - len(view["body"]), 0)
        return {"thread_id": thread_id, "messages": messages}

    def gmail_create_draft(
        self,
        to: list[str],
        subject: str,
        body: str,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        reply_to_message_id: str | None = None,
    ) -> dict:
        email = EmailMessage()
        email["From"] = self.mailbox
        email["To"] = ", ".join(to)
        if cc:
            email["Cc"] = ", ".join(cc)
        if bcc:
            email["Bcc"] = ", ".join(bcc)
        email["Subject"] = subject
        draft_message: dict[str, Any] = {}
        if reply_to_message_id:
            original = (
                self.gmail.users()
                .messages()
                .get(userId="me", id=reply_to_message_id, format="metadata", metadataHeaders=["Message-ID", "References"])
                .execute()
            )
            h = _headers(original.get("payload", {}))
            if h.get("message-id"):
                email["In-Reply-To"] = h["message-id"]
                email["References"] = (h.get("references", "") + " " + h["message-id"]).strip()
            draft_message["threadId"] = original.get("threadId")
        email.set_content(body)
        draft_message["raw"] = base64.urlsafe_b64encode(email.as_bytes()).decode()
        draft = self.gmail.users().drafts().create(userId="me", body={"message": draft_message}).execute()
        return {"draft_id": draft["id"], "to": to, "cc": cc or [], "bcc": bcc or [], "subject": subject}

    def gmail_draft_summary(self, draft_id: str) -> str:
        draft = self.gmail.users().drafts().get(userId="me", id=draft_id, format="full").execute()
        view = self._message_view(draft["message"])
        recipients = ", ".join(x for x in (view["to"], view["cc"]) if x)
        return f"Send email to {recipients}\nSubject: {view['subject']}\n\n{_truncate(view['body'], 1_500)}"

    def gmail_send_draft(self, draft_id: str) -> dict:
        sent = self.gmail.users().drafts().send(userId="me", body={"id": draft_id}).execute()
        return {"sent_message_id": sent.get("id"), "thread_id": sent.get("threadId")}

    # Calendar

    def calendar_list_events(self, time_min: str, time_max: str, query: str | None = None, calendar_id: str = "primary") -> dict:
        params = dict(
            calendarId=calendar_id,
            timeMin=time_min,
            timeMax=time_max,
            singleEvents=True,
            orderBy="startTime",
            maxResults=50,
            timeZone="Asia/Hong_Kong",
        )
        if query:
            params["q"] = query
        resp = self.calendar.events().list(**params).execute()
        events = [
            {
                "event_id": e.get("id"),
                "summary": e.get("summary", ""),
                "start": e.get("start", {}).get("dateTime") or e.get("start", {}).get("date"),
                "end": e.get("end", {}).get("dateTime") or e.get("end", {}).get("date"),
                "location": e.get("location", ""),
                "attendees": [a.get("email") for a in e.get("attendees", [])],
                "link": e.get("htmlLink"),
            }
            for e in resp.get("items", [])
        ]
        return {"events": events}

    def calendar_create_event(
        self,
        summary: str,
        start: str,
        end: str,
        description: str | None = None,
        location: str | None = None,
        attendees: list[str] | None = None,
    ) -> dict:
        body: dict[str, Any] = {
            "summary": summary,
            "start": {"dateTime": start, "timeZone": "Asia/Hong_Kong"},
            "end": {"dateTime": end, "timeZone": "Asia/Hong_Kong"},
        }
        if description:
            body["description"] = description
        if location:
            body["location"] = location
        if attendees:
            body["attendees"] = [{"email": a} for a in attendees]
        event = (
            self.calendar.events()
            .insert(calendarId="primary", body=body, sendUpdates="all" if attendees else "none")
            .execute()
        )
        return {"event_id": event.get("id"), "link": event.get("htmlLink")}

    # Drive

    def drive_search(self, query: str, max_results: int = 10) -> dict:
        escaped = query.replace("\\", "\\\\").replace("'", "\\'")
        resp = (
            self.drive.files()
            .list(
                q=f"fullText contains '{escaped}' and trashed = false",
                pageSize=min(max_results, 25),
                fields="files(id, name, mimeType, modifiedTime, webViewLink, owners(emailAddress))",
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
                corpora="allDrives",
            )
            .execute()
        )
        return {"files": resp.get("files", [])}

    def drive_read_file(self, file_id: str) -> dict:
        meta = self.drive.files().get(fileId=file_id, fields="id, name, mimeType, modifiedTime", supportsAllDrives=True).execute()
        mime = meta["mimeType"]
        exports = {
            "application/vnd.google-apps.document": "text/plain",
            "application/vnd.google-apps.spreadsheet": "text/csv",
            "application/vnd.google-apps.presentation": "text/plain",
        }
        if mime in exports:
            data = self.drive.files().export(fileId=file_id, mimeType=exports[mime]).execute()
            text = data.decode("utf-8", errors="replace")
        elif mime == "application/pdf":
            from pypdf import PdfReader

            data = self.drive.files().get_media(fileId=file_id, supportsAllDrives=True).execute()
            reader = PdfReader(io.BytesIO(data))
            text = "\n\n".join(page.extract_text() or "" for page in reader.pages)
        elif mime.startswith("text/") or mime in ("application/json", "text/csv"):
            data = self.drive.files().get_media(fileId=file_id, supportsAllDrives=True).execute()
            text = data.decode("utf-8", errors="replace")
        else:
            return {"name": meta["name"], "mimeType": mime, "error": "This file type can't be read as text yet."}
        return {"name": meta["name"], "mimeType": mime, "modifiedTime": meta.get("modifiedTime"), "text": _truncate(text, MAX_FILE_CHARS)}


# Tool definitions shown to Claude.

_STR = {"type": "string"}
_STR_LIST = {"type": "array", "items": {"type": "string"}}


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    schema: dict
    # Returns True when the call must wait for the staff member to reply YES.
    needs_confirmation: Callable[[dict], bool] = lambda _input: False
    # True when only staff with can_send may confirm it.
    send_permission: bool = False

    def definition(self) -> dict:
        return {"name": self.name, "description": self.description, "input_schema": self.schema}


def _obj(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


TOOLS: list[ToolSpec] = [
    ToolSpec(
        "gmail_search",
        "Search the assistant mailbox with Gmail search syntax (from:, to:, subject:, after:YYYY/MM/DD, has:attachment, label:, is:unread). Returns message ids, senders, subjects, dates and snippets.",
        _obj({"query": _STR, "max_results": {"type": "integer", "minimum": 1, "maximum": 25}}, ["query"]),
    ),
    ToolSpec(
        "gmail_read_message",
        "Read one email in full (headers, attachment names and body text).",
        _obj({"message_id": _STR}, ["message_id"]),
    ),
    ToolSpec(
        "gmail_read_thread",
        "Read a whole email thread, oldest message first.",
        _obj({"thread_id": _STR}, ["thread_id"]),
    ),
    ToolSpec(
        "gmail_create_draft",
        "Create a draft email in the assistant mailbox. Nothing is sent. Set reply_to_message_id to draft a reply in the same thread. Returns a draft_id that gmail_send_draft can send.",
        _obj(
            {
                "to": _STR_LIST,
                "cc": _STR_LIST,
                "bcc": _STR_LIST,
                "subject": _STR,
                "body": {"type": "string", "description": "Plain text body, including the sign-off."},
                "reply_to_message_id": _STR,
            },
            ["to", "subject", "body"],
        ),
    ),
    ToolSpec(
        "gmail_send_draft",
        "Send a draft created earlier. The staff member must confirm by replying YES before it is sent; the app asks them.",
        _obj({"draft_id": _STR}, ["draft_id"]),
        needs_confirmation=lambda _input: True,
        send_permission=True,
    ),
    ToolSpec(
        "calendar_list_events",
        "List events on the assistant mailbox's calendar between two RFC 3339 times, e.g. 2026-10-23T00:00:00+08:00.",
        _obj({"time_min": _STR, "time_max": _STR, "query": _STR}, ["time_min", "time_max"]),
    ),
    ToolSpec(
        "calendar_create_event",
        "Create a calendar event. Times are RFC 3339 in Hong Kong time, e.g. 2026-10-24T15:00:00+08:00. If attendees are given, invitations are emailed, so the staff member must confirm by replying YES first; the app asks them.",
        _obj(
            {
                "summary": _STR,
                "start": _STR,
                "end": _STR,
                "description": _STR,
                "location": _STR,
                "attendees": _STR_LIST,
            },
            ["summary", "start", "end"],
        ),
        needs_confirmation=lambda tool_input: bool(tool_input.get("attendees")),
        send_permission=True,
    ),
    ToolSpec(
        "drive_search",
        "Search Google Drive files (including shared drives) by text in the file name or content.",
        _obj({"query": _STR, "max_results": {"type": "integer", "minimum": 1, "maximum": 25}}, ["query"]),
    ),
    ToolSpec(
        "drive_read_file",
        "Read the text of a Drive file: Google Docs, Sheets (as CSV), Slides, PDFs and plain text files.",
        _obj({"file_id": _STR}, ["file_id"]),
    ),
]

TOOLS_BY_NAME = {t.name: t for t in TOOLS}


def run_tool(workspace: GoogleWorkspace, name: str, tool_input: dict) -> dict:
    return getattr(workspace, name)(**tool_input)


def describe_pending(workspace: GoogleWorkspace, name: str, tool_input: dict) -> str:
    """The summary a staff member sees before replying YES."""
    if name == "gmail_send_draft":
        return workspace.gmail_draft_summary(tool_input["draft_id"])
    if name == "calendar_create_event":
        lines = [
            f"Create event: {tool_input['summary']}",
            f"When: {tool_input['start']} to {tool_input['end']}",
        ]
        if tool_input.get("location"):
            lines.append(f"Where: {tool_input['location']}")
        lines.append("Invite (emails will be sent): " + ", ".join(tool_input.get("attendees", [])))
        return "\n".join(lines)
    return f"{name}: {json.dumps(tool_input, ensure_ascii=False)}"
