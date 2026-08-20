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
from failproofai_sdk import _events as _events_module

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


# --- Keyword arguments, on every page in the directory ----------------------
#
# The tests above check that a method NAME exists. Nothing checked the keywords,
# and `event.*` ends in `**fields` — so a wrong one is accepted, stored as a
# custom field, and never populates the column the reader wanted. The docs told
# people to call `model_response(response=...)` for a long time; the parameter is
# `content`, so every reader who copied it got an event whose `content` column
# was empty and a stray `response` field they never asked for. Nothing raised.
#
# These also widen the net: PAGE_ADAPTER covers only the four framework pages, so
# `custom-agents.mdx` — which carries the most hand-written event calls on the
# site — was scanned by nothing at all. That is where the bug survived.

ALL_PAGES = sorted(p.name for p in SITE.glob("*.mdx")) if SITE.is_dir() else []

# Custom fields are legal, and the adapters namespace theirs. A bare unknown
# keyword on a documented call is the typo case.
#
# Two exemptions, both deliberate. `fw_*` is the documented namespace for a
# framework's own metadata. And `_PROMOTED_NUMERIC` names the keys ingest lifts
# into real columns — `duration_ms` on `model_response` is the one the docs
# actively tell you to pass, and it travels through `**fields` by design, so the
# SDK validates it there rather than declaring it a parameter. Reading the set
# from the SDK keeps this from drifting the moment a fourth key is promoted.
_CUSTOM_FIELD_PREFIX = "fw_"
_PROMOTED = set(_events_module._PROMOTED_NUMERIC)


def _event_calls(text: str):
    """(method, {keywords}) for every failproofai_sdk.event.X(...) in a python block."""
    for block in re.findall(r"```python[^\n]*\n(.*?)```", text, re.S):
        try:
            tree = ast.parse(textwrap.dedent(block))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                continue
            value = node.func.value
            if not (isinstance(value, ast.Attribute) and value.attr == "event"):
                continue
            yield node.func.attr, {kw.arg for kw in node.keywords if kw.arg}


@pytest.mark.parametrize("page", ALL_PAGES)
def test_every_documented_event_call_uses_real_keywords(page):
    import inspect

    bad = []
    for method, keywords in _event_calls(_page(page)):
        fn = getattr(failproofai_sdk.event, method, None)
        if fn is None:
            continue  # the name test above owns this failure
        real = set(inspect.signature(fn).parameters) - {"fields"}
        for kw in sorted(keywords - real):
            if kw.startswith(_CUSTOM_FIELD_PREFIX) or kw in _PROMOTED:
                continue
            bad.append(f"event.{method}({kw}=...)")
    assert not bad, (
        f"docs/start/integrations/{page} passes keywords that are not parameters: "
        f"{bad}. `event.*` ends in **fields, so these are accepted silently and "
        f"stored as custom fields instead of filling the column the reader wanted."
    )


def test_the_keyword_scan_actually_finds_calls():
    """Otherwise a change to the block format makes every page above pass vacuously."""
    found = sum(len(list(_event_calls(_page(p)))) for p in ALL_PAGES)
    assert found >= 10, f"only {found} event calls found across {len(ALL_PAGES)} pages"
