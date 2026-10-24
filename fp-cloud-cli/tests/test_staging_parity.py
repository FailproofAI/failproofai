"""Commands aligned with the FailproofAI Cloud staging API after the #885 port:
every-kind policy backtests, Jev/both authoring, issue board filters and facets,
evaluation facets, session import and judge/Jev backfill."""

import gzip
import json

import pytest
import respx

from fp_cli.app import app

BASE = "http://dash.test"
CHECKS = [{"name": "prod-db", "question": "Does this touch the production database?"}]


def sse(events):
    return "".join(f"data: {json.dumps(e)}\n\n" for e in events)


def test_backtest_regex_file_keeps_the_module_route(logged_in, runner, tmp_path):
    src = tmp_path / "p.mjs"
    src.write_text("export default {}")
    with respx.mock as mock:
        route = mock.post(f"{BASE}/api/agent/policy-backtest").respond(200, json={"matched": 0})
        result = runner.invoke(app, ["--json", "policies", "backtest", str(src), "--agent-id", "a1", "--hours", "24"])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls[0].request.content) == {"source": "export default {}", "agentId": "a1", "hours": 24}


def test_backtest_published_jev_policy_uses_backtest_all_estimate(logged_in, runner):
    with respx.mock as mock:
        mock.get(f"{BASE}/api/enforcement/policies").respond(200, json=[
            {"id": "p1", "version": 1, "kind": "jev", "semantic": CHECKS},
        ])
        route = mock.post(f"{BASE}/api/agent/policy-backtest-all").respond(200, json={"kind": "jev", "mode": "estimate"})
        result = runner.invoke(app, ["--json", "policies", "backtest", "p1"])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls[0].request.content) == {
        "kind": "jev", "semantic": CHECKS, "hours": 168, "mode": "estimate",
    }


def test_backtest_both_from_files_with_run(logged_in, runner, tmp_path):
    src, sem = tmp_path / "p.mjs", tmp_path / "checks.json"
    src.write_text("export default {}")
    sem.write_text(json.dumps(CHECKS))
    with respx.mock as mock:
        route = mock.post(f"{BASE}/api/agent/policy-backtest-all").respond(200, json={"kind": "both"})
        result = runner.invoke(app, ["--json", "policies", "backtest", str(src), "--semantic", str(sem),
                                     "--run", "--sample", "10"])
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls[0].request.content)
    assert body["kind"] == "both" and body["mode"] == "run" and body["sample"] == 10
    assert body["source"] == "export default {}" and body["semantic"] == CHECKS


@pytest.mark.parametrize("argv", [
    ["policies", "backtest"],
    ["policies", "backtest", "--kind", "jev", "--semantic", "missing.json"],
    ["policies", "backtest", "x.mjs", "--kind", "nope"],
    ["policies", "backtest", "x.mjs", "--sample", "99"],
])
def test_backtest_usage_errors(logged_in, runner, argv):
    with respx.mock(assert_all_called=False):
        result = runner.invoke(app, ["--json", *argv])
    assert result.exit_code == 2, result.output


@pytest.mark.parametrize("kind,sent", [(None, None), ("regex", None), ("jev", "jev"), ("both", "both")])
def test_author_kind(logged_in, runner, kind, sent):
    with respx.mock as mock:
        route = mock.post(f"{BASE}/api/agent/policy-author").respond(
            200, text=sse([{"type": "done", "result": {"source": "x"}}]))
        result = runner.invoke(app, ["--json", "policies", "author", "No prod DB",
                                     *(["--kind", kind] if kind else [])])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls[0].request.content).get("kind") == sent


@pytest.mark.parametrize("key_mode", [False, True])
def test_issue_list_filters(logged_in, runner, key_mode):
    prefix = "/v1" if key_mode else "/api"
    with respx.mock as mock:
        route = mock.get(f"{BASE}{prefix}/issues").respond(200, json=[])
        result = runner.invoke(app, ["--json", *(["--api-key", "k"] if key_mode else []), "issues", "list",
                                     "--agent-id", "a1,a2", "--source", "audit", "--assignee", "me",
                                     "--archived", "all", "--search", "timeout"])
    assert result.exit_code == 0, result.output
    params = route.calls[0].request.url.params
    assert params["agent"] == "a1,a2" and params["source"] == "audit"
    assert params["assignee"] == "me" and params["archived"] == "all" and params["q"] == "timeout"
    assert json.loads(result.stdout) == {"issues": []}


def test_issue_list_alert_id_alone_keeps_the_alert_route(logged_in, runner):
    with respx.mock as mock:
        route = mock.get(f"{BASE}/api/alerts/al1/issues").respond(200, json=[])
        result = runner.invoke(app, ["--json", "issues", "list", "--alert-id", "al1"])
    assert result.exit_code == 0, result.output
    assert route.called


def test_issue_count_and_facets(logged_in, runner):
    with respx.mock as mock:
        count = mock.get(f"{BASE}/api/issues/count").respond(200, json={"count": 3})
        facets = mock.get(f"{BASE}/api/issues/facets").respond(200, json={"agents": [{"value": "a1", "count": 3}]})
        r1 = runner.invoke(app, ["--json", "issues", "count", "--env", "prod"])
        r2 = runner.invoke(app, ["--json", "issues", "facets", "--state", "firing"])
    assert r1.exit_code == 0 and json.loads(r1.stdout) == {"count": 3}
    assert count.calls[0].request.url.params["environment"] == "prod"
    assert r2.exit_code == 0, r2.output
    assert facets.calls[0].request.url.params["state"] == "firing"


def test_issue_filter_validation(logged_in, runner):
    with respx.mock(assert_all_called=False):
        assert runner.invoke(app, ["issues", "list", "--archived", "maybe"]).exit_code == 2
        assert runner.invoke(app, ["issues", "list", "--source", "slack"]).exit_code == 2


@pytest.mark.parametrize("name,path,v1,body,values", [
    ("trigger_events", "/api/events/trigger_events", "/v1/events/trigger_events", ["PreToolUse"], ["PreToolUse"]),
    ("eval_envs", "/api/evaluations/environments", "/v1/evaluations/environments", ["prod"], ["prod"]),
    ("metric_keys", "/api/evaluations/metric-keys", "/v1/evaluations/metric_keys",
     [{"name": "latency_ms", "unit": "ms", "count": 4}], ["latency_ms"]),
])
@pytest.mark.parametrize("key_mode", [False, True])
def test_new_list_facets(logged_in, runner, name, path, v1, body, values, key_mode):
    with respx.mock as mock:
        mock.get(f"{BASE}{v1 if key_mode else path}").respond(200, json=body)
        result = runner.invoke(app, ["--json", *(["--api-key", "k"] if key_mode else []), "list", name])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"kind": name, "values": values}


def test_sessions_import_gzips_and_shares_one_cutoff(logged_in, runner, tmp_path):
    first, second = tmp_path / "proj" / "s1.jsonl", tmp_path / "proj" / "s2.jsonl.gz"
    first.parent.mkdir()
    first.write_text('{"type":"user"}\n')
    second.write_bytes(gzip.compress(b'{"type":"user"}\n'))
    with respx.mock as mock:
        route = mock.post(f"{BASE}/api/events/import").respond(200, json={"sessions": 1})
        result = runner.invoke(app, ["--json", "sessions", "import", str(first), str(second),
                                     "--format", "claude", "--env", "dev", "--dry-run"])
    assert result.exit_code == 0, result.output
    assert len(route.calls) == 2
    a, b = (c.request for c in route.calls)
    assert gzip.decompress(a.content) == b'{"type":"user"}\n'
    assert gzip.decompress(b.content) == b'{"type":"user"}\n'
    assert a.headers["content-type"] == "application/octet-stream"
    assert a.url.params["path"] == "proj/s1.jsonl" and a.url.params["format"] == "claude"
    assert a.url.params["dry_run"] == "true" and a.url.params["environment"] == "dev"
    assert a.url.params["existing_before"] == b.url.params["existing_before"]
    out = json.loads(result.stdout)
    assert [f["file"] for f in out["files"]] == [str(first), str(second)]


def test_sessions_import_bad_format_and_missing_file(logged_in, runner, tmp_path):
    with respx.mock(assert_all_called=False):
        assert runner.invoke(app, ["sessions", "import", "x", "--format", "zip"]).exit_code == 2
        assert runner.invoke(app, ["sessions", "import", str(tmp_path / "none.jsonl")]).exit_code == 2


def test_sessions_list_still_works_as_a_group_callback(logged_in, runner):
    with respx.mock as mock:
        mock.get(f"{BASE}/api/sessions").respond(200, json={"sessions": [], "next_cursor": None})
        result = runner.invoke(app, ["--json", "sessions", "--limit", "5"])
    assert result.exit_code == 0, result.output


def test_deploy_backfill_allows_judge(logged_in, runner):
    with respx.mock as mock:
        mock.get(f"{BASE}/api/evaluator-definitions").respond(200, json=[])
        mock.post(f"{BASE}/api/evaluator-definitions").respond(201, json={"id": "d1"})
        backfill = mock.post(f"{BASE}/api/evaluations/backfill").respond(200, json={"enqueued": 2})
        result = runner.invoke(app, ["--json", "evaluators", "deploy", "relevance", "--judge",
                                     "--criteria", "Grade relevance", "--threshold", "0.7", "--backfill", "7d"])
    assert result.exit_code == 0, result.output
    assert json.loads(backfill.calls[0].request.content)["eval_key"] == "relevance"
    assert "model budget" in result.stderr


def test_usage_windows_needs_a_key(logged_in, runner):
    with respx.mock as mock:
        result = runner.invoke(app, ["--json", "usage", "windows"])
        assert not mock.calls
    assert result.exit_code == 2
