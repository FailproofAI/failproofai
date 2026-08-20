"""The published docs site makes claims about this package, and nothing checked them.

`docs/start/integrations/` on the site is a second copy of the integration guide,
maintained by hand alongside `sdk/python/docs/`. Two copies of the same claims is
exactly the shape that drifts, and it already had: the site named
`capture_content` for CrewAI and `session_id` for LlamaIndex, neither of which
those adapters read, and told readers to verify a Pydantic AI install by printing
`agent.capabilities`, which raises `AttributeError`.

None of that produced an error for a reader — `instrument()` drops unknown option
keys by design — so only a test can catch it.

Same shape as `test_spool_contract.py` and `fp-cli/tests/test_fp_home_contract.py`:
read the other side's source, skip when it is genuinely absent (an installed
sdist has no docs site), and fail when `FAILPROOFAI_SDK_REQUIRE_CONTRACT` says the
repository should be there.
"""
from __future__ import annotations

import ast
import os
import re
import textwrap
from pathlib import Path

import pytest

import failproofai_sdk

# sdk/python -> sdk -> repo root -> docs/
_HERE = Path(failproofai_sdk.__file__).resolve().parent.parent
SITE = _HERE.parent.parent / "docs" / "start" / "integrations"

REQUIRE = os.environ.get("FAILPROOFAI_SDK_REQUIRE_CONTRACT", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

#: site page -> the adapter module it documents.
PAGE_ADAPTER = {
    "langchain.mdx": "langchain",
    "crewai.mdx": "crewai",
    "llamaindex.mdx": "llama_index",
    "pydantic-ai.mdx": "pydantic_ai",
}


def _page(name: str) -> str:
    path = SITE / name
    if path.is_file():
        return path.read_text(encoding="utf-8")
    message = (
        f"{path} is missing. In an installed sdist that is expected. In the "
        f"repository it means the docs site moved and these claims are now "
        f"unguarded — re-point this test rather than deleting it."
    )
    if REQUIRE:
        pytest.fail(message)
    pytest.skip(message)


def _adapter_options(module_name: str) -> set[str]:
    source = (
        Path(failproofai_sdk.__file__).resolve().parent
        / "integrations"
        / f"{module_name}.py"
    ).read_text(encoding="utf-8")
    names = set(re.findall(r'options\.get\(\s*["\'](\w+)["\']', source))
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ClassDef) and node.name == "_Options":
            names |= {
                stmt.target.id
                for stmt in node.body
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name)
            }
    return names


def _documented_options(text: str, adapter: str) -> set[str]:
    out: set[str] = set()
    for block in re.findall(r"```python[^\n]*\n(.*?)```", text, re.S):
        try:
            tree = ast.parse(textwrap.dedent(block))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                continue
            if node.func.attr != "instrument" or not node.args:
                continue
            first = node.args[0]
            if isinstance(first, ast.Constant) and first.value == adapter:
                out |= {kw.arg for kw in node.keywords if kw.arg}
    return out


@pytest.mark.parametrize("page,adapter", sorted(PAGE_ADAPTER.items()))
def test_a_site_page_only_documents_options_the_adapter_reads(page, adapter):
    documented = _documented_options(_page(page), adapter)
    if not documented:
        pytest.skip(f"{page} documents no instrument() options")
    invented = documented - _adapter_options(adapter)
    assert not invented, (
        f"docs/start/integrations/{page} documents instrument({adapter!r}, ...) "
        f"options {sorted(invented)} that the adapter never reads. Unknown keys "
        f"are dropped silently, so a reader gets no error and no effect."
    )


@pytest.mark.parametrize("page", sorted(PAGE_ADAPTER))
def test_a_site_page_only_names_event_methods_that_exist(page):
    named = set(re.findall(r"failproofai_sdk\.event\.([a-z_]+)\s*\(", _page(page)))
    missing = {n for n in named if not hasattr(failproofai_sdk.event, n)}
    assert not missing, f"{page} names event.{sorted(missing)}, which does not exist"


@pytest.mark.parametrize("page", sorted(PAGE_ADAPTER))
def test_a_site_page_only_names_api_this_package_exports(page):
    named = set(re.findall(r"failproofai_sdk\.([a-z_]+)\s*\(", _page(page))) - {"event"}
    missing = {n for n in named if not hasattr(failproofai_sdk, n)}
    assert not missing, f"{page} names failproofai_sdk.{sorted(missing)}, which does not exist"


def test_the_pydantic_page_verifies_the_capability_the_way_that_works():
    """`agent.capabilities` raises AttributeError.

    Pydantic AI merges the list you pass into a single `root_capability`, so the
    verification snippet the page tells a reader to run has to go through it.
    """
    text = _page("pydantic-ai.mdx")
    assert "root_capability.capabilities" in text, (
        "the pydantic page must verify through `agent.root_capability.capabilities`"
    )
    # Scoped to CODE, not prose: the page explains in words that
    # `agent.capabilities` does not exist, and that sentence should stay.
    code = "\n".join(re.findall(r"```python[^\n]*\n(.*?)```", text, re.S))
    assert not re.search(r"(?<!root_capability\.)\bagent\.capabilities\b", code), (
        "a code sample on the pydantic page reads `agent.capabilities`, "
        "which raises AttributeError"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Structure
# ─────────────────────────────────────────────────────────────────────────────
#
# Four framework pages written one at a time drifted into four different shapes:
# LangGraph explained session control under "Control the session", CrewAI buried
# the same thing as an H3 inside "Options", LlamaIndex had it in a callout, and
# Pydantic AI did not mention it at all. A reader who learns one page should be
# able to skim the next.

#: The order every framework page follows. Pages may insert their own sections
#: between these, but these must appear, in this order.
SPINE = [
    "Install",
    "Instrument",
    "What gets recorded",
    "Example",
    "Name your spans",
    "Control the session",
    "Options",
    "Common problems",
    "Next",
]


def _headings(page: str) -> list[str]:
    return [h.strip() for h in re.findall(r"^## (.+)$", _page(page), re.M)]


@pytest.mark.parametrize("page", sorted(PAGE_ADAPTER))
def test_a_framework_page_follows_the_shared_spine(page):
    headings = _headings(page)
    missing = [h for h in SPINE if h not in headings]
    assert not missing, f"{page} is missing sections {missing}; has {headings}"

    positions = [headings.index(h) for h in SPINE]
    assert positions == sorted(positions), (
        f"{page} orders the shared sections differently: "
        f"{[headings[i] for i in positions]}"
    )


@pytest.mark.parametrize("page", sorted(PAGE_ADAPTER))
def test_a_framework_page_is_explicit_about_human_in_the_loop(page):
    """Either it documents the pairs, or it says why there are none.

    Silence reads as an oversight, and the reader cannot tell whether the
    framework has no HITL surface or we simply did not map it.
    """
    text = _page(page)
    assert "## Human in the loop" in text or "human-in-the-loop pair" in text, (
        f"{page} neither documents human-in-the-loop nor states that the "
        f"framework has none"
    )
