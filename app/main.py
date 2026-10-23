"""Web server: Meta's webhook calls these endpoints."""

import asyncio
import json
import logging
from dataclasses import dataclass

from fastapi import FastAPI, Request, Response

from .agent import Assistant
from .audit import AuditLog, GcsAuditLog
from .config import Settings, load_settings
from .google_tools import GoogleWorkspace
from .store import GcsStore, Store
from .whatsapp import IncomingMessage, WhatsAppClient, parse_messages, verify_signature

log = logging.getLogger("assistant")
logging.basicConfig(level=logging.INFO)


@dataclass
class Services:
    settings: Settings
    store: Store
    audit: AuditLog
    whatsapp: WhatsAppClient
    assistant: Assistant


def build_services() -> Services:
    settings = load_settings()
    store = GcsStore(settings.state_bucket)
    audit = GcsAuditLog(settings.audit_bucket)
    workspace = GoogleWorkspace.from_token_json(settings.google_token_json, settings.mailbox)
    return Services(
        settings=settings,
        store=store,
        audit=audit,
        whatsapp=WhatsAppClient(settings.whatsapp_token, settings.whatsapp_phone_number_id, settings.graph_api_version),
        assistant=Assistant(settings, store, audit, workspace),
    )


def create_app(services: Services | None = None) -> FastAPI:
    app = FastAPI(title="East Eagle WhatsApp Assistant")
    holder: dict[str, Services] = {}
    tasks: set[asyncio.Task] = set()

    def svc() -> Services:
        if "s" not in holder:
            holder["s"] = services or build_services()
        return holder["s"]

    @app.get("/")
    async def health():
        return {"ok": True}

    @app.get("/webhook")
    async def verify(request: Request):
        """Meta calls this once when the webhook URL is registered."""
        q = request.query_params
        if q.get("hub.mode") == "subscribe" and q.get("hub.verify_token") == svc().settings.whatsapp_verify_token:
            return Response(content=q.get("hub.challenge", ""), media_type="text/plain")
        return Response(status_code=403)

    @app.post("/webhook")
    async def receive(request: Request):
        s = svc()
        body = await request.body()
        if not verify_signature(s.settings.whatsapp_app_secret, body, request.headers.get("x-hub-signature-256")):
            log.warning("Rejected webhook with a bad signature")
            return Response(status_code=401)
        for message in parse_messages(json.loads(body)):
            if not s.store.claim_message(message.message_id):
                continue  # Meta retried a message we already have
            staff = s.settings.staff.get(message.sender)
            if staff is None:
                s.audit.record("inbound_unknown_sender", message.sender, name=message.sender_name, type=message.type, text=message.text)
                log.info("Ignored a message from a number not on the staff list")
                continue
            # Reply after returning 200, so Meta doesn't time out and resend.
            task = asyncio.create_task(_process(s, staff, message))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
        return {"ok": True}

    app.state.tasks = tasks
    return app


async def _process(s: Services, staff, message: IncomingMessage) -> None:
    try:
        try:
            await s.whatsapp.mark_read(message.message_id)
        except Exception:
            log.exception("mark_read failed")
        reply = await s.assistant.handle(staff, message.text, message.type)
        await s.whatsapp.send_text(staff.phone, reply)
    except Exception as exc:
        log.exception("Failed to process message")
        s.audit.record("error", staff.phone, where="process", error=repr(exc))
        try:
            await s.whatsapp.send_text(staff.phone, "Sorry, something went wrong on my side. Please try again.")
        except Exception:
            log.exception("Could not send the error reply")


app = create_app()
