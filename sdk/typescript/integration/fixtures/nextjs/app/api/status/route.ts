export const dynamic = "force-dynamic";

/** What instrumentation.ts's `instrument()` returned, and whether it ran at all. */
export function GET(): Response {
  const instrumented = (globalThis as { __failproofaiInstrumented?: string[] }).__failproofaiInstrumented ?? null;
  return Response.json({ instrumented, runtime: process.env.NEXT_RUNTIME ?? null });
}
