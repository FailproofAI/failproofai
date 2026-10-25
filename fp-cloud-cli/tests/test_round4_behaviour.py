import json
from io import StringIO

import pytest
import respx
from rich.console import Console

from fp_cli import output
from fp_cli.app import app

BASE = "http://dash.test"
SOURCE = 'EvalResult(score=Score(0.7), reasoning="Tool usage")'


@pytest.mark.parametrize("command", ["create", "deploy"])
@pytest.mark.parametrize("force", [False, True])
@pytest.mark.parametrize("json_mode", [False, True])
@pytest.mark.parametrize("width", [80, 140])
def test_failed_preview_stops_unless_force(logged_in, runner, tmp_path, monkeypatch, command, force, json_mode, width):
    monkeypatch.setenv("COLUMNS", str(width))
    file = tmp_path / "source.py"
    file.write_text(SOURCE)
    old = {"id": "old", "eval_key": "tool_usage", "eval_version": "1", "enabled": True}
    preview = {
        "runs": [
            {"session_id": "run-check", "ok": True,
             "result": {"score": {"value": 0.7}, "reasoning": "Seven tool calls"}},
            {"session_id": "failed-check", "ok": False, "error_kind": "invalid_result",
             "error_message": "Missing result score"},
        ],
        "summary": {"succeeded": 1, "failed": 1, "skipped": 0},
    }
    capture = StringIO()
    original_configure = output.configure

    def configure_capture(**kwargs):
        original_configure(**kwargs)
        if not json_mode:
            output._stdout = Console(file=capture, width=width, no_color=True)

    monkeypatch.setattr(output, "configure", configure_capture)
    with respx.mock(assert_all_called=False) as mock:
        mock.get(BASE + "/api/evaluator-definitions").respond(200, json=[old])
        mock.post(BASE + "/api/evaluator-definitions/dry-run").respond(200, json=preview)
        created = {
            "id": "new", "eval_key": "tool_usage", "eval_version": "2", "enabled": True,
        }
        create = mock.post(BASE + "/api/evaluator-definitions")
        patch = mock.patch(BASE + "/api/evaluator-definitions/old").respond(200, json={})

        def preview_happened_first(request):
            # Data must already be visible to the user when creation starts.
            if not json_mode:
                assert "Missing result score" in capture.getvalue()
                assert "Seven tool calls" in capture.getvalue()
            import httpx
            return httpx.Response(201, json=created)

        create.mock(side_effect=preview_happened_first)
        flags = ["--key", "tool_usage", "--name", "Tool usage"] if command == "create" else ["tool_usage"]
        result = runner.invoke(app, [
            *(["--json"] if json_mode else []), "evaluators", command, *flags,
            "--code", str(file), "--dry-run-on", "run-check", "--dry-run-on", "failed-check",
            *(["--force"] if force else []),
        ])
    assert result.exit_code == (0 if force else 1), result.output
    assert create.called is force
    assert patch.called is (force and command == "deploy")
    if json_mode:
        payload = json.loads(result.stdout)
        if force:
            assert payload == (
                {"created": {"id": "new", "eval_key": "tool_usage", "eval_version": "2", "enabled": True}, "disabled": ["old"]}
                if command == "deploy" else {"id": "new", "eval_key": "tool_usage", "eval_version": "2", "enabled": True}
            )
        else:
            assert payload["exit_code"] == 1
            assert "Missing result score" in payload["error"]
    else:
        rendered = capture.getvalue()
        assert "failed-check · failed" in rendered
        assert "Missing result score" in rendered
        if force:
            assert "--force" in result.stderr
            assert rendered.index("Missing result score") < rendered.index(
                "deployed tool_usage" if command == "deploy" else "EVALUATOR CREATED")


@pytest.mark.parametrize("width", [80, 140])
def test_preview_skip_has_deliberate_outcome(logged_in, runner, tmp_path, monkeypatch, width):
    monkeypatch.setenv("COLUMNS", str(width))
    file = tmp_path / "source.py"
    file.write_text(SOURCE)
    with respx.mock as mock:
        mock.post(BASE + "/api/evaluator-definitions/dry-run").respond(200, json={
            "runs": [{"session_id": "run-check", "ok": True, "applicable": False, "result": None}],
            "summary": {"succeeded": 0, "failed": 0, "skipped": 1},
        })
        result = runner.invoke(app, ["evaluators", "dry-run", "--code", str(file), "--session", "run-check"])
    assert result.exit_code == 0, result.output
    assert "○ run-check · skipped" in result.stdout


@pytest.mark.parametrize("key_mode", [False, True])
def test_deploy_file_without_key(logged_in, runner, tmp_path, key_mode):
    file = tmp_path / "spec.json"
    file.write_text(json.dumps({"display_name": "Tool usage", "evaluator_source": SOURCE, "eval_version": "2"}))
    prefix = "/v1" if key_mode else "/api"
    with respx.mock as mock:
        mock.get(BASE + prefix + "/evaluator-definitions").respond(200, json=[])
        create = mock.post(BASE + prefix + "/evaluator-definitions").respond(201, json={"id": "new"})
        result = runner.invoke(app, [
            "--json", *(["--api-key", "key"] if key_mode else []),
            "evaluators", "deploy", "tool_usage", "--file", str(file),
        ])
    assert result.exit_code == 0, result.output
    assert json.loads(create.calls[0].request.content)["eval_key"] == "tool_usage"
    assert json.loads(result.stdout) == {"created": {"id": "new"}, "disabled": []}


@pytest.mark.parametrize("command", [["plan"], ["plan", "claim", "team_offer"]])
@pytest.mark.parametrize("json_mode", [False, True])
def test_plan_needs_signed_in_person_before_http(logged_in, runner, command, json_mode):
    with respx.mock as mock:
        result = runner.invoke(app, ["--api-key", "key", *(["--json"] if json_mode else []), *command])
        assert not mock.calls
    assert result.exit_code == 2
    expected = f"`fp {' '.join(command[:2])}` needs a signed-in session: run `fp login`"
    assert expected in result.output


@pytest.mark.parametrize("key_mode", [False, True])
@pytest.mark.parametrize("body,expected", [
    ({}, "not available on this FailproofAI Cloud yet"),
    ({"error": "unknown route"}, "not available on this FailproofAI Cloud yet"),
    ({"error": "setting not found"}, "setting not found"),
])
def test_setting_key_404_on_older_cloud(logged_in, runner, key_mode, body, expected):
    prefix = "/v1" if key_mode else "/api"
    with respx.mock as mock:
        mock.put(BASE + prefix + "/settings/otel.ingest_enabled").respond(404, json=body)
        result = runner.invoke(app, ["--json", *(["--api-key", "key"] if key_mode else []), "otel", "enable"])
    assert result.exit_code == 6, result.output
    assert json.loads(result.stdout)["error"] == expected
