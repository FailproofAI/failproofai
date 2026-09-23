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
  - `environment` and `baseDir` apply to the whole process — every copy of the
    SDK loaded into it (the ESM and CommonJS builds, or a copy a bundler put in a
    Next.js route) — so configure once, anywhere at startup.
- **`environment` defaults to `"dev"`.** Set it in `configure` or with
  `AGENTEYE_ENVIRONMENT`.
- **Scope outcomes**:
  - The body returned: `agent_end` with `outcome: "success"`.
  - The body threw: `error`, then `agent_end` with `outcome: "failed"`.
  - An `AbortError`: `agent_end` with `outcome: "cancelled"`.

  The error is always rethrown. A tool failure is recorded on its `tool_result` and
  emits no run-level `error`.
- **`error_type` is the error's class.** When an error's `name` is just `"Error"`
  (openai's `BadRequestError`, many SDK errors) the class name is recorded instead.
- **Timestamps order events within a millisecond.** The last three of the six
  fractional digits are a per-process sequence, not a measurement, so events
  emitted in the same millisecond still sort in the order they happened.
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

- **A normal exit is covered.** Buffered events flush on `process.on("exit")`, and
  the flush timer is `unref`'d, so importing the SDK never keeps a script alive.
- **Short-lived work that returns rather than exits** — a serverless handler, a
  queue job in a long-lived worker — should `await failproofai.flush()` before
  returning: the process lives on, so no exit flush comes.
- **Signals.** `SIGTERM` (every deploy, `docker stop`, a Kubernetes eviction) kills
  Node **without** running exit handlers. The SDK will not install a signal handler
  in your process (that would change what Ctrl-C does), so add one at startup:

```ts
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => {
    failproofai.flushSync();
    process.exit(code); // 128 + signal number: the orchestrator sees a termination, not a success
  });
}
```

  On the way out the SDK **closes whatever is still open**: an interrupted tool
  gets its `tool_result` with `error: "ProcessExit: …"`, and each open agent gets an
  `error` event and `agent_end` with `outcome: "failed"`, innermost first —
  including runs an adapter opened. So a deploy never leaves a run showing as
  running forever. (Python gets the same through `SystemExit` unwinding.) A
  `flushSync()` while the process carries on closes nothing.
- **Next.js:** put that handler in its own module and import it from
  `instrumentation.ts` behind the runtime check (see *Next.js* below) — `process.once`
  in `instrumentation.ts` itself makes Turbopack warn about the Edge runtime.

## A framework agent — turn it on

```ts
import * as failproofai from "@failproofai/sdk";

failproofai.configure({ environment: "production" });
await failproofai.instrument("langchain"); // name the framework you use
```

| Framework | Tested range | How it attaches |
|---|---|---|
| LangChain.js / LangGraph.js | `@langchain/core` 0.3 – 1.x, LangGraph 0.4 – 1.x | global callback configuration — no `callbacks:` needed. Or pass `langchainHandler()` yourself and patch nothing |
| Vercel AI SDK | `ai` 4 – 7 | `telemetry()` at the call site (every major); `instrument("ai")` process-wide on `ai` 7 only |
| Mastra | `@mastra/core` 0.20 – 1.x | `Agent.generate`/`.stream`, tool resolution, the workflow engine |
| LlamaIndex.TS | `llamaindex` 0.11.4 – 0.x | `Settings.callbackManager` plus `AgentWorkflow.runStream` |

**`instrument()` — the rules:**

- **Await it, before the first run.** An unawaited `instrument()` does not record
  nothing — it records a *wrong* trace: the root run starts before the adapter
  exists, so a graph node, a tool or a bare model call becomes the session's agent,
  or each becomes its own one-call session. The LangChain adapter warns when it sees
  this (`… started under a parent run the langchain adapter never saw …`); the
  others cannot tell it apart from a bare call.
- **Name the framework.** A bare `instrument()` patches *every* supported framework
  that resolves from the project — including ones installed but unused, and ones
  resolving from a parent directory's `node_modules`. It resolves to the names it
  instrumented, and `[]` plus a warning when it found nothing. An unknown name throws.
- **Options** go in the second argument, `instrument("<name>", { … })`:

  | Adapter | Options |
  |---|---|
  | `langchain` | `sessionId`, `captureContent` (default `true`), `includeChains`, `graphCallbacks`, `captureLimit` — also accepted by `langchainHandler({ … })` |
  | `llamaindex` | `captureMessages` (default `true`), `steps` (default `true`; `false` drops the workflow-step hooks), `embeddings`, `staleAfter`, `reaperInterval`, `captureLimit` |
  | `ai` | `registerGlobalTracer` (ai 4–6 only, see below), `captureLimit` |
  | `mastra` | `captureLimit` |

  Content capture is **on** by default: a LangGraph node's `hook_triggered` carries
  the message history as `input`, and a hand-written `model_request` carries what
  you pass. `captureContent: false` / `captureMessages: false` keep structure,
  durations and tokens and drop the text.

**The mapping is the Python SDK's.** An **agent** is anything that owns an LLM
decision loop: a graph or chain run, `generateText`/`streamText`, a Mastra agent or
workflow, a LlamaIndex agent run. A LangGraph node or a workflow step is a **hook**
(`hook_triggered`/`hook_completed` with a `trigger_event`), never a nested agent.
Model pairs carry token counts; tool pairs carry the model's own tool-call id. A
failure is recorded once, where it happened — a tool that throws is an `error` on its
`tool_result`, and if the model then recovers the run still ends `success`.

### Naming the agent, and owning the session id

`agent_id` is the facet every dashboard view groups by, and each framework takes it
from a different place. Set it, or you get the framework's default:

| Framework | `agent_id` comes from | Default when unset |
|---|---|---|
| LangGraph / LangChain | the root run's name: `createReactAgent({ name })`, or `.withConfig({ runName })` on a compiled graph | `"LangGraph"` |
| Vercel AI SDK | `functionId` in the call's telemetry settings — `telemetry({ functionId })`. An agent class's own `id` (`ToolLoopAgent({ id })`) is **not** passed through | `"ai.generateText"` / `"ai.streamText"` |
| Mastra | the agent's `name` (not its `id`, not its registration key). A workflow run is rooted under the **workflow's** id, with the agent nested under it | — |
| LlamaIndex.TS | `agent({ name })` | the class or operation name |

Mastra's `tool_name` is the key in the agent's `tools` map, not the `createTool` id.

An adapter mints a random session id when nothing is bound, and nothing reads it
back to you. To use your own — a request or job id, so a dashboard session and your
own logs or database share it — bind it around the framework call:

```ts
await failproofai.session({ sessionId: requestId }, () => graph.invoke(input));
```

`session()` emits nothing; the adapter's agent is the one agent. Wrapping in
`agent()` also works: under the **same** name as the framework agent it becomes that
agent (one `agent_start`); under a **different** name the framework agent nests
under yours (`parent_id` = your name), which is right when your wrapper is a real
outer agent. Inside either, `failproofai.current().sessionId` is the id.

Two consequences of owning it: a **retried** job that reuses its job id lands in the
**same** session, as a second run in it — append the attempt (`${jobId}-2`) if you
want retries separate. And LangChain also accepts it per call, as
`metadata: { failproofai_sdk_session_id }`.

### Per framework

- **Vercel AI SDK.** `telemetry()` at each call site works on every major and is the
  one way to name the agent. On `ai` 7, `instrument("ai")` covers every call in the
  process too; using both does not double-record.

```ts
import { telemetry } from "@failproofai/sdk/ai";

await generateText({
  model,
  prompt,
  telemetry: telemetry({ functionId: "answer-question" }), // ai 4–6: `experimental_telemetry:`
});
```

  On `ai` 4–6, `instrument("ai")` records nothing by itself and warns: the only
  process-wide hook there is the global OpenTelemetry tracer, and taking it would
  break the app's own tracing. `instrument("ai", { registerGlobalTracer: true })`
  opts in when the process runs no OpenTelemetry of its own. `await wrapModel(model)`
  (async — pass the resolved model) records model calls only; tools run above the
  model layer. In a route handler on `ai` 7, pass `abortSignal: request.signal` so a
  client that disconnects mid-stream closes the run instead of leaving it open.
- **Mastra.** `instrument("mastra")` is enough for agents on a `Mastra` instance,
  their tools, and workflows. `wrapTool(tool)` is only for a tool called directly —
  from your own code or a workflow step, not by an agent; `workflow(name, body)` only
  groups work that is not a Mastra workflow under one named span.
- **LlamaIndex.TS.** A tool or LLM call made *outside* an agent workflow is recorded
  as its own one-call run — that is how bare calls are shown, not a bug.

**Token counts — set usage on the model client, or they are silently missing.**
OpenAI-compatible APIs report usage on a stream only when asked, and some framework
clients stream even for a non-streaming call:

| Framework | Where | Needed for |
|---|---|---|
| Vercel AI SDK + `@ai-sdk/openai-compatible` | `createOpenAICompatible({ …, includeUsage: true })` | `streamText` |
| Mastra (same provider package) | `createOpenAICompatible({ …, includeUsage: true })` | `.stream()` |
| LlamaIndex.TS | `openai({ …, additionalChatOptions: { stream_options: { include_usage: true } } })` | **every** agent run — its agent streams internally even for `run()` |

LangChain's `ChatOpenAI` already asks. For any other client, check for
`input_tokens`/`output_tokens` on each `model_response` when you verify.

### Bundlers — the silent one

Most of these frameworks ship an ESM build and a CJS build. Node loads them as two
unrelated copies. The adapters patch the copy your app loads, plus a CJS copy that
something has already `require`d.

No adapter can reach a framework **bundled into your own output** (esbuild,
webpack, `ncc`). The copy in `node_modules` is not the one running, and nothing is
recorded. Either keep the framework external in the bundler config, or use the
call-site helpers, which work bundled: `langchainHandler()`, `telemetry()`,
`wrapTool()`.

### Next.js

`next build` bundles server dependencies by default. Wrap the config, and configure
and instrument from Next's startup hook:

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
  failproofai.configure({ environment: "production" });
  await failproofai.instrument("langchain");
  await import("./instrumentation-node"); // the signal handler from *Shutdown*
}
```

- `withFailproofai` adds LangChain, Mastra, LlamaIndex and the SDK to
  `serverExternalPackages` and keeps your own list. Without it, `instrument()` warns
  at **runtime** (the first request, not `next build`) for each framework it cannot
  reach, and those frameworks record nothing. If you list the packages by hand,
  `FAILPROOFAI_NEXT_EXTERNALS=1` silences the warning.
- The Vercel AI SDK is not externalized and does not need to be: `telemetry()` and
  `instrument("ai")` on `ai` 7 both work in a bundled route.
- `configure()` in `register()` applies to the whole server process, including a copy
  of the SDK bundled into a route.
- **Edge runtimes** (Next.js Edge routes, workers) get a no-op build. Importing is
  safe, and nothing is recorded there. Instrument the Node side.

## An agent with no framework — three edit sites

This is the path for a hand-built loop: an OpenAI or Anthropic client, a `for` loop
and a tool table. It also covers any framework without an adapter, whatever else the
agent does, such as writing its own records to a database. You emit the events
yourself with the same API the adapters use, so the trace is the same shape — and,
if you record what the snippet below records, the same quality.

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
async function callModel(messages: ChatCompletionMessageParam[]) {
  const requestId = randomUUID();
  const started = Date.now();
  failproofai.event.modelRequest({
    model: MODEL,
    requestId,
    // Plain role/content pairs: what a reader of the trace needs. (openai's own
    // message types do not satisfy the SDK's JSON types under `tsc --strict`.)
    messages: messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
    })),
    tools: TOOLS.map((t) => ({ name: t.function.name, description: t.function.description ?? "" })),
  });
  let reply;
  try {
    // Only the provider call in the `try`: nothing else can reach the error path.
    reply = await client.chat.completions.create({ model: MODEL, messages, tools: TOOLS });
  } catch (error) {
    failproofai.event.modelResponse({
      model: MODEL,
      requestId,
      stopReason: "error",
      error: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error),
      duration_ms: Date.now() - started,
    });
    throw error; // the enclosing agent() then ends "failed"
  }
  const choice = reply.choices[0];
  failproofai.event.modelResponse({
    model: reply.model,
    requestId,
    role: choice.message.role,
    content: choice.message.content ?? "",
    stopReason: choice.finish_reason,
    inputTokens: reply.usage?.prompt_tokens ?? null,
    outputTokens: reply.usage?.completion_tokens ?? null,
    duration_ms: Date.now() - started,
    tool_calls: (choice.message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name })),
  });
  return choice.message;
}

// 3. the tool dispatcher — reuse the model's own tool-call id
async function dispatch(call) {
  try {
    const input = JSON.parse(call.function.arguments || "{}"); // bad JSON → a tool error, not a crash
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
- **Record what the adapters record.** `role`, `content`, the tool calls the model
  asked for, tokens, stop reason and duration on the response. Leave them out and the
  trace has the shape but not the substance.
- **Pair model calls on `requestId`**, generated per call, so overlapping calls
  cannot cross-pair.
- **Model calls are not timed for you.** Pass `duration_ms` yourself — an integer
  (`Date.now()` differences are); a float throws `TypeError`.
- **Reuse the model's tool-call id** as `toolCallId`, so a `tool_use` lines up with
  the `tool_calls[]` entry that asked for it. `toolCall()` times the call and records
  a throw as `tool_result.error`, then rethrows.
- **Services and workers.** Pass your own request or job id as `sessionId`
  (`agent("assistant", { sessionId: jobId }, fn)`). A dashboard session and the
  record in your own logs or database are then the same string. (Retries: see
  *Naming the agent, and owning the session id*.)
- **Sub-agents.** Nest `agent()` calls — directly, or from inside a tool the outer
  agent runs. The inner one joins the session, and its `parent_id` is the outer
  agent's name.
- **Don't reach for a module-level session variable.** Two overlapping runs mix
  their events. `AsyncLocalStorage` already does this correctly.
- **Types are the only guard on names in plain JavaScript.** A misspelt required
  option (`toolCallID`) is not a runtime error: the event is written without it and
  never pairs. Use TypeScript, or check the ids when you verify.
- **`input` is typed as an object.** The SDK does not reject a primitive at
  runtime, so wrap it yourself: `{ query: q }`.
- **Watch the size of `messages`.** Each `model_request` carries whatever you pass,
  and the history grows every turn — including provider blobs such as encrypted
  reasoning. Send role/content, and trim what a reader does not need.
- **Don't emit your own `agent_end` inside `agent()`.** The scope emits one; a second
  is accepted and duplicates it.

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

**On a machine running `failproofaid`, that directory is empty seconds after a
healthy run** — the daemon ships each file and deletes it. An empty real spool
means nothing; check with a throwaway spool the daemon does not watch. Use a
directory of your own, so parallel checks on one machine cannot delete each other's:

```bash
export FAILPROOFAI_HOME="$(mktemp -d)"
npx tsx your-agent.ts          # Next.js: set it on `next start`
node -e '
  const fs = require("fs"), d = process.env.FAILPROOFAI_HOME + "/custom-agents/events";
  for (const f of fs.readdirSync(d).filter(f => f.endsWith(".jsonl")).sort())
    for (const l of fs.readFileSync(d + "/" + f, "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(l);
      console.log(e.timestamp, e.session_id, e.agent_id, e.type, e.tool_name ?? "",
        e.tool_call_id ?? e.request_id ?? "", e.input_tokens ?? "", e.output_tokens ?? "",
        e.outcome ?? "", e.error ?? "", e.environment);
    }'
```

Then walk the same checklist as `SKILL.md` §5 (its first item — a dead flush
thread — is Python's; the TypeScript SDK logs `[failproofai-sdk]` warnings to
stderr instead):

1. **One `agent_start`/`agent_end` pair per agent per run** — two when a sub-agent
   runs, each with the right `parent_id`. No files at all usually means one of these:
   - The process was killed by a signal with no handler, or returned from a
     serverless handler without `await failproofai.flush()`.
   - `instrument()` found nothing, or was not awaited: look for the
     `[failproofai-sdk]` warning on stderr.
   - The framework is bundled.
2. **Every pair closed, with the ids you expect** — each
   `model_request`/`model_response` on `request_id`, each `tool_use`/`tool_result` on
   `tool_call_id` — and **token counts** on every `model_response` (missing on
   streams: see *Token counts*).
3. **Two overlapping runs give two session ids, with no events crossing.**
4. **`environment` is the label you expect** on every event.
5. **The `agent_id`s are your names**, not `LangGraph` or `ai.generateText`.

Then confirm the real thing arrived, from a separate environment, with the
`fp-cloud-cli` skill: `fp sessions --session-id <id> --since 1h` (the id you bound
with `session()`, or read with `failproofai.current()`).
