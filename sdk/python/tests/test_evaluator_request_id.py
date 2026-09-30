"""Every evaluator API call carries a request id, and every failure names one.

The server logs each worker call under its `x-request-id`. A worker log line
that says `request_id=4bf92f35…` is then one query away from the server's side
of the same failure — but only if the worker sent an id the server keeps (a
32-hex trace id), and only if the error carries the id the server logged.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import re
from email.message import Message
from urllib.error import HTTPError, URLError

import pytest

from failproofai_sdk.evaluator import (
    ClaimRequest,
    EvaluatorAPIError,
    EvaluatorClient,
    current_request_id,
    request_id_scope,
)

TRACE_ID = re.compile(r"^[0-9a-f]{32}$")
SERVER_ID = "4bf92f3577b34da6a3ce929d0e0e4736"


class Response:
    def __init__(self, body, headers=None):
        self.body = json.dumps(body).encode() if not isinstance(body, bytes) else body
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self, amount):
        return self.body[:amount]


def _client(opener):
    return EvaluatorClient(
        base_url="https://cloud.example/",
        credential="secret",
        opener=opener,
        sleeper=lambda _: None,
    )


def _claim(client):
    return client.claim(ClaimRequest("worker", "sha256:x", 1, 20))


def _headers(**values):
    message = Message()
    for key, value in values.items():
        message[key.replace("_", "-")] = value
    return message


def test_every_call_sends_a_fresh_trace_id():
    sent = []

    def opener(request, timeout):
        sent.append(request.get_header("X-request-id"))
        return Response({"assignments": [], "lease_duration_seconds": 30})

    client = _client(opener)
    for _ in range(2):
        try:
            _claim(client)
        except Exception:  # noqa: BLE001 - the response shape is not under test here
            pass
    assert len(sent) == 2
    assert all(TRACE_ID.match(i or "") for i in sent), sent
    assert sent[0] != sent[1]


def test_retries_of_one_call_share_its_id():
    sent = []

    def opener(request, timeout):
        sent.append(request.get_header("X-request-id"))
        raise URLError("reset")

    with pytest.raises(EvaluatorAPIError) as caught:
        # heartbeat retries; claim deliberately does not
        _client(opener)._json("POST", "/v1/evaluator/runs/heartbeat", None, retry=True)
    assert len(sent) == 4
    assert len(set(sent)) == 1
    # A call that never got an answer names the id it sent.
    assert caught.value.request_id == sent[0]


def test_a_caller_scope_id_is_honoured():
    sent = []

    def opener(request, timeout):
        sent.append(request.get_header("X-request-id"))
        raise URLError("offline")

    with request_id_scope(SERVER_ID) as scoped:
        assert scoped == SERVER_ID
        with pytest.raises(EvaluatorAPIError):
            _claim(_client(opener))
    assert sent == [SERVER_ID]
    assert current_request_id.get() is None, "the scope must not leak"


def test_a_scope_reaches_the_thread_the_runtime_calls_the_client_on():
    # The runtime calls the client via asyncio.to_thread, which copies context.
    sent = []

    def opener(request, timeout):
        sent.append(request.get_header("X-request-id"))
        raise URLError("offline")

    async def main():
        with request_id_scope(SERVER_ID):
            with pytest.raises(EvaluatorAPIError):
                await asyncio.to_thread(_claim, _client(opener))

    asyncio.run(main())
    assert sent == [SERVER_ID]


def test_a_scope_with_free_text_is_replaced_not_sent():
    with request_id_scope("evil\nheader") as scoped:
        assert TRACE_ID.match(scoped)


def test_an_http_error_carries_the_servers_echoed_id():
    def opener(request, timeout):
        raise HTTPError(
            request.full_url, 503, "Unavailable", _headers(x_request_id=SERVER_ID), io.BytesIO(b"")
        )

    with pytest.raises(EvaluatorAPIError) as caught:
        _claim(_client(opener))
    assert caught.value.status == 503
    assert caught.value.request_id == SERVER_ID


def test_without_an_echo_the_error_names_the_id_it_sent():
    sent = []

    def opener(request, timeout):
        sent.append(request.get_header("X-request-id"))
        raise HTTPError(request.full_url, 502, "Bad Gateway", _headers(), io.BytesIO(b"<html>"))

    with pytest.raises(EvaluatorAPIError) as caught:
        _claim(_client(opener))
    assert caught.value.request_id == sent[0]


def test_a_malformed_success_body_still_names_an_id():
    def opener(request, timeout):
        return Response(b"<html>", headers=_headers(x_request_id=SERVER_ID))

    with pytest.raises(EvaluatorAPIError) as caught:
        _claim(_client(opener))
    assert caught.value.code == "invalid_response"
    assert caught.value.request_id == SERVER_ID


def test_the_runtimes_claim_failure_line_names_the_request_id(caplog):
    # Drive the real runtime path: a claim the server refuses must leave a warn
    # line whose MESSAGE carries the id (a basicConfig formatter drops extras).
    from tests.test_evaluator_runtime import FakeClient, _runtime

    from failproofai_sdk.evaluator import Evaluator

    class RejectedClaimClient(FakeClient):
        def claim(self, request):
            raise EvaluatorAPIError(
                status=409,
                code="catalog_mismatch",
                message="register again",
                retryable=False,
                request_id=SERVER_ID,
            )

    runtime = _runtime(Evaluator(name="test", version="1"), RejectedClaimClient())
    with caplog.at_level(logging.WARNING, logger="failproofai_sdk.evaluator"):
        with pytest.raises(EvaluatorAPIError):
            asyncio.run(runtime.run_forever())
    lines = [r for r in caplog.records if "claim failed" in r.getMessage()]
    assert lines, [r.getMessage() for r in caplog.records]
    assert SERVER_ID in lines[0].getMessage()
    assert lines[0].request_id == SERVER_ID
