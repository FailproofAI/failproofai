/**
 * Inert replacements for failproofai's own diagnostic modules, substituted into
 * the sealed bundle at build time.
 *
 * Distinct from `./host-stubs.ts`, which throws. These do nothing and return,
 * because the things they replace are legitimately reachable from the sealed
 * path and legitimately must not happen there:
 *
 * | Replaced | Why it cannot run in the sealed tier |
 * |---|---|
 * | `hook-logger.ts` | appends to a rotating file under `~/.failproofai/logs/`. The sealed context has no filesystem, and the home it would resolve is the daemon's launch environment rather than the request's. |
 * | `hook-telemetry.ts` | `fetch()`s PostHog. Enforcement runs under a hard deadline and performs no unbounded I/O — a synchronous network call inside a hook makes a third party's availability a precondition for the user running a command. |
 * | `lib/telemetry-id.ts` | reads `~/.failproofai/instance-id`, and shells out via `execSync` for a platform machine ID. |
 *
 * Throwing instead of no-op'ing would be wrong here. These are called on the
 * *normal* path — `evaluateVerdicts` logs the policy count and fires
 * `policy_evaluation_error` telemetry when a builtin crashes — so a throw would
 * convert a diagnostic into an evaluation failure and trip a circuit breaker for
 * a policy that worked fine.
 *
 * Nothing is lost. The daemon owns observability for sealed evaluations: it has
 * the structured result, the decision ID, the generation ID, and the timing,
 * and it writes decision evidence to the durable activity spool on its own lane
 * — asynchronously, outside the enforcement deadline. Diagnostics from inside
 * the worker would be a second, worse channel for the same information.
 */

// -- hook-logger --
export type LogLevel = "info" | "warn" | "error";
export function hookLogInfo(_msg: string): void {}
export function hookLogWarn(_msg: string): void {}
export function hookLogError(_msg: string): void {}
export function _resetHookLogger(): void {}

// -- hook-telemetry --
export async function trackHookEvent(
  _distinctId: string,
  _event: string,
  _properties?: Record<string, unknown>,
): Promise<void> {}
export async function flushHookTelemetry(): Promise<void> {}

// -- lib/telemetry-id --
/**
 * A fixed sentinel rather than a random or empty value.
 *
 * It is only ever passed as the `distinctId` argument to the no-op
 * `trackHookEvent` above, so it never leaves the worker. A constant keeps the
 * worker deterministic, which the soak test depends on: the same request must
 * produce the same bytes on the first evaluation and the ten-thousandth.
 */
export function getInstanceId(): string {
  return "sealed-worker";
}
export function hashToId(raw: string): string {
  return raw;
}
export function getPlatformMachineId(): string | undefined {
  return undefined;
}
export function getSystemPropertiesId(): string {
  return "sealed-worker";
}
