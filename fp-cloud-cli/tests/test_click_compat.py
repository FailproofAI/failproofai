"""Guard the contract that ``fp_cli/_click_compat.py`` exists to hold.

Typer 0.26 vendored Click and now catches only *its* Click's exceptions. Every way
that coupling breaks is silent — the CLI imports, compiles, and passes every happy
path while typed errors exit 1 with an empty stderr and the telemetry flag catalog
quietly empties. These are the alarms.
"""

from __future__ import annotations

import ast
import pathlib

import pytest
import typer
from typer.testing import CliRunner

from fp_cli import _click_compat, analytics_registry
from fp_cli.errors import ForbiddenError, KeyModeUnsupportedError, NotFoundError

_PACKAGE = pathlib.Path(__file__).resolve().parent.parent / "fp_cli"


def test_the_package_scan_actually_has_something_to_scan():
    """`_PACKAGE` is a path literal, so a package rename makes it point at nothing.

    Every scanning test below then walks an empty directory, finds zero violations and
    passes — the guard silently stops guarding. This is the tripwire for that: it caught
    nothing during the agenteye -> fp_cli rename only because the literal was updated in
    the same pass, which is exactly the kind of thing that is remembered once.
    """
    assert _PACKAGE.is_dir(), f"{_PACKAGE} does not exist — the scanning tests are vacuous"
    modules = list(_PACKAGE.rglob("*.py"))
    assert len(modules) > 20, (
        f"only {len(modules)} modules found under {_PACKAGE}; the scan is not seeing the package"
    )


def _click_imports(path: pathlib.Path) -> list[str]:
    """Every direct `import click` / `from click import …` in one module."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            hits += [a.name for a in node.names if a.name == "click" or a.name.startswith("click.")]
        elif isinstance(node, ast.ImportFrom):
            if node.module and (node.module == "click" or node.module.startswith("click.")):
                hits.append(node.module)
    return hits


def test_package_never_imports_click_directly():
    """The pip `click` distribution is not necessarily the Click Typer is running.

    Binding to it directly is the whole bug: `raise click.UsageError(...)` from the wrong
    Click is not caught by Typer's runner, so a clean exit-2 usage error becomes exit 1 with
    nothing on stderr. `_click_compat` is the only module allowed to name `click`.
    """
    offenders = {
        str(path.relative_to(_PACKAGE)): names
        for path in sorted(_PACKAGE.rglob("*.py"))
        if path.name != "_click_compat.py" and (names := _click_imports(path))
    }
    assert not offenders, (
        f"import Click via `from . import _click_compat as click`, not directly: {offenders}"
    )


def test_typed_errors_reach_typers_handler():
    """A typed error must still be *caught* by Typer: its message on stderr, its exit code.

    Asserted through a real command run rather than an isinstance check, because what matters
    is the runner's behaviour — which is what silently changed under typer 0.26.
    """
    app = typer.Typer()

    @app.command()
    def boom() -> None:
        raise ForbiddenError("nope", hint="ask an admin")

    result = CliRunner().invoke(app, [])
    assert result.exit_code == 5, result.output  # not 1: uncaught would collapse to 1
    assert "nope" in result.output


def test_error_exit_codes_are_distinct_per_class():
    """The exit-code contract is documented in `--help` and scripted against."""
    assert ForbiddenError("x").exit_code == 5
    assert NotFoundError("x").exit_code == 6
    # Key mode reuses exit 2 rather than adding a seventh code — the table is a scripted
    # contract restated in `app.py`, `cli/skill/SKILL.md` and `enterprise-docs/cli.md`.
    assert KeyModeUnsupportedError("x").exit_code == 2
    assert issubclass(ForbiddenError, _click_compat.ClickException)
    # Through the shim, not pip Click: bind it to the wrong Click and every key-mode
    # refusal escapes uncaught as exit 1 with an empty stderr.
    assert issubclass(KeyModeUnsupportedError, _click_compat.ClickException)


def test_every_symbol_comes_from_the_click_typer_runs():
    """No symbol may quietly come from pip Click while Typer is running its own.

    This is the alarm for a *partial* miss. `_click_compat` used to wrap the whole
    vendored import in one `try: … except ImportError: from click import …`, so a single
    name disappearing from `typer._click` rebound **all six** symbols to pip Click — and
    that is not hypothetical: typer 0.27.2 moved `Abort` out of
    `typer._click.exceptions`, and the fallback fired, and 105 tests went red at once
    with typed errors collapsing to exit 1. Assert the provenance of each symbol
    separately, so the next move is one failure naming one symbol.
    """
    typer_click = pytest.importorskip(
        "typer._click", reason="typer < 0.26 has no vendored Click; pip click IS the right one"
    )
    wrong = {
        name: obj.__module__
        for name in ("ClickException", "UsageError", "BadParameter", "Command", "Parameter")
        if not (obj := getattr(_click_compat, name)).__module__.startswith(typer_click.__name__)
    }
    assert not wrong, f"these came from pip Click, not the Click Typer runs: {wrong}"


def test_abort_is_the_one_typer_raises():
    """`Abort` is the exception NOT to pin to a Click — pin it to Typer.

    It is `click.Abort` before typer 0.26, the vendored class through 0.27.1, and a
    plain `typer.exceptions.Abort(RuntimeError)` from 0.27.2 on. `typer.Abort` is the
    class `typer.prompt` raises and typer's own `_main` catches on every one of those,
    which is the only thing `select.py`'s `except click.Abort` needs to be true.
    """
    assert _click_compat.Abort is typer.Abort


def test_hand_raised_usage_errors_reach_typers_handler():
    """The other half of the contract: `UsageError`/`BadParameter` we raise ourselves.

    `test_typed_errors_reach_typers_handler` covers the `ClickException` subclasses in
    `errors.py`; these two are raised directly through the shim (`raise
    click.UsageError(...)`) from a dozen call sites, and bound to the wrong Click they
    escape uncaught the same way — exit 1, empty stderr, instead of a clean exit 2.
    """
    for exc_class in (_click_compat.UsageError, _click_compat.BadParameter):
        app = typer.Typer()

        @app.command()
        def boom() -> None:
            raise exc_class("bad input")

        result = CliRunner().invoke(app, [])
        assert result.exit_code == 2, (exc_class, result.output)
        assert "bad input" in result.output


def test_is_option_recognises_typer_options():
    """Typer's vendored Click has no `Option` class, so `isinstance` cannot answer this.

    If a future Click stops setting `param_type_name`, this fails loudly instead of quietly
    dropping every flag from the telemetry catalog.
    """
    from typer.main import get_command

    from fp_cli.app import app as real_app

    params = get_command(real_app).params
    assert params, "the root command should declare the global options"
    assert any(_click_compat.is_option(p) for p in params)
    assert all(not _click_compat.is_option(p) for p in params if p.param_type_name == "argument")


def test_flag_catalog_is_populated():
    """The catalog is derived by walking the real command tree; empty means the walk broke."""
    _known, _leaves, flags, value_flags = analytics_registry.build()
    assert "--json" in flags and "--base-url" in value_flags
    assert len(flags) > 50, f"flag catalog collapsed to {len(flags)} entries"
