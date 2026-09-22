# @failproofai/sdk

Telemetry for TypeScript and JavaScript AI agents. Emit events, spool them to
disk, let the daemon ship them.

Zero runtime dependencies. Node ≥ 20.9, ESM and CommonJS.

```bash
npm install @failproofai/sdk
```

```ts
import * as failproofai from "@failproofai/sdk";

await failproofai.agent("planner", { goal: question }, async () => {
  const hits = await failproofai.toolCall("web_search", { input: { q } }, () => search(q));
  failproofai.event.modelResponse({ model, inputTokens: 1_200, outputTokens: 340 });
});
```

That is the whole setup. Events land in `~/.failproofai/custom-agents/events/`,
and `failproofaid` — the daemon the `failproofai` CLI installs — picks them up.
Nothing here opens a socket, and nothing blocks your agent loop on the network.

This is the TypeScript counterpart to the Python
[`failproofai-sdk`](https://pypi.org/project/failproofai-sdk/). Same 15 events,
same wire format, same spool directory: a fleet running both writes into one
pipe, and the dashboard cannot tell which language wrote what.

---

## Three surfaces

### 1. Scopes

`session()`, `agent()` and `toolCall()` bind run identity and — for the latter
two — bracket the work with its own events.

```ts
await failproofai.session({ sessionId: requestId }, async () => {
  await failproofai.agent("supervisor", { goal: "answer the question" }, async () => {
    await failproofai.agent("researcher", async () => {
      // parentId is "supervisor", sessionId is requestId — nothing was passed.
      const docs = await failproofai.toolCall("search", { input: { q } }, () => search(q));
    });
  });
});
```

Identity rides on `AsyncLocalStorage`, so it follows `await`, `.then()`, timers
and callbacks created inside the scope — and two concurrent runs in one process
never mix.

| what happened | events | `outcome` |
|---|---|---|
| the block returned | `agent_end` | `"success"` (or your `outcome`) |
| the block threw | `error`, then `agent_end` | `"failed"` |
| an `AbortError` | `agent_end` only | `"cancelled"` |

The error is always re-thrown. A tool failure is recorded on the leaf
(`tool_result` with an `error`) and emits **no** run-level `error`: one the
agent loop catches is not a run failure, and one that propagates is reported
exactly once, by the enclosing `agent()`.

A synchronous body stays synchronous — `agent("x", () => 1)` returns `1`, not a
promise — because a constructor or an `EventEmitter` listener cannot await one.

**`using`, when a callback will not fit.** A scope opened in a constructor and
closed in a teardown, or one that straddles existing control flow:

```ts
{
  using span = failproofai.agent.open("planner", { goal });
  using call = failproofai.toolCall.open("search", { input: { q } });
  call.call.output = await search(q);
}  // tool_result, then agent_end
```

Prefer the callback form. It runs inside `AsyncLocalStorage.run()`, so there is
nothing to unwind and the whole class of "opened here, closed over there" bugs
is unreachable.

### 2. Adapters

```ts
await failproofai.instrument();              // whatever it can find
await failproofai.instrument("langchain");   // exactly one
failproofai.uninstrument();                  // put everything back
```

| framework | how it attaches |
|---|---|
| **LangChain.js / LangGraph.js** | `CallbackManager.configure`, so every `invoke`/`stream`/`batch` is covered without passing `callbacks:` anywhere. LangGraph nodes become their own agent spans. |
| **Vercel AI SDK** | Call-site APIs — see below. ES-module exports cannot be patched. |
| **Mastra** | `Agent.prototype.generate`/`.stream` (and the `…VNext` variants) plus `createTool`. |
| **LlamaIndex.TS** | `Settings.callbackManager` — subscribed, never patched. |

Everything an adapter records is namespaced `fw_*`, bounded per field and per
event, and tagged with `framework` / `framework_version`. An adapter that fails
is logged and skipped; the others still install, because a broken LlamaIndex
should not cost you LangGraph. `FAILPROOFAI_SDK_STRICT=1` turns every swallowed
failure into a throw.

**The Vercel AI SDK** exports plain functions from an ES module, and an ES
module namespace is immutable by specification — there is nowhere to stand. So
it uses the two extension points the SDK itself documents:

```ts
import { telemetry } from "@failproofai/sdk/ai";

const { text } = await generateText({
  model,
  prompt,
  experimental_telemetry: telemetry({ functionId: "answer-question" }),
});
```

That is the complete integration: an agent span, model request/response with
token counts, and every tool call. If you would rather not pass it at each call
site, wrap the model once instead — that sees model calls only, because tool
calls happen above the model layer:

```ts
import { wrapModel } from "@failproofai/sdk/ai";
const model = await wrapModel(openai("gpt-4o"));
```

Using both is fine: the middleware notices an open tracer span and defers, so
each call is recorded once.

**Mastra and LangChain** have call-site helpers too, for tools built before
`instrument()` ran and for hosts where patching is not wanted:

```ts
import { wrapTool, workflow } from "@failproofai/sdk/mastra";
import { langchainHandler } from "@failproofai/sdk/langchain";
```

### 3. `event.*`

The 15 event methods, for anything the adapters do not cover:

`toolUse` · `toolResult` · `modelRequest` · `modelResponse` · `agentStart` ·
`agentEnd` · `agentPause` · `agentResume` · `hookTriggered` · `hookCompleted` ·
`error` · `humanWait` · `humanInput` · `humanPause` · `humanInterrupt`

```ts
failproofai.event.humanWait({ inputId: "approval-1", prompt: "Ship it?" });
// …later, from anywhere in the same session:
failproofai.event.humanInput({ inputId: "approval-1", response: "yes" });
```

`sessionId` and `agentId` are optional on every one — omitted, they resolve from
the enclosing scope. Nothing bound and nothing passed is an **error**, never a
silent drop: ingest skips an event with no session and answers `200 OK`, so the
run would simply never appear.

The paired events (`toolResult`, `agentResume`, `hookCompleted`, `humanInput`)
compute `duration_ms` from the matching start. You cannot pass it yourself — a
reported duration is unfalsifiable.

Any key you add that the method does not name becomes a custom payload field.
Namespace anything framework-specific `fw_*`; a name that collides with a
declared field is refused rather than silently overwriting a promoted column.

---

## Configuration

```ts
failproofai.configure({
  environment: "production",  // or AGENTEYE_ENVIRONMENT; defaults to "dev"
  flushInterval: 0.5,         // seconds
  baseDir: undefined,         // the ONLY way to move the spool
});
```

Call it once at startup, before any `event.*` call. Nothing is applied unless
all of it validates, so a rejected call leaves the SDK exactly as it was.

| variable | effect |
|---|---|
| `AGENTEYE_ENVIRONMENT` | the `environment` label on every event |
| `FAILPROOFAI_HOME` | moves the umbrella; the spool is always `<home>/custom-agents` |
| `FAILPROOFAI_SDK_LOG_LEVEL` | `debug` \| `info` \| `warn` (default) \| `error` \| `silent` |
| `FAILPROOFAI_SDK_STRICT` | `1` makes a swallowed adapter failure throw |
| `FAILPROOFAI_SDK_STRICT_INTEGRATIONS` | `1` makes a framework-version warning throw |

No environment variable can move the spool off the umbrella. A redirect with no
confirmation and no error means batches land where nothing reads them, and an
unread spool is indistinguishable from an idle one.

Route the SDK's own log lines into your logger with
`failproofai.setLogger({ debug, info, warn, error })`.

## Shutdown

Buffered events are flushed on `process.on("exit")` automatically.

A process killed by a signal never reaches that — Node's default for `SIGTERM`
is to terminate without running exit handlers — so a containerised agent loses
whatever the last interval had not yet written. **This package will not install
a signal handler for you**: registering one changes the process's behaviour (a
listener suppresses Node's default termination), and a library that silently
stopped Ctrl-C from working would be worse than the lost events. Two lines, at
your own startup:

```ts
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    failproofai.flushSync();
    process.exit(0);
  });
}
```

A short-lived script or a serverless handler should `await failproofai.flush()`
before returning: the interval alone does not guarantee delivery, and a function
that returns right after its last event routinely exits before the next cycle.

---

## Evaluations

```ts
import { Evaluator, EvalResult, Score } from "@failproofai/sdk/evaluator";

export const app = new Evaluator({ name: "my-evals", version: "1" });

app.eval("tool_success_rate", { version: "1" }, (session) => {
  const results = session.eventsOfType("tool_result");
  const failures = results.filter((event) => event.payload.error != null).length;
  return new EvalResult({
    score: new Score(results.length === 0 ? 1 : 1 - failures / results.length),
    reasoning: `${failures} of ${results.length} tool calls failed`,
  });
});
```

```bash
FAILPROOFAI_EVALUATOR_URL=https://… \
FAILPROOFAI_EVALUATOR_TOKEN=… \
npx failproofai-evaluator ./my-evals.js
```

The worker claims assignments, runs each definition's condition, submits a plan,
runs the planned evaluations under a heartbeat, and submits each result.

**An evaluation must yield.** A synchronous function that never returns blocks
the one thread there is, and no timeout can fire while it does. Write `async`
evaluations, or let the sandbox run them.

### The sandbox

Server-authored ("managed") evaluations arrive as source. This package runs them
through a restricted expression language that is **parsed and interpreted** —
never `eval`'d, never handed to `node:vm`.

That is not belt-and-braces. JavaScript has a reachable path from any value to
arbitrary code:

```js
(() => {}).constructor("return process")()
x["constructor"]["constructor"]("…")()
```

A static allowlist cannot close the second one, because the key is computed at
runtime and no source check can see it. `node:vm` does not close it either — a
vm context has its own `Function`. Interpreting removes the question: every
property read goes through one function that checks the actual key at the moment
of the read, and the interpreter never constructs a function.

A `worker_threads` sandbox sits around that with V8 heap limits, a wall-clock
`terminate()`, a bounded result and a cap on concurrent sandboxes. That is the
RESOURCE bound — it stops a permitted expression from eating the worker even
though every operation in it is individually legal. If the sandbox cannot be
established, managed source is **refused**, never run unbounded.

---

## What it will not do to your process

* **It will not block your agent loop.** Events go into an in-memory queue; a
  timer writes them. The timer is `unref`'d, so importing this package never
  stops a script exiting.
* **It will not grow without bound.** The queue is capped by count *and* by
  measured bytes. Past either, the oldest events are discarded and a warning
  says so — a telemetry outage must not become an OOM kill.
* **It will not take the process down.** One unencodable event is dropped
  alone, not the batch around it. A throwing getter, a circular reference, a
  `BigInt`, a lone surrogate: each is handled rather than propagated.
* **It will not leave a half-written batch.** Content is `fsync`ed before an
  atomic rename, the directory is `fsync`ed after, and a failed write cleans up
  its temporary file.
* **It will not leave transcripts world-readable.** Batches are `0600` inside a
  `0700` directory. They carry goals, prompts, tool arguments and tool output.
* **It will not ship credentials.** API keys, tokens, JWTs, bearer headers and
  secret-shaped assignments are redacted before the bytes reach disk. The daemon
  redacts again before upload.

## Zero dependencies, on purpose

This package installs into other people's agent processes. Every dependency it
declared would be a version constraint they inherit, in the process whose
reliability it exists to improve. It imports nothing outside Node's standard
library; the framework packages are peer dependencies, all optional, imported
dynamically and only when you ask for them.

A test fails if a runtime dependency is ever added, and the build refuses to
produce a tarball that declares one.

## License

MIT. See [LICENSE](./LICENSE).
