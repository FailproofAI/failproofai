from __future__ import annotations

import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError

import pytest

from failproofai_sdk.evaluator import (
    Assignment,
    ClaimRequest,
    EvaluatorAPIError,
    EvaluatorClient,
    ResultRequest,
)

FIXTURE = Path(__file__).parent / "fixtures" / "evaluator_v2" / "contract.json"


def _samples():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))["samples"]


class Response:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self, amount):
        return self.body[:amount]


class RawResponse(Response):
    def __init__(self, body: bytes):
        self.body = body


def test_claim_sends_bearer_auth_and_does_not_retry():
    calls = []

    def opener(request, timeout):
        calls.append((request, timeout))
        raise URLError("offline")

    client = EvaluatorClient(
        base_url="https://cloud.example/api/",
        credential="secret",
        opener=opener,
        sleeper=lambda _: None,
    )
    with pytest.raises(EvaluatorAPIError, match="transport_error"):
        client.claim(ClaimRequest("worker", "sha256:x", 1, 20))

    assert len(calls) == 1
    request, timeout = calls[0]
    assert request.full_url == "https://cloud.example/v1/evaluator/assignments/claim"
    assert request.get_header("Authorization") == "Bearer secret"
    assert timeout == 30


def test_idempotent_result_submission_retries_transport_failure():
    samples = _samples()
    calls = 0

    def opener(request, timeout):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise URLError("reset")
        return Response(samples["result_response"])

    client = EvaluatorClient(
        base_url="https://cloud.example/",
        credential="secret",
        opener=opener,
        sleeper=lambda _: None,
    )
    response = client.submit_result(
        samples["result_response"]["evaluation_run_id"],
        ResultRequest.from_wire(samples["result_request"]),
    )
    assert response.status == "committed"
    assert calls == 2


def test_transcript_url_cannot_exfiltrate_the_worker_credential():
    sample = _samples()["claim_response"]["assignments"][0]
    assignment = Assignment.from_wire(
        {**sample, "transcript_url": "https://evil.test/read"}
    )
    client = EvaluatorClient(
        base_url="https://cloud.example/",
        credential="secret",
        opener=lambda *_args, **_kwargs: pytest.fail("network must not be reached"),
    )
    with pytest.raises(EvaluatorAPIError, match="outside the configured API origin"):
        client.transcript(assignment, worker_id="worker")


def test_machine_error_envelope_controls_retryability():
    body = json.dumps(_samples()["error_response"]).encode()

    def opener(request, timeout):
        raise HTTPError(request.full_url, 409, "Conflict", {}, io.BytesIO(body))

    client = EvaluatorClient(
        base_url="https://cloud.example/", credential="secret", opener=opener
    )
    with pytest.raises(EvaluatorAPIError) as caught:
        client.claim(ClaimRequest("worker", "sha256:x", 1, 20))
    assert caught.value.code == "lease_lost"
    assert caught.value.status == 409
    assert caught.value.retryable is False
    assert caught.value.request_id == "req-018f47a8"


@pytest.mark.parametrize(
    ("body", "code"),
    [
        (b"not-json", "invalid_response"),
        (b"[]", "invalid_response"),
        (
            b"{" + b'"padding":"' + b"x" * (2 * 1024 * 1024) + b'"}',
            "response_too_large",
        ),
    ],
)
def test_malformed_or_oversized_server_responses_fail_closed(body, code):
    client = EvaluatorClient(
        base_url="https://cloud.example/",
        credential="secret",
        opener=lambda request, timeout: RawResponse(body),
    )
    with pytest.raises(EvaluatorAPIError) as caught:
        client.claim(ClaimRequest("worker", "sha256:x", 1, 20))
    assert caught.value.code == code
    assert caught.value.retryable is False


def test_transcript_identity_is_sent_as_fencing_headers():
    samples = _samples()
    assignment = Assignment.from_wire(samples["claim_response"]["assignments"][0])
    captured = None

    def opener(request, timeout):
        nonlocal captured
        captured = request
        return Response(samples["transcript_response"])

    client = EvaluatorClient(
        base_url="https://cloud.example/", credential="secret", opener=opener
    )
    client.transcript(assignment, worker_id="worker-7")
    assert captured.get_header("X-failproofai-worker-id") == "worker-7"
    assert captured.get_header("X-failproofai-lease-generation") == "3"


def test_constructor_rejects_unsafe_or_incomplete_configuration():
    with pytest.raises(ValueError, match="absolute"):
        EvaluatorClient(base_url="localhost:8080", credential="secret")
    with pytest.raises(ValueError, match="credential"):
        EvaluatorClient(base_url="https://cloud.example", credential="")
    with pytest.raises(ValueError, match="control characters"):
        EvaluatorClient(base_url="https://cloud.example", credential="secret\nleak")


def test_protocol_redirect_does_not_forward_the_bearer_credential():
    exfiltration_attempts = []

    class Sink(BaseHTTPRequestHandler):
        def do_POST(self):
            exfiltration_attempts.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.end_headers()

        def log_message(self, format, *args):
            return

    sink = ThreadingHTTPServer(("127.0.0.1", 0), Sink)
    sink_thread = threading.Thread(target=sink.serve_forever, daemon=True)
    sink_thread.start()

    location = f"http://127.0.0.1:{sink.server_address[1]}/steal"

    class Redirector(BaseHTTPRequestHandler):
        def do_POST(self):
            self.send_response(307)
            self.send_header("Location", location)
            self.end_headers()

        def log_message(self, format, *args):
            return

    redirector = ThreadingHTTPServer(("127.0.0.1", 0), Redirector)
    redirector_thread = threading.Thread(target=redirector.serve_forever, daemon=True)
    redirector_thread.start()
    try:
        client = EvaluatorClient(
            base_url=f"http://127.0.0.1:{redirector.server_address[1]}",
            credential="must-not-leak",
            max_retries=0,
        )
        with pytest.raises(EvaluatorAPIError) as caught:
            client.claim(ClaimRequest("worker", "sha256:x", 1, 0))
        assert caught.value.status == 307
        assert exfiltration_attempts == []
    finally:
        redirector.shutdown()
        redirector.server_close()
        redirector_thread.join(timeout=5)
        sink.shutdown()
        sink.server_close()
        sink_thread.join(timeout=5)
