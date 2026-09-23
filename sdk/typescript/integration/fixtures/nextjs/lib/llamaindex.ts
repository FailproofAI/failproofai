// The llamaindex-0.12 fixture's scripted LLM and tool, so a route's trace can
// be compared with that fixture's `workflow` trace under plain Node.
//
// One difference, in spelling only: the fixture decorates `chat` with
// `@wrapEventCaller @wrapLLMEvent`, and Next's compiler does not take standard
// decorators. They are applied here by hand — the same two functions, in the
// same order, with the context object a decorator receives.
import { wrapEventCaller, wrapLLMEvent } from "@llamaindex/core/decorator";
import {
  ToolCallLLM,
  type ChatMessage,
  type ChatResponse,
  type ChatResponseChunk,
  type LLMChatParamsNonStreaming,
  type LLMChatParamsStreaming,
  type LLMMetadata,
  type ToolCallLLMMessageOptions,
} from "@llamaindex/core/llms";
import { tool } from "llamaindex";
import { z } from "zod";

type Options = ToolCallLLMMessageOptions;

interface Turn {
  tool?: { name: string; input: Record<string, unknown>; id: string };
  text?: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

const weatherTurns = (): Turn[] => [
  { tool: { name: "get_weather", input: { city: "Paris" }, id: "call_1" }, usage: { prompt_tokens: 12, completion_tokens: 5 } },
  { text: "It is sunny in Paris.", usage: { prompt_tokens: 30, completion_tokens: 7 } },
];

const initializers: Array<(this: unknown) => void> = [];

export class ScriptedLLM extends ToolCallLLM {
  supportToolCall = true;
  metadata: LLMMetadata = {
    model: "scripted-1",
    temperature: 0,
    topP: 1,
    contextWindow: 4096,
    tokenizer: undefined,
    structuredOutput: false,
  };
  private readonly turns: Turn[];

  constructor(turns: Turn[] = weatherTurns()) {
    super();
    this.turns = turns;
    for (const init of initializers) init.call(this);
  }

  chat(params: LLMChatParamsStreaming<object, Options>): Promise<AsyncIterable<ChatResponseChunk<Options>>>;
  chat(params: LLMChatParamsNonStreaming<object, Options>): Promise<ChatResponse<Options>>;
  async chat(
    params: LLMChatParamsStreaming<object, Options> | LLMChatParamsNonStreaming<object, Options>,
  ): Promise<AsyncIterable<ChatResponseChunk<Options>> | ChatResponse<Options>> {
    const turn = this.turns.shift() ?? { text: "done", usage: { prompt_tokens: 1, completion_tokens: 1 } };
    const options: Options = turn.tool ? { toolCall: [turn.tool] } : {};
    const message: ChatMessage<Options> = { role: "assistant", content: turn.text ?? "", options };
    if (params.stream) {
      return (async function* (): AsyncGenerator<ChatResponseChunk<Options>> {
        yield { delta: turn.text ?? "", raw: { choices: [{ delta: {} }] }, options };
        yield { delta: "", raw: { choices: [], usage: turn.usage }, options: {} };
      })();
    }
    return { message, raw: { choices: [{ finish_reason: turn.tool ? "tool_calls" : "stop" }], usage: turn.usage } };
  }
}

{
  const context = {
    kind: "method",
    name: "chat",
    static: false,
    private: false,
    access: { has: () => true, get: () => undefined },
    metadata: {},
    addInitializer: (init: (this: unknown) => void) => void initializers.push(init),
  } as never;
  const proto = ScriptedLLM.prototype as unknown as { chat: (...args: unknown[]) => unknown };
  // `@wrapEventCaller @wrapLLMEvent` applies bottom-up: wrapLLMEvent first.
  proto.chat = (wrapEventCaller as (m: unknown, c: never) => typeof proto.chat)(
    (wrapLLMEvent as (m: unknown, c: never) => typeof proto.chat)(proto.chat, context),
    context,
  );
}

export const getWeather = tool({
  name: "get_weather",
  description: "Current weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: ({ city }) => `sunny in ${city}`,
});

export const QUESTION = "weather in Paris?";
