"""The README ships inside the wheel and IS the PyPI landing page.

Nothing else checks it, and it had rotted before this file existed: it documented
`fp incidents` (renamed to `issues` long ago) and claimed the dashboard URL was
required with no default (there is one). Both would have been the first thing a new
user read.

These tests pin the README's factual claims to the code that implements them.
"""

from __future__ import annotations

import pathlib
import re

from typer.main import get_command

from fp_cli import config, errors
from fp_cli.app import app

README = pathlib.Path(__file__).resolve().parent.parent / "README.md"


def _registered() -> set[str]:
    return set(get_command(app).commands)  # type: ignore[attr-defined]


def _readme() -> str:
    return README.read_text(encoding="utf-8")


def test_readme_exists_and_is_substantial():
    """Guards every assertion below from passing vacuously on a missing file."""
    assert README.is_file(), f"{README} is missing — it ships in the wheel"
    assert len(_readme()) > 2000


def test_every_command_the_readme_documents_actually_exists():
    text = _readme()
    documented = set(re.findall(r"^fp ([a-z][a-z-]*)\b", text, re.M))
    documented |= set(re.findall(r"`fp ([a-z][a-z-]*)[ `]", text))
    # Global flags and shell noise are not commands.
    documented = {d for d in documented if not d.startswith("-")}
    unknown = documented - _registered()
    assert not unknown, (
        f"the README documents commands that do not exist: {sorted(unknown)} "
        f"(registered: {sorted(_registered())})"
    )


def test_the_readme_install_instructions_name_the_distribution_not_the_command():
    """`pip install fp` installs somebody else's package. The dist is `fp-cli`."""
    text = _readme()
    bad = re.findall(r"(?:pipx|pip|uv tool) install fp(?![-\w])", text)
    assert not bad, f"install instructions must say fp-cli, not fp: {bad}"


def test_the_documented_default_base_url_is_the_real_one():
    assert config.DEFAULT_BASE_URL in _readme(), (
        f"README does not mention the real default base URL {config.DEFAULT_BASE_URL}"
    )


def test_the_readme_exit_code_table_matches_the_error_classes():
    """The exit codes are a public scripting contract, restated in four places."""
    text = _readme()
    table = dict(
        (int(code), meaning.strip())
        for code, meaning in re.findall(r"^\|\s*(\d)\s*\|\s*([^|]+)\|", text, re.M)
    )
    assert table, "no exit-code table found in the README"
    actual = {
        e.exit_code
        for e in vars(errors).values()
        if isinstance(e, type)
        and issubclass(e, Exception)
        and isinstance(getattr(e, "exit_code", None), int)
    }
    documented = set(table)
    missing = actual - documented
    assert not missing, f"exit codes raised by the CLI but undocumented: {sorted(missing)}"
    assert 0 in documented, "the README must document exit code 0"


def test_the_readme_does_not_link_private_repo_paths():
    """This README is published to PyPI; enterprise-docs/ is a private-repo path."""
    text = _readme()
    for needle in ("enterprise-docs/", "agenteye-enterprise/", "github.com/agenteye"):
        assert needle not in text, f"private path {needle!r} must not ship in a public README"


def test_the_readme_documents_only_env_vars_the_cli_reads():
    """A documented-but-unread env var is worse than an undocumented one: the user
    sets it, nothing happens, and there is no error to search for."""
    import fp_cli

    pkg = pathlib.Path(fp_cli.__file__).resolve().parent
    source = "\n".join(p.read_text(encoding="utf-8") for p in pkg.rglob("*.py"))
    documented = set(re.findall(r"`(FP_[A-Z_]+)`", _readme()))
    assert documented, "the README documents no FP_* env vars — did the table move?"
    unread = {v for v in documented if f'"{v}"' not in source}
    assert not unread, f"README documents env vars the CLI never reads: {sorted(unread)}"
