import { langchainHandler } from "@failproofai/sdk/langchain";

import { ScriptedModel, buildGraph, question } from "../../../lib/langgraph";

export const dynamic = "force-dynamic";

/**
 * `?mode=instrument` — relies on `instrument()` from instrumentation.ts
 *                      (twin: langchain-1 `graph`).
 * `?mode=handler`    — passes the call-site handler, no patching
 *                      (twin: langchain-1 `handler`).
 */
export async function GET(request: Request): Promise<Response> {
  const mode = new URL(request.url).searchParams.get("mode") ?? "instrument";
  const graph = buildGraph(new ScriptedModel());
  const out =
    mode === "handler"
      ? await graph.invoke(question(), { callbacks: [langchainHandler() as never] })
      : await graph.invoke(question());
  return Response.json({ answer: out.messages.at(-1)?.content });
}
