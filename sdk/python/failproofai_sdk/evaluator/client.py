"""Standard-library HTTP client for the Evaluator v2 worker protocol."""

from __future__ import annotations

import json
import random
import time
from collections.abc import Callable, Mapping
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from failproofai_sdk.evaluator.protocol import (
    CLAIM_PATH,
    HEARTBEAT_PATH,
    LEASE_GENERATION_HEADER,
    MAX_TRANSCRIPT_BYTES,
    PLAN_PATH,
    REGISTER_PATH,
    RESULT_PATH,
    WORKER_ID_HEADER,
    Assignment,
    ClaimRequest,
    ClaimResponse,
    ErrorResponse,
    HeartbeatRequest,
    HeartbeatResponse,
    PlanRequest,
    PlanResponse,
    RegisterRequest,
    RegisterResponse,
    ResultRequest,
    ResultResponse,
    SessionTranscript,
    WireModel,
)

_DEFAULT_RESPONSE_LIMIT = 2 * 1024 * 1024
_RETRYABLE_HTTP_STATUSES = frozenset({429, 502, 503, 504})


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def _open_without_redirects(request: Request, *, timeout: float):
    return build_opener(_RejectRedirects()).open(request, timeout=timeout)


class EvaluatorAPIError(RuntimeError):
    def __init__(
        self,
        *,
        status: int | None,
        code: str,
        message: str,
        retryable: bool,
        request_id: str | None = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code
        self.retryable = retryable
        self.request_id = request_id


class EvaluatorClient:
    """Direct server client; evaluator traffic never passes through the dashboard."""

    def __init__(
        self,
        *,
        base_url: str,
        credential: str,
        timeout_seconds: float = 30,
        max_retries: int = 3,
        opener: Callable[..., Any] | None = None,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        parsed = urlsplit(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("base_url must be an absolute http(s) URL")
        if not credential or not credential.strip():
            raise ValueError("credential must not be empty")
        if any(
            ord(character) < 32 or ord(character) == 127 for character in credential
        ):
            raise ValueError("credential must not contain control characters")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be greater than zero")
        if max_retries < 0:
            raise ValueError("max_retries must not be negative")
        self._base_url = base_url.rstrip("/") + "/"
        self._origin = (parsed.scheme, parsed.netloc)
        self._credential = credential
        self._timeout_seconds = timeout_seconds
        self._max_retries = max_retries
        self._opener = opener or _open_without_redirects
        self._sleeper = sleeper

    def register(self, request: RegisterRequest) -> RegisterResponse:
        return RegisterResponse.from_wire(
            self._json("POST", REGISTER_PATH, request, retry=True)
        )

    def claim(self, request: ClaimRequest) -> ClaimResponse:
        # A lost claim response may already have leased work. Do not hide a
        # second claim behind transport retry; the runtime recalculates capacity.
        return ClaimResponse.from_wire(
            self._json("POST", CLAIM_PATH, request, retry=False)
        )

    def transcript(
        self, assignment: Assignment, *, worker_id: str
    ) -> SessionTranscript:
        headers = {
            WORKER_ID_HEADER: worker_id,
            LEASE_GENERATION_HEADER: str(assignment.lease_generation),
        }
        return SessionTranscript.from_wire(
            self._json(
                "GET",
                assignment.transcript_url,
                None,
                retry=True,
                headers=headers,
                response_limit=MAX_TRANSCRIPT_BYTES,
            )
        )

    def plan(self, assignment_id: str, request: PlanRequest) -> PlanResponse:
        return PlanResponse.from_wire(
            self._json(
                "POST",
                PLAN_PATH.format(assignment_id=assignment_id),
                request,
                retry=True,
            )
        )

    def heartbeat(self, request: HeartbeatRequest) -> HeartbeatResponse:
        return HeartbeatResponse.from_wire(
            self._json("POST", HEARTBEAT_PATH, request, retry=True)
        )

    def submit_result(self, run_id: str, request: ResultRequest) -> ResultResponse:
        return ResultResponse.from_wire(
            self._json(
                "POST",
                RESULT_PATH.format(evaluation_run_id=run_id),
                request,
                retry=True,
            )
        )

    def _url(self, path: str) -> str:
        url = urljoin(self._base_url, path)
        parsed = urlsplit(url)
        if (parsed.scheme, parsed.netloc) != self._origin:
            raise EvaluatorAPIError(
                status=None,
                code="invalid_transcript_url",
                message="server supplied a URL outside the configured API origin",
                retryable=False,
            )
        return url

    def _json(
        self,
        method: str,
        path: str,
        body: WireModel | None,
        *,
        retry: bool,
        headers: Mapping[str, str] | None = None,
        response_limit: int = _DEFAULT_RESPONSE_LIMIT,
    ) -> dict[str, Any]:
        encoded = None
        request_headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._credential}",
            "User-Agent": "failproofai-sdk-evaluator/2",
        }
        if body is not None:
            encoded = json.dumps(
                body.to_wire(),
                allow_nan=False,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        if headers:
            request_headers.update(headers)

        attempts = self._max_retries + 1 if retry else 1
        for attempt in range(attempts):
            request = Request(
                self._url(path), data=encoded, headers=request_headers, method=method
            )
            try:
                with self._opener(request, timeout=self._timeout_seconds) as response:
                    return self._decode(
                        response.read(response_limit + 1), response_limit
                    )
            except HTTPError as error:
                api_error = self._http_error(error, response_limit)
                if attempt + 1 == attempts or not api_error.retryable:
                    raise api_error from error
            except (URLError, TimeoutError, OSError) as error:
                if attempt + 1 == attempts:
                    raise EvaluatorAPIError(
                        status=None,
                        code="transport_error",
                        message=str(error),
                        retryable=True,
                    ) from error
            # Jitter is scheduling noise, not a security decision.
            self._sleeper(random.uniform(0, min(0.25 * (2**attempt), 2.0)))  # nosec B311
        raise AssertionError("retry loop exhausted without returning or raising")

    @staticmethod
    def _decode(raw: bytes, limit: int) -> dict[str, Any]:
        if len(raw) > limit:
            raise EvaluatorAPIError(
                status=None,
                code="response_too_large",
                message=f"server response exceeds {limit} bytes",
                retryable=False,
            )
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise EvaluatorAPIError(
                status=None,
                code="invalid_response",
                message="server response was not valid JSON",
                retryable=False,
            ) from error
        if not isinstance(value, dict):
            raise EvaluatorAPIError(
                status=None,
                code="invalid_response",
                message="server response must be a JSON object",
                retryable=False,
            )
        return value

    @classmethod
    def _http_error(cls, error: HTTPError, limit: int) -> EvaluatorAPIError:
        raw = error.read(limit + 1)
        try:
            response = ErrorResponse.from_wire(cls._decode(raw, limit))
        except (ValueError, EvaluatorAPIError):
            return EvaluatorAPIError(
                status=error.code,
                code="http_error",
                message=f"server returned HTTP {error.code}",
                retryable=error.code in _RETRYABLE_HTTP_STATUSES,
            )
        return EvaluatorAPIError(
            status=error.code,
            code=response.error.code,
            message=response.error.message,
            retryable=response.error.retryable,
            request_id=response.error.request_id,
        )
