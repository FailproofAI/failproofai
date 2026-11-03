import { telemetry } from "@failproofai/sdk/ai";
import { generateText, streamText } from "ai";

import { loop, scripted, tools } from "../../../lib/ai";

export const dynamic = "force-dynamic";

/**
 * `?mode=telemetry`          generateText, call-site `telemetry()`       (twin: ai-7 `generate`)
 * `?mode=instrument`         generateText, `instrument()` + isEnabled     (twin: ai-7 `instrument`)
 * `?mode=stream`             streamText → toUIMessageStreamResponse(),
 *                            call-site `telemetry()`                      (twin: ai-7 `stream`)
 * `?mode=instrument-stream`  the same through `instrument()`             (twin: ai-7 `instrument-stream`)
 *
 * The streaming modes return the stream itself, as a chat route does: the
 * model is still producing when the handler returns.
 */
export async function GET(request: Request): Promise<Response> {
  const mode = new URL(request.url).searchParams.get("mode") ?? "telemetry";
  const viaInstrument = mode.startsWith("instrument");
  const settings = viaInstrument
    ? { isEnabled: true as const, functionId: "weather-agent" }
    : telemetry({ functionId: "weather-agent" });
  if (mode.endsWith("stream")) {
    const result = streamText({
      model: scripted(),
      prompt: "Weather in Rome?",
      tools: tools(),
      ...loop,
      experimental_telemetry: settings,
    });
    return result.toUIMessageStreamResponse();
  }
  const { text } = await generateText({
    model: scripted(),
    prompt: "Weather in Paris?",
    tools: tools(),
    ...loop,
    experimental_telemetry: settings,
  });
  return Response.json({ text });
}
