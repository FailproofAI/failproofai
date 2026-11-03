// The core SDK with no framework: scopes, all 15 `event.*` methods, flush.
// Run under Node, Bun and Deno by `runtimes.core.test.ts`: `<runtime> agent.{mjs,cjs} <case>`.
import * as failproofai from "@failproofai/sdk";

const { agent, event, session, toolCall } = failproofai;
const report = (value: unknown) => console.log(JSON.stringify(value));

/** Every public surface once, in one session. */
async function core(): Promise<void> {
  await session({ sessionId: "core-session" }, async () => {
    await agent("planner", { goal: "smoke every surface" }, async () => {
      event.modelRequest({ model: "mock-model", messages: [{ role: "user", content: "hi" }], requestId: "r-1" });
      event.modelResponse({ model: "mock-model", stopReason: "stop", inputTokens: 3, outputTokens: 2, content: "hello", requestId: "r-1" });
      await toolCall("lookup", { toolCallId: "call-1", input: { q: "x" } }, async (call) => {
        call.output = { found: true };
      });
      event.toolUse({ toolName: "manual", toolCallId: "call-2", input: { a: 1 } });
      event.toolResult({ toolName: "manual", toolCallId: "call-2", output: "ok" });
      event.hookTriggered({ hookName: "guard", hookId: "h-1", triggerEvent: "pre_tool" });
      event.hookCompleted({ hookName: "guard", hookId: "h-1", outcome: "allowed" });
      event.agentPause({ pauseId: "p-1", reason: "approval" });
      event.humanWait({ inputId: "i-1", prompt: "approve?" });
      event.humanInput({ inputId: "i-1", response: "yes" });
      event.agentResume({ pauseId: "p-1" });
      event.humanPause({ reason: "coffee" });
      event.humanInterrupt({ reason: "stop that", atStep: "2" });
      event.error({ errorType: "Recoverable", message: "retrying" });
      await agent("helper", async () => {
        event.modelRequest({ model: "mock-model", requestId: "r-2" });
        event.modelResponse({ model: "mock-model", stopReason: "stop", inputTokens: 1, outputTokens: 1, requestId: "r-2" });
      });
    });
  });
  await failproofai.flush();
  report({ core: "done" });
}

async function main(scenario: string): Promise<void> {
  switch (scenario) {
    case "core":
      await core();
      break;
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

main(process.argv[2] ?? "core").catch((error: unknown) => {
  console.error("FATAL", error);
  process.exit(1);
});
