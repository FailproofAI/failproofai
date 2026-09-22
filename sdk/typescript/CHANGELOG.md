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

- **Adapters** — `instrument()` wires LangChain.js / LangGraph.js, the Vercel AI
  SDK, Mastra and LlamaIndex.TS. The AI SDK's surface is ES-module functions,
  which cannot be patched, so it is served by the two extension points the SDK
  itself documents: an OpenTelemetry-shaped `tracer()` for
  `experimental_telemetry`, and a `LanguageModelV2Middleware`. Using both
  records each model call once, not twice.

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
