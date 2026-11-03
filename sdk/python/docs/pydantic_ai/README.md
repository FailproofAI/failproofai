# Pydantic AI

- [Install](#install)
- [The integration](#the-integration)
- [Read this first: construction order](#read-this-first-construction-order)
- [How it attaches](#how-it-attaches)
- [What gets recorded](#what-gets-recorded)
- [A complete example](#a-complete-example)
- [Options](#options)
- [Errors, retries and control flow](#errors-retries-and-control-flow)
- [Pitfalls](#pitfalls)
- [Runnable examples](#runnable-examples)

---

## Install

```bash
pip install 'failproofai-sdk[pydantic-ai]'   # pins pydantic-ai-slim >=2.0,<3
```

**Supported:** `pydantic-ai-slim` 2.0 → 3.0. 2.0 is a capability floor: it is the
release that removed `Agent(instrument=...)` and introduced `AbstractCapability`,
which is the entire surface this adapter is built on. There is no way to
instrument 1.x with this adapter.

---

## The integration

```python
import failproofai_sdk
from pydantic_ai import Agent

failproofai_sdk.configure(environment="production")
failproofai_sdk.instrument()          # <- BEFORE constructing any Agent

agent = Agent("openai:gpt-4o-mini", system_prompt="Be terse.")

with failproofai_sdk.session():
    result = agent.run_sync("...")
```

---

## Read this first: construction order

**`instrument()` must run before you construct an `Agent`.**

The capability is appended at construction time. An `Agent` built before
`instrument()` ran carries no capability and records **nothing** — and there is
no error, because nothing went wrong. This is the single most common way to get
an empty trace with this adapter.

This bites hardest at module scope:

```python
# agents.py
from pydantic_ai import Agent
agent = Agent("openai:gpt-4o-mini")     # constructed at import time


# main.py
import agents                            # <- agent built HERE, uninstrumented
import failproofai_sdk
failproofai_sdk.instrument()             # too late for agents.agent
```

Fix it by instrumenting first:

```python
# main.py
import failproofai_sdk
failproofai_sdk.instrument()

import agents                            # now the agent gets the capability
```

Or construct agents inside a function rather than at import time.

Agents built **while** instrumented keep the capability object, so
`uninstrument()` flips a flag the capability reads rather than trying to reach
back into agents it no longer owns. That means you can safely uninstrument and
re-instrument without rebuilding your agents.

---

## How it attaches

`instrument()` wraps `Agent.__init__` so that every agent constructed afterwards
gets a `FailproofAI` capability appended to its capability list.

The capability implements the middleware protocol Pydantic AI 2.0 introduced, so
it sees:

- run start and end,
- each model request and response, with usage,
- each tool call and its result.

It composes with your own capabilities — it is appended, not substituted, and it
declares an ordering so it wraps the outside of the stack rather than
interfering with middleware you added.

---

## What gets recorded

| Pydantic AI | Failproof event | When |
|---|---|---|
| agent run | `agent_start` / `agent_end` | `run` / `run_sync` / `run_stream` |
| model request | `model_request` / `model_response` | each model call, with `usage` |
| tool call | `tool_use` / `tool_result` | each tool call, with the args the model sent |
| `ModelRetry` from a tool | `tool_result` with `error` | the tool asked for a retry |
| unhandled exception | `error` + `agent_end(outcome="failed")` | the run raises |

There is **no** `hook_triggered` / `hook_completed` pair here, and no
human-in-the-loop pair. That is not a gap — Pydantic AI has no node or step
boundary to bracket, and no built-in human pause. If you build either, emit the
events yourself; see [`../manual/`](../manual/).

`output_type` makes no difference to the trace. A typed run and a string run
produce the same events.

---

## A complete example

```python
import failproofai_sdk
from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry

failproofai_sdk.configure(environment="production")
failproofai_sdk.instrument()

PRICE = {"widget": 42.0, "gadget": 17.5}
STOCK = {"widget": 120, "gadget": 0}


class Report(BaseModel):
    """What the run must produce. Validated by pydantic_ai, not by us."""

    headline: str
    out_of_stock: list[str]


agent = Agent(
    "openai:gpt-4o-mini",
    output_type=Report,
    system_prompt="Use the tools for every number. If a tool fails, note it and continue.",
)


@agent.tool_plain
def price_of(item: str) -> float:
    """Unit price of an item. Valid: widget, gadget."""
    return PRICE[item.lower().strip()]


@agent.tool_plain
def stock_of(item: str) -> int:
    """Units in stock. Valid: widget, gadget."""
    return STOCK[item.lower().strip()]


@agent.tool_plain
def restock_eta(item: str) -> str:
    """Restock ETA. Not available for anything."""
    # ModelRetry hands the failure back to the model instead of raising out of
    # run_sync. Recorded as an errored tool_result either way.
    raise ModelRetry(f"no restock schedule for {item!r} — answer without it")


with failproofai_sdk.session():
    with failproofai_sdk.agent("inventory", goal="stock report"):
        result = agent.run_sync(
            "For 'widget' and 'gadget', get price and stock. "
            "For anything out of stock, try the restock ETA. Then produce the report."
        )

print(result.output.headline)
print(result.output.out_of_stock)
```

Produces **20 events across 6 types**:

```
     1   +0.000s  agent_start       inventory
     2   +0.005s    agent_start     agent · under inventory
     3   +0.006s      model_request  gpt-5.6-terra
     4   +4.036s      model_response  gpt-5.6-terra · 90 out-tok
     5   +4.039s      tool_use      price_of
     ...
    15   +7.028s      tool_use      restock_eta
    16   +7.029s      tool_result   restock_eta · error
    17   +7.032s      model_request  gpt-5.6-terra
    18  +10.411s      model_response  gpt-5.6-terra · 101 out-tok
    19  +10.416s    agent_end       agent · success
    20  +10.417s  agent_end         inventory · success
```

Note events 16–18: the tool failed, the model was told, it made another call and
recovered. The run ends `success` and the failure is still on the record.

The nested `agent` span at depth 2 is Pydantic AI's own run, sitting inside the
`inventory` scope you opened. That is where the model and tool events hang.

---

## Options

```python
failproofai_sdk.instrument(
    "pydantic_ai",
    session_id=None,        # pin every run to one session id
    capture_content=True,   # False drops prompts and completions from payloads
)
```

---

## Errors, retries and control flow

Pydantic AI raises exceptions for three genuinely different things, and the
adapter distinguishes them:

| exception | treated as | result |
|---|---|---|
| `ModelRetry`, `ToolRetryError`, `ToolFailedError` | **a real tool failure** | `tool_result` with `error`; run can still end `success` |
| `SkipToolExecution`, `SkipToolValidation`, `SkipModelRequest`, `CallDeferred`, `ApprovalRequired` | **control flow** | not an error; the run is being steered |
| anything else | **a failure** | `error` + `agent_end(outcome="failed")` |

`ModelRetry` is deliberately in the first group, not the second. It means an
attempt genuinely failed and the model was asked to try again — which is exactly
what a tool span's `error` field is for. Classifying it as control flow would
hide real tool failures behind a green run.

The control-flow list is resolved by name at import time and tolerates every one
of them being absent: a minor release renaming one degrades to "treat it as an
error" rather than raising an `AttributeError` inside your run.

---

## Pitfalls

### An empty trace, no errors anywhere

**Symptom:** the run works, no warnings, and no events.

**Cause:** the `Agent` was constructed before `instrument()` ran. See
[construction order](#read-this-first-construction-order).

**Check it:**

```python
agent = Agent("openai:gpt-4o-mini")
print([type(c).__name__ for c in agent.root_capability.capabilities])
# ['FailproofAI', 'ToolSearch', 'PendingMessageDrainCapability']
```

Pydantic AI merges the list you pass into one `root_capability`, so there is no
`agent.capabilities` attribute — reading that raises `AttributeError`.

---

### A plain exception in a tool kills the run

**Symptom:** `run_sync` raises instead of the model working around a failed tool.

**Cause:** a bare `raise` propagates. That is Pydantic AI's design.

**Fix:** raise `ModelRetry` with a message the model can act on.

```python
@agent.tool_plain
def restock_eta(item: str) -> str:
    """Restock ETA."""
    raise ModelRetry(f"no schedule for {item!r} — answer without it")
```

The failure is recorded as an errored `tool_result` either way; this only
decides whether the run survives it.

---

### There is a nested agent span I did not create

**Symptom:** wrapping in `failproofai_sdk.agent("inventory")` gives you
`inventory` **and** a child called `agent`.

**Cause:** that child is Pydantic AI's own run span, and it is where the model
and tool events hang. It is correct.

**Fix:** if you want one span instead of two, drop your own scope and let the
framework's span be the root — you lose the custom name.

---

### Tracebacks look truncated at the top

**Symptom:** the `traceback` field starts with `[older frames truncated]…`.

**Cause:** Pydantic AI's async graph stack is comfortably longer than the 8KB
field limit. A traceback's last line is the exception itself, so this one field
is trimmed from the **front**, not the back — keeping the head like every other
field would ship 8KB of framework frames and drop the one line anybody reads.

---

## Runnable examples

| file | what it shows | events |
|---|---|---|
| [`examples/quickstart.py`](examples/quickstart.py) | one tool, one turn | 8 |
| [`examples/research_agent.py`](examples/research_agent.py) | 3 tools, typed output, one tool that retries | 20 |

```bash
export OPENAI_API_KEY=sk-...
export FPAI_MODEL=gpt-4o-mini
python docs/pydantic_ai/examples/quickstart.py
```

Both were run against a live model before shipping.
