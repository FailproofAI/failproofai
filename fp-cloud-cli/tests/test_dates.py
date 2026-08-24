from __future__ import annotations

from datetime import datetime, timezone

import pytest

from fp_cli import dates

NOW = datetime(2026, 5, 25, 12, 0, 0, tzinfo=timezone.utc)


def test_all_and_none_have_no_bounds():
    assert dates.resolve_range("all") == (None, None)
    assert dates.resolve_range(None) == (None, None)


@pytest.mark.parametrize(
    "preset,expected_from",
    [
        ("15m", "2026-05-25T11:45:00Z"),
        ("1h", "2026-05-25T11:00:00Z"),
        ("6h", "2026-05-25T06:00:00Z"),
        ("24h", "2026-05-24T12:00:00Z"),
        ("7d", "2026-05-18T12:00:00Z"),
    ],
)
def test_presets(preset, expected_from):
    ts_from, ts_to = dates.resolve_range(preset, now=NOW)
    assert ts_from == expected_from
    assert ts_to is None


def test_custom_from_to_overrides_since():
    ts_from, ts_to = dates.resolve_range(
        "24h", "2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z", now=NOW
    )
    assert ts_from == "2020-01-01T00:00:00Z"
    assert ts_to == "2020-01-02T00:00:00Z"


def test_invalid_since_raises():
    with pytest.raises(ValueError):
        dates.resolve_range("bogus", now=NOW)


@pytest.mark.parametrize(
    "ok_value",
    ["2026-05-01T00:00:00Z", "2026-05-01T00:00:00+00:00", "2026-05-01T12:30:00-05:00"],
)
def test_from_accepts_rfc3339_with_timezone(ok_value):
    ts_from, _ = dates.resolve_range(None, ok_value, None, now=NOW)
    assert ts_from == ok_value


@pytest.mark.parametrize(
    "bad_value",
    [
        "2026-05-01",              # date only
        "2026-05-01T00:00:00",     # no timezone offset → server 400
        "2026-05-01 00:00:00Z",    # space separator, not 'T'
        "not-a-date",
    ],
)
def test_from_rejects_naive_or_malformed(bad_value):
    # These deserialize to a server 400 (exit 1); validating client-side keeps them a
    # clean usage error (exit 2). Applies to --from and --to alike.
    with pytest.raises(ValueError):
        dates.resolve_range(None, bad_value, None, now=NOW)
    with pytest.raises(ValueError):
        dates.resolve_range(None, None, bad_value, now=NOW)


def test_since_choices_cover_presets():
    for preset in dates.PRESETS:
        assert preset in dates.SINCE_CHOICES
    assert "all" in dates.SINCE_CHOICES
