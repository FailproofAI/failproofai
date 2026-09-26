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
 * cache and rate limit (scoped to the config's provider, endpoint and model;
 * see `throttleScope`), `readIntent` (T4) for what the human asked. Jev's own
 * verdict is intent v1 (`decideV1` with `DEFAULT_THRESHOLDS_V1`).
 *
 * The returned promise never rejects: every failure is a `fallback` review,
 * which the combine turns into today's regex result. A `fallback` means Jev
 * produced NO verdict — a genuine transport or degraded failure (timeout, 429,
 * 402, 5xx, malformed body, model mismatch, no transport, a config that cannot
 * be built) — and it deliberately carries no decision, so a verdict Jev DID
 * produce can never be dropped on the way in.
 *
 * A verdict given on an envelope that could not carry everything is not that.
 * It comes through as `answered` with `requestCut: true` when what did not fit
 * was part of the call: it clears nothing, and it still counts toward the
 * most-severe rule, because padding a call must not be a way to stop Jev's own
 * deny applying. Size reaches neither the degrade path nor a refusal —
 * `buildEnvelope` spends a hard budget and never throws, and being over it is
 * recorded rather than acted on, so the strictest thing a big call can be is
 * whatever Jev says about it (see `envelope.ts` and `combine.ts`).
 *
 * `truncated` — an over-long human turn, the agent's last message, or a prompt
 * the intent store had already capped — rides along for the verdict log and
 * changes nothing. It is not a fallback, it withdraws no clear, and the review
 * it rides on is recorded `jev`.
 *
 * Both of those last two paragraphs are a DEPARTURE from plan §4, which files
 * "the envelope was truncated" in one row with the degraded cases and asks for
 * the regex result plus a `jev-fallback` reason. The shipped rule splits that
 * row: a cut CALL is a fallback that clears nothing but keeps Jev's own
 * severity, and a cut MESSAGE is not a fallback at all. `combine.ts`'s header
 * ("Where this departs from plan §4") is the single statement of that rule and
 * of why it is the safe reading; this file only has to produce the two shapes
 * it distinguishes, which is what `toReview` below does.
 */
import { BUILTIN_POLICIES } from "../builtin-policies";
import { normalizePolicyName } from "../policy-registry";
import { effectiveAuthority, type PolicyAuthority, type RegisteredPolicy } from "../policy-types";
import type { JevMode, JevReview, TwoTierReview } from "./combine";
import { DEFAULT_THRESHOLDS_V1 } from "./decide";
import { DEFAULT_JEV_TIMEOUT_MS, appendVerdictLog, evaluateSemantic, verdictLogRow, type SemanticOutcome } from "./evaluator";
import * as intentStore from "./intent";
import { JevError, transportForConfig, type JevTransport } from "./jev-client";
import { DEFAULT_JEV_MODE, type JevConfig } from "./jev-config";
import * as jevThrottle from "./jev-throttle";
import { sessionProjectRoot } from "./session-root";
import type { SemanticInput } from "./types";

/**
 * T5's throttle as this file calls it. §7 declares only
 * `throttleTransport(t)`; T5 added the `scope` option and the
 * `isCachedJevResponse` probe, and both are used through this shape so the
 * call compiles against the contract stub and the real module alike. The
 * probe is optional: without it every answer counts as a fresh one.
 */
interface JevThrottle {
  throttleTransport(t: JevTransport, opts?: { scope?: string }): JevTransport;
  isCachedJevResponse?(response: unknown): boolean;
}
const throttle: JevThrottle = jevThrottle;

/**
 * T4's intent store as this file calls it: §7's `readIntent(sessionId)`,
 * returning what the human typed and the agent's last message. That is all it
 * returns.
 *
 * There was a second, optional field here — a store that had CUT either
 * message reporting so out of band, which the evaluator believes
 * (`SemanticOptions.contextTruncated`) — and nothing has ever written it.
 * `readIntent` in `intent.ts` returns the two fields above, so the branch
 * reading the third was dead while its comment claimed the store reports its
 * cuts. Removed rather than left standing: what actually decides is the
 * evaluator's narrower guess (`intentStoreCut` in `evaluator.ts` — its own
 * omission mark in a message that also fills the cap), so a store cut can go
 * unnoticed, and that belongs in the open.
 *
 * Wiring it is one line if T4's store is ever taught to report the cut
 * (`capWithin` in `intent.ts` is what makes it): pass `contextTruncated` to
 * `evaluateSemantic` below. It has to stay out of band like that, never read
 * out of the message text, because the messages are agent-authored — a cut
 * inferred from their content would let repo text switch the semantic tier off
 * for a call.
 */
interface IntentStore {
  readIntent(sessionId?: string): { userSaid: string[]; agentLastMessage: string | null };
}
const intentReader: IntentStore = intentStore;

/** Whether T5's cache, not the provider, produced this response. Never throws. */
function servedFromCache(response: unknown): boolean {
  try {
    const probe = throttle.isCachedJevResponse;
    return typeof probe === "function" && probe(response) === true;
  } catch {
    return false;
  }
}

/**
 * Where a config's answers come from — provider, endpoint (base URL,
 * Cloudflare account) and the model id sent — as T5's cache scope.
 *
 * The cache lives as long as the warm worker, which outlives any one
 * `jev.json`, and the request alone does not say who answered it: two
 * providers asked for the same model build byte-identical requests. Unscoped,
 * an answer one config got — from a plain-http loopback proxy T1 allows only in
 * shadow mode, say — would clear denies under the next config in enforce mode
 * without that provider ever being asked. The scope is only hashed into the
 * cache key, never stored, so a URL carrying a credential is safe here.
 */
export function throttleScope(cfg: JevConfig, route: { via: string; model: string }): string {
  return JSON.stringify([route.via, cfg.baseUrl ?? null, cfg.accountId ?? null, route.model]);
}

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

/**
 * Bounds on how long one call may wait for Jev — the same bounds T1's config
 * loader enforces, applied again here because this is the component that
 * knows what they protect: every millisecond is added to the tool call, and
 * the daemon client gives a whole hook 30 s before it fail-closed denies.
 */
export const MIN_JEV_TIMEOUT_MS = 100;
export const MAX_JEV_TIMEOUT_MS = 10_000;
/**
 * How long past its own timeout a review may run before it is abandoned as a
 * timeout anyway: a transport that ignores its abort signal must not be able
 * to hold a hook open.
 */
export const JEV_DEADLINE_GRACE_MS = 250;

/** The config's timeout, clamped to the bounds above; anything unusable → the 3000 ms default. */
export function resolveTimeout(cfg: JevConfig): number {
  const t = cfg.timeoutMs;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return DEFAULT_JEV_TIMEOUT_MS;
  return Math.min(MAX_JEV_TIMEOUT_MS, Math.max(MIN_JEV_TIMEOUT_MS, t));
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

/**
 * @param cached - the answer came from T5's cache, not the provider: it is
 *   applied like any other, but its ~0 ms is not a latency (`latencyMs`
 *   null, so latency percentiles only ever measure the provider).
 */
export function toReview(outcome: SemanticOutcome, cached = false): JevReview {
  if (outcome.status === "degraded") {
    // No verdict at all. The `fallback` variant carries no decision, by design:
    // see "One rule about a partial picture" in `combine.ts`.
    return { kind: "fallback", reason: fallbackCode(outcome.reason), latencyMs: outcome.latencyMs, model: null };
  }
  const sent = outcome.via !== "none";
  const latencyMs = sent && !cached ? outcome.latencyMs : null;
  const model = sent ? outcome.model : null;
  const outcomes = outcome.verdict.outcomes;
  // `null` when the injection probe was not in the request, which now means
  // only that no request was made: v1 asks it on every call it sends, with or
  // without a recorded human message (see `compile.ts`).
  const injection = sent ? outcome.verdict.injectionSuspected : null;
  return {
    kind: "answered",
    decision: outcome.verdict.decision,
    reason: outcome.verdict.reason,
    policyName: jevPolicyName(outcome),
    // Every selected policy's questions were in the request, and `readAnswers`
    // refuses a response missing any of them — so selected == asked, and only
    // when a request was actually made.
    asked: sent ? outcomes.map((o) => o.policy) : [],
    // Every answer but `deny`: `none` and `overridden` found nothing to stop,
    // and `instruct` looked at the same concern the regex policy names and
    // judged it a warning. `combine.ts` clears a reviewable verdict on all
    // three, and Jev's own instruct then carries the warning through the
    // most-severe merge — see "A warning-level answer clears the deny, and
    // leaves the warning" there. A `deny` is what keeps the block.
    notDenied: sent ? outcomes.filter((o) => o.verdict !== "deny").map((o) => o.policy) : [],
    injectionAsked: injection !== null,
    injected: injection !== null && injection >= DEFAULT_THRESHOLDS_V1.injection,
    // A check no consent can clear warned: nothing may be cleared on this call
    // (see "A check no consent can clear keeps the floor" in `combine.ts`).
    unclearableWarned: outcomes.some((o) => o.mode === "deny" && o.userCanOverride === false && o.verdict === "instruct"),
    // Something did not fit — a human turn, the agent's message, or what T4's
    // store had already capped before the envelope saw it (it caps to fit the
    // envelope, so the envelope cannot see that cut; only the evaluator's
    // `intentStoreCut` guess can, since nothing reports it out of band — see
    // `IntentStore`). `outcome.truncated` covers both (see `prepareSemantic`).
    // Carried for the verdict log; `combine.ts`
    // reads nothing from it, because the length of what a human typed is not
    // evidence about the call.
    //
    // Only when a request was actually sent: with no semantic policy applying
    // nothing reaches Jev, so nothing was judged on a cut envelope at all.
    truncated: outcome.truncated && sent,
    // §4's row, one field over: part of the CALL — or of the deterministic
    // facts about it — was not shown. Every clear is withdrawn and the call is
    // recorded as `jev-fallback` / `request-cut`; Jev's own deny or instruct
    // still counts, because padding must not be a way to stop it applying, and
    // nothing else is added, because padding must not be a way to invent a
    // deny either.
    //
    // Same "only if a request was sent" rule: with no semantic policy applying
    // nothing was judged, so nothing was hidden from the judging.
    requestCut: outcome.requestCut && sent,
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
  let throttled: JevTransport;
  try {
    route = transportForConfig(cfg);
    throttled = throttle.throttleTransport(route.transport, { scope: throttleScope(cfg, route) });
  } catch (err) {
    const reason = err instanceof JevError ? err.code : "config";
    return handle(Promise.resolve({ kind: "fallback", reason, latencyMs: null, model: null }));
  }

  let intent: ReturnType<IntentStore["readIntent"]>;
  try {
    intent = intentReader.readIntent(call.sessionId);
  } catch {
    intent = { userSaid: [], agentLastMessage: null };
  }

  // Never throws; null only without a cwd, and then there is nothing to pin.
  const projectRoot = sessionProjectRoot(call.sessionId, call.cwd);

  const input: SemanticInput = {
    eventType: call.eventType,
    toolName: call.toolName,
    toolInput: toolInputRecord(call.toolInput),
    ...(call.cwd ? { cwd: call.cwd } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...(call.permissionMode ? { permissionMode: call.permissionMode } : {}),
    userSaid: intent.userSaid,
    agentLastMessage: intent.agentLastMessage,
  };

  /** Set when the answer came from T5's cache (a hit carries the original `usage` and no real latency). */
  let cached = false;
  const transport: JevTransport = async (request, signal) => {
    const response = await throttled(request, signal);
    cached = servedFromCache(response);
    return response;
  };

  const timeoutMs = resolveTimeout(cfg);
  /** Set once the backstop below gave up on the answer: a late one is logged, never applied. */
  let abandoned = false;
  const answered = evaluateSemantic(input, {
    transport,
    cli: call.cli,
    via: route.via,
    model: route.model,
    timeoutMs,
    intent: "v1",
    v1: { thresholds: DEFAULT_THRESHOLDS_V1 },
    signal: controller.signal,
    // No `contextTruncated`: nothing reports a store cut out of band, so the
    // evaluator's own (narrower) guess stands. See `IntentStore` above.
  })
    .then((outcome): JevReview => {
      const hit = cached && outcome.status === "ok";
      const review = toReview(outcome, hit);
      // An aborted request has nothing worth replaying; everything else goes
      // to the local verdict log (never shipped), so any verdict can be
      // re-derived offline from its recorded probabilities. A cache hit is
      // marked, and its tokens are not counted again.
      if (!(outcome.status === "degraded" && outcome.reason === "aborted")) {
        const row = verdictLogRow(input, hit ? { ...outcome, inputTokens: null } : outcome, {
          sessionId: call.sessionId,
          cli: call.cli,
          eventType: call.eventType,
          applied: abandoned || review.kind !== "answered" ? "legacy-fallback" : mode === "shadow" ? "shadow" : "two-tier",
        });
        appendVerdictLog(hit ? { ...row, cached: true } : row);
      }
      return review;
    })
    .catch((): JevReview => ({ kind: "fallback", reason: "error", latencyMs: null, model: null }));

  // The backstop: `evaluateSemantic` times out through the transport's
  // abort signal, which only works if the transport honours it. Whatever the
  // transport does, the review settles shortly after the configured timeout.
  // Deliberately NOT unref'd: in a one-shot hook process a transport stuck on
  // nothing the event loop can see would otherwise let the process exit with
  // the review still pending — an empty stdout, which every CLI reads as allow.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<JevReview>((resolve) => {
    deadline = setTimeout(() => {
      abandoned = true;
      controller.abort();
      resolve({ kind: "fallback", reason: "timeout", latencyMs: timeoutMs + JEV_DEADLINE_GRACE_MS, model: null });
    }, timeoutMs + JEV_DEADLINE_GRACE_MS);
  });
  return handle(
    Promise.race([answered, expired]).finally(() => {
      if (deadline !== undefined) clearTimeout(deadline);
    }),
  );
}
