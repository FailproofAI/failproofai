"""One event the encoder cannot handle must not take the others with it.

Serialisation used to be a single `json.dumps` over the whole drained batch, so
an unencodable payload was not a lost event — it was a lost SPOOL. `_flush`
returned the batch to the queue and re-raised, `_flush_loop` logged and retried
the identical batch on the next interval, and that repeated for the life of the
process. Every event emitted afterwards queued up behind the one that could not
be written, and the only outward sign was `Exception ignored in atexit callback`
on the way out, which reads as a crash in the host application.

`default=str` is not a defence. It is consulted for unsupported *values*, so it
rescues datetime, UUID and Decimal, and does nothing at all for a non-str dict
key or a reference cycle — the two shapes an ordinary agent payload actually
arrives in. A tuple-keyed cache and an ORM row holding a back-reference are both
perfectly reasonable things to hand a telemetry call.

Each test here is written so that it FAILS against the batch-wide encoder: they
assert on the events published beside the bad one, not on the bad one itself.
"""
import json
import logging

import pytest

from failproofai_sdk import _resolver
from failproofai_sdk._events import EventNamespace
from failproofai_sdk._writer import (
    _CYCLE_MARKER,
    _DEPTH_MARKER,
    _MAX_SANITIZE_DEPTH,
    EventWriter,
    _encode_entry,
    _sanitize,
)


@pytest.fixture
def spool(tmp_path):
    _resolver.set_base_dir(tmp_path)
    yield tmp_path
    _resolver.set_base_dir(None)


def read_all(spool_dir):
    events = []
    for path in sorted((spool_dir / "events").glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            events.append(json.loads(line))
    return events


# A payload key that cannot be coerced even by the fallback, so `_encode_entry`
# has to give up on the event rather than find a way through.
class _Unstringable:
    def __repr__(self):
        raise RuntimeError("nope")

    def __str__(self):
        raise RuntimeError("nope")

    def __hash__(self):
        return 0


# ─────────────────────────────────────────────────────────────────────────────
# The wedge itself
# ─────────────────────────────────────────────────────────────────────────────


def test_a_poison_payload_does_not_stop_the_events_around_it(spool):
    """The regression. One bad event, six good ones, and the six must land."""
    writer = EventWriter(flush_interval=3600)
    namespace = EventNamespace(writer)

    namespace.agent_start(session_id="s", agent_id="a", goal="before")
    # A cache keyed by tuple — `json.dumps` refuses this no matter what
    # `default=` is set to, because `default=` is never consulted for keys.
    namespace.tool_use(
        session_id="s", agent_id="a", tool_name="t", tool_call_id="c1",
        input={"cache": {(1, 2): "hit"}},
    )
    for i in range(5):
        namespace.agent_start(session_id="s", agent_id="a", goal=f"after-{i}")

    writer.flush_now()

    goals = {e.get("goal") for e in read_all(spool)}
    assert "before" in goals, "the event emitted BEFORE the bad one was lost with it"
    assert {f"after-{i}" for i in range(5)} <= goals, "events queued behind the bad one never published"


def test_the_spool_keeps_advancing_after_a_poison_payload(spool):
    """Not just this batch — every batch after it.

    The old failure was permanent: the same batch was retried forever, so no
    event emitted at any later point ever reached disk.
    """
    writer = EventWriter(flush_interval=3600)
    namespace = EventNamespace(writer)

    circular: dict = {}
    circular["self"] = circular
    namespace.tool_use(
        session_id="s", agent_id="a", tool_name="t", tool_call_id="c1", input=circular
    )
    writer.flush_now()

    namespace.agent_start(session_id="s", agent_id="a", goal="much-later")
    writer.flush_now()

    assert "much-later" in {e.get("goal") for e in read_all(spool)}


def test_the_queue_does_not_grow_behind_a_poison_payload(spool):
    """The wedge was also a leak: nothing drained, so everything accumulated."""
    writer = EventWriter(flush_interval=3600)
    namespace = EventNamespace(writer)

    namespace.tool_use(
        session_id="s", agent_id="a", tool_name="t", tool_call_id="c1",
        input={"bad": {(1, 2): "x"}},
    )
    for i in range(20):
        namespace.agent_start(session_id="s", agent_id="a", goal=f"g{i}")
    writer.flush_now()

    assert len(writer._queue) == 0, "entries were returned to the queue and will be retried forever"


# ─────────────────────────────────────────────────────────────────────────────
# What the fallback preserves, and what it gives up on
# ─────────────────────────────────────────────────────────────────────────────


def test_a_non_str_key_is_coerced_rather_than_dropped(spool):
    """Recovering the event beats discarding it; the payload is still readable."""
    writer = EventWriter(flush_interval=3600)
    EventNamespace(writer).tool_use(
        session_id="s", agent_id="a", tool_name="t", tool_call_id="c1",
        input={"counts": {1: "one", (2, 3): "two-three"}},
    )
    writer.flush_now()

    published = read_all(spool)
    assert len(published) == 1
    assert published[0]["input"]["counts"] == {"1": "one", "(2, 3)": "two-three"}


def test_a_cycle_becomes_a_marker_and_the_rest_of_the_event_survives(spool):
    writer = EventWriter(flush_interval=3600)
    payload: dict = {"name": "node", "size": 3}
    payload["self"] = payload
    EventNamespace(writer).tool_use(
        session_id="s", agent_id="a", tool_name="t", tool_call_id="c1", input=payload
    )
    writer.flush_now()

    published = read_all(spool)[0]
    assert published["input"]["self"] == _CYCLE_MARKER
    assert published["input"]["name"] == "node", "unrelated keys were collateral damage"
    assert published["input"]["size"] == 3
    assert published["tool_call_id"] == "c1", "the envelope was rewritten too"


def test_a_shared_reference_is_not_mistaken_for_a_cycle():
    """A DAG is not a cycle. Flagging one would corrupt a perfectly good event.

    This is why `_sanitize` tracks the ids on the current PATH rather than every
    id it has ever seen: the same dict appearing twice as siblings encodes fine.
    """
    shared = {"shared": True}
    encoded = _encode_entry({"a": shared, "b": shared, "c": [shared, shared]})
    assert encoded is not None
    assert _CYCLE_MARKER not in encoded
    assert json.loads(encoded)["b"] == {"shared": True}


def test_depth_is_bounded_so_the_fallback_cannot_blow_the_stack():
    """The fallback must not fail the way it exists to prevent."""
    deep: dict = {}
    node = deep
    for _ in range(_MAX_SANITIZE_DEPTH + 50):
        node["next"] = {}
        node = node["next"]
    node["bad"] = {(1, 2): "forces the fallback"}

    encoded = _encode_entry(deep)
    assert encoded is not None
    assert _DEPTH_MARKER in encoded


def test_an_event_that_cannot_be_encoded_at_all_is_dropped_alone(spool, caplog):
    """Give up on the one event. Never on the batch."""
    writer = EventWriter(flush_interval=3600)
    writer.submit({"type": "good-before", "n": 1})
    writer.submit({"type": "hopeless", "payload": {_Unstringable(): "x"}})
    writer.submit({"type": "good-after", "n": 2})

    with caplog.at_level(logging.ERROR, logger="failproofai_sdk._writer"):
        writer.flush_now()

    types = [e["type"] for e in read_all(spool)]
    assert types == ["good-before", "good-after"]
    assert any("dropped 1 unserializable" in r.getMessage() for r in caplog.records), caplog.text


def test_a_batch_of_nothing_but_poison_publishes_no_file_and_does_not_raise(spool):
    writer = EventWriter(flush_interval=3600)
    writer.submit({"type": "hopeless", "payload": {_Unstringable(): "x"}})
    writer.flush_now()

    assert list((spool / "events").glob("*")) == [] or read_all(spool) == []
    assert len(writer._queue) == 0


# ─────────────────────────────────────────────────────────────────────────────
# The two failure classes must stay distinguishable
# ─────────────────────────────────────────────────────────────────────────────


def test_a_filesystem_error_still_retries_the_whole_batch(spool, monkeypatch):
    """Encoding failures drop; IO failures retry. Collapsing the two loses data.

    An unencodable event is permanent — retrying produces the identical failure —
    while a full disk or a momentarily read-only mount is not. If the IO path
    started dropping too, a transient error would silently discard live events.
    """
    writer = EventWriter(flush_interval=3600)
    writer.submit({"type": "keep-me", "n": 1})

    import sys

    writer_module = sys.modules["failproofai_sdk._writer"]
    real_replace = writer_module.os.replace
    calls = {"n": 0}

    def flaky(src, dst):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError(28, "No space left on device")
        return real_replace(src, dst)

    monkeypatch.setattr(writer_module.os, "replace", flaky)

    with pytest.raises(OSError):
        writer.flush_now()
    assert len(writer._queue) == 1, "a transient IO error discarded the batch"

    monkeypatch.undo()
    writer.flush_now()
    assert [e["type"] for e in read_all(spool)] == ["keep-me"]


# ─────────────────────────────────────────────────────────────────────────────
# The fast path must not have moved
# ─────────────────────────────────────────────────────────────────────────────


def test_an_ordinary_event_takes_the_strict_path_byte_for_byte():
    """`test_wire_format.py` pins the bytes; this pins that nothing re-encodes them.

    The fallback rebuilds dicts, and a rebuild is exactly the kind of change that
    reorders keys. Key order is load-bearing here — ingest's dedup key hashes the
    canonical payload, so a reordered event stops retried batches collapsing and
    surfaces as duplicate rows rather than as an error.
    """
    entry = {
        "timestamp": "2026-01-02T03:04:05.678901Z",
        "session_id": "sess-1",
        "agent_id": "agent-1",
        "type": "tool_use",
        "tool_name": "bash",
        "tool_call_id": "tc-1",
        "environment": "prod",
        "input": {"command": "ls"},
    }
    assert _encode_entry(entry) == json.dumps(entry, default=str)


def test_default_str_still_rescues_the_values_it_always_did():
    """The fallback is an addition, not a replacement."""
    from datetime import datetime, timezone
    from decimal import Decimal
    from uuid import UUID

    encoded = _encode_entry(
        {
            "type": "tool_result",
            "when": datetime(2026, 1, 2, tzinfo=timezone.utc),
            "id": UUID("00000000-0000-0000-0000-00000000beef"),
            "cost": Decimal("0.25"),
        }
    )
    decoded = json.loads(encoded)
    assert decoded["cost"] == "0.25"
    assert decoded["id"].endswith("beef")
    assert _CYCLE_MARKER not in encoded, "an ordinary event took the fallback path"


def test_sanitize_leaves_an_already_clean_payload_alone():
    payload = {"a": 1, "b": [1, 2, {"c": "d"}], "e": None, "f": True}
    assert _sanitize(payload, frozenset()) == payload
