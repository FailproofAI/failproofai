"""Persistent, bounded delivery state for FailproofAI instruct decisions."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


class LedgerError(RuntimeError):
    """Instruction state could not be read or updated safely."""


@dataclass(frozen=True)
class InstructionAction:
    block: bool
    status: str


class InstructionLedger:
    def __init__(self, path: Path, *, ttl_seconds: int = 3600, max_rounds: int = 2) -> None:
        self.path = path
        self.ttl_seconds = max(60, int(ttl_seconds))
        self.max_rounds = max(0, int(max_rounds))
        self._init_lock = threading.Lock()
        self._initialized = False

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=0.25, isolation_level=None)
        connection.execute("PRAGMA busy_timeout = 250")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        return connection

    def _ensure_schema(self) -> None:
        if self._initialized:
            return
        with self._init_lock:
            if self._initialized:
                return
            try:
                with self._connect() as connection:
                    connection.execute(
                        """
                        CREATE TABLE IF NOT EXISTS instruction_deliveries (
                          delivery_key TEXT PRIMARY KEY,
                          profile TEXT NOT NULL,
                          session_id TEXT NOT NULL,
                          task_id TEXT NOT NULL,
                          turn_id TEXT NOT NULL,
                          policy_fingerprint TEXT NOT NULL,
                          scope_key TEXT NOT NULL,
                          blocked_api_request_id TEXT NOT NULL,
                          acknowledged_api_request_id TEXT,
                          state TEXT NOT NULL,
                          created_at_ms INTEGER NOT NULL,
                          expires_at_ms INTEGER NOT NULL
                        )
                        """
                    )
                    connection.execute(
                        """
                        CREATE INDEX IF NOT EXISTS instruction_deliveries_turn
                        ON instruction_deliveries(profile, session_id, task_id, turn_id, expires_at_ms)
                        """
                    )
            except sqlite3.Error as exc:
                raise LedgerError(f"could not initialize instruction state: {exc}") from exc
            self._initialized = True

    @staticmethod
    def _digest(parts: Sequence[str]) -> str:
        encoded = json.dumps(list(parts), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def decide(
        self,
        *,
        profile: str,
        session_id: str,
        task_id: str,
        turn_id: str,
        api_request_id: str,
        policy_names: Sequence[str],
        reason: str,
        scope_key: str,
        now_ms: int | None = None,
    ) -> InstructionAction:
        if not session_id or not turn_id or not api_request_id:
            return InstructionAction(False, "missing-correlation-id")

        self._ensure_schema()
        now = int(time.time() * 1000) if now_ms is None else int(now_ms)
        expires_at = now + self.ttl_seconds * 1000
        task = task_id or "root"
        policy_fingerprint = self._digest([*sorted(policy_names), reason])
        delivery_key = self._digest(
            [profile, session_id, task, turn_id, policy_fingerprint, scope_key]
        )

        try:
            with self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "DELETE FROM instruction_deliveries WHERE expires_at_ms <= ?", (now,)
                )
                row = connection.execute(
                    """
                    SELECT blocked_api_request_id, state
                    FROM instruction_deliveries
                    WHERE delivery_key = ?
                    """,
                    (delivery_key,),
                ).fetchone()
                if row is not None:
                    blocked_request, state = row
                    if state == "issued" and blocked_request == api_request_id:
                        connection.commit()
                        return InstructionAction(True, "same-api-request")
                    if state == "issued":
                        connection.execute(
                            """
                            UPDATE instruction_deliveries
                            SET state = 'acknowledged', acknowledged_api_request_id = ?
                            WHERE delivery_key = ?
                            """,
                            (api_request_id, delivery_key),
                        )
                    connection.commit()
                    return InstructionAction(False, "acknowledged")

                rounds = connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM instruction_deliveries
                    WHERE profile = ? AND session_id = ? AND task_id = ? AND turn_id = ?
                      AND expires_at_ms > ?
                    """,
                    (profile, session_id, task, turn_id, now),
                ).fetchone()[0]
                if rounds >= self.max_rounds:
                    connection.commit()
                    return InstructionAction(False, "turn-cap")

                connection.execute(
                    """
                    INSERT INTO instruction_deliveries (
                      delivery_key, profile, session_id, task_id, turn_id,
                      policy_fingerprint, scope_key, blocked_api_request_id,
                      acknowledged_api_request_id, state, created_at_ms, expires_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'issued', ?, ?)
                    """,
                    (
                        delivery_key,
                        profile,
                        session_id,
                        task,
                        turn_id,
                        policy_fingerprint,
                        scope_key,
                        api_request_id,
                        now,
                        expires_at,
                    ),
                )
                connection.commit()
                return InstructionAction(True, "issued")
        except (sqlite3.Error, OSError) as exc:
            raise LedgerError(f"could not update instruction state: {exc}") from exc

    def clear_session(self, session_id: str) -> None:
        if not session_id:
            return
        self._ensure_schema()
        try:
            with self._connect() as connection:
                connection.execute(
                    "DELETE FROM instruction_deliveries WHERE session_id = ?", (session_id,)
                )
        except (sqlite3.Error, OSError) as exc:
            raise LedgerError(f"could not clear instruction state: {exc}") from exc
