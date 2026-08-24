"""The SDK creates its spool path and NOTHING else, at every level.

This SDK installs into other people's agent processes and now writes inside
`~/.failproofai`, a directory the CLI and the daemon own. So the rule is not
merely "make the directory work" — it is that a machine which has only ever run
this SDK must be indistinguishable, to every other component, from a machine
that has run nothing at all.

`detectLayout()` in `src/hooks/fp-config.ts` is the reason that matters. It
decides whether a home is `absent`, `current`, `stale` or `future`, and a
`stale` verdict authorises `resetHome()`, which deletes files. Its landmarks are
`VERSION`, `config.json`, `config.toml`, and layout 1's seven markers. Creating
any of those from here would hand the CLI a half-built home it believes it wrote
— so the only safe thing to create is the spool path itself.

The three cases below are the three states a machine can be in, and each asserts
the EXACT set of paths that appear. An assertion on "the events dir exists" would
pass just as happily if a `VERSION` file appeared beside it.
"""
import json
import os
import stat
import time

import pytest

from failproofai_sdk import _resolver, _runtime
from failproofai_sdk._events import EventNamespace
from failproofai_sdk._writer import EventWriter

#: The interval `_runtime.writer` runs on outside this suite — what a regression
#: would have to wait out. Read off the constructor default rather than restated.
_DEFAULT_FLUSH_INTERVAL = EventWriter.__init__.__defaults__[0]


@pytest.fixture
def home(tmp_path, monkeypatch):
    """An isolated HOME with no failproofai directory at all."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path / ".failproofai"))
    monkeypatch.delenv("AGENTEYE_HOME", raising=False)
    _resolver.set_base_dir(None)
    yield tmp_path
    _resolver.set_base_dir(None)


def tree(root):
    """Every path under `root`, relative and sorted. The whole filesystem effect."""
    if not root.exists():
        return []
    return sorted(str(p.relative_to(root)) for p in root.rglob("*"))


def emit_one(goal="e"):
    writer = EventWriter(flush_interval=3600)
    EventNamespace(writer).agent_start(session_id="s", agent_id="a", goal=goal)
    writer.flush_now()
    return writer


#: What a single published batch must add, and the complete list of it.
def spool_paths(batch_names):
    return sorted(["custom-agents", "custom-agents/events", *[f"custom-agents/events/{n}" for n in batch_names]])


# ─────────────────────────────────────────────────────────────────────────────
# Case 1 — the umbrella spool already exists: add a batch, create nothing else
# ─────────────────────────────────────────────────────────────────────────────


def test_when_the_spool_exists_only_a_batch_file_appears(home):
    fp = home / ".failproofai"
    (fp / "custom-agents" / "events").mkdir(parents=True)
    before = tree(fp)

    emit_one()

    after = tree(fp)
    added = [p for p in after if p not in before]
    assert len(added) == 1, f"expected one new batch file, got {added}"
    assert added[0].startswith("custom-agents/events/event-")
    assert added[0].endswith(".jsonl")


def test_an_existing_failproofai_home_is_not_otherwise_disturbed(home):
    """A configured machine must come through completely untouched.

    Not just "the files are still there" — unchanged. A rewritten `config.json`
    with identical content would still be a component writing into a file it
    does not own.
    """
    fp = home / ".failproofai"
    (fp / "custom-agents" / "events").mkdir(parents=True)
    (fp / "VERSION").write_text('{"layout":4,"cli":"1.0.1"}')
    (fp / "config.json").write_text('{"mode":{"kind":"oss"}}')
    (fp / "credentials.json").write_text('{"token":"secret"}')
    (fp / "policies").mkdir()
    (fp / "policies" / "mine.mjs").write_text("// mine")
    (fp / "hook-activity").mkdir()

    owned = {
        p: (p.read_bytes(), p.stat().st_mtime_ns)
        for p in (fp / "VERSION", fp / "config.json", fp / "credentials.json", fp / "policies" / "mine.mjs")
    }

    emit_one()

    for path, (content, mtime) in owned.items():
        assert path.read_bytes() == content, f"{path.name} was rewritten"
        assert path.stat().st_mtime_ns == mtime, f"{path.name} was touched"
    assert (fp / "hook-activity").is_dir()
    assert sorted(p.name for p in fp.iterdir()) == [
        "VERSION", "config.json", "credentials.json", "custom-agents", "hook-activity", "policies",
    ]


# ─────────────────────────────────────────────────────────────────────────────
# Case 2 — the home exists, the spool does not: create only the spool
# ─────────────────────────────────────────────────────────────────────────────


def test_when_the_home_exists_only_the_spool_path_is_created(home):
    fp = home / ".failproofai"
    fp.mkdir()
    (fp / "VERSION").write_text('{"layout":4,"cli":"1.0.1"}')
    before = tree(fp)

    emit_one()

    added = [p for p in tree(fp) if p not in before]
    batch = [p for p in added if p.endswith(".jsonl")]
    assert len(batch) == 1
    assert sorted(added) == spool_paths([batch[0].rsplit("/", 1)[-1]]), (
        f"created something beyond the spool path: {added}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Case 3 — nothing exists: create the home and the spool, and stop there
# ─────────────────────────────────────────────────────────────────────────────


def test_when_nothing_exists_only_the_home_and_the_spool_are_created(home):
    fp = home / ".failproofai"
    assert not fp.exists()

    emit_one()

    assert fp.is_dir()
    created = tree(fp)
    batch = [p for p in created if p.endswith(".jsonl")]
    assert len(batch) == 1
    assert created == spool_paths([batch[0].rsplit("/", 1)[-1]]), (
        f"a fresh home got more than the spool: {created}"
    )


@pytest.mark.parametrize(
    "landmark",
    ["VERSION", "config.json", "config.toml", "policies-config.json", "last-version", "cloud.json"],
)
def test_no_layout_landmark_is_ever_created(home, landmark):
    """Each of these tells `detectLayout()` a different story, none of them true.

    `VERSION`/`config.json` would report a home this SDK never built as
    `current`; `config.toml` and layout 1's markers report it `stale`, which is
    what authorises `resetHome()` to start deleting. The SDK has no business
    voting on any of it.
    """
    emit_one()
    assert not (home / ".failproofai" / landmark).exists()


def test_a_home_built_only_by_the_sdk_looks_unconfigured(home):
    """The cross-component property, asserted from this side.

    Verified against the real `detectLayout()` too: a home holding only
    `custom-agents/` returns `{kind: "absent"}` and `isConfigured()` is false.
    Pinned here so a change on THIS side that starts writing a landmark fails in
    the SDK's own suite rather than in the CLI's, months later.
    """
    emit_one()
    fp = home / ".failproofai"
    assert sorted(p.name for p in fp.iterdir()) == ["custom-agents"]


# ─────────────────────────────────────────────────────────────────────────────
# Repeat writes, permissions, and the failure paths
# ─────────────────────────────────────────────────────────────────────────────


def test_repeated_flushes_do_not_recreate_or_churn_the_directories(home):
    writer = EventWriter(flush_interval=3600)
    ns = EventNamespace(writer)
    ns.agent_start(session_id="s", agent_id="a", goal="one")
    writer.flush_now()

    events = home / ".failproofai" / "custom-agents" / "events"
    inode = events.stat().st_ino

    for i in range(5):
        ns.agent_start(session_id="s", agent_id="a", goal=f"more-{i}")
        writer.flush_now()

    assert events.stat().st_ino == inode, "the events directory was replaced"
    assert len(list(events.glob("*.jsonl"))) == 6
    assert list(events.glob("*.tmp")) == [], "a temp file was left behind"


def test_the_process_wide_writer_cannot_flush_into_the_running_test(home):
    """The count above is only meaningful if nothing else writes here.

    `_runtime.writer` starts at import on a 0.5s interval, and the spool path is
    resolved when a batch is WRITTEN, not when the event is submitted. So an
    event queued while one test's `FAILPROOFAI_HOME` was current gets written
    into whichever test is running half a second later, with no error on either
    side — the test above then counts seven batch files where it wrote six. It
    reached CI exactly once, on one interpreter out of five.

    `conftest._quiesce_the_process_wide_writer` closes it. This asserts the
    EFFECT rather than the interval, so it still fails if the loop acquires
    another way to wake — and it waits well past the 0.5s default, so a
    regression cannot pass by being fast.
    """
    events = home / ".failproofai" / "custom-agents" / "events"

    _runtime.writer.submit(
        {"type": "agent_start", "session_id": "leak", "agent_id": "a", "goal": "must not land here"}
    )
    try:
        time.sleep(_DEFAULT_FLUSH_INTERVAL * 3)
        assert not events.exists() or list(events.glob("*.jsonl")) == [], (
            "the process-wide writer flushed into a test's spool"
        )
    finally:
        # Drop it rather than flush it: flushing would write the event into this
        # test's directory, which is the thing being ruled out.
        _runtime.writer._queue.clear()
        _runtime.writer._queued_bytes = 0


def test_created_directories_are_owner_writable_and_not_world_writable(home):
    emit_one()
    for d in (
        home / ".failproofai",
        home / ".failproofai" / "custom-agents",
        home / ".failproofai" / "custom-agents" / "events",
    ):
        mode = stat.S_IMODE(d.stat().st_mode)
        assert mode & stat.S_IRWXU == stat.S_IRWXU, f"{d} is not owner-rwx"
        assert not mode & stat.S_IWOTH, f"{d} is world-writable"


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_an_unwritable_home_raises_and_keeps_the_events_queued(home):
    """A permission error must not be mistaken for a delivered batch.

    `_flush` returns the drained entries to the queue and re-raises, so the next
    interval retries them. Dropping here would lose live events to a condition
    that is usually temporary — a home mounted read-only, a directory an
    installer briefly re-owned.
    """
    fp = home / ".failproofai"
    fp.mkdir(mode=0o500)
    try:
        writer = EventWriter(flush_interval=3600)
        EventNamespace(writer).agent_start(session_id="s", agent_id="a", goal="held")
        with pytest.raises(OSError):
            writer.flush_now()
        assert len(writer._queue) == 1, "events were dropped on a permission error"
    finally:
        fp.chmod(0o700)


def test_agenteye_home_no_longer_bypasses_the_umbrella(home, monkeypatch):
    """Emitting with it exported must build the umbrella and NOT the legacy tree.

    The observable half of the resolver change: not just "resolution returns a
    different path", but "the batch is on disk under ~/.failproofai and nothing
    was created under ~/.agenteye".
    """
    legacy = home / ".agenteye"
    monkeypatch.setenv("AGENTEYE_HOME", str(legacy))
    _resolver.set_base_dir(None)

    emit_one()

    assert not legacy.exists(), "the legacy root was created despite the change"
    umbrella = home / ".failproofai" / "custom-agents"
    assert umbrella.exists(), "the umbrella was not created"
    assert list((umbrella / "events").glob("*.jsonl")), "no batch landed in the umbrella"


def test_the_batch_written_is_readable_and_carries_the_event(home):
    """Creating directories is worthless if the payload does not survive it."""
    emit_one(goal="round-trip")
    events = home / ".failproofai" / "custom-agents" / "events"
    (batch,) = list(events.glob("*.jsonl"))
    rows = [json.loads(line) for line in batch.read_text(encoding="utf-8").splitlines()]
    assert [r["goal"] for r in rows] == ["round-trip"]
    assert rows[0]["type"] == "agent_start"


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores file permissions")
def test_batches_and_the_events_dir_are_not_readable_by_other_local_users(home):
    """These files are transcripts, not metadata.

    A batch carries `goal`, prompt text, tool arguments and tool output straight
    from the host agent. Under the ordinary `umask 022` they landed `0644` inside
    `0755` directories, so on any shared host — a build box, a bastion, a
    container with several service accounts — every other local user could read
    every agent transcript this SDK spools, for the whole flush+upload window and
    indefinitely if no daemon is running.

    The sibling `fp-cloud-cli` already writes its credential `0600` inside a `0700`
    directory, so the asymmetry was an oversight rather than a house style. The
    daemon reads these as the SAME user (its unit is `User=<user>` with `HOME`
    set to that user's home), so tightening them costs no delivery.
    """
    prev = os.umask(0o022)
    try:
        emit_one(goal="SECRET-GOAL-TEXT")
    finally:
        os.umask(prev)

    events = home / ".failproofai" / "custom-agents" / "events"
    assert stat.S_IMODE(events.stat().st_mode) == 0o700, "events dir is enterable by others"

    batches = list(events.glob("*.jsonl"))
    assert batches, "nothing was published"
    for batch in batches:
        mode = stat.S_IMODE(batch.stat().st_mode)
        assert mode == 0o600, f"{batch.name} is {oct(mode)}, not 0600"


def test_a_tilde_base_dir_is_expanded_rather_than_taken_literally(home, monkeypatch, tmp_path):
    """`configure(base_dir="~/.agenteye")` is a recipe this package prescribes.

    `_resolver.get_base_dir`'s own docstring lists it as one of three supported
    bridges for a host still running the older `agenteye-collector`, and calls it
    the explicit, visible-at-the-call-site one. `Path("~/.agenteye")` is a
    RELATIVE path whose first segment is the literal character `~`, so without
    `expanduser` the writer's `mkdir(parents=True)` created a `~` directory under
    whatever the process's cwd happened to be and spooled into it. Nothing on the
    machine watches that path: 100% of the telemetry is lost, silently, which is
    the exact "an unread spool is indistinguishable from an idle one" failure the
    prose around that docstring exists to prevent.
    """
    monkeypatch.chdir(tmp_path)
    _resolver.set_base_dir("~/.agenteye")
    try:
        resolved = _resolver.get_base_dir()
        assert resolved.is_absolute(), f"{resolved} is relative"
        assert resolved == home / ".agenteye"

        emit_one()
        assert not (tmp_path / "~").exists(), "spooled into a literal '~' directory"
        assert list((home / ".agenteye" / "events").glob("*.jsonl"))
    finally:
        _resolver.set_base_dir(None)
