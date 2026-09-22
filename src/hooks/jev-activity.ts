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
 * up. So a reason is reduced to a short kebab-case CODE before it is stored,
 * and anything that is not code-shaped becomes `other`. The Rust side applies
 * the same rule again, for rows written by some other build.
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

/** A fallback reason code: lowercase kebab-case, e.g. `timeout`, `http-429`, `out-of-credits`. */
const REASON_CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const JEV_REASON_MAX_CHARS = 40;
/** What a reason that is not code-shaped is stored as. */
export const JEV_REASON_OTHER = "other";

/**
 * Leading words the evaluator puts in front of free text. Only these are kept
 * from a free-form reason: an arbitrary leading word could be the first word of
 * the command itself (`rm`, `curl`), so it is not trusted just for being short.
 * `FREE_TEXT_PREFIXES` in the collector's `transform.rs` is the same list; a
 * test keeps the two identical.
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
 * Reduce a fallback reason to a short code, or undefined when there is none.
 *
 * - Already a code (`timeout`, `http-429`, `model-mismatch`): kept, lowercased.
 * - Free text behind a known prefix (`prepare: Unexpected token…`,
 *   `http-500: upstream said …`): the prefix's code.
 * - Anything else: `other`. Never the text.
 */
export function normalizeJevFallbackReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return undefined;
  if (s.length <= JEV_REASON_MAX_CHARS && REASON_CODE_RE.test(s)) return s;
  const head = /^([a-z0-9]+(?:-[a-z0-9]+)*)\s*[:(]/.exec(s)?.[1];
  if (head) {
    if (/^http-\d{3}$/.test(head)) return head;
    const known = JEV_FREE_TEXT_PREFIXES.get(head);
    if (known) return known;
  }
  return JEV_REASON_OTHER;
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

/** True when a row carries any Jev field, i.e. a Jev config was present for the call. */
export function hasJevActivity(entry: JevActivityFields): boolean {
  return entry.evaluator === "jev" || entry.evaluator === "jev-fallback";
}

export interface JevActivitySummary {
  /** One line, e.g. `Jev · enforce · cleared block-env-files · 38 ms`. */
  headline: string;
  /** Short facts for a detail view, in display order. */
  facts: string[];
}

/**
 * How the dashboard says what Jev did on one row, or null when Jev was not
 * involved. Plain language, no probabilities: those live in the verdict log.
 */
export function describeJevActivity(raw: JevActivityFields & { decision?: string }): JevActivitySummary | null {
  const e = sanitizeJevActivity(raw);
  if (!hasJevActivity(e)) return null;
  const facts: string[] = [];
  const mode = e.jevMode ? ` (${e.jevMode})` : "";

  if (e.evaluator === "jev-fallback") {
    const why = e.jevFallbackReason ?? "unknown reason";
    facts.push(`Jev unavailable: ${why}`, "the regex policies decided alone");
    if (e.jevLatencyMs !== undefined) facts.push(`${e.jevLatencyMs} ms`);
    return { headline: `Jev fell back${mode} · ${why}`, facts };
  }

  if (e.jevDecision) facts.push(`Jev verdict: ${e.jevDecision}`);
  const cleared = e.jevCleared ?? [];
  if (cleared.length > 0) {
    const verb = e.jevMode === "shadow" ? "would have cleared" : "cleared";
    facts.push(`${verb} ${cleared.join(", ")}`);
  }
  if (e.jevMode === "shadow") facts.push("shadow mode: the regex result was enforced");
  if (e.jevLatencyMs !== undefined) facts.push(`${e.jevLatencyMs} ms`);
  if (e.jevModel) facts.push(e.jevModel);

  const headlineParts = [`Jev${mode}`];
  if (e.jevDecision) headlineParts.push(e.jevDecision);
  if (cleared.length > 0) headlineParts.push(`${e.jevMode === "shadow" ? "would clear" : "cleared"} ${cleared.length}`);
  if (e.jevLatencyMs !== undefined) headlineParts.push(`${e.jevLatencyMs} ms`);
  return { headline: headlineParts.join(" · "), facts };
}
