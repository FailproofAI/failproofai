/**
 * The Jev (two-tier evaluator) fields of a hook activity row: their allowed
 * shapes, the one normaliser every writer and shipper goes through, and a
 * plain-language summary for the dashboard.
 *
 * WHY A NORMALISER AT ALL. These fields leave the machine: the collector ships
 * them to FailproofAI Cloud (`crates/fpai-collect/src/sources/hooks/transform.rs`)
 * and a few ride PostHog (`hook-telemetry.ts`). The rule for everything shipped
 * from a hook row is "decisions and tool names, never file contents", and most
 * of these fields are closed sets that cannot break it. `jevFallbackReason` is
 * the exception: the evaluator's degraded reasons include free text
 * (`prepare: <error message>`, `error: <message>`), and an error message is
 * exactly where a fragment of the judged command or the human's prompt can end
 * up. So a reason is reduced to one of a closed list of CODES before it is
 * stored ({@link JEV_REASON_CODES}), and anything else becomes `other` — even a
 * short kebab-case word, which could be the command's own first word. The Rust
 * side applies the same rule again, for rows written by some other build.
 *
 * WHAT THE VALIDATORS DO NOT COVER. `jevCleared` and `jevModel` are checked for
 * shape only (no whitespace or control characters; a model-id alphabet). That
 * keeps a sentence, a command line or a prompt out, but a whitespace-free
 * fragment — a path, a file name — has the same shape as a policy name or a
 * model id and would pass. Those two fields rely on the writer supplying
 * registered policy names and the provider's model id, which is what the
 * combine rules write.
 *
 * WHAT `evaluator: "jev"` MEANS. The two-tier path ran for this call. It does
 * NOT by itself mean Jev answered: when a hard policy denies, the combine rules
 * abort Jev and record `{ evaluator: "jev", jevMode }` and nothing else. So
 * every reader classifies a row with {@link jevOutcome} — answered, fell back,
 * or not consulted — rather than reading `evaluator` alone.
 *
 * Pure on purpose — no node imports — so the client dashboard can use
 * {@link describeJevActivity} without pulling `node:fs` into a browser bundle.
 */
import type { HookActivityEntry } from "./hook-activity-store";

export type JevActivityFields = Pick<
  HookActivityEntry,
  "evaluator" | "jevDecision" | "jevCleared" | "jevFallbackReason" | "jevLatencyMs" | "jevModel" | "jevMode"
>;

/** Every Jev key on an activity row, in the order they are documented. */
export const JEV_ACTIVITY_KEYS = [
  "evaluator",
  "jevDecision",
  "jevCleared",
  "jevFallbackReason",
  "jevLatencyMs",
  "jevModel",
  "jevMode",
] as const satisfies ReadonlyArray<keyof JevActivityFields>;

const EVALUATORS = new Set(["jev", "jev-fallback"]);
const DECISIONS = new Set(["allow", "instruct", "deny"]);
const MODES = new Set(["shadow", "enforce"]);

/**
 * A reason's leading code — lowercase kebab-case — either alone or followed by
 * `:` / `(` and free text: `timeout`, `http-429`, `prepare: <message>`.
 */
const REASON_HEAD_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\s*(?:$|[:(])/;
const HTTP_CODE_RE = /^http-\d{3}$/;
export const JEV_REASON_MAX_CHARS = 40;
/** What a reason that is not a known code is stored as. */
export const JEV_REASON_OTHER = "other";

/**
 * Every fallback reason code a row may carry, besides `http-NNN`. The codes the
 * Jev client, the evaluator, the throttle and the combine rules produce; any
 * other reason is stored as `other`. A code added to a producer must be added
 * here AND to `JEV_REASON_CODES` in the collector's `transform.rs` (a test
 * keeps the two identical), or it ships as `other` — safe, but less useful.
 */
export const JEV_REASON_CODES: ReadonlySet<string> = new Set<string>([
  "aborted",
  "cloudflare-error",
  "cloudflare-incomplete",
  "config",
  "error",
  "malformed",
  "model-mismatch",
  "network",
  "no-api-key",
  "no-transport",
  "other",
  "out-of-credits",
  "prepare-error",
  "rate-limited",
  "request-too-large",
  "timeout",
  "truncated",
  "upstream-error",
]);

/**
 * Leading words that are renamed on the way in: the evaluator's free-text
 * prefixes, each mapped to its code. `prepare` is the one that differs — the
 * evaluator writes `prepare: <message>`, and the combine rules cut that down
 * to a bare `prepare` — and both are stored as `prepare-error`, so one failure
 * never shows up under two names. `FREE_TEXT_PREFIXES` in the collector's
 * `transform.rs` is the same list; a test keeps the two identical.
 */
export const JEV_FREE_TEXT_PREFIXES: ReadonlyMap<string, string> = new Map<string, string>([
  ["prepare", "prepare-error"],
  ["error", "error"],
  ["timeout", "timeout"],
  ["network", "network"],
  ["malformed", "malformed"],
  ["truncated", "truncated"],
  ["rate-limited", "rate-limited"],
  ["out-of-credits", "out-of-credits"],
  ["model-mismatch", "model-mismatch"],
  ["request-too-large", "request-too-large"],
  ["config", "config"],
]);

/** Model ids: `jev-1.13.0`, `typesafe/jev-1.13-20260917`, `typesafe-ai/jev`, `~typesafe/jev-latest`. */
const MODEL_RE = /^[A-Za-z0-9~][A-Za-z0-9._/:@~+-]{0,99}$/;
/** Policy names never contain whitespace or control characters; `pack/<id>@<v>/<name>` is the longest shape. */
const POLICY_NAME_RE = /^[^\s\u0000-\u001f\u007f]{1,200}$/;
export const JEV_CLEARED_MAX = 64;

/**
 * Reduce a fallback reason to a known code, or undefined when there is none.
 *
 * - A known code (`timeout`, `http-429`, `model-mismatch`), alone or in front
 *   of free text (`prepare: Unexpected token…`, `http-500: upstream said …`):
 *   that code, lowercased, renamed through {@link JEV_FREE_TEXT_PREFIXES}.
 * - Anything else: `other`. Never the text — not even a short kebab-case word
 *   that merely looks like a code (`curl`, `secret-project`).
 */
export function normalizeJevFallbackReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return undefined;
  const head = REASON_HEAD_RE.exec(s)?.[1];
  if (head === undefined || head.length > JEV_REASON_MAX_CHARS) return JEV_REASON_OTHER;
  if (HTTP_CODE_RE.test(head)) return head;
  const code = JEV_FREE_TEXT_PREFIXES.get(head) ?? head;
  return JEV_REASON_CODES.has(code) ? code : JEV_REASON_OTHER;
}

/**
 * The Jev fields of `entry`, each one valid or absent. Non-Jev keys pass
 * through untouched, and an entry with no Jev keys comes back as the same
 * object — the unconfigured path must not be rewritten on its way to disk.
 *
 * Deliberately field-by-field rather than all-or-nothing: an invalid model id
 * is no reason to lose the fact that Jev fell back.
 */
export function sanitizeJevActivity<T extends JevActivityFields>(entry: T): T {
  if (!JEV_ACTIVITY_KEYS.some((k) => entry[k] !== undefined)) return entry;
  const out: T = { ...entry };
  const drop = (k: keyof JevActivityFields) => {
    delete out[k];
  };

  if (!(typeof out.evaluator === "string" && EVALUATORS.has(out.evaluator))) drop("evaluator");
  if (!(typeof out.jevDecision === "string" && DECISIONS.has(out.jevDecision))) drop("jevDecision");
  if (!(typeof out.jevMode === "string" && MODES.has(out.jevMode))) drop("jevMode");

  if (Array.isArray(out.jevCleared)) {
    const names = [
      ...new Set(out.jevCleared.filter((n): n is string => typeof n === "string" && POLICY_NAME_RE.test(n))),
    ].slice(0, JEV_CLEARED_MAX);
    out.jevCleared = names;
  } else {
    drop("jevCleared");
  }

  const reason = normalizeJevFallbackReason(out.jevFallbackReason);
  if (reason === undefined) drop("jevFallbackReason");
  else out.jevFallbackReason = reason;

  if (typeof out.jevLatencyMs === "number" && Number.isFinite(out.jevLatencyMs) && out.jevLatencyMs >= 0) {
    out.jevLatencyMs = Math.round(out.jevLatencyMs);
  } else {
    drop("jevLatencyMs");
  }

  if (typeof out.jevModel === "string" && MODEL_RE.test(out.jevModel.trim())) out.jevModel = out.jevModel.trim();
  else drop("jevModel");

  return out;
}

/** True when the row says which evaluator ran, i.e. a Jev config was present for the call. */
export function hasJevActivity(entry: JevActivityFields): boolean {
  return entry.evaluator === "jev" || entry.evaluator === "jev-fallback";
}

/**
 * What happened to Jev on one call:
 *
 * - `answered`: Jev's answer was read and the combine rules applied it.
 * - `fallback`: Jev was asked and was unavailable, truncated or mismatched, so
 *   the regex result stood (`evaluator: "jev-fallback"`).
 * - `not-consulted`: a hard policy denied first, so Jev was aborted and its
 *   answer never read. The combine rules record exactly
 *   `{ evaluator: "jev", jevMode }` for that.
 *
 * Null when Jev was not part of the call (no config, or not a gate).
 *
 * A `jev` row counts as answered when it carries anything only an answer
 * produces: a verdict, a cleared list (even an empty one), a latency or a
 * model id. So a row whose verdict another build wrote in a shape this one
 * cannot read still counts as answered; only the bare not-consulted shape
 * does not. `transform.rs` applies the same rule (`JevOutcome`).
 */
export type JevOutcome = "answered" | "fallback" | "not-consulted";

export function jevOutcome(raw: JevActivityFields): JevOutcome | null {
  return outcomeOf(sanitizeJevActivity(raw));
}

/** {@link jevOutcome} for a row that is already sanitized. */
function outcomeOf(e: JevActivityFields): JevOutcome | null {
  if (e.evaluator === "jev-fallback") return "fallback";
  if (e.evaluator !== "jev") return null;
  const answered =
    e.jevDecision !== undefined || e.jevCleared !== undefined || e.jevLatencyMs !== undefined || e.jevModel !== undefined;
  return answered ? "answered" : "not-consulted";
}

/** What the dashboard says about a call Jev was not consulted on. */
export const JEV_NOT_CONSULTED_FACT = "Jev not consulted: a hard policy's deny is final";

/**
 * What Jev did on one row, as short facts in display order — e.g.
 * `["Jev verdict: allow", "cleared block-env-files", "38 ms", "jev-1.13.0"]` —
 * or null when Jev was not involved. Plain language, no probabilities: those
 * live in the verdict log. Never an empty list: a call Jev was not consulted
 * on says so ({@link JEV_NOT_CONSULTED_FACT}).
 */
export function describeJevActivity(raw: JevActivityFields): string[] | null {
  const e = sanitizeJevActivity(raw);
  const outcome = outcomeOf(e);
  if (outcome === null) return null;
  if (outcome === "not-consulted") return [JEV_NOT_CONSULTED_FACT];
  const facts: string[] = [];

  if (outcome === "fallback") {
    facts.push(`Jev unavailable: ${e.jevFallbackReason ?? "unknown reason"}`, "the regex policies decided alone");
    if (e.jevLatencyMs !== undefined) facts.push(`${e.jevLatencyMs} ms`);
    return facts;
  }

  if (e.jevDecision) facts.push(`Jev verdict: ${e.jevDecision}`);
  const cleared = e.jevCleared ?? [];
  if (cleared.length > 0) {
    facts.push(`${e.jevMode === "shadow" ? "would have cleared" : "cleared"} ${cleared.join(", ")}`);
  }
  if (e.jevMode === "shadow") facts.push("shadow mode: the regex result was enforced");
  if (e.jevLatencyMs !== undefined) facts.push(`${e.jevLatencyMs} ms`);
  if (e.jevModel) facts.push(e.jevModel);
  // Answered, but nothing this build can show (a verdict in a shape it cannot read).
  if (facts.length === 0) facts.push("Jev answered");
  return facts;
}
