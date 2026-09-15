"""Versioned Unix-socket client for failproofaid policy evaluation."""

from __future__ import annotations

import json
import os
import socket
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_REQUEST_BYTES = 1024 * 1024


class EvaluationError(RuntimeError):
    """The daemon could not return a trustworthy policy verdict."""


@dataclass(frozen=True)
class PolicyVerdict:
    decision: str
    policy_names: tuple[str, ...]
    reason: str | None
    matched_policies: tuple[str, ...]
    duration_ms: int
    tool_name: str | None


def daemon_socket_path() -> Path:
    override = os.environ.get("FAILPROOFAI_DAEMON_SOCKET", "").strip()
    if override:
        return Path(override).expanduser()
    root = os.environ.get("FAILPROOFAI_HOME", "").strip()
    home = Path(root).expanduser() if root else Path.home() / ".failproofai"
    return home / "run" / "failproofaid.sock"


def _read_exact(sock: socket.socket, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise EvaluationError("failproofaid closed the connection before returning a verdict")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _string_list(value: object, field: str) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise EvaluationError(f"failproofaid returned an invalid {field}")
    if not all(isinstance(item, str) for item in value):
        raise EvaluationError(f"failproofaid returned an invalid {field}")
    return tuple(value)


def evaluate_policy(
    *,
    event: str,
    payload: Mapping[str, Any],
    cwd: str | None,
    connect_timeout_ms: int = 250,
    evaluation_timeout_ms: int = 12_000,
) -> PolicyVerdict:
    request = {
        "type": "policyEvaluation",
        "protocolVersion": PROTOCOL_VERSION,
        "integration": "hermes",
        "event": event,
        "payload": dict(payload),
        "cwd": cwd,
    }
    try:
        body = json.dumps(
            request,
            ensure_ascii=False,
            separators=(",", ":"),
            default=lambda value: repr(value),
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise EvaluationError(f"could not encode policy request: {exc}") from exc
    if len(body) > MAX_REQUEST_BYTES:
        raise EvaluationError("policy request exceeds the 1 MiB limit")

    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(max(connect_timeout_ms, 1) / 1000)
            sock.connect(str(daemon_socket_path()))
            sock.settimeout(max(evaluation_timeout_ms, 1) / 1000)
            sock.sendall(struct.pack(">I", len(body)) + body)
            declared_length = struct.unpack(">I", _read_exact(sock, 4))[0]
            if declared_length > MAX_FRAME_BYTES:
                raise EvaluationError("failproofaid response exceeds the 16 MiB limit")
            response = json.loads(_read_exact(sock, declared_length).decode("utf-8"))
    except EvaluationError:
        raise
    except (OSError, UnicodeError, ValueError, struct.error) as exc:
        raise EvaluationError(f"failproofaid evaluation failed: {exc}") from exc

    if not isinstance(response, dict):
        raise EvaluationError("failproofaid returned a non-object response")
    if response.get("protocolVersion") != PROTOCOL_VERSION:
        raise EvaluationError("failproofaid protocol version mismatch")
    if response.get("type") == "error":
        message = response.get("message")
        raise EvaluationError(str(message or "failproofaid could not evaluate the policy"))
    if response.get("type") != "policyResult":
        raise EvaluationError("failproofaid does not support native policy evaluation")

    decision = response.get("decision")
    if decision not in {"allow", "deny", "instruct"}:
        raise EvaluationError("failproofaid returned an invalid policy decision")
    reason = response.get("reason")
    if reason is not None and not isinstance(reason, str):
        raise EvaluationError("failproofaid returned an invalid policy reason")
    duration_ms = response.get("durationMs", 0)
    if not isinstance(duration_ms, int) or duration_ms < 0:
        raise EvaluationError("failproofaid returned an invalid evaluation duration")
    tool_name = response.get("toolName")
    if tool_name is not None and not isinstance(tool_name, str):
        raise EvaluationError("failproofaid returned an invalid tool name")

    return PolicyVerdict(
        decision=decision,
        policy_names=_string_list(response.get("policyNames", []), "policyNames"),
        reason=reason,
        matched_policies=_string_list(response.get("matchedPolicies", []), "matchedPolicies"),
        duration_ms=duration_ms,
        tool_name=tool_name,
    )
