import asyncio
import hashlib
import hmac
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.agent import Assistant
from app.audit import MemoryAuditLog
from app.config import Settings, StaffMember, parse_staff
from app.main import Services, create_app
from app.store import MemoryStore
from app.whatsapp import parse_messages, split_text, verify_signature

LEO = StaffMember(phone="85290000001", name="Leo", can_send=True)
AMY = StaffMember(phone="85290000002", name="Amy", can_send=False)


def make_settings() -> Settings:
    return Settings(
        whatsapp_token="t",
        whatsapp_phone_number_id="123",
        whatsapp_app_secret="secret",
        whatsapp_verify_token="verify-me",
        google_token_json="{}",
        mailbox="eileen.gu@easteagle-am.com",
        audit_bucket="audit",
        state_bucket="state",
        staff={LEO.phone: LEO, AMY.phone: AMY},
    )


# Fakes


class Block(SimpleNamespace):
    def model_dump(self, **_kwargs):
        return {k: v for k, v in vars(self).items() if v is not None}


def text(t):
    return Block(type="text", text=t)


def tool_use(id_, name, input_):
    return Block(type="tool_use", id=id_, name=name, input=input_)


class FakeClaude:
    """Returns scripted responses and records each request's messages."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs):
        self.requests.append(json.loads(json.dumps(kwargs["messages"])))
        content, stop = self.responses.pop(0)
        return SimpleNamespace(content=content, stop_reason=stop, stop_details=None)


class FakeWorkspace:
    def __init__(self):
        self.calls = []

    def gmail_search(self, query, max_results=10):
        self.calls.append(("gmail_search", query))
        return {"messages": [{"message_id": "m1", "subject": "SFC circular"}]}

    def gmail_create_draft(self, to, subject, body, **kw):
        self.calls.append(("gmail_create_draft", to, subject))
        return {"draft_id": "d1"}

    def gmail_draft_summary(self, draft_id):
        return "Send email to compliance@example.com\nSubject: Hello"

    def gmail_send_draft(self, draft_id):
        self.calls.append(("gmail_send_draft", draft_id))
        return {"sent_message_id": "s1"}


def make_assistant(responses):
    store, audit, ws, claude = MemoryStore(), MemoryAuditLog(), FakeWorkspace(), FakeClaude(responses)
    return Assistant(make_settings(), store, audit, ws, client=claude), store, audit, ws, claude


def run(coro):
    return asyncio.run(coro)


# WhatsApp helpers


def test_signature():
    body = b'{"a":1}'
    sig = "sha256=" + hmac.new(b"secret", body, hashlib.sha256).hexdigest()
    assert verify_signature("secret", body, sig)
    assert not verify_signature("secret", body + b" ", sig)
    assert not verify_signature("secret", body, None)


def test_parse_messages():
    payload = {
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "contacts": [{"wa_id": "85290000001", "profile": {"name": "Leo"}}],
                            "messages": [
                                {"id": "wamid.1", "from": "85290000001", "timestamp": "1", "type": "text", "text": {"body": "hi"}}
                            ],
                            "statuses": [{"id": "x", "status": "read"}],
                        }
                    }
                ]
            }
        ]
    }
    [msg] = parse_messages(payload)
    assert (msg.message_id, msg.sender, msg.sender_name, msg.text) == ("wamid.1", "85290000001", "Leo", "hi")


def test_split_text():
    long = ("para " * 300 + "\n\n") * 5
    parts = split_text(long, limit=4096)
    assert all(len(p) <= 4096 for p in parts)
    assert "".join(parts).replace(" ", "").replace("\n", "") == long.replace(" ", "").replace("\n", "")


def test_parse_staff():
    staff = parse_staff('{"+852 9000 0001": {"name": "Leo", "can_send": true}}')
    assert staff["85290000001"].can_send


# Assistant flow


def test_tool_loop_and_history():
    assistant, store, audit, ws, claude = make_assistant(
        [
            ([tool_use("t1", "gmail_search", {"query": "SFC"})], "tool_use"),
            ([text("Found the SFC circular email.")], "end_turn"),
        ]
    )
    reply = run(assistant.handle(LEO, "Any SFC emails?"))
    assert reply == "Found the SFC circular email."
    assert ws.calls == [("gmail_search", "SFC")]
    msgs = store.conversations[LEO.phone]["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"]
    assert msgs[2]["content"][0]["tool_use_id"] == "t1"
    assert {e["event"] for e in audit.entries} >= {"inbound", "tool_call", "reply"}


def test_send_needs_yes():
    assistant, store, audit, ws, claude = make_assistant(
        [
            (
                [tool_use("t1", "gmail_create_draft", {"to": ["compliance@example.com"], "subject": "Hello", "body": "Hi"})],
                "tool_use",
            ),
            ([tool_use("t2", "gmail_send_draft", {"draft_id": "d1"})], "tool_use"),
            ([text("I've prepared the email.")], "end_turn"),
        ]
    )
    reply = run(assistant.handle(LEO, "Email compliance hello"))
    assert "Reply *YES*" in reply and "compliance@example.com" in reply
    assert ("gmail_send_draft", "d1") not in ws.calls
    assert store.pending[LEO.phone]["tool"] == "gmail_send_draft"

    reply = run(assistant.handle(LEO, "YES"))
    assert reply.startswith("Done. Email sent.")
    assert ("gmail_send_draft", "d1") in ws.calls
    assert LEO.phone not in store.pending
    assert any(e["event"] == "action_confirmed" for e in audit.entries)
    assert store.conversations[LEO.phone]["messages"][-1]["role"] == "assistant"


def test_anything_else_cancels():
    assistant, store, audit, ws, claude = make_assistant(
        [
            ([tool_use("t1", "gmail_send_draft", {"draft_id": "d1"})], "tool_use"),
            ([text("Prepared.")], "end_turn"),
            ([text("OK, cancelled.")], "end_turn"),
        ]
    )
    run(assistant.handle(LEO, "send draft d1"))
    reply = run(assistant.handle(LEO, "wait, no"))
    assert reply == "OK, cancelled."
    assert ("gmail_send_draft", "d1") not in ws.calls
    assert "cancelled" in claude.requests[-1][-1]["content"]


def test_staff_without_send_permission():
    assistant, store, audit, ws, claude = make_assistant(
        [
            ([tool_use("t1", "gmail_send_draft", {"draft_id": "d1"})], "tool_use"),
            ([text("The draft is ready for Leo to send.")], "end_turn"),
        ]
    )
    reply = run(assistant.handle(AMY, "send it"))
    assert "YES" not in reply
    assert AMY.phone not in store.pending
    assert claude.requests[-1][-1]["content"][0]["is_error"] is True


def test_api_error_does_not_save_partial_turn():
    import anthropic
    import httpx2

    assistant, store, audit, ws, claude = make_assistant([])

    async def boom(**kwargs):
        raise anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com"))

    claude.beta.messages.create = boom
    reply = run(assistant.handle(LEO, "hello"))
    assert "couldn't reach" in reply
    assert LEO.phone not in store.conversations


# Webhook


class FakeWhatsApp:
    def __init__(self):
        self.sent = []

    async def send_text(self, to, text):
        self.sent.append((to, text))

    async def mark_read(self, message_id):
        pass


def test_webhook_end_to_end():
    assistant, store, audit, ws, claude = make_assistant([([text("Hello Leo")], "end_turn")])
    wa = FakeWhatsApp()
    services = Services(settings=make_settings(), store=store, audit=audit, whatsapp=wa, assistant=assistant)
    app = create_app(services)
    client = TestClient(app)

    r = client.get("/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "42"})
    assert r.text == "42"
    assert client.get("/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "no"}).status_code == 403

    def payload(sender, msg_id):
        return json.dumps(
            {"entry": [{"changes": [{"value": {"messages": [{"id": msg_id, "from": sender, "timestamp": "1", "type": "text", "text": {"body": "hi"}}]}}]}]}
        ).encode()

    def post(body):
        sig = "sha256=" + hmac.new(b"secret", body, hashlib.sha256).hexdigest()
        return client.post("/webhook", content=body, headers={"x-hub-signature-256": sig})

    assert client.post("/webhook", content=payload(LEO.phone, "a"), headers={"x-hub-signature-256": "sha256=bad"}).status_code == 401

    with client:
        assert post(payload("85299999999", "stranger")).status_code == 200
        assert post(payload(LEO.phone, "m1")).status_code == 200
        assert post(payload(LEO.phone, "m1")).status_code == 200  # Meta retry, ignored

        async def drain():
            while app.state.tasks:
                await asyncio.gather(*app.state.tasks)

        client.portal.call(drain)

    assert wa.sent == [(LEO.phone, "Hello Leo")]
    assert any(e["event"] == "inbound_unknown_sender" for e in audit.entries)
