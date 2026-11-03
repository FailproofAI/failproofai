/**
 * Next.js's documented startup hook: `register()` runs once per server process,
 * before any request is handled. The place the README should tell Next users
 * to call `instrument()`.
 *
 * `NEXT_RUNTIME` guards the Node-only work: Next also evaluates this file for
 * the Edge runtime, where the SDK has no filesystem to spool to.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.FAILPROOFAI_IT_INSTRUMENT === "0") return;
  const failproofai = await import("@failproofai/sdk");
  const instrumented = await failproofai.instrument();
  (globalThis as { __failproofaiInstrumented?: string[] }).__failproofaiInstrumented = instrumented;
}
