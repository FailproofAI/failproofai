/**
 * Authoring and worker primitives for FailproofAI Evaluator v2.
 *
 * A separate entry point on purpose: a process that only emits telemetry never
 * imports the evaluator's networking or sandbox machinery.
 *
 *     import { Evaluator, EvalResult, Score } from "@failproofai/sdk/evaluator";
 *
 *     const app = new Evaluator({ name: "my-evals", version: "1" });
 *
 *     app.eval("tool_success_rate", { version: "1" }, (session) => {
 *       const calls = session.count("tool_use");
 *       const failures = session
 *         .eventsOfType("tool_result")
 *         .filter((event) => event.payload.error != null).length;
 *       return new EvalResult({
 *         score: new Score(calls === 0 ? 1 : 1 - failures / calls),
 *       });
 *     });
 *
 *     await app.runFromEnv();
 */

export {
  Assertion,
  ConditionResult,
  EvalResult,
  Evaluator,
  Metric,
  Score,
  catalogDefinitionOf,
  validateKey,
} from "./authoring.js";
export type {
  CancellationFunction,
  ConditionFunction,
  EvalDefinition,
  EvalFunction,
  EvalOptions,
  EvalResultOptions,
  ManagedCompiler,
} from "./authoring.js";

export { EvaluatorAPIError, EvaluatorClient } from "./client.js";
export type { EvaluatorClientOptions } from "./client.js";

export {
  CLAIM_PATH,
  DEFINITIONS_PATH,
  DEFAULT_POLL_INTERVAL_SECONDS,
  ERROR_SPECS,
  EvaluatorKind,
  ExecutionMode,
  HEARTBEAT_INTERVAL_SECONDS,
  HEARTBEAT_PATH,
  LEASE_DURATION_SECONDS,
  LEASE_GENERATION_HEADER,
  MAX_ATTEMPTS,
  MAX_CATALOG_DEFINITIONS,
  MAX_CLAIM_CAPACITY,
  MAX_DESCRIPTION_BYTES,
  MAX_DISPLAY_NAME_BYTES,
  MAX_DISPLAY_VALUE_BYTES,
  MAX_ERROR_CODE_BYTES,
  MAX_ERROR_MESSAGE_BYTES,
  MAX_EVAL_KEY_BYTES,
  MAX_LABELS_PER_RESULT,
  MAX_LABEL_BYTES,
  MAX_REASONING_BYTES,
  MAX_RESULTS_PER_RUN,
  MAX_SUMMARY_BYTES,
  MAX_TRANSCRIPT_BYTES,
  MAX_UNIT_BYTES,
  MAX_VERSION_BYTES,
  MAX_WORKER_ID_BYTES,
  PLAN_PATH,
  PROTOCOL_VERSION,
  ProtocolError,
  REGISTER_PATH,
  RESULT_PATH,
  RESULT_SCHEMA_VERSION,
  ResultKind,
  TRANSCRIPT_PATH,
  TRANSCRIPT_SCHEMA_VERSION,
  TerminalRunStatus,
  UnsupportedProtocolVersion,
  WORKER_ID_HEADER,
  sessionTranscriptFromWire,
  validateProtocolVersion,
} from "./protocol.js";
export type {
  Assignment,
  AssignmentDefinition,
  CatalogDefinition,
  ClaimRequest,
  ClaimResponse,
  DefinitionsResponse,
  ErrorResponse,
  EvalSelection,
  HeartbeatRequest,
  HeartbeatResponse,
  HeartbeatRun,
  PlanRequest,
  PlanResponse,
  PlannedRun,
  RegisterRequest,
  RegisterResponse,
  RemoteError,
  ResultItem,
  ResultRequest,
  ResultResponse,
  SessionTranscript,
  SkippedEval,
  TranscriptEvent,
} from "./protocol.js";

export { DEFAULT_EVAL_TIMEOUT_SECONDS, WorkerRuntime, workerConfigFromEnv } from "./runtime.js";
export type { WorkerConfig } from "./runtime.js";

export {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  EvaluationSandboxUnavailable,
  EvaluationTimeout,
  MAX_CONCURRENT_SANDBOXES,
  MAX_CONDITION_SOURCE_BYTES,
  MAX_EVALUATOR_SOURCE_BYTES,
  MAX_SANDBOX_TIMEOUT_SECONDS,
  SANDBOX_GLOBAL_NAMES,
  SANDBOX_MAX_RESULT_BYTES,
  SANDBOX_MEMORY_MB,
  UnsafeEvaluatorSource,
  compileCondition,
  compileEvaluator,
  sourceChecksum,
} from "./source.js";

export {
  EvaluationBudgetExceeded,
  MAX_AST_NODES,
  MAX_CALL_DEPTH,
  MAX_POW_EXPONENT,
  MAX_STEPS,
  compileExpression,
} from "./expression.js";
