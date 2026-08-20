"""What the ingest server promotes, and what this SDK must therefore emit.

The server pulls a fixed set of keys out of each event's payload and stores them
as real indexed columns; everything else stays in the opaque `payload` blob.
Those promoted columns are what every filter, facet and chart in the product
reads. The extraction is total in the worst way:

    fn ps(payload, key) -> Option<&str> { payload.get(key).and_then(|v| v.as_str()) }

A missing key and a key holding the wrong JSON type are indistinguishable — both
yield `None`, both store NULL, and the row still ingests with `200 OK`. So an
event that spells `tool_name` as `toolName`, or sends it as a number, lands in
storage looking successful and is invisible to every tool-name filter forever.

This file pins the SDK's half. `PROMOTED` is frozen here because this repository
cannot see the server, and `test_promoted_columns_match_the_server` re-derives
the same list from a real AgentEye checkout when `FP_AGENTEYE_ROOT` points at
one, so the frozen copy cannot quietly rot.
"""
import json
import os
import re
from pathlib import Path

import pytest

from failproofai_sdk import _context, _events, _resolver, _schema
from failproofai_sdk._events import EventNamespace

# ─────────────────────────────────────────────────────────────────────────────
# The promoted-column contract
# ─────────────────────────────────────────────────────────────────────────────

#: Payload keys the server lifts into an indexed column via `ps()` (string).
PROMOTED_STRING = frozenset(
    {
        "tool_name",
        "tool_call_id",
        "hook_name",
        "hook_id",
        "input_id",
        "pause_id",
        "error_type",
        "model",
    }
)

#: Payload keys the server lifts via `pu32()` (unsigned, 32-bit).
PROMOTED_NUMERIC = frozenset({"duration_ms", "input_tokens", "output_tokens"})

PROMOTED = PROMOTED_STRING | PROMOTED_NUMERIC


class _Recorder:
    """Stands in for the writer so a call can be inspected without touching disk."""

    def __init__(self):
        self.entries = []

    def submit(self, entry):
        self.entries.append(entry)


def _emit_everything():
    """Call every public event method once, fully populated. Returns the payloads."""
    recorder = _Recorder()
    ns = EventNamespace(recorder)

    ids = dict(session_id="s", agent_id="a")
    ns.agent_start(**ids, goal="g", parent_id="p")
    ns.agent_end(**ids, outcome="success", summary="s")
    ns.agent_pause(**ids, pause_id="p1", reason="r", user_id="u")
    ns.agent_resume(**ids, pause_id="p1", reason="r", user_id="u")
    ns.tool_use(**ids, tool_name="bash", tool_call_id="tc", input={"cmd": "ls"})
    ns.tool_result(**ids, tool_name="bash", tool_call_id="tc", output="o")
    ns.model_request(**ids, model="m", messages=[], system=None, tools=[])
    ns.model_response(**ids, model="m", stop_reason="end_turn", input_tokens=1, output_tokens=2, content="c", role="assistant")
    ns.error(**ids, error_type="ValueError", message="m", traceback="t")
    ns.hook_triggered(**ids, hook_name="h", hook_id="h1", trigger_event="PreToolUse", input={})
    ns.hook_completed(**ids, hook_name="h", hook_id="h1", outcome="allow", output="o")
    ns.human_wait(**ids, input_id="i1", prompt="p", options=["y"], reason="r")
    ns.human_input(**ids, input_id="i1", response="y")
    ns.human_pause(**ids, reason="r", user_id="u")
    ns.human_interrupt(**ids, reason="r", user_id="u", at_step="1")
    return recorder.entries


def test_every_promoted_column_is_emitted_by_at_least_one_event():
    """A promoted column nothing ever populates is a dead column, silently."""
    emitted = set()
    for payload in _emit_everything():
        emitted |= payload.keys()

    missing = PROMOTED - emitted
    assert not missing, (
        f"no event emits {sorted(missing)}, so those indexed columns are "
        "always NULL. Either an event method stopped sending the key, or the "
        "server promotes something this SDK never produces."
    )


def test_promoted_values_have_the_json_type_the_extractor_accepts():
    """`ps()` needs a JSON string; `pu32()` needs a non-negative integer.

    A type mismatch is NOT an error on either side — it is a NULL column next to
    a payload that still visibly contains the value, which is the single most
    confusing shape this pipeline can produce.
    """
    for payload in _emit_everything():
        for key in PROMOTED_STRING & payload.keys():
            assert isinstance(payload[key], str), (
                f"{payload['type']}.{key} is {type(payload[key]).__name__}; "
                "ps() only reads JSON strings and would store NULL"
            )
        for key in PROMOTED_NUMERIC & payload.keys():
            value = payload[key]
            assert isinstance(value, int) and not isinstance(value, bool), (
                f"{payload['type']}.{key} is {type(value).__name__}; emit a "
                "whole integer so the value survives regardless of how the "
                "server's numeric extractor is implemented"
            )
            assert value >= 0, f"{payload['type']}.{key} is negative; the column is unsigned"
            assert value <= 0xFFFFFFFF, f"{payload['type']}.{key} overflows UInt32"


def test_promoted_keys_never_collide_with_a_reserved_name():
    """Reserved names are validated separately; a promoted key must not be one."""
    assert not (PROMOTED & _events._RESERVED)


@pytest.mark.parametrize("event_type", ["tool_result", "hook_completed", "human_input", "agent_resume"])
def test_unpaired_events_omit_duration_rather_than_sending_zero(event_type):
    """No start seen means unknown, and unknown must not be recorded as `0ms`.

    Zero is a real, plottable duration. Emitting it for "we never saw the start"
    poisons every latency percentile with values that were never measured.
    """
    recorder = _Recorder()
    ns = EventNamespace(recorder)
    ids = dict(session_id="s", agent_id="a")

    if event_type == "tool_result":
        ns.tool_result(**ids, tool_name="t", tool_call_id="never-started")
    elif event_type == "hook_completed":
        ns.hook_completed(**ids, hook_name="h", hook_id="never-started")
    elif event_type == "human_input":
        ns.human_input(**ids, input_id="never-started")
    else:
        ns.agent_resume(**ids, pause_id="never-started")

    assert "duration_ms" not in recorder.entries[0]


# ─────────────────────────────────────────────────────────────────────────────
# Reserved names — enforcement is SPLIT across two mechanisms, deliberately
# ─────────────────────────────────────────────────────────────────────────────


def test_reserved_set_is_exactly_the_five_ingest_reads_structurally():
    assert _events._RESERVED == {"timestamp", "session_id", "agent_id", "type", "environment"}


@pytest.mark.parametrize("name", ["session_id", "agent_id"])
def test_identity_kwargs_raise_type_error_not_value_error(name):
    """These are explicit parameters, so Python rejects the duplicate first.

    Two exception types for one apparent rule. Documented rather than unified,
    because unifying it means shadowing a real signature parameter to raise a
    nicer error, and that trades a loud failure for a subtler one.
    """
    ns = EventNamespace(_Recorder())
    kwargs = {"session_id": "s", "agent_id": "a"}
    kwargs[name] = "duplicate"
    with pytest.raises(TypeError):
        ns.agent_start(**kwargs, **{name: "again"})


@pytest.mark.parametrize("name", ["timestamp", "type", "environment"])
def test_stamped_fields_raise_value_error_from_the_validator(name):
    """These are not signature parameters, so they reach `_validate_fields`."""
    ns = EventNamespace(_Recorder())
    with pytest.raises(ValueError, match="Reserved field names"):
        ns.agent_start(session_id="s", agent_id="a", **{name: "x"})


@pytest.mark.parametrize(
    "call",
    [
        lambda ns: ns.tool_result(session_id="s", agent_id="a", tool_name="t", tool_call_id="c", duration_ms=5),
        lambda ns: ns.hook_completed(session_id="s", agent_id="a", hook_name="h", hook_id="i", duration_ms=5),
        lambda ns: ns.human_input(session_id="s", agent_id="a", input_id="i", duration_ms=5),
        lambda ns: ns.agent_resume(session_id="s", agent_id="a", pause_id="p", duration_ms=5),
    ],
)
def test_duration_ms_cannot_be_supplied_by_the_caller(call):
    """It is measured, not reported — a caller-supplied value would be unfalsifiable."""
    ns = EventNamespace(_Recorder())
    with pytest.raises(ValueError, match="auto-computed"):
        call(ns)


def test_a_reserved_name_is_rejected_by_every_event_method():
    """One method forgetting `_validate_fields` would let a caller rewrite `type`."""
    ns = EventNamespace(_Recorder())
    methods = [m for m in dir(ns) if not m.startswith("_") and callable(getattr(ns, m))]
    assert len(methods) == 15, f"expected 15 event methods, found {len(methods)}: {sorted(methods)}"

    required = {
        "tool_use": dict(tool_name="t", tool_call_id="c"),
        "tool_result": dict(tool_name="t", tool_call_id="c"),
        "hook_triggered": dict(hook_name="h", hook_id="i"),
        "hook_completed": dict(hook_name="h", hook_id="i"),
        "error": dict(error_type="E", message="m"),
        "human_wait": dict(input_id="i"),
        "human_input": dict(input_id="i"),
        "agent_pause": dict(pause_id="p"),
        "agent_resume": dict(pause_id="p"),
    }
    for method in methods:
        with pytest.raises(ValueError, match="Reserved field names"):
            getattr(ns, method)(
                session_id="s", agent_id="a", **required.get(method, {}), type="hijacked"
            )


# ─────────────────────────────────────────────────────────────────────────────
# The strings the rename must never touch
# ─────────────────────────────────────────────────────────────────────────────

#: Renaming any of these desynchronises the SDK from the daemon that reads its
#: spool, with no error on either side — events are simply written somewhere
#: nothing watches. The Python import name and the PyPI distribution name were
#: renamed to failproofai_sdk / failproofai-sdk; the wire and filesystem
#: contract deliberately was not, exactly as the `fp` CLI kept `X-AgentEye-Org`
#: and the `ae_session` cookie through its own rename.
FROZEN_STRINGS = {
    "AGENTEYE_HOME": (
        "the operator override both daemons honour, and the documented escape "
        "hatch for a host still running agenteye-collector"
    ),
    "AGENTEYE_ENVIRONMENT": "the environment label, read at import time",
    "FAILPROOFAI_HOME": "moves the umbrella root, mirrored in fp-home.ts",
    "custom-agents": "the DEFAULT spool root, mirrored in fp-home.ts and config.rs",
}

#: Deliberately NOT frozen, and each for its own reason.
#:
#: ``AGENTEYE_SPOOL_TO_FAILPROOFAI`` was the opt-in that selected the umbrella
#: root. It also required that directory to already exist, and nothing ever
#: created it, so the branch never once fired. It is retired rather than frozen:
#: the umbrella is the default now, so anyone who exported it already has what
#: they were asking for.
#:
#: ``.agenteye`` is no longer a literal this package must contain. It survives
#: in prose and in `legacy_agenteye_dir()`, but freezing it would make this test
#: pass on a comment — which is exactly how it passed while the variable above
#: was being deleted.
RETIRED_STRINGS = ("AGENTEYE_SPOOL_TO_FAILPROOFAI",)

PACKAGE_DIR = Path(_resolver.__file__).resolve().parent


def test_the_spool_contract_strings_are_still_spelled_the_old_way():
    """A well-meaning rename sweep is the realistic threat here, not a redesign."""
    source = "\n".join(
        p.read_text(encoding="utf-8") for p in sorted(PACKAGE_DIR.glob("*.py"))
    )
    for literal, why in FROZEN_STRINGS.items():
        assert literal in source, (
            f"{literal!r} is gone from the package — {why}. This is a wire and "
            "filesystem contract with a daemon that is released separately, so "
            "renaming it here strands every event this SDK writes. If the "
            "rename is genuinely intended, change the daemon FIRST and keep "
            "reading the old name for at least one release."
        )


def test_the_retired_opt_in_is_not_read_by_any_module():
    """Freed, not merely unused — a leftover branch would contradict the docs.

    Checked over `os.environ` lookups rather than the raw text, because the name
    still appears in `_resolver`'s prose explaining why it went away, and a
    substring check over source is how the frozen-strings test above was passing
    for the wrong reason while the variable was being deleted.
    """
    import re

    for path in sorted(PACKAGE_DIR.glob("*.py")):
        source = path.read_text(encoding="utf-8")
        for retired in RETIRED_STRINGS:
            reads = re.findall(rf"environ(?:\.get)?[\(\[]\s*[\"']{retired}", source)
            assert not reads, f"{path.name} still reads the retired {retired}"


def test_the_spool_layout_is_events_and_failed_under_the_base_dir():
    """The daemon watches `<base>/events` and quarantines to `<base>/failed`."""
    writer_source = (PACKAGE_DIR / "_writer.py").read_text(encoding="utf-8")
    assert '"events"' in writer_source


def test_batches_are_published_by_atomic_rename_from_a_tmp_suffix():
    """`.tmp` -> `.jsonl` via os.replace is what stops a half-written read.

    The daemon takes any `.jsonl` in the directory as complete. Writing straight
    to the final name would hand it a truncated file whose unparseable lines
    ingest counts as `skipped` — 200 OK, events gone.
    """
    writer_source = (PACKAGE_DIR / "_writer.py").read_text(encoding="utf-8")
    assert '.tmp' in writer_source
    assert '.jsonl' in writer_source
    assert "os.replace(tmp_path, final_path)" in writer_source, (
        "the atomic publish is gone. shutil.move, Path.rename across devices, or "
        "a plain write to the final name all reintroduce the torn-read window."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Cross-check against a real AgentEye checkout, when one is available
# ─────────────────────────────────────────────────────────────────────────────

_AGENTEYE_ROOT = os.environ.get("FP_AGENTEYE_ROOT")
_INGEST_RS = Path(_AGENTEYE_ROOT) / "server" / "src" / "routes" / "ingest.rs" if _AGENTEYE_ROOT else None

requires_agenteye_checkout = pytest.mark.skipif(
    _INGEST_RS is None or not _INGEST_RS.is_file(),
    reason="set FP_AGENTEYE_ROOT to an AgentEye checkout to verify against real ingest.rs",
)


@requires_agenteye_checkout
def test_promoted_columns_match_the_server():
    """Re-derive PROMOTED from ingest.rs so the frozen copy above cannot rot."""
    source = _INGEST_RS.read_text(encoding="utf-8")

    actual_strings = set(re.findall(r'ps\(payload_value,\s*"([a-z_]+)"\)', source))
    actual_numeric = set(re.findall(r'pu32\(payload_value,\s*"([a-z_]+)"\)', source))

    # `model_name` is a documented fallback spelling the server also accepts;
    # this SDK only ever emits `model`, which is the preferred one.
    actual_strings.discard("model_name")

    assert actual_strings == PROMOTED_STRING, (
        "the server's promoted string columns drifted from this SDK's frozen "
        f"copy. server={sorted(actual_strings)} sdk={sorted(PROMOTED_STRING)}"
    )
    assert PROMOTED_NUMERIC >= actual_numeric, (
        "the server promotes a numeric column this SDK does not know about: "
        f"{sorted(actual_numeric - PROMOTED_NUMERIC)}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Promoted numeric columns — the type has to be right, not just the key
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", sorted(_events._PROMOTED_NUMERIC))
@pytest.mark.parametrize("bad", ["many", 12.5, True, -1, 2**32, [1], {"n": 1}])
def test_a_promoted_numeric_is_refused_rather_than_stored_as_null(name, bad):
    """`pu32()` returns None on a mismatch, and None is written as NULL at 200 OK.

    Nothing is logged and nothing is rejected — the row still arrives — so the
    only symptom is a column that is populated for some events and not others.
    `_RESERVED` never covered this: it blocks five structural keys and lets every
    other custom field through untouched, whatever type it carries.

    Rejecting rather than coercing, because a float is a mistake worth hearing
    about: the server drops it whole rather than rounding it, and rounding it
    here would hide that from the one person able to fix the source.
    """
    ns = EventNamespace(_Recorder())
    with pytest.raises(ValueError, match=name):
        ns.agent_start(session_id="s", agent_id="a", **{name: bad})


@pytest.mark.parametrize("name", ["input_tokens", "output_tokens"])
def test_model_response_checks_its_own_two_token_counts(name):
    """They are named parameters, so they never reach `_validate_fields`.

    They are also the likeliest of the three to arrive wrong — a caller reading
    them straight off a provider's usage object gets whatever that object holds.
    """
    ns = EventNamespace(_Recorder())
    with pytest.raises(ValueError, match=name):
        ns.model_response(session_id="s", agent_id="a", model="m", **{name: "1024"})


@pytest.mark.parametrize("name", sorted(_events._PROMOTED_NUMERIC))
def test_a_valid_promoted_numeric_still_goes_through_untouched(name):
    recorder = _Recorder()
    EventNamespace(recorder).agent_start(session_id="s", agent_id="a", **{name: 4096})
    assert recorder.entries[0][name] == 4096


@pytest.mark.parametrize("name", sorted(_events._PROMOTED_NUMERIC))
def test_the_boundary_values_of_a_u32_are_accepted(name):
    """0 and 2**32 - 1 are valid, and an off-by-one here silently rejects real data."""
    recorder = _Recorder()
    ns = EventNamespace(recorder)
    ns.agent_start(session_id="s", agent_id="a", **{name: 0})
    ns.agent_start(session_id="s", agent_id="a", **{name: 2**32 - 1})
    assert [e[name] for e in recorder.entries] == [0, 2**32 - 1]


def test_none_is_not_treated_as_a_bad_promoted_numeric():
    """`model_response` passes its optionals straight through as None."""
    recorder = _Recorder()
    EventNamespace(recorder).model_response(
        session_id="s", agent_id="a", model="m", input_tokens=None, output_tokens=None
    )
    assert "input_tokens" not in recorder.entries[0]


def test_the_promoted_numeric_set_matches_the_one_ingest_lifts():
    """Two hand-maintained lists, one in the SDK and one in this file's header.

    If they drift, the validator stops covering a column that ingest still
    promotes, and this file's own assertions stop describing the server.
    """
    assert _events._PROMOTED_NUMERIC == PROMOTED_NUMERIC


# ─────────────────────────────────────────────────────────────────────────────
# The MEASURED duration is bound by the same u32 range a caller is held to
# ─────────────────────────────────────────────────────────────────────────────

#: The four events that pair with an earlier one and compute `duration_ms`.
#: Each takes a start call and an end call against the same id.
PAIRED = {
    "tool_result": (
        lambda ns: ns.tool_use(session_id="s", agent_id="a", tool_name="t", tool_call_id="x"),
        lambda ns: ns.tool_result(session_id="s", agent_id="a", tool_name="t", tool_call_id="x"),
    ),
    "hook_completed": (
        lambda ns: ns.hook_triggered(session_id="s", agent_id="a", hook_name="h", hook_id="x"),
        lambda ns: ns.hook_completed(session_id="s", agent_id="a", hook_name="h", hook_id="x"),
    ),
    "human_input": (
        lambda ns: ns.human_wait(session_id="s", agent_id="a", input_id="x"),
        lambda ns: ns.human_input(session_id="s", agent_id="a", input_id="x"),
    ),
    "agent_resume": (
        lambda ns: ns.agent_pause(session_id="s", agent_id="a", pause_id="x"),
        lambda ns: ns.agent_resume(session_id="s", agent_id="a", pause_id="x"),
    ),
}


def _emit_pair_with_gap(event_type, gap_seconds, monkeypatch):
    """Run one start/end pair with a controlled interval between them."""
    import datetime as _dt

    start_call, end_call = PAIRED[event_type]
    recorder = _Recorder()
    ns = EventNamespace(recorder)

    base = _dt.datetime(2026, 1, 1, tzinfo=_dt.timezone.utc)
    clock = {"now": base}
    monkeypatch.setattr(EventNamespace, "_now", staticmethod(lambda: clock["now"]))

    start_call(ns)
    clock["now"] = base + _dt.timedelta(seconds=gap_seconds)
    recorder.entries.clear()
    end_call(ns)
    return recorder.entries[0]


@pytest.mark.parametrize("event_type", sorted(PAIRED))
def test_a_pair_spanning_more_than_u32_milliseconds_omits_the_duration(event_type, monkeypatch):
    """~49.7 days is an ordinary lifetime for these pairs, not an abuse.

    A `human_wait` answered after a long weekend, an `agent_pause` resumed a
    month later. Over the range, `pu32()` stores NULL at 200 OK — so an
    unbounded value is not an error anywhere, just an empty column.
    """
    over = (2**32 / 1000) + 60  # comfortably past 2**32 ms
    payload = _emit_pair_with_gap(event_type, over, monkeypatch)
    assert "duration_ms" not in payload, (
        f"{event_type} emitted {payload.get('duration_ms')}, which the server stores as NULL"
    )


@pytest.mark.parametrize("event_type", sorted(PAIRED))
def test_a_backwards_clock_omits_the_duration_rather_than_going_negative(event_type, monkeypatch):
    """`datetime.now()` is wall-clock, so an NTP step back yields a negative gap.

    `round()` keeps the sign, and a negative into an unsigned column is the same
    silent NULL as an oversized one.
    """
    payload = _emit_pair_with_gap(event_type, -5, monkeypatch)
    assert "duration_ms" not in payload, f"{event_type} emitted a negative duration"


@pytest.mark.parametrize("event_type", sorted(PAIRED))
def test_an_ordinary_gap_still_produces_a_duration(event_type, monkeypatch):
    """The bound must not swallow the normal case it exists to protect."""
    payload = _emit_pair_with_gap(event_type, 1.5, monkeypatch)
    assert payload["duration_ms"] == 1500
    assert isinstance(payload["duration_ms"], int)


@pytest.mark.parametrize("event_type", sorted(PAIRED))
def test_the_upper_boundary_itself_is_kept(event_type, monkeypatch):
    """Exactly 2**32 - 1 ms is representable; an off-by-one here drops real data."""
    payload = _emit_pair_with_gap(event_type, (2**32 - 1) / 1000, monkeypatch)
    assert payload["duration_ms"] == 2**32 - 1


def test_the_measured_and_the_caller_supplied_paths_enforce_the_same_range():
    """One range, two entry points. They drifted once already.

    `_validate_promoted_numeric` refused a caller anything outside 0..2**32-1
    while the SDK's own computation was unbounded — the same field, held to two
    different standards depending on who produced it.
    """
    import datetime as _dt

    base = _dt.datetime(2026, 1, 1, tzinfo=_dt.timezone.utc)
    over = base + _dt.timedelta(milliseconds=2**32)
    assert _events._measured_duration_ms(base, over) is None
    with pytest.raises(ValueError):
        _events._validate_promoted_numeric("duration_ms", 2**32)

    ok = base + _dt.timedelta(milliseconds=2**32 - 1)
    assert _events._measured_duration_ms(base, ok) == 2**32 - 1
    _events._validate_promoted_numeric("duration_ms", 2**32 - 1)


# ─────────────────────────────────────────────────────────────────────────────
# session_id / agent_id — on every event, and skipped silently when wrong
# ─────────────────────────────────────────────────────────────────────────────

#: Every public event method, with the arguments it needs besides the two ids.
ALL_METHODS = [
    ("agent_start", {}), ("agent_end", {}),
    ("agent_pause", {"pause_id": "p"}), ("agent_resume", {"pause_id": "p"}),
    ("tool_use", {"tool_name": "t", "tool_call_id": "c"}),
    ("tool_result", {"tool_name": "t", "tool_call_id": "c"}),
    ("model_request", {}), ("model_response", {}),
    ("hook_triggered", {"hook_name": "h", "hook_id": "i"}),
    ("hook_completed", {"hook_name": "h", "hook_id": "i"}),
    ("error", {"error_type": "E", "message": "m"}),
    ("human_wait", {"input_id": "i"}), ("human_input", {"input_id": "i"}),
    ("human_pause", {}), ("human_interrupt", {}),
]


def test_the_method_list_here_covers_every_public_event():
    """Or a method added later silently skips the check below."""
    public = {
        n for n in dir(EventNamespace)
        if not n.startswith("_") and callable(getattr(EventNamespace, n))
    }
    assert {m for m, _ in ALL_METHODS} == public


@pytest.mark.parametrize("method,extra", ALL_METHODS, ids=[m for m, _ in ALL_METHODS])
@pytest.mark.parametrize("bad", [None, 123, {"x": 1}, ["a"], b"bytes"], ids=lambda v: type(v).__name__)
def test_a_non_string_session_id_is_refused_on_every_event(method, extra, bad):
    """Ingest SKIPS these and answers 200 — `{"accepted":0,"skipped":1}`.

    Verified against the live server. Nothing upstream learns: the SDK reports
    success, the collector deletes the batch, and the event is gone. `None` is
    the realistic way in — an uninitialised variable, a lookup that missed.
    """
    ns = EventNamespace(_Recorder())
    with pytest.raises(TypeError, match="session_id"):
        getattr(ns, method)(session_id=bad, agent_id="a", **extra)


@pytest.mark.parametrize("method,extra", ALL_METHODS, ids=[m for m, _ in ALL_METHODS])
def test_a_non_string_agent_id_is_refused_on_every_event(method, extra):
    """`None` is no longer invalid — it means "resolve from scope" (below).

    `TypeError`, because the wrong TYPE was supplied — and because omitting a
    required keyword argument was always a TypeError, so code catching one keeps
    working now that identity is optional.
    """
    ns = EventNamespace(_Recorder())
    with pytest.raises(TypeError, match="agent_id"):
        getattr(ns, method)(session_id="s", agent_id=12345, **extra)


@pytest.mark.parametrize("method,extra", ALL_METHODS, ids=[m for m, _ in ALL_METHODS])
def test_an_omitted_agent_id_resolves_rather_than_raising(method, extra):
    """Omitting it is the ergonomic path the scopes exist for, not an error.

    With no `agent()` scope open it lands on `DEFAULT_AGENT_ID` — the convention
    the skill already teaches — rather than raising. Inventing a *session* that
    way would scatter one run across as many sessions as it has emit sites, so
    only the agent has a default.
    """
    recorder = _Recorder()
    getattr(EventNamespace(recorder), method)(session_id="s", **extra)
    assert recorder.entries[0]["agent_id"] == _context.DEFAULT_AGENT_ID


def test_an_unresolvable_session_id_raises_rather_than_emitting():
    """Nothing passed and nothing bound must be loud.

    Ingest skips an event whose `session_id` is not a JSON string and answers
    `200 OK` with `{"accepted":0,"skipped":1}`, so emitting here would lose the
    event with no error on either side — the exact failure the validation exists
    to prevent, reached through the new ergonomic path instead of a bad argument.
    """
    ns = EventNamespace(_Recorder())
    with pytest.raises(TypeError, match="session_id is required"):
        ns.agent_start()


def test_an_ambient_scope_satisfies_both_ids():
    import failproofai_sdk

    recorder = _Recorder()
    ns = EventNamespace(recorder)
    with failproofai_sdk.session("sess-x"):
        with failproofai_sdk.agent("planner"):
            ns.agent_start(goal="from ambient scope")
    entry = recorder.entries[-1]
    assert entry["session_id"] == "sess-x"
    assert entry["agent_id"] == "planner"


@pytest.mark.parametrize("blank", ["", "   ", "\t\n"], ids=["empty", "spaces", "whitespace"])
def test_a_blank_identity_is_refused_although_the_server_accepts_it(blank):
    """The worse of the two outcomes, which is why it is refused too.

    A skipped event is at least absent. A blank id is ACCEPTED by the server, so
    every event sent that way lands and is silently grouped under one id — the
    data looks present and is quietly merged across unrelated runs.
    """
    ns = EventNamespace(_Recorder())
    with pytest.raises(ValueError, match="empty"):
        ns.agent_start(session_id=blank, agent_id="a")
    with pytest.raises(ValueError, match="empty"):
        ns.agent_start(session_id="s", agent_id=blank)


def test_ordinary_identities_are_untouched():
    recorder = _Recorder()
    EventNamespace(recorder).agent_start(session_id="run-001", agent_id="planner")
    assert recorder.entries[0]["session_id"] == "run-001"
    assert recorder.entries[0]["agent_id"] == "planner"
