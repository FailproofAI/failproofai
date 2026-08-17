"""This SDK imports nothing outside the standard library, and must not start.

It is installed into other people's agent processes. Every dependency we declare
becomes a version constraint on their application, and a resolver conflict we
cause is one they have to solve — in the observability library, which is the last
place anyone wants to spend an afternoon. "Zero dependencies" is the reason it is
safe to add to an existing project without thinking, so it is a promise rather
than a coincidence, and a promise needs a test.

The declaration and the code are checked separately because they fail
separately: a stray `import httpx` in a rarely-taken branch is an ImportError in
the user's process at exactly the wrong moment, and an unused `dependencies`
entry drags a package into every install for nothing. CI proves the third case
the source cannot — that the built wheel really installs with `--no-deps`.
"""

from __future__ import annotations

import ast
import sys
import tomllib
from pathlib import Path

import failproofai_sdk

PKG = Path(failproofai_sdk.__file__).resolve().parent
ROOT = PKG.parent
PYPROJECT = ROOT / "pyproject.toml"

#: Everything the package is allowed to import: the standard library, itself, and
#: nothing else. `sys.stdlib_module_names` is the interpreter's own list, so this
#: stays correct across versions instead of being a hand-maintained allowlist.
ALLOWED = set(sys.stdlib_module_names) | {"failproofai_sdk"}


def _module_sources() -> list[Path]:
    return sorted(p for p in PKG.rglob("*.py") if "__pycache__" not in p.parts)


def _imported_top_level_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            # A relative import (`from . import x`) has level > 0 and no external
            # module to check.
            if node.level == 0 and node.module:
                modules.add(node.module.split(".")[0])
    return modules


def test_the_package_imports_only_the_standard_library():
    """Including imports inside functions, which `ast.walk` reaches too.

    `_environment.get_environment` really does `import os` inside the function
    body, so a check that only read module-level imports would miss a whole class
    of dependency — the deferred one somebody adds to keep import time down.
    """
    offenders: dict[str, set[str]] = {}
    for path in _module_sources():
        external = _imported_top_level_modules(path) - ALLOWED
        if external:
            offenders[path.name] = external

    assert not offenders, (
        f"the SDK imports non-stdlib modules: {offenders}. This package is "
        "installed into other people's agent processes, where every dependency "
        "we add is a constraint they have to satisfy. If one is genuinely "
        "unavoidable, it needs a deliberate decision and a `dependencies` entry — "
        "not an import that fails at runtime in a branch CI never took."
    )


def test_the_scan_found_the_modules_it_was_meant_to_scan():
    """Guards against the check above passing because it read nothing."""
    names = {p.name for p in _module_sources()}
    assert {"_writer.py", "_events.py", "_schema.py", "_resolver.py"} <= names, (
        f"the package walk found only {sorted(names)}"
    )


def test_no_runtime_dependencies_are_declared():
    """The manifest half of the same promise."""
    manifest = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    declared = manifest["project"].get("dependencies", [])
    assert declared == [], (
        f"pyproject declares runtime dependencies: {declared}. Installing this "
        "SDK must not pull anything in."
    )


def test_dev_dependencies_are_test_only_and_stay_out_of_the_install():
    """`[project.optional-dependencies].dev` never reaches a plain install."""
    manifest = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    extras = manifest["project"].get("optional-dependencies", {})
    assert set(extras) == {"dev"}, f"unexpected extras: {sorted(extras)}"
    assert all(spec.startswith("pytest") for spec in extras["dev"]), (
        f"the dev extra grew beyond the test runner: {extras['dev']}. Anything "
        "here is one `--extra dev` away from a user's environment."
    )


def test_the_package_declares_itself_typed():
    """`py.typed` must ship, or the annotations are invisible to a type checker."""
    assert (PKG / "py.typed").is_file()
    manifest = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    package_data = manifest["tool"]["setuptools"]["package-data"]
    assert "py.typed" in package_data["failproofai_sdk"], (
        "py.typed exists on disk but is not in [tool.setuptools.package-data], so "
        "it is absent from the built wheel — where it is the only thing that "
        "makes the type hints count."
    )


def test_importing_the_package_does_not_touch_the_network_or_the_filesystem_eagerly():
    """Import must be cheap and side-effect-light beyond starting the flush thread.

    Constructing `EventWriter` at module scope already starts a daemon thread,
    which is a documented cost. Creating directories or reading config at import
    time would be a further one, paid by every process that imports the package
    whether or not it emits anything.
    """
    source = (PKG / "__init__.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    module_level_calls = [
        node
        for node in tree.body
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)
    ]
    called = {
        node.value.func.id
        for node in module_level_calls
        if isinstance(node.value.func, ast.Name)
    }
    assert called <= {"EventWriter", "EventNamespace"}, (
        f"__init__ gained module-level construction of {sorted(called - {'EventWriter', 'EventNamespace'})}. "
        "Import-time work is paid by every process that imports this package."
    )
