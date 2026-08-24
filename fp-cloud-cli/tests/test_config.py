from __future__ import annotations

import os
import stat
from datetime import datetime, timedelta, timezone

from fp_cli import config


def _iso(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) + delta).strftime("%Y-%m-%dT%H:%M:%SZ")


def test_load_missing_returns_defaults(home):
    cfg = config.load_config()
    assert cfg.base_url is None  # no default URL — it must be set explicitly
    assert cfg.session_token is None


def test_save_and_load_roundtrip(home):
    cfg = config.CliConfig(
        base_url="http://x.test",
        session_token="t",
        expires_at="2999-01-01T00:00:00Z",
        email="e@test",
        user_id="u",
    )
    config.save_config(cfg)
    assert config.load_config() == cfg


def test_save_uses_0600_permissions(home):
    config.save_config(config.CliConfig())
    mode = stat.S_IMODE(os.stat(config.config_path()).st_mode)
    assert mode == 0o600


def test_base_dir_respects_fp_home(home):
    assert config.base_dir() == home


def test_clear_token_wipes_session_identity_and_org(home):
    # logout must leave NO stale identity: token, expiry, email, user id, and the
    # active org are all cleared. base_url / insecure / anonymous_id are kept so the
    # next login doesn't need them re-specified and telemetry stays stable.
    config.save_config(
        config.CliConfig(
            base_url="http://x.test",
            session_token="t",
            expires_at="2999-01-01T00:00:00Z",
            email="e@test",
            user_id="u1",
            insecure=True,
            org="acme",
            anonymous_id="anon-123",
        )
    )
    config.clear_token(config.load_config())
    reloaded = config.load_config()
    # cleared — nothing about who/where remains
    assert reloaded.session_token is None
    assert reloaded.expires_at is None
    assert reloaded.email is None
    assert reloaded.user_id is None
    assert reloaded.org is None
    # kept — preferences + stable machine id
    assert reloaded.base_url == "http://x.test"
    assert reloaded.insecure is True
    assert reloaded.anonymous_id == "anon-123"


def test_corrupt_file_falls_back_to_defaults(home):
    path = config.config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not json")
    assert config.load_config().base_url is None


def test_is_expired():
    assert config.is_expired(config.CliConfig()) is True  # no token at all
    assert config.is_expired(config.CliConfig(session_token="t")) is True  # no expiry
    assert config.is_expired(
        config.CliConfig(session_token="t", expires_at=_iso(timedelta(hours=-1)))
    ) is True
    assert config.is_expired(
        config.CliConfig(session_token="t", expires_at=_iso(timedelta(hours=1)))
    ) is False


def test_is_expired_handles_z_suffix_and_skew():
    # 30s in the future is "expired" under the default 60s skew.
    soon = _iso(timedelta(seconds=30))
    assert config.is_expired(config.CliConfig(session_token="t", expires_at=soon)) is True


def test_insecure_defaults_false_and_roundtrips(home):
    assert config.load_config().insecure is False  # secure by default
    config.save_config(config.CliConfig(insecure=True))
    assert config.load_config().insecure is True
