from __future__ import annotations

import sys

import pytest

from failproofai_sdk.evaluator import Evaluator
from failproofai_sdk.evaluator.__main__ import load_evaluator


def test_module_loader_defaults_to_app(tmp_path, monkeypatch):
    (tmp_path / "my_evals.py").write_text(
        "from failproofai_sdk.evaluator import Evaluator\n"
        "app = Evaluator(name='example', version='1')\n",
        encoding="utf-8",
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    try:
        loaded = load_evaluator("my_evals")
    finally:
        sys.modules.pop("my_evals", None)
    assert isinstance(loaded, Evaluator)
    assert loaded.name == "example"


def test_module_loader_supports_an_explicit_attribute(tmp_path, monkeypatch):
    (tmp_path / "custom_evals.py").write_text(
        "from failproofai_sdk.evaluator import Evaluator\n"
        "worker = Evaluator(name='custom', version='1')\n",
        encoding="utf-8",
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    try:
        loaded = load_evaluator("custom_evals:worker")
    finally:
        sys.modules.pop("custom_evals", None)
    assert loaded.name == "custom"


def test_module_loader_rejects_the_wrong_object_type(tmp_path, monkeypatch):
    (tmp_path / "not_evals.py").write_text("app = object()\n", encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    try:
        with pytest.raises(TypeError, match="not Evaluator"):
            load_evaluator("not_evals")
    finally:
        sys.modules.pop("not_evals", None)
