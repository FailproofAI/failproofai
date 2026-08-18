"""The skill's code is instructions an agent executes, so it is code under test.

An agent reading `SKILL.md` copies these blocks into someone's real agent loop.
A bug in a documented snippet ships to every reader, and unlike the package it
is never exercised by anything — which is why it gets a guard rather than a
proofread.
"""
import ast
import re
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[1] / "skill"
SNIPPET_FILES = sorted(SKILL.rglob("*.md"))


def python_blocks(path):
    """Every ```python fenced block in a markdown file."""
    text = path.read_text(encoding="utf-8")
    return re.findall(r"```python\n(.*?)```", text, re.DOTALL)


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
