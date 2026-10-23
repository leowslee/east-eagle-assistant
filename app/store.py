"""Working state: processed message ids, conversations and actions waiting for YES.

Production uses a Cloud Storage bucket (no document size limit, so long email threads fit).
Tests and local runs use MemoryStore.
"""

import json
import time
from typing import Protocol


class Store(Protocol):
    def claim_message(self, message_id: str) -> bool: ...
    def load_conversation(self, phone: str) -> dict | None: ...
    def save_conversation(self, phone: str, conversation: dict) -> None: ...
    def delete_conversation(self, phone: str) -> None: ...
    def load_pending(self, phone: str) -> dict | None: ...
    def save_pending(self, phone: str, pending: dict) -> None: ...
    def delete_pending(self, phone: str) -> None: ...


class MemoryStore:
    def __init__(self):
        self.claimed: set[str] = set()
        self.conversations: dict[str, dict] = {}
        self.pending: dict[str, dict] = {}

    def claim_message(self, message_id: str) -> bool:
        if message_id in self.claimed:
            return False
        self.claimed.add(message_id)
        return True

    def load_conversation(self, phone):
        conv = self.conversations.get(phone)
        return json.loads(json.dumps(conv)) if conv else None

    def save_conversation(self, phone, conversation):
        self.conversations[phone] = json.loads(json.dumps(conversation))

    def delete_conversation(self, phone):
        self.conversations.pop(phone, None)

    def load_pending(self, phone):
        return self.pending.get(phone)

    def save_pending(self, phone, pending):
        self.pending[phone] = pending

    def delete_pending(self, phone):
        self.pending.pop(phone, None)


class GcsStore:
    def __init__(self, bucket_name: str):
        from google.cloud import storage

        self._bucket = storage.Client().bucket(bucket_name)

    def _read(self, path: str) -> dict | None:
        blob = self._bucket.blob(path)
        if not blob.exists():
            return None
        return json.loads(blob.download_as_bytes())

    def _write(self, path: str, data: dict) -> None:
        self._bucket.blob(path).upload_from_string(json.dumps(data), content_type="application/json")

    def _delete(self, path: str) -> None:
        blob = self._bucket.blob(path)
        if blob.exists():
            blob.delete()

    def claim_message(self, message_id: str) -> bool:
        """Create-only write, so a message Meta delivers twice is handled once."""
        from google.api_core.exceptions import PreconditionFailed

        try:
            self._bucket.blob(f"processed/{message_id}").upload_from_string(
                str(time.time()), if_generation_match=0
            )
            return True
        except PreconditionFailed:
            return False

    def load_conversation(self, phone):
        return self._read(f"conversations/{phone}.json")

    def save_conversation(self, phone, conversation):
        self._write(f"conversations/{phone}.json", conversation)

    def delete_conversation(self, phone):
        self._delete(f"conversations/{phone}.json")

    def load_pending(self, phone):
        return self._read(f"pending/{phone}.json")

    def save_pending(self, phone, pending):
        self._write(f"pending/{phone}.json", pending)

    def delete_pending(self, phone):
        self._delete(f"pending/{phone}.json")
