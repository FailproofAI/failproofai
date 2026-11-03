/**
 * One builder per event type. `toDict()` IS the wire format.
 *
 * Frozen byte-for-byte by `test/wire-format.test.ts`, and kept in lockstep with
 * `failproofai_sdk/_schema.py`: the two SDKs write into the same spool
 * directories and the same ingest endpoint, so a field that differs between
 * them is a field the dashboard renders for one language and not the other.
 *
 * KEY ORDER IS PART OF THE FORMAT. JavaScript preserves insertion order for
 * string keys, so the order below is the order on the wire, and it matches
 * Python's `_build`: the base identity block, then `environment`, then the
 * declared optionals that were supplied, then the caller's extras.
 */

import { getEnvironment } from "./environment.js";

export type JsonValue = unknown;
export type ExtraFields = Record<string, unknown>;

/**
 * Build an ordered event object, omitting absent optionals, then merge extras.
 *
 * `extra` is merged LAST and verbatim — which is why `events.ts` refuses a
 * reserved name and why `integrations/core.ts` namespaces everything `fw_*`.
 * An extra called `tool_name` would otherwise overwrite the declared one and
 * silently change a promoted column.
 */
function build(
  base: Record<string, unknown>,
  specifics: ReadonlyArray<readonly [string, unknown]>,
  extra: ExtraFields,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  result.environment = getEnvironment();
  for (const [key, value] of specifics) {
    if (value !== undefined && value !== null) result[key] = value;
  }
  return Object.assign(result, extra);
}

interface Identity {
  timestamp: string;
  sessionId: string;
  agentId: string;
}

function identityBlock(
  { timestamp, sessionId, agentId }: Identity,
  type: string,
  required: Record<string, unknown> = {},
): Record<string, unknown> {
  return { timestamp, session_id: sessionId, agent_id: agentId, type, ...required };
}

export interface ToolUseEvent extends Identity {
  toolName: string;
  toolCallId: string;
  input?: Record<string, unknown> | null;
  extraFields?: ExtraFields;
}

export function toolUseEvent(event: ToolUseEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "tool_use", {
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
    }),
    [["input", event.input]],
    event.extraFields ?? {},
  );
}

export interface ToolResultEvent extends Identity {
  toolName: string;
  toolCallId: string;
  output?: unknown;
  error?: string | null;
  durationMs?: number | null;
  extraFields?: ExtraFields;
}

export function toolResultEvent(event: ToolResultEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "tool_result", {
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
    }),
    [
      ["output", event.output],
      ["error", event.error],
      ["duration_ms", event.durationMs],
    ],
    event.extraFields ?? {},
  );
}

export interface ModelRequestEvent extends Identity {
  model?: string | null;
  messages?: Array<Record<string, unknown>> | null;
  system?: unknown;
  tools?: Array<Record<string, unknown>> | null;
  /**
   * Pairs this request with its response. Appended LAST in the ordered list so
   * an event that omits it serialises byte-for-byte as before —
   * `wire-format.test.ts` freezes those bytes, and the dedup key hashes them.
   */
  requestId?: string | null;
  extraFields?: ExtraFields;
}

export function modelRequestEvent(event: ModelRequestEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "model_request"),
    [
      ["model", event.model],
      ["messages", event.messages],
      ["system", event.system],
      ["tools", event.tools],
      ["request_id", event.requestId],
    ],
    event.extraFields ?? {},
  );
}

export interface ModelResponseEvent extends Identity {
  model?: string | null;
  stopReason?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  content?: unknown;
  role?: string | null;
  /** The `requestId` of the `model_request` this answers. See above. */
  requestId?: string | null;
  extraFields?: ExtraFields;
}

export function modelResponseEvent(event: ModelResponseEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "model_response"),
    [
      ["model", event.model],
      ["stop_reason", event.stopReason],
      ["input_tokens", event.inputTokens],
      ["output_tokens", event.outputTokens],
      ["content", event.content],
      ["role", event.role],
      ["request_id", event.requestId],
    ],
    event.extraFields ?? {},
  );
}

export interface AgentStartEvent extends Identity {
  goal?: string | null;
  parentId?: string | null;
  extraFields?: ExtraFields;
}

export function agentStartEvent(event: AgentStartEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "agent_start"),
    [
      ["goal", event.goal],
      ["parent_id", event.parentId],
    ],
    event.extraFields ?? {},
  );
}

export interface AgentEndEvent extends Identity {
  outcome?: string | null;
  summary?: string | null;
  extraFields?: ExtraFields;
}

export function agentEndEvent(event: AgentEndEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "agent_end"),
    [
      ["outcome", event.outcome],
      ["summary", event.summary],
    ],
    event.extraFields ?? {},
  );
}

export interface AgentPauseEvent extends Identity {
  pauseId: string;
  reason?: string | null;
  userId?: string | null;
  extraFields?: ExtraFields;
}

export function agentPauseEvent(event: AgentPauseEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "agent_pause", { pause_id: event.pauseId }),
    [
      ["reason", event.reason],
      ["user_id", event.userId],
    ],
    event.extraFields ?? {},
  );
}

export interface AgentResumeEvent extends Identity {
  pauseId: string;
  durationMs?: number | null;
  reason?: string | null;
  userId?: string | null;
  extraFields?: ExtraFields;
}

export function agentResumeEvent(event: AgentResumeEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "agent_resume", { pause_id: event.pauseId }),
    [
      ["duration_ms", event.durationMs],
      ["reason", event.reason],
      ["user_id", event.userId],
    ],
    event.extraFields ?? {},
  );
}

export interface HookTriggeredEvent extends Identity {
  hookName: string;
  hookId: string;
  triggerEvent?: string | null;
  input?: unknown;
  extraFields?: ExtraFields;
}

export function hookTriggeredEvent(event: HookTriggeredEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "hook_triggered", {
      hook_name: event.hookName,
      hook_id: event.hookId,
    }),
    [
      ["trigger_event", event.triggerEvent],
      ["input", event.input],
    ],
    event.extraFields ?? {},
  );
}

export interface HookCompletedEvent extends Identity {
  hookName: string;
  hookId: string;
  outcome?: string | null;
  output?: unknown;
  error?: string | null;
  durationMs?: number | null;
  extraFields?: ExtraFields;
}

export function hookCompletedEvent(event: HookCompletedEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "hook_completed", {
      hook_name: event.hookName,
      hook_id: event.hookId,
    }),
    [
      ["outcome", event.outcome],
      ["output", event.output],
      ["error", event.error],
      ["duration_ms", event.durationMs],
    ],
    event.extraFields ?? {},
  );
}

export interface ErrorEvent extends Identity {
  errorType: string;
  message: string;
  traceback?: string | null;
  extraFields?: ExtraFields;
}

export function errorEvent(event: ErrorEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "error", {
      error_type: event.errorType,
      message: event.message,
    }),
    [["traceback", event.traceback]],
    event.extraFields ?? {},
  );
}

export interface HumanWaitEvent extends Identity {
  inputId: string;
  prompt?: string | null;
  options?: string[] | null;
  reason?: string | null;
  extraFields?: ExtraFields;
}

export function humanWaitEvent(event: HumanWaitEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "human_wait", { input_id: event.inputId }),
    [
      ["prompt", event.prompt],
      ["options", event.options],
      ["reason", event.reason],
    ],
    event.extraFields ?? {},
  );
}

export interface HumanInputEvent extends Identity {
  inputId: string;
  response?: string | null;
  durationMs?: number | null;
  extraFields?: ExtraFields;
}

export function humanInputEvent(event: HumanInputEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "human_input", { input_id: event.inputId }),
    [
      ["response", event.response],
      ["duration_ms", event.durationMs],
    ],
    event.extraFields ?? {},
  );
}

export interface HumanPauseEvent extends Identity {
  reason?: string | null;
  userId?: string | null;
  extraFields?: ExtraFields;
}

export function humanPauseEvent(event: HumanPauseEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "human_pause"),
    [
      ["reason", event.reason],
      ["user_id", event.userId],
    ],
    event.extraFields ?? {},
  );
}

export interface HumanInterruptEvent extends Identity {
  reason?: string | null;
  userId?: string | null;
  atStep?: string | null;
  extraFields?: ExtraFields;
}

export function humanInterruptEvent(event: HumanInterruptEvent): Record<string, unknown> {
  return build(
    identityBlock(event, "human_interrupt"),
    [
      ["reason", event.reason],
      ["user_id", event.userId],
      ["at_step", event.atStep],
    ],
    event.extraFields ?? {},
  );
}

/**
 * Every field name any event builder above declares, plus the wire names of the
 * identity block. `integrations/core.ts` derives its forbidden-extras set from
 * this so that adding a field here cannot leave a stale copy there.
 */
export const DECLARED_FIELD_NAMES: ReadonlySet<string> = new Set([
  "timestamp",
  "session_id",
  "agent_id",
  "type",
  "environment",
  "tool_name",
  "tool_call_id",
  "input",
  "output",
  "error",
  "duration_ms",
  "model",
  "messages",
  "system",
  "tools",
  "request_id",
  "stop_reason",
  "input_tokens",
  "output_tokens",
  "content",
  "role",
  "goal",
  "parent_id",
  "outcome",
  "summary",
  "pause_id",
  "reason",
  "user_id",
  "hook_name",
  "hook_id",
  "trigger_event",
  "error_type",
  "message",
  "traceback",
  "input_id",
  "prompt",
  "options",
  "response",
  "at_step",
]);
