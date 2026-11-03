import * as failproofai from "@failproofai/sdk";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/**
 * The SDK in the Edge runtime: no filesystem, so no spool. Importing it must
 * not take the route down; what each call does instead is what this reports.
 */
export async function GET(): Promise<Response> {
  const outcome: Record<string, unknown> = { imported: typeof failproofai.event === "object" };
  try {
    failproofai.session({ sessionId: "edge-session" }, () =>
      failproofai.agent("edge-agent", () => {
        failproofai.event.modelRequest({ model: "mock-model", requestId: "r-1" });
      }),
    );
    outcome.emitted = true;
  } catch (error) {
    outcome.emitted = String(error);
  }
  try {
    await failproofai.flush();
    outcome.flushed = true;
  } catch (error) {
    outcome.flushed = String(error);
  }
  return Response.json(outcome);
}
