# Writing the integration

The SDK has no ambient session: every call needs `session_id` and `agent_id`, and
nothing carries them for you. Threading both through every function that might
emit an event is what makes instrumentation sprawl into a diff nobody wants to
review — and it is why integrations get abandoned halfway.

Bind identity once per run, read it at the call sites.

## Don't use a module global

The obvious shortcut breaks silently:

```python
# WRONG
_current_session = None       # or self.session_id on a shared client
```

The moment two runs overlap — two asyncio tasks, two threads, two requests in one
process — they share this variable. Events from both runs get whichever
`session_id` was written last. You do not get an error; you get **one session
containing two runs' events, interleaved**, and another session missing entirely.
Nothing about the output says the data is wrong.

Use `contextvars`. They are per-task and per-thread, and they are in the standard
library.

## The wrapper

One module. Drop it in the agent's package, import it at the call sites.

```python
# observability.py
import contextlib
import contextvars
import logging
import traceback
import uuid

import failproofai_sdk

log = logging.getLogger(__name__)

_session_id: contextvars.ContextVar[str] = contextvars.ContextVar("agenteye_session_id")
_agent_id: contextvars.ContextVar[str] = contextvars.ContextVar("agenteye_agent_id")

_FAILED = "failed"        # NOT "failure" — see SKILL.md §3
_SUCCESS = "success"


def current_session_id() -> str | None:
    """The session_id of the run in scope, or None. Needed by any sub-agent that
    is its own function rather than an inline block."""
    return _session_id.get(None)


def _emit(method: str, **fields) -> None:
    """Emit an event with identity filled in from the current run.

    Unsupported payload leaves are stringified by the SDK writer. This
    try/except covers mistakes made at the call site (a bad method name or a
    reserved field).
    """
    sid = _session_id.get(None)
    if sid is None:
        log.warning("failproofai_sdk: %s emitted outside a run() block — dropped", method)
        return
    try:
        getattr(failproofai_sdk.event, method)(
            session_id=sid, agent_id=_agent_id.get("main"),
            **fields,
        )
    except Exception:
        log.exception("failproofai_sdk: failed to emit %s", method)


@contextlib.contextmanager
def run(*, session_id: str | None = None, agent_id: str = "main",
        goal: str | None = None, parent_id: str | None = None):
    """Bracket one run. Emits agent_start on entry, agent_end on every exit."""
    sid = session_id or uuid.uuid4().hex
    t_sid = _session_id.set(sid)
    t_aid = _agent_id.set(agent_id)
    try:
        failproofai_sdk.event.agent_start(
            session_id=sid, agent_id=agent_id, goal=goal, parent_id=parent_id
        )
        try:
            yield sid
        except BaseException as e:
            _emit("error", error_type=type(e).__name__, message=str(e),
                  traceback=traceback.format_exc())
            failproofai_sdk.event.agent_end(session_id=sid, agent_id=agent_id,
                                     outcome=_FAILED, summary=f"{type(e).__name__}: {e}")
            raise
        else:
            failproofai_sdk.event.agent_end(session_id=sid, agent_id=agent_id, outcome=_SUCCESS)
    finally:
        _session_id.reset(t_sid)
        _agent_id.reset(t_aid)


class _Box:
    """Set .output inside a tool_call block to record the tool's result."""
    output = None


@contextlib.contextmanager
def tool_call(tool_name: str, *, tool_call_id: str | None = None, input=None):
    """Bracket one tool call. Emits tool_use/tool_result and times it."""
    tcid = tool_call_id or uuid.uuid4().hex
    _emit("tool_use", tool_name=tool_name, tool_call_id=tcid, input=input)
    box = _Box()
    try:
        yield box
    except Exception as e:
        _emit("tool_result", tool_name=tool_name, tool_call_id=tcid,
              error=f"{type(e).__name__}: {e}")
        raise
    else:
        _emit("tool_result", tool_name=tool_name, tool_call_id=tcid, output=box.output)


def model_request(**fields) -> None:
    _emit("model_request", **fields)


def model_response(**fields) -> None:
    _emit("model_response", **fields)


def submit(pool, fn, *args, **kwargs):
    """pool.submit, but the worker inherits the current run.

    Use this instead of pool.submit anywhere inside a run(). A bare submit gives
    the worker an empty context, so every event it emits is dropped — see
    "Threads will drop your events" below. Wrapping it here means a future call
    site cannot forget.
    """
    ctx = contextvars.copy_context()
    return pool.submit(ctx.run, lambda: fn(*args, **kwargs))
```

`tool_call_id` must be unique **process-wide**, not just within a run — the SDK
keys its correlation map on the bare id, so two concurrent runs drawing from a
small space (`random.randint(1, 999)`, or a per-run `call_1` counter) will
occasionally pair the wrong two events and report a confident wrong duration.
`uuid4` or your framework's own id. See `events.md`.

`run()` and `tool_call()` are sync context managers and work unchanged inside
`async def` — they wrap no I/O, so there is nothing to await.

## Using it

```python
import observability as obs

with obs.run(agent_id="planner", goal=user_question) as session_id:
    resp = call_model(messages)
    with obs.tool_call("web_search", tool_call_id=tc.id, input=tc.input) as t:
        t.output = search(tc.input["query"])
```

`agent_start`/`agent_end` and the error path come for free — including on an
exception, which is the exit path hand-written instrumentation always forgets.

## Where to put the calls

**One tool dispatcher.** Most agents route every tool through one function. That
is one edit site for all tools:

```python
def dispatch(tool_call):
    with obs.tool_call(tool_call.name, tool_call_id=tool_call.id,
                       input=tool_call.input) as t:
        t.output = TOOLS[tool_call.name](**tool_call.input)
        return t.output
```

Reuse the framework's own tool-call id — Anthropic and OpenAI both give you one.
It is already unique and it makes the events line up with your provider logs.

**One LLM wrapper.** Same idea on the model side:

```python
def call_model(messages, **kw):
    obs.model_request(model=MODEL, messages=messages, tools=kw.get("tools"))
    resp = client.messages.create(model=MODEL, messages=messages, **kw)
    obs.model_response(
        model=resp.model,
        stop_reason=resp.stop_reason,
        input_tokens=resp.usage.input_tokens,
        output_tokens=resp.usage.output_tokens,
        role=resp.role,
    )
    return resp
```

**Sub-agents.** One session, several actors. Reuse the parent's `session_id`;
give each actor its own `agent_id`; set `parent_id` to the **parent's `agent_id`**
(not a session id — that silently nests nothing):

```python
async def researcher(topic):
    with obs.run(session_id=obs.current_session_id(),   # NOT a new session
                 agent_id="researcher", parent_id="planner"):
        ...
```

**Yes, this means several `agent_start` events on one `session_id` — that is
correct and intended.** `SKILL.md` §2 says "emit `agent_start` at the top of the
run"; read that as *once per agent*, not once per session. One `agent_start` per
actor is what makes sub-agents appear as distinct, nested spans; a session with
one `agent_start` is simply a session with one actor. The session still exists
from the first one.

Use `current_session_id()` rather than threading `session_id` through as a
parameter — a sub-agent is usually its own function, and the whole point of the
contextvar is that you don't have to.

## Threads will drop your events

This one is worth reading twice, because it fails the quiet way.

`contextvars` propagate to asyncio tasks automatically — a task started inside a
`run()` block inherits the session. **They do not propagate to new threads.** A
thread starts with an empty context, so `_session_id.get(None)` returns `None`
there, and every event emitted from that thread is dropped.

So if the agent dispatches tools to a `ThreadPoolExecutor`, the naive version
records nothing from the workers:

```python
# WRONG — worker sees no session
pool.submit(dispatch, tool_call)
```

Copy the context in:

```python
import contextvars

ctx = contextvars.copy_context()
pool.submit(ctx.run, dispatch, tool_call)
```

The wrapper above logs a warning when this happens, which is the only reason you
will notice. If you see `emitted outside a run() block` in your logs, this is
almost always why.

## Frameworks

Nothing here is framework-specific — the wrapper is 60 lines of stdlib. Where a
framework gives you a callback surface, put `run()` at its outermost boundary and
`tool_call()` in its tool hook.

| Framework | Session bracket | Tool pair |
|---|---|---|
| plain loop | around the loop function | in the dispatcher |
| LangChain / LangGraph | around `.invoke()` / `.astream()`, or a callback handler's `on_chain_start` / `on_chain_end` | `on_tool_start` / `on_tool_end` |
| an HTTP agent service | request middleware, keyed on the request id | in the dispatcher |
| a queue worker | around the job handler, keyed on the job id | in the dispatcher |

For an HTTP service or a worker, you usually already have a per-run id (request
id, job id, trace id). **Use it as `session_id`** rather than generating a new
one — then a session in AgentEye and a request in your own logs are the same
string, and cross-referencing an incident stops being detective work.

## Testing your integration

Point the SDK somewhere disposable and read what came out:

```python
# conftest.py
import json, pathlib, pytest

@pytest.fixture
def events(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTEYE_HOME", str(tmp_path))
    import failproofai_sdk
    # flush_interval is huge on purpose: it parks the background thread so it
    # cannot race our explicit flush. Both paths write a file named only to the
    # millisecond, so two flushes in the same millisecond clobber each other and
    # you lose events — a flaky test with a real cause.
    failproofai_sdk.configure(base_dir=tmp_path, environment="test", flush_interval=3600)
    yield lambda: [
        json.loads(line)
        for f in sorted((tmp_path / "events").glob("*.jsonl"))
        for line in f.read_text().splitlines()
    ]
```

```python
def test_run_emits_a_session(events):
    import failproofai_sdk, observability as obs
    with obs.run(agent_id="planner", goal="test"):
        pass
    failproofai_sdk._writer.flush_now()          # don't wait 0.5s for the flush thread
    types = [e["type"] for e in events()]
    assert types == ["agent_start", "agent_end"]

def test_failure_is_recorded_as_failed(events):
    import failproofai_sdk, observability as obs, pytest
    with pytest.raises(ValueError):
        with obs.run(agent_id="planner"):
            raise ValueError("boom")
    failproofai_sdk._writer.flush_now()
    ev = {e["type"]: e for e in events()}
    assert ev["error"]["error_type"] == "ValueError"
    assert ev["agent_end"]["outcome"] == "failed"     # not "failure"
```

`failproofai_sdk._writer.flush_now()` drains the queue synchronously. Without it, a fast
test finishes before the flush cycle and reads an empty directory — a
flaky-looking failure with a real cause. Note the leading underscore: `_writer` is
not a public API, so pin your SDK version if your tests depend on it.

Assert on `type`, `session_id`, and `outcome`. Those are the three that break
silently in production.

**Add one test with an awkward payload**, because this is the failure that costs
you everything and it is invisible in normal testing:

```python
def test_unserializable_payload_does_not_kill_the_writer(events):
    import failproofai_sdk, datetime, observability as obs
    with obs.run(agent_id="planner"):
        with obs.tool_call("clock") as t:
            t.output = {"at": datetime.datetime.now()}      # a real tool does this
    failproofai_sdk._writer.flush_now()
    assert [e["type"] for e in events()] == [
        "agent_start", "tool_use", "tool_result", "agent_end"]
```

The awkward value is stringified by the SDK writer, and the later `agent_end`
must still be present. Keep this test because real tool outputs frequently carry
objects outside JSON's native type set.
