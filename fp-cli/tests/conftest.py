from __future__ import annotations

import pytest
from typer.testing import CliRunner

from fp_cli import config

BASE_URL = "http://dash.test"


@pytest.fixture(autouse=True)
def pinned_terminal(monkeypatch):
    """Pin the terminal rich renders against, for every test.

    Without this the suite means something different on every machine: CI has no TTY
    and falls back to 80 columns, while a developer's terminal is whatever width the
    window happens to be — so panels wrap in different places — and `FORCE_COLOR`
    pushes ANSI escapes into output the assertions read as plain text. That is how a
    green CI run coexisted with ~41 local failures.

    `COLUMNS`/`LINES` are the lever because rich reads them from ``os.environ`` at
    render time (and at Console construction), so they also reach the consoles
    ``output.py`` builds at import, which nothing here replaces. 140 is deliberately
    wider than the boxes so nothing wraps; `TERM=dumb` costs rich its colour system,
    so plain text survives even a `-s` run on a real terminal.
    """
    monkeypatch.setenv("COLUMNS", "140")
    monkeypatch.setenv("LINES", "50")
    monkeypatch.setenv("TERM", "dumb")
    # Every knob that forces colour back on regardless of the above (or off, which
    # some assertions would equally depend on) — the run must not inherit any of them.
    for var in ("FORCE_COLOR", "CLICOLOR_FORCE", "NO_COLOR", "TTY_COMPATIBLE"):
        monkeypatch.delenv(var, raising=False)


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Isolate ~/.fp to a temp dir and clear FP_* env that would leak in."""
    monkeypatch.setenv("FP_HOME", str(tmp_path))
    for var in (
        "FP_DASHBOARD_URL",
        "FP_TOKEN",
        # Every env var the app callback reads has to be listed here. A developer with
        # FP_API_KEY exported would otherwise run the whole auth-sensitive
        # suite in API-key mode, and one with FP_ORG exported would send a tenant
        # header the test never asked for — a different suite from CI's either way,
        # passing or failing for a reason invisible in the diff.
        "FP_API_KEY",
        "FP_ORG",
        "FP_JSON",
        # FP_INSECURE was missing from this list for as long as it has existed (it was
        # AGENTEYE_INSECURE then). A developer with it exported ran the entire suite
        # with TLS verification disabled — exactly the invisible-in-the-diff divergence
        # the comment above warns about, in the one variable where it is a security
        # property rather than a formatting one.
        "FP_INSECURE",
        "NO_COLOR",
    ):
        monkeypatch.delenv(var, raising=False)
    return tmp_path


@pytest.fixture
def runner():
    # Click >=8.2 dropped the mix_stderr argument (stdout/stderr are always split).
    try:
        return CliRunner(mix_stderr=False)
    except TypeError:
        return CliRunner()


@pytest.fixture
def logged_in(home):
    """Seed a valid, unexpired session pointing at BASE_URL."""
    config.save_config(
        config.CliConfig(
            base_url=BASE_URL,
            session_token="tok",
            expires_at="2999-01-01T00:00:00Z",
            email="me@test",
            user_id="u1",
        )
    )
    return home
