# Framework integrations

If the agent runs on LangChain/LangGraph, CrewAI, LlamaIndex or Pydantic AI, you
do not write the instrumentation — you turn it on. The adapters ship inside the
SDK wheel and are imported only when you ask for them.

```python
import failproofai_sdk
from langgraph.graph import StateGraph      # import your framework FIRST

failproofai_sdk.configure(environment="production")
failproofai_sdk.instrument()                       # every supported framework already imported

graph.invoke({"messages": [...]})           # sessions, tools, models, errors all appear
```

No call site changes. `graph.invoke()`, `crew.kickoff()`, `await workflow.run()`
and `await agent.run()` are recorded exactly as they are written today.

## `instrument()` / `uninstrument()`

```python
failproofai_sdk.instrument()                       # auto-detect
failproofai_sdk.instrument("crewai")               # exactly one
failproofai_sdk.instrument("langchain", session_id=request_id, capture_content=False)
failproofai_sdk.uninstrument()                     # put everything back
```

- **Auto-detect reads what is already imported, not what is installed.** This is
  deliberate — a library that imports LangChain to find out whether you use it
  costs you a second of startup for nothing. The consequence is an ordering rule:
  `configure()` → import the framework → `instrument()` → run. Calling
  `instrument()` too early instruments nothing and returns `()` — no exception,
  but it does log a warning, so check stderr when a run records nothing.
- **It returns the names it newly instrumented**, as a tuple. Assert on it in
  startup code if you want a loud failure: `assert failproofai_sdk.instrument()`.
- **Instrumenting something already active is a no-op** returning `()`. Calling
  it from two code paths, or from a reloading dev server, cannot double-record.
- **An unknown name raises `ValueError` listing the valid ones.** A typo that
  silently records nothing is the worst available outcome, so this one is loud.
  Accepted spellings: `langchain` (aliases `langgraph`, `langchain_core`),
  `crewai`, `llama_index` (`llamaindex`, `llama-index`), `pydantic_ai`
  (`pydantic-ai`, `pydanticai`).
- **One adapter failing does not cost you the others.** With no argument, an
  adapter whose install fails is logged and skipped and the rest still install.
- **Ask what is wired up** rather than guessing, when a run records nothing:

  ```python
  from failproofai_sdk.integrations import available, active

  available()   # ('crewai', 'langchain', 'llama_index', 'pydantic_ai') — every adapter that ships
  active()      # ('langchain',) — what is instrumented in THIS process right now
  ```

  An empty `active()` after you called `instrument()` is the ordering bug above:
  the framework was not in `sys.modules` yet.
- **`uninstrument()` never raises**, restores the original objects it replaced,
  and closes anything still open with `outcome="cancelled"` so teardown does not
  leave a session reported as ongoing forever.

Options are keyword arguments to `instrument()`. The same dict reaches every
adapter, so an option meant for one is ignored by the others rather than raising:

| Option | Applies to | Effect |
|---|---|---|
| `session_id=` | langchain, crewai, pydantic_ai | Pin every run to this session id. Use it when your service already has a per-request id. |
| `capture_content=False` | langchain, pydantic_ai | Drop prompts, messages and outputs; keep structure, durations and token counts. |
| `capture_messages=False` | llama_index | The same, for LlamaIndex. |
| `include_chains=("rag",)` | langchain | Record these intermediate chains by name. Default: none — see below. |
| `graph_callbacks=False` | langchain | Turn off LangGraph interrupt/resume wiring. Default on. |
| `steps=False` | llama_index | Stop emitting a hook pair per workflow step. Default on. |
| `embeddings=True` | llama_index | Record embedding calls. Default off — they are high volume and low signal. |
| `stale_after=600.0` | llama_index | Seconds before the background reaper closes a span the workflow never finished. |
| `reaper_interval=30.0` | llama_index | How often that reaper runs. |

## The rule the mappings follow

> A framework construct becomes an Failproof AI **agent** if and only if it owns an
> LLM decision loop and has its own goal. Everything else with a start and an end
> becomes the closest kind of leaf.

| Kind | Gets | Examples |
|---|---|---|
| owns a decision loop | `agent_start` / `agent_end` | the top-level graph, crew or workflow, and anything the framework itself calls an agent — a compiled subgraph, a CrewAI `Agent` role, a LlamaIndex `FunctionAgent` |
| something the agent *calls* | `tool_use` / `tool_result` | function tools, retrievers, memory and knowledge queries |
| machinery *around* the agent | `hook_triggered` / `hook_completed` (with `trigger_event`) | LangGraph nodes, LlamaIndex workflow steps, CrewAI flow methods, guardrails |

**A LangGraph node is a hook, not a nested agent**, and that is the one mapping
decision worth understanding, because it is the one you might be tempted to
"fix". `agent_id` is the primary facet across every session; it has to stay a
small, stable set of labels. Promote `retrieve`, `grade_documents` and
`should_continue` to agents and you drown the real agents in the filter, and the
session ends up labelled with whichever node happened to run first. Hook spans
draw identically on the timeline — same lanes, same durations — and you get a
per-node latency surface for free, with `hook_name` as its own facet.

## LangChain / LangGraph

Supported: `langchain-core >=1.4.7,<2`, `langgraph >=1.2,<2`.

Attaches through LangChain's own callback configuration, so **every** callback
manager the framework builds carries it — including ones created inside chains
you never touch.

| LangChain / LangGraph | Failproof AI |
|---|---|
| root run (the outermost chain/graph) | `agent_start` / `agent_end` |
| LangGraph node | `hook_triggered` / `hook_completed`, `trigger_event="graph_node"` |
| compiled subgraph | nested `agent_start` / `agent_end`, `agent_id="root/node"` |
| tool run | `tool_use` / `tool_result` |
| retriever run | `tool_use` / `tool_result`, output summarised |
| chat model / LLM run | `model_request` / `model_response`, paired on `request_id` |
| `interrupt()` | `human_wait` + `agent_pause` |
| `Command(resume=...)` | `agent_resume` + `human_input` |
| intermediate chains | **nothing**, unless you name them in `include_chains` |

**Python 3.10 async nodes must forward `RunnableConfig`.** LangGraph cannot
automatically propagate callback context from an async node into a child
`ainvoke()` on Python 3.10. Without this, the child model or tool appears as a
separate root run:

```python
from langchain_core.runnables import RunnableConfig

async def plan(state, config: RunnableConfig):
    reply = await model.ainvoke(state["messages"], config=config)
    return {"messages": [reply]}
```

Python 3.11 and later propagate this context automatically.

`session_id` resolution, in order — the first that produces a value wins:

1. `instrument("langchain", session_id=...)`;
2. `config={"metadata": {"failproofai_sdk_session_id": sid}}` on the call — the
   documented per-call key, and the one to use in a web service;
3. an enclosing `failproofai_sdk.session()` / `failproofai_sdk.agent()` scope;
4. `metadata["session_id" | "conversation_id" | "thread_id"]`;
5. the root run id.

It is never synthesised from scratch. A made-up id would split one run into many
sessions, which is a silent wrong answer rather than a loud one.

Three behaviours that surprise people:

- **A `GraphInterrupt` is control flow, not an error.** LangGraph raises it
  through the same error callback as a genuine failure, so a naive integration
  paints every human approval red and ends the run as `failed`. The adapter
  treats the whole interrupt family as control flow and emits the HITL pairs
  instead.
- **Streaming never produces per-token events.** Time-to-first-token and the
  chunk count are folded into the closing `model_response` as `fw_ttft_ms` and
  `fw_chunks`.
- **`agent_id` is the graph or chain name**, never a run UUID. Framework ids land
  in `fw_run_id` / `fw_node` / `fw_thread_id`.

## CrewAI

Supported: `crewai >=1.13,<2` (the release where the span tree and normalised
token usage are both present). Registers a listener on CrewAI's event bus;
`crew.kickoff()` is unchanged.

| CrewAI | Failproof AI |
|---|---|
| crew kickoff | `agent_start` / `agent_end`, `agent_id` = crew name |
| agent execution | nested `agent_start` / `agent_end`, `agent_id` = the agent's **role** |
| task | no event of its own — folded into the agent execution that runs it |
| flow method | `hook_triggered` / `hook_completed`, `trigger_event="flow_method"` |
| guardrail | hook pair; a tripped guardrail closes with `outcome="rejected"` |
| tool usage | `tool_use` / `tool_result` |
| memory / knowledge query, save, retrieval | `tool_use` / `tool_result` (`memory.query`, `knowledge.search`, …) |
| LLM call | `model_request` / `model_response` |
| LLM stream chunks | folded into the closing `model_response` |

`agent_id` is the crew name at the top and the **agent role** underneath —
`"researcher"`, `"editor"`. CrewAI's `agent.id` is a UUID and goes to
`fw_agent_id`, never to `agent_id`. CrewAI runs its own internal flow inside
every agent execution; that one is a pass-through and does not become a span.

## LlamaIndex

Supported: `llama-index-core >=0.14.23,<0.15`. Registers on the root dispatcher,
so one call covers every workflow and agent in the process.

| LlamaIndex | Failproof AI |
|---|---|
| `Workflow.run` root span | session + `agent_start` / `agent_end` |
| nested `Workflow.run` span | nested `agent_start` / `agent_end` |
| workflow step | `hook_triggered` / `hook_completed`, `trigger_event="workflow_step"` |
| LLM chat start/end | `model_request` / `model_response`, paired on `request_id` |
| `FunctionTool.call` | `tool_use` / `tool_result` |
| retrieval start/end | `tool_use` / `tool_result`, output summarised |
| a tool that waits for an event | `human_wait` + `agent_pause`, then `agent_resume` + `human_input` |
| embeddings | nothing, unless `embeddings=True` |

`agent_id` is the `FunctionAgent.name` when there is one and the workflow class
name otherwise — never a span id.

**Token counts are best-effort here, and deliberately so.** LlamaIndex has no
standard usage field, so the raw usage dict always ships as `usage`, and the
top-level `input_tokens` / `output_tokens` are set **only** when a recognised key
is present. A model integration that names its counters something new gives you a
populated `usage` and blank token columns. That is the honest outcome; a
confident wrong number would be worse.

**Known gap:** human-in-the-loop is captured only when the wait happens inside a
tool — the pattern LlamaIndex documents. A plain workflow step that waits for an
event is resolved by the runtime before anything observable happens, so there is
no signal to key a pause on.

## Pydantic AI

Supported: `pydantic-ai-slim >=2.0,<3`. Every tutorial written for v1 is wrong
for this range: `Agent(instrument=...)` was removed in 2.0. The adapter installs
itself as a capability instead — no OpenTelemetry SDK required, and it cannot
double-count against your own tracing.

| Pydantic AI | Failproof AI |
|---|---|
| an agent run | `agent_start` / `agent_end` (plus `error` on failure) |
| a model request | `model_request` / `model_response` |
| a tool execution | `tool_use` / `tool_result` |
| graph nodes (`UserPromptNode`, `ModelRequestNode`, `CallToolsNode`) | **nothing** |

Graph nodes are Pydantic AI's own loop machinery rather than steps you wrote —
unlike a LangGraph node — and everything they do that is worth seeing is already
covered by the model and tool spans.

`session_id` is the run's `conversation_id`, so a conversation spanning several
runs is one session; an enclosing `failproofai_sdk.session()` / `failproofai_sdk.agent()` scope
always wins. `agent_id` is the `Agent`'s name.

**One ordering rule, because it bites:** the capability is attached when an
`Agent` is constructed, so **agents built before `instrument()` are not
instrumented**, and agents built while instrumented keep the capability object
after `uninstrument()` (it turns into a pass-through and stops recording).
Construct your agents after `instrument()`, or attach it yourself:

```python
from failproofai_sdk.integrations.pydantic_ai import FailproofAI

agent = Agent("openai:gpt-5", capabilities=[FailproofAI()])
```

## Mixing adapters with hand-written events

They compose, and this is the supported way to add detail an adapter cannot know
about:

```python
failproofai_sdk.instrument("langchain")

with failproofai_sdk.agent("planner", goal=question):        # your bracket
    graph.invoke(...)                                  # adapter events land here
    with failproofai_sdk.tool_call("billing_check") as t:     # your own tool span
        t.output = check(user)
```

Adapter events join **that** session, with `parent_id="planner"`. An adapter
resolves identity from its own run id first, then that run's parent chain, then
whatever scope you have open — so a hand-written outer bracket and an adapter
produce one tree, not two.

## What every adapter guarantees

- **They never raise into your agent.** Every callback is wrapped: a failure logs
  at WARNING with a traceback, and after three failures at the same call site
  that site disables itself at ERROR. A broken adapter costs you a log line, not
  your agent. Set `FAILPROOFAI_SDK_STRICT=1` to make it re-raise instead — do that in
  tests and when debugging an adapter that records nothing.
- **Version ranges are checked at `instrument()` time.** Outside the supported
  range: warn once, keep going. Named explicitly but not importable at all:
  `ImportError` carrying the install command. `FAILPROOFAI_SDK_STRICT_INTEGRATIONS=1`
  promotes every one of those warnings to an exception.
- **Framework-native ids are namespaced `fw_*`** — `fw_run_id`, `fw_node`,
  `fw_task_id`, `fw_agent_id`, `fw_thread_id`. Flat, never nested. This is a
  safety rule, not a style one: custom fields are merged last, so an un-namespaced
  extra called `tool_name` or `duration_ms` would overwrite the real field.
- **Large payloads are truncated**, per field and per event, with a
  `…[truncated]` marker. Prompts, retrieved documents and tool outputs are the
  three largest strings in an agent process.
- **Every event carries `framework`, `framework_version` and
  `integration_version`**, so you can tell adapter output from your own.
- **No per-token events, ever.** Streaming is folded into the closing
  `model_response`.
- **Timestamps are stamped when the callback fires.** Nothing is backdated, so an
  adapter cannot import a trace that already happened.

## Verifying an adapter

Everything in `../SKILL.md` §5 applies unchanged — the events go to the same
files. Four checks that are specific to adapter output:

1. **The first event of each session is the root `agent_start`.** Anything
   emitted before it can leave the session labelled by the wrong actor.
2. **`agent_id` values are names, not UUIDs** — `"planner"`, `"researcher"`,
   the graph name. A UUID here means something is being passed through that
   should have gone to `fw_agent_id`.
3. **`model_request` and `model_response` share a `request_id`**, and every
   `model_response` carries an integer `duration_ms`.
4. **Nothing is left open.** Every `tool_use` has a `tool_result`, every
   `agent_start` an `agent_end`.

If an adapter records nothing at all, in this order: was the framework imported
**before** `instrument()` (auto-detect reads imported modules); did
`instrument()` return a non-empty tuple; and does the run produce anything with
`FAILPROOFAI_SDK_STRICT=1` set, which converts a swallowed adapter error into a raise.

## A framework that is not on this list

Use the shipped context managers at the framework's own boundaries —
`failproofai_sdk.agent()` around the run, `failproofai_sdk.tool_call()` in the tool hook. See
`integration.md`. Ask before writing a full callback adapter for an unsupported
framework: adding one to the SDK is usually the better answer.
