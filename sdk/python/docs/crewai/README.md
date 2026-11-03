# CrewAI

- [Install](#install)
- [The integration](#the-integration)
- [How it attaches](#how-it-attaches)
- [What gets recorded](#what-gets-recorded)
- [A complete example](#a-complete-example)
- [Agent names come from roles](#agent-names-come-from-roles)
- [Options](#options)
- [Human in the loop](#human-in-the-loop)
- [Pitfalls](#pitfalls)
- [Runnable examples](#runnable-examples)

---

## Install

```bash
pip install 'failproofai-sdk[crewai]'        # pins crewai >=1.13,<2
```

**Supported:** `crewai` 1.13 → 2.0. 1.13 is a capability floor, not a guess — it
is the release that added `started_event_id` and normalised token usage, both of
which the adapter relies on to pair events and report tokens.

---

## The integration

```python
import failproofai_sdk

failproofai_sdk.configure(environment="production")
failproofai_sdk.instrument()

with failproofai_sdk.session():
    Crew(agents=[analyst, writer], tasks=[gather, summarise]).kickoff()
```

Nothing about your crew, agents, tasks or tools changes.

---

## How it attaches

`instrument()` constructs a listener on CrewAI's module-level
`crewai_event_bus` and subscribes one handler per event class.

Two details that matter if you are debugging:

**The bus dispatches by exact type, with no MRO walk.** There is no `BaseEvent`
catch-all to subscribe to, so the adapter carries an explicit table of every
class it maps. A CrewAI release that renames an event class disables exactly
that one hook (with a warning) rather than breaking the adapter.

**Every handler is `async def`, deliberately.** The bus dispatches *sync*
handlers onto a ten-worker pool where submission order is not execution order.
Measured on crewai 1.15.8, sync handlers produced a demonstrably wrong event
stream — pairs closing before they opened. Async handlers run in order.

---

## What gets recorded

| CrewAI | Failproof event | When |
|---|---|---|
| crew kickoff | `agent_start` / `agent_end` | the crew starts and finishes |
| flow start / finish | `agent_start` / `agent_end` | a flow you wrote |
| agent execution | nested `agent_start` / `agent_end` | `agent_id` = the **role** |
| task | *nothing* — recorded as a link | see below |
| flow method | `hook_triggered` / `hook_completed` | each `@start` / `@listen` method |
| guardrail | `hook_triggered` / `hook_completed` | each LLM guardrail |
| tool usage | `tool_use` / `tool_result` | each tool call |
| memory query / save / retrieve | `tool_use` / `tool_result` | named `memory.query`, `memory.save`, … |
| knowledge query / retrieve | `tool_use` / `tool_result` | named `knowledge.query`, … |
| LLM call | `model_request` / `model_response` | each model call, with usage |
| LLM stream chunk | *nothing* | folded into `fw_chunks`, `fw_ttft_ms` |
| human feedback requested | `human_wait` + `agent_pause` | the flow blocks on a person |
| human feedback received | `agent_resume` + `human_input` | the person answers |
| agent execution error | `error` + `agent_end(outcome="failed")` | the agent raises |

### Why a task emits nothing

A CrewAI task is a subset of the agent execution that runs it. Emitting both
would double every row in the timeline and render them as siblings, which is
simply wrong — the task *contains* the agent work, it does not run beside it.

The task is still recorded: it is registered as a link so its children resolve
to the crew above them, and its id and name ride along on the agent's own events
as `fw_task_id` and `fw_task_name`. You can filter by task; you just do not get
a duplicate span.

### Why memory and knowledge ops are tools

They are retrieval calls the agent makes. Naming them for the surface they hit
(`memory.query`, `knowledge.retrieve`) rather than the class that fired means
they show up on the tools page next to your real tools, where you actually want
to compare their latency.

---

## A complete example

```python
import failproofai_sdk
from crewai import Agent, Crew, Process, Task
from crewai.tools import tool

failproofai_sdk.configure(environment="production")
failproofai_sdk.instrument()

MODEL = "openai/gpt-4o-mini"

METRICS = {
    "revenue": "$4.2M ARR, up 12% QoQ",
    "churn": "3.1% monthly logo churn, up from 2.4%",
    "nps": "41, flat",
}


@tool("lookup_metric")
def lookup_metric(name: str) -> str:
    """Look up a business metric by name. Valid: revenue, churn, nps."""
    return METRICS.get(name.lower().strip(), "unknown metric")


analyst = Agent(
    role="analyst",                       # <- this becomes agent_id
    goal="pull the numbers that matter and state them plainly",
    backstory="You read dashboards for a living and distrust round numbers.",
    tools=[lookup_metric],
    llm=MODEL,
)
writer = Agent(
    role="writer",
    goal="turn numbers into three lines an exec will actually read",
    backstory="You write board updates. You never pad.",
    llm=MODEL,
)

gather = Task(
    description="Look up 'revenue', 'churn' and 'nps' with the tool.",
    expected_output="Three lines, one metric each.",
    agent=analyst,
)
summarise = Task(
    description="Using the metrics above, write a three-line exec summary.",
    expected_output="Exactly three lines.",
    agent=writer,
    context=[gather],
)

with failproofai_sdk.session():
    result = Crew(
        agents=[analyst, writer],
        tasks=[gather, summarise],
        process=Process.sequential,
    ).kickoff()

print(result)
```

This produces **17–18 events across 6 types**, with the handoff visible:

```
     1   +0.000s  agent_start       crew
     2   +0.049s    agent_start     analyst · under crew
     3   +0.055s      model_request  gpt-5.6-terra
     4   +3.112s      model_response  gpt-5.6-terra · 65 out-tok
     5   +3.114s      tool_use      lookup_metric
     ...
    13   +5.129s    agent_end       analyst · success
    14   +5.149s    agent_start     writer · under crew
    15   +5.156s      model_request  gpt-5.6-terra
    16   +8.177s      model_response  gpt-5.6-terra · 48 out-tok
    17   +8.205s    agent_end       writer · success
    18   +8.224s  agent_end         crew · success
```

Two roles, two spans, one session — you can now break latency and token spend
down per role.

---

## Agent names come from roles

`agent_id` is taken from `Agent(role=...)`. That is what makes it a useful
dashboard facet instead of a UUID nobody can read.

```python
Agent(role="analyst", ...)      # agent_id = "analyst"     good
Agent(role="analyst-7f3a2b", ...)   # one facet entry per run    bad
```

`agent_id` is a `LowCardinality(String)` column. A role containing a run id or a
timestamp degrades that column for every query anyone runs. Keep roles short,
human, and stable across runs.

If a role looks like an id (a UUID, a long hex string), the adapter refuses it
and falls back to a safe default, putting the real value in `fw_agent_id`.

---

## Options

```python
failproofai_sdk.instrument(
    "crewai",
    session_id=None,          # pin every run to one session id
)
```

`session_id` is the only option this adapter reads — there is no
`capture_content` here. Prompts and completions are always recorded, truncated
to the payload budget.

Session identity resolves as: the `session_id` option, then the enclosing
`failproofai_sdk.session()` scope, then a generated `uuid4().hex` per crew or
flow.

---

## Human in the loop

CrewAI's flow runtime emits `HumanFeedbackRequestedEvent` before it blocks on a
person and `HumanFeedbackReceivedEvent` after the answer. Both are recorded, as
four events:

```
human_wait      prompt, options
agent_pause     starts the paused-time clock
   ... a person is reading ...
agent_resume    stops it — this is what feeds paused time
human_input     the answer, with the wait measured
```

Neither pair is redundant. `human_wait` → `human_input` carries the prompt and
the answer; `agent_pause` → `agent_resume` is the only thing that feeds paused
time. Without the second pair, a ten-minute human wait is billed as ten minutes
of active agent time.

> **CrewAI sets no correlation id on either event.** `request_id` is `None` on
> both and `started_event_id` is `None` on the received one, so there is nothing
> to join on directly. The adapter pairs on `request_id` when present (the
> enterprise async provider does set it), then on `(flow_name, method_name)`,
> then on the most recently opened pause. The last fallback is sound because a
> console prompt blocks — two cannot interleave. **If you build your own
> concurrent feedback provider, set `request_id` on both events.**

Feedback arriving for a request that was never seen — a flow resumed in another
process, say — records the answer but deliberately withholds `agent_resume`,
because closing a pause that never opened would subtract an interval that was
never added.

---

## Pitfalls

### Roles with ids in them wreck the facet

**Symptom:** the agent filter on the dashboard has thousands of entries.

**Cause:** `role` contains a UUID, a timestamp or a per-run suffix.

**Fix:** use a stable human role. Put the run-specific id in the task
description or a payload field.

---

### Asserting on events straight after `kickoff()` finds nothing

**Symptom:** your test reads zero events, but the dashboard shows them.

**Cause:** the bus is asynchronous. `kickoff()` returns before the last handlers
have run.

**Fix:**

```python
from crewai.events.event_bus import crewai_event_bus

crew.kickoff()
crewai_event_bus.flush(timeout=30)   # now read
```

This is a property of CrewAI, not of the SDK.

---

### A crew that dies mid-tool leaves an open span

**Symptom:** a session shows as `ongoing` forever.

**Cause:** `agent_end` force-closes open *pauses* but not tools or models, so a
run that dies inside a tool call leaves that `tool_use` unclosed.

**Fix:** none needed in normal operation — `uninstrument()` and process teardown
close whatever is still open, marking it `fw_incomplete` with
`outcome="cancelled"`. If you are killing processes with `SIGKILL`, nothing can
run, and the span stays open.

---

### Nothing is recorded at all

1. Did `instrument()` run before `kickoff()`?
2. Is there a `with failproofai_sdk.session():` around it?
3. Set `FAILPROOFAI_SDK_STRICT=1` and run again — a degraded hook will raise
   instead of being swallowed.
4. Check your `crewai` version is ≥ 1.13. Below that, `started_event_id` does
   not exist and pairing falls back to a heuristic.

---

## Runnable examples

| file | what it shows | events |
|---|---|---|
| [`examples/quickstart.py`](examples/quickstart.py) | one agent, one task, one tool | 10 |
| [`examples/research_crew.py`](examples/research_crew.py) | 2 agents, 2 tasks, sequential handoff | 17 |

```bash
export OPENAI_API_KEY=sk-...
export FPAI_MODEL=gpt-4o-mini
python docs/crewai/examples/quickstart.py
```

Both were run against a live model before shipping.
