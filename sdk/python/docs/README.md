# failproofai-sdk — integration guide

Plug your agent into Failproof AI. One call, no call-site changes, no ids
threaded through your code.

```bash
pip install 'failproofai-sdk[langgraph]'
```

```python
import failproofai_sdk

failproofai_sdk.instrument()          # auto-detects the frameworks you imported

with failproofai_sdk.session():
    graph.invoke(...)                 # recorded
```

That is the whole integration.

---

## pick your framework

| framework | guide | runnable code |
|---|---|---|
| LangChain / LangGraph | [langgraph/](langgraph/) | [langgraph/examples/](langgraph/examples/) |
| CrewAI | [crewai/](crewai/) | [crewai/examples/](crewai/examples/) |
| LlamaIndex | [llama_index/](llama_index/) | [llama_index/examples/](llama_index/examples/) |
| Pydantic AI | [pydantic_ai/](pydantic_ai/) | [pydantic_ai/examples/](pydantic_ai/examples/) |
| **no framework** (your own agent) | [manual/](manual/) | [manual/examples/](manual/examples/) |

Using something else — AutoGen, Haystack, Semantic Kernel, your own loop? Read
[manual/](manual/). It is the same fidelity, it just costs you the call sites,
and it explains why AutoGen has no adapter.

---

## what you get

Here is a real trace, printed by `langgraph/examples/quickstart.py`. This is
captured output, not an illustration:

```
━━ failproof_ai · langgraph quickstart
   session  faf3a02d64464e34809eae95fa244230
   events   14 · agents 1 · types 8

     №    offset  event             detail
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     1   +0.000s  agent_start       LangGraph
     2   +0.001s    hook_triggered  agent
     3   +0.002s      model_request  gpt-5.6-terra
     4   +3.023s      model_response  gpt-5.6-terra · 21 out-tok
     5   +3.024s    hook_completed  agent
     6   +3.024s    hook_triggered  tools
     7   +3.025s      tool_use      word_count
     8   +3.025s      tool_result   word_count · ok
     9   +3.025s    hook_completed  tools
    10   +3.026s    hook_triggered  agent
    11   +3.027s      model_request  gpt-5.6-terra
    12   +5.717s      model_response  gpt-5.6-terra · 5 out-tok
    13   +5.720s    hook_completed  agent
    14   +5.721s  agent_end         LangGraph · success
```

One `graph.invoke()` from the outside. Fourteen events with timings, token
counts and the tool call, from the inside.

---

## the three calls

### 1. `configure()` — optional

```python
failproofai_sdk.configure(
    environment="production",   # label on every event; default "dev"
    flush_interval=0.5,         # seconds between disk flushes
    base_dir=None,              # spool root; default ~/.failproofai/custom-agents
)
```

Defaults are usually right. Set `environment` so you can tell prod from staging
on the dashboard.

### 2. `instrument()` — the one that does the work

```python
failproofai_sdk.instrument()               # every framework already imported
failproofai_sdk.instrument("crewai")       # exactly one
failproofai_sdk.uninstrument()             # put everything back
```

Auto-detection reads `sys.modules` — a framework you have installed but are not
using is never imported on your behalf.

### 3. `session()` — group one run

```python
with failproofai_sdk.session():
    ...
```

A session is one run. Without it, each top-level call becomes its own session,
which is almost never what you want.

---

## the fifteen event types

| group | events | what they mean |
|---|---|---|
| agents | `agent_start` `agent_end` | a unit of work begins / ends |
| | `agent_pause` `agent_resume` | it is blocked / unblocked (feeds paused time) |
| models | `model_request` `model_response` | one LLM round trip, with tokens |
| tools | `tool_use` `tool_result` | one tool call, with args and output |
| hooks | `hook_triggered` `hook_completed` | a node / step / task boundary |
| humans | `human_wait` `human_input` | you asked a person / they answered |
| | `human_pause` `human_interrupt` | a person paused / stopped the agent |
| failures | `error` | something went wrong |

**Events come in pairs.** The closing event carries a `duration_ms` measured
from the matching opening one. An opening event with no close renders as a span
that never finishes.

---

## what each framework emits

Measured from the real runs in this directory, not declared.

| event | langgraph | crewai | llama_index | pydantic ai | your own |
|---|:--:|:--:|:--:|:--:|:--:|
| `agent_start` / `agent_end` | yes | yes | yes | yes | you |
| `model_request` / `model_response` | yes | yes | yes | yes | you |
| `tool_use` / `tool_result` | yes | yes | yes | yes | you |
| `hook_triggered` / `hook_completed` | node | task | step | — | you |
| `error` | yes | yes | yes | yes | automatic |
| `human_wait` / `human_input` | yes | yes | yes | — | you |
| `agent_pause` / `agent_resume` | yes | yes | yes | — | you |
| `human_pause` / `human_interrupt` | — | — | — | — | you |

A dash means the framework has no such concept, not that it is missing.
Pydantic AI has no node boundary and no built-in human pause, so there is
nothing to map. `human_pause` and `human_interrupt` describe a *person* acting
on the agent — a stop button — which no framework signals; emit those yourself.

---

## running the examples

Every example in this tree was executed against a live model before it shipped.

```bash
pip install 'failproofai-sdk[langgraph]'
export OPENAI_API_KEY=sk-...
export FPAI_MODEL=gpt-4o-mini            # optional, this is the default

python docs/langgraph/examples/quickstart.py
```

Each one prints the event stream it produced when it finishes. That printer
lives in [`_shared/`](_shared/) and is **cosmetics only** — the two bootstrap
lines at the top of each example exist just to import it. Delete them and the
example still instruments correctly.

---

## instrumentation cannot break your agent

Every callback goes through a wrapper whose only job is to re-raise. Your call
sits in exactly one `try`; everything the SDK does happens outside it.

- a hook that raises is logged once, with its traceback, and your call is
  unaffected;
- a hook that raises three times at the same site is disabled for the rest of
  the process, with one error line saying so.

That firewall is the right default in production and the wrong one when you are
debugging. To make failures loud instead:

```bash
export FAILPROOFAI_SDK_STRICT=1
```

Without it you can only ever prove "it did not crash", never "it swallowed the
right thing".

---

## zero dependencies

`import failproofai_sdk` pulls in nothing outside the standard library. That is
enforced, not asserted: one test installs the built wheel with `--no-deps`,
another launches a fresh interpreter and proves no framework reaches
`sys.modules`.

The extras install the **framework**, not the adapter — the adapter code always
ships in the base wheel and is imported only when `instrument()` asks for it.
Most people already have the framework and never need an extra.

| extra | installs |
|---|---|
| `failproofai-sdk[langchain]` | `langchain-core>=1.4.7,<2` |
| `failproofai-sdk[langgraph]` | `langgraph>=1.2,<2` |
| `failproofai-sdk[crewai]` | `crewai>=1.13,<2` |
| `failproofai-sdk[llamaindex]` | `llama-index-core>=0.14.23,<0.15` |
| `failproofai-sdk[pydantic-ai]` | `pydantic-ai-slim>=2.0,<3` |

There is deliberately no `[all]` — an extra that installs four agent frameworks
at once is a resolver problem handed to somebody who wanted a telemetry library.

---

## verifying it works

Look at the dashboard, or query the store.

**Do not read the spool directory to check.** When `failproofaid` is running it
collects and deletes each batch file within milliseconds of it appearing, so a
read races the collector and returns only what has not shipped yet — which looks
exactly like an adapter that emitted nothing but its closing events. This is a
real thing that happened while writing these docs.

To inspect events in-process instead, tap the writer:

```python
captured = []
_original = failproofai_sdk._writer.submit
failproofai_sdk._writer.submit = lambda e: (captured.append(e), _original(e))[1]
```

Every example here does exactly that.

---

## troubleshooting

| symptom | most likely cause |
|---|---|
| no events at all | `instrument()` never ran, or ran after you built the agent (Pydantic AI) |
| events, but no session | no `with failproofai_sdk.session():` — each call became its own session |
| `TypeError: ... missing session_id` | you emitted from a new thread; wrap it in `failproofai_sdk.propagate()` |
| spans that never finish | an opening event with no closing one — emit the pairs |
| null token counts on LlamaIndex | streaming has no usage; see [llama_index/](llama_index/) |
| `agent_id` full of uuids | keep it low-cardinality — a role or node name, never a run id |
| duplicated events on LangChain | you registered a second callback handler as well as `instrument()` |
| adapter seems to do nothing | set `FAILPROOFAI_SDK_STRICT=1` and run again |
