# Writing the integration

Identity is ambient. Bind it once per run with a context manager and every
`event.*` call inside — including calls in functions that have never heard of
Failproof AI — lands on the right session and agent.

You do not write the contextvar layer any more; it ships. This page is how to use
it, and what the two failure modes it exists to prevent look like when you route
around it.

On a supported framework (LangChain/LangGraph, CrewAI, LlamaIndex, Pydantic AI),
read `frameworks.md` first — `failproofai_sdk.instrument()` does all of this for you.

## The three scopes

```python
import failproofai_sdk

failproofai_sdk.configure(environment="production")

with failproofai_sdk.agent("planner", goal=question):            # agent_start / agent_end
    with failproofai_sdk.tool_call("web_search", input={"q": question}) as t:
        t.output = search(question)
```

| Scope | Emits | Yields |
|---|---|---|
| `failproofai_sdk.session(session_id=None, *, agent_id=None)` | **nothing** — identity only | the session id |
| `failproofai_sdk.agent(agent_id="main", *, session_id=None, goal=None, parent_id=AUTO, outcome="success", summary=None, **fields)` | `agent_start` on entry, `agent_end` on every exit | an `Identity` |
| `failproofai_sdk.tool_call(tool_name, *, tool_call_id=None, input=None, **fields)` | `tool_use` / `tool_result`, timed | a handle — set `.output`, read `.id` |

Every one of them works as `with` **and** `async with`, with identical semantics
and byte-identical events. Nothing in a scope awaits, so the async form is the
same code; use whichever matches the function you are in.

Read the current identity anywhere with `failproofai_sdk.current()`, which returns a
frozen `Identity(session_id, agent_id, parent_id, depth)`. `session_id is None`
means nothing is bound.

**`session()` versus `agent()`.** `session()` binds identity and emits nothing —
reach for it when the run is brackets you do not own (a request handler that
delegates to a framework), or when you want one session id to cover several
`agent()` blocks. `agent()` is what creates the session on the platform, because
a session is *defined* as something that emitted `agent_start`.

**Defaults, all of them chosen to be hard to get wrong:**

- `session_id=None` on `agent()`/`session()` inherits an already-bound session,
  and generates a `uuid4().hex` only if there is none. A nested scope stays inside
  one run rather than splitting it in two.
- `parent_id` defaults to the enclosing agent from the scope stack. Pass
  `parent_id=None` to force a root span, or a string to override.
- `tool_call_id` defaults to `uuid4().hex` — unique process-wide, which is what
  the correlation map needs (see `events.md`).

## What `agent()` does on the way out

This is the exit path hand-written instrumentation always gets wrong, so it is
worth stating exactly:

| Exception | Events, in order | `outcome` |
|---|---|---|
| none | `agent_end` | `"success"` (or your `outcome=`) |
| any `Exception` | `error`, **then** `agent_end` | `"failed"` |
| `KeyboardInterrupt` / `SystemExit` | `error`, then `agent_end` | `"failed"` |
| `CancelledError` / `GeneratorExit` | `agent_end` only | `"cancelled"` |

The exception is always re-raised. `error` comes strictly *before* `agent_end`,
because the agent span closes at `agent_end` and anything after it is attributed
to nothing. A cancellation is not a failure and must not pollute the Errors
surface, so it emits no `error` event.

`tool_call()` on failure emits `tool_result(error="TypeName: message")` and **no
`error` event** — a tool failure the agent loop catches is not a run-level error,
and one that propagates is reported exactly once, by the enclosing `agent()`.

## Explicit identity still works

`session_id` and `agent_id` are optional keyword arguments on all 15 `event.*`
methods, not removed ones. Passing them explicitly still works, and still wins
over whatever is bound:

```python
failproofai_sdk.event.tool_use(session_id=sid, agent_id="planner",
                        tool_name="web_search", tool_call_id="toolu_01")
```

Omit `session_id` with nothing bound and you get a **`TypeError`** naming both
fixes. That is deliberate: the alternative is dropping the event silently, and
this SDK already asks you to debug enough invisible failures. `agent_id` never
raises — it is a label, and it falls back to `"main"`.

## Don't use a module global

The shortcut the scopes exist to replace, because it breaks silently:

```python
# WRONG
_current_session = None       # or self.session_id on a shared client
```

The moment two runs overlap — two asyncio tasks, two threads, two requests in one
process — they share this variable. Events from both runs get whichever
`session_id` was written last. You do not get an error; you get **one session
containing two runs' events, interleaved**, and another session missing entirely.
Nothing about the output says the data is wrong.

The scopes bind contextvars instead: per-task and per-thread, so overlapping runs
cannot see each other's identity. The agent stack they keep is immutable for the
same reason — a mutable stack shared by reference between tasks is the same bug
wearing a contextvars costume, and it passes every single-threaded test.

## Threads will drop your events — `propagate()` is the fix

This one is worth reading twice, because it is the failure everybody hits.

`contextvars` propagate into asyncio tasks automatically — a task started inside
an `agent()` block inherits the session. **They do not propagate into new
threads.** A fresh thread starts with an empty context, so nothing is bound
there.

```python
# WRONG — the worker has no session
pool.submit(dispatch, tool_call)
```

Wrap the callable:

```python
pool.submit(failproofai_sdk.propagate(dispatch), tool_call)
pool.map(failproofai_sdk.propagate(work), items)
threading.Thread(target=failproofai_sdk.propagate(work)).start()
loop.run_in_executor(None, failproofai_sdk.propagate(work), x)
```

`propagate(fn)` captures the identity bound *at the moment you call it* and binds
it inside the worker, then restores what was there. One name covers thread pools,
bare threads and `run_in_executor`.

**Do not reach for `contextvars.copy_context().run` instead.** A `Context` object
cannot be entered by two threads at once — the second gets `RuntimeError: cannot
enter context` — so the copy-context form crashes the caller's worker on any
reuse, which is exactly what `pool.map` and a retried submit do. Mutations made
inside `ctx.run` also persist in that `Context`, so a reused one leaks the
previous call's agent stack into the next run.

Since events now raise rather than vanish when nothing is bound, an un-propagated
worker announces itself with a `TypeError` naming `failproofai_sdk.propagate` instead of
producing a session that is quietly missing half its events.

## Where to put the calls

**One tool dispatcher.** Most agents route every tool through one function. That
is one edit site for all tools:

```python
def dispatch(tool_call):
    with failproofai_sdk.tool_call(tool_call.name, tool_call_id=tool_call.id,
                            input=tool_call.input) as t:
        t.output = TOOLS[tool_call.name](**tool_call.input)
        return t.output
```

Reuse the framework's own tool-call id — Anthropic and OpenAI both give you one.
It is already unique, and it makes the events line up with your provider logs.

**One LLM wrapper.** Same idea on the model side. Pass a `request_id` on both
halves so concurrent calls pair correctly, and set `duration_ms` yourself on the
response — it is not auto-computed for model events:

```python
def call_model(messages, **kw):
    rid = uuid.uuid4().hex
    started = time.monotonic()
    failproofai_sdk.event.model_request(model=MODEL, messages=messages, request_id=rid,
                                 tools=kw.get("tools"))
    try:
        resp = client.messages.create(model=MODEL, messages=messages, **kw)
    # BaseException, not Exception. `asyncio.CancelledError` inherits straight
    # from BaseException on every supported Python, so `except Exception` does
    # NOT see a cancelled tool — and a cancelled tool is a `tool_use` with no
    # `tool_result` after it: an orphaned event that also holds its correlation
    # slot until the cap evicts it. Cancellation is the ordinary way an async
    # tool ends when a timeout fires or a caller gives up.
    except BaseException as e:
        failproofai_sdk.event.model_response(
            model=MODEL, request_id=rid, error=f"{type(e).__name__}: {e}",
            duration_ms=round((time.monotonic() - started) * 1000))
        raise
    failproofai_sdk.event.model_response(
        model=resp.model, request_id=rid, stop_reason=resp.stop_reason,
        input_tokens=resp.usage.input_tokens, output_tokens=resp.usage.output_tokens,
        role=resp.role, duration_ms=round((time.monotonic() - started) * 1000))
    return resp
```

`duration_ms` must be a whole-millisecond **`int`** — a float raises `ValueError`
at the call site rather than silently emptying the column.

**Sub-agents.** One session, several actors. Nest the scopes and the wiring is
automatic — the inner `agent()` inherits the session and takes the outer agent as
its `parent_id`:

```python
async def researcher(topic):
    async with failproofai_sdk.agent("researcher", goal=topic):
        ...

async with failproofai_sdk.agent("planner", goal=question):
    await researcher(topic)          # session inherited, parent_id="planner"
```

**Yes, this means several `agent_start` events on one `session_id` — that is
correct and intended.** `SKILL.md` §2 says "emit `agent_start` at the top of the
run"; read that as *once per agent*, not once per session. One `agent_start` per
actor is what makes sub-agents appear as distinct, nested spans.

If a sub-agent runs in a different function that is called *outside* the parent's
block, pass `session_id=failproofai_sdk.current().session_id` explicitly rather than
letting it generate a new one.

**A service.** For an HTTP handler or a queue worker you usually already have a
per-run id — request id, job id, trace id. **Use it as the `session_id`** rather
than generating one: then a session in Failproof AI and a request in your own logs
are the same string, and cross-referencing an incident stops being detective
work.

```python
@app.post("/chat")
async def chat(req: Request, body: ChatBody):
    async with failproofai_sdk.agent("assistant", session_id=req.headers["x-request-id"],
                              goal=body.message):
        return await run_agent(body.message)
```

## Frameworks

| Framework | What to do |
|---|---|
| LangChain / LangGraph | `failproofai_sdk.instrument()` — see `frameworks.md` |
| CrewAI | `failproofai_sdk.instrument()` |
| LlamaIndex | `failproofai_sdk.instrument()` |
| Pydantic AI | `failproofai_sdk.instrument()` |
| a plain agent loop | `agent()` around the loop, `tool_call()` in the dispatcher |
| an HTTP agent service | `agent()` in request middleware, keyed on the request id |
| a queue worker | `agent()` around the job handler, keyed on the job id |
| anything else with a callback surface | `agent()` at its outermost boundary, `tool_call()` in its tool hook |

Adapters and hand-written scopes compose: instrument the framework, wrap the call
in your own `failproofai_sdk.agent(...)`, and the adapter's events join **that** session
with your agent as their parent. `frameworks.md` has the details.

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
    import failproofai_sdk
    with failproofai_sdk.agent("planner", goal="test"):
        pass
    failproofai_sdk._writer.flush_now()          # don't wait for the flush thread
    types = [e["type"] for e in events()]
    assert types == ["agent_start", "agent_end"]

def test_failure_is_recorded_as_failed(events):
    import failproofai_sdk, pytest
    with pytest.raises(ValueError):
        with failproofai_sdk.agent("planner"):
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

Assert on `type`, `session_id` and `outcome`. Those are the three that break
silently in production.

**Test the overlap, not just the happy path.** A single run passes even when
identity is a module global; mixing only shows up once two runs overlap, which is
production and not your laptop:

```python
import asyncio

def test_two_runs_do_not_mix(events):
    import failproofai_sdk

    async def run(name):
        async with failproofai_sdk.agent(name, session_id=name):
            await asyncio.sleep(0)                     # force the interleave
            failproofai_sdk.event.tool_use(tool_name="t", tool_call_id=f"{name}-1")

    async def both():
        await asyncio.gather(run("a"), run("b"))

    asyncio.run(both())
    failproofai_sdk._writer.flush_now()
    for e in events():
        assert e["agent_id"] == e["session_id"]        # no event crossed over
```

Without the `await asyncio.sleep(0)` the tasks do not interleave and the test
passes against a broken implementation, which makes it worthless.

**Add one test with an awkward payload**, because this is the failure that costs
you everything and it is invisible in normal testing:

```python
def test_unserializable_payload_does_not_kill_the_writer(events):
    import failproofai_sdk, datetime
    with failproofai_sdk.agent("planner"):
        with failproofai_sdk.tool_call("clock") as t:
            t.output = {"at": datetime.datetime.now()}      # a real tool does this
    failproofai_sdk._writer.flush_now()
    assert [e["type"] for e in events()] == [
        "agent_start", "tool_use", "tool_result", "agent_end"]
```

The awkward value is stringified by the SDK writer, and the later `agent_end`
must still be present. Keep this test because real tool outputs frequently carry
objects outside JSON's native type set.
