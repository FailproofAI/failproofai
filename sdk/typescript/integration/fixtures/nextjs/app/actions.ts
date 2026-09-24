"use server";

import { telemetry } from "@failproofai/sdk/ai";
import { generateText } from "ai";

import { loop, scripted, tools } from "../lib/ai";

/** A server action running an agent (twin: ai-7 `generate`). */
export async function askWeather(): Promise<string> {
  const { text } = await generateText({
    model: scripted(),
    prompt: "Weather in Paris?",
    tools: tools(),
    ...loop,
    experimental_telemetry: telemetry({ functionId: "weather-agent" }),
  });
  return text;
}
