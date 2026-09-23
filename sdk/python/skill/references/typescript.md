# TypeScript and JavaScript agents — `@failproofai/sdk`

Everything in `SKILL.md` §2 (plan) and §6 (production) applies unchanged. The
TypeScript SDK writes the **same 15 events, the same wire format, into the same
spool directory** as the Python one, and `failproofaid` ships both. A fleet running
both languages writes into one pipe, and the dashboard cannot tell which language
wrote what. This page is what differs: install, names, adapters, bundlers, runtimes,
shutdown and verification.

## Install

```bash
npm install @failproofai/sdk        # or: pnpm add / yarn add / bun add
```

Node ≥ 20.9, Bun, or Deno (`npm:@failproofai/sdk`). ES modules and CommonJS both
work. It has zero runtime dependencies. The framework packages are optional peer
dependencies, loaded only when you ask for them.

```ts
import * as failproofai from "@failproofai/sdk";        // ESM
// const failproofai = require("@failproofai/sdk");     // CommonJS
```

Confirm what you have:

```bash
node -e 'console.log(require("@failproofai/sdk").version)'
```

| Import | What it holds |
|---|---|
| `@failproofai/sdk` | scopes, `event.*`, `configure`, `flush`/`flushSync`, `instrument`/`uninstrument` |
| `@failproofai/sdk/langchain` | `langchainHandler()` — a callback handler, no patching |
| `@failproofai/sdk/ai` | `telemetry()`, `wrapModel()` for the Vercel AI SDK |
| `@failproofai/sdk/mastra` | `wrapTool()`, `workflow()` |
| `@failproofai/sdk/llamaindex` | the LlamaIndex.TS adapter's options and helpers (`instrument("llamaindex")` is the usual entry) |
| `@failproofai/sdk/next` | `withFailproofai()` for `next.config` |
| `@failproofai/sdk/evaluator` | the evaluator worker — see `evaluator.md` |

The root import deliberately does not re-export the subpaths.

## Names: camelCase in, snake_case on the wire

Every Python name has a camelCase twin, and the file on disk is identical:

| Python | TypeScript |
|---|---|
| `failproofai_sdk.agent("x", goal=g)` | `failproofai.agent("x", { goal: g }, fn)` |
| `failproofai_sdk.tool_call(...)` | `failproofai.toolCall(name, { toolCallId, input }, fn)` |
| `failproofai_sdk.session(session_id=...)` | `failproofai.session({ sessionId }, fn)` |
| `event.tool_use(tool_name=, tool_call_id=)` | `event.toolUse({ toolName, toolCallId })` |
| `event.model_response(input_tokens=, stop_reason=, request_id=)` | `event.modelResponse({ inputTokens, stopReason, requestId })` |
| `event.error(error_type=, message=)` | `event.error({ errorType, message })` |
| `event.human_wait(input_id=)` / `agent_pause(pause_id=)` / `hook_triggered(hook_id=, trigger_event=)` | `inputId` / `pauseId` / `hookId`, `triggerEvent` |
| `configure(base_dir=, flush_interval=, environment=)` | `configure({ baseDir, flushInterval, environment })` |
| `failproofai_sdk._writer.flush_now()` | `await failproofai.flush()` / `failproofai.flushSync()` |
| `propagate(fn)` | `propagate(fn)` |

**Only declared option names are camelCase.** Any other key is a custom payload
field and is written **verbatim**, so `duration_ms` stays `duration_ms`. A camelCase
typo of a declared name (`toolCallID`) is not an error: it becomes a new field, and
nothing tells you.

## The contract, in TypeScript

`SKILL.md` §3 holds, with these spellings:

- **Identity is ambient.** It rides on `AsyncLocalStorage`, so it follows `await`,
  `.then()`, timers and callbacks created inside the scope. Two concurrent runs in
  one process never mix. A callback **stored** in one run and invoked from another
  does not inherit it: wrap it with `failproofai.propagate(fn)`.
- **No session bound and none passed throws `TypeError`** from `event.*` and
  `toolCall()`. `agent()` and `session()` mint a fresh session instead. A non-string id also
  throws `TypeError`. An empty or whitespace id throws `Error`. `agentId` falls back
  to `"main"`.
- **A reserved extra throws.** `timestamp`, `session_id`, `agent_id`, `type` and
  `environment` cannot be custom fields.
- **Token counts must be integers.** `inputTokens: 12.5` throws `TypeError`.
  `null` is fine: the key is omitted.
- **`duration_ms` is refused on the four paired closers**: `toolResult`,
  `hookCompleted`, `humanInput` and `agentResume`. They compute it. On every other
  method, including `modelResponse`, it is accepted as a custom field, and that is
  how you time a model call yourself.
- **`configure()`**: call it once, at startup, before the first event.
  - Omitted options reset to their defaults.
  - Nothing is applied unless every option validates.
  - A comma in `environment` throws.
  - A comma in `AGENTEYE_ENVIRONMENT` does not throw. It warns and falls back to
    `"dev"`.
- **`environment` defaults to `"dev"`.** Set it in `configure` or with
  `AGENTEYE_ENVIRONMENT`.
- **Scope outcomes**:
  - The body returned: `agent_end` with `outcome: "success"`.
  - The body threw: `error`, then `agent_end` with `outcome: "failed"`.
  - An `AbortError`: `agent_end` with `outcome: "cancelled"`.

  The error is always rethrown. A tool failure is recorded on its `tool_result` and
  emits no run-level `error`.
- **Unencodable values never take the process down.** Circular references,
  `BigInt`, throwing getters and lone surrogates are handled. One bad event is
  dropped alone, not the batch around it.
- **Credentials are redacted before the bytes reach disk.** That covers API keys,
  tokens, JWTs and bearer headers.
- **The SDK's own warnings go to stderr, prefixed `[failproofai-sdk]`.**
  - Route them with `failproofai.setLogger({ debug, info, warn, error })`.
  - Set verbosity with `FAILPROOFAI_SDK_LOG_LEVEL`: `debug`, `info`, `warn`
    (the default), `error` or `silent`.
  - `FAILPROOFAI_SDK_STRICT=1` makes a swallowed adapter failure throw.

## Shutdown — the part that loses data

- **Exit handler.** Buffered events flush on `process.on("exit")`, and the flush
  timer is `unref`'d, so importing the SDK never keeps a script alive.
- **Short-lived work.** A short script, a CLI, a serverless handler or a queue job
  that exits after its last event must `await failproofai.flush()` before
  returning. The interval alone does not guarantee delivery.
- **Signals.** `SIGTERM` (every deploy, `docker stop`, a Kubernetes eviction) kills
  Node **without** running exit handlers. The SDK will not install a signal handler
  in your process, so add one at startup:

```ts
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    failproofai.flushSync();
    process.exit(0);
  });
}
```

## A framework agent — turn it on

```ts
import * as failproofai from "@failproofai/sdk";

failproofai.configure({ environment: "production" });
await failproofai.instrument();              // every supported framework it can resolve
// await failproofai.instrument("langchain"); // exactly one; an unknown name throws
```

| Framework | Tested range | How it attaches |
|---|---|---|
| LangChain.js / LangGraph.js | `@langchain/core` 0.3 – 1.x, LangGraph 0.4 – 1.x | global callback configuration — no `callbacks:` needed. Or pass `langchainHandler()` yourself and patch nothing |
| Vercel AI SDK | `ai` 4 – 7 | `telemetry()` at the call site (every major); `instrument("ai")` process-wide on `ai` 7 only |
| Mastra | `@mastra/core` 0.20 – 1.x | `Agent.generate`/`.stream`, tool resolution, the workflow engine |
| LlamaIndex.TS | `llamaindex` 0.11.4 – 0.x | `Settings.callbackManager` plus `AgentWorkflow.runStream` |

Differences from Python:

- **`instrument()` is async.** Await it before the first run.
- **Auto-detect uses installed packages, not imported ones.** It detects what
  resolves from your project, so the Python ordering rule does not apply.
- **What it returns.** It resolves to the names it newly instrumented, and `[]` plus
  a warning when it found nothing.
- **The mapping is the Python SDK's.**
  - An **agent** is anything that owns an LLM decision loop: a graph or chain run,
    `generateText`/`streamText`, a Mastra agent, a LlamaIndex agent run.
  - A LangGraph node or a workflow step is a **hook**
    (`hook_triggered`/`hook_completed` with a `trigger_event`), never a nested agent.
  - Model pairs carry token counts. Tool pairs carry the model's own tool-call id.
  - A failure is recorded once, where it happened.
- **Vercel AI SDK 4–6: `instrument("ai")` records nothing by itself** and logs a
  warning saying so. The only process-wide hook on those majors is the global
  OpenTelemetry tracer, and taking it would break the app's own OpenTelemetry. Use
  the call-site form:

```ts
import { telemetry } from "@failproofai/sdk/ai";

await generateText({
  model,
  prompt,
  experimental_telemetry: telemetry({ functionId: "answer-question" }), // ai 7: `telemetry:`
});
```

  `instrument("ai", { registerGlobalTracer: true })` opts in when the process runs
  no OpenTelemetry of its own. `await wrapModel(model)` (it is async; pass the
  resolved model, not the promise) records model calls only, because
  tools run above the model layer.
- **Streamed token counts.** LlamaIndex and Mastra only get usage on a stream when
  the model client asks for it:
  - LlamaIndex: `additionalChatOptions: { stream_options: { include_usage: true } }`
  - Mastra: `includeUsage: true` on an OpenAI-compatible provider

  Otherwise those model calls arrive with no tokens.
- **Mixing adapters and hand-written events.** Wrap a framework call in your own
  `failproofai.agent(...)` and the adapter's events join that session, with your
  agent as their parent.

### Bundlers — the silent one

Most of these frameworks ship an ESM build and a CJS build. Node loads them as two
unrelated copies. The adapters patch the copy your app loads, plus a CJS copy that
something has already `require`d.

No adapter can reach a framework **bundled into your own output** (esbuild,
webpack, `ncc`). The copy in `node_modules` is not the one running, and nothing is
recorded. Either keep the framework external in the bundler config, or use the
call-site helpers, which work bundled: `langchainHandler()`, `telemetry()`,
`wrapTool()`.

**Next.js bundles server dependencies by default.** Wrap the config and instrument
from Next's startup hook:

```ts
// next.config.ts
import { withFailproofai } from "@failproofai/sdk/next";
export default withFailproofai({ /* your config */ });
```

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const failproofai = await import("@failproofai/sdk");
  await failproofai.instrument();
}
```

`withFailproofai` adds LangChain, Mastra, LlamaIndex and the SDK to
`serverExternalPackages` and keeps your own list. Without it, `instrument()` warns
once per framework it cannot reach. If you list the packages by hand,
`FAILPROOFAI_NEXT_EXTERNALS=1` silences the warning.

**Edge runtimes** (Next.js Edge routes, workers) get a no-op build. Importing is
safe, and nothing is recorded there. Instrument the Node side.

## An agent with no framework — three edit sites

This is the path for a hand-built loop: an OpenAI or Anthropic client, a `for` loop
and a tool table. It also covers any framework without an adapter, whatever else the
agent does, such as writing its own records to a database. You emit the events
yourself with the same API the adapters use, so the trace is the same shape and the
same quality.

Every hand-built agent already has these three places, whatever its functions are
called. Find them in the codebase first:

| Where | Add | Emits |
|---|---|---|
| where **one run** starts and ends | `failproofai.agent("name", { goal }, async () => …)` | `agent_start` / `agent_end` |
| the **one function that calls the model** | `event.modelRequest` before, `event.modelResponse` after — **both halves, even on failure** | one pair per model turn |
| the **one function that runs tools** | `failproofai.toolCall(name, { toolCallId, input }, () => run())` | `tool_use` / `tool_result` |

```ts
import { randomUUID } from "node:crypto";
import * as failproofai from "@failproofai/sdk";

// 1. the run — everything inside lands on this session, with no ids passed
const answer = await failproofai.agent("inventory", { goal: question }, async () => {
  for (let turn = 0; turn < 6; turn++) {
    const message = await callModel(messages);
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) return message.content ?? "";
    messages.push(message);
    for (const call of calls) {
      messages.push({ role: "tool", tool_call_id: call.id, content: await dispatch(call) });
    }
  }
  return "(gave up)";
});

// 2. the model call — pair on requestId, time it yourself, close it on failure
async function callModel(messages) {
  const requestId = randomUUID();
  const started = Date.now();
  failproofai.event.modelRequest({ model: MODEL, requestId, messages });
  try {
    const reply = await client.chat.completions.create({ model: MODEL, messages, tools });
    failproofai.event.modelResponse({
      model: reply.model,
      requestId,
      stopReason: reply.choices[0].finish_reason,
      inputTokens: reply.usage?.prompt_tokens ?? null,
      outputTokens: reply.usage?.completion_tokens ?? null,
      duration_ms: Date.now() - started,
    });
    return reply.choices[0].message;
  } catch (error) {
    failproofai.event.modelResponse({
      model: MODEL,
      requestId,
      stopReason: "error",
      error: String(error),
      duration_ms: Date.now() - started,
    });
    throw error; // the enclosing agent() then ends "failed"
  }
}

// 3. the tool dispatcher — reuse the model's own tool-call id
async function dispatch(call) {
  const input = JSON.parse(call.function.arguments || "{}");
  try {
    return await failproofai.toolCall(call.function.name, { toolCallId: call.id, input }, () =>
      runTool(call.function.name, input),
    );
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`; // let the model recover
  }
}
```

The rules that make this correct:

- **Emit both halves of the model pair.** A `modelRequest` with no `modelResponse`
  is a span the dashboard shows as running forever — hence the `catch`.
- **Pair model calls on `requestId`**, generated per call, so overlapping calls
  cannot cross-pair.
- **Model calls are not timed for you.** Pass `duration_ms` yourself.
- **Reuse the model's tool-call id** as `toolCallId`, so a `tool_use` lines up with
  the `tool_calls[]` entry that asked for it. `toolCall()` times the call and records
  a throw as `tool_result.error`, then rethrows.
- **Services and workers.** Pass your own request or job id as `sessionId`
  (`agent("assistant", { sessionId: requestId }, fn)`). A dashboard session and the
  record in your own logs or database are then the same string.
- **Sub-agents.** Nest `agent()` calls. The inner one joins the session, and its
  `parent_id` is the outer agent's name.
- **Don't reach for a module-level session variable.** Two overlapping runs mix
  their events. `AsyncLocalStorage` already does this correctly.
- **`input` is typed as an object.** The SDK does not reject a primitive at
  runtime (plain JavaScript can pass one), so wrap it yourself: `{ query: q }`.

The complete, runnable version is `sdk/typescript/examples/research-agent.ts` in the
FailproofAI/failproofai repo. CI runs it, as an ES module and as CommonJS, against
the real `openai` client.

**`using`, when a callback will not fit.** Use it for a scope opened in a
constructor and closed in a teardown:

```ts
{
  using span = failproofai.agent.open("planner", { goal });
  using call = failproofai.toolCall.open("search", { input: { q } });
  call.call.output = await search(q);
} // tool_result, then agent_end
```

Prefer the callback form. It has nothing to unwind.

## Verify

The spool is the same directory the Python SDK uses:
`${FAILPROOFAI_HOME:-~/.failproofai}/custom-agents/events/`, unless the app passed
`configure({ baseDir })`.

A throwaway loop that touches nothing real:

```bash
export FAILPROOFAI_HOME=/tmp/fpai-ts-test
rm -rf /tmp/fpai-ts-test && npx tsx your-agent.ts
node -e '
  const fs = require("fs"), d = "/tmp/fpai-ts-test/custom-agents/events";
  for (const f of fs.readdirSync(d).filter(f => f.endsWith(".jsonl")).sort())
    for (const l of fs.readFileSync(d + "/" + f, "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(l);
      console.log(e.session_id, e.agent_id, e.type, e.tool_name ?? "", e.duration_ms ?? "");
    }'
```

Then walk the same checklist as `SKILL.md` §5:

1. **Is there exactly one `agent_start` per run?** No files at all usually means
   one of these:
   - The process exited before a flush: a short script without
     `await failproofai.flush()`, or a signal with no handler.
   - `instrument()` found nothing: look for the `[failproofai-sdk]` warning on
     stderr.
   - The framework is bundled.
2. **Is every pair closed, with the ids you expect?** Check each
   `model_request`/`model_response` and each `tool_use`/`tool_result`.
3. **Do two overlapping runs produce two session ids, with no events crossing?**
4. **Is `environment` the label you expect?**
