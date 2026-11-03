# LlamaIndex

- [Install](#install)
- [The integration](#the-integration)
- [Read this first: token counts](#read-this-first-token-counts)
- [How it attaches](#how-it-attaches)
- [What gets recorded](#what-gets-recorded)
- [A complete example](#a-complete-example)
- [Options](#options)
- [Human in the loop](#human-in-the-loop)
- [Pitfalls](#pitfalls)
- [Runnable examples](#runnable-examples)

---

## Install

```bash
pip install 'failproofai-sdk[llamaindex]'    # pins llama-index-core >=0.14.23,<0.15
```

**Supported:** `llama-index-core` 0.14.23 → 0.15. 0.14.23 is a capability floor:
it is the release where `to_payload()` replaced `to_dict()` and where the
workflow stream started carrying the typed agent events this adapter reads.
Below it, model names and agent structure both go missing.

---

## The integration

```python
import asyncio
import failproofai_sdk

failproofai_sdk.configure(environment="production")
failproofai_sdk.instrument()

async def main():
    async with failproofai_sdk.session():
        await agent.run("...")

asyncio.run(main())
```

LlamaIndex's agent API is async. Every Failproof scope works under `async with`
as well as `with`, and produces byte-identical events either way.

---

## Read this first: token counts

**Without one extra argument, every token count in your trace will be null.**

`FunctionAgent` — the agent API LlamaIndex documents — calls `astream_chat`. And
`llama-index-llms-openai` does not send `stream_options={"include_usage": True}`
when it streams, so **the provider never sends the usage chunk at all**.
`LLMChatEndEvent.response.raw` arrives with no `usage` key on it, and there is
nothing for any instrumentation to read.

This is upstream LlamaIndex behaviour, not a Failproof one. Verified by spying
on the dispatcher directly against `llama-index-core` 0.14.23: every single
`LLMChatEndEvent` in a `FunctionAgent` run has usage absent.

**The fix is one argument on your LLM:**

```python
from llama_index.llms.openai import OpenAI

llm = OpenAI(
    model="gpt-4o-mini",
    additional_kwargs={"stream_options": {"include_usage": True}},
)
```

Measured on the same run, same model:

| | `input_tokens` | `output_tokens` |
|---|---|---|
| without | `None` | `None` |
| with | `148` | `17` |

Non-streaming calls (`llm.chat`, `llm.achat`) extract usage correctly with no
configuration at all. It is only the streaming path — which is the default agent
path — that needs this.

---

## How it attaches

Two handlers on LlamaIndex's global dispatcher:

- an **event handler** for the typed workflow and LLM events, and
- a **span handler** for the enter/exit spans around workflows, steps and tools.

Both together are what makes the agent *loop* visible, not just its model calls.
This is the main thing this adapter buys you over a model-only integration: you
can see `parse_agent_output` taking 160ms, or `aggregate_tool_results` running
twice.

---

## What gets recorded

| LlamaIndex | Failproof event | When |
|---|---|---|
| `Workflow.run` root span | session + `agent_start` / `agent_end` | the outermost run |
| nested `Workflow.run` span | nested `agent_start` / `agent_end` | a sub-workflow |
| workflow step span | `hook_triggered` / `hook_completed` | each step in the agent loop |
| `LLMChatStartEvent` / `EndEvent` | `model_request` / `model_response` | each model call |
| `FunctionTool.call` span | `tool_use` / `tool_result` | each tool call |
| `RetrievalStartEvent` / `EndEvent` | `tool_use` / `tool_result` | output summarised, not dumped |
| embeddings | *nothing* | unless `embeddings=True` |
| `WaitingForEvent` drop | `human_wait` + `agent_pause` | a tool waits on a person |
| exception | `error` + `agent_end(outcome="failed")` | the run raises |

`agent_id` is the `FunctionAgent.name` when you set one, and the workflow class
name otherwise — never a span id.

```python
FunctionAgent(name="city_analyst", tools=[...], llm=llm)   # agent_id = "city_analyst"
```

### Why retrieval output is summarised

A retriever returns documents. Dumping them into the payload puts your entire
corpus in the events store, one copy per query. The adapter records the count,
the score range and truncated snippets instead. If you need the documents
themselves, they are in your index.

### Why steps are hooks and not agents

`init_run`, `setup_agent`, `run_agent_step`, `parse_agent_output`, `call_tool`
and `aggregate_tool_results` are the framework's own loop, not units of work you
wrote. They are hook pairs so `agent_id` stays a meaningful facet instead of
filling up with machinery.

---

## A complete example

```python
import asyncio

import failproofai_sdk
from llama_index.core.agent.workflow import FunctionAgent
from llama_index.core.tools import FunctionTool
from llama_index.llms.openai import OpenAI

failproofai_sdk.configure(environment="production")
failproofai_sdk.instrument()

POP = {"tokyo": "37M", "delhi": "33M", "lagos": "16M"}
AREA = {"tokyo": "2,194 km2", "delhi": "1,484 km2", "lagos": "1,171 km2"}


def population(city: str) -> str:
    """Population of a city. Valid: tokyo, delhi, lagos."""
    return POP.get(city.lower().strip(), "unknown")


def area(city: str) -> str:
    """Land area of a city. Valid: tokyo, delhi, lagos."""
    return AREA.get(city.lower().strip(), "unknown")


async def main():
    agent = FunctionAgent(
        name="city_analyst",
        tools=[
            FunctionTool.from_defaults(fn=population),
            FunctionTool.from_defaults(fn=area),
        ],
        llm=OpenAI(
            model="gpt-4o-mini",
            # REQUIRED for token counts on the streaming agent path.
            additional_kwargs={"stream_options": {"include_usage": True}},
        ),
        system_prompt="Use the tools. Be terse.",
    )

    async with failproofai_sdk.session():
        async with failproofai_sdk.agent("city_analyst", goal="compare two cities"):
            answer = await agent.run("Compare Tokyo and Delhi on population and area.")

    print(answer)


asyncio.run(main())
```

The quickstart version of this produces **26 events across 8 types**, and the
agent loop is fully visible:

```
     1   +0.000s  agent_start       Agent
     2   +0.001s    hook_triggered  init_run
     4   +0.548s    hook_triggered  setup_agent
     6   +0.549s    hook_triggered  run_agent_step
     7   +0.551s      model_request  gpt-5.6-terra
     8   +3.546s      model_response  gpt-5.6-terra
    10   +3.662s    hook_triggered  parse_agent_output
    12   +3.825s    hook_triggered  call_tool
    13   +3.825s      tool_use      city_population
    14   +3.826s      tool_result   city_population · ok
    16   +3.826s    hook_triggered  aggregate_tool_results
    ...
    26   +6.968s  agent_end         Agent · success
```

---

## Options

```python
failproofai_sdk.instrument(
    "llama_index",
    embeddings=False,       # True records embedding calls as tool pairs
    steps=True,             # False drops workflow-step hook pairs
    capture_messages=True,  # False drops prompts and system text from payloads
    stale_after=600.0,      # seconds before an abandoned span is force-closed
    reaper_interval=30.0,   # how often the reaper sweeps; 0 disables it
)
```

| Option | Why you would change it |
|---|---|
| `embeddings` | Off by default: a bulk index build is thousands of calls and buries the timeline. On for debugging embedding latency or cost. |
| `steps` | Off if you want only model and tool events and find the agent loop noisy. |
| `capture_messages` | Off for regulated data. Structure, timings, tokens and outcomes are still recorded. |
| `stale_after` | A workflow that never finishes leaves an open span. The reaper force-closes it after this many seconds, so the session settles instead of reading `ongoing` forever. |
| `reaper_interval` | Sweep frequency. `0` disables the reaper. |

**There is no `session_id` option on this adapter, and no `capture_content`.**
Set the session with a scope, and use `capture_messages` for content:

```python
async with failproofai_sdk.session(f"chat-{user_id}"):
    await agent.run(...)
```

---

## Human in the loop

Only visible when the wait happens **inside a tool**.

```python
async def ask_human(question: str) -> str:
    """Ask a person and wait for their answer."""
    ctx = ...  # your workflow context
    response = await ctx.wait_for_event(HumanResponseEvent)
    return response.answer
```

That produces `human_wait` + `agent_pause`, then `agent_resume` +
`human_input` on the retry.

`ctx.wait_for_event` in a **plain workflow step** is not captured.  The runtime
catches the drop before it reaches the dispatcher: the step simply exits with
`None` and re-runs later, so there is no signal to key a pause on. The
FunctionAgent pattern — which is the one LlamaIndex documents — waits inside a
tool and is captured in full.

---

## Pitfalls

### Every token count is null

See [Read this first](#read-this-first-token-counts). One argument on your LLM.

---

### Token counts are null on a non-OpenAI integration

**Symptom:** `usage` is populated in the payload but `input_tokens` /
`output_tokens` are `None`.

**Cause:** there is no standard usage field in LlamaIndex. The adapter tries
`response.raw["usage"]`, then `raw["usage_metadata"]`, then
`response.additional_kwargs`, calling `model_dump()` first when `raw` is a
pydantic model. An integration that names its counters something new will not
match.

**Why it behaves this way:** the top-level token fields are set **only** when a
recognised key is present, but the raw dict always ships as `usage` regardless.
A populated `usage` with blank token columns is the honest outcome, and much
better than a confident wrong number. Look at `usage` in the payload to see what
your provider actually called them, and open an issue with that key name.

---

### The timeline is buried in `init_run` / `setup_agent` noise

**Symptom:** far more hook pairs than you expected.

**Cause:** that is the FunctionAgent loop. Every iteration is
`setup_agent` → `run_agent_step` → `parse_agent_output` →
`call_tool` → `aggregate_tool_results`.

**Fix:** nothing is wrong, but you can filter by `hook_name` on the dashboard.
The step timings are usually the reason people install this adapter rather than
a model-only one.

---

### Nothing is recorded at all

1. Did `instrument()` run before you constructed the agent? (For LlamaIndex the
   order does not matter, unlike Pydantic AI — but check anyway.)
2. Is there an `async with failproofai_sdk.session():` around the `await`?
3. Set `FAILPROOFAI_SDK_STRICT=1` and run again.
4. Check `llama-index-core >= 0.14.23`.

---

## Runnable examples

| file | what it shows | events |
|---|---|---|
| [`examples/quickstart.py`](examples/quickstart.py) | one tool, one turn, async | 26 |
| [`examples/research_agent.py`](examples/research_agent.py) | 3 tools, several turns, one tool that fails | 64 |

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_API_BASE=...     # note: llama_index reads API_BASE, not BASE_URL
export FPAI_MODEL=gpt-4o-mini
python docs/llama_index/examples/quickstart.py
```

Both were run against a live model before shipping. Both set `stream_options`,
so both report real token counts.
