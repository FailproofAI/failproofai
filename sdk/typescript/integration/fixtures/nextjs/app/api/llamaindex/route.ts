import { agent } from "@llamaindex/workflow";

import { QUESTION, ScriptedLLM, getWeather } from "../../../lib/llamaindex";

export const dynamic = "force-dynamic";

/** A LlamaIndex agent workflow through `instrument()` (twin: llamaindex-0.12 `workflow`). */
export async function GET(): Promise<Response> {
  const out = await agent({ llm: new ScriptedLLM(), tools: [getWeather] }).run(QUESTION);
  return Response.json({ answer: out.data.result });
}
