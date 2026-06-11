/**
 * Shared fetch wrapper with per-request timeout and external-signal
 * composition.
 *
 * Replaces three byte-equivalent implementations that had drifted on the
 * default timeout (15s in two client components, 10s in the server-side
 * api-server-client). Co-locates the `isAbortError` predicate so callers
 * can classify timeout vs network failures consistently.
 *
 * Built on the platform primitives `AbortSignal.timeout()` — which
 * aborts with a typed `DOMException(..., "TimeoutError")` rather than
 * the default bare abort that surfaces as Next.js 16's dev-overlay
 * "signal is aborted without reason" warning — and `AbortSignal.any()`,
 * which composes the timeout signal with any caller-supplied
 * `init.signal` so a component-unmount or parent-controller abort
 * actually stops the in-flight fetch. The prior `AbortController` +
 * `setTimeout` implementation called `controller.abort()` with no
 * reason AND silently dropped `init.signal` by spreading then
 * overwriting it with the controller's own signal.
 *
 * Both APIs are available in every runtime Next.js 16 supports:
 * `AbortSignal.timeout` since Node 17.3 / 16.14, `AbortSignal.any`
 * since Node 20.3 (also backported to 18.17). Next.js 16's minimum
 * runtime (Node >= 20.9, per its engines field) covers both. Browser
 * support: Chrome 116+, Firefox 124+, Safari 17.4+.
 */

/** Hard cap on every fetch using this helper unless overridden. Picked to
 *  exceed the server-side `REQUEST_TIMEOUT_MS` (10s) in `api-server-client.ts`
 *  so a slow but successful upstream response still lands. */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(input, { ...init, signal });
}

/** True when an error came from an `AbortController.abort()` OR an
 *  `AbortSignal.timeout()` firing. Both surface as objects whose `name`
 *  is "AbortError" or "TimeoutError" respectively — depending on the
 *  runtime, they may be `Error` subclasses, `DOMException` instances,
 *  both, or neither (the jsdom polyfill, for one, breaks the Error
 *  prototype chain), so we duck-type on `name` rather than the
 *  provenance. Callers always pass values caught from a try/catch, so
 *  the universe of inputs is narrow enough that name-matching is
 *  unambiguous. Keeping the two names in one predicate prevents the
 *  "I forgot TimeoutError" drift class. */
export function isAbortError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}
