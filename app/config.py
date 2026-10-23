"""Settings, read from environment variables (set as Cloud Run secrets in production)."""

import json
import os
from dataclasses import dataclass, field
from zoneinfo import ZoneInfo

HK_TZ = ZoneInfo("Asia/Hong_Kong")


@dataclass(frozen=True)
class StaffMember:
    phone: str  # WhatsApp ID: country code + number, digits only, e.g. "85291234567"
    name: str
    can_send: bool = False  # may confirm outgoing email and calendar invites


@dataclass(frozen=True)
class Settings:
    whatsapp_token: str
    whatsapp_phone_number_id: str
    whatsapp_app_secret: str
    whatsapp_verify_token: str
    google_token_json: str  # authorized-user JSON for the assistant mailbox
    mailbox: str
    audit_bucket: str
    state_bucket: str
    staff: dict[str, StaffMember] = field(default_factory=dict)
    model: str = "claude-opus-5-5"
    effort: str = "medium"
    graph_api_version: str = "v21.0"
    conversation_idle_hours: float = 4.0


def parse_staff(raw: str) -> dict[str, StaffMember]:
    """STAFF_JSON looks like {"85291234567": {"name": "Leo", "can_send": true}, ...}."""
    staff = {}
    for phone, info in json.loads(raw or "{}").items():
        digits = "".join(ch for ch in phone if ch.isdigit())
        staff[digits] = StaffMember(phone=digits, name=info["name"], can_send=bool(info.get("can_send", False)))
    return staff


def load_settings() -> Settings:
    env = os.environ
    return Settings(
        whatsapp_token=env["WHATSAPP_TOKEN"],
        whatsapp_phone_number_id=env["WHATSAPP_PHONE_NUMBER_ID"],
        whatsapp_app_secret=env["WHATSAPP_APP_SECRET"],
        whatsapp_verify_token=env["WHATSAPP_VERIFY_TOKEN"],
        google_token_json=env["GOOGLE_TOKEN_JSON"],
        mailbox=env.get("ASSISTANT_MAILBOX", "eileen.gu@easteagle-am.com"),
        audit_bucket=env["AUDIT_BUCKET"],
        state_bucket=env["STATE_BUCKET"],
        staff=parse_staff(env.get("STAFF_JSON", "{}")),
        model=env.get("CLAUDE_MODEL", "claude-opus-5-5"),
        effort=env.get("CLAUDE_EFFORT", "medium"),
        conversation_idle_hours=float(env.get("CONVERSATION_IDLE_HOURS", "4")),
    )
