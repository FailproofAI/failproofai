"""Versioned Unix-socket client for failproofaid policy evaluation."""

from __future__ import annotations

import json
import os
import socket
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

PROTOCOL_VERSION = 2
# Oldest daemon version this plugin falls back to (crates/fpai-ipc
# MIN_PROTOCOL_VERSION), and the first that carries agentSettingsPath.
MIN_PROTOCOL_VERSION = 1
AGENT_SETTINGS_PATH_SINCE = 2
# active.json schema that can target policies at agents (crates/failproofaid
# cloud_policies.rs SCOPED_DESIRED_STATE_SCHEMA_VERSION).
SCOPED_SCHEMA_VERSION = 3
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


def _agent_targeted_deployment() -> bool:
    """Whether this machine's Cloud deployment targets policies at agents.

    An older daemon evaluates without naming the agent, and a targeted policy
    does not apply to an unknown one, so its answer could allow what that
    policy denies: such a machine is never asked in the older version. A
    deployment that exists but cannot be read counts as targeted.
    """
    override = os.environ.get("FAILPROOFAI_CLOUD_POLICY_DIR", "").strip()
    if override:
        directory = Path(override).expanduser()
    else:
        root = os.environ.get("FAILPROOFAI_HOME", "").strip()
        home = Path(root).expanduser() if root else Path.home() / ".failproofai"
        directory = home / "policies" / "cloud-policies"
    # Read directly: `Path.exists()` reports a permission error as absent, and
    # only a manifest that is NOT THERE means no deployment.
    try:
        text = (directory / "active.json").read_text(encoding="utf-8")
    except FileNotFoundError:
        return False
    except OSError:
        return True
    try:
        version = json.loads(text).get("schemaVersion")
    except (ValueError, AttributeError):
        return True
    return not (type(version) is int and version < SCOPED_SCHEMA_VERSION)


def _remaining_timeout(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise EvaluationError("failproofaid evaluation timed out")
    return remaining


def _read_exact(sock: socket.socket, length: int, deadline: float) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        sock.settimeout(_remaining_timeout(deadline))
        try:
            chunk = sock.recv(remaining)
        except TimeoutError as exc:
            raise EvaluationError("failproofaid evaluation timed out") from exc
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


def _exchange(body: bytes, connect_timeout_ms: int, deadline: float) -> Any:
    """One framed request and its framed reply over a fresh connection."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(min(max(connect_timeout_ms, 1) / 1000, _remaining_timeout(deadline)))
            sock.connect(str(daemon_socket_path()))
            sock.settimeout(_remaining_timeout(deadline))
            try:
                sock.sendall(struct.pack(">I", len(body)) + body)
            except TimeoutError as exc:
                raise EvaluationError("failproofaid evaluation timed out") from exc
            declared_length = struct.unpack(">I", _read_exact(sock, 4, deadline))[0]
            if declared_length > MAX_FRAME_BYTES:
                raise EvaluationError("failproofaid response exceeds the 16 MiB limit")
            return json.loads(_read_exact(sock, declared_length, deadline).decode("utf-8"))
    except EvaluationError:
        raise
    except (OSError, UnicodeError, ValueError, struct.error) as exc:
        raise EvaluationError(f"failproofaid evaluation failed: {exc}") from exc


def evaluate_policy(
    *,
    event: str,
    payload: Mapping[str, Any],
    cwd: str | None,
    agent_settings_path: str | None = None,
    connect_timeout_ms: int = 250,
    evaluation_timeout_ms: int = 12_000,
) -> PolicyVerdict:
    def build(version: int) -> bytes:
        request: dict[str, Any] = {
            "type": "policyEvaluation",
            "protocolVersion": version,
            "integration": "hermes",
            "event": event,
            "payload": dict(payload),
            "cwd": cwd,
        }
        if version >= AGENT_SETTINGS_PATH_SINCE:
            # An unknown profile is explicit. Omitting this field would let a new
            # daemon's warm worker attribute the call to its own Hermes home.
            request["agentSettingsPath"] = agent_settings_path or ""
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
        return body

    # One deadline covers connect, send and read: evaluation_timeout_ms is the
    # longest a tool call can wait here. Connect is bounded by both budgets.
    deadline = time.monotonic() + max(evaluation_timeout_ms, 1) / 1000
    version = PROTOCOL_VERSION
    response = _exchange(build(version), connect_timeout_ms, deadline)
    answered = response.get("protocolVersion") if isinstance(response, dict) else None
    # An older daemon still inside the supported range: ask again in its version
    # rather than block every call until it is replaced.
    if (
        type(answered) is int
        and MIN_PROTOCOL_VERSION <= answered < PROTOCOL_VERSION
        and not _agent_targeted_deployment()
    ):
        version = answered
        response = _exchange(build(version), connect_timeout_ms, deadline)

    if not isinstance(response, dict):
        raise EvaluationError("failproofaid returned a non-object response")
    if response.get("protocolVersion") != version:
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
