"""Packaging contracts, read from `importlib.metadata` — never from pyproject.

Two reasons this file never opens `pyproject.toml`:

1. `tomllib` is 3.11+ and this SDK's floor is 3.10, so parsing it here would
   make the packaging tests skip exactly on the leg that catches 3.10 problems.
2. `pyproject.toml` is the *input*. What ships is the wheel's `METADATA`, and
   the failure mode these tests exist to catch — an extra that silently drags
   the wrong `failproofai_sdk` off PyPI — happens at install time, from METADATA.

The rules being enforced:

* **zero runtime dependencies.** `import failproofai_sdk` must work in an environment
  with nothing else installed, so every `Requires-Dist` carries an
  `extra == "..."` marker.
* **no self-referential extra.** On public PyPI `failproofai_sdk` is the *CLI*; a
  `Requires-Dist: failproofai_sdk[...]` would install the CLI over this SDK. This is
  also why the adapters ship as extras on one distribution rather than as
  `failproofai_sdk-langgraph` and friends.
* **no `[all]` extra** — a resolution bomb that exists only for CI's
  convenience.
* **the extras and the adapter registry agree.** They are two hand-maintained
  lists of the same set, in two files, with no codegen between them.
"""

import re
import os
import subprocess
from pathlib import Path

import failproofai_sdk
import sys
import textwrap

import importlib.metadata as metadata

import pytest

from failproofai_sdk import integrations

DIST = "failproofai_sdk"


def requirements() -> list[str]:
    return list(metadata.requires(DIST) or [])


def declared_extras() -> set[str]:
    return set(metadata.distribution(DIST).metadata.get_all("Provides-Extra") or [])


def test_the_distribution_is_installed():
    # Guards every other test in this file: `requires()` returns None for a
    # dist that is not installed, and `for req in []` passes vacuously.
    assert metadata.version(DIST)
    assert requirements()


def test_every_requirement_is_gated_behind_an_extra():
    ungated = [req for req in requirements() if "extra ==" not in req]
    assert ungated == [], (
        "failproofai_sdk must have ZERO runtime dependencies; these would be installed "
        f"unconditionally: {ungated}"
    )


#: Names a requirement here must never be. `failproofai-sdk` is self-reference —
#: `pip install failproofai-sdk[langchain]` resolving through an extra back onto
#: this distribution. `agenteye` is the RETIRED distribution: on public PyPI that
#: name is the CLI, so pinning it would install the CLI over the SDK.
_FORBIDDEN_REQUIREMENT_NAMES = frozenset({"failproofai-sdk", "agenteye"})


def test_no_requirement_names_the_retired_distribution():
    """Both sides normalized, which is the whole point.

    This compared a dash-normalized name against `DIST`, which keeps its
    UNDERSCORE — so `"failproofai-sdk" != "failproofai_sdk"` was true for every
    possible input and the assertion could not fail. Negative-controlled: a
    planted `failproofai-sdk[langchain]; extra == "all"` used to pass.
    """
    for req in requirements():
        name = re.split(r"[\s\[<>=!~;(]", req.strip(), maxsplit=1)[0]
        assert name.lower().replace("_", "-") not in _FORBIDDEN_REQUIREMENT_NAMES, (
            f"requirement {req!r} names a distribution that must never appear here: "
            "self-reference resolves an extra back onto this package, and `agenteye` "
            "is the CLI on public PyPI, so either would install something else over "
            "the SDK"
        )


def test_there_is_no_all_extra():
    assert "all" not in declared_extras()


def test_every_extra_maps_to_a_registered_adapter():
    for extra in declared_extras() - {"dev"}:
        # Raises ValueError if the extra is not a name (or alias) the registry
        # knows — i.e. an extra nobody can instrument.
        assert integrations._canonical(extra) in integrations.available()


def test_every_registered_adapter_has_an_extra():
    covered = {integrations._canonical(extra) for extra in declared_extras() - {"dev"}}
    assert covered == set(integrations.available())


def test_every_extra_requirement_pins_a_floor_and_a_ceiling():
    # Without a ceiling, a clean build a year from now pulls the next major, the
    # callback API shifts, and the adapter stops receiving events while raising
    # nothing at all.
    for req in requirements():
        if 'extra == "dev"' in req:
            continue
        assert ">=" in req, f"{req} has no floor"
        assert "<" in req, f"{req} has no ceiling"


IMPORT_GUARD = textwrap.dedent(
    """
    import sys

    baseline = set(sys.modules)
    import failproofai_sdk

    added = set(sys.modules) - baseline
    third_party = sorted(
        name for name in added
        if name.split(".")[0] not in sys.stdlib_module_names
        and not name.startswith("failproofai_sdk")
    )
    integrations = sorted(n for n in sys.modules if n.startswith("failproofai_sdk.integrations"))

    assert not third_party, "import failproofai_sdk pulled in third-party modules: %r" % third_party
    assert not integrations, "import failproofai_sdk imported the adapters: %r" % integrations
    assert failproofai_sdk._writer is not sys.modules["failproofai_sdk._writer"], "_writer is the module"
    print("OK")
    """
)


def test_importing_the_package_stays_clean(tmp_path):
    """A subprocess, because the assertion is about a *cold* interpreter.

    In-process, every framework any other test file imported is already in
    `sys.modules` and the check is vacuous.
    """
    # `cwd=tmp_path` is what makes the interpreter cold — away from the source
    # tree, so nothing is importable by accident. PYTHONPATH then puts the
    # package back deliberately, which is what lets this run in an environment
    # where it is not pip-installed (a container running the suite off a mounted
    # checkout). Without it the test does not fail loudly, it fails with
    # ModuleNotFoundError and looks like a packaging bug that is not there.
    env = dict(os.environ, PYTHONPATH=str(Path(failproofai_sdk.__file__).resolve().parents[1]))
    result = subprocess.run(
        [sys.executable, "-c", IMPORT_GUARD],
        capture_output=True,
        text=True,
        cwd=str(tmp_path),
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout


def test_instrument_is_lazy_until_it_is_called():
    # `failproofai_sdk.instrument` is a thin wrapper whose import sits *inside* the
    # function body; the guard test above proves the module-level import is
    # absent, this proves the wrapper still exists to be called.
    assert callable(sdk_instrument())


def sdk_instrument():
    import failproofai_sdk

    return failproofai_sdk.instrument


@pytest.mark.parametrize("name", ["langchain", "crewai", "llama_index", "pydantic_ai"])
def test_the_registry_points_at_a_module_inside_this_package(name):
    path = integrations._REGISTRY[name]
    assert path.startswith("failproofai_sdk.integrations.")
    # The registry entry is a STRING, imported on demand. If this ever becomes a
    # module object, `import failproofai_sdk` stops being zero-dependency.
    assert isinstance(path, str)
