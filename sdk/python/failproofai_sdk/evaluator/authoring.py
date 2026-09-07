"""Evaluator definition registry and typed author results."""

from __future__ import annotations

import hashlib
import inspect
import json
import math
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from failproofai_sdk.evaluator.protocol import (
    MAX_CATALOG_DEFINITIONS,
    MAX_DESCRIPTION_BYTES,
    MAX_DISPLAY_NAME_BYTES,
    MAX_DISPLAY_VALUE_BYTES,
    MAX_EVAL_KEY_BYTES,
    MAX_LABEL_BYTES,
    MAX_LABELS_PER_RESULT,
    MAX_REASONING_BYTES,
    MAX_RESULTS_PER_RUN,
    MAX_SUMMARY_BYTES,
    MAX_UNIT_BYTES,
    MAX_VERSION_BYTES,
    CatalogDefinition,
    ResultItem,
    ResultKind,
    SessionTranscript,
)

_KEY = re.compile(r"^[a-z][a-z0-9_]*$")
EvalFunction = Callable[[SessionTranscript], "EvalResult | Awaitable[EvalResult]"]
ConditionFunction = Callable[
    [SessionTranscript], "bool | ConditionResult | Awaitable[bool | ConditionResult]"
]
CancellationFunction = Callable[[SessionTranscript], "Any | Awaitable[Any]"]


def _bounded(value: str, *, field_name: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if not value:
        raise ValueError(f"{field_name} must not be empty")
    size = len(value.encode("utf-8"))
    if size > maximum:
        raise ValueError(f"{field_name} is {size} bytes; maximum is {maximum}")
    # Reject C0 control characters and DEL, matching the server's `check_bounded`
    # (server/src/evaluator/protocol.rs). Without this the SDK accepts a string —
    # e.g. reasoning/summary quoting transcript text that contains an ANSI escape
    # or NUL — that the server then rejects with a NON-RETRYABLE 422, so a
    # successful evaluation is silently lost and its assignment dead-letters.
    # TAB, LF and CR are kept because real multi-line reasoning uses them.
    bad = next(
        (
            ch
            for ch in value
            if (ord(ch) < 0x20 and ch not in "\t\n\r") or ord(ch) == 0x7F
        ),
        None,
    )
    if bad is not None:
        raise ValueError(
            f"{field_name} must not contain control characters "
            f"(found U+{ord(bad):04X})"
        )
    return value


def _finite(value: float, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{field_name} must be a number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{field_name} must be finite")
    return result


def _labels(values: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    if len(values) > MAX_LABELS_PER_RESULT:
        raise ValueError(f"at most {MAX_LABELS_PER_RESULT} labels are allowed")
    normalized = []
    for label in values:
        normalized.append(_bounded(label, field_name="label", maximum=MAX_LABEL_BYTES))
    if len(set(normalized)) != len(normalized):
        raise ValueError("labels must be unique")
    return tuple(sorted(normalized))


@dataclass(frozen=True)
class Score:
    value: float
    passed: bool | None = None
    unit: str = "ratio"
    display_value: str | None = None
    description: str | None = None

    def __post_init__(self) -> None:
        value = _finite(self.value, "score value")
        if not 0 <= value <= 1:
            raise ValueError("score value must be between 0 and 1")
        object.__setattr__(self, "value", value)
        if self.passed is not None and not isinstance(self.passed, bool):
            raise TypeError("score passed must be a boolean or None")
        _validate_result_text(self.unit, self.display_value, self.description)


@dataclass(frozen=True)
class Metric:
    value: float
    unit: str = ""
    display_value: str | None = None
    description: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "value", _finite(self.value, "metric value"))
        _validate_result_text(self.unit, self.display_value, self.description)


@dataclass(frozen=True)
class Assertion:
    passed: bool
    description: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.passed, bool):
            raise TypeError("assertion passed must be a boolean")
        if self.description is not None:
            _bounded(
                self.description,
                field_name="description",
                maximum=MAX_DESCRIPTION_BYTES,
            )


@dataclass(frozen=True)
class ConditionResult:
    applicable: bool
    reason_code: str = "condition_false"

    def __post_init__(self) -> None:
        if not isinstance(self.applicable, bool):
            raise TypeError("condition applicable must be a boolean")
        _validate_key(self.reason_code, "condition reason code")


def _validate_result_text(
    unit: str, display_value: str | None, description: str | None
) -> None:
    if unit:
        _bounded(unit, field_name="unit", maximum=MAX_UNIT_BYTES)
    if display_value is not None:
        _bounded(
            display_value,
            field_name="display value",
            maximum=MAX_DISPLAY_VALUE_BYTES,
        )
    if description is not None:
        _bounded(
            description,
            field_name="description",
            maximum=MAX_DESCRIPTION_BYTES,
        )


@dataclass(frozen=True)
class EvalResult:
    score: Score | None = None
    metrics: Mapping[str, Metric | float] = field(default_factory=dict)
    assertions: Mapping[str, Assertion | bool] = field(default_factory=dict)
    reasoning: str | None = None
    summary: str | None = None
    labels: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.reasoning is not None:
            _bounded(
                self.reasoning,
                field_name="reasoning",
                maximum=MAX_REASONING_BYTES,
            )
        if self.summary is not None:
            _bounded(self.summary, field_name="summary", maximum=MAX_SUMMARY_BYTES)
        object.__setattr__(self, "labels", _labels(list(self.labels)))

    def result_items(self, eval_key: str) -> tuple[ResultItem, ...]:
        items: list[ResultItem] = []
        if self.score is not None:
            items.append(
                ResultItem(
                    result_key=eval_key,
                    result_kind=ResultKind.SCORE,
                    numeric_value=self.score.value,
                    bool_value=self.score.passed,
                    unit=self.score.unit,
                    display_value=self.score.display_value,
                    description=self.score.description,
                    reasoning=self.reasoning,
                    labels=self.labels,
                )
            )
        for key, raw_metric in sorted(self.metrics.items()):
            _validate_key(key, "metric key")
            metric = (
                raw_metric if isinstance(raw_metric, Metric) else Metric(raw_metric)
            )
            items.append(
                ResultItem(
                    result_key=key,
                    result_kind=ResultKind.METRIC,
                    numeric_value=metric.value,
                    unit=metric.unit,
                    display_value=metric.display_value,
                    description=metric.description,
                    # A metric-kind eval's primary result IS the metric whose
                    # key equals eval_key; attach the eval's reasoning there so
                    # it is not silently dropped for non-score evals.
                    reasoning=self.reasoning if key == eval_key else None,
                    labels=self.labels,
                )
            )
        for key, raw_assertion in sorted(self.assertions.items()):
            _validate_key(key, "assertion key")
            assertion = (
                raw_assertion
                if isinstance(raw_assertion, Assertion)
                else Assertion(raw_assertion)
            )
            items.append(
                ResultItem(
                    result_key=key,
                    result_kind=ResultKind.ASSERTION,
                    bool_value=assertion.passed,
                    description=assertion.description,
                    # An assertion-kind eval's primary result is the assertion
                    # whose key equals eval_key; carry the eval's reasoning there
                    # so a non-score eval does not lose it.
                    reasoning=self.reasoning if key == eval_key else None,
                    labels=self.labels,
                )
            )
        if not items:
            raise ValueError("an EvalResult must contain a score, metric, or assertion")
        if len(items) > MAX_RESULTS_PER_RUN:
            raise ValueError(
                f"an EvalResult may contain at most {MAX_RESULTS_PER_RUN} results"
            )
        keys = [item.result_key for item in items]
        if len(keys) != len(set(keys)):
            raise ValueError("result keys must be unique within one evaluation run")
        return tuple(items)


def _validate_key(value: str, field_name: str = "eval_key") -> str:
    _bounded(value, field_name=field_name, maximum=MAX_EVAL_KEY_BYTES)
    if not _KEY.fullmatch(value):
        raise ValueError(f"{field_name} must match {_KEY.pattern}")
    return value


@dataclass(frozen=True)
class EvalDefinition:
    eval_key: str
    display_name: str
    eval_version: str
    result_kind: ResultKind
    labels: tuple[str, ...]
    function: EvalFunction
    condition: ConditionFunction | None
    on_cancel: CancellationFunction | None
    timeout_seconds: float | None

    def catalog_definition(self) -> CatalogDefinition:
        return CatalogDefinition(
            eval_key=self.eval_key,
            display_name=self.display_name,
            eval_version=self.eval_version,
            result_kind=self.result_kind,
            labels=self.labels,
        )


class Evaluator:
    """A process-local collection of explicitly versioned evaluations."""

    def __init__(self, *, name: str, version: str) -> None:
        self.name = _bounded(name, field_name="name", maximum=MAX_DISPLAY_NAME_BYTES)
        self.version = _bounded(
            version, field_name="version", maximum=MAX_VERSION_BYTES
        )
        self._definitions: dict[str, EvalDefinition] = {}

    def eval(
        self,
        eval_key: str,
        *,
        version: str,
        display_name: str | None = None,
        result_kind: ResultKind | str = ResultKind.SCORE,
        labels: tuple[str, ...] | list[str] = (),
        when: ConditionFunction | None = None,
        on_cancel: CancellationFunction | None = None,
        timeout_seconds: float | None = None,
    ) -> Callable[[EvalFunction], EvalFunction]:
        key = _validate_key(eval_key)
        eval_version = _bounded(
            version, field_name="eval version", maximum=MAX_VERSION_BYTES
        )
        display = _bounded(
            display_name or eval_key.replace("_", " ").capitalize(),
            field_name="display name",
            maximum=MAX_DISPLAY_NAME_BYTES,
        )
        kind = ResultKind(result_kind)
        normalized_labels = _labels(list(labels))
        if timeout_seconds is not None:
            timeout_seconds = _finite(timeout_seconds, "timeout_seconds")
            if timeout_seconds <= 0:
                raise ValueError("timeout_seconds must be greater than zero")

        def register(function: EvalFunction) -> EvalFunction:
            if key in self._definitions:
                raise ValueError(f"duplicate eval key: {key}")
            if len(self._definitions) >= MAX_CATALOG_DEFINITIONS:
                raise ValueError(
                    f"an evaluator may define at most {MAX_CATALOG_DEFINITIONS} evaluations"
                )
            if not callable(function):
                raise TypeError("evaluation must be callable")
            if when is not None and not callable(when):
                raise TypeError("when must be callable")
            if on_cancel is not None and not callable(on_cancel):
                raise TypeError("on_cancel must be callable")
            self._definitions[key] = EvalDefinition(
                eval_key=key,
                display_name=display,
                eval_version=eval_version,
                result_kind=kind,
                labels=normalized_labels,
                function=function,
                condition=when,
                on_cancel=on_cancel,
                timeout_seconds=timeout_seconds,
            )
            return function

        return register

    @property
    def definitions(self) -> tuple[EvalDefinition, ...]:
        return tuple(self._definitions[key] for key in sorted(self._definitions))

    def catalog(self) -> tuple[CatalogDefinition, ...]:
        return tuple(definition.catalog_definition() for definition in self.definitions)

    @property
    def catalog_revision(self) -> str:
        payload = [item.to_wire() for item in self.catalog()]
        canonical = json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return "sha256:" + hashlib.sha256(canonical).hexdigest()

    def definition(self, eval_key: str) -> EvalDefinition:
        try:
            return self._definitions[eval_key]
        except KeyError as error:
            raise KeyError(f"unknown eval key: {eval_key}") from error

    def run_from_env(self) -> None:
        """Run this evaluator until the process receives a stop request."""
        import asyncio
        import signal

        from failproofai_sdk.evaluator.runtime import WorkerConfig, WorkerRuntime

        async def run() -> None:
            runtime = WorkerRuntime(self, WorkerConfig.from_env())
            loop = asyncio.get_running_loop()
            for name in ("SIGINT", "SIGTERM"):
                process_signal = getattr(signal, name, None)
                if process_signal is None:
                    continue
                try:
                    loop.add_signal_handler(process_signal, runtime.stop)
                except (NotImplementedError, RuntimeError):
                    pass
            await runtime.run_forever()

        asyncio.run(run())

    @staticmethod
    async def call(
        function: EvalFunction | ConditionFunction, session: SessionTranscript
    ) -> Any:
        result = function(session)
        if inspect.isawaitable(result):
            return await result
        return result
