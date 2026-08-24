"""`docs/` is the integration surface, so it is code under test.

The guide and the runnable code live together — one directory per framework,
each holding the README somebody reads and the `examples/` they run:

    docs/
      README.md              the index
      _shared/               cosmetics for the examples; never part of the SDK
      manual/                no framework, raw scopes + event.*
      langgraph/  crewai/  llama_index/  pydantic_ai/
        README.md            the guide
        examples/*.py        runnable, and run before shipping

Nothing here checks prose. It checks the three ways a docs tree rots without
anybody noticing: a framework gains an adapter and never gains a page, a page or
an example names an API that no longer exists, and an example drifts into
teaching the manual identity path the scopes replaced.

The examples themselves need a framework and an API key, so they cannot run in
unit CI — which is exactly why they need a guard that does not.
"""
from __future__ import annotations

import ast
import re
import textwrap
from pathlib import Path

import pytest

import failproofai_sdk

DOCS = Path(failproofai_sdk.__file__).resolve().parent.parent / "docs"

#: adapter registry name -> the directory that documents it.
#: `langgraph` is the directory for the `langchain` adapter: it is the spelling
#: people search for, and the adapter serves both.
ADAPTER_DIRS = {
    "langchain": "langgraph",
    "crewai": "crewai",
    "llama_index": "llama_index",
    "pydantic_ai": "pydantic_ai",
}

#: directory -> the failproofai-sdk extra its guide must name.
DIR_EXTRA = {
    "langgraph": "langgraph",
    "crewai": "crewai",
    "llama_index": "llamaindex",
    "pydantic_ai": "pydantic-ai",
}

#: directory -> third-party modules its examples may import. `manual/` maps to
#: the openai client and nothing else: it is the "no framework" path, so
#: borrowing one would defeat the point of it.
DIR_IMPORTS = {
    "langgraph": {"langchain_core", "langgraph", "langchain_openai"},
    "crewai": {"crewai"},
    "llama_index": {"llama_index"},
    "pydantic_ai": {"pydantic_ai", "pydantic"},
    "manual": {"openai"},
}

#: stdlib and local helpers every example may import. `_shared` is the trace
#: printer and is explicitly not part of the SDK surface.
ALWAYS_ALLOWED = {"failproofai_sdk", "_shared", "os", "sys", "json", "asyncio", "pathlib"}

ALL_DIRS = sorted(DIR_IMPORTS)


def _guides() -> list[Path]:
    """The framework guides. `_shared/README.md` documents the trace printer,
    which is cosmetics rather than an integration, so it is not one of these."""
    return sorted((DOCS / d / "README.md") for d in ALL_DIRS)


def _examples() -> list[Path]:
    return sorted(p for d in ALL_DIRS for p in (DOCS / d / "examples").glob("*.py"))


EXAMPLES = _examples()
EXAMPLE_IDS = [f"{p.parents[1].name}/{p.name}" for p in EXAMPLES]


def _imports(tree: ast.AST) -> set[str]:
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            out.add(node.module.split(".")[0])
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Shape
# ─────────────────────────────────────────────────────────────────────────────


def test_the_docs_tree_exists():
    assert DOCS.is_dir(), f"{DOCS} is missing"
    assert (DOCS / "README.md").is_file(), "docs/README.md — the index — is missing"


def test_there_is_a_directory_for_every_adapter():
    """An adapter with no guide is one nobody will find."""
    from failproofai_sdk.integrations import _REGISTRY

    assert set(ADAPTER_DIRS) == set(_REGISTRY), (
        f"adapters {sorted(_REGISTRY)} but guides for {sorted(ADAPTER_DIRS)}"
    )
    for adapter, directory in ADAPTER_DIRS.items():
        assert (DOCS / directory).is_dir(), f"{adapter} has no docs/{directory}/"


def test_every_documented_directory_is_accounted_for():
    """A directory nobody links to is a directory nobody maintains."""
    found = {p.name for p in DOCS.iterdir() if p.is_dir() and p.name != "_shared"}
    assert found == set(ALL_DIRS)


@pytest.mark.parametrize("directory", ALL_DIRS)
def test_a_directory_has_a_guide_and_examples(directory):
    assert (DOCS / directory / "README.md").is_file(), f"{directory}/README.md missing"
    examples = list((DOCS / directory / "examples").glob("*.py"))
    assert examples, f"{directory}/examples/ has no runnable code"


@pytest.mark.parametrize("directory", ALL_DIRS)
def test_a_directory_has_a_quickstart(directory):
    """`quickstart.py` is the fixed entry point every guide links to."""
    assert (DOCS / directory / "examples" / "quickstart.py").is_file()


@pytest.mark.parametrize("directory", ALL_DIRS)
def test_a_directory_has_more_than_a_quickstart(directory):
    """A quickstart alone never shows a multi-event flow, which is the point."""
    assert len(list((DOCS / directory / "examples").glob("*.py"))) >= 2


def test_the_index_links_to_every_directory():
    index = (DOCS / "README.md").read_text(encoding="utf-8")
    for directory in ALL_DIRS:
        assert f"{directory}/" in index, f"docs/README.md never links to {directory}/"


# ─────────────────────────────────────────────────────────────────────────────
# The guides
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("guide", _guides(), ids=lambda p: p.parent.name)
def test_a_guide_only_names_api_this_package_exports(guide):
    """A rename in the SDK must break this test, not somebody's copy-paste."""
    text = guide.read_text(encoding="utf-8")
    referenced = set(re.findall(r"failproofai_sdk\.([a-z_]+)\s*\(", text)) - {"event"}
    missing = {name for name in referenced if not hasattr(failproofai_sdk, name)}
    assert not missing, f"{guide.parent.name} names failproofai_sdk.{missing}, which does not exist"


@pytest.mark.parametrize("guide", _guides(), ids=lambda p: p.parent.name)
def test_a_guide_only_names_event_methods_that_exist(guide):
    text = guide.read_text(encoding="utf-8")
    referenced = set(re.findall(r"failproofai_sdk\.event\.([a-z_]+)\s*\(", text))
    missing = {n for n in referenced if not hasattr(failproofai_sdk.event, n)}
    assert not missing, f"{guide.parent.name} names event.{missing}, which does not exist"


@pytest.mark.parametrize("guide", _guides() + [DOCS / "README.md"], ids=lambda p: str(p.parent.name or "index"))
def test_a_guide_only_names_extras_that_exist(guide):
    """A wrong extra in an install line is a five-minute dead end."""
    try:  # Python 3.11+
        import tomllib
    except ModuleNotFoundError:
        import tomli as tomllib

    manifest = tomllib.loads((DOCS.parent / "pyproject.toml").read_text(encoding="utf-8"))
    extras = set(manifest["project"]["optional-dependencies"])
    named = set(re.findall(r"failproofai-sdk\[([a-z-]+)\]", guide.read_text(encoding="utf-8")))
    assert named <= extras, f"{guide} names non-existent extras: {sorted(named - extras)}"


@pytest.mark.parametrize("directory,extra", sorted(DIR_EXTRA.items()))
def test_a_framework_guide_names_its_own_extra(directory, extra):
    text = (DOCS / directory / "README.md").read_text(encoding="utf-8")
    assert "pip install" in text, f"{directory} never says how to install it"
    assert f"failproofai-sdk[{extra}]" in text, f"{directory} does not name the {extra!r} extra"


@pytest.mark.parametrize("directory", sorted(DIR_EXTRA))
def test_a_framework_guide_shows_instrument_and_a_session(directory):
    text = (DOCS / directory / "README.md").read_text(encoding="utf-8")
    assert "failproofai_sdk.instrument(" in text, f"{directory} never shows instrument()"
    assert "failproofai_sdk.session()" in text, f"{directory} never shows a session"


@pytest.mark.parametrize("guide", _guides(), ids=lambda p: p.parent.name)
def test_a_guide_links_to_the_examples_it_documents(guide):
    """A guide describing a file that does not exist is worse than no guide."""
    text = guide.read_text(encoding="utf-8")
    linked = set(re.findall(r"\(examples/([\w.]+\.py)\)", text))
    on_disk = {p.name for p in (guide.parent / "examples").glob("*.py")}
    assert linked, f"{guide.parent.name} links to none of its examples"
    assert linked <= on_disk, f"{guide.parent.name} links to missing {sorted(linked - on_disk)}"


def test_the_manual_guide_does_not_teach_instrument():
    """`manual/` is the no-adapter path; showing instrument() there is a slip.

    Scoped to the part of the page that teaches the manual API — the section on
    unsupported frameworks legitimately contrasts the two.
    """
    text = (DOCS / "manual" / "README.md").read_text(encoding="utf-8")
    body = text.split("## Instrumenting an unsupported framework")[0]
    assert "failproofai_sdk.instrument()" not in body


def test_the_index_lists_every_event_type():
    """The event matrix is the index's whole value; a missing row is a silent gap."""
    from failproofai_sdk._events import EventNamespace

    text = (DOCS / "README.md").read_text(encoding="utf-8")
    methods = [
        n for n in vars(EventNamespace)
        if not n.startswith("_") and callable(getattr(EventNamespace, n))
    ]
    missing = [m for m in methods if m not in text]
    assert not missing, f"docs/README.md does not mention {missing}"


# ─────────────────────────────────────────────────────────────────────────────
# The examples
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("path", EXAMPLES, ids=EXAMPLE_IDS)
def test_an_example_parses(path):
    ast.parse(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("path", EXAMPLES, ids=EXAMPLE_IDS)
def test_an_example_imports_only_its_own_framework(path):
    """Borrowing a second framework turns an example into an install problem."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    allowed = ALWAYS_ALLOWED | DIR_IMPORTS[path.parents[1].name]
    unexpected = _imports(tree) - allowed
    assert not unexpected, f"{path.parents[1].name}/{path.name} imports {sorted(unexpected)}"


@pytest.mark.parametrize("path", EXAMPLES, ids=EXAMPLE_IDS)
def test_an_example_calls_api_this_package_exports(path):
    called = {
        node.func.attr
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "failproofai_sdk"
    }
    assert called, f"{path.name} never calls failproofai_sdk.*"
    missing = {c for c in called if not hasattr(failproofai_sdk, c)}
    assert not missing, f"{path.name} calls failproofai_sdk.{missing} which does not exist"


@pytest.mark.parametrize("path", EXAMPLES, ids=EXAMPLE_IDS)
def test_an_example_does_not_thread_identity_by_hand(path):
    """`session_id=` everywhere teaches the path the scopes were built to remove.

    Checked over the AST rather than the raw text, so an example is free to
    *explain* `session_id=` in its docstring — which the manual quickstart has
    to, since explaining what the scopes replace is its whole job.
    """
    threaded = [
        node
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
        if isinstance(node, ast.Call)
        for kw in node.keywords
        if kw.arg in ("session_id", "agent_id")
    ]
    assert not threaded, (
        f"{path.parents[1].name}/{path.name} passes session_id/agent_id by hand"
    )


@pytest.mark.parametrize("path", EXAMPLES, ids=EXAMPLE_IDS)
def test_an_example_opens_a_session(path):
    source = path.read_text(encoding="utf-8")
    assert "failproofai_sdk.session()" in source, f"{path.name} never opens a session"


@pytest.mark.parametrize(
    "path",
    [p for p in EXAMPLES if p.parents[1].name != "manual"],
    ids=[i for i in EXAMPLE_IDS if not i.startswith("manual/")],
)
def test_a_framework_example_instruments(path):
    source = path.read_text(encoding="utf-8")
    assert "failproofai_sdk.instrument()" in source, f"{path.name} never instruments"


@pytest.mark.parametrize(
    "path",
    [p for p in EXAMPLES if p.parents[1].name == "manual"],
    ids=[i for i in EXAMPLE_IDS if i.startswith("manual/")],
)
def test_a_manual_example_does_not_instrument(path):
    """`manual/` exists to show the path with no adapter."""
    source = path.read_text(encoding="utf-8")
    assert "failproofai_sdk.instrument()" not in source


@pytest.mark.parametrize("path", EXAMPLES, ids=EXAMPLE_IDS)
def test_an_example_documents_how_to_run_itself(path):
    """The docstring is what somebody reads before running it."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    doc = ast.get_docstring(tree) or ""
    assert "pip install" in doc, f"{path.name} does not say how to install it"
    expected = f"python docs/{path.parents[1].name}/examples/{path.name}"
    assert expected in doc, f"{path.name} does not show `{expected}`"


def test_the_shared_helper_is_not_importable_from_the_sdk():
    """`_shared` is cosmetics. If it ever became a dependency of the package,
    the zero-dependency promise would be quietly routed around."""
    import failproofai_sdk.integrations as integrations

    for module in (failproofai_sdk, integrations):
        source = Path(module.__file__).read_text(encoding="utf-8")
        assert "_shared" not in source


# ─────────────────────────────────────────────────────────────────────────────
# Documented options must exist
# ─────────────────────────────────────────────────────────────────────────────
#
# The guides shipped naming `capture_content` for CrewAI and `session_id` for
# LlamaIndex. Neither adapter reads either one, so both were silently ignored:
# `instrument()` passes the same dict to every adapter and unknown keys are
# dropped by design, which means a reader following the docs got no error and no
# effect. Nothing checked, because the option lists were prose.

#: docs directory -> the adapter module that backs it.
DIR_ADAPTER = {
    "langgraph": "langchain",
    "crewai": "crewai",
    "llama_index": "llama_index",
    "pydantic_ai": "pydantic_ai",
}


def _adapter_options(module_name: str) -> set[str]:
    """Every option key an adapter actually reads, from its source.

    Two spellings, because the adapters use two: `options.get("x")` for the ones
    that read the dict directly, and a dataclass of defaults for LangChain,
    which parses the dict into `_Options` first.
    """
    import failproofai_sdk

    source = (
        Path(failproofai_sdk.__file__).resolve().parent
        / "integrations"
        / f"{module_name}.py"
    ).read_text(encoding="utf-8")

    names = set(re.findall(r'options\.get\(\s*["\'](\w+)["\']', source))

    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "_Options":
            names |= {
                stmt.target.id
                for stmt in node.body
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name)
            }
    return names


def _documented_options(text: str, adapter_name: str) -> set[str]:
    """Keyword names inside a documented `instrument("<name>", ...)` call."""
    documented: set[str] = set()
    for block in re.findall(r"```python[^\n]*\n(.*?)```", text, re.S):
        try:
            tree = ast.parse(textwrap.dedent(block))
        except SyntaxError:  # a fragment, not a whole program
            continue
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                continue
            if node.func.attr != "instrument":
                continue
            first = node.args[0] if node.args else None
            if isinstance(first, ast.Constant) and first.value == adapter_name:
                documented |= {kw.arg for kw in node.keywords if kw.arg}
    return documented


@pytest.mark.parametrize("directory,module_name", sorted(DIR_ADAPTER.items()))
def test_a_guide_only_documents_options_the_adapter_reads(directory, module_name):
    text = (DOCS / directory / "README.md").read_text(encoding="utf-8")
    documented = _documented_options(text, module_name)
    if not documented:
        pytest.skip(f"{directory} documents no instrument() options")
    real = _adapter_options(module_name)
    invented = documented - real
    assert not invented, (
        f"{directory}/README.md documents instrument({module_name!r}, ...) options "
        f"{sorted(invented)} that the adapter never reads. Unknown keys are "
        f"dropped silently, so a reader following this gets no error and no effect. "
        f"Real options: {sorted(real)}"
    )
