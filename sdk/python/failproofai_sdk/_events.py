from datetime import datetime, timezone
from typing import Any

from failproofai_sdk._schema import (
    AgentEndEvent,
    AgentPauseEvent,
    AgentResumeEvent,
    AgentStartEvent,
    ErrorEvent,
    HookCompletedEvent,
    HookTriggeredEvent,
    HumanInputEvent,
    HumanInterruptEvent,
    HumanPauseEvent,
    HumanWaitEvent,
    ModelRequestEvent,
    ModelResponseEvent,
    ToolResultEvent,
    ToolUseEvent,
)

# session_id and agent_id are explicit signature params on every method, so Python raises
# TypeError before our validator runs if a caller tries to pass them as extra **fields.
# timestamp and type are not in the signature, so they land in **fields and are caught here.
_RESERVED = frozenset({"timestamp", "session_id", "agent_id", "type", "environment"})

# Hard cap on `_pending` correlation map size. Orphaned starts (a `tool_use` with
# no `tool_result`, a `human_wait` the user never answers, etc.) would otherwise
# grow this dict unbounded in a long-running process. At the cap we evict the
# oldest entry FIFO — Python dicts preserve insertion order since 3.7.
_PENDING_CAP = 10_000


# Every pairing in `_pending` is namespaced by what it pairs. It was not always:
# tool pairs keyed on the bare `tool_call_id` and hook pairs on the bare
# `hook_id`, sharing one flat keyspace, while human and pause pairs were already
# namespaced. A caller whose tool call and hook happened to share an id — not
# exotic, both are frequently the harness's own step id — got a `hook_completed`
# that consumed the `tool_use` timestamp and reported the interval between two
# unrelated events, and then a `tool_result` with no duration at all. Both are
# plausible numbers, neither is an error, and nothing downstream can tell.
#
# These are correlation keys only; they are never emitted and never leave the
# process, so namespacing them changes no wire format. It only changes
# `duration_ms` in the colliding case, from a fabricated value to a correct one.
def _tool_key(tool_call_id: str) -> str:
    return f"tool:{tool_call_id}"


def _hook_key(hook_id: str) -> str:
    return f"hook:{hook_id}"


class EventNamespace:
    def __init__(self, writer) -> None:
        self._writer = writer
        self._pending: dict[str, datetime] = {}

    def _track_pending(self, key: str, ts: datetime) -> None:
        if len(self._pending) >= _PENDING_CAP:
            oldest = next(iter(self._pending))
            del self._pending[oldest]
        self._pending[key] = ts

    def _validate_fields(self, fields: dict) -> None:
        bad = _RESERVED & fields.keys()
        if bad:
            raise ValueError(f"Reserved field names cannot be used as custom fields: {sorted(bad)}")

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)

    @staticmethod
    def _fmt_ts(dt: datetime) -> str:
        return dt.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"

    def tool_use(
        self,
        *,
        session_id: str,
        agent_id: str,
        tool_name: str,
        tool_call_id: str,
        input: dict | None = None,
        **fields,
    ) -> None:
        self._validate_fields(fields)
        ts = self._now()
        self._track_pending(_tool_key(tool_call_id), ts)
        self._writer.submit(
            ToolUseEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                tool_name=tool_name,
                tool_call_id=tool_call_id,
                input=input,
                extra_fields=fields,
            ).to_dict()
        )

    def tool_result(
        self,
        *,
        session_id: str,
        agent_id: str,
        tool_name: str,
        tool_call_id: str,
        output: Any | None = None,
        error: str | None = None,
        **fields,
    ) -> None:
        if "duration_ms" in fields:
            raise ValueError("duration_ms is auto-computed by the SDK and cannot be passed by the caller")
        self._validate_fields(fields)
        ts = self._now()
        start_ts = self._pending.pop(_tool_key(tool_call_id), None)
        # Emit an int: the server stores duration_ms as u32 and its JSON parser
        # drops any float (`as_u64()` -> None), so a bare float silently NULLs the
        # column. Round to whole milliseconds at the source.
        duration_ms = (
            round((ts - start_ts).total_seconds() * 1000) if start_ts is not None else None
        )
        self._writer.submit(
            ToolResultEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                tool_name=tool_name,
                tool_call_id=tool_call_id,
                output=output,
                error=error,
                duration_ms=duration_ms,
                extra_fields=fields,
            ).to_dict()
        )

    def model_request(
        self,
        *,
        session_id: str,
        agent_id: str,
        model: str | None = None,
        messages: list[dict] | None = None,
        system: Any | None = None,
        tools: list[dict] | None = None,
        **fields,
    ) -> None:
        self._validate_fields(fields)
        ts = self._now()
        self._writer.submit(
            ModelRequestEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                model=model,
                messages=messages,
                system=system,
                tools=tools,
                extra_fields=fields,
            ).to_dict()
        )

    def model_response(
        self,
        *,
        session_id: str,
        agent_id: str,
        model: str | None = None,
        stop_reason: str | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        content: Any | None = None,
        role: str | None = None,
        **fields,
    ) -> None:
        self._validate_fields(fields)
        ts = self._now()
        self._writer.submit(
            ModelResponseEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                model=model,
                stop_reason=stop_reason,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                content=content,
                role=role,
                extra_fields=fields,
            ).to_dict()
        )

    def agent_start(
        self,
        *,
        session_id: str,
        agent_id: str,
        goal: str | None = None,
        parent_id: str | None = None,
        **fields,
    ) -> None:
        self._validate_fields(fields)
        ts = self._now()
        self._writer.submit(
            AgentStartEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                goal=goal,
                parent_id=parent_id,
                extra_fields=fields,
            ).to_dict()
        )

    def agent_end(
        self,
        *,
        session_id: str,
        agent_id: str,
        outcome: str | None = None,
        summary: str | None = None,
        **fields,
    ) -> None:
        self._validate_fields(fields)
        ts = self._now()
        self._writer.submit(
            AgentEndEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                outcome=outcome,
                summary=summary,
                extra_fields=fields,
            ).to_dict()
        )

    def agent_pause(
        self,
        *,
        session_id: str,
        agent_id: str,
        pause_id: str,
        reason: str | None = None,
        user_id: str | None = None,
        **fields,
    ) -> None:
        self._validate_fields(fields)
        ts = self._now()
        self._track_pending(f"pause:{session_id}:{agent_id}:{pause_id}", ts)
        self._writer.submit(
            AgentPauseEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                pause_id=pause_id,
                reason=reason,
                user_id=user_id,
                extra_fields=fields,
            ).to_dict()
        )

    def agent_resume(
        self,
        *,
        session_id: str,
        agent_id: str,
        pause_id: str,
        reason: str | None = None,
        user_id: str | None = None,
        **fields,
    ) -> None:
        if "duration_ms" in fields:
            raise ValueError("duration_ms is auto-computed by the SDK and cannot be passed by the caller")
        self._validate_fields(fields)
        ts = self._now()
        start_ts = self._pending.pop(f"pause:{session_id}:{agent_id}:{pause_id}", None)
        # Emit an int: the server stores duration_ms as u32 and its JSON parser
        # drops any float (`as_u64()` -> None), so a bare float silently NULLs the
        # column. Round to whole milliseconds at the source.
        duration_ms = (
            round((ts - start_ts).total_seconds() * 1000) if start_ts is not None else None
        )
        self._writer.submit(
            AgentResumeEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                pause_id=pause_id,
                duration_ms=duration_ms,
                reason=reason,
                user_id=user_id,
                extra_fields=fields,
            ).to_dict()
        )

    def hook_triggered(
        self,
        *,
        session_id: str,
        agent_id: str,
        hook_name: str,
        hook_id: str,
        trigger_event: str | None = None,
        input: Any | None = None,
        **fields,
    ) -> None:
        self._validate_fields(fields)
        ts = self._now()
        self._track_pending(_hook_key(hook_id), ts)
        self._writer.submit(
            HookTriggeredEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                hook_name=hook_name,
                hook_id=hook_id,
                trigger_event=trigger_event,
                input=input,
                extra_fields=fields,
            ).to_dict()
        )

    def hook_completed(
        self,
        *,
        session_id: str,
        agent_id: str,
        hook_name: str,
        hook_id: str,
        outcome: str | None = None,
        output: Any | None = None,
        error: str | None = None,
        **fields,
    ) -> None:
        if "duration_ms" in fields:
            raise ValueError("duration_ms is auto-computed by the SDK and cannot be passed by the caller")
        self._validate_fields(fields)
        ts = self._now()
        start_ts = self._pending.pop(_hook_key(hook_id), None)
        # Emit an int: the server stores duration_ms as u32 and its JSON parser
        # drops any float (`as_u64()` -> None), so a bare float silently NULLs the
        # column. Round to whole milliseconds at the source.
        duration_ms = (
            round((ts - start_ts).total_seconds() * 1000) if start_ts is not None else None
        )
        self._writer.submit(
            HookCompletedEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                hook_name=hook_name,
                hook_id=hook_id,
                outcome=outcome,
                output=output,
                error=error,
                duration_ms=duration_ms,
                extra_fields=fields,
            ).to_dict()
        )

    def error(
        self,
        *,
        session_id: str,
        agent_id: str,
        error_type: str,
        message: str,
        traceback: str | None = None,
        **fields,
    ) -> None:
        self._validate_fields(fields)
        ts = self._now()
        self._writer.submit(
            ErrorEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                error_type=error_type,
                message=message,
                traceback=traceback,
                extra_fields=fields,
            ).to_dict()
        )

    def human_wait(
        self,
        *,
        session_id: str,
        agent_id: str,
        input_id: str,
        prompt: str | None = None,
        options: list[str] | None = None,
        reason: str | None = None,
        **fields,
    ) -> None:
        self._validate_fields(fields)
        ts = self._now()
        self._track_pending(f"human:{session_id}:{agent_id}:{input_id}", ts)
        self._writer.submit(
            HumanWaitEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                input_id=input_id,
                prompt=prompt,
                options=options,
                reason=reason,
                extra_fields=fields,
            ).to_dict()
        )

    def human_input(
        self,
        *,
        session_id: str,
        agent_id: str,
        input_id: str,
        response: str | None = None,
        **fields,
    ) -> None:
        if "duration_ms" in fields:
            raise ValueError("duration_ms is auto-computed by the SDK and cannot be passed by the caller")
        self._validate_fields(fields)
        ts = self._now()
        start_ts = self._pending.pop(f"human:{session_id}:{agent_id}:{input_id}", None)
        # Emit an int: the server stores duration_ms as u32 and its JSON parser
        # drops any float (`as_u64()` -> None), so a bare float silently NULLs the
        # column. Round to whole milliseconds at the source.
        duration_ms = (
            round((ts - start_ts).total_seconds() * 1000) if start_ts is not None else None
        )
        self._writer.submit(
            HumanInputEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                input_id=input_id,
                response=response,
                duration_ms=duration_ms,
                extra_fields=fields,
            ).to_dict()
        )

    def human_pause(
        self,
        *,
        session_id: str,
        agent_id: str,
        reason: str | None = None,
        user_id: str | None = None,
        **fields,
    ) -> None:
        self._validate_fields(fields)
        ts = self._now()
        self._writer.submit(
            HumanPauseEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                reason=reason,
                user_id=user_id,
                extra_fields=fields,
            ).to_dict()
        )

    def human_interrupt(
        self,
        *,
        session_id: str,
        agent_id: str,
        reason: str | None = None,
        user_id: str | None = None,
        at_step: str | None = None,
        **fields,
    ) -> None:
        self._validate_fields(fields)
        ts = self._now()
        self._writer.submit(
            HumanInterruptEvent(
                timestamp=self._fmt_ts(ts),
                session_id=session_id,
                agent_id=agent_id,
                reason=reason,
                user_id=user_id,
                at_step=at_step,
                extra_fields=fields,
            ).to_dict()
        )
