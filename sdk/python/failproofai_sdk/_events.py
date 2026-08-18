import logging
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

logger = logging.getLogger(__name__)

# session_id and agent_id are explicit signature params on every method, so Python raises
# TypeError before our validator runs if a caller tries to pass them as extra **fields.
# timestamp and type are not in the signature, so they land in **fields and are caught here.
_RESERVED = frozenset({"timestamp", "session_id", "agent_id", "type", "environment"})

# Payload keys ingest lifts out of the JSON blob into unsigned 32-bit columns via
# `pu32()`. Everything else is stored as-is and can be any shape, but these three
# are read with a typed accessor that returns None on a mismatch — and a None
# there is written as NULL under a 200 OK. Nothing is logged, nothing is
# rejected, and the row still arrives, so the only symptom is a column that is
# empty for some events and not others.
#
# `duration_ms` is refused outright on the four events that MEASURE it. These
# checks cover the other way in: any of the three passed as a custom field on an
# event that does not name it, plus `model_response`'s own two parameters, which
# are the ones a caller is most likely to fill straight from a provider response.
_PROMOTED_NUMERIC = frozenset({"duration_ms", "input_tokens", "output_tokens"})

_U32_MAX = 2**32 - 1


def _validate_promoted_numeric(name: str, value) -> None:
    """Reject anything `pu32()` would silently turn into NULL.

    Rejecting rather than coercing, and at the boundary rather than in the
    writer, for the same reason `_validated_interval` does: this is the last
    point where the caller still has a stack trace pointing at their own call.
    A float is a mistake worth hearing about — the server drops it whole rather
    than rounding it — and rounding it here would hide that from the one person
    who could fix the source of it.

    `bool` is checked before `int` because it IS an int in Python, and `True`
    would otherwise sail through and store as 1.
    """
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(
            f"{name} must be an int (the server reads it as an unsigned 32-bit "
            f"integer and stores NULL for anything else), got {type(value).__name__}: {value!r}"
        )
    if not 0 <= value <= _U32_MAX:
        raise ValueError(
            f"{name} must be between 0 and {_U32_MAX} (an unsigned 32-bit "
            f"integer), got {value!r}"
        )


def _validate_identity(name: str, value) -> None:
    """Reject an id the server will skip, at the point the caller can see it.

    `session_id` and `agent_id` are on every one of the 15 event types and are
    what everything downstream groups by. Ingest requires each to be a JSON
    string: hand it anything else and the row is SKIPPED — and the response is
    `200 OK` with `{"accepted": 0, "skipped": 1}`, so nothing upstream learns.
    The SDK reports success, the collector deletes the batch, and the event is
    gone. Verified against the live server for int, null and object.

    `None` is the realistic way in — an uninitialised variable, a dict lookup
    that missed, an id threaded through a code path that forgot to set it. The
    caller does not get a wrong number here, they get no data at all, and the
    only symptom is a dashboard that is emptier than it should be.

    Empty and whitespace-only are refused as well, and those the server DOES
    accept. That is the worse outcome of the two: every event lands, grouped
    under one blank id, so the data looks present and is silently merged.
    """
    if not isinstance(value, str):
        raise ValueError(
            f"{name} must be a str — the server skips any event whose {name} is "
            f"not a JSON string, and answers 200 as though it stored it. "
            f"Got {type(value).__name__}: {value!r}"
        )
    if not value.strip():
        raise ValueError(
            f"{name} must not be empty — the server accepts it, so every event "
            f"sent this way is silently grouped under one blank id."
        )

def _measured_duration_ms(start_ts, end_ts) -> "int | None":
    """Whole milliseconds between a paired start and end, or None.

    The four paired events each computed this inline, and none of them applied
    the range the SERVER enforces — the same range `_validate_promoted_numeric`
    refuses a caller for. `pu32()` reads `duration_ms` as an unsigned 32-bit
    integer and stores NULL for anything outside it, at `200 OK`, so an
    out-of-range duration is not an error anywhere: the row lands with an empty
    column and nothing says why.

    Two ways to leave the range, both reachable without anything being wrong
    with the caller:

    * **over.** 2**32 ms is ~49.7 days. A `human_wait` answered after a long
      weekend, or an `agent_pause` resumed a month later, is an ordinary
      lifetime for these pairs, not an abuse of them.
    * **under.** These are wall-clock readings from `datetime.now()`, so an NTP
      step backwards between start and end yields a NEGATIVE interval. `round()`
      keeps the sign, and a negative into an unsigned column is the same silent
      NULL.

    Omitted rather than clamped. A clamped 49.7 days is indistinguishable from a
    measurement, and the whole reason `duration_ms` is computed here instead of
    accepted from the caller is that a reported duration is unfalsifiable. An
    absent field is at least honest, and the timestamps are still on both events
    for anyone who wants to do the subtraction themselves.
    """
    if start_ts is None:
        return None
    ms = round((end_ts - start_ts).total_seconds() * 1000)
    if not 0 <= ms <= _U32_MAX:
        logger.warning(
            "Failproof AI omitted duration_ms=%d: outside the unsigned 32-bit range "
            "the server stores it in (0..%d). The event is unaffected.",
            ms,
            _U32_MAX,
        )
        return None
    return ms


# Hard cap on `_pending` correlation map size. Orphaned starts (a `tool_use` with
# no `tool_result`, a `human_wait` the user never answers, etc.) would otherwise
# grow this dict unbounded in a long-running process. At the cap we evict the
# oldest entry FIFO — Python dicts preserve insertion order since 3.7.
_PENDING_CAP = 10_000


# Every pairing in `_pending` is namespaced by what it pairs AND by whose it is.
# Neither half was always there, and each missing half produced the same class of
# wrong answer: a duration measured between two unrelated events.
#
# The kind prefix came first. Tool pairs keyed on the bare `tool_call_id` and
# hook pairs on the bare `hook_id`, sharing one flat keyspace, so a caller whose
# tool call and hook happened to share an id — not exotic, both are frequently
# the harness's own step id — got a `hook_completed` that consumed the
# `tool_use` timestamp, and then a `tool_result` with no duration at all.
#
# The session/agent half was still missing afterwards, and only from these two:
# human and pause pairs had it from the start. `_pending` lives on one
# process-wide `EventNamespace`, so two sessions in one process — a supervisor
# running agents concurrently, the ordinary multi-agent shape — collided on any
# shared step id. Starting `step-1` in session A then in session B overwrote A's
# timestamp; A's result then reported B's interval, and B's result reported none.
# Both are plausible numbers, neither is an error, and nothing downstream can
# tell which sessions were affected.
#
# These are correlation keys only; they are never emitted and never leave the
# process, so namespacing them changes no wire format. It only changes
# `duration_ms` in the colliding case, from a fabricated value to a correct one.
def _tool_key(session_id: str, agent_id: str, tool_call_id: str) -> str:
    return f"tool:{session_id}:{agent_id}:{tool_call_id}"


def _hook_key(session_id: str, agent_id: str, hook_id: str) -> str:
    return f"hook:{session_id}:{agent_id}:{hook_id}"


class EventNamespace:
    def __init__(self, writer) -> None:
        self._writer = writer
        self._pending: dict[str, datetime] = {}

    def _track_pending(self, key: str, ts: datetime) -> None:
        # Evicting has to tolerate another thread doing the same thing, because
        # this runs on the CALLER'S agent loop and a raise here is a crash in
        # their code, not a lost measurement.
        #
        # `len()` then `next(iter())` then remove is a read-modify-write, and
        # nothing serialises the three. Two threads arriving at the cap together
        # pick the SAME victim, and the second `del` raised KeyError straight
        # out of `event.tool_use()`. Reproduced at 24 crashes per 30_000 calls
        # across 10 threads — and only once `_pending` is full, which is the
        # long-running multi-agent process this cap exists for in the first
        # place. `next(iter())` has two more shapes for the same reason:
        # StopIteration if the dict was emptied, RuntimeError if it was resized
        # between the iterator and the first step.
        #
        # No lock, deliberately. `_pending` operations are nanoseconds and a
        # lock held at the instant of a `fork()` is inherited locked by a thread
        # that does not exist in the child — the exact hazard `_writer` rebuilds
        # its Event and lock to avoid. Tolerant operations have no such edge.
        #
        # The cost is that the cap is approximate under contention: several
        # threads may insert after each evicting once. That is the same trade
        # `EventWriter.submit` already makes — a backstop against unbounded
        # growth, not an exact quota.
        if len(self._pending) >= _PENDING_CAP:
            try:
                oldest = next(iter(self._pending))
            except (StopIteration, RuntimeError):  # emptied or resized under us
                pass
            else:
                self._pending.pop(oldest, None)  # may already be gone
        self._pending[key] = ts

    def _validate_fields(self, fields: dict) -> None:
        bad = _RESERVED & fields.keys()
        if bad:
            raise ValueError(f"Reserved field names cannot be used as custom fields: {sorted(bad)}")
        for name in _PROMOTED_NUMERIC & fields.keys():
            _validate_promoted_numeric(name, fields[name])

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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
        self._validate_fields(fields)
        ts = self._now()
        self._track_pending(_tool_key(session_id, agent_id, tool_call_id), ts)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
        self._validate_fields(fields)
        ts = self._now()
        start_ts = self._pending.pop(_tool_key(session_id, agent_id, tool_call_id), None)
        duration_ms = _measured_duration_ms(start_ts, ts)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
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
        # Named parameters, so they never reach `_validate_fields`. They are also
        # the likeliest of the three to arrive wrong: a caller reading them off a
        # provider's usage object gets whatever that object holds.
        _validate_promoted_numeric("input_tokens", input_tokens)
        _validate_promoted_numeric("output_tokens", output_tokens)
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
        self._validate_fields(fields)
        ts = self._now()
        start_ts = self._pending.pop(f"pause:{session_id}:{agent_id}:{pause_id}", None)
        duration_ms = _measured_duration_ms(start_ts, ts)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
        self._validate_fields(fields)
        ts = self._now()
        self._track_pending(_hook_key(session_id, agent_id, hook_id), ts)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
        self._validate_fields(fields)
        ts = self._now()
        start_ts = self._pending.pop(_hook_key(session_id, agent_id, hook_id), None)
        duration_ms = _measured_duration_ms(start_ts, ts)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
        self._validate_fields(fields)
        ts = self._now()
        start_ts = self._pending.pop(f"human:{session_id}:{agent_id}:{input_id}", None)
        duration_ms = _measured_duration_ms(start_ts, ts)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
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
        _validate_identity("session_id", session_id)
        _validate_identity("agent_id", agent_id)
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
