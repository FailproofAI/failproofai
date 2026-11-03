"""Every CLI request carries its own id, and every failure names it.

A customer pastes `ref 4bf92f35`; support finds every server log line of that
request with one query. That only works if (a) each HTTP request has a distinct
id, (b) every typed error — not just ApiError — carries it, and (c) the id is
still there when something in front of the API answered without echoing one.
"""

from __future__ import annotations

import json
import re

import httpx
import pytest
import respx

from fp_cli import client as api
from fp_cli.app import app
from fp_cli.client import ClientContext
from fp_cli.errors import ApiError, AuthError, ForbiddenError, NetworkError, NotFoundError

BASE = "http://dash.test"
TRACE_ID = re.compile(r"^[0-9a-f]{32}$")
SERVER_ID = "4bf92f3577b34da6a3ce929d0e0e4736"


def ctx() -> ClientContext:
    return ClientContext(base_url=BASE, token="tok")


@respx.mock
def test_each_request_gets_its_own_trace_id():
    route = respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(200, json={"sessions": [], "next_cursor": None})
    )
    api.list_sessions(ctx())
    api.list_sessions(ctx())
    ids = [call.request.headers["x-request-id"] for call in route.calls]
    assert len(ids) == 2
    assert all(TRACE_ID.match(i) for i in ids), ids
    assert ids[0] != ids[1]


@pytest.mark.parametrize(
    ("status", "error_type"),
    [(401, AuthError), (403, ForbiddenError), (404, NotFoundError), (500, ApiError)],
)
@respx.mock
def test_every_typed_error_carries_the_servers_request_id(status, error_type):
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(status, json={"error": "x"}, headers={"x-request-id": SERVER_ID})
    )
    with pytest.raises(error_type) as excinfo:
        api.list_sessions(ctx())
    assert excinfo.value.request_id == SERVER_ID
    assert excinfo.value.ref == SERVER_ID[:8]


@respx.mock
def test_without_an_echo_the_error_names_the_id_we_sent():
    # A proxy or front door answered: no x-request-id on the response. The id we
    # sent is still the one in the dashboard's access logs.
    route = respx.get(f"{BASE}/api/sessions").mock(return_value=httpx.Response(502, text="bad gateway"))
    with pytest.raises(ApiError) as excinfo:
        api.list_sessions(ctx())
    sent = route.calls.last.request.headers["x-request-id"]
    assert excinfo.value.request_id == sent


@respx.mock
def test_an_unsane_echo_is_not_put_on_the_error():
    route = respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(500, json={"error": "x"}, headers={"x-request-id": "a b c"})
    )
    with pytest.raises(ApiError) as excinfo:
        api.list_sessions(ctx())
    assert excinfo.value.request_id == route.calls.last.request.headers["x-request-id"]


@respx.mock
def test_a_network_error_names_the_id_it_sent():
    route = respx.get(f"{BASE}/api/sessions").mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(NetworkError) as excinfo:
        api.list_sessions(ctx())
    assert excinfo.value.request_id == route.calls.last.request.headers["x-request-id"]
    # Exit code contract unchanged.
    assert excinfo.value.exit_code == 3


@respx.mock
def test_the_human_error_line_shows_the_ref(logged_in, runner):
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(403, json={"error": "forbidden"}, headers={"x-request-id": SERVER_ID})
    )
    result = runner.invoke(app, ["sessions"])
    assert result.exit_code == 5
    assert f"ref {SERVER_ID[:8]}" in result.stderr


@respx.mock
def test_the_json_envelope_carries_the_full_id_for_non_api_errors(logged_in, runner):
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(403, json={"error": "forbidden"}, headers={"x-request-id": SERVER_ID})
    )
    result = runner.invoke(app, ["--json", "sessions"])
    assert result.exit_code == 5
    data = json.loads(result.stdout)
    assert data["request_id"] == SERVER_ID
    # The ref is for humans; the envelope's message stays clean.
    assert "ref " not in data["error"]
