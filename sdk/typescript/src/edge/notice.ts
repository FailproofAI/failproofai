/**
 * The one line an Edge / Worker build says, once per isolate.
 *
 * Deliberately self-contained: it imports nothing, not even `logger.ts`,
 * because that module reads environment variables at import time and a Cloudflare
 * Worker without `nodejs_compat` has no `process` at all. Everything under
 * `src/edge/` holds to the same rule — the whole point of these modules is that
 * importing them cannot fail anywhere JavaScript runs.
 */

let said = false;

export const EDGE_NOTICE =
  "@failproofai/sdk loaded its no-op build: this runtime (an Edge / Worker runtime, " +
  "or a browser bundle) has no filesystem for the local failproofaid spool, so NOTHING " +
  "is recorded here; your code runs unchanged. Record from the Node.js runtime " +
  '(Next.js: drop `export const runtime = "edge"` from the route).';

/** Say it once. Never throws: a diagnostic must not take the host down. */
export function notice(): void {
  if (said) return;
  said = true;
  try {
    console.warn(`[failproofai-sdk] ${EDGE_NOTICE}`);
  } catch {
    /* empty */
  }
}

/** Forget that the notice was given (tests). */
export function resetNotice(): void {
  said = false;
}
