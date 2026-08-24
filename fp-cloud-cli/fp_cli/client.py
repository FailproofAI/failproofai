"""Pure query layer for the FailproofAI Cloud API.

Every function takes a :class:`ClientContext` and returns plain dataclasses or
primitives. Nothing here prints or imports Typer/Rich — this is the surface a
future MCP server wraps directly. :class:`AuthMode` is defined here rather than in
``_context`` for the same reason the dependency runs this way round: ``_context``
imports *this* module, and the transport below needs the enum at runtime to pick
bearer vs cookie. ``_context`` re-exports it.

Two auth modes, and they never mix:

* **session** — the ``ae_session`` cookie against the dashboard's ``/api/*``
  routes (its ``withAuth`` reads the cookie only; it does not accept a bearer).
* **api_key** — ``Authorization: Bearer <key>`` against the server's curated
  versioned API at ``/v1/*``. Every path is translated at the four request
  chokepoints below (see :func:`_v1_path`), never at the ~70 call sites.
"""

from __future__ import annotations

import json as _json
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence, Union

import httpx

from .errors import (
    ApiError,
    AuthError,
    ForbiddenError,
    KeyModeUnsupportedError,
    NetworkError,
    NotFoundError,
)
from .models import (
    AgentEvent,
    Alert,
    ApiKey,
    Audit,
    AuditFinding,
    AuditRun,
    DashboardUser,
    Deployment,
    Evaluation,
    Incident,
    IncidentComment,
    IncidentSubscriber,
    Machine,
    Page,
    PolicyRef,
    PolicyVersion,
    QueryResult,
    SavedQuery,
    Session,
    SessionUser,
    SettingRow,
)

MAX_PAGE_SIZE = 200


class AuthMode(str, Enum):
    """Which credential this invocation carries — an explicit state, never inferred.

    Resolved once from the flags/env/saved config (see ``_context.resolve_auth``) and
    then carried on both ``AppState`` and :class:`ClientContext`. It is an enum rather
    than ``if state.api_key`` because the empty-string cases have to stay
    distinguishable: ``--api-key ""`` is *key mode with no credential* (an error), NOT
    "fall back to whatever session happens to be saved on this machine".

    ``str``-valued so the telemetry property is the enum itself — one closed set, no
    second hand-written mapping to drift.
    """

    SESSION = "session"
    API_KEY = "api_key"
    NONE = "none"


@dataclass
class ClientContext:
    base_url: str
    token: Optional[str] = None
    timeout: float = 30.0
    transport: Optional[httpx.BaseTransport] = None
    verify: bool = True
    org: Optional[str] = None  # active tenant slug -> X-AgentEye-Org header
    api_key: Optional[str] = None  # bearer credential; only read in AuthMode.API_KEY
    # Defaults to SESSION so every existing construction site (login, the org probe,
    # tests) keeps its cookie behaviour unchanged.
    auth_mode: AuthMode = AuthMode.SESSION


# --- /v1 translation (API-key mode only) ------------------------------------
#
# The CLI's ~70 call sites all name the DASHBOARD's proxy path (`/api/...`). An
# API key cannot use those: `withAuth` reads the `ae_session` cookie and nothing
# else. Key mode therefore targets the server's curated versioned API directly,
# and the rewrite happens HERE — at the four request chokepoints — so no call
# site can forget it.
#
# It is deliberately NOT a blind `s|^/api|/v1|`. Two families would break
# silently under that:
#
#   * `/api/evaluations/score-keys` is a RENAME invented by the proxy — the
#     server route is `evaluations/score_keys` (see
#     dashboard/app/api/evaluations/score-keys/route.ts). A blind swap 404s and
#     the CLI reports a cheerful "Not found."
#   * `/api/auth/*` and `/api/agent/*` have NO `/v1` equivalent at all. The auth
#     and conversation routes are deliberately excluded from the version
#     contract, and `agent/chat` + `agent/health` exist only in the dashboard —
#     there is no server route to reach.
#
# Anything else is unclassified, and unclassified must be LOUD: a new call site
# that quietly passed through would produce a wrong URL, and the failure would
# arrive months later as "the CLI 404s in CI". `tests/test_v1_routing.py`
# AST-scans this file for every `/api/` literal and asserts each one lands in
# exactly one of these three buckets, then checks the resulting `/v1` paths
# against the server router's own `.route()` literals.

_API_PREFIX = "/api/"

# `/api/<family>/...` -> `/v1/<family>/...`, byte-identical below the prefix.
# Keyed on the FIRST path segment: a family is either mirrored wholesale or not
# at all, and listing families (not paths) keeps this honest without a 60-entry
# table that nobody would maintain.
_V1_MECHANICAL_FAMILIES = frozenset(
    {
        "access-granters",
        "alerts",
        "audits",
        "evaluations",
        "events",
        "issues",
        "keys",
        "permission-sets",
        "queries",
        "sessions",
        "settings",
        # Organization usage / billing windows. Mechanical: the server registers
        # /usage and /usage/windows inside `versioned_routes`, so both are on /v1.
        "usage",
        "users",
    }
)

# Exact paths the dashboard proxy renames on the way through. Checked BEFORE the
# family rule, which is why this must stay exact-match.
_V1_RENAMED = {
    "/api/evaluations/score-keys": "/v1/evaluations/score_keys",
}

# Families with no `/v1` route, and why — the message a user actually sees.
_V1_NO_EQUIVALENT = {
    "auth": (
        "the sign-in endpoints are deliberately absent from /v1 — they take a browser "
        "session, not an API key"
    ),
    "agent": (
        "the assistant is implemented by the dashboard, not the API — there is no /v1 "
        "route behind it"
    ),
    # ROOT-ONLY on the server, and deliberately so: `/v1` is published on the
    # dashboard host by the ingress, and publish/deploy/rollback are operator
    # writes gated on `policies:write`. Exposing them there would put fleet
    # mutation on the open internet. See the ROOT-ONLY block in
    # `server/src/routes/mod.rs`.
    "enforcement": (
        "cloud-managed policies are an operator surface — the fleet routes are "
        "deliberately absent from /v1, which is internet-facing"
    ),
}


def _v1_path(path: str) -> str:
    """Translate a dashboard `/api/...` path to its `/v1/...` equivalent.

    Raises :class:`KeyModeUnsupportedError` (exit 2) for a family that has no `/v1`
    route, and :class:`ApiError` for anything unclassified — never a silent
    pass-through, which would send a request to a URL nobody chose.
    """
    if path in _V1_RENAMED:
        return _V1_RENAMED[path]
    if not path.startswith(_API_PREFIX):
        raise ApiError(
            f"the CLI cannot address {path!r} with an API key: it is not a dashboard "
            "/api/ path. This is a bug in the CLI, not in your command.",
            hint="re-run without --api-key (session mode) and please report it",
        )
    family = path[len(_API_PREFIX) :].split("/", 1)[0]
    if family in _V1_NO_EQUIVALENT:
        raise KeyModeUnsupportedError(
            f"{path} has no API-key equivalent — {_V1_NO_EQUIVALENT[family]}",
            hint="run this command with a signed-in session (fp login) instead",
        )
    if family in _V1_MECHANICAL_FAMILIES:
        return "/v1/" + path[len(_API_PREFIX) :]
    raise ApiError(
        f"the CLI does not know how to reach {path!r} on the versioned API — the "
        "key-mode route table in client.py has no entry for it.",
        hint="re-run without --api-key (session mode) and please report it",
    )


#: Segments that change which endpoint a path addresses rather than naming a
#: record. `..` walks up, `.` is a no-op the server may or may not collapse, and
#: an EMPTY segment turns `/api/users/{id}` with an unset id into `/api/users/`,
#: i.e. the collection — so `disable_user(ctx, "")` from an unset CI variable
#: addressed every user instead of failing.
_BAD_SEGMENTS = frozenset({"", ".", ".."})


def _validate_path(path: str) -> None:
    """Refuse a path whose interpolated ids have changed what it addresses.

    Every `f"/api/…/{id}"` in this module interpolates a caller-supplied value
    raw — there is no `quote` anywhere — and httpx then RESOLVES the result as a
    URL. So an id containing `..`, `?` or `#` silently re-points the request, and
    that defeats `_v1_path`'s family guard specifically: the family is computed
    from the literal prefix BEFORE httpx normalises the dot segments away, so
    `disable_key(key_ctx, "../enforcement/policies/x/enable")` classified as the
    mechanical `keys` family and then issued
    `POST /v1/enforcement/policies/x/enable/disable` — an operator-write family
    that `_V1_NO_EQUIVALENT` exists to make unreachable under an API key.

    In session mode the same shapes read the wrong record without saying so:
    `get_incident(ctx, "abc#frag")` requests `/api/issues/abc` (fragment dropped)
    and returns a different issue as if it were the right one, and
    `put_setting(ctx, "foo?admin=1", v)` injects a query parameter.

    Raising rather than quoting, because none of these are a legitimate id that
    merely needs escaping — they are a caller passing something that is not an
    id at all, and the useful answer is to say so.
    """
    head = path.split("?", 1)[0].split("#", 1)[0]
    if head != path:
        raise ApiError(
            f"the CLI refuses to request {path!r}: an id contained '?' or '#', which "
            "changes which endpoint is called rather than naming a record.",
            hint="check the id you passed — it is not a valid identifier",
        )
    for segment in path.split("/")[1:]:
        if segment in _BAD_SEGMENTS:
            raise ApiError(
                f"the CLI refuses to request {path!r}: it contains an empty or "
                "relative path segment, which addresses a different endpoint than "
                "the command intends.",
                hint="check the id you passed — an unset variable is the usual cause",
            )


def _path(ctx: ClientContext, path: str) -> str:
    """The path to actually request: `/v1/...` under an API key, `/api/...` otherwise.

    The single choke point every request goes through, in both modes, which is
    why the id validation lives here rather than at 45 interpolation sites.
    """
    _validate_path(path)
    if ctx.auth_mode is AuthMode.API_KEY:
        return _v1_path(path)
    return path


def _client(ctx: ClientContext, *, timeout: Any = None) -> httpx.Client:
    headers = {"x-request-id": uuid.uuid4().hex}
    cookies = None
    # Bearer XOR cookie — an `else`, never two independent `if`s. Sending both
    # would hand a human's `ae_session` to `/v1` alongside the key, and every
    # positive assertion ("the bearer header is set") would still pass while the
    # CLI leaked a session cookie into CI. tests/test_auth_mode.py asserts the
    # NEGATIVE on both sides.
    if ctx.auth_mode is AuthMode.API_KEY:
        if ctx.api_key:
            headers["Authorization"] = f"Bearer {ctx.api_key}"
    else:
        if ctx.token:
            cookies = {"ae_session": ctx.token}
    # The dashboard resolves the active org from this header (dashboard/lib/withAuth.ts);
    # without it a multi-org user is rejected. Single-org users are fine either way.
    # In key mode the caller only ever puts an EXPLICIT --org/FP_ORG in `org`
    # (see `_context.build_context`), never the saved one.
    if ctx.org:
        headers["X-AgentEye-Org"] = ctx.org
    return httpx.Client(
        base_url=ctx.base_url.rstrip("/"),
        cookies=cookies,
        headers=headers,
        timeout=ctx.timeout if timeout is None else timeout,
        transport=ctx.transport,
        verify=ctx.verify,
    )


def _csv(value: Optional[Union[str, Sequence[str]]]) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value or None
    items = [str(v) for v in value if str(v)]
    return ",".join(items) if items else None


def _bool(value: Optional[bool]) -> Optional[str]:
    if value is None:
        return None
    return "true" if value else "false"


def _extract_error(response: httpx.Response) -> Optional[str]:
    try:
        data = response.json()
    except Exception:
        return None
    if isinstance(data, dict):
        msg = data.get("error") or data.get("message")
        if not msg:
            return None
        # Fold in the server's raw `detail` (e.g. the underlying DB error for a failed
        # `query run`) so an agent gets the actionable message, not just "query failed".
        detail = data.get("detail")
        if detail and str(detail) != str(msg):
            return f"{msg}: {detail}"
        return str(msg)
    return None


def _required_permission(response: httpx.Response) -> Optional[str]:
    """The ``required_permission`` slug the server names on a 403 (e.g. ``keys:create``), so the
    CLI can tell the user exactly which grant they're missing instead of a bare ``forbidden``."""
    try:
        data = response.json()
    except Exception:
        return None
    if isinstance(data, dict) and data.get("required_permission"):
        return str(data["required_permission"])
    return None


def _raise_for_status(response: httpx.Response, ctx: ClientContext) -> None:
    key_mode = ctx.auth_mode is AuthMode.API_KEY
    if response.status_code < 400:
        # A 3xx to /login means the request never reached the API: some front door
        # (Next.js middleware) answered it. httpx does not follow redirects, so
        # without this the body is empty/HTML and the caller reports "the dashboard
        # returned a malformed response" — which sends people hunting for a server
        # bug. In key mode it has exactly one cause worth naming.
        if 300 <= response.status_code < 400 and key_mode:
            location = response.headers.get("location", "")
            if "/login" in location:
                raise ApiError(
                    "/v1 is not routed at this base URL — the request was redirected to "
                    "the dashboard's login page, so it landed on the web app instead of "
                    "the API.",
                    status=response.status_code,
                    request_id=response.headers.get("x-request-id"),
                    hint="point --base-url at the server itself, e.g. http://localhost:8080",
                )
        # Session mode is deliberately left alone for the /login case: that 3xx is
        # the ordinary "your cookie is gone" case and changing its exit code is a
        # separate contract change.
        #
        # Every OTHER 3xx is an error for every method, in both modes. httpx does
        # not follow redirects, so a 3xx means the request did not reach the API
        # at all — and `_request_json` turns the empty body into `{}`, which the
        # mutating half of the CLI reads as success. `fp --base-url http://…
        # issues ack i1` against a front door that 301s http→https exited 0
        # printing "✓ acknowledged issue i1" while the POST never arrived;
        # `deploy_policies` returned an empty Deployment, which an operator reads
        # as "the machine now runs nothing" rather than "nothing happened".
        if 300 <= response.status_code < 400:
            raise ApiError(
                "The request was redirected and did not reach the API, so it had no "
                "effect. Nothing was changed.",
                status=response.status_code,
                request_id=response.headers.get("x-request-id"),
                hint=(
                    "check --base-url: a redirect here usually means http:// where the "
                    "server wants https://, or a front door in front of the API"
                ),
            )
        return
    request_id = response.headers.get("x-request-id")
    message = _extract_error(response)
    if response.status_code == 401:
        if key_mode:
            raise AuthError(
                "The API key was rejected. It may be revoked, mistyped, or issued by a "
                "different deployment than --base-url points at."
            )
        raise AuthError("Session expired or not logged in. Run fp login.")
    if response.status_code == 403:
        needed = _required_permission(response)
        if key_mode:
            # Genuinely ambiguous, and the server cannot disambiguate it for us: a key
            # acting for an org it was not issued for gets the SAME 403 as a key missing
            # a permission, on purpose — telling the two apart would let a key holder
            # enumerate which orgs exist. So name both causes rather than guess one.
            what = (
                f"the API key is missing the {needed} permission"
                if needed
                else "the API key is not allowed to do this"
            )
            raise ForbiddenError(
                f"{what}, or it cannot act for this org — the server answers 403 for both.",
                hint="check the key's grants, and the org you targeted with --org / FP_ORG",
            )
        if needed:
            raise ForbiddenError(f"you don't have the {needed} permission")
        raise ForbiddenError(message or "you don't have permission for this action")
    if response.status_code == 404:
        # In key mode a 404 has TWO very different causes, and the wrong reading
        # sends people hunting for a server bug that isn't there:
        #   1. the endpoint genuinely has no such record — the API answered, in JSON;
        #   2. `/v1` is not routed at this origin at all, so something else answered.
        #
        # (2) is the likeliest first-run mistake: pointing --base-url at a
        # dashboard whose front door does not forward /v1. It used to surface as a
        # 3xx to /login, which the branch above names — but a dashboard that
        # correctly declines to auth-gate /v1 returns its own 404 instead, and that
        # is indistinguishable from (1) on the status code alone.
        #
        # The tell is the content type: our API always answers JSON, so an HTML
        # body means a web app answered a request meant for the API.
        if key_mode:
            content_type = response.headers.get("content-type", "").lower()
            if "html" in content_type:
                raise ApiError(
                    "/v1 is not routed at this base URL — an HTML page answered, so the "
                    "request reached a web app rather than the API.",
                    status=404,
                    request_id=request_id,
                    hint="point --base-url at the server itself, e.g. http://localhost:8080",
                )
        raise NotFoundError(message or "Not found.")
    if response.status_code == 429:
        retry_after = response.headers.get("retry-after")
        wait = f" Retry after {retry_after}s." if retry_after else " Please wait a moment and try again."
        raise ApiError(
            (message or "Rate limited — too many requests.") + wait,
            status=429,
            request_id=request_id,
        )
    raise ApiError(
        message or f"Request failed with status {response.status_code}.",
        status=response.status_code,
        request_id=request_id,
    )


def _get_json(ctx: ClientContext, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
    clean = {k: v for k, v in (params or {}).items() if v is not None}
    url = _path(ctx, path)  # chokepoint 1 of 4 for the /api -> /v1 rewrite
    try:
        with _client(ctx) as client:
            response = client.get(url, params=clean)
    except httpx.RequestError as exc:
        raise NetworkError(
            f"Cannot reach FailproofAI Cloud at {ctx.base_url}: {exc}"
        )
    _raise_for_status(response, ctx)
    # A 2xx with an empty or non-JSON body is anomalous for a read (e.g. a proxy or
    # captive portal returning an HTML 200). Surface it as a clean error instead of
    # letting `response.json()` raise a raw JSONDecodeError traceback.
    try:
        return response.json()
    except ValueError:
        raise ApiError(
            "The dashboard returned a malformed (non-JSON) response.",
            status=response.status_code,
            request_id=response.headers.get("x-request-id"),
        )


def _request_json(
    ctx: ClientContext,
    method: str,
    path: str,
    *,
    json_body: Any = None,
    params: Optional[Dict[str, Any]] = None,
) -> Any:
    """Issue a write request and return the parsed JSON body (or ``{}`` if empty).

    Mirrors :func:`_get_json`: maps transport failures to :class:`NetworkError` and
    applies the shared 401/403/404/4xx/5xx mapping via :func:`_raise_for_status`, so
    every write inherits the same exit-code contract. Tolerates an empty/204 body.
    """
    clean = {k: v for k, v in (params or {}).items() if v is not None} or None
    url = _path(ctx, path)  # chokepoint 2 of 4 for the /api -> /v1 rewrite
    try:
        with _client(ctx) as client:
            response = client.request(method, url, json=json_body, params=clean)
    except httpx.RequestError as exc:
        raise NetworkError(
            f"Cannot reach FailproofAI Cloud at {ctx.base_url}: {exc}"
        )
    _raise_for_status(response, ctx)
    # A genuinely empty body (204, or a 200 with no content) is a legitimate
    # "done, nothing to report" for a mutation.
    if not response.content:
        return {}
    try:
        return response.json()
    except ValueError:
        # A body that is PRESENT but not JSON is not that. It is a proxy error
        # page, a captive portal, or a front door answering instead of the API —
        # and returning `{}` made every one of those read as success on the
        # mutating half of the CLI, which is the half where a false success
        # matters. Reads already raise here; writes now do too.
        raise ApiError(
            "The dashboard returned a malformed (non-JSON) response, so the request "
            "may not have been applied.",
            status=response.status_code,
            request_id=response.headers.get("x-request-id"),
        )


def _post_json(ctx: ClientContext, path: str, json_body: Any = None, *, params: Optional[Dict[str, Any]] = None) -> Any:
    return _request_json(ctx, "POST", path, json_body=json_body, params=params)


def _put_json(ctx: ClientContext, path: str, json_body: Any = None) -> Any:
    return _request_json(ctx, "PUT", path, json_body=json_body)


def _patch_json(ctx: ClientContext, path: str, json_body: Any = None) -> Any:
    return _request_json(ctx, "PATCH", path, json_body=json_body)


def _delete(ctx: ClientContext, path: str) -> Any:
    return _request_json(ctx, "DELETE", path)


# --- Auth / identity --------------------------------------------------------


def get_session_user(ctx: ClientContext) -> SessionUser:
    """GET /api/auth/session — the currently authenticated user."""
    return SessionUser.from_dict(_get_json(ctx, "/api/auth/session"))


def org_is_accessible(ctx: ClientContext, slug: str) -> bool:
    """Return True iff the authenticated user can act in org ``slug`` — i.e. the
    org **exists** AND is granted to them (a membership, or an instance admin with
    access). Probes a cheap org-scoped endpoint with ``X-AgentEye-Org: slug``;
    HTTP 200 → accessible, 403/404 → the org does not exist or is not theirs.

    Used to validate an explicitly-requested tenant (``--org`` / ``FP_ORG``)
    before it is saved, so a non-existent or unauthorised slug is rejected up front
    instead of being persisted and breaking every later command.

    Raises :class:`AuthError` on 401 (dead session) and :class:`NetworkError` on a
    transport failure, so a transient outage is never misreported as a bad org.
    """
    probe = ClientContext(
        base_url=ctx.base_url,
        token=ctx.token,
        timeout=ctx.timeout,
        verify=ctx.verify,
        org=slug,
        api_key=ctx.api_key,
        auth_mode=ctx.auth_mode,
    )
    try:
        with _client(probe) as client:
            # Probe an auth-only endpoint (no specific data permission): it returns 200 for a
            # member OR an instance admin granted the org, and 403/404 otherwise. Using a
            # permission-gated route (e.g. /api/evaluations/environments) wrongly rejected an
            # instance admin who has org access but no data perms.
            # chokepoint 3 of 4 — this one builds its own client rather than going
            # through _get_json, so it needs the rewrite applied by hand.
            response = client.get(_path(probe, "/api/access-granters"))
    except httpx.RequestError as exc:
        raise NetworkError(
            f"Cannot reach FailproofAI Cloud at {ctx.base_url}: {exc}"
        )
    if response.status_code == 200:
        return True
    if response.status_code == 401:
        raise AuthError("Session expired or not logged in. Run fp login.")
    # 403 / 404 (and anything else non-2xx) → the org is not accessible to this user.
    return False


# --- Events -----------------------------------------------------------------


def _event_query_params(
    *,
    session_id: Optional[Union[str, Sequence[str]]],
    agent_id: Optional[Union[str, Sequence[str]]],
    event_type: Optional[Union[str, Sequence[str]]],
    environment: Optional[Union[str, Sequence[str]]],
    error_type: Optional[Union[str, Sequence[str]]],
    errored: Optional[bool],
    order: Optional[str],
    search: Optional[Sequence[str]],
    search_exclude: Optional[Union[str, Sequence[str]]],
    ts_from: Optional[str],
    ts_to: Optional[str],
    cursor: Optional[Union[int, str]],
    limit: Optional[int],
) -> Dict[str, Any]:
    """The shared filter/cursor/order query params for the events feeds.

    ``/api/events`` (full) and ``/api/events/summary`` (light) accept an IDENTICAL query
    surface and emit an interchangeable ``"<ts>|<id>"`` cursor, so both feeds build their
    params here — they can never drift.
    """
    # session_id / agent_id are CSV multi-value on the wire (server `IN (...)`); `_csv`
    # serializes a list to `a,b` and passes a bare string through unchanged (back-compat).
    params: Dict[str, Any] = {
        "session_id": _csv(session_id),
        "agent_id": _csv(agent_id),
        "event_type": _csv(event_type),
        "environment": _csv(environment),
        "error_type": _csv(error_type),
        # the server reads `errored` only when truthy (matches the dashboard `/errors` view).
        "errored": "true" if errored else None,
        "order": order,
        "search_exclude": _csv(search_exclude),
        "ts_from": ts_from,
        "ts_to": ts_to,
        "cursor": cursor,
        "limit": limit,
    }
    # `search` is free text — sent as REPEATED params (not CSV), so httpx needs a list.
    terms = [s for s in (search or []) if s and s.strip()]
    if terms:
        params["search"] = terms
    return params


def list_events(
    ctx: ClientContext,
    *,
    session_id: Optional[Union[str, Sequence[str]]] = None,
    agent_id: Optional[Union[str, Sequence[str]]] = None,
    event_type: Optional[Union[str, Sequence[str]]] = None,
    environment: Optional[Union[str, Sequence[str]]] = None,
    error_type: Optional[Union[str, Sequence[str]]] = None,
    errored: Optional[bool] = None,
    order: Optional[str] = None,
    search: Optional[Sequence[str]] = None,
    search_exclude: Optional[Union[str, Sequence[str]]] = None,
    ts_from: Optional[str] = None,
    ts_to: Optional[str] = None,
    cursor: Optional[Union[int, str]] = None,
    limit: Optional[int] = None,
) -> Page[AgentEvent]:
    """GET /api/events — the FULL feed (includes the fat ``payload`` column).

    Heavy at scale (payload is ~99.9% of the events table, read under ``FINAL``). Use only
    for the bounded, payload-requesting paths (``events --full`` /
    ``--fields payload``). The default list + all of ``errors`` use
    :func:`list_event_summaries` instead.
    """
    params = _event_query_params(
        session_id=session_id, agent_id=agent_id, event_type=event_type,
        environment=environment, error_type=error_type, errored=errored, order=order,
        search=search, search_exclude=search_exclude, ts_from=ts_from, ts_to=ts_to,
        cursor=cursor, limit=limit,
    )
    data = _get_json(ctx, "/api/events", params)
    items = [AgentEvent.from_dict(e) for e in (data if isinstance(data, dict) else {}).get("events", [])]
    return Page(items=items, next_cursor=data.get("next_cursor"))


def list_event_summaries(
    ctx: ClientContext,
    *,
    session_id: Optional[Union[str, Sequence[str]]] = None,
    agent_id: Optional[Union[str, Sequence[str]]] = None,
    event_type: Optional[Union[str, Sequence[str]]] = None,
    environment: Optional[Union[str, Sequence[str]]] = None,
    error_type: Optional[Union[str, Sequence[str]]] = None,
    errored: Optional[bool] = None,
    order: Optional[str] = None,
    search: Optional[Sequence[str]] = None,
    search_exclude: Optional[Union[str, Sequence[str]]] = None,
    ts_from: Optional[str] = None,
    ts_to: Optional[str] = None,
    cursor: Optional[Union[int, str]] = None,
    limit: Optional[int] = None,
) -> Page[AgentEvent]:
    """GET /api/events/summary — the LIGHT, payload-free feed (PR #338).

    Same filters/order and an interchangeable cursor as :func:`list_events`, but the server
    projects only the display columns (no ``payload``): it returns the precomputed
    ``summary`` / ``is_error`` plus ``error_type`` / ``output_tokens`` / context-window
    fields. This is the CLI's default read path: ordinary list/errors reads do not touch the
    fat payload column. A free-text ``search`` is the deliberate exception: the response is
    still payload-free, but the server scans payload in the WHERE clause to find matches.
    """
    params = _event_query_params(
        session_id=session_id, agent_id=agent_id, event_type=event_type,
        environment=environment, error_type=error_type, errored=errored, order=order,
        search=search, search_exclude=search_exclude, ts_from=ts_from, ts_to=ts_to,
        cursor=cursor, limit=limit,
    )
    data = _get_json(ctx, "/api/events/summary", params)
    items = [AgentEvent.from_dict(e) for e in (data if isinstance(data, dict) else {}).get("events", [])]
    return Page(items=items, next_cursor=data.get("next_cursor"))


# --- Event facets & analytics ----------------------------------------------

_FACET_PATHS = {
    "agent_ids": "/api/events/agent_ids",
    "event_types": "/api/events/event_types",
    "models": "/api/events/models",
    "tool_names": "/api/events/tool_names",
    "hook_names": "/api/events/hook_names",
    "error_types": "/api/events/error_types",
    "trigger_events": "/api/events/trigger_events",
    "environments": "/api/events/environments",
    # Evaluation score keys (a distinct endpoint, not /api/events) — the source for
    # the sessions-page score-filter dropdown; needs `evaluations:read`.
    "score_filters": "/api/evaluations/score-keys",
}
FACET_KINDS = tuple(_FACET_PATHS.keys())


def list_facet(ctx: ClientContext, kind: str) -> List[str]:
    """GET /api/events/<kind> — distinct facet values (a bare JSON array)."""
    data = _get_json(ctx, _FACET_PATHS[kind])
    return [str(x) for x in data] if isinstance(data, list) else []


def get_usage(ctx: ClientContext) -> Dict[str, Any]:
    """GET /api/usage — the active org's current 30-day metering window."""
    data = _get_json(ctx, "/api/usage")
    if not isinstance(data, dict):
        raise ApiError("The dashboard returned an invalid usage response.")
    return data


def event_error_summary(
    ctx: ClientContext,
    *,
    session_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    event_type: Optional[Union[str, Sequence[str]]] = None,
    error_type: Optional[Union[str, Sequence[str]]] = None,
    environment: Optional[Union[str, Sequence[str]]] = None,
    ts_from: Optional[str] = None,
    ts_to: Optional[str] = None,
    search: Optional[Sequence[str]] = None,
    search_exclude: Optional[Union[str, Sequence[str]]] = None,
) -> Dict[str, Any]:
    """GET /api/events/error_summary — {total, sessions, agents, last_ts, bins}."""
    params: Dict[str, Any] = {
        "session_id": session_id,
        "agent_id": agent_id,
        "event_type": _csv(event_type),
        "error_type": _csv(error_type),
        "environment": _csv(environment),
        "ts_from": ts_from,
        "ts_to": ts_to,
        "search_exclude": _csv(search_exclude),
    }
    terms = [s for s in (search or []) if s and s.strip()]
    if terms:
        params["search"] = terms
    data = _get_json(ctx, "/api/events/error_summary", params)
    return data if isinstance(data, dict) else {}


# --- Evaluations / sessions -------------------------------------------------


def list_evaluations(
    ctx: ClientContext,
    *,
    session_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    environment: Optional[Union[str, Sequence[str]]] = None,
    status: Optional[str] = None,
    score_filters: Optional[str] = None,
    latest_per_session: Optional[bool] = None,
    ts_from: Optional[str] = None,
    ts_to: Optional[str] = None,
    cursor: Optional[int] = None,
    limit: Optional[int] = None,
) -> Page[Evaluation]:
    data = _get_json(
        ctx,
        "/api/evaluations",
        {
            "session_id": session_id,
            "agent_id": agent_id,
            "environment": _csv(environment),
            "status": status,
            "score_filters": score_filters,
            "latest_per_session": _bool(latest_per_session),
            "ts_from": ts_from,
            "ts_to": ts_to,
            "cursor": cursor,
            "limit": limit,
        },
    )
    items = [Evaluation.from_dict(e) for e in (data if isinstance(data, dict) else {}).get("evaluations", [])]
    return Page(items=items, next_cursor=data.get("next_cursor"))


def list_sessions(
    ctx: ClientContext,
    *,
    session_id: Optional[Union[str, Sequence[str]]] = None,
    agent_id: Optional[Union[str, Sequence[str]]] = None,
    environment: Optional[Union[str, Sequence[str]]] = None,
    status: Optional[Union[str, Sequence[str]]] = None,
    score_filters: Optional[str] = None,
    ts_from: Optional[str] = None,
    ts_to: Optional[str] = None,
    cursor: Optional[str] = None,
    limit: Optional[int] = None,
) -> Page[Session]:
    """GET /api/sessions — one row per agent run (the endpoint the dashboard's sessions page
    uses). Every filter is CSV multi-value on the wire → server ``IN(...)`` (UNION within a
    filter, AND across filters); ``status`` matches each session's LATEST evaluation status.
    ``cursor`` is the opaque string keyset cursor (``"<last_event_at>|<id>"``)."""
    data = _get_json(
        ctx,
        "/api/sessions",
        {
            "session_id": _csv(session_id),
            "agent_id": _csv(agent_id),
            "environment": _csv(environment),
            "status": _csv(status),
            "score_filters": score_filters,
            "ts_from": ts_from,
            "ts_to": ts_to,
            "cursor": cursor,
            "limit": limit,
        },
    )
    items = [Session.from_dict(s) for s in (data if isinstance(data, dict) else {}).get("sessions", [])]
    return Page(items=items, next_cursor=data.get("next_cursor"))


def evaluation_aggregate(
    ctx: ClientContext,
    *,
    session_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    environment: Optional[Union[str, Sequence[str]]] = None,
    status: Optional[str] = None,
    score_filters: Optional[str] = None,
    latest_per_session: Optional[bool] = None,
    featured_keys: Optional[Union[str, Sequence[str]]] = None,
    ts_from: Optional[str] = None,
    ts_to: Optional[str] = None,
) -> Dict[str, Any]:
    """GET /api/evaluations/aggregate — rolled-up status/score stats + timeline."""
    data = _get_json(
        ctx,
        "/api/evaluations/aggregate",
        {
            "session_id": session_id,
            "agent_id": agent_id,
            "environment": _csv(environment),
            "status": status,
            "score_filters": score_filters,
            "latest_per_session": _bool(latest_per_session),
            "featured_keys": _csv(featured_keys),
            "ts_from": ts_from,
            "ts_to": ts_to,
        },
    )
    return data if isinstance(data, dict) else {}


# --- API keys ---------------------------------------------------------------


def list_keys(ctx: ClientContext) -> List[ApiKey]:
    """GET /api/keys — all keys for the org (metadata only; a bare JSON array)."""
    data = _get_json(ctx, "/api/keys")
    return [ApiKey.from_dict(k) for k in (data if isinstance(data, list) else [])]


def list_permission_sets(ctx: ClientContext) -> Dict[str, List[str]]:
    """GET /api/permission-sets — the org's permission sets (built-in + custom) as a
    ``{name: [permissions]}`` map. Used to expand a ``--permission-set`` for a KEY client-side
    (keys store a flat permission list, so the CLI seeds from the set like the dashboard's
    SetPicker). Returns ``{}`` on any non-list/odd shape."""
    data = _get_json(ctx, "/api/permission-sets")
    if not isinstance(data, list):
        return {}
    out: Dict[str, List[str]] = {}
    for s in data:
        if isinstance(s, dict) and s.get("name"):
            out[str(s["name"])] = [str(p) for p in (s.get("permissions") or [])]
    return out


def create_key(ctx: ClientContext, *, name: str, key: str, permissions: Sequence[str]) -> ApiKey:
    """POST /api/keys — create a key. The caller supplies the secret (``key``);
    the response carries no secret (it must be shown to the user once, by the caller)."""
    data = _post_json(ctx, "/api/keys", {"name": name, "key": key, "permissions": list(permissions)})
    return ApiKey.from_dict(data)


def update_key(ctx: ClientContext, key_id: str, *, permissions: Sequence[str]) -> ApiKey:
    """PATCH /api/keys/{id} — replace the key's permission grants."""
    data = _patch_json(ctx, f"/api/keys/{key_id}", {"permissions": list(permissions)})
    return ApiKey.from_dict(data)


def disable_key(ctx: ClientContext, key_id: str) -> None:
    """POST /api/keys/{id}/disable — revoke a key (irreversible)."""
    _post_json(ctx, f"/api/keys/{key_id}/disable")


def regenerate_key(ctx: ClientContext, key_id: str) -> str:
    """POST /api/keys/{id}/regenerate — rotate the secret; returns the NEW secret once."""
    data = _post_json(ctx, f"/api/keys/{key_id}/regenerate")
    key = str(data.get("key", "")) if isinstance(data, dict) else ""
    if not key:
        # The rotation is irreversible and the secret is shown exactly once, so
        # an empty string here is an unrecoverable credential loss, not a
        # cosmetic glitch: `fp keys regenerate ci-bot -y | pbcopy` captured a
        # blank line and exited 0 while the old secret was already dead
        # server-side. Say so instead.
        raise ApiError(
            "the server did not return a new secret, so the key may or may not have "
            "been rotated",
            hint="check `fp keys show <name>` before assuming either way",
        )
    return key


# --- Saved queries / SQL runner ---------------------------------------------


def list_saved_queries(ctx: ClientContext) -> List[SavedQuery]:
    """GET /api/queries — saved queries for the org (response is {"queries": [...]})."""
    data = _get_json(ctx, "/api/queries")
    items = data.get("queries", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
    return [SavedQuery.from_dict(q) for q in items]


def create_saved_query(
    ctx: ClientContext,
    *,
    name: str,
    sql_text: str,
    description: str = "",
    params: Optional[List[Dict[str, Any]]] = None,
) -> SavedQuery:
    """POST /api/queries — create a saved query."""
    body = {"name": name, "description": description, "sql_text": sql_text, "params": params or []}
    return SavedQuery.from_dict(_post_json(ctx, "/api/queries", body))


def update_saved_query(
    ctx: ClientContext,
    query_id: str,
    *,
    name: str,
    sql_text: str,
    description: str = "",
    params: Optional[List[Dict[str, Any]]] = None,
) -> SavedQuery:
    """PUT /api/queries/{id} — full replace of a saved query."""
    body = {"name": name, "description": description, "sql_text": sql_text, "params": params or []}
    return SavedQuery.from_dict(_put_json(ctx, f"/api/queries/{query_id}", body))


def delete_saved_query(ctx: ClientContext, query_id: str) -> None:
    """DELETE /api/queries/{id}."""
    _delete(ctx, f"/api/queries/{query_id}")


def run_query(
    ctx: ClientContext,
    *,
    sql: Optional[str] = None,
    query_id: Optional[str] = None,
    params: Optional[List[Any]] = None,
) -> QueryResult:
    """POST /api/queries/run — execute inline SQL or a saved query (read-only pool)."""
    body: Dict[str, Any] = {"params": params or []}
    if sql is not None:
        body["sql"] = sql
    if query_id is not None:
        body["query_id"] = query_id
    return QueryResult.from_dict(_post_json(ctx, "/api/queries/run", body))


def query_schema(ctx: ClientContext) -> Dict[str, Any]:
    """GET /api/queries/schema — {schema, tables:[{name, columns:[{name,type}]}]}."""
    data = _get_json(ctx, "/api/queries/schema")
    return data if isinstance(data, dict) else {}


# --- Users ------------------------------------------------------------------


def list_users(ctx: ClientContext) -> List[DashboardUser]:
    """GET /api/users — all org members (a bare JSON array)."""
    data = _get_json(ctx, "/api/users")
    return [DashboardUser.from_dict(u) for u in (data if isinstance(data, list) else [])]


def get_user(ctx: ClientContext, user_id: str) -> DashboardUser:
    """GET /api/users/{id}."""
    return DashboardUser.from_dict(_get_json(ctx, f"/api/users/{user_id}"))


def _user_perm_body(permission_set, permission_added, permission_removed) -> Dict[str, Any]:
    body: Dict[str, Any] = {}
    if permission_set is not None:
        body["permission_set"] = permission_set
    if permission_added is not None:
        body["permission_added"] = list(permission_added)
    if permission_removed is not None:
        body["permission_removed"] = list(permission_removed)
    return body


def create_user(
    ctx: ClientContext,
    *,
    email: str,
    permission_set: Optional[str] = None,
    permission_added: Optional[Sequence[str]] = None,
    permission_removed: Optional[Sequence[str]] = None,
) -> DashboardUser:
    """POST /api/users — invite/create a member."""
    body = {"email": email, **_user_perm_body(permission_set, permission_added, permission_removed)}
    return DashboardUser.from_dict(_post_json(ctx, "/api/users", body))


def update_user(
    ctx: ClientContext,
    user_id: str,
    *,
    permission_set: Optional[str] = None,
    permission_added: Optional[Sequence[str]] = None,
    permission_removed: Optional[Sequence[str]] = None,
) -> DashboardUser:
    """PUT /api/users/{id} — change a member's grants."""
    body = _user_perm_body(permission_set, permission_added, permission_removed)
    return DashboardUser.from_dict(_put_json(ctx, f"/api/users/{user_id}", body))


def disable_user(ctx: ClientContext, user_id: str) -> None:
    """DELETE /api/users/{id} — disable a member (reversible via enable)."""
    _delete(ctx, f"/api/users/{user_id}")


def enable_user(ctx: ClientContext, user_id: str) -> DashboardUser:
    """POST /api/users/{id}/enable — re-enable a disabled member."""
    return DashboardUser.from_dict(_post_json(ctx, f"/api/users/{user_id}/enable"))


# --- Settings ---------------------------------------------------------------


def list_settings(ctx: ClientContext) -> List[SettingRow]:
    """GET /api/settings — {settings:[...]}."""
    data = _get_json(ctx, "/api/settings")
    items = data.get("settings", []) if isinstance(data, dict) else []
    return [SettingRow.from_dict(s) for s in items]


def get_settings_schema(ctx: ClientContext) -> List[Dict[str, Any]]:
    """Registry metadata per setting.

    There is no dedicated schema endpoint on the dashboard — each ``GET /api/settings``
    row carries its own ``schema`` blob, so derive the metadata from the settings list.
    """
    rows = list_settings(ctx)
    return [{"key": r.key, **(r.schema or {})} for r in rows]


def put_setting(ctx: ClientContext, key: str, value: Any) -> SettingRow:
    """PUT /api/settings/{key} — body is always wrapped as {"value": ...}."""
    return SettingRow.from_dict(_put_json(ctx, f"/api/settings/{key}", {"value": value}))


# --- Alerts -----------------------------------------------------------------


def list_alerts(ctx: ClientContext) -> List[Alert]:
    """GET /api/alerts — alert definitions for the org (bare array)."""
    data = _get_json(ctx, "/api/alerts")
    return [Alert.from_dict(a) for a in (data if isinstance(data, list) else [])]


def create_alert(ctx: ClientContext, body: Dict[str, Any]) -> Dict[str, Any]:
    """POST /api/alerts — returns {id, created_at}."""
    return _post_json(ctx, "/api/alerts", body)


def update_alert(ctx: ClientContext, alert_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """PUT /api/alerts/{id} — returns {id, updated_at}."""
    return _put_json(ctx, f"/api/alerts/{alert_id}", body)


def delete_alert(ctx: ClientContext, alert_id: str) -> None:
    """DELETE /api/alerts/{id}."""
    _delete(ctx, f"/api/alerts/{alert_id}")


def test_alert(ctx: ClientContext, alert_id: str, channels: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """POST /api/alerts/{id}/test — fire a test notification; {ok, synthetic_incident_id}."""
    return _post_json(ctx, f"/api/alerts/{alert_id}/test", {"channels": channels} if channels else {})


# --- Incidents --------------------------------------------------------------


def list_incidents(
    ctx: ClientContext,
    *,
    state: Optional[str] = None,
    alert_id: Optional[str] = None,
    limit: Optional[int] = None,
) -> List[Incident]:
    """GET /api/issues (or /api/alerts/{id}/issues when alert_id given). The
    alert-scoped path honours ``state``/``limit`` too — pass them so the filters aren't silently
    dropped on that path (``_get_json`` omits None params)."""
    if alert_id:
        data = _get_json(ctx, f"/api/alerts/{alert_id}/issues", {"state": state, "limit": limit})
    else:
        data = _get_json(ctx, "/api/issues", {"state": state, "limit": limit})
    return [Incident.from_dict(i) for i in (data if isinstance(data, list) else [])]


def count_incidents(ctx: ClientContext, *, state: Optional[str] = None) -> int:
    """GET /api/issues/count — {count}."""
    data = _get_json(ctx, "/api/issues/count", {"state": state})
    if not isinstance(data, dict):
        return 0
    try:
        return int(data.get("count", 0))
    except (TypeError, ValueError):
        return 0


def get_incident(ctx: ClientContext, incident_id: str) -> Incident:
    """GET /api/issues/{id} — full detail (comments, subscribers, activity)."""
    return Incident.from_dict(_get_json(ctx, f"/api/issues/{incident_id}"))


def ack_incident(ctx: ClientContext, incident_id: str) -> None:
    _post_json(ctx, f"/api/issues/{incident_id}/ack")


def assign_incident(ctx: ClientContext, incident_id: str, assignees: Sequence[str]) -> None:
    """POST /api/issues/{id}/assign — replace the assignee list (server validates each email)."""
    _post_json(ctx, f"/api/issues/{incident_id}/assign", {"assignees": list(assignees)})


def resolve_incident(ctx: ClientContext, incident_id: str) -> None:
    _post_json(ctx, f"/api/issues/{incident_id}/resolve")


def list_incident_comments(ctx: ClientContext, incident_id: str) -> List[IncidentComment]:
    data = _get_json(ctx, f"/api/issues/{incident_id}/comments")
    return [IncidentComment.from_dict(c) for c in (data if isinstance(data, list) else [])]


def create_incident_comment(ctx: ClientContext, incident_id: str, body: str) -> IncidentComment:
    data = _post_json(ctx, f"/api/issues/{incident_id}/comments", {"body": body})
    return IncidentComment.from_dict(data)


def delete_incident_comment(ctx: ClientContext, incident_id: str, comment_id: str) -> None:
    _delete(ctx, f"/api/issues/{incident_id}/comments/{comment_id}")


def list_incident_subscribers(ctx: ClientContext, incident_id: str) -> List[IncidentSubscriber]:
    data = _get_json(ctx, f"/api/issues/{incident_id}/subscribers")
    return [IncidentSubscriber.from_dict(s) for s in (data if isinstance(data, list) else [])]


def subscribe_incident(ctx: ClientContext, incident_id: str, email: Optional[str] = None) -> None:
    _post_json(ctx, f"/api/issues/{incident_id}/subscribe", {"email": email} if email else {})


def unsubscribe_incident(ctx: ClientContext, incident_id: str, email: Optional[str] = None) -> None:
    _post_json(ctx, f"/api/issues/{incident_id}/unsubscribe", {"email": email} if email else {})


def open_incident(
    ctx: ClientContext,
    *,
    summary: str,
    alert_id: Optional[str] = None,
    severity: Optional[str] = None,
    title: Optional[str] = None,
) -> Dict[str, Any]:
    """POST /api/alerts/{id}/issues (linked) or /api/issues (standalone).

    ``title`` is required by the server on the standalone path (an orphan has no
    parent alert whose name it could borrow) and optional on the linked path,
    where the server falls back to the alert's own name.
    """
    if alert_id:
        linked: Dict[str, Any] = {"summary": summary}
        if title:
            linked["title"] = title
        return _post_json(ctx, f"/api/alerts/{alert_id}/issues", linked)
    body: Dict[str, Any] = {"summary": summary}
    if title:
        body["title"] = title
    if severity:
        body["severity"] = severity
    return _post_json(ctx, "/api/issues", body)


# --- Audits -----------------------------------------------------------------


def list_audits(ctx: ClientContext) -> List[Audit]:
    """GET /api/audits — audit definitions for the org (bare array)."""
    data = _get_json(ctx, "/api/audits")
    return [Audit.from_dict(a) for a in (data if isinstance(data, list) else [])]


def get_audit(ctx: ClientContext, audit_id: str) -> Audit:
    """GET /api/audits/{id} — one audit definition."""
    return Audit.from_dict(_get_json(ctx, f"/api/audits/{audit_id}"))


def create_audit(ctx: ClientContext, body: Dict[str, Any]) -> Dict[str, Any]:
    """POST /api/audits — returns {id, created_at}."""
    return _post_json(ctx, "/api/audits", body)


def update_audit(ctx: ClientContext, audit_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """PUT /api/audits/{id} — full replace; returns {id, updated}."""
    return _put_json(ctx, f"/api/audits/{audit_id}", body)


def delete_audit(ctx: ClientContext, audit_id: str) -> None:
    """DELETE /api/audits/{id}."""
    _delete(ctx, f"/api/audits/{audit_id}")


def run_audit(ctx: ClientContext, audit_id: str) -> Dict[str, Any]:
    """POST /api/audits/{id}/run — queue a run now; 202 {queued: true} (409 if one is running)."""
    return _post_json(ctx, f"/api/audits/{audit_id}/run")


def get_audit_context(ctx: ClientContext, audit_id: str) -> Dict[str, Any]:
    """GET /api/audits/{id}/context — the brief plus each URL's snapshot state."""
    return _get_json(ctx, f"/api/audits/{audit_id}/context")


def put_audit_context(ctx: ClientContext, audit_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """PUT /api/audits/{id}/context — FULL REPLACEMENT; ``{"text":"","urls":[]}`` clears.

    A sub-resource rather than fields on the definition body, so a flag-only
    ``audits edit`` — which read-merges through ``_audit_to_body``'s allowlist —
    can never silently wipe it.
    """
    return _put_json(ctx, f"/api/audits/{audit_id}/context", body)


def refresh_audit_context(ctx: ClientContext, audit_id: str) -> Dict[str, Any]:
    """POST /api/audits/{id}/context/refresh — re-fetch every non-blocked URL."""
    return _post_json(ctx, f"/api/audits/{audit_id}/context/refresh")


def list_audit_runs(ctx: ClientContext, audit_id: str) -> List[AuditRun]:
    """GET /api/audits/{id}/runs — run history, newest first (bare array)."""
    data = _get_json(ctx, f"/api/audits/{audit_id}/runs")
    return [AuditRun.from_dict(r) for r in (data if isinstance(data, list) else [])]


def list_audit_findings(
    ctx: ClientContext,
    *,
    audit_id: Optional[str] = None,
    run_id: Optional[str] = None,
    status: Optional[Union[str, Sequence[str]]] = None,
    limit: Optional[int] = None,
    offset: Optional[int] = None,
) -> List[AuditFinding]:
    """GET /api/audits/findings — the org-wide triage list (bare array, priority-desc).

    ``status`` is CSV on the wire (server ``IN (...)``); omitting it leaves the server's
    default live set (open + recurring).
    """
    data = _get_json(
        ctx,
        "/api/audits/findings",
        {
            "audit_id": audit_id,
            "run_id": run_id,
            "status": _csv(status),
            "limit": limit,
            "offset": offset,
        },
    )
    return [AuditFinding.from_dict(f) for f in (data if isinstance(data, list) else [])]


def get_audit_finding(ctx: ClientContext, finding_id: str) -> AuditFinding:
    """GET /api/audits/findings/{fid} — one finding."""
    return AuditFinding.from_dict(_get_json(ctx, f"/api/audits/findings/{finding_id}"))


def set_finding_status(
    ctx: ClientContext,
    finding_id: str,
    *,
    action: str,
    reason: Optional[str] = None,
    assigned_to: Optional[str] = None,
) -> Dict[str, Any]:
    """POST /api/audits/findings/{fid}/status — triage action; returns {id, action, ok}."""
    body: Dict[str, Any] = {"action": action}
    if reason is not None:
        body["reason"] = reason
    if assigned_to is not None:
        body["assigned_to"] = assigned_to
    return _post_json(ctx, f"/api/audits/findings/{finding_id}/status", body)


# --- Agent assistant --------------------------------------------------------


def agent_health(ctx: ClientContext) -> Dict[str, Any]:
    """GET /api/agent/health — {enabled, llm_configured?, model?, models?, default_model?}."""
    data = _get_json(ctx, "/api/agent/health")
    return data if isinstance(data, dict) else {}


def list_conversations(ctx: ClientContext) -> List[Dict[str, Any]]:
    """GET /api/agent/conversations — {conversations:[...]}."""
    data = _get_json(ctx, "/api/agent/conversations")
    return data.get("conversations", []) if isinstance(data, dict) else []


def get_conversation(ctx: ClientContext, conversation_id: str) -> Dict[str, Any]:
    """GET /api/agent/conversations/{id} — {title, messages:[...]}."""
    data = _get_json(ctx, f"/api/agent/conversations/{conversation_id}")
    return data if isinstance(data, dict) else {}


def rename_conversation(ctx: ClientContext, conversation_id: str, title: str) -> None:
    """PATCH /api/agent/conversations/{id}."""
    _patch_json(ctx, f"/api/agent/conversations/{conversation_id}", {"title": title})


def delete_conversation(ctx: ClientContext, conversation_id: str) -> None:
    """DELETE /api/agent/conversations/{id}."""
    _delete(ctx, f"/api/agent/conversations/{conversation_id}")


def create_conversation(ctx: ClientContext, title: str = "") -> Dict[str, Any]:
    """POST /api/agent/conversations — create an empty conversation (owner = your email,
    so it appears in the dashboard's assistant). Returns the created summary, incl. ``id``.
    An empty title becomes the server default ("New conversation")."""
    data = _post_json(ctx, "/api/agent/conversations", {"title": title})
    return data if isinstance(data, dict) else {}


def replace_messages(
    ctx: ClientContext, conversation_id: str, messages: List[Dict[str, Any]]
) -> None:
    """PUT /api/agent/conversations/{id}/messages — atomically replace the whole thread.

    ``messages`` use the shared wire shape ``{"role": ..., "content": {"text": ...}}`` so
    the persisted transcript renders identically in the CLI and the dashboard assistant.
    """
    _put_json(ctx, f"/api/agent/conversations/{conversation_id}/messages", {"messages": messages})


def _stream_sse(ctx: ClientContext, path: str, body: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    """POST and yield each parsed JSON object from an SSE ``data:`` stream."""
    # Keep the connect (and write/pool) timeout so an unreachable server still fails
    # fast, but DISABLE the read timeout: an SSE answer can legitimately pause between
    # frames (a slow LLM turn or a long tool call) far longer than --timeout, and a
    # read-timeout there would kill the stream mid-answer and be mislabeled "cannot reach".
    stream_timeout = httpx.Timeout(ctx.timeout, read=None)
    url = _path(ctx, path)  # chokepoint 4 of 4 for the /api -> /v1 rewrite
    try:
        with _client(ctx, timeout=stream_timeout) as client:
            with client.stream("POST", url, json=body) as response:
                if response.status_code >= 400:
                    response.read()
                    _raise_for_status(response, ctx)
                buf = ""
                for chunk in response.iter_text():
                    buf += chunk
                    while "\n\n" in buf:
                        frame, buf = buf.split("\n\n", 1)
                        for line in frame.splitlines():
                            if line.startswith("data:"):
                                payload = line[len("data:"):].strip()
                                if payload:
                                    try:
                                        yield _json.loads(payload)
                                    except ValueError:
                                        pass
    except httpx.RequestError as exc:
        raise NetworkError(f"Cannot reach FailproofAI Cloud at {ctx.base_url}: {exc}")


def agent_chat_oneshot(
    ctx: ClientContext,
    *,
    message: Optional[str] = None,
    messages: Optional[List[Dict[str, Any]]] = None,
    conversation_id: Optional[str] = None,
    page_context: Optional[str] = None,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """POST /api/agent/chat — accumulate the streamed answer.

    Pass a single ``message`` (a standalone turn) OR a full ``messages`` thread (to
    continue a conversation); ``conversation_id`` is forwarded for correlation. Aborts
    (``interrupted``) if the assistant asks for interactive input, since the CLI can't
    hold an interactive turn.
    """
    body: Dict[str, Any] = {
        "messages": messages
        if messages is not None
        else [{"role": "user", "content": {"text": message}}]
    }
    if conversation_id:
        body["conversationId"] = conversation_id
    if page_context:
        body["pageContext"] = page_context
    if model:
        body["model"] = model
    parts: List[str] = []
    tools: List[str] = []
    interrupted = False
    error: Optional[str] = None
    for ev in _stream_sse(ctx, "/api/agent/chat", body):
        kind = ev.get("type")
        if kind == "text-delta":
            parts.append(str(ev.get("text", "")))
        elif kind == "tool-start":
            tools.append(str(ev.get("tool", "")))
        elif kind == "ask-user":
            interrupted = True
            error = str(ev.get("question") or "the assistant needs interactive input")
            break
        elif kind == "error":
            error = str(ev.get("message", "assistant error"))
        elif kind == "done":
            break
    return {"answer": "".join(parts), "tools": tools, "interrupted": interrupted, "error": error}


# --- Pagination helper ------------------------------------------------------


class Walk:
    """Where a `paginate()` walk stopped, for a caller that needs to say so.

    A generator cannot return a value to a `list()` around it, and the four
    `--all` commands need one: they were hard-coding ``next_cursor = None`` and
    then emitting ``{"…": [...], "next_cursor": null}``, which positively asserts
    that the feed is exhausted. With `--limit` defaulting to 50, `fp --json
    events --session-id X --all` made ONE request, returned 50 rows out of
    10,000 and told the caller there was nothing more to fetch — and the CLI had
    the live cursor in hand at that moment and threw it away.

    Pass one in and read it after the walk: `truncated` says the walk stopped on
    `--limit` rather than on an exhausted feed, and `next_cursor` is where to
    resume.
    """

    __slots__ = ("truncated", "next_cursor")

    def __init__(self) -> None:
        self.truncated = False
        self.next_cursor: Optional[Union[int, str]] = None


def paginate(
    fetch_page: Callable[..., Page],
    *,
    limit: Optional[int] = None,
    page_size: Optional[int] = None,
    start_cursor: Optional[Union[int, str]] = None,
    walk: Optional["Walk"] = None,
) -> Iterator[Any]:
    """Walk cursor pages, yielding items until exhausted or ``limit`` reached.

    ``fetch_page`` must accept ``cursor`` and ``limit`` keyword arguments and
    return a :class:`Page`. Stops if the cursor fails to decrease (defensive
    against a server that returns a non-decreasing cursor).

    ``walk`` is an optional :class:`Walk` the caller can read afterwards to tell
    a walk that ran out of data from one that ran out of budget.
    """
    if limit is not None and limit <= 0:
        return
    remaining = limit
    cursor: Optional[Union[int, str]] = start_cursor
    seen: set = set()
    while True:
        size = page_size or MAX_PAGE_SIZE
        if remaining is not None:
            size = min(size, remaining)
        size = max(1, min(size, MAX_PAGE_SIZE))

        page = fetch_page(cursor=cursor, limit=size)
        for index, item in enumerate(page.items):
            yield item
            if remaining is not None:
                remaining -= 1
                if remaining <= 0:
                    if walk is not None:
                        # More on this page, or a cursor for the next one: either
                        # way the feed is not exhausted.
                        more_here = index + 1 < len(page.items)
                        if more_here or page.next_cursor is not None:
                            walk.truncated = True
                            walk.next_cursor = page.next_cursor if not more_here else cursor
                    return

        next_cursor = page.next_cursor
        if next_cursor is None:
            return
        # Defensive loop guard: stop if the server hands back a cursor we've already
        # walked (no forward progress). Keyed on the string form so it works for BOTH
        # int cursors (sessions/evaluations) and string cursors (events) without comparing
        # across types — the old `next_cursor >= cursor` crashed on a str/int mix when
        # `--cursor` (a string) was combined with an int-cursor endpoint.
        key = str(next_cursor)
        if key in seen:
            return
        seen.add(key)
        cursor = next_cursor


# ── Cloud-managed enforcement ────────────────────────────────────────────────
#
# Every path here is ROOT-ONLY on the server: deliberately absent from `/v1`,
# because `/v1` is published on the dashboard host by the ingress and these are
# operator WRITE paths (publish, deploy, rollback). The commands therefore refuse
# API-key mode up front via `deny_in_key_mode` rather than translating a path
# that would 404 — see `server/src/routes/mod.rs`, the ROOT-ONLY block.


def list_policies(ctx: ClientContext) -> List[PolicyVersion]:
    """GET /api/enforcement/policies — every published policy, latest version each."""
    data = _get_json(ctx, "/api/enforcement/policies")
    items = data if isinstance(data, list) else data.get("policies", [])
    return [PolicyVersion.from_dict(p) for p in items]


def publish_policy(
    ctx: ClientContext, policy_id: str, source: str, description: str = ""
) -> PolicyVersion:
    """POST /api/enforcement/policies — mints a NEW VERSION; never edits in place."""
    body = {"id": policy_id, "source": source, "description": description}
    return PolicyVersion.from_dict(_post_json(ctx, "/api/enforcement/policies", body) or {})


def set_policy_enabled(ctx: ClientContext, policy_id: str, enabled: bool) -> Dict[str, Any]:
    """POST /api/enforcement/policies/{id}/{enable|disable}."""
    verb = "enable" if enabled else "disable"
    path = f"/api/enforcement/policies/{policy_id}/{verb}"
    return _post_json(ctx, path) or {}


def delete_policy(ctx: ClientContext, policy_id: str) -> Dict[str, Any]:
    """DELETE /api/enforcement/policies/{id} — archives it; machines keep what they hold."""
    return _request_json(ctx, "DELETE", f"/api/enforcement/policies/{policy_id}") or {}


def list_machines(ctx: ClientContext) -> List[Machine]:
    """GET /api/enforcement/machines — every host that has ever checked in."""
    data = _get_json(ctx, "/api/enforcement/machines")
    items = data if isinstance(data, list) else data.get("machines", [])
    return [Machine.from_dict(m) for m in items]


def rename_machine(ctx: ClientContext, machine_id: str, label: str) -> Dict[str, Any]:
    """PATCH /api/enforcement/machines/{id} — a human label, not the id."""
    path = f"/api/enforcement/machines/{machine_id}"
    return _request_json(ctx, "PATCH", path, json_body={"label": label}) or {}


def list_deployments(ctx: ClientContext) -> List[Deployment]:
    """GET /api/enforcement/deployments — what every machine is told to run."""
    data = _get_json(ctx, "/api/enforcement/deployments")
    items = data if isinstance(data, list) else data.get("deployments", [])
    return [Deployment.from_dict(d) for d in items]


def get_deployment(ctx: ClientContext, machine_id: str) -> Optional[Deployment]:
    """One machine's deployment, or None when nothing has been deployed to it.

    The read half of every read-modify-write. `deploy` is a FULL REPLACE, so a
    caller that skips this and sends only what it wants ADDED silently removes
    everything else.
    """
    for dep in list_deployments(ctx):
        if dep.machine_id == machine_id:
            return dep
    return None


def deploy_policies(
    ctx: ClientContext, machine_id: str, policies: Sequence[PolicyRef]
) -> Deployment:
    """PUT /api/enforcement/deployments/{id} — REPLACES the machine's whole set."""
    path = f"/api/enforcement/deployments/{machine_id}"
    body = {"policies": [p.to_dict() for p in policies]}
    return Deployment.from_dict(_request_json(ctx, "PUT", path, json_body=body) or {})


def deployment_history(ctx: ClientContext, machine_id: str) -> List[Dict[str, Any]]:
    """GET /api/enforcement/deployments/{id}/history — every generation, newest first."""
    path = f"/api/enforcement/deployments/{machine_id}/history"
    data = _get_json(ctx, path)
    return data if isinstance(data, list) else data.get("history", [])


def rollback_deployment(ctx: ClientContext, machine_id: str, deployment: int) -> Deployment:
    """POST /api/enforcement/deployments/{id}/rollback — reinstate a past generation.

    Note this mints a NEW generation carrying the old set rather than rewinding
    the counter, so the history stays append-only.
    """
    path = f"/api/enforcement/deployments/{machine_id}/rollback"
    body = {"deployment": deployment}
    return Deployment.from_dict(_post_json(ctx, path, body) or {})


def enforcement_summary(
    ctx: ClientContext, hours: int = 24, machine_id: Optional[str] = None
) -> Dict[str, Any]:
    """GET /api/enforcement/summary — coverage from Postgres, decisions from ClickHouse."""
    params = {"hours": hours}
    if machine_id:
        params["machineId"] = machine_id
    return _get_json(ctx, "/api/enforcement/summary", params=params) or {}


def decision_timeline(
    ctx: ClientContext, hours: int = 24, machine_id: Optional[str] = None
) -> Dict[str, Any]:
    """GET /api/enforcement/decisions/timeline — hourly deny/instruct/paused bins."""
    params = {"hours": hours}
    if machine_id:
        params["machineId"] = machine_id
    return _get_json(ctx, "/api/enforcement/decisions/timeline", params=params) or {}


def compose_policy(ctx: ClientContext, intent: str) -> Dict[str, Any]:
    """POST /api/agent/compose-policy — the assistant drafts a policy source.

    STREAMS. The route answers `text/event-stream`, not JSON: `delta` frames as
    tokens arrive, then one `done` carrying the finished source (the dashboard
    feeds those deltas into a Monaco diff). Reading it as JSON gets a parse
    error on the first frame, which is how this was written the first time.

    The field is `intent`, not `prompt` — the server rejects anything else with
    a 400 before the model is ever called.

    Dashboard-only, like the rest of the assistant: there is no `/v1` route
    behind it.
    """
    source = ""
    for event in _stream_sse(ctx, "/api/agent/compose-policy", {"intent": intent}):
        kind = event.get("type")
        if kind == "error":
            raise ApiError(
                str(event.get("reason") or "the policy composer hit an error"),
                hint="check `fp agent health` — the assistant may not be configured here",
            )
        if kind == "done":
            source = str(event.get("source") or "")
            return {"source": source, "usage": event.get("usage") or {}}
    # The stream ended without a `done`. Returning "" here would render as an
    # empty draft; saying so is the difference between a bug and a blank file.
    #
    # The overwhelmingly likely cause is the composer's own 30s ceiling —
    # `agent/src/server.ts` aborts the request at 30_000ms, server-side, and a
    # slower model or a longer intent simply does not finish. Naming it matters
    # because the obvious remedy (raise --timeout) does nothing: the cut is not
    # on this side.
    raise ApiError(
        "the assistant stopped before returning a policy — the composer has a "
        "30s server-side limit and this draft did not finish inside it",
        hint="try a shorter, more specific description, or run it again",
    )
