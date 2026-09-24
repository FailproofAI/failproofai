import { wrapTool } from "@failproofai/sdk/mastra";

import { question, weather, weatherAgent } from "../../../lib/mastra";

export const dynamic = "force-dynamic";

/**
 * `?mode=instrument` — Agent.generate() through `instrument()` (twin: mastra-1 `generate`).
 * `?mode=wraptool`   — the call-site `wrapTool()`               (twin: mastra-1 `wraptool`).
 */
export async function GET(request: Request): Promise<Response> {
  const mode = new URL(request.url).searchParams.get("mode") ?? "instrument";
  if (mode === "wraptool") {
    const tool = wrapTool(weather);
    return Response.json({ out: await tool.execute!({ city: "Rome" }, {} as never) });
  }
  const out = await weatherAgent().generate(question);
  return Response.json({ answer: out.text });
}
