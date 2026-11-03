"""A 404 in key mode has two very different causes; the CLI must tell them apart.

Pointing `--base-url` at a dashboard whose front door does not forward `/v1` is
the likeliest first-run mistake. It used to arrive as a 3xx to `/login`, which
`_raise_for_status` names explicitly — but a dashboard that correctly declines to
auth-gate `/v1` (see `dashboard/proxy.ts`) returns its own 404 instead, and on
the status code alone that is indistinguishable from "no such record".

The tell is the content type: the API only ever answers JSON.
"""

import httpx
import pytest
import respx

from fp_cli import client as api
from fp_cli.client import AuthMode, ClientContext
from fp_cli.errors import ApiError, NotFoundError

BASE = "http://server.test"


def key_ctx() -> ClientContext:
    return ClientContext(base_url=BASE, api_key="ak_test", auth_mode=AuthMode.API_KEY)


@respx.mock
def test_html_404_names_the_routing_problem() -> None:
    respx.get(f"{BASE}/v1/events").mock(
        return_value=httpx.Response(
            404,
            text="<!DOCTYPE html><html>404</html>",
            headers={"content-type": "text/html; charset=utf-8"},
        )
    )
    with pytest.raises(ApiError) as excinfo:
        api.list_events(key_ctx())
    assert "not routed" in str(excinfo.value)
    # Must NOT degrade to the ordinary not-found error, which would send the
    # reader hunting for a missing record instead of a misconfigured base URL.
    assert not isinstance(excinfo.value, NotFoundError)


@respx.mock
def test_json_404_is_still_an_ordinary_not_found() -> None:
    """The other half.

    Without this, the guard above could 'pass' by relabelling every 404 as a
    routing problem — worse than the bug it fixes, because then a genuinely
    missing record would send people to check their base URL forever.
    """
    respx.get(f"{BASE}/v1/events").mock(
        return_value=httpx.Response(404, json={"error": "nope"})
    )
    with pytest.raises(NotFoundError):
        api.list_events(key_ctx())


@respx.mock
def test_session_mode_html_404_is_untouched() -> None:
    """Cookie mode keeps its existing behaviour — this diagnostic is key-mode only."""
    respx.get(f"{BASE}/api/events").mock(
        return_value=httpx.Response(
            404,
            text="<!DOCTYPE html><html>404</html>",
            headers={"content-type": "text/html; charset=utf-8"},
        )
    )
    with pytest.raises(NotFoundError):
        api.list_events(ClientContext(base_url=BASE, token="tok"))
