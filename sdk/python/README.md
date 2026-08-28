# failproofai-sdk

The Python SDK for [Failproof AI](https://befailproof.ai) agent observability. It
records what your agent did — tool calls, model requests, hooks, errors, waits for
a human — as structured events, and hands them to the daemon that ships them to
the platform.

- **PyPI distribution:** `failproofai-sdk`
- **Import name:** `failproofai_sdk`
- **Dependencies:** none. Standard library only, so installing it constrains
  nothing else in your environment.

## Evaluator v2 status

This package currently provides tracing and event emission only. The legacy
inbound `agenteye-evaluator` package has been retired; do not build new evaluator
services against its server-push HTTP contract. A customer-hosted, outbound-only
worker runtime will be added under the lazy `failproofai_sdk.evaluator` namespace
as part of Evaluator v2. Until that API ships, no evaluator module is included in
the distribution.

## Installation

```bash
pip install failproofai-sdk
# or
uv add failproofai-sdk
```

> **Do not `pip install agenteye`.** That distribution name is occupied on PyPI by
> a stranded build of an old CLI, which ships a module called `agenteye_cli` and is
> not this SDK. Installing it gives you `ModuleNotFoundError` at best, and — if
> this SDK is already present — pip treats it as an upgrade and **removes the SDK**
> to install the CLI. The import that worked five minutes ago then stops working.

## How events reach the platform

The SDK never opens a network connection. It appends events to an in-memory queue,
and a background thread writes them to local JSONL batches:

```
your agent  →  failproofai_sdk  →  ~/.failproofai/custom-agents/events/*.jsonl  →  daemon  →  platform
```

A daemon on the same host watches that directory and uploads each batch.
**`failproofaid` reads this root; the older `agenteye-collector` does not** — it
resolves `$AGENTEYE_HOME` or `~/.agenteye` and nothing else, so a host running
only that collector needs one of the three bridges in the upgrade note below, or
its batches pile up unread. If no daemon is running, batches simply accumulate on
disk — the SDK does not fail, and your agent does not block.

## Agent frameworks

If your agent runs on LangChain/LangGraph, CrewAI, LlamaIndex or Pydantic AI,
one line captures it — runs, sub-agents, tools, model calls and their token
counts — without threading an id through anything:

```python
import failproofai_sdk

failproofai_sdk.configure(environment="production")
failproofai_sdk.instrument()          # auto-detects what is already imported

graph.invoke({"messages": [...]})     # unchanged
```

```bash
pip install 'failproofai-sdk[langgraph]'     # or [langchain] [crewai] [llamaindex] [pydantic-ai]
```

The adapter code ships in the base wheel and imports its framework lazily, so
the extras are a convenience — `pip install failproofai-sdk` still declares no
dependencies at all, and `import failproofai_sdk` loads nothing outside the
standard library. See `skill/references/frameworks.md` for the per-framework
mapping, and `docs/` for a per-framework integration guide with runnable
examples beside it.

## Scopes

The same identity layer, for code the adapters do not cover. `session_id` and
`agent_id` are optional on every event method — omitted, they resolve from the
enclosing scope:

```python
with failproofai_sdk.session() as sid:
    with failproofai_sdk.agent("planner", goal=question):

        with failproofai_sdk.tool_call("search", input={"q": q}) as t:
            t.output = search(q)                 # tool_use / tool_result, timed

        with failproofai_sdk.agent("writer"):     # a sub-agent; parent inferred
            failproofai_sdk.event.model_request(model="...")
```

`agent()` brackets a run with `agent_start`/`agent_end` and records an `error`
before the end event when the block raises — a cancellation closes it as
`cancelled` rather than failed. Every scope works under `async with` too.

Contextvars do **not** cross into a new thread, so hand work over with
`propagate`:

```python
pool.submit(failproofai_sdk.propagate(work), item)
```

Nothing bound and nothing passed raises `TypeError` naming the fix. It is never
a silent emit: ingest skips an event with no session and answers `200`.

## Quick start

```python
import failproofai_sdk

# Call once at startup. Omit to use defaults (~/.failproofai/custom-agents;
# 500ms flush interval).
failproofai_sdk.configure(base_dir=None, flush_interval=0.5)

# Emit events via failproofai_sdk.event.<method>(...)
failproofai_sdk.event.agent_start(session_id="run-001", agent_id="planner", goal="answer user query")

failproofai_sdk.event.tool_use(
    session_id="run-001",
    agent_id="planner",
    tool_name="web_search",
    tool_call_id="toolu_01",
    input={"query": "latest AI research"},
)

failproofai_sdk.event.tool_result(
    session_id="run-001",
    agent_id="planner",
    tool_name="web_search",
    tool_call_id="toolu_01",     # matches tool_use — SDK auto-computes duration_ms
    output={"results": ["..."]},
)

failproofai_sdk.event.agent_end(session_id="run-001", agent_id="planner", outcome="success")
```

## configure()

```python
failproofai_sdk.configure(
    base_dir=None,        # Path | str | None. Default:
                          #   ~/.failproofai/custom-agents (honours $FAILPROOFAI_HOME)
    flush_interval=0.5,   # float, seconds between flush cycles
    environment=None,     # str | None. Else $AGENTEYE_ENVIRONMENT, else "dev"
)
```

Call once before any `event.*` call. Safe to omit — defaults work out of the box.
When `base_dir` is `None`, the SDK spools to `~/.failproofai/custom-agents`
(honouring `$FAILPROOFAI_HOME`, which moves the umbrella; the `custom-agents`
segment is always appended, so the spool is always inside it).

**`base_dir` is the only way to spool anywhere else.** No environment variable
redirects it.

**The default spool root moved.** It was `~/.agenteye`. The daemon this SDK ships
beside, `failproofaid`, watches **both** roots and always has, so on a host
running it this changes which directory the files land in and nothing else.
Batches already sitting in `~/.agenteye/events` are not orphaned — they stay put
and are still collected; that directory simply stops growing.

> [!IMPORTANT]
> **If you run the older `agenteye-collector`, point IT at this SDK — not the
> other way round.** That collector resolves `$AGENTEYE_HOME` or `~/.agenteye`
> and nothing else, so it does not watch where this SDK writes: no upload, no
> error, and an unread spool looks exactly like an idle one.
>
> `AGENTEYE_HOME` used to be the way back, and is not any more — this SDK no
> longer reads it, so exporting it moves the collector and leaves the SDK where
> it was. Pick one of:
>
> * run `failproofaid` instead — it watches **both** roots, so nothing needs
>   configuring; or
> * set **the collector's** `AGENTEYE_HOME=~/.failproofai/custom-agents`, so it
>   watches `~/.failproofai/custom-agents/events` — where this SDK writes; or
> * `configure(base_dir="~/.agenteye")` in the application, which is explicit
>   and visible at the call site.

`AGENTEYE_SPOOL_TO_FAILPROOFAI` is **retired**. It selected this root, but also
required the directory to already exist — and nothing ever created it, so the
opt-in never fired. Anyone who set it already wanted this and now gets it.

## Event reference

All event methods share two required fields:

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | `str` | Identifies the top-level agent run |
| `agent_id` | `str` | Identifies which agent within the session emitted the event |

Every method also accepts arbitrary `**fields` for custom metadata (see [Custom fields](#custom-fields)).

---

### `event.tool_use()`

Emitted when an agent invokes a tool. Pair with `tool_result` — the SDK auto-computes `duration_ms`.

```python
failproofai_sdk.event.tool_use(
    session_id="run-001",
    agent_id="planner",
    tool_name="web_search",    # str, required
    tool_call_id="toolu_01",   # str, required — correlation key for the matching tool_result
    input={"query": "..."},    # dict | None
)
```

---

### `event.tool_result()`

Emitted when a tool returns. Correlates with `tool_use` via `tool_call_id`.

```python
failproofai_sdk.event.tool_result(
    session_id="run-001",
    agent_id="planner",
    tool_name="web_search",
    tool_call_id="toolu_01",    # must match the prior tool_use
    output={"results": ["..."]},  # Any | None
    error=None,                   # str | None — set if the tool raised
    # duration_ms is computed automatically — do not pass it
)
```

---

### `event.model_request()`

Emitted just before sending a prompt to an LLM.

```python
failproofai_sdk.event.model_request(
    session_id="run-001",
    agent_id="planner",
    model="claude-opus-4-6",   # str | None
    messages=[                  # list[dict] | None — conversation turns
        {"role": "user", "content": "..."},
    ],
    system="You are helpful.",  # Any | None — str or list of content blocks
    tools=[                     # list[dict] | None — tool schemas offered to the model
        {"name": "search", "input_schema": {"type": "object"}},
    ],
)
```

`messages` entries accept either a plain string `content` or Anthropic-style list-of-blocks `content`. Sampling params (`temperature`, `max_tokens`, etc.) can be passed as extra kwargs.

---

### `event.model_response()`

Emitted when the LLM returns a response.

```python
failproofai_sdk.event.model_response(
    session_id="run-001",
    agent_id="planner",
    model="claude-opus-4-6",   # str | None
    stop_reason="end_turn",    # str | None
    input_tokens=1024,         # int | None
    output_tokens=256,         # int | None
    content=[                   # Any | None — str, or list of content blocks
        {"type": "text", "text": "..."},
    ],
    role="assistant",           # str | None
)
```

`content` accepts either a plain string (generic providers) or a list of Anthropic-style content blocks. Tool calls live inside `content` as `{"type": "tool_use", ...}` blocks — no separate `tool_calls` field.

---

### `event.agent_start()`

Emitted when an agent begins work.

```python
failproofai_sdk.event.agent_start(
    session_id="run-001",
    agent_id="planner",
    goal="answer user query",   # str | None
    parent_id=None,             # str | None — parent agent_id for nested agents
)
```

---

### `event.agent_end()`

Emitted when an agent finishes work.

```python
failproofai_sdk.event.agent_end(
    session_id="run-001",
    agent_id="planner",
    outcome="success",          # str | None
    summary="Answered query",   # str | None
)
```

---

### `event.agent_pause()`

Emitted when an agent is suspended (e.g. waiting for human input, user-requested
pause, throttling). Does **not** end the agent — pair it with `agent_resume`, and
the SDK auto-computes the paused `duration_ms`. Emit `agent_resume` instead of a
second `agent_start` when the agent continues.

```python
failproofai_sdk.event.agent_pause(
    session_id="run-001",
    agent_id="planner",
    pause_id="pause-abc",          # str, required — correlation key (reuse it on agent_resume)
    reason="waiting_for_user",     # str | None
    user_id="usr_42",              # str | None — who paused, if user-initiated
)
```

`pause_id` is emitted on both events, so a pause always pairs to its resume — even
when they happen in different processes (in that case `duration_ms` is omitted and
the interval is derived downstream from the two timestamps).

---

### `event.agent_resume()`

Emitted when a paused agent continues. Correlates with `agent_pause` via `pause_id`;
the SDK auto-computes `duration_ms` (how long the agent was paused).

```python
failproofai_sdk.event.agent_resume(
    session_id="run-001",
    agent_id="planner",
    pause_id="pause-abc",          # str, required — must match the prior agent_pause
    reason="user_resumed",         # str | None
    user_id="usr_42",              # str | None
    # duration_ms is computed automatically — do not pass it
)
```

---

### `event.hook_triggered()`

Emitted when a hook fires. Pair with `hook_completed` — the SDK auto-computes `duration_ms`.

```python
failproofai_sdk.event.hook_triggered(
    session_id="run-001",
    agent_id="planner",
    hook_name="pre_tool_use",   # str, required
    hook_id="hook-abc",         # str, required — correlation key
    trigger_event="tool_use",   # str | None
    input={"tool": "search"},   # Any | None
)
```

---

### `event.hook_completed()`

Emitted when a hook finishes. Correlates with `hook_triggered` via `hook_id`.

```python
failproofai_sdk.event.hook_completed(
    session_id="run-001",
    agent_id="planner",
    hook_name="pre_tool_use",
    hook_id="hook-abc",         # must match the prior hook_triggered
    outcome="allow",            # str | None
    output=None,                # Any | None
    error=None,                 # str | None
    # duration_ms is computed automatically — do not pass it
)
```

---

### `event.error()`

Emitted when an unhandled error occurs.

```python
failproofai_sdk.event.error(
    session_id="run-001",
    agent_id="planner",
    error_type="TimeoutError",  # str, required
    message="timed out",        # str, required
    traceback="Traceback...",   # str | None
)
```

---

## Custom fields

Any extra keyword arguments are appended to the event after the standard fields:

```python
failproofai_sdk.event.tool_use(
    session_id="run-001",
    agent_id="planner",
    tool_name="db_query",
    tool_call_id="toolu_02",
    request_id="req-123",       # custom field
    tenant_id="acme",           # custom field
)
```

The field names `timestamp`, `type`, and `environment` are reserved and raise
`ValueError` if passed as custom fields. `session_id` and `agent_id` are required
parameters and cannot be supplied a second time. Set the environment with
`configure(environment=...)` or `AGENTEYE_ENVIRONMENT`.

Keep payloads as structured JSON when downstream queries need their fields. Values
JSON does not natively support—such as datetimes, UUIDs, decimals, sets, bytes, or
model objects—are converted to strings so the writer can continue flushing the batch.

## JSONL output

Events are buffered in-process and flushed to disk every `flush_interval` seconds (default 500ms).
Each flush writes one JSONL file:

```
~/.failproofai/custom-agents/events/event-2026-04-01T12-00-00-000Z-48213-7.jsonl
```

Each line is one JSON object. Example:

```json
{"timestamp": "2026-04-01T12:00:00.000000Z", "session_id": "run-001", "agent_id": "planner", "type": "agent_start", "goal": "answer user query"}
{"timestamp": "2026-04-01T12:00:00.123456Z", "session_id": "run-001", "agent_id": "planner", "type": "tool_use", "tool_name": "web_search", "tool_call_id": "toolu_01"}
```

The batch is published by writing a `.tmp` file and atomically renaming it to
`.jsonl`, so a daemon polling the directory never reads a half-written file. The
trailing `<pid>-<seq>` keeps two batches written in the same millisecond — by two
threads, or by two agent processes sharing the spool — from overwriting each
other. You do not need to manage these files directly.

## Development

```bash
# Install dev dependencies
uv sync --locked --extra dev

# Run the test suite
uv run pytest tests/ -v

# Run a single test
uv run pytest tests/test_sdk.py -k duration -v
```

| Suite | What it holds |
|---|---|
| `test_sdk.py` | The public API — every event method, unit and on-disk |
| `test_wire_format.py` | Golden bytes for all 15 event types, frozen |
| `test_server_contract.py` | The keys ingest promotes to indexed columns |
| `test_spool_contract.py` | Agreement with the daemons that read the spool |
| `test_durability.py` | Concurrency, crash and retry paths — nothing silently lost |
| `test_zero_dependencies.py` | The stdlib-only guarantee |
| `test_no_customer_identifiers.py` | Nothing private ships in a public wheel |

Two suites reach for sources outside this package. `test_spool_contract.py` reads
the Rust and TypeScript in this repo and never skips; set
`FAILPROOFAI_SDK_REQUIRE_CONTRACT=1` (CI does) so a moved file fails instead of
skipping. Set `FP_AGENTEYE_ROOT` to an AgentEye checkout to additionally verify
against the older collector and the live ingest handler.
