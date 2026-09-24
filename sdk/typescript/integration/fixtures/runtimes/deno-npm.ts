// Deno, the way a Deno app is written: every package through an `npm:`
// specifier, TypeScript run as-is. `deno run --allow-all deno-npm.ts <case>`.
//
// With a package.json beside it Deno resolves `npm:` specifiers against this
// fixture's node_modules — the packed SDK and the pinned `ai` — so nothing is
// fetched at run time.
import * as failproofai from "npm:@failproofai/sdk";
import { telemetry, wrapModel } from "npm:@failproofai/sdk/ai";
import { generateText, stepCountIs, tool } from "npm:ai@6.0.288";
import { MockLanguageModelV3 } from "npm:ai@6.0.288/test";
import { z } from "npm:zod@4.6.5";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
const finish = (reason: "stop" | "tool-calls") => ({ unified: reason, raw: reason });

/** Asks for `weather` once, then answers. */
function scripted() {
  let calls = 0;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "mock-model",
    doGenerate: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: [{ type: "tool-call", toolCallId: "call-1", toolName: "weather", input: '{"city":"Paris"}' }],
          finishReason: finish("tool-calls"),
          usage: usage(11, 7),
          warnings: [],
        };
      }
      return { content: [{ type: "text", text: "It is 20C in Paris." }], finishReason: finish("stop"), usage: usage(23, 9), warnings: [] };
    },
  });
}

const tools = {
  weather: tool({
    description: "Current weather for a city",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }: { city: string }) => ({ city, celsius: 20 }),
  }),
};

async function main(scenario: string): Promise<void> {
  let text: string;
  if (scenario === "telemetry") {
    ({ text } = await generateText({
      model: scripted(),
      prompt: "Weather in Paris?",
      tools,
      stopWhen: stepCountIs(4),
      experimental_telemetry: telemetry({ functionId: "weather-agent" }),
    }));
  } else if (scenario === "wrap") {
    ({ text } = await failproofai.agent("weather-agent", () =>
      wrapModel(scripted()).then((model) =>
        generateText({ model, prompt: "Weather in Paris?", tools, stopWhen: stepCountIs(4) }),
      ),
    ));
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
  console.log(JSON.stringify({ text }));
  await failproofai.flush();
}

main(Deno.args[0] ?? "telemetry").catch((error: unknown) => {
  console.error("FATAL", error);
  Deno.exit(1);
});

declare const Deno: { args: string[]; exit(code: number): never };
