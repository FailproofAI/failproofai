"""When `--all` stops early, the response must say so.

The defect these pin was measured against a live instance, on the CLI this one
was moved from:

    fp --json sessions --since 7d --limit 200        -> 200 rows, next_cursor set
    fp --json sessions --since 7d --all              ->  50 rows   (25x undercount)
    fp --json sessions --since 7d --all --limit 5000 -> 1,274 rows

`--all` inherits `--limit`'s default of 50 — which is documented and deliberate
here — but the envelope then hard-coded `next_cursor: null`, so a 4% sample of a
customer's fleet came back with exit 0, no warning, and a response that read as
complete. Nothing in the output could tell you otherwise.

The fix (`Walk`, carried through `client.paginate`) is present in this repo and
was untested when these were written. That combination is the one worth
guarding: a silent-completeness bug cannot be caught by reading the code, only
by asserting on what the envelope claims.

So every test here checks the REPORTED completeness, not just the row count.

The fake feed is a real cursor server — it honours `limit` and `cursor` — not a
list of canned pages. A fixture that ignored `limit` would pass no matter how
few rows the CLI asked for, which is to say it could not fail on the bug.
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from fp_cli import client
from fp_cli.app import app

from .conftest import BASE_URL as BASE


def _feed(key: str, total: int, row):
    """respx side_effect: a cursor-paginated feed holding ``total`` rows.

    The cursor is the offset of the next row (opaque to the CLI, which only
    round-trips it). ``limit`` is honoured exactly, so the CLI's own page sizing
    decides how much of the feed it can actually reach.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        params = request.url.params
        limit = int(params["limit"])
        offset = int(params.get("cursor") or 0)
        rows = [row(i) for i in range(offset, min(offset + limit, total))]
        nxt = offset + len(rows)
        return httpx.Response(
            200, json={key: rows, "next_cursor": str(nxt) if nxt < total else None}
        )

    return handler


def _event_row(i: int) -> dict:
    return {
        "id": i, "session_id": "s", "agent_id": "a", "event_type": "tool_use",
        "ts": "2026-08-24T12:00:00Z", "environment": "prod", "summary": f"row {i}",
    }


def _session_row(i: int) -> dict:
    return {
        "session_id": f"sess-{i}", "agent_id": "a", "environment": "prod",
        "last_event_at": "2026-08-24T12:00:00Z", "latest_evaluation": None,
    }


def _eval_row(i: int) -> dict:
    return {
        "id": f"eval-{i}", "session_id": "s", "agent_id": "a", "environment": "prod",
        "status": "done", "scores": {"helpfulness": 0.9}, "created_at": "2026-08-24T12:00:00Z",
    }


# (command, endpoint, server key, envelope key, row builder). Every command that
# takes `--all`; the bug was reported on `sessions` but lived in the shared
# walker, so all four had it. `errors` is the one where the two keys differ: it
# reads the shared errored-events feed (`{"events": …}`) and re-labels it
# `errors` on the way out.
FEEDS = [
    ("events", "/api/events/summary", "events", "events", _event_row),
    ("sessions", "/api/sessions", "sessions", "sessions", _session_row),
    ("evals", "/api/evaluations", "evaluations", "evaluations", _eval_row),
    ("errors", "/api/events/summary", "events", "errors", _event_row),
]
IDS = [f[0] for f in FEEDS]

TOTAL = 274  # > the 50 default, and not a multiple of the 200 page size


@pytest.mark.parametrize("command,endpoint,server_key,key,row", FEEDS, ids=IDS)
@respx.mock
def test_all_stopped_by_the_default_limit_is_reported_not_silent(
    logged_in, runner, command, endpoint, server_key, key, row
):
    """THE REGRESSION. `--all` stopping at 50 is the documented behaviour; saying
    the feed was exhausted is the bug."""
    respx.get(f"{BASE}{endpoint}").mock(side_effect=_feed(server_key, TOTAL, row))
    res = runner.invoke(app, ["--base-url", BASE, "--json", command, "--all"])
    assert res.exit_code == 0, res.output
    out = json.loads(res.stdout)
    assert len(out[key]) == 50, "the documented default bound still applies"
    assert out["next_cursor"] is not None, (
        "a walk that stopped on --limit must hand back a resumable cursor; "
        "null here is the 4%-sample-reported-as-complete bug"
    )


@pytest.mark.parametrize("command,endpoint,server_key,key,row", FEEDS, ids=IDS)
@respx.mock
def test_all_that_exhausts_the_feed_reports_complete(
    logged_in, runner, command, endpoint, server_key, key, row
):
    """The other direction, and the reason `truncated` cannot just be "we hit the
    limit": a walk that took every row must NOT claim there is more."""
    respx.get(f"{BASE}{endpoint}").mock(side_effect=_feed(server_key, 30, row))
    res = runner.invoke(app, ["--base-url", BASE, "--json", command, "--all", "--limit", "500"])
    assert res.exit_code == 0, res.output
    out = json.loads(res.stdout)
    assert len(out[key]) == 30
    assert out["next_cursor"] is None, "an exhausted feed must not look truncated"


@respx.mock
def test_an_explicit_limit_is_honoured_and_reported(logged_in, runner):
    """`--all --limit N` is how you actually get more than the default, so the
    bound has to hold exactly and still report the remainder."""
    respx.get(f"{BASE}/api/sessions").mock(side_effect=_feed("sessions", TOTAL, _session_row))
    res = runner.invoke(
        app, ["--base-url", BASE, "--json", "sessions", "--all", "--limit", "220"]
    )
    assert res.exit_code == 0, res.output
    out = json.loads(res.stdout)
    assert len(out["sessions"]) == 220
    assert out["next_cursor"] is not None


@respx.mock
def test_all_pages_in_chunks_rather_than_one_giant_request(logged_in, runner):
    """The walk must actually WALK. Asking for 220 in a single request would work
    against this fake and fail against a server that caps a page at 200."""
    route = respx.get(f"{BASE}/api/sessions").mock(
        side_effect=_feed("sessions", TOTAL, _session_row)
    )
    res = runner.invoke(
        app, ["--base-url", BASE, "--json", "sessions", "--all", "--limit", "220"]
    )
    assert res.exit_code == 0, res.output
    assert route.call_count > 1, "a 220-row walk must span more than one request"
    for call in route.calls:
        assert int(call.request.url.params["limit"]) <= 200


# --- the walker itself, below the CLI ---------------------------------------


def _pages(total: int, page: int):
    """A `fetch_page` over ``total`` rows, honouring the limit it is given."""

    def fetch(cursor=None, limit=None):
        offset = int(cursor or 0)
        size = min(limit or page, page)
        items = list(range(offset, min(offset + size, total)))
        nxt = offset + len(items)
        return client.Page(items=items, next_cursor=str(nxt) if nxt < total else None)

    return fetch


def test_walk_records_the_cursor_it_stopped_on():
    walk = client.Walk()
    items = list(client.paginate(_pages(500, 200), limit=250, walk=walk))
    assert len(items) == 250
    assert walk.truncated is True
    assert walk.next_cursor is not None, "a bounded walk must be resumable"


def test_walk_that_exhausts_the_feed_is_not_flagged_truncated():
    walk = client.Walk()
    items = list(client.paginate(_pages(120, 200), limit=500, walk=walk))
    assert len(items) == 120
    assert walk.truncated is False
    assert walk.next_cursor is None


def test_truncated_is_not_derivable_from_the_row_count():
    """The subtle case, and why `Walk` exists at all: a walk whose limit lands
    EXACTLY on the last row is complete, and one that lands exactly on a page
    boundary with more behind it is not. Row count cannot tell those apart."""
    exact = client.Walk()
    list(client.paginate(_pages(200, 200), limit=200, walk=exact))
    assert exact.truncated is False, "taking every row is not a truncation"

    boundary = client.Walk()
    list(client.paginate(_pages(400, 200), limit=200, walk=boundary))
    assert boundary.truncated is True, "stopping on a boundary with more behind it is"
