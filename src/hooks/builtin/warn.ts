/**
 * A warning sink for sealed-tier policies.
 *
 * `hook-logger.ts` imports `node:fs` and `node:os` — it appends to a rotating
 * file under `~/.failproofai/logs/`. One `import { hookLogWarn }` inside
 * `payload-only.ts` would therefore put `node:fs` in that module's resolved
 * import graph, and tier derivation would demote all 32 sealed-eligible
 * policies to `user-context`. The sealed tier would be empty and nothing would
 * say so.
 *
 * So the sealed half depends on this module instead, which imports nothing.
 * The host-side aggregator (`builtin-policies.ts`) installs the real logger at
 * load; the sealed worker either installs its own sink or leaves the default,
 * which discards. Discarding is correct there: the sealed context has no
 * filesystem to write a log to, and a policy warning is diagnostic, never part
 * of a verdict.
 */

export type PolicyWarnSink = (message: string) => void;

const noop: PolicyWarnSink = () => {};

let sink: PolicyWarnSink = noop;

/** Install the process-wide sink. Called by `builtin-policies.ts` at load. */
export function setPolicyWarnSink(fn: PolicyWarnSink): void {
  sink = fn;
}

/** Restore the discarding default. Exposed for test isolation. */
export function resetPolicyWarnSink(): void {
  sink = noop;
}

/** Emit a diagnostic warning from inside a policy. Never affects a verdict. */
export function policyWarn(message: string): void {
  sink(message);
}
