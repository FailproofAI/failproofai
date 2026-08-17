# Event catalog

Every method lives on `failproofai_sdk.event`, is **keyword-only**, returns `None`, and
requires `session_id: str` and `agent_id: str`. Nothing here blocks or does I/O —
the call queues the event and returns.

Emit only what fits the agent. There is no requirement to use every type, and no
penalty for skipping one — except `agent_start`, without which the session does
not exist at all.

## The 15 events

Columns: **Required** is beyond the universal `session_id` + `agent_id`.
*Optional fields are omitted from the record entirely when left unset* — they are
not written as `null`.

| Method | Required | Optional | Notes |
|---|---|---|---|
| `agent_start` | — | `goal`, `parent_id` | **Creates the session.** `parent_id` is the **`agent_id` of the parent agent** — not a session id, not a run id. Pass a session id here and you get no nesting, silently. |
| `agent_end` | — | `outcome`, `summary` | `outcome` must be `failed`/`error`/`timeout`/`rejected` to count as a failure. |
| `agent_pause` | `pause_id` | `reason`, `user_id` | Suspends the agent (waiting for a human, throttled, user-paused) **without ending it**. Starts the paused clock for this `pause_id`. |
| `agent_resume` | `pause_id` | `reason`, `user_id` | Emit **instead of a second `agent_start`** when a paused agent continues. `duration_ms` auto-computed — how long it was paused. |
| `tool_use` | `tool_name`, `tool_call_id` | `input` | Starts the duration clock for this `tool_call_id`. |
| `tool_result` | `tool_name`, `tool_call_id` | `output`, `error` | `duration_ms` auto-computed from the matching `tool_use`. |
| `model_request` | — | `model`, `messages`, `system`, `tools` | |
| `model_response` | — | `model`, `stop_reason`, `input_tokens`, `output_tokens`, `content`, `role` | Token counts drive spend reporting. |
| `error` | `error_type`, `message` | `traceback` | Always counts as an error, whatever else is set. |
| `hook_triggered` | `hook_name`, `hook_id` | `trigger_event`, `input` | Starts the clock for this `hook_id`. |
| `hook_completed` | `hook_name`, `hook_id` | `outcome`, `output`, `error` | `duration_ms` auto-computed. Same `outcome` rule as `agent_end`. |
| `human_wait` | `input_id` | `prompt`, `options`, `reason` | Starts the clock for this `input_id`. |
| `human_input` | `input_id` | `response` | `duration_ms` auto-computed — how long the human took. |
| `human_pause` | — | `reason`, `user_id` | |
| `human_interrupt` | — | `reason`, `user_id`, `at_step` | |

## Rules that apply to every event

**Payloads should be structured JSON where possible.** Serialization happens on
a background thread. Unsupported leaves such as `datetime`, `UUID`, `Decimal`,
`set`, `bytes`, or a Pydantic model are stringified automatically rather than
stopping the writer. If downstream analysis needs more than that string form,
serialize the value explicitly into a stable JSON object at the integration
boundary.

**Custom fields are free, and their *names* are unvalidated:**

```python
failproofai_sdk.event.tool_use(
    session_id=sid, agent_id="planner",
    tool_name="web_search", tool_call_id="toolu_01",
    input={"query": "..."},
    tenant="acme", retry_count=2,          # yours, kept verbatim
)
```

A misspelled **optional** name is not an error — it is a new field. `inpt={...}`
is accepted, stored, and invisible; nothing will tell you. When something is
missing from a surface, suspect a typo before suspecting the platform.

A misspelled **required** name is a plain `TypeError` — `tool_name` and friends
are real parameters, so `tool_nmae="search"` fails loudly at the call site. Only
the optional names are silent.

**Five names are reserved and raise `ValueError`.** `timestamp`, `session_id`,
`agent_id`, `type`, `environment` — passing any as a custom field. (`session_id`
and `agent_id` are already named args, so Python raises `TypeError` first.)

**`duration_ms` is yours to pass on eleven of the fifteen.** It is computed for you
on `tool_result`, `hook_completed`, `human_input`, and `agent_resume`, and passing
it to *those four* raises `ValueError`. On the other eleven there is no guard:
`agent_end(..., duration_ms=5)` is accepted and stored as an ordinary custom field. Don't.

**Correlation is one flat, process-wide map — not one per type.** The SDK keeps
open `tool_call_id` and `hook_id` values in a single dict keyed by the bare id.
Consequences, in order of how much they hurt:

- **`tool_call_id` and `hook_id` collide with each other.** A
  `hook_completed(hook_id="x")` will pair with a pending `tool_use(tool_call_id="x")`
  and emit a confident, wrong `duration_ms` spanning two unrelated events. Your
  ids must be unique across all concurrent runs **and across both namespaces**.
- **Per-run counters are unsafe.** `call_1`, `call_2` — common in home-grown loops
  — collide across overlapping runs. The failure is not the missing duration the
  docs might lead you to expect; it is a *plausible wrong number attributed to the
  wrong run*, which is worse. Reuse your framework's id (Anthropic and OpenAI
  tool-call ids are globally unique), or a `uuid4`.
- **`input_id` and `pause_id` are the exceptions**: both are scoped per
  session/agent (namespaced internally), so `human_wait`/`human_input` and
  `agent_pause`/`agent_resume` cannot collide across runs — or with the flat
  `tool_call_id`/`hook_id` namespace.
- **The pair must happen in the same process.** A `tool_use` in one worker and a
  `tool_result` in another produces two unpaired events and no duration.
- **The map is capped at 10,000 and evicts oldest-first**, so a long-running
  process that leaks orphaned starts can silently lose the duration on legitimate
  later pairs.

**Timestamps are set by the SDK** at the moment you call the method — UTC,
microsecond precision, `Z`-suffixed (`2026-07-17T09:15:22.123456Z`). You cannot
override it (`timestamp` is reserved).

**There is no event id.** Events carry no unique identifier and no sequence
number. They are ordered by timestamp and correlated by your ids. This means
events are not deduplicable — if you emit the same event twice, that is two
events.

## What one line looks like

Each record is one line of JSON in an `event-*.jsonl` file. Key order is stable:
identity first, then the event's own required fields, then `environment`, then
whatever optional and custom fields you set.

```json
{"timestamp": "2026-07-17T09:15:22.123456Z", "session_id": "run-001", "agent_id": "planner", "type": "tool_use", "tool_name": "web_search", "tool_call_id": "toolu_01", "environment": "production", "input": {"query": "latest AI research"}}
{"timestamp": "2026-07-17T09:15:23.456789Z", "session_id": "run-001", "agent_id": "planner", "type": "tool_result", "tool_name": "web_search", "tool_call_id": "toolu_01", "environment": "production", "output": {"results": ["..."]}, "duration_ms": 1333.6}
```

**Parse it; don't grep it.** The whitespace above is what today's writer happens
to emit — it is not a contract. `grep '"type":"agent_start"'` finds nothing on a
perfectly healthy integration, and reads as "my events are missing". Use
`python -m json.tool --json-lines`, or `jq`.

`environment` is always present. It is `"dev"` unless you set it — see
`../SKILL.md` §3.

## A minimal complete run

The shape to aim for. `agent_start` and `agent_end` bracket everything; the pairs
nest inside.

```python
import failproofai_sdk

failproofai_sdk.configure(environment="production")

sid = "run-001"
failproofai_sdk.event.agent_start(session_id=sid, agent_id="planner", goal="answer the user's question")
try:
    failproofai_sdk.event.model_request(session_id=sid, agent_id="planner", model="claude-opus-4-8",
                                 messages=[{"role": "user", "content": "..."}])
    failproofai_sdk.event.model_response(session_id=sid, agent_id="planner", model="claude-opus-4-8",
                                  stop_reason="tool_use", input_tokens=1200, output_tokens=95)

    failproofai_sdk.event.tool_use(session_id=sid, agent_id="planner",
                            tool_name="web_search", tool_call_id="toolu_01",
                            input={"query": "..."})
    failproofai_sdk.event.tool_result(session_id=sid, agent_id="planner",
                               tool_name="web_search", tool_call_id="toolu_01",
                               output={"results": ["..."]})
except Exception as e:
    import traceback
    failproofai_sdk.event.error(session_id=sid, agent_id="planner",
                         error_type=type(e).__name__, message=str(e),
                         traceback=traceback.format_exc())
    failproofai_sdk.event.agent_end(session_id=sid, agent_id="planner", outcome="failed")
    raise
else:
    failproofai_sdk.event.agent_end(session_id=sid, agent_id="planner",
                             outcome="success", summary="answered from 1 search")
```

Note `outcome="failed"` in the `except` — not `"failure"`, which silently reads as
a non-failure.

Threading `sid` through by hand like this is fine for one function and miserable
across a real codebase. See `integration.md`.

## Pausing and resuming — not ending

When a run suspends — waiting for a human, rate-limited, user-paused — do **not**
emit `agent_end` and then a fresh `agent_start` on the way back: that reads as two
separate agents, and the wait counts as active work. Bracket the gap with
`agent_pause` / `agent_resume` instead, reusing one `pause_id`:

```python
import uuid
pause_id = str(uuid.uuid4())
failproofai_sdk.event.agent_pause(session_id=sid, agent_id="planner",
                           pause_id=pause_id, reason="waiting_for_user")
#   … the run is parked; a human is deciding …
failproofai_sdk.event.agent_resume(session_id=sid, agent_id="planner", pause_id=pause_id)
```

The agent span stays open across the pause (it is not ended); `agent_resume`
carries the paused `duration_ms` when both halves run in the same process, and
paused time is reported separately from active work. Persist `pause_id` if the
resume happens in a different process so it reuses the same value.
