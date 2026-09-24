/**
 * Dependency-free wire models for the outbound Evaluator v2 protocol.
 *
 * Every `fromWire` is a VALIDATOR, not a cast. The server is the other side of
 * a network boundary: a field that arrives as a number where a string was
 * promised, or an enum value this SDK has never heard of, has to fail here with
 * a message naming the field — not three frames later as an undefined property
 * on an object nobody can explain.
 */

export const PROTOCOL_VERSION = "2";
export const TRANSCRIPT_SCHEMA_VERSION = "2";
export const RESULT_SCHEMA_VERSION = "2";

export const REGISTER_PATH = "/v1/evaluator/workers/register";
export const CLAIM_PATH = "/v1/evaluator/assignments/claim";
export const TRANSCRIPT_PATH = "/v1/evaluator/assignments/{assignment_id}/transcript";
export const DEFINITIONS_PATH = "/v1/evaluator/assignments/{assignment_id}/definitions";
export const PLAN_PATH = "/v1/evaluator/assignments/{assignment_id}/plan";
export const HEARTBEAT_PATH = "/v1/evaluator/runs/heartbeat";
export const RESULT_PATH = "/v1/evaluator/runs/{evaluation_run_id}/result";
export const WORKER_ID_HEADER = "X-FailproofAI-Worker-Id";
export const LEASE_GENERATION_HEADER = "X-FailproofAI-Lease-Generation";

export const HEARTBEAT_INTERVAL_SECONDS = 30;
export const LEASE_DURATION_SECONDS = 120;
/**
 * Fallback poll cadence if the register response omits `poll_interval_seconds`.
 * The worker prefers the server-advertised value; claims are normal short
 * polls, never long-polls, so this only bounds idle latency, not connection
 * lifetime.
 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 10;
export const MAX_ATTEMPTS = 5;

export const MAX_CATALOG_DEFINITIONS = 100;
export const MAX_CLAIM_CAPACITY = 32;
export const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024;
export const MAX_RESULTS_PER_RUN = 25;
export const MAX_EVAL_KEY_BYTES = 128;
export const MAX_DISPLAY_NAME_BYTES = 128;
export const MAX_VERSION_BYTES = 128;
export const MAX_WORKER_ID_BYTES = 128;
export const MAX_LABEL_BYTES = 64;
export const MAX_LABELS_PER_RESULT = 20;
export const MAX_SUMMARY_BYTES = 4 * 1024;
export const MAX_REASONING_BYTES = 16 * 1024;
export const MAX_UNIT_BYTES = 64;
export const MAX_DISPLAY_VALUE_BYTES = 256;
export const MAX_DESCRIPTION_BYTES = 1_000;
export const MAX_ERROR_CODE_BYTES = 64;
export const MAX_ERROR_MESSAGE_BYTES = 4 * 1024;

export const ERROR_SPECS: Readonly<Record<string, { httpStatus: number; retryable: boolean }>> = {
  invalid_credentials: { httpStatus: 401, retryable: false },
  instance_disabled: { httpStatus: 403, retryable: false },
  insufficient_permissions: { httpStatus: 403, retryable: false },
  assignment_not_found: { httpStatus: 404, retryable: false },
  run_not_found: { httpStatus: 404, retryable: false },
  catalog_mismatch: { httpStatus: 409, retryable: false },
  lease_lost: { httpStatus: 409, retryable: false },
  plan_conflict: { httpStatus: 409, retryable: false },
  submission_conflict: { httpStatus: 409, retryable: false },
  retry_budget_exhausted: { httpStatus: 409, retryable: false },
  transcript_too_large: { httpStatus: 413, retryable: false },
  invalid_request: { httpStatus: 422, retryable: false },
  invalid_catalog: { httpStatus: 422, retryable: false },
  incomplete_plan: { httpStatus: 422, retryable: false },
  unsupported_protocol_version: { httpStatus: 426, retryable: false },
  internal_error: { httpStatus: 500, retryable: true },
};

/** A local or remote evaluator protocol contract violation. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export class UnsupportedProtocolVersion extends ProtocolError {
  readonly received: string;
  constructor(received: string) {
    super(
      `unsupported evaluator protocol version ${JSON.stringify(received)}; ` +
        `supported major version is ${PROTOCOL_VERSION}`,
    );
    this.name = "UnsupportedProtocolVersion";
    this.received = received;
  }
}

export function validateProtocolVersion(version: string): void {
  if (version !== PROTOCOL_VERSION) throw new UnsupportedProtocolVersion(version);
}

export const EvaluatorKind = { MANAGED: "managed", CUSTOMER: "customer" } as const;
export type EvaluatorKind = (typeof EvaluatorKind)[keyof typeof EvaluatorKind];

export const ResultKind = { SCORE: "score", METRIC: "metric", ASSERTION: "assertion" } as const;
export type ResultKind = (typeof ResultKind)[keyof typeof ResultKind];

export const ExecutionMode = { LOCAL: "local", SANDBOX: "sandbox" } as const;
export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];

/**
 * The wire value for a server-authored definition is `"python"` — the name the
 * protocol was minted with, when the only worker was the Python SDK. It means
 * "the server authored this source and the worker must sandbox it", which this
 * SDK does in a `worker_threads` sandbox rather than a forked interpreter. The
 * wire string cannot change without a protocol bump, so the constant carries
 * the honest local name and this map carries the wire one.
 */
const EXECUTION_MODE_WIRE: Record<string, ExecutionMode> = {
  local: ExecutionMode.LOCAL,
  python: ExecutionMode.SANDBOX,
  sandbox: ExecutionMode.SANDBOX,
};
const EXECUTION_MODE_TO_WIRE: Record<ExecutionMode, string> = {
  local: "local",
  sandbox: "python",
};

export const TerminalRunStatus = {
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  CANCELLED: "cancelled",
} as const;
export type TerminalRunStatus = (typeof TerminalRunStatus)[keyof typeof TerminalRunStatus];

export type WireObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function str(data: WireObject, key: string): string {
  const value = data[key];
  if (typeof value !== "string") throw new ProtocolError(`${key} must be a string`);
  return value;
}

function int(data: WireObject, key: string): number {
  const value = data[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ProtocolError(`${key} must be an integer`);
  }
  return value;
}

function positiveInt(data: WireObject, key: string): number {
  const value = int(data, key);
  if (value <= 0) throw new ProtocolError(`${key} must be greater than zero`);
  return value;
}

function nonNegativeInt(data: WireObject, key: string): number {
  const value = int(data, key);
  if (value < 0) throw new ProtocolError(`${key} must not be negative`);
  return value;
}

function optionalString(data: WireObject, key: string): string | null {
  const value = data[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ProtocolError(`${key} must be a string or null`);
  return value;
}

function list(data: WireObject, key: string): unknown[] {
  const value = data[key];
  if (!Array.isArray(value)) throw new ProtocolError(`${key} must be an array`);
  return value;
}

function object(value: unknown, fieldName: string): WireObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${fieldName} must be an object`);
  }
  return value as WireObject;
}

function objectList(data: WireObject, key: string): WireObject[] {
  return list(data, key).map((value, index) => object(value, `${key}[${index}]`));
}

function stringList(data: WireObject, key: string): string[] {
  const values = list(data, key);
  values.forEach((value, index) => {
    if (typeof value !== "string") throw new ProtocolError(`${key}[${index}] must be a string`);
  });
  return values as string[];
}

function enumValue<T extends string>(
  allowed: readonly T[],
  data: WireObject,
  key: string,
): T {
  const value = str(data, key);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ProtocolError(
      `${key} must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}`,
    );
  }
  return value as T;
}

function executionMode(data: WireObject, key: string): ExecutionMode {
  // Required explicitly. Coercing a missing or unknown value to `local`
  // silently runs a server-authored definition down the customer-local path
  // (or vice-versa); a malformed wire value is a protocol error, not a default.
  const raw = str(data, key);
  const mode = EXECUTION_MODE_WIRE[raw];
  if (mode === undefined) {
    throw new ProtocolError(
      `${key} must be one of ${Object.keys(EXECUTION_MODE_WIRE)
        .map((item) => JSON.stringify(item))
        .join(", ")}`,
    );
  }
  return mode;
}

function optionalPositiveNumber(data: WireObject, key: string): number | null {
  const value = data[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") throw new ProtocolError(`${key} must be a number or null`);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ProtocolError(`${key} must be finite and greater than zero`);
  }
  return value;
}

function boolean_(data: WireObject, key: string, fallback?: boolean): boolean {
  const value = data[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "boolean") throw new ProtocolError(`${key} must be a boolean`);
  return value;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface CatalogDefinition {
  evalKey: string;
  displayName: string;
  evalVersion: string;
  resultKind: ResultKind;
  labels: readonly string[];
}

export function catalogDefinitionToWire(value: CatalogDefinition): WireObject {
  return {
    eval_key: value.evalKey,
    display_name: value.displayName,
    eval_version: value.evalVersion,
    result_kind: value.resultKind,
    labels: [...value.labels],
  };
}

export function catalogDefinitionFromWire(data: WireObject): CatalogDefinition {
  return {
    evalKey: str(data, "eval_key"),
    displayName: str(data, "display_name"),
    evalVersion: str(data, "eval_version"),
    resultKind: enumValue(Object.values(ResultKind), data, "result_kind"),
    labels: stringList(data, "labels"),
  };
}

export interface RegisterRequest {
  workerId: string;
  sdkVersion: string;
  catalogRevision: string;
  maxConcurrency: number;
  definitions: readonly CatalogDefinition[];
}

export function registerRequestToWire(value: RegisterRequest): WireObject {
  return {
    protocol_version: PROTOCOL_VERSION,
    worker_id: value.workerId,
    sdk_version: value.sdkVersion,
    catalog_revision: value.catalogRevision,
    max_concurrency: value.maxConcurrency,
    definitions: value.definitions.map(catalogDefinitionToWire),
  };
}

export interface RegisterResponse {
  evaluatorInstanceId: string;
  evaluatorKind: EvaluatorKind;
  heartbeatIntervalSeconds: number;
  leaseDurationSeconds: number;
  pollIntervalSeconds: number;
  claimLimit: number;
  disabledDefinitions: readonly string[];
}

export function registerResponseFromWire(data: WireObject): RegisterResponse {
  validateProtocolVersion(str(data, "protocol_version"));
  return {
    evaluatorInstanceId: str(data, "evaluator_instance_id"),
    evaluatorKind: enumValue(Object.values(EvaluatorKind), data, "evaluator_kind"),
    heartbeatIntervalSeconds: int(data, "heartbeat_interval_seconds"),
    leaseDurationSeconds: int(data, "lease_duration_seconds"),
    pollIntervalSeconds: int(data, "poll_interval_seconds"),
    claimLimit: int(data, "claim_limit"),
    disabledDefinitions: stringList(data, "disabled_definitions"),
  };
}

export interface ClaimRequest {
  workerId: string;
  catalogRevision: string;
  capacity: number;
}

export function claimRequestToWire(value: ClaimRequest): WireObject {
  return {
    protocol_version: PROTOCOL_VERSION,
    worker_id: value.workerId,
    catalog_revision: value.catalogRevision,
    capacity: value.capacity,
  };
}

export interface Assignment {
  assignmentId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  sessionId: string;
  sessionRevisionId: string;
  agentId: string;
  environment: string;
  triggerReason: string;
  eventCount: number;
  transcriptUrl: string;
  definitionsUrl: string;
}

export function assignmentFromWire(data: WireObject): Assignment {
  return {
    assignmentId: str(data, "assignment_id"),
    leaseGeneration: positiveInt(data, "lease_generation"),
    leaseExpiresAt: str(data, "lease_expires_at"),
    sessionId: str(data, "session_id"),
    sessionRevisionId: str(data, "session_revision_id"),
    agentId: str(data, "agent_id"),
    environment: str(data, "environment"),
    triggerReason: str(data, "trigger_reason"),
    eventCount: nonNegativeInt(data, "event_count"),
    transcriptUrl: str(data, "transcript_url"),
    definitionsUrl: typeof data.definitions_url === "string" ? data.definitions_url : "",
  };
}

export interface AssignmentDefinition {
  evalKey: string;
  displayName: string;
  evalVersion: string;
  resultKind: ResultKind;
  labels: readonly string[];
  executionMode: ExecutionMode;
  conditionSource: string | null;
  sourceChecksum: string | null;
  timeoutSeconds: number | null;
}

export function assignmentDefinitionFromWire(data: WireObject): AssignmentDefinition {
  return {
    evalKey: str(data, "eval_key"),
    displayName: str(data, "display_name"),
    evalVersion: str(data, "eval_version"),
    resultKind: enumValue(Object.values(ResultKind), data, "result_kind"),
    labels: stringList(data, "labels"),
    executionMode: executionMode(data, "execution_mode"),
    conditionSource: optionalString(data, "condition_source"),
    sourceChecksum: optionalString(data, "source_checksum"),
    timeoutSeconds: optionalPositiveNumber(data, "timeout_seconds"),
  };
}

export interface DefinitionsResponse {
  assignmentId: string;
  catalogRevision: string;
  definitions: readonly AssignmentDefinition[];
}

export function definitionsResponseFromWire(data: WireObject): DefinitionsResponse {
  validateProtocolVersion(str(data, "protocol_version"));
  return {
    assignmentId: str(data, "assignment_id"),
    catalogRevision: str(data, "catalog_revision"),
    definitions: objectList(data, "definitions").map(assignmentDefinitionFromWire),
  };
}

export interface ClaimResponse {
  assignments: readonly Assignment[];
}

export function claimResponseFromWire(data: WireObject): ClaimResponse {
  validateProtocolVersion(str(data, "protocol_version"));
  return { assignments: objectList(data, "assignments").map(assignmentFromWire) };
}

export interface TranscriptEvent {
  id: string;
  ts: string;
  eventType: string;
  payload: Readonly<WireObject>;
}

export function transcriptEventFromWire(data: WireObject): TranscriptEvent {
  return {
    id: str(data, "id"),
    ts: str(data, "ts"),
    eventType: str(data, "event_type"),
    payload: object(data.payload, "payload"),
  };
}

export interface SessionTranscript {
  assignmentId: string;
  sessionId: string;
  sessionRevisionId: string;
  agentId: string;
  environment: string;
  startedAt: string;
  endedAt: string;
  eventCount: number;
  events: readonly TranscriptEvent[];
  schemaVersion: string;
  eventsOfType(eventType: string): readonly TranscriptEvent[];
  count(eventType: string): number;
  toWire(): WireObject;
}

function makeTranscript(fields: Omit<SessionTranscript, "eventsOfType" | "count" | "toWire">): SessionTranscript {
  return {
    ...fields,
    eventsOfType(eventType: string) {
      return fields.events.filter((event) => event.eventType === eventType);
    },
    count(eventType: string) {
      return fields.events.reduce((total, event) => total + (event.eventType === eventType ? 1 : 0), 0);
    },
    toWire(): WireObject {
      return {
        schema_version: fields.schemaVersion,
        assignment_id: fields.assignmentId,
        session_id: fields.sessionId,
        session_revision_id: fields.sessionRevisionId,
        agent_id: fields.agentId,
        environment: fields.environment,
        started_at: fields.startedAt,
        ended_at: fields.endedAt,
        event_count: fields.eventCount,
        events: fields.events.map((event) => ({
          id: event.id,
          ts: event.ts,
          event_type: event.eventType,
          payload: event.payload,
        })),
      };
    },
  };
}

export function sessionTranscriptFromWire(data: WireObject): SessionTranscript {
  const version = str(data, "schema_version");
  if (version !== TRANSCRIPT_SCHEMA_VERSION) {
    throw new ProtocolError(`unsupported transcript schema version ${JSON.stringify(version)}`);
  }
  const events = objectList(data, "events").map(transcriptEventFromWire);
  const eventCount = nonNegativeInt(data, "event_count");
  if (eventCount !== events.length) {
    throw new ProtocolError(
      `event_count is ${eventCount}, but transcript contains ${events.length} events`,
    );
  }
  return makeTranscript({
    assignmentId: str(data, "assignment_id"),
    sessionId: str(data, "session_id"),
    sessionRevisionId: str(data, "session_revision_id"),
    agentId: str(data, "agent_id"),
    environment: str(data, "environment"),
    startedAt: str(data, "started_at"),
    endedAt: str(data, "ended_at"),
    eventCount,
    events,
    schemaVersion: version,
  });
}

/** Rebuild a transcript from `toWire()` — used across the sandbox boundary. */
export function sessionTranscriptFromWireLoose(data: WireObject): SessionTranscript {
  return sessionTranscriptFromWire(data);
}

export interface EvalSelection {
  evalKey: string;
  evalVersion: string;
}

export interface SkippedEval {
  evalKey: string;
  evalVersion: string;
  reasonCode: string;
}

export interface PlanRequest {
  workerId: string;
  leaseGeneration: number;
  selected: readonly EvalSelection[];
  skipped: readonly SkippedEval[];
}

export function planRequestToWire(value: PlanRequest): WireObject {
  return {
    protocol_version: PROTOCOL_VERSION,
    worker_id: value.workerId,
    lease_generation: value.leaseGeneration,
    selected: value.selected.map((item) => ({
      eval_key: item.evalKey,
      eval_version: item.evalVersion,
    })),
    skipped: value.skipped.map((item) => ({
      eval_key: item.evalKey,
      eval_version: item.evalVersion,
      reason_code: item.reasonCode,
    })),
  };
}

export interface PlannedRun {
  evaluationRunId: string;
  evalKey: string;
  evalVersion: string;
  executionMode: ExecutionMode;
  evaluatorSource: string | null;
  sourceChecksum: string | null;
  timeoutSeconds: number | null;
}

export function plannedRunFromWire(data: WireObject): PlannedRun {
  return {
    evaluationRunId: str(data, "evaluation_run_id"),
    evalKey: str(data, "eval_key"),
    evalVersion: str(data, "eval_version"),
    executionMode: executionMode(data, "execution_mode"),
    evaluatorSource: optionalString(data, "evaluator_source"),
    sourceChecksum: optionalString(data, "source_checksum"),
    timeoutSeconds: optionalPositiveNumber(data, "timeout_seconds"),
  };
}

export interface PlanResponse {
  assignmentId: string;
  assignmentStatus: string;
  runs: readonly PlannedRun[];
  idempotentReplay: boolean;
}

export function planResponseFromWire(data: WireObject): PlanResponse {
  validateProtocolVersion(str(data, "protocol_version"));
  return {
    assignmentId: str(data, "assignment_id"),
    assignmentStatus: str(data, "assignment_status"),
    runs: objectList(data, "runs").map(plannedRunFromWire),
    idempotentReplay: boolean_(data, "idempotent_replay", false),
  };
}

export interface HeartbeatRun {
  evaluationRunId: string;
  state: string;
  progress?: number | null;
}

export interface HeartbeatRequest {
  workerId: string;
  leaseGeneration: number;
  runs: readonly HeartbeatRun[];
}

export function heartbeatRequestToWire(value: HeartbeatRequest): WireObject {
  return {
    protocol_version: PROTOCOL_VERSION,
    worker_id: value.workerId,
    lease_generation: value.leaseGeneration,
    runs: value.runs.map((run) => ({
      evaluation_run_id: run.evaluationRunId,
      state: run.state,
      ...(run.progress === undefined || run.progress === null ? {} : { progress: run.progress }),
    })),
  };
}

export interface HeartbeatResponse {
  leaseExpiresAt: string;
  acceptedRunIds: readonly string[];
}

export function heartbeatResponseFromWire(data: WireObject): HeartbeatResponse {
  validateProtocolVersion(str(data, "protocol_version"));
  return {
    leaseExpiresAt: str(data, "lease_expires_at"),
    acceptedRunIds: stringList(data, "accepted_run_ids"),
  };
}

export interface ResultItem {
  resultKey: string;
  resultKind: ResultKind;
  numericValue?: number | null;
  boolValue?: boolean | null;
  textValue?: string | null;
  unit?: string;
  displayValue?: string | null;
  description?: string | null;
  reasoning?: string | null;
  labels?: readonly string[];
}

export function resultItemToWire(value: ResultItem): WireObject {
  return {
    result_key: value.resultKey,
    result_kind: value.resultKind,
    numeric_value: value.numericValue ?? null,
    bool_value: value.boolValue ?? null,
    text_value: value.textValue ?? null,
    unit: value.unit ?? "",
    display_value: value.displayValue ?? null,
    description: value.description ?? null,
    reasoning: value.reasoning ?? null,
    labels: [...(value.labels ?? [])],
  };
}

export function resultItemFromWire(data: WireObject): ResultItem {
  const numeric = data.numeric_value;
  if (numeric !== undefined && numeric !== null) {
    if (typeof numeric !== "number") throw new ProtocolError("numeric_value must be a number or null");
    if (!Number.isFinite(numeric)) throw new ProtocolError("numeric_value must be finite");
  }
  const boolean = data.bool_value;
  if (boolean !== undefined && boolean !== null && typeof boolean !== "boolean") {
    throw new ProtocolError("bool_value must be a boolean or null");
  }
  return {
    resultKey: str(data, "result_key"),
    resultKind: enumValue(Object.values(ResultKind), data, "result_kind"),
    numericValue: (numeric) ?? null,
    boolValue: (boolean) ?? null,
    textValue: optionalString(data, "text_value"),
    unit: str(data, "unit"),
    displayValue: optionalString(data, "display_value"),
    description: optionalString(data, "description"),
    reasoning: optionalString(data, "reasoning"),
    labels: stringList(data, "labels"),
  };
}

export interface ResultRequest {
  submissionId: string;
  workerId: string;
  leaseGeneration: number;
  status: TerminalRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: string | null;
  results: readonly ResultItem[];
  errorCode: string | null;
  errorMessage: string | null;
}

export function resultRequestToWire(value: ResultRequest): WireObject {
  return {
    protocol_version: PROTOCOL_VERSION,
    result_schema_version: RESULT_SCHEMA_VERSION,
    submission_id: value.submissionId,
    worker_id: value.workerId,
    lease_generation: value.leaseGeneration,
    status: value.status,
    started_at: value.startedAt,
    finished_at: value.finishedAt,
    duration_ms: value.durationMs,
    summary: value.summary,
    results: value.results.map(resultItemToWire),
    error_code: value.errorCode,
    error_message: value.errorMessage,
  };
}

export interface ResultResponse {
  evaluationRunId: string;
  submissionId: string;
  status: string;
  idempotentReplay: boolean;
  resultCount: number;
  resultChecksum: string;
}

export function resultResponseFromWire(data: WireObject): ResultResponse {
  validateProtocolVersion(str(data, "protocol_version"));
  return {
    evaluationRunId: str(data, "evaluation_run_id"),
    submissionId: str(data, "submission_id"),
    status: str(data, "status"),
    idempotentReplay: boolean_(data, "idempotent_replay"),
    resultCount: nonNegativeInt(data, "result_count"),
    resultChecksum: str(data, "result_checksum"),
  };
}

export interface RemoteError {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string;
}

export interface ErrorResponse {
  error: RemoteError;
}

export function errorResponseFromWire(data: WireObject): ErrorResponse {
  validateProtocolVersion(str(data, "protocol_version"));
  const error = object(data.error, "error");
  return {
    error: {
      code: str(error, "code"),
      message: str(error, "message"),
      retryable: boolean_(error, "retryable"),
      requestId: str(error, "request_id"),
    },
  };
}

export { EXECUTION_MODE_TO_WIRE };
