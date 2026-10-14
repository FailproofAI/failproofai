import json
from datetime import datetime, timezone

import pytest
import respx

from fp_cli.app import app

BASE = "http://dash.test"
SOURCE = "EvalResult(score=Score(value=0.9), reasoning='ok')"


@pytest.fixture
def code(tmp_path):
    path = tmp_path / "eval.py"
    path.write_text(SOURCE)
    return str(path)


KINDS = [
    (["--judge", "--criteria", "Grade relevance", "--step", "Assess specificity"], "judge"),
    (["--jev", "noul", "--instructions", "Assess resolution", "--true", "Resolved", "--false", "Unresolved"], "jev"),
    (["--jev", "score", "--instructions", "Grade relevance", "--level", "Poor", "--level", "Fair", "--level", "Good"], "jev"),
]


@pytest.mark.parametrize("key_mode", [False, True])
@pytest.mark.parametrize("flags,kind", KINDS + [([], "code")])
def test_create_bodies(logged_in, runner, code, key_mode, flags, kind):
    prefix = "v1" if key_mode else "api"
    flags = flags or ["--code", code, "--result-kind", "assertion"]
    with respx.mock as mock:
        route = mock.post(f"{BASE}/{prefix}/evaluator-definitions").respond(201, json={"id": "d1", "enabled": True})
        result = runner.invoke(app, ["--json", *(["--api-key", "key"] if key_mode else []),
                                     "evaluators", "create", "--key", "quality", "--name", "Quality", *flags])
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls[0].request.content)
    assert body["eval_key"] == "quality"
    assert body["display_name"] == "Quality"
    assert body["eval_version"] == "1"
    assert body["labels"] == []
    if kind == "code":
        assert body["evaluator_source"] == SOURCE
        assert body["result_kind"] == "assertion"
    else:
        assert body["result_kind"] == "score"
        envelope = json.loads(body["evaluator_source"])
        assert envelope["kind"] == kind
        assert envelope["threshold"] is None
        if kind == "judge":
            assert envelope["steps"] == ["Assess specificity"]


@pytest.mark.parametrize("flags", [
    ["--judge", "--criteria", "Grade", "--threshold", "1.5"],
    ["--judge", "--criteria", "Grade", "--threshold", "nan"],
    ["--judge", "--criteria", "Grade", "--result-kind", "metric"],
    ["--judge", "--criteria", "Grade", "--step", "Answer yes/no"],
    ["--jev", "score", "--instructions", "Grade", "--level", "Bad", "--level", "Good"],
    ["--jev", "score", "--instructions", "Grade", "--level", "Bad", "--level", "Bad", "--level", "Good"],
    ["--jev", "noul", "--instructions", "Grade"],
    ["--judge", "--criteria", "Grade", "--dry-run-on", "s1"],
    ["--judge", "--criteria", "Grade", "--code", "-"],
    ["--judge", "--criteria", "Grade", "--timeout", "-1"],
])
def test_validation_before_network(logged_in, runner, flags):
    with respx.mock(assert_all_called=False) as mock:
        catch_all = mock.route().respond(200, json={})
        result = runner.invoke(app, ["--json", "evaluators", "create", "--key", "quality", "--name", "Quality", *flags])
    assert result.exit_code == 2, result.output
    assert catch_all.call_count == 0


@pytest.mark.parametrize("key", ["Bad", "1bad", "bad-key", "../bad", ""])
def test_key_validation(logged_in, runner, code, key):
    result = runner.invoke(app, ["--json", "evaluators", "create", "--key", key, "--name", "Quality", "--code", code])
    assert result.exit_code == 2


def test_deploy_order_and_dry_run(logged_in, runner, code):
    old = {"id": "d1", "eval_key": "quality", "eval_version": "1", "display_name": "Quality", "enabled": True}
    with respx.mock as mock:
        mock.get(f"{BASE}/v1/evaluator-definitions").respond(200, json=[old])
        dry = mock.post(f"{BASE}/v1/evaluator-definitions/dry-run").respond(200, json={"ok": True})
        create = mock.post(f"{BASE}/v1/evaluator-definitions").respond(201, json={**old, "id": "d2", "eval_version": "2"})
        patch = mock.patch(f"{BASE}/v1/evaluator-definitions/d1").respond(200, json={})
        result = runner.invoke(app, ["--json", "--api-key", "key", "evaluators", "deploy", "quality", "--code", code, "--dry-run-on", "s1"])
        order = [(call.request.method, call.request.url.path) for call in mock.calls]
    assert result.exit_code == 0, result.output
    assert order == [("GET", "/v1/evaluator-definitions"), ("POST", "/v1/evaluator-definitions/dry-run"),
                     ("POST", "/v1/evaluator-definitions"), ("PATCH", "/v1/evaluator-definitions/d1")]
    assert json.loads(create.calls[0].request.content)["eval_version"] == "2"
    assert json.loads(patch.calls[0].request.content) == {"enabled": False}
    assert json.loads(dry.calls[0].request.content)["session_ids"] == ["s1"]
    assert json.loads(result.stdout)["disabled"] == ["d1"]


@pytest.mark.parametrize("key_mode", [False, True])
def test_deploy_backfill_uses_utc_z_timestamps(logged_in, runner, code, monkeypatch, key_mode):
    from fp_cli.commands import evaluators_cmds

    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            assert tz == timezone.utc
            return cls(2026, 10, 14, 12, 34, 56, 123456, tzinfo=tz)

    monkeypatch.setattr(evaluators_cmds, "datetime", FixedDateTime)
    prefix = "v1" if key_mode else "api"
    with respx.mock as mock:
        mock.get(f"{BASE}/{prefix}/evaluator-definitions").respond(200, json=[
            {"id": "d1", "eval_key": "quality", "eval_version": "1", "enabled": True},
        ])
        mock.post(f"{BASE}/{prefix}/evaluator-definitions").respond(201, json={"id": "d2"})
        mock.patch(f"{BASE}/{prefix}/evaluator-definitions/d1").respond(200, json={})
        backfill = mock.post(f"{BASE}/{prefix}/evaluations/backfill").respond(200, json={"queued": True})
        result = runner.invoke(app, [
            "--json", *(["--api-key", "key"] if key_mode else []),
            "evaluators", "deploy", "quality", "--code", code, "--backfill", "7d",
        ])
        order = [(call.request.method, call.request.url.path) for call in mock.calls]
    assert result.exit_code == 0, result.output
    assert json.loads(backfill.calls[0].request.content) == {
        "from": "2026-10-07T12:34:56Z",
        "to": "2026-10-14T12:34:56Z",
        "eval_key": "quality",
        "dry_run": False,
    }
    assert order[-2:] == [
        ("PATCH", f"/{prefix}/evaluator-definitions/d1"),
        ("POST", f"/{prefix}/evaluations/backfill"),
    ]


def test_failed_create_never_disables(logged_in, runner, code):
    with respx.mock(assert_all_called=False) as mock:
        mock.get(f"{BASE}/api/evaluator-definitions").respond(200, json=[{"id": "d1", "eval_key": "quality", "eval_version": "1"}])
        mock.post(f"{BASE}/api/evaluator-definitions").respond(409, json={"error": "version conflict"})
        patch = mock.patch(f"{BASE}/api/evaluator-definitions/d1").respond(200, json={})
        result = runner.invoke(app, ["--json", "evaluators", "deploy", "quality", "--code", code])
    assert result.exit_code == 1
    assert not patch.called


def test_partial_deploy_is_reported(logged_in, runner, code):
    with respx.mock as mock:
        mock.get(f"{BASE}/api/evaluator-definitions").respond(200, json=[{"id": "d1", "eval_key": "quality", "eval_version": "1"}])
        mock.post(f"{BASE}/api/evaluator-definitions").respond(201, json={"id": "d2"})
        mock.patch(f"{BASE}/api/evaluator-definitions/d1").respond(403, json={})
        result = runner.invoke(app, ["--json", "evaluators", "deploy", "quality", "--code", code])
    assert result.exit_code == 5
    assert "Published quality@2" in result.stderr
    assert "d2" in result.stderr


def test_draft_round_trip(logged_in, runner, tmp_path):
    body = {"eval_key": "quality", "display_name": "Quality", "eval_version": "1",
            "result_kind": "score", "labels": [], "evaluator_source": SOURCE}
    path = tmp_path / "draft.json"
    with respx.mock as mock:
        mock.post(f"{BASE}/api/agent/compose-eval").respond(200, json={"spec": body})
        result = runner.invoke(app, ["--json", "evaluators", "draft", "Grade quality", "--out", str(path)])
    assert result.exit_code == 0, result.output
    assert json.loads(path.read_text()) == body
    with respx.mock as mock:
        route = mock.post(f"{BASE}/v1/evaluator-definitions").respond(201, json={"id": "d1"})
        result = runner.invoke(app, ["--json", "--api-key", "key", "evaluators", "create", "--file", str(path)])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls[0].request.content) == body


def test_draft_denies_key(logged_in, runner):
    with respx.mock(assert_all_called=False) as mock:
        route = mock.route().respond(200, json={})
        result = runner.invoke(app, ["--json", "--api-key", "key", "evaluators", "draft", "Grade"])
    assert result.exit_code == 2
    assert "needs a signed-in session: run `fp login`" in result.stdout
    assert not route.called


@pytest.mark.parametrize("count", [0, 2, 11])
def test_dry_run_sessions(logged_in, runner, code, count):
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(f"{BASE}/v1/evaluator-definitions/dry-run").respond(200, json={"ok": True})
        result = runner.invoke(app, ["--json", "--api-key", "key", "evaluators", "dry-run", "--code", code,
                                    *[v for n in range(count) for v in ("--session", str(n))]])
    assert result.exit_code == (2 if count > 10 else 0), result.output
    if count <= 10:
        assert json.loads(route.calls[0].request.content)["session_ids"] == [str(n) for n in range(count)]
    else:
        assert not route.called


def test_judge_refusal(logged_in, runner):
    result = runner.invoke(app, ["--json", "evaluators", "dry-run", "--judge", "--criteria", "Grade"])
    assert result.exit_code == 2
    assert "Cloud refuses judge dry-runs" in result.stdout


@pytest.mark.parametrize("command,path", [("instances", "evaluator-instances"), ("schema", "evaluator-schema-profile"), ("jobs", "evaluation-jobs")])
def test_auxiliary_commands(logged_in, runner, command, path):
    with respx.mock as mock:
        mock.get(f"{BASE}/v1/{path}").respond(200, json=[])
        result = runner.invoke(app, ["--json", "--api-key", "key", "evaluators", command])
    assert result.exit_code == 0, result.output


@pytest.mark.parametrize("command,body", [("enable", {"enabled": True}), ("disable", {"enabled": False}),
    ("label", {"labels": ["new"]})])
def test_patch_commands(logged_in, runner, command, body):
    with respx.mock as mock:
        mock.get(f"{BASE}/v1/evaluator-definitions").respond(200, json=[
            {"id": "d1", "eval_key": "quality", "eval_version": "1", "labels": ["old"]}])
        route = mock.patch(f"{BASE}/v1/evaluator-definitions/d1").respond(200, json=body)
        result = runner.invoke(app, ["--json", "--api-key", "key", "evaluators", command, "quality@1",
                                    *(["--add", "new", "--remove", "old"] if command == "label" else [])])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls[0].request.content) == body


def test_list_show_filter(logged_in, runner):
    rows = [{"id": "d1", "eval_key": "quality", "eval_version": "1", "enabled": False},
            {"id": "d2", "eval_key": "quality", "eval_version": "2", "enabled": True}]
    with respx.mock as mock:
        mock.get(f"{BASE}/v1/evaluator-definitions").respond(200, json=rows)
        listing = runner.invoke(app, ["--json", "--api-key", "key", "evaluators", "list", "--key", "quality"])
        showing = runner.invoke(app, ["--json", "--api-key", "key", "evaluators", "show", "quality@1"])
    assert listing.exit_code == showing.exit_code == 0
    assert json.loads(listing.stdout) == [rows[1]]
    assert json.loads(showing.stdout) == rows[0]


@pytest.mark.parametrize("frm,to,ok", [
    ("2026-10-01T00:00:00Z", "2026-10-08T00:00:00Z", True),
    ("2026-10-01T00:00:00Z", "2026-09-01T00:00:00Z", False),
    ("2026-01-01T00:00:00Z", "2026-10-08T00:00:00Z", False),
])
def test_backfill(logged_in, runner, frm, to, ok):
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(f"{BASE}/v1/evaluations/backfill").respond(200, json={"ok": True})
        result = runner.invoke(app, ["--json", "--api-key", "key", "evaluators", "backfill", "--from", frm, "--to", to, "--dry-run"])
    assert result.exit_code == (0 if ok else 2), result.output
    if ok:
        assert "excludes judge/Jev" in result.stderr
        assert json.loads(route.calls[0].request.content)["dry_run"] is True


@pytest.mark.parametrize("command", ["list", "instances", "schema", "jobs"])
def test_evaluator_404(logged_in, runner, command):
    with respx.mock as mock:
        mock.route().respond(404, json={})
        result = runner.invoke(app, ["--json", "evaluators", command])
    assert result.exit_code == 6
    assert "not available on this FailproofAI Cloud yet" in result.stdout


def test_failed_dry_run_blocks_creation(logged_in, runner, code):
    with respx.mock(assert_all_called=False) as mock:
        mock.post(f"{BASE}/api/evaluator-definitions/dry-run").respond(200, json={
            "runs": [{"ok": False, "error_message": "missing result"}], "summary": {"failed": 1}})
        create = mock.post(f"{BASE}/api/evaluator-definitions").respond(201, json={"id": "d1"})
        result = runner.invoke(app, ["--json", "evaluators", "create", "--key", "quality", "--name", "Quality", "--code", code, "--dry-run-on", "s1"])
    assert result.exit_code == 1
    assert not create.called
    assert "was not created" in result.stdout


@pytest.mark.parametrize("draft_kind,fields", [
    ("code", {"evaluator_source": SOURCE}),
    ("judge", {"criteria": "Grade relevance", "steps": ["Assess specificity"], "threshold": 0.7, "evaluator_source": ""}),
    ("jev", {"jevType": "noul", "instructions": "Check resolution", "jevCriteria": {"true": "Resolved", "false": "Unresolved"}, "evaluator_source": ""}),
])
def test_real_dashboard_draft_shape(logged_in, runner, tmp_path, draft_kind, fields):
    draft = {"eval_key": "quality", "display_name": "Quality", "result_kind": "score", "labels": [],
             "condition_source": "", "reasoning": "Draft explanation", "kind": draft_kind, **fields}
    path = tmp_path / "draft.json"
    with respx.mock as mock:
        mock.post(f"{BASE}/api/agent/compose-eval").respond(200, json=draft)
        result = runner.invoke(app, ["--json", "evaluators", "draft", "Grade", "--kind", draft_kind, "--out", str(path)])
    assert result.exit_code == 0, result.output
    body = json.loads(path.read_text())
    assert body["eval_version"] == "1"
    assert "reasoning" not in body and "kind" not in body and "condition_source" not in body
    if draft_kind != "code":
        assert json.loads(body["evaluator_source"])["kind"] == draft_kind


@pytest.mark.parametrize("flags", [
    ["--judge", "--criteria", "Grade", "--step", "Score of 0 on failure"],
    ["--judge", "--criteria", "Grade", "--step", "score: 1 on success"],
    ["--jev", "score", "--instructions", "Grade", "--level", "Poor", "--level", "poor", "--level", "Good"],
    ["--judge", "--criteria", "Grade", "--version", "bad version"],
    ["--judge", "--criteria", "Grade", "--label", "bad\nlabel"],
    ["--judge", "--criteria", "Grade", "--timeout", "3601"],
])
def test_server_validation_edges(logged_in, runner, flags):
    with respx.mock as mock:
        result = runner.invoke(app, ["--json", "evaluators", "create", "--key", "quality", "--name", "Quality", *flags])
        assert not mock.calls
    assert result.exit_code == 2, result.output
