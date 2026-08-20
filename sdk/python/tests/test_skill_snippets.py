"""The skill's code is instructions an agent executes, so it is code under test.

An agent reading `SKILL.md` copies these blocks into someone's real agent loop.
A bug in a documented snippet ships to every reader, and unlike the package it
is never exercised by anything — which is why it gets a guard rather than a
proofread.
"""
import ast
import re
import textwrap
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[1] / "skill"
SNIPPET_FILES = sorted(SKILL.rglob("*.md"))


def python_blocks(path):
    """Every ```python fenced block in a markdown file, dedented.

    Dedented because a fenced block nested inside a list item is indented in the
    source and is still valid Python once that common prefix is removed. Without
    this the only way to keep a snippet testable was to hoist it out of the list
    it belongs to — so the guard was quietly shaping the prose. `test_site_docs.py`
    already dedents; these two scans should not disagree about what a block is.
    """
    text = path.read_text(encoding="utf-8")
    blocks = re.findall(r"```python[^\n]*\n(.*?)```", text, re.DOTALL)
    return [textwrap.dedent(b) for b in blocks]


def test_there_are_snippets_to_check():
    """A path typo would otherwise make every test below pass vacuously."""
    blocks = [b for p in SNIPPET_FILES for b in python_blocks(p)]
    assert len(blocks) >= 5, f"found {len(blocks)} python blocks under {SKILL}"


@pytest.mark.parametrize("path", SNIPPET_FILES, ids=lambda p: p.name)
def test_every_documented_snippet_parses(path):
    """A snippet that does not compile is worse than no snippet."""
    for i, block in enumerate(python_blocks(path)):
        try:
            ast.parse(block)
        except SyntaxError as exc:  # pragma: no cover - failure path
            pytest.fail(f"{path.name} block {i} does not parse: {exc}")


@pytest.mark.parametrize("path", SNIPPET_FILES, ids=lambda p: p.name)
def test_lifecycle_brackets_catch_baseexception_not_exception(path):
    """A cancelled tool or run must still emit its closing event.

    `asyncio.CancelledError` inherits straight from `BaseException`, so
    `except Exception` does not see it — and cancellation is the ordinary way an
    async tool ends when a timeout fires or a caller gives up, not an exotic
    one. The result is a `tool_use` with no `tool_result`, or an `agent_start`
    with no `agent_end`: an orphaned event that also holds its correlation slot
    until the cap evicts it.

    Only handlers that EMIT are checked. A bare `except Exception` around the
    emit call itself is correct and must stay — swallowing `KeyboardInterrupt`
    there would make telemetry able to block a Ctrl-C.
    """
    for i, block in enumerate(python_blocks(path)):
        try:
            tree = ast.parse(block)
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.ExceptHandler):
                continue
            body = ast.unparse(ast.Module(body=node.body, type_ignores=[]))
            emits = re.search(r"\b(_emit|event\.\w+|failproofai_sdk\.event\.\w+)\s*\(", body)
            if not emits:
                continue
            caught = ast.unparse(node.type) if node.type else "<bare>"
            assert "BaseException" in caught, (
                f"{path.name} block {i}: `except {caught}` wraps an emit — a cancelled "
                "tool or run would skip its closing event. Use BaseException."
            )


# --- The prose is a contract too -------------------------------------------
#
# Everything above checks that snippets PARSE and handle cancellation. Nothing
# checked that what the skill SAYS is true, and three claims had gone stale
# undetected: a correlation bug described as current after it was fixed, a float
# `duration_ms` described as silently dropped after it started raising, and a
# verify step pointing at the pre-migration spool root. An agent following that
# last one looks in an empty directory and reports the integration broken.
#
# These are the checks that would have caught each class.

import failproofai_sdk
from failproofai_sdk import _resolver

SKILL_TEXT = {p.name: p.read_text(encoding="utf-8") for p in SNIPPET_FILES}


def test_the_skill_only_names_event_methods_that_exist():
    """A method renamed in the SDK leaves the skill teaching a call that raises."""
    named = set()
    for text in SKILL_TEXT.values():
        named |= set(re.findall(r"(?:failproofai_sdk\.)?event\.([a-z_]+)\s*\(", text))
    assert named, "no event.* calls found — the scan stopped working"
    missing = sorted(n for n in named if not hasattr(failproofai_sdk.event, n))
    assert not missing, f"the skill names event methods that do not exist: {missing}"


def test_the_skill_only_names_public_api_that_exists():
    """Same, for the top-level surface an agent is told to import and call."""
    named = set(re.findall(r"failproofai_sdk\.([a-z_]+[a-z_0-9]*)\s*\(", "\n".join(SKILL_TEXT.values())))
    named -= {"event"}  # a namespace, reached as failproofai_sdk.event.<method>
    assert named, "no failproofai_sdk.* calls found — the scan stopped working"
    missing = sorted(n for n in named if not hasattr(failproofai_sdk, n))
    assert not missing, f"the skill names public API that does not exist: {missing}"


def test_the_skill_verifies_against_the_current_spool_root(monkeypatch):
    """The verify step must send a reader to the directory the SDK actually writes.

    `~/.agenteye` is still allowed in the migration notes — that is what the
    older `agenteye-collector` reads, and the skill has to say so. What is not
    allowed is presenting it as the path to CHECK, which is what it did: a fresh
    integration with no env vars writes to `~/.failproofai/custom-agents/events`,
    so the documented `ls` found nothing and read as total failure.
    """
    # The suite sets FAILPROOFAI_HOME to a sandbox (conftest), and this
    # assertion is about the SHAPE of the default rather than where this run
    # happens to spool — so it resolves with that pointer removed.
    monkeypatch.delenv("FAILPROOFAI_HOME", raising=False)
    default = str(_resolver.failproofai_custom_agents_dir())
    assert default.endswith("/.failproofai/custom-agents"), default

    skill = SKILL_TEXT["SKILL.md"]
    assert "~/.failproofai/custom-agents/events" in skill, (
        "SKILL.md never names the current default spool directory"
    )
    offenders = [
        line.strip()
        for line in skill.splitlines()
        if re.search(r"(ls|cat)\b[^\n]*~/\.agenteye/events", line)
    ]
    assert not offenders, (
        "SKILL.md tells the reader to inspect the pre-migration spool root; "
        f"that directory is empty on a default install: {offenders}"
    )


def test_the_skill_does_not_brand_the_product_with_the_retired_name():
    """The H1 and the description are what an agent reads before anything else.

    `agenteye` stays legal in migration notes and in the collector's own name;
    naming the PRODUCT that is what this catches.
    """
    skill = SKILL_TEXT["SKILL.md"]
    heading = next(line for line in skill.splitlines() if line.startswith("# "))
    assert "agenteye" not in heading.lower(), f"retired product name in the H1: {heading}"

    front = skill.split("---")[1] if skill.startswith("---") else ""
    description = re.search(r"description:.*?(?=\n[a-z_]+:|\Z)", front, re.S)
    assert description, "SKILL.md has no frontmatter description"
    assert "to agenteye" not in description.group(0).lower(), (
        "the frontmatter description still says events are reported to AgentEye"
    )
