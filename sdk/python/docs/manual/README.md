# Your own agent — no framework

For an agent you wrote yourself, or a framework Failproof has no adapter for.
There is nothing to instrument: you emit the events.

This is a first-class path, not a consolation prize. It is exactly what the four
adapters call underneath — they are translation tables over the same API.

- [Install](#install)
- [The three scopes](#the-three-scopes)
- [What a scope does on the way out](#what-a-scope-does-on-the-way-out)
- [The fifteen event methods](#the-fifteen-event-methods)
- [A complete example](#a-complete-example)
- [Threads and async](#threads-and-async)
- [Instrumenting an unsupported framework](#instrumenting-an-unsupported-framework)
- [Why there is no AutoGen adapter](#why-there-is-no-autogen-adapter)
- [Pitfalls](#pitfalls)
- [Runnable examples](#runnable-examples)

---

## Install

```bash
pip install failproofai-sdk
```

No extras. Zero dependencies.

---

## The three scopes

```python
import failproofai_sdk

failproofai_sdk.configure(environment="production")

with failproofai_sdk.session() as sid:          # identity only — emits nothing
    with failproofai_sdk.agent("planner"):      # agent_start / agent_end
        with failproofai_sdk.tool_call("search", input={"q": q}) as t:
            t.output = search(q)                # tool_use / tool_result
```

| scope | emits | purpose |
|---|---|---|
| `session()` | nothing | binds a session id — groups one run |
| `agent()` | `agent_start` / `agent_end` | brackets a unit of work |
| `tool_call()` | `tool_use` / `tool_result` | brackets one tool, measuring it |

**Everything inside them can omit `session_id=` and `agent_id=`.** The scopes
bind identity on contextvars and every `event.*` call reads it back. That is the
whole point — threading two ids through every function that might emit an event
is what turns instrumentation into a diff nobody wants to review.

All three work under `async with` as well as `with`:

```python
async with failproofai_sdk.session():
    async with failproofai_sdk.agent("planner"):
        async with failproofai_sdk.tool_call("search", input={"q": q}) as t:
            t.output = await search(q)
```

### Nesting agents

```python
with failproofai_sdk.session():
    with failproofai_sdk.agent("supervisor"):
        with failproofai_sdk.agent("researcher"):     # parent_id = "supervisor"
            ...
        with failproofai_sdk.agent("writer"):         # parent_id = "supervisor"
            ...
```

`parent_id` and `depth` are computed from the stack. You never pass them.

---

## What a scope does on the way out

`agent()` handles exceptions for you:

| what happened | events emitted | `outcome` |
|---|---|---|
| nothing raised | `agent_end` | `success` |
| `Exception` | `error`, then `agent_end` | `failed` |
| `KeyboardInterrupt` / `SystemExit` | `error`, then `agent_end` | `failed` |
| `CancelledError` / `GeneratorExit` | `agent_end` only | `cancelled` |

Two deliberate details:

- **`error` strictly before `agent_end`.** The dashboard closes the span at
  `agent_end`, so anything emitted after it is attributed to nothing.
- **A cancellation is not a failure.** Otherwise every cancelled run pollutes
  the errors surface. `asyncio.CancelledError` has been a `BaseException` since
  Python 3.8, and it is caught and re-raised untouched.

The exception is **always** re-raised. A scope never swallows.

`tool_call()` does the same for tools: a raising body produces
`tool_result(error="TypeName: msg")` and **no** `error` event, because a tool
failure the agent loop catches is not a run-level error, and one that propagates
is reported exactly once by the enclosing `agent()`.

---

## The fifteen event methods

### agents

```python
failproofai_sdk.event.agent_start(agent_id="planner", goal="find the cheapest flight")
failproofai_sdk.event.agent_end(agent_id="planner", outcome="success", summary="...")
failproofai_sdk.event.agent_pause(pause_id="p1", reason="awaiting approval")
failproofai_sdk.event.agent_resume(pause_id="p1")
```

`outcome` is `"failed"`, never `"failure"` — only `error|failed|timeout|rejected`
count as a failure server-side.

### models

```python
failproofai_sdk.event.model_request(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "..."}],
    request_id="req-1",          # optional; pairs the two events explicitly
)
failproofai_sdk.event.model_response(
    model="gpt-4o-mini",
    content="...",
    input_tokens=139,
    output_tokens=21,
    request_id="req-1",
    duration_ms=5202,            # int, never float
)
```

Pass `request_id` if you make concurrent model calls — without it the dashboard
pairs requests and responses FIFO per agent, and concurrent calls mis-pair.

### tools

```python
failproofai_sdk.event.tool_use(tool_name="search", tool_call_id="c1", input={"q": "..."})
failproofai_sdk.event.tool_result(tool_name="search", tool_call_id="c1", output="...", error=None)
```

`tool_call_id` is what pairs them. Prefer the `tool_call()` scope, which
guarantees the pair even when the body raises.

### hooks

```python
failproofai_sdk.event.hook_triggered(hook_name="retrieve", hook_id="h1", trigger_event="node")
failproofai_sdk.event.hook_completed(hook_name="retrieve", hook_id="h1", outcome="success")
```

Use these for node, step or middleware boundaries — **not** nested `agent()`
calls. `agent_id` is a low-cardinality facet, and one entry per node drowns it.

### humans

```python
failproofai_sdk.event.human_wait(input_id="i1", prompt="Approve?", options=["yes", "no"])
failproofai_sdk.event.human_input(input_id="i1", response="yes")

failproofai_sdk.event.human_pause(reason="operator paused the run", user_id="dana")
failproofai_sdk.event.human_interrupt(reason="operator stopped the run", at_step="step_3")
```

`human_wait`/`human_input` = *the agent asked a person*.
`human_pause`/`human_interrupt` = *a person acted on the agent* — a stop button,
an operator intervention. No framework signals the second pair, so it is always
yours.

Emit `agent_pause`/`agent_resume` around a human wait too: only that pair feeds
paused time, and without it the wait is billed as active agent time.

### failures

```python
failproofai_sdk.event.error(
    error_type="TimeoutError",
    message="provider timed out after 30s",
    traceback="...",
)
```

Usually emitted for you by `agent()`. Call it directly for a failure that does
not raise — a validation rejection, a guardrail trip.

---

## A complete example

A real tool-calling loop against the OpenAI API, with no agent framework at all:

```python
import json

import failproofai_sdk
from openai import OpenAI

failproofai_sdk.configure(environment="production")

client = OpenAI()
MODEL = "gpt-4o-mini"

PRICE = {"widget": 42.0, "gadget": 17.5}
STOCK = {"widget": 120, "gadget": 0}

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "price_of",
            "description": "Unit price of an item.",
            "parameters": {
                "type": "object",
                "properties": {"item": {"type": "string"}},
                "required": ["item"],
            },
        },
    },
]


def run_tool(name: str, args: dict) -> str:
    if name == "price_of":
        return str(PRICE[args["item"].lower().strip()])
    raise LookupError(f"unknown tool {name!r}")


def turn(messages: list):
    """One LLM call, bracketed by the model pair."""
    failproofai_sdk.event.model_request(model=MODEL, messages=messages)
    reply = client.chat.completions.create(model=MODEL, messages=messages, tools=TOOLS)
    usage = reply.usage
    failproofai_sdk.event.model_response(
        model=MODEL,
        content=reply.choices[0].message.content or "",
        input_tokens=usage.prompt_tokens,
        output_tokens=usage.completion_tokens,
    )
    return reply.choices[0].message


messages = [
    {"role": "system", "content": "Use the tools for every number. Be terse."},
    {"role": "user", "content": "Price for widget and gadget?"},
]

with failproofai_sdk.session():
    with failproofai_sdk.agent("inventory", goal="price report"):
        for _ in range(4):          # bounded: an unbounded agent loop is its own bug
            message = turn(messages)
            calls = message.tool_calls or []
            if not calls:
                print(message.content)
                break

            messages.append(message.model_dump(exclude_none=True))
            for call in calls:
                args = json.loads(call.function.arguments or "{}")
                # tool_call() emits tool_use now and tool_result on exit,
                # turning a raised exception into `error` on the result.
                with failproofai_sdk.tool_call(
                    call.function.name, tool_call_id=call.id, input=args
                ) as handle:
                    handle.output = run_tool(call.function.name, args)
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": str(handle.output),
                })
```

Produces **14 events across 6 types** — the same shape an adapter would give
you:

```
     1   +0.000s  agent_start       inventory
     2   +0.000s    model_request   gpt-5.6-terra
     3   +3.962s    model_response  gpt-5.6-terra · 96 out-tok
     4   +3.962s    tool_use        price_of
     5   +3.962s    tool_result     price_of · ok
     ...
    12   +3.962s    model_request   gpt-5.6-terra
    13   +8.459s    model_response  gpt-5.6-terra · 29 out-tok
    14   +8.459s  agent_end         inventory · success
```

---

## Threads and async

contextvars propagate into asyncio tasks **automatically**. They do **not**
propagate into new threads — a thread starts with an empty context.

```python
import failproofai_sdk

# asyncio: nothing to do
async with failproofai_sdk.session():
    await asyncio.gather(worker(1), worker(2))       # both see the session

# threads: wrap the callable
pool.submit(failproofai_sdk.propagate(work), x)
pool.map(failproofai_sdk.propagate(work), items)
threading.Thread(target=failproofai_sdk.propagate(work)).start()
loop.run_in_executor(None, failproofai_sdk.propagate(work), x)
```

Without `propagate()`, the worker's events raise a `TypeError` naming the fix,
rather than silently landing on no session.

`propagate()` snapshots identity *values*, not the `Context` object — a
`Context` cannot be entered by two threads at once, so the obvious
`copy_context().run` form crashes on any reuse such as `pool.map`.

---

## Instrumenting an unsupported framework

Most agent frameworks give you three seams. Map them and you have a complete
trace.

**1. Bracket the run** — wherever your framework starts and finishes a unit of
work:

```python
with failproofai_sdk.session():
    with failproofai_sdk.agent(agent_name, goal=task):
        result = framework.run(task)
```

**2. Bracket each tool** — in whatever the framework calls a tool wrapper or
middleware:

```python
with failproofai_sdk.tool_call(name, input=args) as call:
    call.output = original(**args)
```

**3. Pair each model call** — around the provider call:

```python
failproofai_sdk.event.model_request(model=model, messages=messages)
reply = provider.complete(...)
failproofai_sdk.event.model_response(
    model=model, content=text,
    input_tokens=usage.prompt_tokens,
    output_tokens=usage.completion_tokens,
)
```

If the framework has a node, step or middleware boundary worth seeing, add
`hook_triggered` / `hook_completed` around it. Do **not** promote it to a nested
`agent()`.

### If the framework has a global callback surface

If it does expose a process-wide registration point, four rules from the shipped
adapters are worth copying:

- **Never raise into the caller.** Wrap every callback so a bug in yours cannot
  affect the instrumented call.
- **Do not hold a contextvar token between two callbacks.** When start and end
  are separate calls, `ContextVar.reset(token)` raises across asyncio tasks and
  threads alike. Keep a map from the framework's own run id to identity, and pass
  `session_id=` / `agent_id=` explicitly.
- **Bound every map.** Orphaned starts are normal — a crashed run, an unconsumed
  stream, a skipped end callback. Unbounded, that is a leak in a long-lived
  server.
- **Restore exactly what you replaced.** Save the original attribute object; if
  it is no longer yours at teardown, leave it alone rather than deleting somebody
  else's patch.

---

## Why there is no AutoGen adapter

Two reasons, and both are decisions rather than backlog items.

**`autogen-core` is discontinued.** The `autogen-core` / `autogen-agentchat`
line has been unmaintained since 2025-09-30. An adapter against a dead callback
surface is a dependency that cannot be fixed when it drifts.

**AG2 has no global auto-instrument hook.** AG2 — the community fork — exposes
no process-wide registration point equivalent to LangChain's configure hook,
CrewAI's event bus, LlamaIndex's dispatcher or Pydantic AI's capability list.
Instrumenting it means wrapping each agent at each construction site, which is a
wrapper you paste into your own code — precisely the ergonomics the adapters
exist to remove.

If AutoGen matters to you, the three seams above record the same fifteen event
types at the same fidelity. It just costs you the call sites.

---

## Pitfalls

### Spans that never finish

**Symptom:** the dashboard shows a run still going, hours later.

**Cause:** an opening event with no closing one — a `model_request` with no
`model_response`, or a `tool_use` with no `tool_result`.

**Fix:** use the scopes, which guarantee the pair even when the body raises. If
you call `event.*` by hand, use `try` / `finally`.

---

### `ValueError: duration_ms is auto-computed`

**Symptom:** passing `duration_ms` to a closing event raises.

**Cause:** it is measured by the SDK from the matching opening event, so passing
it is rejected on `tool_result`, `hook_completed`, `agent_resume` and
`human_input`.

**Fix:** do not pass it. The exception is `model_response`, where it **is**
accepted, because only you know the real provider latency — and it must be an
`int` — a float raises `ValueError` at the call site, because the server would store NULL for it.

---

### `TypeError: ... missing session_id`

**Symptom:** a `TypeError` naming `session_id` from inside a worker.

**Cause:** you emitted from a thread that never inherited the context.

**Fix:** `failproofai_sdk.propagate()`. See [Threads and async](#threads-and-async).

This is deliberately a loud error rather than a silent drop: an event with no
session is skipped by ingest and answered `200`, which is the exact silent
failure the identity layer exists to prevent.

---

### Extra fields silently disappearing

**Symptom:** you passed `model="x"` as an extra field and it did not show up, or
it overwrote something.

**Cause:** extras are merged **last**, so an extra named like a declared field —
`tool_name`, `model`, `outcome`, `input_tokens` — would overwrite the real field
and change a promoted column.

**Fix:** namespace yours. The adapters use an `fw_` prefix:

```python
failproofai_sdk.event.tool_use(
    tool_name="search", tool_call_id="c1",
    my_region="eu-west-1",        # fine
    # model="x",                  # dropped, with a warning
)
```

---

### `agent_id` full of UUIDs

**Symptom:** the agent filter has thousands of entries.

**Cause:** `agent_id` is a low-cardinality facet column, and you put a run id in
it.

**Fix:** use a role or node name. Put the real id in a payload field.

---

## Runnable examples

| file | what it shows | events |
|---|---|---|
| [`examples/quickstart.py`](examples/quickstart.py) | the three scopes, ~40 lines | 6 |
| [`examples/research_agent.py`](examples/research_agent.py) | a real OpenAI tool-calling loop, hand-instrumented | 14 |

```bash
pip install failproofai-sdk openai
export OPENAI_API_KEY=sk-...
export FPAI_MODEL=gpt-4o-mini
python docs/manual/examples/quickstart.py
```

Both were run against a live model before shipping.
