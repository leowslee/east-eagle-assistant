"""WhatsApp Business Cloud API: webhook signature check, parsing and sending."""

import hashlib
import hmac
from dataclasses import dataclass

import httpx

MAX_BODY = 4096  # WhatsApp text message limit


@dataclass(frozen=True)
class IncomingMessage:
    message_id: str
    sender: str  # wa_id, digits only
    sender_name: str
    type: str
    text: str
    timestamp: int


def verify_signature(app_secret: str, body: bytes, header: str | None) -> bool:
    """Meta signs every webhook POST with HMAC-SHA256 of the raw body using the app secret."""
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(app_secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header.removeprefix("sha256="))


def parse_messages(payload: dict) -> list[IncomingMessage]:
    """Pull user messages out of a webhook payload. Status updates (sent/read) are skipped."""
    found = []
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            names = {c.get("wa_id"): c.get("profile", {}).get("name", "") for c in value.get("contacts", [])}
            for msg in value.get("messages", []):
                kind = msg.get("type", "")
                if kind == "text":
                    text = msg.get("text", {}).get("body", "")
                elif kind == "button":
                    text = msg.get("button", {}).get("text", "")
                else:
                    text = ""
                sender = msg.get("from", "")
                found.append(
                    IncomingMessage(
                        message_id=msg.get("id", ""),
                        sender=sender,
                        sender_name=names.get(sender, ""),
                        type=kind,
                        text=text,
                        timestamp=int(msg.get("timestamp", 0)),
                    )
                )
    return found


def split_text(text: str, limit: int = MAX_BODY) -> list[str]:
    """Split a long reply into WhatsApp-sized parts, preferring paragraph and line breaks."""
    parts = []
    rest = text.strip()
    while len(rest) > limit:
        cut = rest.rfind("\n\n", 0, limit)
        if cut <= 0:
            cut = rest.rfind("\n", 0, limit)
        if cut <= 0:
            cut = rest.rfind(" ", 0, limit)
        if cut <= 0:
            cut = limit
        parts.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        parts.append(rest)
    return parts


class WhatsAppClient:
    def __init__(self, token: str, phone_number_id: str, api_version: str = "v21.0"):
        self._url = f"https://graph.facebook.com/{api_version}/{phone_number_id}/messages"
        self._headers = {"Authorization": f"Bearer {token}"}

    async def send_text(self, to: str, text: str) -> list[str]:
        """Send text, split if needed. Returns the WhatsApp message ids."""
        ids = []
        async with httpx.AsyncClient(timeout=30) as client:
            for part in split_text(text):
                resp = await client.post(
                    self._url,
                    headers=self._headers,
                    json={
                        "messaging_product": "whatsapp",
                        "to": to,
                        "type": "text",
                        "text": {"body": part, "preview_url": False},
                    },
                )
                resp.raise_for_status()
                ids.extend(m["id"] for m in resp.json().get("messages", []))
        return ids

    async def mark_read(self, message_id: str) -> None:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                self._url,
                headers=self._headers,
                json={"messaging_product": "whatsapp", "status": "read", "message_id": message_id},
            )
