# Changelog — `@failproofai/sdk`

The TypeScript telemetry SDK. Released independently of the `failproofai` npm
package, of its Python sibling `failproofai-sdk`, and of `fp-cloud-cli`, so the
versions here line up with none of them.

Headings are `## <version> — <YYYY-MM-DD>`, and the section matching the version
in `src/version.ts` becomes that release's GitHub Release body. A release whose
section is missing or empty is refused before anything is built.

## 0.0.1-beta.0 — 2026-09-23

### Added

- **First release.** `@failproofai/sdk` is the TypeScript counterpart to the
  Python `failproofai-sdk`: the same 15 events, the same wire format, the same
  spool directory, the same evaluator protocol. A process running a Node agent
  and a process running a Python one now write into one pipe, and the dashboard
  cannot tell which wrote what.

- **Scopes** — `session()`, `agent()`, `toolCall()`. Identity rides on
  `AsyncLocalStorage`, so two concurrent runs in one process never mix. Each
  takes a callback (`await agent("planner", fn)`) and also has a `.open()`
  returning a `using`-compatible handle for the cases a callback cannot express.
  A synchronous body stays synchronous — the scopes do not wrap every call in a
  promise, because a constructor or an `EventEmitter` listener cannot await one.

- **Adapters** — `instrument()` wires LangChain.js / LangGraph.js
  (`@langchain/core` 0.3 – 1.x), the Vercel AI SDK (`ai` 4 – 7), Mastra
  (`@mastra/core` 0.20 – 1.x) and LlamaIndex.TS (`llamaindex` 0.11.4 – 0.x),
  and they draw the Python SDK's trees: a construct is an agent only if it owns
  an LLM decision loop, a LangGraph node or workflow step is a hook, model and
  tool calls are pairs carrying token counts and the model's own tool call id,
  and a failure is recorded once, where it happened. LangChain traces match the
  Python adapter's golden output event for event, including interrupt/resume.
  The AI SDK is served by `telemetry()` — one object carrying an OpenTelemetry
  tracer for `ai` 4–6 and a telemetry integration for `ai` 7 — plus
  `wrapModel()` and, for `ai` 7, `instrument("ai")`; using them together records
  each call once. On `ai` 4–6 `instrument("ai")` never takes the global
  OpenTelemetry slot unless asked (`registerGlobalTracer: true`), because
  taking it silently refuses the application's own tracing set up afterwards.
  `langchainHandler()` works without `instrument()`.

- **Safe in a long-running server.** Nothing a finished run leaves behind is
  kept: tracker links go when their run closes (a FIFO cap full of finished
  runs used to evict live ones and drop their events), LangGraph runs paused on
  a human and resumed by another worker are forgotten after 15 minutes, and a
  streamed model call that is cancelled or errors still closes. Concurrent
  requests on one shared LlamaIndex query engine or agent are kept apart, and
  `uninstrument()` stops Mastra recording through models and tools it had
  already wrapped. Frameworks are found from the entry script as well as the
  working directory, so a service started from `/` or a monorepo app with its
  own nested copy of a framework is instrumented correctly.

- **Tested against the real frameworks, not just in isolation.** `integration/`
  installs real framework releases at both ends of every declared range from
  per-fixture lockfiles, extracts the packed tarball into each, and runs one
  agent as an ES module and as CommonJS — the dual-package case where an
  adapter that patches the CommonJS copy of a framework records nothing at all
  in an ES-module application. Adapters patch the copy the application loads,
  and never load a second one. Runs in CI as `failproofai-ts-sdk-integrations`.

- **Every commonly used surface, not just the headline API.** Beyond each
  framework's main agent call the suite covers LangChain's v1 `createAgent`,
  LCEL chains, retrievers, `.batch()` and nested `@langchain/core` copies; the
  AI SDK's agent classes, embeddings, object generation, approval and
  client-side tools and every stream-consumption style; Mastra instances,
  networks, memory threads (the thread is the session), workflows with
  suspend/resume, processors and MCP tools; LlamaIndex chat engines, query
  engines, retrievers and `createWorkflow()` workflows — each under
  concurrency as well.

- **Next.js:** `withFailproofai(nextConfig)` from `@failproofai/sdk/next`
  keeps the frameworks `instrument()` patches out of Next's server bundle, and
  `instrument()` warns once per framework it cannot reach instead of recording
  nothing silently. Importing the SDK in an Edge route is safe (a no-op build).

- **Your own agent, no framework:** a guide to the three places every
  hand-built agent already has (the run, the model call, the tool dispatcher)
  and `examples/research-agent.ts`, a real OpenAI tool loop instrumented by hand
  — the TypeScript twin of the Python SDK's `research_agent.py`. The integration
  suite runs that exact file on every CI run, as ESM and CJS, against the real
  `openai` client.

- **Runtimes:** Node ≥ 20.9, Bun and Deno, every framework as ESM and CJS,
  checked against Node's trace.

- **Type declarations for every consumer setup** — ESM and CommonJS
  `nodenext`, CommonJS `node16`, `moduleResolution: node` (every subpath, via
  `typesVersions`) and `bundler` — on TypeScript ≥ 5.4. CommonJS consumers get
  CommonJS declarations; `@arethetypeswrong/cli` reports no problems.

- **Evaluator** — `@failproofai/sdk/evaluator` implements Evaluator v2: the wire
  protocol, the worker state machine, the authoring API, and a
  `failproofai-evaluator` command to run one.

- **A sandbox that is a real one.** Server-authored evaluation source runs
  through a restricted expression language that is **parsed and interpreted**
  here — never `eval`'d, never handed to `node:vm`. That is not
  belt-and-braces: JavaScript has a reachable path from any value to arbitrary
  code (`x["constructor"]["constructor"]("…")()`), a static allowlist cannot
  close it because the key is computed at runtime, and a `vm` context has its
  own `Function` to reach. Every property read goes through one function that
  checks the actual key at the moment of the read. A `worker_threads` sandbox
  with V8 heap limits, a wall-clock `terminate()` and a bounded result sits
  around that as the RESOURCE bound, and an evaluation that cannot be sandboxed
  is refused rather than run.

- **Zero runtime dependencies**, checked by the build and by a test. This
  package installs into other people's agent processes; every dependency it
  declared would be a version constraint they inherit.

- Dual ESM + CommonJS build, Node ≥ 20.9.
