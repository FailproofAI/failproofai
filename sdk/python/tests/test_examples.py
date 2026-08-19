"""The shipped quickstarts are the plug-in UX, so they are code under test.

`examples/*.py` is what somebody runs in the first five minutes. Nothing else
exercises them — they need a framework and an API key, so they cannot run in
unit CI — which is exactly why they need a guard that does not.

What is checked here is everything checkable without a model: that they parse,
that they call API this package actually exports, that each imports only the
framework its own extra installs, and that they demonstrate the ergonomics they
exist to demonstrate rather than the manual identity path they replace.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

import failproofai_sdk

EXAMPLES = Path(failproofai_sdk.__file__).resolve().parent.parent / "examples"

#: quickstart -> the extra that installs what it imports.
QUICKSTARTS = {
    "langgraph_quickstart.py": {"langchain_core", "langgraph", "langchain_openai"},
    "crewai_quickstart.py": {"crewai"},
    "llamaindex_quickstart.py": {"llama_index"},
    "pydantic_ai_quickstart.py": {"pydantic_ai"},
}


def _paths() -> list[Path]:
    return sorted(p for p in EXAMPLES.glob("*.py"))


def _imports(tree: ast.AST) -> set[str]:
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            out.add(node.module.split(".")[0])
    return out


def test_there_is_a_quickstart_for_every_adapter():
    """A framework with an adapter and no quickstart is one nobody will find."""
    from failproofai_sdk.integrations import _REGISTRY

    assert len(QUICKSTARTS) == len(_REGISTRY), (
        f"{len(_REGISTRY)} adapters but {len(QUICKSTARTS)} quickstarts — "
        f"adapters: {sorted(_REGISTRY)}"
    )
    assert {p.name for p in _paths()} == set(QUICKSTARTS)


@pytest.mark.parametrize("name", sorted(QUICKSTARTS))
def test_a_quickstart_parses(name):
    ast.parse((EXAMPLES / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", sorted(QUICKSTARTS))
def test_a_quickstart_imports_only_its_own_framework(name):
    """Borrowing a second framework turns a quickstart into an install problem."""
    tree = ast.parse((EXAMPLES / name).read_text(encoding="utf-8"))
    external = _imports(tree) - {"failproofai_sdk", "os", "asyncio"}
    unexpected = external - QUICKSTARTS[name]
    assert not unexpected, f"{name} imports {sorted(unexpected)}"


@pytest.mark.parametrize("name", sorted(QUICKSTARTS))
def test_a_quickstart_calls_api_this_package_exports(name):
    """A rename in the SDK must break the examples here, not in someone's terminal."""
    source = (EXAMPLES / name).read_text(encoding="utf-8")
    called = {
        node.func.attr
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "failproofai_sdk"
    }
    assert called, f"{name} never calls failproofai_sdk.*"
    missing = {c for c in called if not hasattr(failproofai_sdk, c)}
    assert not missing, f"{name} calls failproofai_sdk.{missing} which does not exist"


@pytest.mark.parametrize("name", sorted(QUICKSTARTS))
def test_a_quickstart_demonstrates_the_ergonomics_it_exists_for(name):
    """`instrument()` plus a `session()`, and no identity threaded by hand.

    A quickstart that passes `session_id=` everywhere teaches the manual path the
    adapters were built to remove, and is how the reference integration ended up
    being a wrapper customers pasted into their own code.
    """
    source = (EXAMPLES / name).read_text(encoding="utf-8")
    assert "failproofai_sdk.instrument()" in source, f"{name} never instruments"
    assert "failproofai_sdk.session()" in source, f"{name} never opens a session"
    assert "session_id=" not in source, (
        f"{name} threads session_id by hand — that is the path the scopes replace"
    )


@pytest.mark.parametrize("name", sorted(QUICKSTARTS))
def test_a_quickstart_names_the_extra_that_installs_it(name):
    """The first line somebody runs. A wrong extra is a 5-minute dead end."""
    try:  # Python 3.11+
        import tomllib
    except ModuleNotFoundError:
        import tomli as tomllib

    source = (EXAMPLES / name).read_text(encoding="utf-8")
    assert "pip install" in source, f"{name} does not say how to install it"

    manifest = tomllib.loads(
        (EXAMPLES.parent / "pyproject.toml").read_text(encoding="utf-8")
    )
    extras = set(manifest["project"]["optional-dependencies"])
    named = {
        line.split("failproofai-sdk[")[1].split("]")[0]
        for line in source.splitlines()
        if "failproofai-sdk[" in line
    }
    assert named, f"{name} does not name a failproofai-sdk extra"
    assert named <= extras, f"{name} names a non-existent extra: {sorted(named - extras)}"
