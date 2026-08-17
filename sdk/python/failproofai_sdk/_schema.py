from dataclasses import dataclass, field
from typing import Any

from failproofai_sdk._environment import get_environment


def _build(base: dict, specifics: list[tuple[str, Any]], extra: dict) -> dict:
    """Build ordered event dict, omitting None values, then merge extra fields."""
    result = {**base}
    result["environment"] = get_environment()
    for k, v in specifics:
        if v is not None:
            result[k] = v
    result.update(extra)
    return result


@dataclass(kw_only=True)
class ToolUseEvent:
    timestamp: str
    session_id: str
    agent_id: str
    tool_name: str
    tool_call_id: str
    input: dict | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id, "type": "tool_use",
             "tool_name": self.tool_name, "tool_call_id": self.tool_call_id},
            [("input", self.input)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class ToolResultEvent:
    timestamp: str
    session_id: str
    agent_id: str
    tool_name: str
    tool_call_id: str
    output: Any | None = None
    error: str | None = None
    duration_ms: float | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id, "type": "tool_result",
             "tool_name": self.tool_name, "tool_call_id": self.tool_call_id},
            [("output", self.output), ("error", self.error), ("duration_ms", self.duration_ms)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class ModelRequestEvent:
    timestamp: str
    session_id: str
    agent_id: str
    model: str | None = None
    messages: list[dict] | None = None
    system: Any | None = None
    tools: list[dict] | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id, "type": "model_request"},
            [("model", self.model), ("messages", self.messages),
             ("system", self.system), ("tools", self.tools)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class ModelResponseEvent:
    timestamp: str
    session_id: str
    agent_id: str
    model: str | None = None
    stop_reason: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    content: Any | None = None
    role: str | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id, "type": "model_response"},
            [("model", self.model), ("stop_reason", self.stop_reason),
             ("input_tokens", self.input_tokens), ("output_tokens", self.output_tokens),
             ("content", self.content), ("role", self.role)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class AgentStartEvent:
    timestamp: str
    session_id: str
    agent_id: str
    goal: str | None = None
    parent_id: str | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id, "type": "agent_start"},
            [("goal", self.goal), ("parent_id", self.parent_id)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class AgentEndEvent:
    timestamp: str
    session_id: str
    agent_id: str
    outcome: str | None = None
    summary: str | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id, "type": "agent_end"},
            [("outcome", self.outcome), ("summary", self.summary)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class AgentPauseEvent:
    timestamp: str
    session_id: str
    agent_id: str
    pause_id: str
    reason: str | None = None
    user_id: str | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id,
             "type": "agent_pause", "pause_id": self.pause_id},
            [("reason", self.reason), ("user_id", self.user_id)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class AgentResumeEvent:
    timestamp: str
    session_id: str
    agent_id: str
    pause_id: str
    duration_ms: float | None = None
    reason: str | None = None
    user_id: str | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id,
             "type": "agent_resume", "pause_id": self.pause_id},
            [("duration_ms", self.duration_ms), ("reason", self.reason), ("user_id", self.user_id)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class HookTriggeredEvent:
    timestamp: str
    session_id: str
    agent_id: str
    hook_name: str
    hook_id: str
    trigger_event: str | None = None
    input: Any | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id, "type": "hook_triggered",
             "hook_name": self.hook_name, "hook_id": self.hook_id},
            [("trigger_event", self.trigger_event), ("input", self.input)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class HookCompletedEvent:
    timestamp: str
    session_id: str
    agent_id: str
    hook_name: str
    hook_id: str
    outcome: str | None = None
    output: Any | None = None
    error: str | None = None
    duration_ms: float | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id, "type": "hook_completed",
             "hook_name": self.hook_name, "hook_id": self.hook_id},
            [("outcome", self.outcome), ("output", self.output),
             ("error", self.error), ("duration_ms", self.duration_ms)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class ErrorEvent:
    timestamp: str
    session_id: str
    agent_id: str
    error_type: str
    message: str
    traceback: str | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id, "type": "error",
             "error_type": self.error_type, "message": self.message},
            [("traceback", self.traceback)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class HumanWaitEvent:
    timestamp: str
    session_id: str
    agent_id: str
    input_id: str
    prompt: str | None = None
    options: list[str] | None = None
    reason: str | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id,
             "type": "human_wait", "input_id": self.input_id},
            [("prompt", self.prompt), ("options", self.options), ("reason", self.reason)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class HumanInputEvent:
    timestamp: str
    session_id: str
    agent_id: str
    input_id: str
    response: str | None = None
    duration_ms: float | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id,
             "type": "human_input", "input_id": self.input_id},
            [("response", self.response), ("duration_ms", self.duration_ms)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class HumanPauseEvent:
    timestamp: str
    session_id: str
    agent_id: str
    reason: str | None = None
    user_id: str | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id,
             "type": "human_pause"},
            [("reason", self.reason), ("user_id", self.user_id)],
            self.extra_fields,
        )


@dataclass(kw_only=True)
class HumanInterruptEvent:
    timestamp: str
    session_id: str
    agent_id: str
    reason: str | None = None
    user_id: str | None = None
    at_step: str | None = None
    extra_fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return _build(
            {"timestamp": self.timestamp, "session_id": self.session_id, "agent_id": self.agent_id,
             "type": "human_interrupt"},
            [("reason", self.reason), ("user_id", self.user_id), ("at_step", self.at_step)],
            self.extra_fields,
        )
