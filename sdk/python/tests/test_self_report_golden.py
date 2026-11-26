"""Self Reports: the Python side of the repository's shared golden files.

The Rust daemon, the CLI and the TypeScript SDK are tested against the same
files in test-fixtures/self-report/, so the tool description, input schema,
default categories, recognised tool names and the `self_report` event's field
order cannot drift between the four implementations. Change a golden file only
together with every implementation.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import failproofai_sdk as fp
from failproofai_sdk import _self_report
from failproofai_sdk._schema import SelfReportEvent

_HERE = Path(__file__).resolve()
REPO_ROOT = _HERE.parents[3] if len(_HERE.parents) > 3 else _HERE.parent
GOLDEN = REPO_ROOT / "test-fixtures" / "self-report"

#: CI sets this, so a missing golden directory fails instead of skipping.
REQUIRE = os.environ.get("FAILPROOFAI_SDK_REQUIRE_CONTRACT", "").strip().lower() in {"1", "true", "yes"}

pytestmark = pytest.mark.skipif(
    not GOLDEN.is_dir() and not REQUIRE,
    reason="the golden files live in the failproofai repository, not in the sdist",
)


def golden(name: str) -> str:
    return (GOLDEN / name).read_text(encoding="utf-8")


def lines(name: str) -> list[str]:
    return [line for line in golden(name).split("\n") if line]


def test_description_byte_for_byte():
    cats = [dict(c) for c in _self_report.DEFAULT_CATEGORIES]
    assert _self_report.describe(cats) == golden("description.golden.txt")
    assert _self_report.describe(cats, "Report a missing repository as missing_context.") == golden(
        "description-guidance.golden.txt"
    )


def test_input_schema_byte_for_byte():
    spec = _self_report.self_report_spec(categories=[dict(c) for c in _self_report.DEFAULT_CATEGORIES])
    assert json.dumps(spec["input_schema"], separators=(",", ":"), ensure_ascii=False) + "\n" == golden(
        "input-schema.golden.json"
    )


def test_default_categories():
    assert [dict(c) for c in _self_report.DEFAULT_CATEGORIES] == json.loads(golden("categories.golden.json"))


def test_tool_names():
    assert list(_self_report.TOOL_SPELLINGS) == lines("tool-names.golden.txt")
    for name in lines("tool-names.golden.txt"):
        assert fp.is_self_report_tool(name), name
        assert fp.is_self_report_tool(name.upper()), name
    assert fp.is_self_report_tool("report", "failproofai")
    assert fp.is_self_report_tool("MCP:report", "failproofai")
    assert not fp.is_self_report_tool("report", "linear")
    assert not fp.is_self_report_tool("MCP:report")


def test_event_field_order():
    spec = json.loads(golden("event-fields.golden.json"))
    base = dict(
        timestamp="2026-11-25T10:00:00.000000Z",
        session_id="s1",
        agent_id="a1",
        category="looping",
        detail="Same step again.",
    )
    assert list(SelfReportEvent(**base).to_dict()) == spec["order"]
    assert list(SelfReportEvent(**base, tool_call_id="call_1").to_dict()) == spec["order"] + spec["optional"]


def test_argument_aliases_match_the_shared_list():
    fixture = json.loads(golden("arg-aliases.json"))
    assert {k: list(v) for k, v in _self_report.ARG_ALIASES.items()} == fixture["aliases"]
    assert fixture["cases"]
    for case in fixture["cases"]:
        want = (case["category"], case["detail"])
        assert _self_report.parse_arguments(case["args"]) == want, case["args"]
        assert _self_report.parse_arguments(json.dumps(case["args"])) == want, case["args"]
