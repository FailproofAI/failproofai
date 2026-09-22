/**
 * Starts Jev's review of one tool call, in parallel with the regex policies,
 * for the two-tier evaluator.
 *
 * Loaded by `handler.ts` with a dynamic import, and only once a Jev config
 * (BYOK) exists and the call is a gate event — so a machine without
 * `jev.json` never loads the semantic evaluator at all, and its hook path is
 * exactly what it was before two tiers existed.
 *
 * Everything the request needs comes through the §7 contracts:
 * `transportForConfig` (T1) for the provider, `throttleTransport` (T5) for the
 * cache and rate limit, `readIntent` (T4) for what the human asked. Jev's own
 * verdict is intent v1 (`decideV1` with `DEFAULT_THRESHOLDS_V1`).
 *
 * The returned promise never rejects: every failure is a `fallback` review,
 * which the combine turns into today's regex result.
 */
import { BUILTIN_POLICIES } from "../builtin-policies";
import { normalizePolicyName } from "../policy-registry";
import { effectiveAuthority, type PolicyAuthority, type RegisteredPolicy } from "../policy-types";
import type { JevMode, JevReview, TwoTierReview } from "./combine";
import { DEFAULT_THRESHOLDS_V1 } from "./decide";
import { DEFAULT_JEV_TIMEOUT_MS, appendVerdictLog, evaluateSemantic, verdictLogRow, type SemanticOutcome } from "./evaluator";
import { readIntent } from "./intent";
import { JevError, transportForConfig } from "./jev-client";
import { DEFAULT_JEV_MODE, type JevConfig } from "./jev-config";
import { throttleTransport } from "./jev-throttle";
import type { SemanticInput } from "./types";

/**
 * The self-protection guard (and anything else `alwaysOn`) is hard whatever
 * it declares. Registered policies do not carry `alwaysOn`, so it is looked up
 * from the builtin definitions by canonical name.
 */
const ALWAYS_ON: ReadonlySet<string> = new Set(
  BUILTIN_POLICIES.filter((p) => p.alwaysOn).map((p) => normalizePolicyName(p.name)),
);

export function authorityOf(p: Pick<RegisteredPolicy, "name" | "authority" | "reviewedBy">): {
  authority: PolicyAuthority;
  reviewedBy: string[];
} {
  const authority = effectiveAuthority({ authority: p.authority, reviewedBy: p.reviewedBy, alwaysOn: ALWAYS_ON.has(p.name) });
  if (authority !== "reviewable") return { authority, reviewedBy: [] };
  const reviewedBy = (p.reviewedBy ?? []).filter((n): n is string => typeof n === "string" && n.length > 0);
  return { authority, reviewedBy };
}

export interface JevCallContext {
  eventType: string;
  toolName: string;
  toolInput: unknown;
  cwd?: string;
  permissionMode?: string;
  sessionId?: string;
  cli: string;
}

export function resolveMode(cfg: JevConfig): JevMode {
  return cfg.mode === "shadow" || cfg.mode === "enforce" ? cfg.mode : DEFAULT_JEV_MODE;
}

function resolveTimeout(cfg: JevConfig): number {
  const t = cfg.timeoutMs;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_JEV_TIMEOUT_MS;
}

/** The semantic policy an attributable Jev verdict is filed under. */
function jevPolicyName(outcome: Extract<SemanticOutcome, { status: "ok" }>): string {
  const { verdict } = outcome;
  const wanted = verdict.decision === "deny" ? "deny" : "instruct";
  const first = verdict.outcomes.find((o) => o.verdict === wanted);
  if (first) return `semantic/${first.policy}`;
  return verdict.beyondTask ? "semantic/beyond-task" : "semantic/jev";
}

/**
 * A fallback reason as a short stable code (`timeout`, `http-429`,
 * `model-mismatch`, …). Degraded reasons can carry an exception message after
 * a colon; that detail stays in the local verdict log and never reaches the
 * activity row, which telemetry may ship.
 */
export function fallbackCode(reason: string): string {
  const code = reason.split(":")[0].trim();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(code) ? code : "error";
}

export function toReview(outcome: SemanticOutcome): JevReview {
  if (outcome.status === "degraded") {
    return { kind: "fallback", reason: fallbackCode(outcome.reason), latencyMs: outcome.latencyMs, model: null, decision: null };
  }
  const sent = outcome.via !== "none";
  const latencyMs = sent ? outcome.latencyMs : null;
  const model = sent ? outcome.model : null;
  // A truncated envelope means Jev did not see all of the call: padding a
  // command must not be a way to hide its dangerous part, so the regex result
  // stands, every deny counting. Jev's answer is still recorded.
  if (outcome.truncated) {
    return { kind: "fallback", reason: "truncated", latencyMs, model, decision: outcome.verdict.decision };
  }
  const outcomes = outcome.verdict.outcomes;
  const injection = outcome.verdict.injectionSuspected;
  return {
    kind: "answered",
    decision: outcome.verdict.decision,
    reason: outcome.verdict.reason,
    policyName: jevPolicyName(outcome),
    // Every selected policy's questions were in the request, and `readAnswers`
    // refuses a response missing any of them — so selected == asked, and only
    // when a request was actually made.
    asked: sent ? outcomes.map((o) => o.policy) : [],
    clear: sent ? outcomes.filter((o) => o.verdict === "none" || o.verdict === "overridden").map((o) => o.policy) : [],
    injected: injection !== null && injection >= DEFAULT_THRESHOLDS_V1.injection,
    latencyMs,
    model,
  };
}

function toolInputRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * Kick off the request now; the caller runs the regex policies meanwhile and
 * awaits `review` only if no hard deny decided first.
 */
export function startJevReview(cfg: JevConfig, call: JevCallContext): TwoTierReview {
  const mode = resolveMode(cfg);
  const controller = new AbortController();
  let settled = false;
  const handle = (review: Promise<JevReview>): TwoTierReview => ({
    mode,
    review: review.finally(() => {
      settled = true;
    }),
    abort: () => {
      if (!settled) controller.abort();
    },
    authorityOf,
  });

  let route: ReturnType<typeof transportForConfig>;
  let transport: ReturnType<typeof throttleTransport>;
  try {
    route = transportForConfig(cfg);
    transport = throttleTransport(route.transport);
  } catch (err) {
    const reason = err instanceof JevError ? err.code : "config";
    return handle(Promise.resolve({ kind: "fallback", reason, latencyMs: null, model: null, decision: null }));
  }

  let intent: { userSaid: string[]; agentLastMessage: string | null };
  try {
    intent = readIntent(call.sessionId);
  } catch {
    intent = { userSaid: [], agentLastMessage: null };
  }

  const input: SemanticInput = {
    eventType: call.eventType,
    toolName: call.toolName,
    toolInput: toolInputRecord(call.toolInput),
    ...(call.cwd ? { cwd: call.cwd } : {}),
    ...(call.permissionMode ? { permissionMode: call.permissionMode } : {}),
    userSaid: intent.userSaid,
    agentLastMessage: intent.agentLastMessage,
  };

  const review = evaluateSemantic(input, {
    transport,
    via: route.via,
    model: route.model,
    timeoutMs: resolveTimeout(cfg),
    intent: "v1",
    v1: { thresholds: DEFAULT_THRESHOLDS_V1 },
    signal: controller.signal,
  })
    .then((outcome): JevReview => {
      const review = toReview(outcome);
      // An aborted request has nothing worth replaying; everything else goes
      // to the local verdict log (never shipped), so any verdict can be
      // re-derived offline from its recorded probabilities.
      if (!(outcome.status === "degraded" && outcome.reason === "aborted")) {
        appendVerdictLog(
          verdictLogRow(input, outcome, {
            sessionId: call.sessionId,
            cli: call.cli,
            eventType: call.eventType,
            applied: review.kind !== "answered" ? "legacy-fallback" : mode === "shadow" ? "shadow" : "two-tier",
          }),
        );
      }
      return review;
    })
    .catch((): JevReview => ({ kind: "fallback", reason: "error", latencyMs: null, model: null, decision: null }));
  return handle(review);
}
