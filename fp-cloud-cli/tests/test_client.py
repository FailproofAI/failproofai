from __future__ import annotations

import httpx
import pytest
import respx

from fp_cli import client as api
from fp_cli.client import AuthMode, ClientContext
from fp_cli.errors import (
    ApiError,
    AuthError,
    ForbiddenError,
    NetworkError,
    NotFoundError,
)
from fp_cli.models import Page

BASE = "http://dash.test"


def ctx() -> ClientContext:
    return ClientContext(base_url=BASE, token="tok")


def key_ctx() -> ClientContext:
    return ClientContext(base_url=BASE, api_key="ak_test", auth_mode=AuthMode.API_KEY)


@respx.mock
def test_list_events_maps_params_and_parses():
    route = respx.get(f"{BASE}/api/events").mock(
        return_value=httpx.Response(
            200,
            json={
                "events": [
                    {
                        "id": 2,
                        "session_id": "s",
                        "agent_id": "a",
                        "event_type": "tool_use",
                        "ts": "2026-05-25T00:00:00Z",
                        "payload": {"k": 1},
                        "environment": "prod",
                    }
                ],
                "next_cursor": 1,
            },
        )
    )
    page = api.list_events(
        ctx(),
        session_id="s",
        event_type=["a", "b"],
        environment=["prod", "dev"],
        limit=10,
    )
    assert isinstance(page, Page)
    assert page.next_cursor == 1
    assert page.items[0].event_type == "tool_use"
    assert page.items[0].payload == {"k": 1}

    request = route.calls.last.request
    assert request.url.params["session_id"] == "s"
    assert request.url.params["event_type"] == "a,b"
    assert request.url.params["environment"] == "prod,dev"
    assert request.url.params["limit"] == "10"
    # cookie auth + request id propagation
    assert "ae_session=tok" in request.headers.get("cookie", "")
    assert request.headers.get("x-request-id")


@respx.mock
def test_list_event_summaries_hits_light_feed_and_parses_summary():
    # The light feed: same params/cursor as list_events, but payload-free rows carrying the
    # server-computed summary/is_error + promoted columns.
    route = respx.get(f"{BASE}/api/events/summary").mock(
        return_value=httpx.Response(
            200,
            json={
                "events": [
                    {
                        "id": 7,
                        "session_id": "s",
                        "agent_id": "a",
                        "event_type": "error",
                        "ts": "2026-05-25T00:00:00Z",
                        "environment": "prod",
                        "summary": "TimeoutError: upstream timed out",
                        "is_error": True,
                        "error_type": "TimeoutError",
                        "output_tokens": None,
                        "context_window": 200000,
                        "context_fill": 12.5,
                    }
                ],
                "next_cursor": "2026-05-25 00:00:00.000000|7",
            },
        )
    )
    page = api.list_event_summaries(
        ctx(),
        errored=True,
        error_type="TimeoutError",
        environment=["prod", "dev"],
        limit=10,
    )
    assert isinstance(page, Page)
    assert page.next_cursor == "2026-05-25 00:00:00.000000|7"  # interchangeable string cursor
    e = page.items[0]
    assert e.event_type == "error"
    assert e.summary == "TimeoutError: upstream timed out"  # server field, no payload parsing
    assert e.is_error is True and e.error_type == "TimeoutError"
    assert e.context_window == 200000 and e.context_fill == 12.5
    assert e.payload == {}  # the fat column is never fetched on this feed

    params = route.calls.last.request.url.params
    assert params["errored"] == "true"
    assert params["error_type"] == "TimeoutError"
    assert params["environment"] == "prod,dev"


@respx.mock
def test_list_evaluations_score_filters_and_latest():
    route = respx.get(f"{BASE}/api/evaluations").mock(
        return_value=httpx.Response(200, json={"evaluations": [], "next_cursor": None})
    )
    api.list_evaluations(
        ctx(),
        score_filters="helpfulness:0.5..0.8",
        latest_per_session=True,
        status="done",
    )
    params = route.calls.last.request.url.params
    assert params["score_filters"] == "helpfulness:0.5..0.8"
    assert params["latest_per_session"] == "true"
    assert params["status"] == "done"


@respx.mock
def test_401_maps_to_auth_error():
    respx.get(f"{BASE}/api/auth/session").mock(return_value=httpx.Response(401, json={}))
    with pytest.raises(AuthError):
        api.get_session_user(ctx())


@respx.mock
def test_403_maps_to_forbidden():
    respx.get(f"{BASE}/api/events").mock(
        return_value=httpx.Response(403, json={"error": "forbidden"})
    )
    with pytest.raises(ForbiddenError):
        api.list_events(ctx())


@respx.mock
def test_404_maps_to_not_found():
    respx.get(f"{BASE}/api/events").mock(
        return_value=httpx.Response(404, json={"error": "nope"})
    )
    with pytest.raises(NotFoundError):
        api.list_events(ctx())


@respx.mock
def test_500_carries_status_and_request_id():
    respx.get(f"{BASE}/api/events").mock(
        return_value=httpx.Response(500, json={"error": "boom"}, headers={"x-request-id": "rid-1"})
    )
    with pytest.raises(ApiError) as excinfo:
        api.list_events(ctx())
    assert excinfo.value.status == 500
    assert excinfo.value.request_id == "rid-1"


@respx.mock
def test_network_error():
    respx.get(f"{BASE}/api/events").mock(side_effect=httpx.ConnectError("down"))
    with pytest.raises(NetworkError):
        api.list_events(ctx())


# --- API-key mode: the same statuses, but the message has to name the key ----


@respx.mock
def test_key_mode_401_blames_the_key_not_a_session():
    respx.get(f"{BASE}/v1/events").mock(return_value=httpx.Response(401, json={}))
    with pytest.raises(AuthError) as excinfo:
        api.list_events(key_ctx())
    message = str(excinfo.value)
    assert "API key" in message
    # "Run fp login" is exactly the wrong advice for a CI job holding a key.
    assert "login" not in message


@respx.mock
def test_key_mode_403_names_the_permission_and_the_org_ambiguity():
    respx.get(f"{BASE}/v1/events").mock(
        return_value=httpx.Response(
            403, json={"error": "forbidden", "required_permission": "events:read"}
        )
    )
    with pytest.raises(ForbiddenError) as excinfo:
        api.list_events(key_ctx())
    message = str(excinfo.value)
    assert "events:read" in message
    # The server answers 403 for "wrong org" too — deliberately, so a key holder
    # cannot enumerate orgs — so the CLI must not present one cause as the answer.
    assert "org" in message


@respx.mock
def test_key_mode_403_with_an_empty_body_still_explains_both_causes():
    # No JSON at all: `_extract_error` and `_required_permission` both come back
    # empty, which is the shape a proxy or a non-permission 403 produces.
    respx.get(f"{BASE}/v1/events").mock(return_value=httpx.Response(403, text=""))
    with pytest.raises(ForbiddenError) as excinfo:
        api.list_events(key_ctx())
    message = str(excinfo.value)
    assert "API key" in message and "org" in message


@respx.mock
def test_session_mode_403_wording_is_unchanged():
    respx.get(f"{BASE}/api/events").mock(
        return_value=httpx.Response(403, json={"required_permission": "events:read"})
    )
    with pytest.raises(ForbiddenError) as excinfo:
        api.list_events(ctx())
    assert str(excinfo.value) == "you don't have the events:read permission"


@respx.mock
def test_key_mode_redirect_to_login_names_the_real_problem():
    # httpx does not follow redirects, so without the explicit 3xx check this returns
    # an empty body and surfaces as "the dashboard returned a malformed response" —
    # which sends people looking for a server bug instead of a routing one.
    respx.get(f"{BASE}/v1/events").mock(
        return_value=httpx.Response(307, headers={"location": "/login?next=%2Fv1%2Fevents"})
    )
    with pytest.raises(ApiError) as excinfo:
        api.list_events(key_ctx())
    assert "/v1 is not routed" in str(excinfo.value)
    assert "localhost:8080" in (excinfo.value.hint or "")


@respx.mock
def test_key_mode_ordinary_2xx_is_untouched_by_the_redirect_check():
    respx.get(f"{BASE}/v1/keys").mock(return_value=httpx.Response(200, json=[]))
    assert api.list_keys(key_ctx()) == []


def test_paginate_walks_until_null_cursor():
    pages = [Page(items=[1, 2], next_cursor=10), Page(items=[3], next_cursor=None)]
    seen_cursors = []

    def fetch(cursor, limit):
        seen_cursors.append(cursor)
        return pages.pop(0)

    assert list(api.paginate(fetch)) == [1, 2, 3]
    assert seen_cursors == [None, 10]


def test_paginate_respects_limit():
    def fetch(cursor, limit):
        start = cursor if cursor is not None else 1000
        return Page(items=list(range(limit)), next_cursor=start - 1)

    out = list(api.paginate(fetch, limit=3))
    assert len(out) == 3


def test_paginate_stops_on_nondecreasing_cursor():
    def fetch(cursor, limit):
        return Page(items=[1], next_cursor=5)  # cursor never decreases

    out = list(api.paginate(fetch, limit=100))
    # page 1 (cursor=None) and page 2 (cursor=5) each yield one item; the
    # non-decreasing cursor (5 >= 5) then halts the loop instead of spinning.
    assert out == [1, 1]


def test_paginate_non_positive_limit_yields_nothing():
    def fetch(cursor, limit):  # pragma: no cover - must not be called
        raise AssertionError("fetch_page should not be called for limit <= 0")

    assert list(api.paginate(fetch, limit=0)) == []


def test_paginate_honors_start_cursor():
    seen = []

    def fetch(cursor, limit):
        seen.append(cursor)
        return Page(items=[1], next_cursor=None)

    list(api.paginate(fetch, start_cursor=42))
    assert seen == [42]
