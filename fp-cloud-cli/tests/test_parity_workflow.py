"""Stacked feature verification must run against its actual PR base."""

from pathlib import Path


def test_stacked_parity_workflow_is_read_only_and_runs_real_checks():
    workflow = Path(__file__).resolve().parents[2] / ".github/workflows/fp-cli-parity.yml"
    text = workflow.read_text()
    assert "branches: [feat/tui-ux]" in text
    assert '["3.10", "3.11", "3.12", "3.13"]' in text
    assert 'FP_CLI_REQUIRE_CONTRACT: "1"' in text
    assert "uv run --extra dev pytest -q" in text
    assert "tests/fake_cloud_smoke.py" in text
    assert "contents: read" in text
    assert "persist-credentials: false" in text
    assert "workflow_dispatch" not in text
    assert "publish" not in text
