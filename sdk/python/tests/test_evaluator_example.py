from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from failproofai_sdk.evaluator import ConditionResult


def _example_module():
    path = Path(__file__).parents[1] / "examples" / "evaluator_worker.py"
    spec = importlib.util.spec_from_file_location("evaluator_worker_example", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_example_registers_deterministic_and_async_evals(monkeypatch):
    monkeypatch.delenv("EXAMPLE_JUDGE_URL", raising=False)
    module = _example_module()
    definitions = {item.eval_key: item for item in module.app.definitions}
    assert set(definitions) == {"answer_relevance", "tool_efficiency"}
    assert definitions["answer_relevance"].eval_version == "judge-api-v1"

    skipped = definitions["answer_relevance"].condition(None)
    assert skipped == ConditionResult(False, "judge_not_configured")


def test_example_rejects_non_http_judge_urls(monkeypatch):
    module = _example_module()
    monkeypatch.setenv("EXAMPLE_JUDGE_URL", "file:///etc/passwd")
    with pytest.raises(ValueError, match="absolute http"):
        module._call_judge("question", "answer")
