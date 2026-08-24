# LangChain / LangGraph

One adapter serves both — LangGraph runs on `langchain-core`'s callback manager,
so instrumenting one instruments the other.

- [Install](#install)
- [The integration](#the-integration)
- [How it attaches](#how-it-attaches)
- [What gets recorded](#what-gets-recorded)
- [A complete example](#a-complete-example)
- [Naming your agents](#naming-your-agents)
- [Controlling the session](#controlling-the-session)
- [Options](#options)
- [What an event actually looks like](#what-an-event-actually-looks-like)
- [Human in the loop](#human-in-the-loop)
- [Pitfalls](#pitfalls)
- [Runnable examples](#runnable-examples)

---

## Install

```bash
pip install 'failproofai-sdk[langgraph]'     # pins langgraph >=1.2,<2
```

Using plain LangChain without LangGraph:

```bash
pip install 'failproofai-sdk[langchain]'     # pins langchain-core >=1.4.7,<2
```

You almost certainly have the framework already. The extras exist to state the
supported range; the adapter itself ships in the base wheel.

**Supported:** `langchain-core` 1.4.7 → 2.0, `langgraph` 1.2 → 2.0. Outside
that range the adapter still installs and warns once, because a version we have
not tested is a better bet than no telemetry.

---

## The integration

```python
import failproofai_sdk

failproofai_sdk.configure(environment="production")
failproofai_sdk.instrument()

with failproofai_sdk.session():
    graph.invoke({"messages": [HumanMessage("...")]})
```

Three lines, and nothing else in your codebase changes. No decorators on your
nodes, no callback passed to `.invoke()`, no ids threaded through your
functions.

`instrument()` with no argument auto-detects every supported framework already
imported. To be explicit:

```python
failproofai_sdk.instrument("langchain")      # "langgraph" is an alias
```

---

## How it attaches

`instrument()` registers a tracer through
`langchain_core.tracers.context.register_configure_hook`. LangChain injects it
into **every callback manager it builds**, which means:

- every graph, node, tool, retriever and model call is captured;
- so is anything inside a library you did not write, as long as it goes through
  LangChain;
- there is nothing to pass to `.invoke()` and no call site to change.

The tracer subclasses `BaseTracer`, so LangChain assembles the run tree and
hands over `Run` objects with inputs, outputs, metadata and timings already
collected — two override points instead of twenty hand-correlated callbacks.

<details>
<summary><b>Why we do not patch <code>BaseCallbackManager.__init__</code></b></summary>

Some other integrations do, and it double-records.
`BaseCallbackManager.merge()` builds a new manager with handlers already passed
in, so their `isinstance` dedup misses and the handler is added twice. MLflow
patches `merge` as well to work around it. The configure hook has no such hole.

This is also why you must **not** pass a Failproof handler in
`config={"callbacks": [...]}` yourself — see [Pitfalls](#pitfalls).
</details>

<details>
<summary><b>Why the handler runs inline</b></summary>

`run_inline = True` is not optional. `AsyncCallbackManager` dispatches sync
handlers through `run_in_executor` unless a handler opts out, and that hop can
**reorder callbacks** — which scrambles timestamp order and breaks every pairing.
Writing an event is a `deque.append`, so running inline on the event loop is
safe.
</details>

---

## What gets recorded

| LangChain / LangGraph | Failproof event | When |
|---|---|---|
| root run | `agent_start` / `agent_end` | the outermost `.invoke()` / `.stream()` |
| LangGraph node | `hook_triggered` / `hook_completed` | each node entry and exit |
| compiled subgraph | nested `agent_start` / `agent_end` | a subgraph run, named `root/node` |
| tool run | `tool_use` / `tool_result` | each tool call, with args and output |
| retriever run | `tool_use` / `tool_result` | output summarised, not dumped |
| chat model / LLM run | `model_request` / `model_response` | each model call, with token usage |
| streamed tokens | *nothing* | folded into `fw_chunks`, `fw_ttft_ms` on the response |
| `interrupt()` | `human_wait` + `agent_pause` | the graph suspends for a person |
| `Command(resume=...)` | `agent_resume` + `human_input` | the graph continues |
| unhandled exception | `error` + `agent_end(outcome="failed")` | the run raises |
| intermediate chains | *nothing* | unless named in `include_chains` |

### Why a node is a hook and not a nested agent

`agent_id` is a `LowCardinality(String)` column and the primary facet on every
dashboard surface. Promoting `retrieve`, `grade_documents` and `should_continue`
to agents would:

- drown that facet with one entry per node, and
- label the whole session after whichever node happened to run first.

Hook spans render structurally identically in the timeline, and you get a
per-node latency page for free. Subgraphs *do* become nested agents, because a
compiled subgraph is a genuine unit of work.

### Why streamed tokens emit nothing

A 500-token response would otherwise be 500 stored rows against a five-lane
rail. The chunk count, time-to-first-token and a `fw_streamed` flag land on the
single `model_response` instead.

---

## A complete example

Copy-pasteable, no helpers:

```python
import failproofai_sdk
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import ToolNode, create_react_agent

failproofai_sdk.configure(environment="production")
failproofai_sdk.instrument()


@tool
def price_of(item: str) -> float:
    """Return the unit price of an item in USD."""
    return {"widget": 42.0, "gadget": 17.5}[item.lower().strip()]


@tool
def stock_of(item: str) -> int:
    """Return the units of an item currently in stock."""
    return {"widget": 120, "gadget": 0}[item.lower().strip()]


# handle_tool_errors=True feeds a raised exception back to the model as a tool
# message instead of aborting the graph. The failure is recorded either way.
tools = ToolNode([price_of, stock_of], handle_tool_errors=True)
graph = create_react_agent(ChatOpenAI(model="gpt-4o-mini"), tools)

with failproofai_sdk.session():
    with failproofai_sdk.agent("analyst", goal="price and stock report"):
        result = graph.invoke({
            "messages": [HumanMessage("Price and stock for widget and gadget?")]
        })

print(result["messages"][-1].content)
```

Running the fuller version of this
([`examples/research_agent.py`](examples/research_agent.py)) produces **36
events across 8 types**: the `analyst` span, the graph nested inside it, a hook
pair per node, a model pair per turn with token counts, and a tool pair per call
— including one that failed:

```
     1   +0.000s  agent_start       analyst
     2   +0.001s    agent_start     LangGraph · under analyst
     3   +0.002s      hook_triggered  agent
     4   +0.003s        model_request  gpt-5.6-terra
     5   +3.690s        model_response  gpt-5.6-terra · 99 out-tok
     ...
    28   +5.830s        tool_use    restock_eta
    29   +5.834s        tool_result  restock_eta · error
     ...
    36   +9.209s  agent_end         analyst · success
```

Note event 29: a failed tool is a `tool_result` carrying `error`. The run still
ends `success`, because the agent recovered — the trace preserves both facts.

---

## Naming your agents

By default the root span takes the graph's own name (`LangGraph`, or whatever
you passed to `.compile(name=...)`). Wrap it to get something meaningful:

```python
with failproofai_sdk.session():
    with failproofai_sdk.agent("analyst", goal="price and stock report"):
        graph.invoke(...)
```

Everything inside now carries `parent_id="analyst"`, and the dashboard groups by
`analyst` rather than by a framework class name.

For multi-agent setups, nest the scopes — each worker becomes a child span:

```python
with failproofai_sdk.session():
    with failproofai_sdk.agent("supervisor"):
        with failproofai_sdk.agent("researcher"):
            research_graph.invoke(...)
        with failproofai_sdk.agent("writer"):
            writer_graph.invoke(...)
```

See [`examples/supervisor_handoff.py`](examples/supervisor_handoff.py) — 38
events, 5 agents, correctly nested.

> **Keep `agent_id` low-cardinality.** It is a facet column. Use a role or node
> name (`analyst`, `researcher`), never a UUID or a per-run string. Put the real
> id in a payload field instead.

---

## Controlling the session

The session id is resolved in this order — first match wins:

1. `failproofai_sdk.instrument("langchain", session_id="...")` — pins every run
2. `config={"metadata": {"failproofai_sdk_session_id": "..."}}` — per call
3. the ambient `failproofai_sdk.session()` / `agent()` scope
4. `metadata["session_id"]`, `metadata["conversation_id"]`, `metadata["thread_id"]`
5. the root run id

It is **never synthesised from scratch**, because a made-up id splits one run
into many sessions — a silent wrong answer rather than a loud one.

Per-call override:

```python
graph.invoke(
    {"messages": [...]},
    config={"metadata": {"failproofai_sdk_session_id": f"chat-{user_id}"}},
)
```

> `thread_id` **is** available to callbacks on this stack, despite what you may
> have read. Reports that it is `None` are about `langchain-core` dropping
> `configurable` from `metadata`; LangGraph 1.2 re-adds it. It is still only the
> fourth resolution step, because a thread is a conversation, not necessarily a
> single run.

---

## Options

```python
failproofai_sdk.instrument(
    "langchain",
    session_id=None,            # pin every run to one session id
    include_chains=set(),       # allowlist intermediate chains as hook pairs
    capture_content=True,       # False drops prompts and completions from payloads
    graph_callbacks=True,       # first-class interrupt/resume (needs langgraph >= 1.2)
)
```

**`capture_content=False`** is the switch for regulated data. Structure,
timings, token counts, tool names and outcomes are all still recorded; the
message bodies and completions are not.

**`include_chains`** takes a set of runnable names. Use it sparingly — it exists
for a chain that is genuinely a step in your pipeline, not to surface
`RunnableSequence`.

It applies to **nested** runs only. A runnable you invoke at the top level is
the session's root, so it becomes the agent span rather than a hook pair, and
naming it here has no effect.

---

## What an event actually looks like

A real `model_response`, captured from `examples/quickstart.py`:

```json
{
  "timestamp": "2026-08-19T19:50:56.241974Z",
  "session_id": "7e5de1571fa14424aa1a5bbd88cb420d",
  "agent_id": "LangGraph",
  "type": "model_response",
  "environment": "production",
  "model": "gpt-5.6-terra",
  "stop_reason": "tool_calls",
  "input_tokens": 139,
  "output_tokens": 21,
  "content": "",
  "role": "assistant",
  "request_id": "01a01b93-91a0-7c92-bf45-3857ee43d3ff",
  "usage": { "input_tokens": 139, "output_tokens": 21, "total_tokens": 160 },
  "duration_ms": 5202,
  "framework": "langchain",
  "framework_version": "1.5.6",
  "integration_version": "0.0.1b1",
  "fw_langgraph_version": "1.2.11",
  "fw_run_id": "01a01b93-91a0-7c92-bf45-3857ee43d3ff",
  "fw_node": "agent",
  "fw_step": 1
}
```

Everything prefixed `fw_` is framework-specific detail, namespaced so it can
never collide with — and silently overwrite — a first-class field like
`model` or `output_tokens`. `request_id` is what pairs this response with its
request; without it the dashboard falls back to FIFO pairing and concurrent
calls mis-pair.

---

## Human in the loop

LangGraph's `interrupt()` produces **four** events, and neither pair is
redundant:

```python
from langgraph.types import interrupt, Command

def approve(state):
    decision = interrupt({"prompt": "Ship it?", "options": ["yes", "no"]})
    return {"approved": decision == "yes"}

with failproofai_sdk.session():
    graph.invoke(state, config)              # human_wait + agent_pause
    # ... minutes pass ...
    graph.invoke(Command(resume="yes"), config)   # agent_resume + human_input
```

- `human_wait` → `human_input` carries the prompt, the options, the answer and
  the pending-human count;
- `agent_pause` → `agent_resume` is the **only** thing that feeds paused time.
  Without it the whole human wait is billed as active agent time.

The root agent span deliberately stays **open** across the gap, so the two
`.invoke()` calls are one session and one run.

---

## Pitfalls

### A raising tool aborts the whole graph

**Symptom:** your run dies on the first tool exception instead of recovering.

**Cause:** `create_react_agent` propagates it by default.

**Fix:** build the tool node explicitly.

```python
from langgraph.prebuilt import ToolNode, create_react_agent

tools = ToolNode([price_of, stock_of], handle_tool_errors=True)
graph = create_react_agent(model, tools)
```

The failure is recorded as `tool_result` with `error` either way — this only
decides whether the run survives it.

---

### A bare `llm.invoke()` shows up as an agent named after the model class

**Symptom:** an `agent_id` of `ChatOpenAI` in your trace.

**Cause:** a direct model call outside any graph has no parent run, so it opens
a root agent span **and** emits its own `model_request` / `model_response` pair
inside it. The dashboard parents leaves to an open agent and synthesises a
never-ending root span when there is none, so the span is deliberate.

**Fix:** name it.

```python
with failproofai_sdk.agent("summariser"):
    summary = ChatOpenAI(model="gpt-4o-mini").invoke([HumanMessage(text)])
```

> Before v1.0.1-beta.2 this case emitted the agent span and **nothing else** —
> no model name, no token counts, no latency. If you are on an older build,
> upgrade.

---

### Interrupts look like errors and are not

**Symptom:** you expect a red error on every human approval.

**Cause:** LangGraph's runnable does `except BaseException: on_chain_error(e);
raise` with no special case for interrupts, so every HITL pause reaches the
tracer as an error callback.

**Fix:** none needed. Any `GraphBubbleUp` subclass — `GraphInterrupt`,
`NodeInterrupt`, `ParentCommand`, `GraphDrained` — is treated as control flow.
Without that, every approval would paint a red error plus
`agent_end(outcome="failed")`.

---

### Everything is recorded twice

**Symptom:** every event appears two times.

**Cause:** you passed a Failproof handler in `config={"callbacks": [...]}` *as
well as* calling `instrument()`.

**Fix:** remove it. The configure hook already covers every callback manager in
the process. There is never a reason to register a handler by hand.

---

### Nothing is recorded at all

Work through these in order:

1. Did `instrument()` actually run before the graph executed?
2. Is there a `with failproofai_sdk.session():` around the call? Without one,
   every `.invoke()` becomes its own session — you will have events, but
   scattered.
3. Set `FAILPROOFAI_SDK_STRICT=1` and run again. A silently degraded hook will
   now raise instead of being swallowed.
4. Are you reading the spool directory to check? Do not — a running
   `failproofaid` deletes each batch within milliseconds. Check the dashboard.

---

### Events from a worker thread raise `TypeError`

**Symptom:** `TypeError` naming `session_id` from inside a thread pool.

**Cause:** contextvars propagate into asyncio tasks automatically but **not**
into new threads — a thread starts with an empty context.

**Fix:**

```python
pool.submit(failproofai_sdk.propagate(work), x)
threading.Thread(target=failproofai_sdk.propagate(work)).start()
```

---

## Runnable examples

| file | what it shows | events |
|---|---|---|
| [`examples/quickstart.py`](examples/quickstart.py) | one tool, one turn — the smallest real trace | 14 |
| [`examples/research_agent.py`](examples/research_agent.py) | 3 tools, several turns, one tool that fails and recovers | 36 |
| [`examples/supervisor_handoff.py`](examples/supervisor_handoff.py) | a supervisor delegating to 2 workers, nested spans | 38 |

```bash
export OPENAI_API_KEY=sk-...
export FPAI_MODEL=gpt-4o-mini
python docs/langgraph/examples/quickstart.py
```

Each prints the event stream it produced. All three were run against a live
model before shipping.
