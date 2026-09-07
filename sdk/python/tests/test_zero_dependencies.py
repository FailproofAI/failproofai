"""This SDK imports nothing outside the standard library, and must not start.

It is installed into other people's agent processes. Every dependency we declare
becomes a version constraint on their application, and a resolver conflict we
cause is one they have to solve — in the observability library, which is the last
place anyone wants to spend an afternoon. "Zero dependencies" is the reason it is
safe to add to an existing project without thinking, so it is a promise rather
than a coincidence, and a promise needs a test.

The framework adapters under `integrations/` are the one exception, and they do
not weaken the promise. Each one imports the framework it adapts — there is no
other way to subclass its callback base class — but they are reached ONLY through
`instrument()`, which resolves them by string through `importlib.import_module`
at call time. So `import failproofai_sdk` still touches nothing outside the
standard library, and an adapter's import can only run in a process where that
framework was already installed and imported. Both halves of that are asserted
below, the second by launching a fresh interpreter rather than by reading source.

The declaration and the code are checked separately because they fail
separately: a stray `import httpx` in a rarely-taken branch is an ImportError in
the user's process at exactly the wrong moment, and an unused `dependencies`
entry drags a package into every install for nothing. CI proves the third case
the source cannot — that the built wheel really installs with `--no-deps`.
"""

from __future__ import annotations

import ast
import sys

import pytest
from pathlib import Path

try:  # Python 3.11+
    import tomllib
except ModuleNotFoundError:  # 3.10 — `tomli` is the same parser, from the dev extra
    # Deliberately not a skip. The manifest assertions below are the enforcement
    # of the zero-dependency promise, and a promise that stops being checked on
    # the oldest interpreter we advertise is checked where it matters least.
    # `tomli` is a TEST dependency; `[project.dependencies]` stays empty, which
    # is the thing actually being promised.
    import tomli as tomllib

import failproofai_sdk

PKG = Path(failproofai_sdk.__file__).resolve().parent
ROOT = PKG.parent
PYPROJECT = ROOT / "pyproject.toml"

#: Everything the package is allowed to import: the standard library, itself, and
#: nothing else. `sys.stdlib_module_names` is the interpreter's own list, so this
#: stays correct across versions instead of being a hand-maintained allowlist.
ALLOWED = set(sys.stdlib_module_names) | {"failproofai_sdk"}


#: Adapters are allowed to import the framework they adapt. Nothing else is, and
#: this set is deliberately explicit rather than "anything under integrations/":
#: a new file added there gets scanned like core code until it is named here.
ADAPTER_IMPORTS = {
    "langchain.py": {"langchain_core", "langgraph"},
    "crewai.py": {"crewai"},
    "llama_index.py": {"llama_index", "llama_index_instrumentation", "pydantic"},
    "pydantic_ai.py": {"pydantic_ai"},
}

#: Framework top-level names that must never appear in `sys.modules` after a bare
#: `import failproofai_sdk`.
FRAMEWORK_ROOTS = {
    "langchain", "langchain_core", "langgraph", "crewai",
    "llama_index", "llama_index_instrumentation", "pydantic", "pydantic_ai",
}


def _module_sources() -> list[Path]:
    return sorted(p for p in PKG.rglob("*.py") if "__pycache__" not in p.parts)


def _allowed_for(path: Path) -> set[str]:
    """What this module may import beyond the standard library."""
    if path.parent.name == "integrations":
        return ALLOWED | ADAPTER_IMPORTS.get(path.name, set())
    return ALLOWED


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
        external = _imported_top_level_modules(path) - _allowed_for(path)
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


#: The only distributions the dev extra may name, each with the reason it is there.
#: This is an allowlist rather than a count, because the failure it prevents is a
#: convenience library drifting in — anything here is one `--extra dev` away from a
#: user's environment, and none of it is covered by the zero-dependency promise.
ALLOWED_DEV_DEPENDENCIES = {
    "pytest": "the test runner",
    "pytest-asyncio": "the adapters are half-async; their scopes are exercised "
                      "under `async with`, which needs an async test runner",
    "tomli": "tomllib's backport; Python 3.10 has no stdlib TOML parser, and "
             "test_zero_dependencies.py must not stop checking the manifest there",
}

#: Extras that exist only to pull a FRAMEWORK in, mapped to the distribution each
#: is allowed to name. The adapter code always ships in the base wheel and lazy-
#: imports, so these gate nothing on our side — they are a convenience for users
#: who do not already have the framework.
FRAMEWORK_EXTRAS = {
    "langchain": {"langchain-core"},
    "langgraph": {"langgraph"},
    "crewai": {"crewai", "onnxruntime"},
    "llamaindex": {"llama-index-core"},
    "pydantic-ai": {"pydantic-ai-slim"},
}


def _named(spec: str) -> str:
    """"crewai>=1.13,<2; python_version < '3.11'" -> "crewai"."""
    head = spec.split(";")[0].strip().split("[")[0]
    for op in ("===", "~=", "!=", ">=", "<=", "==", ">", "<"):
        head = head.split(op)[0]
    return head.strip()


def test_dev_dependencies_are_test_only_and_stay_out_of_the_install():
    """`[project.optional-dependencies].dev` never reaches a plain install."""
    manifest = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    extras = manifest["project"].get("optional-dependencies", {})
    assert set(extras) == {"dev"} | set(FRAMEWORK_EXTRAS), (
        f"unexpected extras: {sorted(set(extras) - {'dev'} - set(FRAMEWORK_EXTRAS))}"
    )

    named = {_named(spec) for spec in extras["dev"]}
    unexpected = named - set(ALLOWED_DEV_DEPENDENCIES)
    assert not unexpected, (
        f"the dev extra grew beyond the test tooling: {sorted(unexpected)}. Each "
        "entry needs a reason in ALLOWED_DEV_DEPENDENCIES, because anything here "
        "is one `--extra dev` away from a user's environment."
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
    # EVERY module, not just `__init__.py`. This read one file and asserted on
    # `ast.Assign` nodes only — and `__init__.py` has none: the writer and the
    # namespace moved to `_runtime.py`, whose own docstring says so. So the set
    # was always empty and `set() <= {...}` could not fail, while the two things
    # it claimed to guard — import-time work added in `_runtime.py` or any other
    # imported module, and a bare expression statement like `os.makedirs(...)`,
    # which is an `ast.Expr` and not an `ast.Assign` — were both invisible to it.
    # Negative-controlled: a planted `mkdir` + `open()` in `_runtime.py` used to
    # leave the whole file green.
    # Each of these is module-level work that IS intended, and each is here
    # deliberately rather than by a pattern that would also admit a `mkdir`:
    #
    #   EventWriter / EventNamespace  the documented cost — starts the flush thread
    #   count                         `itertools.count()` for the batch sequence
    #   register                      `atexit.register(_flush_all_at_exit)`
    #   _Auto                         a sentinel object
    #   getLogger / frozenset / tuple pure, no I/O
    #
    # Adding to this list is the deliberate act. Anything NOT here — a `mkdir`,
    # an `open`, a config read, a request — is paid by every process that
    # imports this package, in someone else's agent, whether or not they ever
    # emit an event.
    allowed = {
        "EventWriter",
        "EventNamespace",
        "count",
        "register",
        "_Auto",
        "getLogger",
        "frozenset",
        "tuple",
    }
    offenders: list[str] = []
    for module in sorted(PKG.glob("*.py")):
        tree = ast.parse(module.read_text(encoding="utf-8"))
        for node in tree.body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                call = node.value
            elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                call = node.value
            else:
                continue
            func = call.func
            name = (
                func.id
                if isinstance(func, ast.Name)
                else (func.attr if isinstance(func, ast.Attribute) else None)
            )
            if name is None or name in allowed:
                continue
            offenders.append(f"{module.name}:{node.lineno}: {name}()")

    assert not offenders, (
        "module-level work runs at `import failproofai_sdk`, in someone else's "
        "agent process, whether or not they ever emit an event:\n  "
        + "\n  ".join(offenders)
    )


# ─────────────────────────────────────────────────────────────────────────────
# The adapters exist, so laziness is now the load-bearing half
# ─────────────────────────────────────────────────────────────────────────────


def test_importing_the_package_loads_no_framework():
    """The promise, asserted at runtime instead of inferred from the source.

    `integrations/` may import frameworks; what must stay true is that nothing
    reaches it unless the caller asks. A fresh interpreter is used because this
    test process has already imported half of everything — checking `sys.modules`
    in-process would pass on the strength of nobody having imported LangChain yet.
    """
    import json
    import subprocess

    probe = (
        "import json, sys; import failproofai_sdk; "
        f"roots = {sorted(FRAMEWORK_ROOTS)!r}; "
        "print(json.dumps(sorted({m.split('.')[0] for m in sys.modules} & set(roots))))"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, cwd=str(ROOT), timeout=60
    )
    assert result.returncode == 0, result.stderr
    loaded = json.loads(result.stdout.strip())
    assert loaded == [], (
        f"`import failproofai_sdk` pulled in {loaded}. The adapters must stay behind "
        "`instrument()`, which resolves them by string at call time — an eager "
        "import here is an ImportError in every process that has not installed "
        "that framework."
    )


def test_importing_the_package_does_not_load_the_evaluator_runtime():
    """Telemetry-only users do not pay for the separate worker surface."""
    import json
    import subprocess

    probe = (
        "import json, sys; import failproofai_sdk; "
        "print(json.dumps(sorted(m for m in sys.modules "
        "if m.startswith('failproofai_sdk.evaluator'))))"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, cwd=str(ROOT), timeout=60
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout.strip()) == []


def test_the_adapter_registry_holds_strings_not_modules():
    """`_REGISTRY` maps a name to a dotted path; importing it here would defeat it."""
    from failproofai_sdk.integrations import _REGISTRY

    assert _REGISTRY, "the adapter registry is empty"
    for name, target in _REGISTRY.items():
        assert isinstance(target, str), f"{name} maps to {type(target).__name__}, not a path"
        assert target.startswith("failproofai_sdk.integrations."), target


def test_instrument_on_a_bare_interpreter_installs_nothing_and_does_not_raise():
    """The realistic first call: no framework installed, `instrument()` anyway.

    It must return an empty result rather than raising — an observability call
    that explodes because the user has not installed LangChain is worse than one
    that does nothing.
    """
    import subprocess

    probe = (
        "import failproofai_sdk as f; r = f.instrument(); "
        "assert r == () or r == [], r; print('ok')"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, cwd=str(ROOT), timeout=60
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


@pytest.mark.parametrize("extra", sorted(FRAMEWORK_EXTRAS), ids=sorted(FRAMEWORK_EXTRAS))
def test_a_framework_extra_names_only_its_own_framework(extra):
    """Each one pulls in a framework and nothing else.

    An extra that quietly added a runtime library would put it in the
    environment of everyone who typed `failproofai-sdk[langchain]`, which is the
    zero-dependency promise leaking out through a side door.
    """
    manifest = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    specs = manifest["project"]["optional-dependencies"][extra]
    assert specs, f"the {extra} extra is empty"
    assert {_named(s) for s in specs} == FRAMEWORK_EXTRAS[extra]


def test_no_extra_refers_back_to_this_package():
    """A self-referential extra is how a package installs something else over itself.

    On public PyPI `agenteye` is the CLI, which is what made this a real hazard
    in the SDK's previous home: `agenteye[langchain]` would have pulled the CLI
    in on top of the SDK. The name is different here; the shape of the mistake is
    not, and there is deliberately no `[all]` either — an extra that installs
    four agent frameworks at once is a resolver problem handed to somebody who
    wanted a telemetry library.
    """
    manifest = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    extras = manifest["project"]["optional-dependencies"]
    assert "all" not in extras
    for name, specs in extras.items():
        for spec in specs:
            assert _named(spec) not in {"failproofai-sdk", "failproofai_sdk", "agenteye"}, (
                f"the {name} extra refers back to this package: {spec!r}"
            )


def test_every_framework_extra_has_an_upper_bound():
    """A ceiling on each, or a clean build a year from now silently stops working.

    The adapters subclass framework callback bases. A new major shifts that API,
    the adapter stops receiving events, and it raises nothing while doing so —
    the failure is an empty dashboard, not a traceback.
    """
    manifest = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    extras = manifest["project"]["optional-dependencies"]
    for name in FRAMEWORK_EXTRAS:
        for spec in extras[name]:
            assert "<" in spec, f"{name}: {spec!r} has no upper bound"
