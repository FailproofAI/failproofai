"""Anti-drift guard for API-key mode's `/api/*` -> `/v1/*` translation.

Why this test is shaped the way it is
-------------------------------------
The CLI already had an anti-drift test that stayed green through an 85 -> 0 collapse
(`memory/2026-07-24-typer-026-vendored-click-breaks-cli-errors.md`): it walked the
command tree with the *same* broken predicate the production code used, so it
compared nothing to nothing and reported success. The lesson is not "write an
anti-drift test", it is "get the expectation from a source the production code does
not also consult".

So each leg below sources its input independently of `client.py`'s own logic:

1. The set of paths comes from an **AST scan of client.py's string literals**, not
   from any registry the translator reads. Add a call site and it appears here
   whether or not anyone remembered a list.
2. The set of legal `/v1` paths comes from the **server router's own `.route()`
   literals**. A path the CLI is happy to build but the server never registered
   fails here, which is the 404-in-CI this whole feature could otherwise ship.
3. The unsupported commands are driven through a **real CliRunner**, asserting the
   exit code AND that zero HTTP calls happened — the "fails before any network
   call" half is the part a return-value assertion cannot see.
"""

from __future__ import annotations

import ast
import os
import pathlib
import re

import httpx
import pytest
import respx

from fp_cli import client as api
from fp_cli.app import app
from fp_cli.errors import KeyModeUnsupportedError

CLIENT_PY = pathlib.Path(api.__file__)
BASE = "http://dash.test"
KEY = "ak_live_abc123"


# --- leg 1: every /api/ literal in client.py is classified -------------------


def _api_path_literals(source: str) -> set:
    """Every `/api/...` path the CLI can build, read straight out of the source.

    f-strings are reconstructed as templates (`f"/api/keys/{key_id}/disable"` ->
    `/api/keys/{}/disable`) so an interpolated id becomes a wildcard segment rather
    than a fragment. The constant *pieces* of an f-string are skipped for exactly that
    reason: `"/api/issues/"` on its own is not a path anyone requests.
    """
    tree = ast.parse(source)
    inside_fstring = {
        id(v)
        for node in ast.walk(tree)
        if isinstance(node, ast.JoinedStr)
        for v in node.values
    }
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            text = "".join(
                v.value if isinstance(v, ast.Constant) and isinstance(v.value, str) else "{}"
                for v in node.values
            )
        elif (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and id(node) not in inside_fstring
        ):
            text = node.value
        else:
            continue
        # `> len("/api/")` skips the `_API_PREFIX` constant itself: it is the rule, not
        # a path, and no real request is ever made to a bare "/api/".
        if text.startswith("/api/") and len(text) > len("/api/"):
            found.add(text)
    return found


def _buckets(path: str) -> list:
    """Which classification(s) `path` falls into, computed from the DATA in client.py
    rather than by calling its classifier — a catch-all `else` in the translator must
    not be able to make this test pass."""
    kinds = []
    if path in api._V1_RENAMED:
        kinds.append("override")
    else:
        # The rename is an exact-match override of the family rule, so it is only
        # checked when the path is not itself renamed; that keeps the three buckets
        # genuinely disjoint instead of "exactly one, if you squint".
        family = path[len("/api/") :].split("/", 1)[0]
        if family in api._V1_NO_EQUIVALENT:
            kinds.append("no-v1")
        if family in api._V1_MECHANICAL_FAMILIES:
            kinds.append("mechanical")
    return kinds


def test_every_api_literal_is_classified_exactly_once():
    literals = _api_path_literals(CLIENT_PY.read_text())
    assert literals, "the AST scan found no /api/ paths — it has stopped asking anything"
    unclassified = sorted(p for p in literals if not _buckets(p))
    assert not unclassified, (
        "these /api/ paths have no /v1 classification — add the family to "
        "_V1_MECHANICAL_FAMILIES, _V1_RENAMED or _V1_NO_EQUIVALENT in client.py "
        f"(and check the server actually serves it): {unclassified}"
    )
    ambiguous = sorted(p for p in literals if len(_buckets(p)) > 1)
    assert not ambiguous, f"/api paths matching more than one bucket: {ambiguous}"


def test_no_v1_paths_raise_instead_of_being_requested():
    literals = _api_path_literals(CLIENT_PY.read_text())
    excluded = [p for p in literals if _buckets(p) == ["no-v1"]]
    assert excluded, "the excluded families vanished from client.py — verify on purpose"
    for path in excluded:
        with pytest.raises(KeyModeUnsupportedError):
            api._v1_path(path)


def test_an_unknown_family_raises_loudly():
    # The property the two lists above cannot prove about each other: a path in no
    # bucket must fail, not pass through to a URL nobody chose.
    with pytest.raises(Exception) as excinfo:
        api._v1_path("/api/telepathy/read")
    assert "/api/telepathy/read" in str(excinfo.value)


def test_the_score_keys_rename_is_applied():
    # Hyphen -> underscore. It exists only in the dashboard proxy
    # (dashboard/app/api/evaluations/score-keys/route.ts), so a blind s|^/api|/v1|
    # 404s and the CLI reports a cheerful "Not found."
    assert api._v1_path("/api/evaluations/score-keys") == "/v1/evaluations/score_keys"
    assert api._FACET_PATHS["score_filters"] == "/api/evaluations/score-keys"


# --- leg 2: every produced /v1 path exists in the server router ---------------


SERVER_ROUTER = pathlib.Path("server") / "src" / "routes" / "mod.rs"


def _repo_root():
    """The AgentEye monorepo root, or None when it is not on disk.

    The CLI lives in this repo; the Rust server this leg checks against lives in the
    private AgentEye monorepo. So the anchor is the router file ITSELF, not a marker
    like AGENTS.md — this repo has its own AGENTS.md at the root, and anchoring on
    that would resolve to a root with no `server/` under it and fail for the wrong
    reason. Set FP_AGENTEYE_ROOT to point at a monorepo checkout to run this leg in
    CI; otherwise it skips.
    """
    override = os.environ.get("FP_AGENTEYE_ROOT")
    if override:
        return pathlib.Path(override)
    for parent in [CLIENT_PY, *CLIENT_PY.parents]:
        if (parent / SERVER_ROUTER).is_file():
            return parent
    return None


def _versioned_route_templates():
    """The route path literals inside the server's `versioned_routes()` — i.e. exactly
    the set that gets nested under `/v1`.

    Parsing the WHOLE file would be wrong in the silent direction: the root-only block
    in `router()` registers `/auth/session`, `/agent/conversations` and friends, so a
    CLI path that must never be translated would look perfectly valid.
    """
    root = _repo_root()
    if root is None:
        pytest.skip(
            "AgentEye monorepo not on disk — set FP_AGENTEYE_ROOT to a checkout to "
            "verify CLI paths against the real server router"
        )
    mod_rs = root / SERVER_ROUTER
    # Inside the monorepo a missing router is a real failure. A bare skip here is how
    # this test would go quietly useless the day the file moves.
    assert mod_rs.is_file(), f"server router not found at {mod_rs} — this test cannot verify anything"
    source = mod_rs.read_text()
    start = source.find("fn versioned_routes")
    end = source.find("pub fn router")
    assert 0 <= start < end, (
        f"{mod_rs} no longer has `fn versioned_routes` before `pub fn router`; the /v1 "
        "router was reshaped and this test must be re-pointed at the new source of truth"
    )
    return set(re.findall(r'\.route\(\s*"([^"]+)"', source[start:end]))


def _matches(cli_path: str, server_template: str) -> bool:
    """`/v1/issues/{}/comments` matches the server's `/issues/{iid}/comments`.

    A `{}` segment on the CLI side is an interpolated id, so it may only line up with a
    server `{capture}` — never with a literal, or `/queries/{}` would silently "match"
    `/queries/run`.
    """
    cli_parts, server_parts = cli_path.split("/"), server_template.split("/")
    if len(cli_parts) != len(server_parts):
        return False
    for got, want in zip(cli_parts, server_parts):
        if want.startswith("{") and want.endswith("}"):
            continue
        if got != want:
            return False
    return True


def test_every_translated_path_is_a_real_server_route():
    templates = _versioned_route_templates()
    literals = _api_path_literals(CLIENT_PY.read_text())
    translated = {}
    for path in literals:
        if _buckets(path) == ["no-v1"]:
            continue
        translated[path] = api._v1_path(path)
    assert translated, "nothing was translated — the scan or the translator is broken"

    missing = sorted(
        f"{src} -> {dst}"
        for src, dst in translated.items()
        if not any(_matches(dst[len("/v1") :], t) for t in templates)
    )
    assert not missing, (
        "these CLI paths translate to a /v1 route the server does not register — they "
        f"would 404 with an API key and nothing else would notice: {missing}"
    )


# --- leg 3: unsupported commands fail before any network call -----------------


UNSUPPORTED = [
    ["login"],
    ["logout"],
    ["orgs", "list"],
    ["orgs", "switch", "acme"],
    ["orgs", "current"],
    ["orgs", "perms"],
    ["agent", "health"],
    ["agent", "models"],
    ["agent", "chats"],
    ["agent", "ask", "hello"],
    ["agent", "show", "abc123"],
    ["agent", "rename", "abc123", "--title", "x"],
    ["agent", "delete", "abc123", "--yes"],
    ["keys", "update", "ci-bot", "--add", "keys:read"],
]


@pytest.mark.parametrize("argv", UNSUPPORTED, ids=lambda a: " ".join(a[:2]))
def test_unsupported_command_exits_2_with_zero_http_calls(logged_in, runner, argv):
    # `logged_in` seeds a saved session deliberately: the failure must come from the
    # key, not from having nothing else to fall back on.
    with respx.mock(assert_all_called=False) as mock:
        catch_all = mock.route().mock(return_value=httpx.Response(200, json={}))
        result = runner.invoke(app, ["--base-url", BASE, "--api-key", KEY, *argv])
    assert result.exit_code == 2, f"{argv} -> {result.exit_code}: {result.output}"
    assert catch_all.call_count == 0, f"{argv} opened a connection before failing"


def test_unsupported_command_says_why_and_what_to_do(logged_in, runner):
    result = runner.invoke(app, ["--base-url", BASE, "--api-key", KEY, "--json", "orgs", "list"])
    assert result.exit_code == 2, result.output
    assert "API key" in result.stdout
    assert "fp login" in result.stdout  # the hint rides in the JSON envelope


def test_whoami_is_the_exception(logged_in, runner):
    # Contractually "never errors" (cli/skill/SKILL.md leans on it as the pre-flight).
    result = runner.invoke(app, ["--base-url", BASE, "--api-key", KEY, "whoami"])
    assert result.exit_code == 0, result.output


SUPPORTED = [
    (["keys", "list"], "/v1/keys", []),
    (["sessions"], "/v1/sessions", {"sessions": [], "next_cursor": None}),
    (["events"], "/v1/events/summary", {"events": [], "next_cursor": None}),
    (["issues", "list"], "/v1/issues", []),
    (["list", "envs"], "/v1/events/environments", []),
    (["list", "score_filters"], "/v1/evaluations/score_keys", []),
    (["query", "list"], "/v1/queries", {"queries": []}),
    (["users", "list"], "/v1/users", []),
    (["settings", "list"], "/v1/settings", {"settings": []}),
    (["alerts", "list"], "/v1/alerts", []),
    (["audits", "list"], "/v1/audits", []),
]


@pytest.mark.parametrize("argv,path,body", SUPPORTED, ids=lambda a: " ".join(a[:2]) if isinstance(a, list) else "")
def test_supported_commands_reach_their_v1_route(logged_in, runner, argv, path, body):
    """The other half of leg 3: the guard must not have swallowed the working set, and
    each command must land on the `/v1` route it is supposed to (only this exact URL is
    mocked, so a wrong path is a connection error, not a quiet pass)."""
    with respx.mock(assert_all_called=False) as mock:
        route = mock.get(f"{BASE}{path}").mock(return_value=httpx.Response(200, json=body))
        result = runner.invoke(app, ["--base-url", BASE, "--api-key", KEY, "--json", *argv])
    assert result.exit_code == 0, f"{argv} -> {result.exit_code}: {result.output}"
    assert route.called
