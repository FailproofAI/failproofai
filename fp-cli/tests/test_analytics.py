"""Tests for CLI telemetry.

The whole suite runs with telemetry **off** (``is_dev_or_test`` sees
``PYTEST_CURRENT_TEST``), so nothing here ever touches the network. Tests that need
the capture path force ``resolve_config`` to ``enabled`` and swap in a fake client
that records calls — mirroring the transport-fake style used elsewhere in the suite.
"""

from __future__ import annotations

import json

import pytest

from fp_cli import analytics
from fp_cli import analytics_config as acfg
from fp_cli import app as appmod
from fp_cli import config
from fp_cli._version import __version__


class FakeClient:
    """Stand-in for ``posthog.Posthog`` that records calls instead of sending."""

    def __init__(self, api_key=None, **kwargs):
        self.api_key = api_key
        self.kwargs = kwargs
        self.events = []  # list of (distinct_id, event, properties)
        self.aliases = []  # list of (previous_id, distinct_id)
        self.flushed = 0
        self.shutdowns = 0

    # Keyword-only after `event`, mirroring the installed posthog>=7 signature
    # (`capture(self, event, **kwargs)`). It was the posthog-3 positional shape,
    # so every assertion in this file and in test_telemetry_completeness.py was
    # validated against a stand-in the real client no longer matched — a 380-line
    # privacy suite proving nothing about what would actually go over the wire.
    def capture(self, event=None, *, distinct_id=None, properties=None, **_):
        self.events.append((distinct_id, event, properties))

    def alias(self, previous_id=None, distinct_id=None, **_):
        self.aliases.append((previous_id, distinct_id))

    def flush(self):
        self.flushed += 1

    def shutdown(self):
        self.shutdowns += 1


@pytest.fixture(autouse=True)
def _clean_analytics_state():
    """Reset the module singleton around every test."""
    analytics._client = None
    analytics._distinct_id = None
    analytics._command = None
    analytics._json_output = False
    analytics._auth_mode = "none"
    analytics._force_anonymous = False
    analytics._init_done = False      # client is built lazily; reset the one-shot guard
    analytics._pending_conf = None
    yield
    analytics.shutdown()
    analytics._client = None
    analytics._init_done = False
    analytics._pending_conf = None
    analytics._force_anonymous = False


@pytest.fixture
def force_enabled(monkeypatch):
    """Force telemetry 'enabled' despite the pytest gate, backed by a fake client."""
    monkeypatch.setattr(
        acfg,
        "resolve_config",
        lambda: acfg.AnalyticsConfig(enabled=True, api_key="phc_test", host="http://ph.test"),
    )
    import posthog

    monkeypatch.setattr(posthog, "Posthog", FakeClient)
    return FakeClient


# --- gating / opt-out ------------------------------------------------------------


def test_disabled_under_pytest(monkeypatch):
    for var in ("FP_ANALYTICS_DISABLED", "DO_NOT_TRACK", "FP_CLI_DEV"):
        monkeypatch.delenv(var, raising=False)
    # PYTEST_CURRENT_TEST is set by pytest, so the dev/test gate alone disables us.
    assert acfg.is_dev_or_test() is True
    assert acfg.resolve_config().enabled is False
    analytics.init_analytics(config.CliConfig())
    analytics._ensure_client()  # force the (deferred) build — stays off because disabled
    assert analytics._client is None


@pytest.mark.parametrize("var", ["FP_ANALYTICS_DISABLED", "DO_NOT_TRACK"])
@pytest.mark.parametrize("val", ["1", "true", "TRUE", "yes", "Yes"])
def test_opt_out_truthy(monkeypatch, var, val):
    monkeypatch.setenv(var, val)
    assert acfg.is_disabled() is True


@pytest.mark.parametrize("val", ["0", "false", "no", "", "  "])
def test_opt_out_falsey(monkeypatch, val):
    monkeypatch.delenv("DO_NOT_TRACK", raising=False)
    monkeypatch.setenv("FP_ANALYTICS_DISABLED", val)
    assert acfg.is_disabled() is False


def test_init_noop_when_opted_out(monkeypatch):
    # Even with the pytest gate bypassed, the opt-out env var keeps us off.
    monkeypatch.setattr(acfg, "is_dev_or_test", lambda: False)
    monkeypatch.setenv("FP_ANALYTICS_DISABLED", "1")
    analytics.init_analytics(config.CliConfig())
    analytics._ensure_client()  # force the (deferred) build — stays off because opted out
    assert analytics._client is None


# --- distinct id / identity ------------------------------------------------------


def test_anonymous_id_generated_and_persisted(home, force_enabled):
    analytics.init_analytics(config.load_config())
    analytics._ensure_client()  # client is built lazily on first use
    assert analytics._client is not None
    anon = config.load_config().anonymous_id
    assert anon  # persisted to cli.json
    assert analytics._distinct_id == anon  # logged-out -> anonymous distinct id


def test_logged_in_uses_user_id_not_anonymous(home, force_enabled):
    config.save_config(
        config.CliConfig(base_url="http://d", session_token="tok", user_id="u-42")
    )
    analytics.init_analytics(config.load_config())
    analytics._ensure_client()  # client is built lazily on first use
    assert analytics._distinct_id == "u-42"
    # No anonymous id is minted while logged in.
    assert config.load_config().anonymous_id is None


def test_super_properties_tag_product(home, force_enabled):
    analytics.init_analytics(config.load_config())
    analytics._ensure_client()  # client is built lazily on first use
    sup = analytics._client.kwargs["super_properties"]
    # Must match analytics_config.PRODUCT exactly — it is the discriminator that keeps
    # this CLI's events apart from the Enforcement CLI's in the shared PostHog project.
    assert sup["product"] == "fp-cli"
    assert sup["cli_version"] == __version__
    assert sup["os"] and sup["python_version"]
    # The client is constructed against the direct ingest host, geoip disabled.
    assert analytics._client.kwargs["disable_geoip"] is True


def test_identify_links_anonymous_to_user(home, force_enabled):
    config.save_config(config.CliConfig(anonymous_id="anon-1"))
    analytics.init_analytics(config.load_config())
    analytics.identify("user-xyz")
    assert analytics._client.aliases == [("anon-1", "user-xyz")]


def test_identify_noop_when_disabled():
    # No force_enabled -> client is None; must not raise.
    analytics.init_analytics(config.CliConfig())
    analytics.identify("user-xyz")  # no-op, no exception


def test_reset_rotates_anonymous_id(home, force_enabled):
    config.save_config(config.CliConfig(anonymous_id="old-anon"))
    analytics.init_analytics(config.load_config())
    analytics.reset()
    rotated = config.load_config().anonymous_id
    assert rotated and rotated != "old-anon"


def test_reset_rotates_even_when_disabled(home):
    # The anonymous id is persistent state and the opt-out flag can flip between runs,
    # so logout must rotate it regardless of whether telemetry is active this run.
    config.save_config(config.CliConfig(anonymous_id="keep"))
    analytics.init_analytics(config.CliConfig())  # disabled -> client None
    analytics.reset()
    after = config.load_config().anonymous_id
    assert after and after != "keep"


# --- command_executed payload / privacy ------------------------------------------


def _only_event(client):
    assert len(client.events) == 1
    distinct_id, event, props = client.events[0]
    return distinct_id, event, props


def test_command_executed_payload_allowlist(home, force_enabled):
    analytics.init_analytics(config.load_config())
    analytics.note_command("sessions", True)
    argv = [
        "--json", "sessions", "--since", "24h",
        "--base-url", "https://secret.internal",
        "--score", "helpfulness:..0.5",
    ]
    analytics.capture_command(exit_code=0, duration_ms=12, argv=argv)

    _, event, props = _only_event(analytics._client)
    assert event == "command_executed"
    assert props == {
        "command": "sessions",
        "subcommand": None,
        "success": True,
        "exit_code": 0,
        "error_category": None,
        "duration_ms": 12,
        "flags": ["--json", "--since", "--base-url", "--score"],
        "json_output": True,
        "auth_mode": "none",
    }
    # No argument VALUES leak — serialise the whole payload and scan.
    blob = json.dumps(props)
    for secret in ("secret.internal", "24h", "helpfulness", "0.5"):
        assert secret not in blob


def test_command_executed_group_subcommand(home, force_enabled):
    analytics.init_analytics(config.load_config())
    analytics.note_command("agent", False)
    analytics.capture_command(
        exit_code=0, duration_ms=3, argv=["agent", "rename", "chat-001", "--title", "secret title"]
    )
    _, _, props = _only_event(analytics._client)
    assert props["command"] == "agent"
    assert props["subcommand"] == "rename"
    assert props["flags"] == ["--title"]
    blob = json.dumps(props)
    assert "chat-001" not in blob and "secret title" not in blob


def test_auth_mode_rides_on_command_executed(home, force_enabled):
    from fp_cli.client import AuthMode

    analytics.init_analytics(config.load_config())
    analytics.note_command("sessions", False, auth_mode=AuthMode.API_KEY)
    analytics.capture_command(
        exit_code=0, duration_ms=1, argv=["--api-key", "ak_live_SECRET", "sessions"]
    )
    _, _, props = _only_event(analytics._client)
    assert props["auth_mode"] == "api_key"
    # The mode is the whole signal: never the key, its length, or a prefix.
    blob = json.dumps(props)
    assert "ak_live_SECRET" not in blob and "SECRET" not in blob
    assert props["flags"] == ["--api-key"]  # the NAME only


@pytest.mark.parametrize("given,expected", [
    ("session", "session"),
    ("api_key", "api_key"),
    (None, "none"),
    ("something-else", "none"),  # closed enum: an unexpected value degrades, never rides along
])
def test_auth_mode_is_a_closed_enum(home, force_enabled, given, expected):
    analytics.init_analytics(config.load_config())
    analytics.note_command("whoami", False, auth_mode=given)
    analytics.capture_command(exit_code=0, duration_ms=1, argv=["whoami"])
    _, _, props = _only_event(analytics._client)
    assert props["auth_mode"] == expected


def test_key_mode_forces_the_anonymous_distinct_id(home, force_enabled):
    # A CI box with a logged-in human on it: the key's commands must NOT be attributed
    # to that person.
    config.save_config(
        config.CliConfig(base_url="http://d", session_token="tok", user_id="u-42")
    )
    analytics.init_analytics(config.load_config(), force_anonymous=True)
    analytics._ensure_client()
    assert analytics._distinct_id != "u-42"
    assert analytics._distinct_id == config.load_config().anonymous_id


def test_unknown_command_is_dropped(home, force_enabled):
    analytics.init_analytics(config.load_config())
    analytics.note_command("rm-rf-everything", False)  # not a real command
    analytics.capture_command(exit_code=0, duration_ms=1, argv=["rm-rf-everything"])
    _, _, props = _only_event(analytics._client)
    assert props["command"] is None


@pytest.mark.parametrize(
    "code,category,success",
    [
        (0, None, True),
        (2, "usage", False),
        (3, "network", False),
        (4, "auth", False),
        (5, "forbidden", False),
        (6, "not_found", False),
        (1, "error", False),
    ],
)
def test_error_category_from_exit_code(home, force_enabled, code, category, success):
    analytics.init_analytics(config.load_config())
    analytics.note_command("whoami", False)
    analytics.capture_command(exit_code=code, duration_ms=1, argv=["whoami"])
    _, _, props = _only_event(analytics._client)
    assert props["error_category"] == category
    assert props["success"] is success


# --- helpers ---------------------------------------------------------------------


def test_sanitize_flags_keeps_names_drops_values():
    argv = [
        "--base-url", "https://secret", "--token", "abc", "--email", "a@b.com",
        "--score", "k:..0.5", "sessions", "-q", "--unknown-xyz", "-5",
        "--fields=session_id,scores",
    ]
    flags = analytics._sanitize_flags(argv)
    assert flags == ["--base-url", "--token", "--email", "--score", "--quiet", "--fields"]
    blob = " ".join(flags)
    for leak in ("secret", "abc", "a@b.com", "k:..0.5", "session_id"):
        assert leak not in blob


@pytest.mark.parametrize(
    "argv,expected",
    [
        (["agent", "show", "x"], "show"),
        (["agent", "rename"], "rename"),
        (["--json", "agent", "show"], "show"),
        (["agent", "rename", "show"], "rename"),  # first after 'agent' wins
        (["sessions", "--all"], None),  # 'sessions' is a leaf, not a group
        (["whoami"], None),
    ],
)
def test_detect_subcommand(argv, expected):
    assert analytics._detect_subcommand(argv) == expected


def test_shutdown_is_idempotent(home, force_enabled):
    analytics.init_analytics(config.load_config())
    analytics._ensure_client()  # client is built lazily on first use
    client = analytics._client
    analytics.shutdown()
    assert analytics._client is None
    assert client.flushed == 1 and client.shutdowns == 1
    analytics.shutdown()  # second call: no-op, no error
    assert client.flushed == 1


# --- entry-point wrapper preserves exit codes ------------------------------------


def test_main_entry_preserves_exit_code(monkeypatch):
    recorded = {}

    def boom():
        raise SystemExit(4)

    monkeypatch.setattr(appmod, "app", boom)
    monkeypatch.setattr(
        appmod.analytics, "capture_command", lambda code, ms, argv: recorded.update(code=code)
    )
    monkeypatch.setattr(appmod.analytics, "shutdown", lambda: None)

    with pytest.raises(SystemExit) as exc:
        appmod.main_entry()
    assert exc.value.code == 4
    assert recorded["code"] == 4


def test_main_entry_success_path(monkeypatch):
    recorded = {}
    monkeypatch.setattr(appmod, "app", lambda: None)  # returns without exiting
    monkeypatch.setattr(
        appmod.analytics, "capture_command", lambda code, ms, argv: recorded.update(code=code)
    )
    monkeypatch.setattr(appmod.analytics, "shutdown", lambda: None)

    with pytest.raises(SystemExit) as exc:
        appmod.main_entry()
    assert exc.value.code == 0
    assert recorded["code"] == 0
