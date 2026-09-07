"""Dependency-free wire models for the outbound Evaluator v2 protocol."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any, TypeVar

PROTOCOL_VERSION = "2"
TRANSCRIPT_SCHEMA_VERSION = "2"
RESULT_SCHEMA_VERSION = "2"

REGISTER_PATH = "/v1/evaluator/workers/register"
CLAIM_PATH = "/v1/evaluator/assignments/claim"
TRANSCRIPT_PATH = "/v1/evaluator/assignments/{assignment_id}/transcript"
DEFINITIONS_PATH = "/v1/evaluator/assignments/{assignment_id}/definitions"
PLAN_PATH = "/v1/evaluator/assignments/{assignment_id}/plan"
HEARTBEAT_PATH = "/v1/evaluator/runs/heartbeat"
RESULT_PATH = "/v1/evaluator/runs/{evaluation_run_id}/result"
WORKER_ID_HEADER = "X-FailproofAI-Worker-Id"
LEASE_GENERATION_HEADER = "X-FailproofAI-Lease-Generation"

HEARTBEAT_INTERVAL_SECONDS = 30
LEASE_DURATION_SECONDS = 120
# Fallback poll cadence if the register response omits poll_interval_seconds. The
# worker prefers the server-advertised value; claims are normal short polls, never
# long-polls, so this only bounds idle latency, not connection lifetime.
DEFAULT_POLL_INTERVAL_SECONDS = 10
MAX_ATTEMPTS = 5

MAX_CATALOG_DEFINITIONS = 100
MAX_CLAIM_CAPACITY = 32
MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024
MAX_RESULTS_PER_RUN = 25
MAX_EVAL_KEY_BYTES = 128
MAX_DISPLAY_NAME_BYTES = 128
MAX_VERSION_BYTES = 128
MAX_WORKER_ID_BYTES = 128
MAX_LABEL_BYTES = 64
MAX_LABELS_PER_RESULT = 20
MAX_SUMMARY_BYTES = 4 * 1024
MAX_REASONING_BYTES = 16 * 1024
MAX_UNIT_BYTES = 64
MAX_DISPLAY_VALUE_BYTES = 256
MAX_DESCRIPTION_BYTES = 1_000
MAX_ERROR_CODE_BYTES = 64
MAX_ERROR_MESSAGE_BYTES = 4 * 1024

ERROR_SPECS = {
    "invalid_credentials": {"http_status": 401, "retryable": False},
    "instance_disabled": {"http_status": 403, "retryable": False},
    "insufficient_permissions": {"http_status": 403, "retryable": False},
    "assignment_not_found": {"http_status": 404, "retryable": False},
    "run_not_found": {"http_status": 404, "retryable": False},
    "catalog_mismatch": {"http_status": 409, "retryable": False},
    "lease_lost": {"http_status": 409, "retryable": False},
    "plan_conflict": {"http_status": 409, "retryable": False},
    "submission_conflict": {"http_status": 409, "retryable": False},
    "retry_budget_exhausted": {"http_status": 409, "retryable": False},
    "transcript_too_large": {"http_status": 413, "retryable": False},
    "invalid_request": {"http_status": 422, "retryable": False},
    "invalid_catalog": {"http_status": 422, "retryable": False},
    "incomplete_plan": {"http_status": 422, "retryable": False},
    "unsupported_protocol_version": {"http_status": 426, "retryable": False},
    "internal_error": {"http_status": 500, "retryable": True},
}


class ProtocolError(ValueError):
    """A local or remote evaluator protocol contract violation."""


class UnsupportedProtocolVersion(ProtocolError):
    def __init__(self, received: str) -> None:
        super().__init__(
            f"unsupported evaluator protocol version {received!r}; "
            f"supported major version is {PROTOCOL_VERSION}"
        )
        self.received = received


def validate_protocol_version(version: str) -> None:
    if version != PROTOCOL_VERSION:
        raise UnsupportedProtocolVersion(version)


class EvaluatorKind(str, Enum):
    MANAGED = "managed"
    CUSTOMER = "customer"


class ResultKind(str, Enum):
    SCORE = "score"
    METRIC = "metric"
    ASSERTION = "assertion"


class ExecutionMode(str, Enum):
    LOCAL = "local"
    PYTHON = "python"


class TerminalRunStatus(str, Enum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    TIMED_OUT = "timed_out"
    CANCELLED = "cancelled"


_EnumT = TypeVar("_EnumT", bound=Enum)


def _wire(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if hasattr(value, "__dataclass_fields__"):
        return {key: _wire(item) for key, item in asdict(value).items()}
    if isinstance(value, (list, tuple)):
        return [_wire(item) for item in value]
    if isinstance(value, dict):
        return {key: _wire(item) for key, item in value.items()}
    return value


class WireModel:
    def to_wire(self) -> dict[str, Any]:
        return _wire(self)


def _string(data: Mapping[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str):
        raise ProtocolError(f"{key} must be a string")
    return value


def _integer(data: Mapping[str, Any], key: str) -> int:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(f"{key} must be an integer")
    return value


def _list(data: Mapping[str, Any], key: str) -> list[Any]:
    value = data.get(key)
    if not isinstance(value, list):
        raise ProtocolError(f"{key} must be an array")
    return value


def _object(value: Any, field_name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ProtocolError(f"{field_name} must be an object")
    return value


def _object_list(data: Mapping[str, Any], key: str) -> tuple[Mapping[str, Any], ...]:
    return tuple(
        _object(value, f"{key}[{index}]")
        for index, value in enumerate(_list(data, key))
    )


def _string_list(data: Mapping[str, Any], key: str) -> tuple[str, ...]:
    values = _list(data, key)
    for index, value in enumerate(values):
        if not isinstance(value, str):
            raise ProtocolError(f"{key}[{index}] must be a string")
    return tuple(values)


def _enum(enum_type: type[_EnumT], data: Mapping[str, Any], key: str) -> _EnumT:
    value = _string(data, key)
    try:
        return enum_type(value)
    except ValueError as error:
        allowed = ", ".join(repr(item.value) for item in enum_type)
        raise ProtocolError(f"{key} must be one of {allowed}") from error


def _positive_integer(data: Mapping[str, Any], key: str) -> int:
    value = _integer(data, key)
    if value <= 0:
        raise ProtocolError(f"{key} must be greater than zero")
    return value


def _nonnegative_integer(data: Mapping[str, Any], key: str) -> int:
    value = _integer(data, key)
    if value < 0:
        raise ProtocolError(f"{key} must not be negative")
    return value


def _optional_string(data: Mapping[str, Any], key: str) -> str | None:
    value = data.get(key)
    if value is not None and not isinstance(value, str):
        raise ProtocolError(f"{key} must be a string or null")
    return value


@dataclass(frozen=True)
class CatalogDefinition(WireModel):
    eval_key: str
    display_name: str
    eval_version: str
    result_kind: ResultKind
    labels: tuple[str, ...] = ()

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> CatalogDefinition:
        return cls(
            eval_key=_string(data, "eval_key"),
            display_name=_string(data, "display_name"),
            eval_version=_string(data, "eval_version"),
            result_kind=_enum(ResultKind, data, "result_kind"),
            labels=_string_list(data, "labels"),
        )


@dataclass(frozen=True)
class RegisterRequest(WireModel):
    worker_id: str
    sdk_version: str
    catalog_revision: str
    max_concurrency: int
    definitions: tuple[CatalogDefinition, ...]
    protocol_version: str = PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> RegisterRequest:
        validate_protocol_version(_string(data, "protocol_version"))
        return cls(
            worker_id=_string(data, "worker_id"),
            sdk_version=_string(data, "sdk_version"),
            catalog_revision=_string(data, "catalog_revision"),
            max_concurrency=_integer(data, "max_concurrency"),
            definitions=tuple(
                CatalogDefinition.from_wire(item)
                for item in _object_list(data, "definitions")
            ),
        )


@dataclass(frozen=True)
class RegisterResponse(WireModel):
    evaluator_instance_id: str
    evaluator_kind: EvaluatorKind
    heartbeat_interval_seconds: int
    lease_duration_seconds: int
    poll_interval_seconds: int
    claim_limit: int
    disabled_definitions: tuple[str, ...] = ()
    protocol_version: str = PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> RegisterResponse:
        validate_protocol_version(_string(data, "protocol_version"))
        return cls(
            evaluator_instance_id=_string(data, "evaluator_instance_id"),
            evaluator_kind=_enum(EvaluatorKind, data, "evaluator_kind"),
            heartbeat_interval_seconds=_integer(data, "heartbeat_interval_seconds"),
            lease_duration_seconds=_integer(data, "lease_duration_seconds"),
            poll_interval_seconds=_integer(data, "poll_interval_seconds"),
            claim_limit=_integer(data, "claim_limit"),
            disabled_definitions=_string_list(data, "disabled_definitions"),
        )


@dataclass(frozen=True)
class ClaimRequest(WireModel):
    worker_id: str
    catalog_revision: str
    capacity: int
    protocol_version: str = PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> ClaimRequest:
        validate_protocol_version(_string(data, "protocol_version"))
        return cls(
            worker_id=_string(data, "worker_id"),
            catalog_revision=_string(data, "catalog_revision"),
            capacity=_integer(data, "capacity"),
        )


@dataclass(frozen=True)
class Assignment(WireModel):
    assignment_id: str
    lease_generation: int
    lease_expires_at: str
    session_id: str
    session_revision_id: str
    agent_id: str
    environment: str
    trigger_reason: str
    event_count: int
    transcript_url: str
    definitions_url: str = ""

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> Assignment:
        return cls(
            assignment_id=_string(data, "assignment_id"),
            lease_generation=_positive_integer(data, "lease_generation"),
            lease_expires_at=_string(data, "lease_expires_at"),
            session_id=_string(data, "session_id"),
            session_revision_id=_string(data, "session_revision_id"),
            agent_id=_string(data, "agent_id"),
            environment=_string(data, "environment"),
            trigger_reason=_string(data, "trigger_reason"),
            event_count=_nonnegative_integer(data, "event_count"),
            transcript_url=_string(data, "transcript_url"),
            definitions_url=str(data.get("definitions_url") or ""),
        )


@dataclass(frozen=True)
class AssignmentDefinition(WireModel):
    eval_key: str
    display_name: str
    eval_version: str
    result_kind: ResultKind
    labels: tuple[str, ...] = ()
    execution_mode: ExecutionMode = ExecutionMode.LOCAL
    condition_source: str | None = None
    source_checksum: str | None = None
    timeout_seconds: float | None = None

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> AssignmentDefinition:
        timeout = data.get("timeout_seconds")
        if timeout is not None:
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
                raise ProtocolError("timeout_seconds must be a number or null")
            timeout = float(timeout)
            if not math.isfinite(timeout) or timeout <= 0:
                raise ProtocolError("timeout_seconds must be finite and greater than zero")
        return cls(
            eval_key=_string(data, "eval_key"),
            display_name=_string(data, "display_name"),
            eval_version=_string(data, "eval_version"),
            result_kind=_enum(ResultKind, data, "result_kind"),
            labels=_string_list(data, "labels"),
            # Require execution_mode explicitly. Coercing a falsy/missing value to
            # 'local' silently ran a server-authored ('python') definition down the
            # customer-local path (or vice-versa); a malformed wire value is a
            # protocol error, not a default (F2).
            execution_mode=_enum(ExecutionMode, data, "execution_mode"),
            condition_source=_optional_string(data, "condition_source"),
            source_checksum=_optional_string(data, "source_checksum"),
            timeout_seconds=timeout,
        )


@dataclass(frozen=True)
class DefinitionsResponse(WireModel):
    assignment_id: str
    catalog_revision: str
    definitions: tuple[AssignmentDefinition, ...]
    protocol_version: str = PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> DefinitionsResponse:
        validate_protocol_version(_string(data, "protocol_version"))
        return cls(
            assignment_id=_string(data, "assignment_id"),
            catalog_revision=_string(data, "catalog_revision"),
            definitions=tuple(
                AssignmentDefinition.from_wire(item)
                for item in _object_list(data, "definitions")
            ),
        )


@dataclass(frozen=True)
class ClaimResponse(WireModel):
    assignments: tuple[Assignment, ...]
    protocol_version: str = PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> ClaimResponse:
        validate_protocol_version(_string(data, "protocol_version"))
        return cls(
            tuple(
                Assignment.from_wire(item) for item in _object_list(data, "assignments")
            )
        )


@dataclass(frozen=True)
class TranscriptEvent(WireModel):
    id: str
    ts: str
    event_type: str
    payload: Mapping[str, Any]

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> TranscriptEvent:
        payload = data.get("payload")
        if not isinstance(payload, Mapping):
            raise ProtocolError("payload must be an object")
        return cls(
            id=_string(data, "id"),
            ts=_string(data, "ts"),
            event_type=_string(data, "event_type"),
            payload=dict(payload),
        )


@dataclass(frozen=True)
class SessionTranscript(WireModel):
    assignment_id: str
    session_id: str
    session_revision_id: str
    agent_id: str
    environment: str
    started_at: str
    ended_at: str
    event_count: int
    events: tuple[TranscriptEvent, ...]
    schema_version: str = TRANSCRIPT_SCHEMA_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> SessionTranscript:
        version = _string(data, "schema_version")
        if version != TRANSCRIPT_SCHEMA_VERSION:
            raise ProtocolError(f"unsupported transcript schema version {version!r}")
        events = tuple(
            TranscriptEvent.from_wire(item) for item in _object_list(data, "events")
        )
        event_count = _nonnegative_integer(data, "event_count")
        if event_count != len(events):
            raise ProtocolError(
                f"event_count is {event_count}, but transcript contains {len(events)} events"
            )
        return cls(
            assignment_id=_string(data, "assignment_id"),
            session_id=_string(data, "session_id"),
            session_revision_id=_string(data, "session_revision_id"),
            agent_id=_string(data, "agent_id"),
            environment=_string(data, "environment"),
            started_at=_string(data, "started_at"),
            ended_at=_string(data, "ended_at"),
            event_count=event_count,
            events=events,
        )

    def events_of_type(self, event_type: str) -> tuple[TranscriptEvent, ...]:
        return tuple(event for event in self.events if event.event_type == event_type)

    def count(self, event_type: str) -> int:
        return sum(event.event_type == event_type for event in self.events)


@dataclass(frozen=True)
class EvalSelection(WireModel):
    eval_key: str
    eval_version: str

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> EvalSelection:
        return cls(_string(data, "eval_key"), _string(data, "eval_version"))


@dataclass(frozen=True)
class SkippedEval(WireModel):
    eval_key: str
    eval_version: str
    reason_code: str

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> SkippedEval:
        return cls(
            _string(data, "eval_key"),
            _string(data, "eval_version"),
            _string(data, "reason_code"),
        )


@dataclass(frozen=True)
class PlanRequest(WireModel):
    worker_id: str
    lease_generation: int
    selected: tuple[EvalSelection, ...] = ()
    skipped: tuple[SkippedEval, ...] = ()
    protocol_version: str = PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> PlanRequest:
        validate_protocol_version(_string(data, "protocol_version"))
        return cls(
            worker_id=_string(data, "worker_id"),
            lease_generation=_positive_integer(data, "lease_generation"),
            selected=tuple(
                EvalSelection.from_wire(item) for item in _object_list(data, "selected")
            ),
            skipped=tuple(
                SkippedEval.from_wire(item) for item in _object_list(data, "skipped")
            ),
        )


@dataclass(frozen=True)
class PlannedRun(WireModel):
    evaluation_run_id: str
    eval_key: str
    eval_version: str
    execution_mode: ExecutionMode = ExecutionMode.LOCAL
    evaluator_source: str | None = None
    source_checksum: str | None = None
    timeout_seconds: float | None = None

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> PlannedRun:
        timeout = data.get("timeout_seconds")
        if timeout is not None:
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
                raise ProtocolError("timeout_seconds must be a number or null")
            timeout = float(timeout)
            if not math.isfinite(timeout) or timeout <= 0:
                raise ProtocolError("timeout_seconds must be finite and greater than zero")
        return cls(
            evaluation_run_id=_string(data, "evaluation_run_id"),
            eval_key=_string(data, "eval_key"),
            eval_version=_string(data, "eval_version"),
            # Require execution_mode explicitly. Coercing a falsy/missing value to
            # 'local' silently ran a server-authored ('python') definition down the
            # customer-local path (or vice-versa); a malformed wire value is a
            # protocol error, not a default (F2).
            execution_mode=_enum(ExecutionMode, data, "execution_mode"),
            evaluator_source=_optional_string(data, "evaluator_source"),
            source_checksum=_optional_string(data, "source_checksum"),
            timeout_seconds=timeout,
        )


@dataclass(frozen=True)
class PlanResponse(WireModel):
    assignment_id: str
    assignment_status: str
    runs: tuple[PlannedRun, ...]
    idempotent_replay: bool = False
    protocol_version: str = PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> PlanResponse:
        validate_protocol_version(_string(data, "protocol_version"))
        replay = data.get("idempotent_replay", False)
        if not isinstance(replay, bool):
            raise ProtocolError("idempotent_replay must be a boolean")
        return cls(
            assignment_id=_string(data, "assignment_id"),
            assignment_status=_string(data, "assignment_status"),
            runs=tuple(
                PlannedRun.from_wire(item) for item in _object_list(data, "runs")
            ),
            idempotent_replay=replay,
        )


@dataclass(frozen=True)
class HeartbeatRun(WireModel):
    evaluation_run_id: str
    state: str
    progress: float | None = None

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> HeartbeatRun:
        progress = data.get("progress")
        if progress is not None:
            if isinstance(progress, bool) or not isinstance(progress, (int, float)):
                raise ProtocolError("progress must be a number or null")
            progress = float(progress)
            if not math.isfinite(progress) or not 0 <= progress <= 1:
                raise ProtocolError("progress must be finite and between 0 and 1")
        return cls(
            evaluation_run_id=_string(data, "evaluation_run_id"),
            state=_string(data, "state"),
            progress=progress,
        )


@dataclass(frozen=True)
class HeartbeatRequest(WireModel):
    worker_id: str
    lease_generation: int
    runs: tuple[HeartbeatRun, ...]
    protocol_version: str = PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> HeartbeatRequest:
        validate_protocol_version(_string(data, "protocol_version"))
        return cls(
            worker_id=_string(data, "worker_id"),
            lease_generation=_positive_integer(data, "lease_generation"),
            runs=tuple(
                HeartbeatRun.from_wire(item) for item in _object_list(data, "runs")
            ),
        )


@dataclass(frozen=True)
class HeartbeatResponse(WireModel):
    lease_expires_at: str
    accepted_run_ids: tuple[str, ...]
    protocol_version: str = PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> HeartbeatResponse:
        validate_protocol_version(_string(data, "protocol_version"))
        return cls(
            lease_expires_at=_string(data, "lease_expires_at"),
            accepted_run_ids=_string_list(data, "accepted_run_ids"),
        )


@dataclass(frozen=True)
class ResultItem(WireModel):
    result_key: str
    result_kind: ResultKind
    numeric_value: float | None = None
    bool_value: bool | None = None
    text_value: str | None = None
    unit: str = ""
    display_value: str | None = None
    description: str | None = None
    reasoning: str | None = None
    labels: tuple[str, ...] = ()

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> ResultItem:
        numeric = data.get("numeric_value")
        if numeric is not None:
            if isinstance(numeric, bool) or not isinstance(numeric, (int, float)):
                raise ProtocolError("numeric_value must be a number or null")
            numeric = float(numeric)
            if not math.isfinite(numeric):
                raise ProtocolError("numeric_value must be finite")
        boolean = data.get("bool_value")
        if boolean is not None and not isinstance(boolean, bool):
            raise ProtocolError("bool_value must be a boolean or null")
        return cls(
            result_key=_string(data, "result_key"),
            result_kind=_enum(ResultKind, data, "result_kind"),
            numeric_value=numeric,
            bool_value=boolean,
            text_value=_optional_string(data, "text_value"),
            unit=_string(data, "unit"),
            display_value=_optional_string(data, "display_value"),
            description=_optional_string(data, "description"),
            reasoning=_optional_string(data, "reasoning"),
            labels=_string_list(data, "labels"),
        )


@dataclass(frozen=True)
class ResultRequest(WireModel):
    submission_id: str
    worker_id: str
    lease_generation: int
    status: TerminalRunStatus
    started_at: str
    finished_at: str
    duration_ms: int
    summary: str | None
    results: tuple[ResultItem, ...]
    error_code: str | None
    error_message: str | None
    protocol_version: str = PROTOCOL_VERSION
    result_schema_version: str = RESULT_SCHEMA_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> ResultRequest:
        validate_protocol_version(_string(data, "protocol_version"))
        result_schema_version = _string(data, "result_schema_version")
        if result_schema_version != RESULT_SCHEMA_VERSION:
            raise ProtocolError(
                f"unsupported result schema version {result_schema_version!r}"
            )
        return cls(
            submission_id=_string(data, "submission_id"),
            worker_id=_string(data, "worker_id"),
            lease_generation=_positive_integer(data, "lease_generation"),
            status=_enum(TerminalRunStatus, data, "status"),
            started_at=_string(data, "started_at"),
            finished_at=_string(data, "finished_at"),
            duration_ms=_nonnegative_integer(data, "duration_ms"),
            summary=_optional_string(data, "summary"),
            results=tuple(
                ResultItem.from_wire(item) for item in _object_list(data, "results")
            ),
            error_code=_optional_string(data, "error_code"),
            error_message=_optional_string(data, "error_message"),
        )


@dataclass(frozen=True)
class ResultResponse(WireModel):
    evaluation_run_id: str
    submission_id: str
    status: str
    idempotent_replay: bool
    result_count: int
    result_checksum: str
    protocol_version: str = PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> ResultResponse:
        validate_protocol_version(_string(data, "protocol_version"))
        replay = data.get("idempotent_replay")
        if not isinstance(replay, bool):
            raise ProtocolError("idempotent_replay must be a boolean")
        return cls(
            evaluation_run_id=_string(data, "evaluation_run_id"),
            submission_id=_string(data, "submission_id"),
            status=_string(data, "status"),
            idempotent_replay=replay,
            result_count=_nonnegative_integer(data, "result_count"),
            result_checksum=_string(data, "result_checksum"),
        )


@dataclass(frozen=True)
class RemoteError(WireModel):
    code: str
    message: str
    retryable: bool
    request_id: str

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> RemoteError:
        retryable = data.get("retryable")
        if not isinstance(retryable, bool):
            raise ProtocolError("retryable must be a boolean")
        return cls(
            code=_string(data, "code"),
            message=_string(data, "message"),
            retryable=retryable,
            request_id=_string(data, "request_id"),
        )


@dataclass(frozen=True)
class ErrorResponse(WireModel):
    error: RemoteError
    protocol_version: str = PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> ErrorResponse:
        validate_protocol_version(_string(data, "protocol_version"))
        return cls(RemoteError.from_wire(_object(data.get("error"), "error")))
