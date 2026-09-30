/**
 * FailproofAI Cloud Jev's health as this machine sees it (review M3).
 *
 * Under a Cloud Jev mode every gated tool call is a Cloud call, and every one
 * that fails falls back to the regex alone. That trade is right for the hook
 * path, and it used to be silent. This module adds two things:
 *
 * - **A circuit breaker.** After {@link BREAKER_FAILURES} Cloud Jev failures
 *   in a row (a timeout, no connection, a 5xx, a reply that cannot be used),
 *   Cloud Jev is not asked for {@link BREAKER_OPEN_MS}. The regex decides at
 *   once, instead of every tool call on the machine waiting out the Cloud
 *   timeout. Then ONE call goes through (half-open): an answer closes the
 *   breaker, and another failure opens it again. A 429 is not a failure here,
 *   because the Cloud transport already honours its Retry-After
 *   (`cloudRetryAfter` in `jev-client.ts`). Nor is a call this machine
 *   abandoned itself, or one its own settings stopped.
 * - **A report** in `errors.json`, machine-level (`id: "jevMode"`, beside
 *   `jev_unconfigured`):
 *   - `jev_rate_limited: <n> calls fell back to regex in the last 10 min`,
 *     while FailproofAI Cloud refuses calls for the organization's Jev rate
 *     limit;
 *   - `jev_unavailable: …`, while the breaker is open.
 *
 *   Both clear as soon as a call is answered again. The count is refreshed at
 *   most every {@link REPORT_REFRESH_MS}, so a burst of refusals does not
 *   become a burst of writes.
 *
 * The state is module-level, like the Retry-After cool-down and the throttle:
 * the daemon's warm worker is the process that sees every call. A one-shot
 * hook process, on a machine not set up yet, starts clean each time. The state
 * is keyed by where the calls go (endpoint and machine id), so a reconnect
 * starts afresh.
 */
import { readCloudPolicyErrors, writeCloudPolicyErrors, type CloudPolicyError } from "../cloud-policy-errors";
import type { JevReview } from "./combine";

/** Consecutive failures that open the breaker. */
export const BREAKER_FAILURES = 3;
/** How long an open breaker skips FailproofAI Cloud Jev before it lets one call through. */
export const BREAKER_OPEN_MS = 60_000;
/** The window `jev_rate_limited` counts over. */
export const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
/** A changing count is re-reported at most this often. */
export const REPORT_REFRESH_MS = 30_000;

/** Reported while FailproofAI Cloud refuses this machine's calls for the org's Jev rate limit. */
export const JEV_RATE_LIMITED = "jev_rate_limited";
/** Reported while the breaker is open. */
export const JEV_UNAVAILABLE = "jev_unavailable";

/** The fallback reason of a call the open breaker did not send (a known activity code). */
export const BREAKER_SKIP_REASON = "unavailable";

interface State {
  scope: string;
  failures: number;
  lastFailure: string | null;
  /** When an open breaker lets its next call through; null = closed. */
  openUntil: number | null;
  /** The half-open trial call is in flight: the others still skip. */
  probing: boolean;
  /** When each rate-limited fallback happened, within the window. */
  rateLimited: number[];
  /** The count last reported, and when, so the report changes at most every REPORT_REFRESH_MS. */
  reportedRate: { n: number; at: number } | null;
  /** The entries last merged into `errors.json` by {@link reportCloudJevHealth}. */
  lastReport: string;
}

const fresh = (scope: string): State => ({
  scope,
  failures: 0,
  lastFailure: null,
  openUntil: null,
  probing: false,
  rateLimited: [],
  reportedRate: null,
  lastReport: "[]",
});

let state: State = fresh("");
const clock = (): number => performance.now();

/** Tests only. */
export function _resetCloudJevHealthForTest(): void {
  state = fresh("");
}

function forScope(scope: string): State {
  if (state.scope !== scope) state = fresh(scope);
  return state;
}

/** Whether a call may go to FailproofAI Cloud now; `probe` marks the half-open trial. */
export type CloudJevGate = { ask: true; probe: boolean } | { ask: false };

/** Ask the breaker before sending a call. Taking the trial (`probe: true`) must be followed by {@link recordCloudJevResult}. */
export function cloudJevGate(scope: string, at: number = clock()): CloudJevGate {
  const s = forScope(scope);
  if (s.openUntil === null) return { ask: true, probe: false };
  if (at < s.openUntil || s.probing) return { ask: false };
  s.probing = true;
  return { ask: true, probe: true };
}

/** What one Cloud call's review says about Cloud's health. */
export type CloudJevResult = "answered" | "rate-limited" | "failed" | "neutral";

/** Fallback codes that say FailproofAI Cloud Jev could not be used; `http-5xx` too. */
const FAILURES: ReadonlySet<string> = new Set(["timeout", "network", "malformed", "model-mismatch", "upstream-error", "error"]);

/**
 * - `answered`: Jev's verdict arrived.
 * - `rate-limited`: FailproofAI Cloud refused the call for a rate limit, or its
 *   Retry-After held the call (`http-429`); or the machine's own request budget
 *   stopped it (`rate-limited`), which a Cloud 429 empties so the calls right
 *   behind it do not go out (`jev-throttle.ts`).
 * - `failed`: timeout, no connection, a 5xx, or a reply that could not be used.
 * - `neutral`: anything that says nothing about Cloud. That covers a call this
 *   machine aborted (the regex decided first), its own config, and Cloud
 *   refusing THIS request (4xx): Cloud answered, so it is up.
 */
export function classifyCloudJevReview(review: JevReview): CloudJevResult {
  if (review.kind === "answered") return "answered";
  if (review.kind !== "fallback") return "neutral";
  const code = review.reason;
  if (code === "http-429" || code === "rate-limited") return "rate-limited";
  if (FAILURES.has(code) || /^http-5\d\d$/.test(code)) return "failed";
  return "neutral";
}

/** Record one call's result against the breaker and the report. */
export function recordCloudJevResult(
  scope: string,
  result: CloudJevResult,
  code: string | null,
  probe: boolean,
  at: number = clock(),
): void {
  if (state.scope !== scope) return; // A call to a connection this machine no longer has.
  const s = state;
  if (probe) s.probing = false;
  switch (result) {
    case "answered":
      s.failures = 0;
      s.lastFailure = null;
      s.openUntil = null;
      s.rateLimited = [];
      break;
    case "rate-limited":
      s.rateLimited.push(at);
      // A 429 is Cloud answering, so it is up: the breaker's streak ends, and
      // its Retry-After, not the breaker, holds the calls behind this one. The
      // machine's own budget says nothing about Cloud either way.
      if (code === "http-429") {
        s.failures = 0;
        s.openUntil = null;
      }
      break;
    case "failed":
      s.failures += 1;
      s.lastFailure = code;
      if (probe || s.failures >= BREAKER_FAILURES) s.openUntil = at + BREAKER_OPEN_MS;
      break;
    case "neutral":
      break;
  }
}

/** Is `message` one of this module's reports? */
export function isCloudJevHealthMessage(message: string): boolean {
  return message.startsWith(JEV_RATE_LIMITED) || message.startsWith(JEV_UNAVAILABLE);
}

/** The report as it stands: `errors.json` entries, none when all is well. */
export function cloudJevHealthErrors(at: number = clock()): CloudPolicyError[] {
  const s = state;
  const out: CloudPolicyError[] = [];
  s.rateLimited = s.rateLimited.filter((t) => at - t < RATE_LIMIT_WINDOW_MS);
  const n = s.rateLimited.length;
  if (n === 0) {
    s.reportedRate = null;
  } else {
    if (s.reportedRate === null || at - s.reportedRate.at >= REPORT_REFRESH_MS) s.reportedRate = { n, at };
    const minutes = Math.round(RATE_LIMIT_WINDOW_MS / 60_000);
    const count = s.reportedRate.n;
    out.push({
      id: "jevMode",
      version: null,
      kind: "daemon",
      message: `${JEV_RATE_LIMITED}: ${count} call${count === 1 ? "" : "s"} fell back to regex in the last ${minutes} min`,
    });
  }
  if (s.openUntil !== null) {
    out.push({
      id: "jevMode",
      version: null,
      kind: "daemon",
      message:
        `${JEV_UNAVAILABLE}: FailproofAI Cloud Jev failed ${BREAKER_FAILURES} or more calls in a row ` +
        `(last: ${s.lastFailure ?? "error"}), so tool calls skip it for ${BREAKER_OPEN_MS / 1000} s at a time ` +
        "and the regex decides alone",
    });
  }
  return out;
}

/**
 * Merge the report into `errors.json` now, when it changed since this process
 * last merged it, so the daemon's next poll carries it without waiting for the
 * next hook. Every other entry is kept. Never throws.
 */
export function reportCloudJevHealth(at: number = clock()): void {
  try {
    const entries = cloudJevHealthErrors(at);
    const text = JSON.stringify(entries);
    if (text === state.lastReport) return;
    state.lastReport = text;
    const report = (readCloudPolicyErrors() ?? []).filter((e) => !(e.id === "jevMode" && isCloudJevHealthMessage(e.message)));
    writeCloudPolicyErrors([...report, ...entries]);
  } catch {
    // A report must not cost a hook its answer; the next call reports again.
  }
}
