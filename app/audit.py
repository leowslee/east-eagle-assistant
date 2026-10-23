"""Audit log for SFC record keeping.

Every inbound message, reply, tool call and confirmed action is written as its own JSON object
to a Cloud Storage bucket that has a locked retention policy (see README), so records cannot be
changed or deleted before the retention period ends.
"""

import json
import uuid
from datetime import datetime
from typing import Protocol

from .config import HK_TZ


class AuditLog(Protocol):
    def record(self, event: str, phone: str, **details) -> None: ...


def _entry(event: str, phone: str, details: dict) -> dict:
    return {
        "id": uuid.uuid4().hex,
        "time": datetime.now(HK_TZ).isoformat(),
        "event": event,
        "phone": phone,
        **details,
    }


class MemoryAuditLog:
    def __init__(self):
        self.entries: list[dict] = []

    def record(self, event, phone, **details):
        self.entries.append(_entry(event, phone, details))


class GcsAuditLog:
    def __init__(self, bucket_name: str):
        from google.cloud import storage

        self._bucket = storage.Client().bucket(bucket_name)

    def record(self, event, phone, **details):
        entry = _entry(event, phone, details)
        day = entry["time"][:10]
        path = f"{day}/{entry['time']}_{phone}_{event}_{entry['id'][:8]}.json"
        self._bucket.blob(path).upload_from_string(
            json.dumps(entry, ensure_ascii=False, default=str), content_type="application/json"
        )
