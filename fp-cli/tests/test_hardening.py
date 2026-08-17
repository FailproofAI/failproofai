"""Regression tests for the cli-bug-fix hardening pass.

Covers the crash/robustness fixes: pagination cursor type-mix, guarded file reads,
the non-JSON read-body trap, 429 messaging, explicit ISO date validation, non-finite
score bounds, and the empty-token (no silent saved-session fallback) guard.
"""

from __future__ import annotations

from fp_cli import _click_compat as click  # the Click Typer is running
import httpx
import pytest
import respx

from fp_cli import client, config, dates
from fp_cli._context import validate_score_filters
from fp_cli.app import app
from fp_cli.client import ClientContext
from fp_cli.commands._write import read_text_arg
from fp_cli.errors import ApiError
from fp_cli.models import Page

BASE = "http://dash.test"


def _ctx() -> ClientContext:
    return ClientContext(base_url=BASE, token="t", org="globex")


# --- paginate: int/str cursor mix must not crash (was a TypeError) ----------


def test_paginate_mixed_cursor_types_no_crash():
    # start_cursor is a str (from --cursor); pages return int next_cursor.
    pages = [Page(items=[1, 2], next_cursor=100), Page(items=[3], next_cursor=None)]
    seq = iter(pages)

    def fetch(cursor, limit):
        return next(seq)

    got = list(client.paginate(fetch, limit=10, page_size=2, start_cursor="9999999999999999"))
    assert got == [1, 2, 3]


def test_paginate_stops_on_repeated_cursor():
    # A server that returns the same cursor forever must not loop forever.
    def fetch(cursor, limit):
        return Page(items=["x"], next_cursor=42)

    got = list(client.paginate(fetch, limit=1000, page_size=1, start_cursor=None))
    assert 0 < len(got) < 1000  # bounded by the seen-cursor guard


# --- read_text_arg: missing file -> usage error, not a traceback -----------


def test_read_text_arg_missing_file_is_usage_error():
    with pytest.raises(click.BadParameter):
        read_text_arg("/no/such/file.json")


# --- _get_json: non-JSON 2xx body -> ApiError, not raw JSONDecodeError ------


@respx.mock
def test_get_json_non_json_body_raises_clean_apierror():
    respx.get(f"{BASE}/api/events").mock(
        return_value=httpx.Response(200, text="<html>not json</html>")
    )
    with pytest.raises(ApiError):
        client._get_json(_ctx(), "/api/events")


@respx.mock
def test_429_includes_retry_after():
    respx.get(f"{BASE}/api/events").mock(
        return_value=httpx.Response(429, headers={"retry-after": "5"}, json={})
    )
    with pytest.raises(ApiError) as ei:
        client._get_json(_ctx(), "/api/events")
    assert "Retry after 5" in str(ei.value)


# --- dates: explicit --from/--to validation --------------------------------


def test_resolve_range_rejects_garbage_date():
    with pytest.raises(ValueError):
        dates.resolve_range(ts_from="not-a-date")


def test_resolve_range_rejects_date_only():
    with pytest.raises(ValueError):
        dates.resolve_range(ts_from="2026-06-01")


def test_resolve_range_accepts_full_iso():
    frm, _ = dates.resolve_range(ts_from="2026-05-01T00:00:00Z")
    assert frm == "2026-05-01T00:00:00Z"


# --- validate_score_filters: reject non-finite bounds ----------------------


@pytest.mark.parametrize("value", ["helpfulness:nan..", "x:0.0..inf", "y:-inf..1"])
def test_score_filter_rejects_non_finite(value):
    with pytest.raises(click.BadParameter):
        validate_score_filters([value])


def test_score_filter_accepts_valid_ranges():
    validate_score_filters(["helpfulness:0.5..0.8", "x:..0.3", "y:0.9.."])  # no raise


@pytest.mark.parametrize("value", ["helpfulness:..", "x:..", "metric:.."])
def test_score_filter_rejects_both_bounds_empty(value):
    # `KEY:..` (no min, no max) is meaningless — the server silently drops it and
    # returns the UNFILTERED set, so it must be a clean client-side usage error.
    with pytest.raises(click.BadParameter):
        validate_score_filters([value])


# --- empty --token must NOT silently use the saved session -----------------


def test_empty_token_does_not_fall_back_to_saved_session(home, runner):
    config.save_config(config.CliConfig(base_url=BASE, session_token="saved-tok"))
    # `--token ""` (e.g. an unset CI var) is an explicit "no auth", not a fallback.
    result = runner.invoke(app, ["--base-url", BASE, "--token", "", "events"])
    assert result.exit_code == 4, result.output  # not logged in (was: used saved-tok)


def test_negative_timeout_is_usage_error(home, runner):
    result = runner.invoke(app, ["--base-url", BASE, "--timeout", "-1", "events"])
    assert result.exit_code == 2, result.output
