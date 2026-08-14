/**
 * Next.js instrumentation hook — runs once on server startup.
 * Delegates to lib/instrumentation-node.ts which is dynamically imported only
 * when running in the Node.js runtime, so Edge compilation never sees Node.js APIs.
 *
 * Only THIS file has to sit at the repo root — Next's detection matches the exact
 * basename `instrumentation`, so the Node half is an ordinary module and lives in lib/.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { registerNode } = await import("./lib/instrumentation-node");
  await registerNode();
}
