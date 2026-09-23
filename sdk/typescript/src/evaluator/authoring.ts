/**
 * Evaluator definition registry and typed author results.
 *
 * Every bound checked here is a bound the SERVER also checks, and rejects with
 * a NON-RETRYABLE 422. Checking them at authoring time is what turns "a
 * successful evaluation silently dead-lettered in production" into an error at
 * the line that wrote it.
 */

import { createHash } from "node:crypto";

import {
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
  ResultKind,
  catalogDefinitionToWire,
} from "./protocol.js";
import type { CatalogDefinition, ResultItem, SessionTranscript } from "./protocol.js";

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export type EvalFunction = (session: SessionTranscript) => EvalResult | Promise<EvalResult>;
export type ConditionFunction = (
  session: SessionTranscript,
) => boolean | ConditionResult | Promise<boolean | ConditionResult>;
export type CancellationFunction = (session: SessionTranscript) => unknown;

/**
 * Compiles server-authored (sandboxed) source into something callable with a
 * session. Signature mirrors `source.compileEvaluator`, which is the default.
 *
 * A host that serves managed definitions whose source is NOT a restricted
 * expression — a declarative judge document, say — installs its own compiler
 * here. The SDK stays agnostic: it never inspects the source, it just hands it
 * to whoever compiles. Returning an async function is supported and is the
 * right shape for a compiler whose work is IO-bound.
 */
export type ManagedCompiler = (
  source: string,
  options: { timeoutSeconds?: number | null; evalKey?: string | null },
) => EvalFunction;

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function bounded(value: unknown, fieldName: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${fieldName} must be a string`);
  if (value === "") throw new Error(`${fieldName} must not be empty`);
  const size = utf8Length(value);
  if (size > maximum) throw new Error(`${fieldName} is ${size} bytes; maximum is ${maximum}`);
  // Reject C0 control characters and DEL, matching the server's own check.
  // Without this the SDK accepts a string — reasoning or a summary quoting
  // transcript text that contains an ANSI escape or a NUL — that the server
  // then rejects with a NON-RETRYABLE 422, so a successful evaluation is
  // silently lost and its assignment dead-letters. TAB, LF and CR are kept
  // because real multi-line reasoning uses them.
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if ((code < 0x20 && char !== "\t" && char !== "\n" && char !== "\r") || code === 0x7f) {
      throw new Error(
        `${fieldName} must not contain control characters (found U+${code
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")})`,
      );
    }
  }
  return value;
}

function finite(value: unknown, fieldName: string): number {
  if (typeof value !== "number") throw new TypeError(`${fieldName} must be a number`);
  if (!Number.isFinite(value)) throw new Error(`${fieldName} must be finite`);
  return value;
}

function normalizeLabels(values: readonly string[]): string[] {
  if (values.length > MAX_LABELS_PER_RESULT) {
    throw new Error(`at most ${MAX_LABELS_PER_RESULT} labels are allowed`);
  }
  const normalized = values.map((label) => bounded(label, "label", MAX_LABEL_BYTES));
  if (new Set(normalized).size !== normalized.length) throw new Error("labels must be unique");
  return [...normalized].sort();
}

function validateResultText(
  unit: string,
  displayValue: string | undefined,
  description: string | undefined,
): void {
  if (unit) bounded(unit, "unit", MAX_UNIT_BYTES);
  if (displayValue !== undefined) bounded(displayValue, "display value", MAX_DISPLAY_VALUE_BYTES);
  if (description !== undefined) bounded(description, "description", MAX_DESCRIPTION_BYTES);
}

export function validateKey(value: string, fieldName = "eval_key"): string {
  bounded(value, fieldName, MAX_EVAL_KEY_BYTES);
  if (!KEY_PATTERN.test(value)) throw new Error(`${fieldName} must match ${KEY_PATTERN.source}`);
  return value;
}

export class Score {
  readonly value: number;
  readonly passed: boolean | undefined;
  readonly unit: string;
  readonly displayValue: string | undefined;
  readonly description: string | undefined;

  constructor(
    value: number,
    options: {
      passed?: boolean;
      unit?: string;
      displayValue?: string;
      description?: string;
    } = {},
  ) {
    const numeric = finite(value, "score value");
    if (numeric < 0 || numeric > 1) throw new Error("score value must be between 0 and 1");
    if (options.passed !== undefined && typeof options.passed !== "boolean") {
      throw new TypeError("score passed must be a boolean or undefined");
    }
    this.value = numeric;
    this.passed = options.passed;
    this.unit = options.unit ?? "ratio";
    this.displayValue = options.displayValue;
    this.description = options.description;
    validateResultText(this.unit, this.displayValue, this.description);
    Object.freeze(this);
  }
}

export class Metric {
  readonly value: number;
  readonly unit: string;
  readonly displayValue: string | undefined;
  readonly description: string | undefined;

  constructor(
    value: number,
    options: { unit?: string; displayValue?: string; description?: string } = {},
  ) {
    this.value = finite(value, "metric value");
    this.unit = options.unit ?? "";
    this.displayValue = options.displayValue;
    this.description = options.description;
    validateResultText(this.unit, this.displayValue, this.description);
    Object.freeze(this);
  }
}

export class Assertion {
  readonly passed: boolean;
  readonly description: string | undefined;

  constructor(passed: boolean, options: { description?: string } = {}) {
    if (typeof passed !== "boolean") throw new TypeError("assertion passed must be a boolean");
    this.passed = passed;
    this.description = options.description;
    if (this.description !== undefined) {
      bounded(this.description, "description", MAX_DESCRIPTION_BYTES);
    }
    Object.freeze(this);
  }
}

export class ConditionResult {
  readonly applicable: boolean;
  readonly reasonCode: string;

  constructor(applicable: boolean, reasonCode = "condition_false") {
    if (typeof applicable !== "boolean") {
      throw new TypeError("condition applicable must be a boolean");
    }
    this.applicable = applicable;
    this.reasonCode = reasonCode;
    validateKey(reasonCode, "condition reason code");
    Object.freeze(this);
  }
}

export interface EvalResultOptions {
  score?: Score;
  metrics?: Record<string, Metric | number>;
  assertions?: Record<string, Assertion | boolean>;
  reasoning?: string;
  summary?: string;
  labels?: readonly string[];
}

export class EvalResult {
  readonly score: Score | undefined;
  readonly metrics: Readonly<Record<string, Metric | number>>;
  readonly assertions: Readonly<Record<string, Assertion | boolean>>;
  readonly reasoning: string | undefined;
  readonly summary: string | undefined;
  readonly labels: readonly string[];

  constructor(options: EvalResultOptions = {}) {
    this.score = options.score;
    this.metrics = options.metrics ?? {};
    this.assertions = options.assertions ?? {};
    this.reasoning = options.reasoning;
    this.summary = options.summary;
    if (this.reasoning !== undefined) bounded(this.reasoning, "reasoning", MAX_REASONING_BYTES);
    if (this.summary !== undefined) bounded(this.summary, "summary", MAX_SUMMARY_BYTES);
    this.labels = normalizeLabels(options.labels ?? []);
    Object.freeze(this);
  }

  resultItems(evalKey: string): ResultItem[] {
    const items: ResultItem[] = [];
    if (this.score !== undefined) {
      items.push({
        resultKey: evalKey,
        resultKind: ResultKind.SCORE,
        numericValue: this.score.value,
        boolValue: this.score.passed ?? null,
        unit: this.score.unit,
        displayValue: this.score.displayValue ?? null,
        description: this.score.description ?? null,
        reasoning: this.reasoning ?? null,
        labels: this.labels,
      });
    }
    for (const key of Object.keys(this.metrics).sort()) {
      validateKey(key, "metric key");
      const raw = this.metrics[key]!;
      const metric = raw instanceof Metric ? raw : new Metric(raw);
      items.push({
        resultKey: key,
        resultKind: ResultKind.METRIC,
        numericValue: metric.value,
        unit: metric.unit,
        displayValue: metric.displayValue ?? null,
        description: metric.description ?? null,
        // A metric-kind eval's primary result IS the metric whose key equals
        // `evalKey`; attach the eval's reasoning there so it is not silently
        // dropped for non-score evals.
        reasoning: key === evalKey ? (this.reasoning ?? null) : null,
        labels: this.labels,
      });
    }
    for (const key of Object.keys(this.assertions).sort()) {
      validateKey(key, "assertion key");
      const raw = this.assertions[key]!;
      const assertion = raw instanceof Assertion ? raw : new Assertion(raw);
      items.push({
        resultKey: key,
        resultKind: ResultKind.ASSERTION,
        boolValue: assertion.passed,
        description: assertion.description ?? null,
        reasoning: key === evalKey ? (this.reasoning ?? null) : null,
        labels: this.labels,
      });
    }
    if (items.length === 0) {
      throw new Error("an EvalResult must contain a score, metric, or assertion");
    }
    if (items.length > MAX_RESULTS_PER_RUN) {
      throw new Error(`an EvalResult may contain at most ${MAX_RESULTS_PER_RUN} results`);
    }
    const keys = items.map((item) => item.resultKey);
    if (new Set(keys).size !== keys.length) {
      throw new Error("result keys must be unique within one evaluation run");
    }
    return items;
  }
}

export interface EvalDefinition {
  evalKey: string;
  displayName: string;
  evalVersion: string;
  resultKind: ResultKind;
  labels: readonly string[];
  function: EvalFunction;
  condition: ConditionFunction | null;
  onCancel: CancellationFunction | null;
  timeoutSeconds: number | null;
}

export function catalogDefinitionOf(definition: EvalDefinition): CatalogDefinition {
  return {
    evalKey: definition.evalKey,
    displayName: definition.displayName,
    evalVersion: definition.evalVersion,
    resultKind: definition.resultKind,
    labels: definition.labels,
  };
}

/** Deterministic JSON with sorted keys and no spaces, for the catalog hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export interface EvalOptions {
  version: string;
  displayName?: string;
  resultKind?: ResultKind;
  labels?: readonly string[];
  when?: ConditionFunction;
  onCancel?: CancellationFunction;
  timeoutSeconds?: number;
}

/**
 * Marks an `Evaluator` across the package's two builds.
 *
 * `failproofai-evaluator` is the ESM build, and a CommonJS evals file (plain
 * `tsc` output, `require`) constructs its `Evaluator` from `dist/cjs` — a
 * second, unrelated copy of the class. `instanceof` is false across the two, so
 * the loader refused the commonest setup there is with "resolved to Evaluator,
 * not an Evaluator". `Symbol.for` is one registry per process, so both copies
 * stamp and read the same key.
 */
const EVALUATOR_BRAND = Symbol.for("@failproofai/sdk/evaluator.Evaluator");

/**
 * True for an `Evaluator` from either build of this package.
 *
 * Safe to hand the result to `runFromEnv()`: that method belongs to the copy
 * that built the object, and runs the runtime from that same copy, so the
 * result classes it checks are the ones the evaluations construct.
 *
 * @internal
 */
export function isEvaluator(value: unknown): value is Evaluator {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[EVALUATOR_BRAND] === true &&
    typeof (value as { runFromEnv?: unknown }).runFromEnv === "function"
  );
}

/** A process-local collection of explicitly versioned evaluations. */
export class Evaluator {
  declare readonly [EVALUATOR_BRAND]: true;
  readonly name: string;
  readonly version: string;
  readonly managedCompiler: ManagedCompiler | null;
  private readonly registry = new Map<string, EvalDefinition>();

  constructor(options: { name: string; version: string; managedCompiler?: ManagedCompiler }) {
    Object.defineProperty(this, EVALUATOR_BRAND, { value: true });
    this.name = bounded(options.name, "name", MAX_DISPLAY_NAME_BYTES);
    this.version = bounded(options.version, "version", MAX_VERSION_BYTES);
    // Omitted keeps the default: server-authored source is compiled and
    // sandboxed by `source.compileEvaluator`. Customer workers never set this —
    // their definitions are LOCAL and never carry source at all.
    if (options.managedCompiler !== undefined && typeof options.managedCompiler !== "function") {
      throw new TypeError("managedCompiler must be a function");
    }
    this.managedCompiler = options.managedCompiler ?? null;
  }

  /**
   * Register one evaluation.
   *
   *     evaluator.eval("tool_success_rate", { version: "1" }, (session) =>
   *       new EvalResult({ score: new Score(ratio) }),
   *     );
   */
  eval(evalKey: string, options: EvalOptions, fn: EvalFunction): EvalFunction {
    const key = validateKey(evalKey);
    const evalVersion = bounded(options.version, "eval version", MAX_VERSION_BYTES);
    const display = bounded(
      options.displayName ?? defaultDisplayName(evalKey),
      "display name",
      MAX_DISPLAY_NAME_BYTES,
    );
    const kind = options.resultKind ?? ResultKind.SCORE;
    if (!Object.values(ResultKind).includes(kind)) {
      throw new Error(`resultKind must be one of ${Object.values(ResultKind).join(", ")}`);
    }
    const labels = normalizeLabels(options.labels ?? []);
    let timeoutSeconds: number | null = null;
    if (options.timeoutSeconds !== undefined) {
      timeoutSeconds = finite(options.timeoutSeconds, "timeoutSeconds");
      if (timeoutSeconds <= 0) throw new Error("timeoutSeconds must be greater than zero");
    }

    if (this.registry.has(key)) throw new Error(`duplicate eval key: ${key}`);
    if (this.registry.size >= MAX_CATALOG_DEFINITIONS) {
      throw new Error(
        `an evaluator may define at most ${MAX_CATALOG_DEFINITIONS} evaluations`,
      );
    }
    if (typeof fn !== "function") throw new TypeError("evaluation must be a function");
    if (options.when !== undefined && typeof options.when !== "function") {
      throw new TypeError("when must be a function");
    }
    if (options.onCancel !== undefined && typeof options.onCancel !== "function") {
      throw new TypeError("onCancel must be a function");
    }

    this.registry.set(key, {
      evalKey: key,
      displayName: display,
      evalVersion,
      resultKind: kind,
      labels,
      function: fn,
      condition: options.when ?? null,
      onCancel: options.onCancel ?? null,
      timeoutSeconds,
    });
    return fn;
  }

  get definitions(): readonly EvalDefinition[] {
    return [...this.registry.keys()].sort().map((key) => this.registry.get(key)!);
  }

  catalog(): CatalogDefinition[] {
    return this.definitions.map(catalogDefinitionOf);
  }

  get catalogRevision(): string {
    const payload = this.catalog().map(catalogDefinitionToWire);
    const canonical = Buffer.from(canonicalJson(payload), "utf8");
    return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  }

  definition(evalKey: string): EvalDefinition {
    const found = this.registry.get(evalKey);
    if (found === undefined) throw new Error(`unknown eval key: ${evalKey}`);
    return found;
  }

  /** Run this evaluator until the process receives a stop request. */
  async runFromEnv(): Promise<void> {
    const { WorkerRuntime, workerConfigFromEnv } = await import("./runtime.js");
    const runtime = new WorkerRuntime(this, workerConfigFromEnv());
    const stop = (): void => {
      runtime.stop();
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, stop);
    }
    try {
      await runtime.runForever();
    } finally {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.removeListener(signal, stop);
      }
    }
  }

  /** Call an evaluation or condition, awaiting it when it returns a promise. */
  static async call(
    fn: EvalFunction | ConditionFunction,
    session: SessionTranscript,
  ): Promise<unknown> {
    return await (fn as (s: SessionTranscript) => unknown)(session);
  }
}

function defaultDisplayName(evalKey: string): string {
  const spaced = evalKey.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
