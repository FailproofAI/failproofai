"""Native Hermes bridge for FailproofAI policy enforcement."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Mapping

from .client import PolicyVerdict, evaluate_policy
from .ledger import InstructionLedger, LedgerError

logger = logging.getLogger(__name__)

_PROTOCOL_CONTEXT = (
    "When a tool result starts with FAILPROOF INSTRUCTION, treat it as policy guidance. "
    "Reconsider the attempted action before retrying. Do not evade or ignore the instruction; "
    "change tools, arguments, targets, or side effects only when the instruction requires it. "
    "If you cannot follow the instruction, stop and explain why."
)


def _bounded_int(value: object, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return min(max(parsed, minimum), maximum)


def _profile_name() -> str:
    explicit = os.environ.get("HERMES_PROFILE", "").strip()
    if explicit:
        return explicit
    configured_home = os.environ.get("HERMES_HOME", "").strip()
    home = Path(configured_home).expanduser() if configured_home else Path.home() / ".hermes"
    if home.parent.name == "profiles":
        return home.name
    return "default"


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


class FailproofAIPlugin:
    def __init__(self, ctx: Any) -> None:
        self.ctx = ctx
        self.profile = _profile_name()
        self.failure_mode = str(ctx.get_config("failure_mode", "deny")).strip().lower()
        self.connect_timeout_ms = _bounded_int(
            ctx.get_config("connect_timeout_ms", 250), 250, 25, 5_000
        )
        self.evaluation_timeout_ms = _bounded_int(
            ctx.get_config("evaluation_timeout_ms", 12_000), 12_000, 100, 29_000
        )
        ttl_seconds = _bounded_int(
            ctx.get_config("instruction_ttl_seconds", 3_600), 3_600, 60, 86_400
        )
        max_rounds = _bounded_int(
            ctx.get_config("max_instruction_rounds", 2), 2, 0, 10
        )
        self.ledger = InstructionLedger(
            Path(ctx.state.data_dir) / "instructions.db",
            ttl_seconds=ttl_seconds,
            max_rounds=max_rounds,
        )

    def _fallback(self, error: Exception) -> dict[str, str] | None:
        logger.error("FailproofAI evaluator unavailable: %s", error)
        if self.failure_mode == "allow":
            return None
        return {
            "action": "block",
            "message": (
                "FailproofAI could not verify this tool call because the local policy "
                "evaluator is unavailable. Check `failproofai status` before retrying."
            ),
        }

    def _evaluate(self, event: str, payload: Mapping[str, Any]) -> PolicyVerdict:
        cwd = _string(payload.get("cwd")) or os.getcwd()
        return evaluate_policy(
            event=event,
            payload=payload,
            cwd=cwd,
            connect_timeout_ms=self.connect_timeout_ms,
            evaluation_timeout_ms=self.evaluation_timeout_ms,
        )

    def pre_tool_call(
        self,
        tool_name: str = "",
        args: Mapping[str, Any] | None = None,
        session_id: str = "",
        task_id: str = "",
        tool_call_id: str = "",
        turn_id: str = "",
        api_request_id: str = "",
        **kwargs: Any,
    ) -> dict[str, str] | None:
        payload = {
            "hook_event_name": "pre_tool_call",
            "tool_name": tool_name,
            "tool_input": dict(args or {}),
            "session_id": session_id,
            "cwd": _string(kwargs.get("cwd")) or os.getcwd(),
            "hermes": {
                "profile": self.profile,
                "task_id": task_id,
                "tool_call_id": tool_call_id,
                "turn_id": turn_id,
                "api_request_id": api_request_id,
            },
        }
        try:
            verdict = self._evaluate("pre_tool_call", payload)
        except Exception as exc:
            return self._fallback(exc)

        if verdict.decision == "allow":
            return None
        if verdict.decision == "deny":
            return {
                "action": "block",
                "message": verdict.reason or "Blocked by FailproofAI policy.",
            }

        reason = verdict.reason or "Reconsider this tool call before retrying."
        try:
            action = self.ledger.decide(
                profile=self.profile,
                session_id=session_id,
                task_id=task_id,
                turn_id=turn_id,
                api_request_id=api_request_id,
                policy_names=verdict.policy_names,
                reason=reason,
                scope_key=verdict.tool_name or tool_name or "unknown-tool",
            )
        except LedgerError as exc:
            # An advisory instruction must never become an indefinite denial
            # because its local retry state is unavailable.
            logger.error("FailproofAI instruction state unavailable; allowing: %s", exc)
            return None

        if not action.block:
            if action.status in {"missing-correlation-id", "turn-cap"}:
                logger.warning("FailproofAI instruction allowed in degraded state: %s", action.status)
            return None

        policies = ", ".join(verdict.policy_names) or "unknown policy"
        return {
            "action": "block",
            "message": (
                f"FAILPROOF INSTRUCTION ({policies})\n\n{reason}\n\n"
                "Reconsider the attempted action, then make a corrected tool call. "
                "Do not route around this instruction with an equivalent ungoverned action."
            ),
        }

    def _observe(self, event: str, payload: Mapping[str, Any]) -> None:
        try:
            self._evaluate(event, payload)
        except Exception as exc:
            logger.warning("FailproofAI observation failed for %s: %s", event, exc)

    def post_tool_call(
        self,
        tool_name: str = "",
        args: Mapping[str, Any] | None = None,
        result: Any = None,
        session_id: str = "",
        **kwargs: Any,
    ) -> None:
        self._observe(
            "post_tool_call",
            {
                "hook_event_name": "post_tool_call",
                "tool_name": tool_name,
                "tool_input": dict(args or {}),
                "tool_response": result,
                "session_id": session_id,
                "cwd": _string(kwargs.get("cwd")) or os.getcwd(),
                "hermes": {"profile": self.profile, **kwargs},
            },
        )

    def on_session_start(self, session_id: str = "", **kwargs: Any) -> None:
        self._observe(
            "on_session_start",
            {
                "hook_event_name": "on_session_start",
                "session_id": session_id,
                "cwd": _string(kwargs.get("cwd")) or os.getcwd(),
                "hermes": {"profile": self.profile, **kwargs},
            },
        )

    def on_session_end(self, session_id: str = "", **kwargs: Any) -> None:
        self._observe(
            "on_session_end",
            {
                "hook_event_name": "on_session_end",
                "session_id": session_id,
                "cwd": _string(kwargs.get("cwd")) or os.getcwd(),
                "hermes": {"profile": self.profile, **kwargs},
            },
        )
        self._clear_session(session_id)

    def subagent_stop(self, session_id: str = "", **kwargs: Any) -> None:
        self._observe(
            "subagent_stop",
            {
                "hook_event_name": "subagent_stop",
                "session_id": session_id,
                "cwd": _string(kwargs.get("cwd")) or os.getcwd(),
                "hermes": {"profile": self.profile, **kwargs},
            },
        )

    def pre_llm_call(self, **kwargs: Any) -> dict[str, str]:
        return {"context": _PROTOCOL_CONTEXT}

    def on_session_reset(self, session_id: str = "", **kwargs: Any) -> None:
        self._clear_session(session_id)

    def on_session_finalize(self, session_id: str = "", **kwargs: Any) -> None:
        self._clear_session(session_id)

    def _clear_session(self, session_id: str) -> None:
        try:
            self.ledger.clear_session(session_id)
        except LedgerError as exc:
            logger.warning("FailproofAI instruction cleanup failed: %s", exc)


def register(ctx: Any) -> None:
    plugin = FailproofAIPlugin(ctx)
    ctx.register_hook("pre_tool_call", plugin.pre_tool_call)
    ctx.register_hook("post_tool_call", plugin.post_tool_call)
    ctx.register_hook("pre_llm_call", plugin.pre_llm_call)
    ctx.register_hook("on_session_start", plugin.on_session_start)
    ctx.register_hook("on_session_end", plugin.on_session_end)
    ctx.register_hook("on_session_reset", plugin.on_session_reset)
    ctx.register_hook("on_session_finalize", plugin.on_session_finalize)
    ctx.register_hook("subagent_stop", plugin.subagent_stop)
