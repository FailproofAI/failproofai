// The core SDK with no framework: scopes, all 15 `event.*` methods, flush —
// and the short-lived-handler shapes (AWS Lambda and the like). Run under
// Node, Bun and Deno by `runtimes.core.test.ts`: `<runtime> agent.{mjs,cjs} <case>`.
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

/**
 * A serverless handler: one agent run, then return. What happens AFTER the
 * return is the runtime's choice, and each case below is one of them.
 */
async function handler(invocation: number, flush: boolean): Promise<{ ok: true }> {
  await session({ sessionId: `lambda-${invocation}` }, async () => {
    await agent("lambda-agent", async () => {
      event.modelRequest({ model: "mock-model", requestId: `r-${invocation}` });
      event.modelResponse({ model: "mock-model", stopReason: "stop", inputTokens: 5, outputTokens: 1, requestId: `r-${invocation}` });
    });
  });
  if (flush) await failproofai.flush();
  return { ok: true };
}

/**
 * The execution environment freezing — or reclaiming — the sandbox the moment
 * the handler's promise settles. No further JavaScript runs: no interval, no
 * `exit` listener. SIGKILL is the faithful stand-in; a frozen sandbox that is
 * later discarded is indistinguishable from it on disk.
 */
function frozen(): never {
  process.kill(process.pid, "SIGKILL");
  // Unreachable: SIGKILL cannot be caught.
  throw new Error("still running after SIGKILL");
}

async function main(scenario: string): Promise<void> {
  switch (scenario) {
    case "core":
      await core();
      break;
    case "lambda-flush":
      // The documented pattern: `await flush()` before returning.
      report(await handler(1, true));
      frozen();
      break;
    case "lambda-no-flush":
      // No flush, and the sandbox is frozen/reclaimed right after the return.
      report(await handler(1, false));
      frozen();
      break;
    case "lambda-return":
      // No flush, but the process is allowed to end normally: the `exit`
      // listener writes what the interval had not.
      report(await handler(1, false));
      break;
    case "lambda-sigterm":
      // No flush; the platform sends SIGTERM and the app installed no handler.
      // Node's default for SIGTERM terminates WITHOUT running `exit` listeners.
      report(await handler(1, false));
      process.kill(process.pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      break;
    case "lambda-warm":
      // A warm container: several invocations in one process, each flushing,
      // then reclaimed.
      for (const invocation of [1, 2, 3]) report(await handler(invocation, true));
      frozen();
      break;
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

main(process.argv[2] ?? "core").catch((error: unknown) => {
  console.error("FATAL", error);
  process.exit(1);
});
