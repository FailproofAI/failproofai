"""FailproofAI Cloud Jev / regex / both policies in `fp` (CONTRACT C4, C6).

`fp policies publish --kind regex|jev|both [--source] [--semantic]`, list/show
carrying the kind and the Jev check names, `fp fleet deploy --jev-mode`, and
machines showing the policy errors they report.
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx

from fp_cli import client
from fp_cli.app import app
from fp_cli.enforcement import (
    RefUsageError,
    parse_semantic,
    plan_deploy,
    resolve_kind,
    version_kinds,
)
from fp_cli.models import Deployment, Machine, PolicyRef, PolicyVersion

BASE = "http://dash.test"
FIXTURES = Path(__file__).resolve().parents[2] / "__tests__" / "fixtures" / "cloud-jev"
VALID = json.loads((FIXTURES / "semantic-valid.json").read_text())

DECL = {
    "name": "acme-prod-db",
    "title": "Tried to write to the production database",
    "appliesTo": ["shell"],
    "mode": "deny",
    "userCanOverride": True,
    "probes": [{"id": "writes", "instructions": "It writes.", "criteria": {"true": "yes", "false": "no"}}],
    "guidance": "Ask first.",
}

SERVER_BOTH = {
    "id": "no-prod-db", "version": 3, "description": "prod db guard", "sha256": "a" * 64,
    "source": "export default 1;", "createdAt": "2026-09-30T00:00:00Z", "createdBy": "me@test",
    "disabled": False, "archived": False, "kind": "both", "semantic": [DECL],
    "semanticSha256": "b" * 64, "authority": "reviewable", "reviewedBy": ["acme-prod-db"],
}
SERVER_JEV = {
    "id": "secrets", "version": 1, "description": "", "sha256": "", "source": None,
    "createdAt": "2026-09-30T00:00:00Z", "createdBy": "me@test", "disabled": False,
    "archived": False, "kind": "jev", "semantic": [dict(DECL, name="acme-secrets")],
    "semanticSha256": "c" * 64,
}
SERVER_REGEX_OLD = {
    "id": "no-force-push", "version": 2, "description": "", "sha256": "d" * 64,
    "source": "export default 2;", "createdAt": "2026-09-01T00:00:00Z", "createdBy": None,
    "disabled": False, "archived": False,
}


# ── models ────────────────────────────────────────────────────────────────────


def test_a_policy_version_carries_its_kind_and_jev_checks():
    both = PolicyVersion.from_dict(SERVER_BOTH)
    assert (both.kind, both.jev_names, both.authority, both.reviewed_by) == (
        "both", ["acme-prod-db"], "reviewable", ["acme-prod-db"])
    out = both.to_dict()
    assert out["kind"] == "both" and out["semantic"] == [DECL]
    assert out["semanticSha256"] == "b" * 64 and out["reviewedBy"] == ["acme-prod-db"]


def test_a_version_from_a_server_that_predates_kinds_is_regex():
    old = PolicyVersion.from_dict(SERVER_REGEX_OLD)
    assert old.kind == "regex" and old.jev_names == [] and old.semantic is None
    out = old.to_dict()
    assert out["kind"] == "regex"
    assert "semantic" not in out and "reviewedBy" not in out and "authority" not in out


def test_machines_carry_policy_errors_and_jev_mode_only_when_reported():
    reported = Machine.from_dict({
        "machineId": "m1", "policyErrors": [{"id": "p", "version": 1, "kind": "jev", "message": "bad"}],
        "policyErrorsAt": "2026-09-30T01:00:00Z", "jevMode": "observe",
    })
    assert reported.policy_errors == [{"id": "p", "version": 1, "kind": "jev", "message": "bad"}]
    assert reported.jev_mode == "observe"
    d = reported.to_dict()
    assert d["policyErrors"][0]["message"] == "bad" and d["jevMode"] == "observe"
    assert d["policyErrorsAt"] == "2026-09-30T01:00:00Z"

    quiet = Machine.from_dict({"machineId": "m2"})
    assert quiet.policy_errors is None and quiet.jev_mode is None
    assert not {"policyErrors", "policyErrorsAt", "jevMode"} & set(quiet.to_dict())


def test_a_deployment_carries_its_jev_mode():
    dep = Deployment.from_dict({"machineId": "m1", "deployment": 4, "policies": [], "jevMode": "enforce"})
    assert dep.jev_mode == "enforce" and dep.to_dict()["jevMode"] == "enforce"
    assert "jevMode" not in Deployment.from_dict({"machineId": "m1", "deployment": 4}).to_dict()


# ── kind + semantic (pure) ────────────────────────────────────────────────────


@pytest.mark.parametrize("kind,src,sem,expected", [
    (None, True, False, "regex"),
    (None, False, True, "jev"),
    (None, True, True, "both"),
    ("regex", True, False, "regex"),
    ("jev", False, True, "jev"),
    ("both", True, True, "both"),
])
def test_the_kind_follows_from_what_was_given(kind, src, sem, expected):
    assert resolve_kind(kind, has_source=src, has_semantic=sem) == expected


@pytest.mark.parametrize("kind,src,sem,needle", [
    ("regex", True, True, "takes no --semantic"),
    ("jev", True, True, "takes no JavaScript"),
    ("jev", False, False, "needs --semantic"),
    ("both", True, False, "needs --semantic"),
    ("hybrid", True, False, "not one of"),
])
def test_a_kind_that_contradicts_its_inputs_is_a_usage_error(kind, src, sem, needle):
    with pytest.raises(RefUsageError, match=needle):
        resolve_kind(kind, has_source=src, has_semantic=sem)


def test_semantic_accepts_the_contract_fixtures_and_a_wrapper():
    assert len(VALID) == 16
    assert parse_semantic(json.dumps(VALID)) == VALID
    assert parse_semantic(json.dumps({"semantic": VALID[:2]})) == VALID[:2]


@pytest.mark.parametrize("text,needle", [
    ("{not json", "not valid JSON"),
    (json.dumps({"name": "x"}), "JSON array"),
    ("[]", "no Jev declarations"),
    (json.dumps([DECL] * 25), "at most 24"),
    (json.dumps([{"title": "no name"}]), "#0 is not an object with a name"),
])
def test_semantic_refuses_what_is_not_a_declaration_list(text, needle):
    with pytest.raises(RefUsageError, match=needle):
        parse_semantic(text)


# ── deploy plan: --jev-mode ───────────────────────────────────────────────────


def _plan(**kw):
    base = dict(current=[PolicyRef("a", 1)], base=5, latest={"a": 1, "j": 2})
    base.update(kw)
    return plan_deploy("m1", **base)


def test_jev_mode_alone_is_a_change_and_is_carried_in_the_plan():
    plan = _plan(jev_mode="observe")
    assert not plan.is_noop and plan.jev_mode_changes
    assert plan.to_dict()["jevMode"] == {"from": "local", "to": "observe", "changed": True}


def test_the_same_jev_mode_again_is_a_noop():
    assert _plan(jev_mode="observe", current_jev_mode="observe").is_noop
    assert _plan(jev_mode="local").is_noop  # already local


def test_local_hands_the_mode_back_to_the_machine():
    plan = _plan(jev_mode="local", current_jev_mode="enforce")
    assert plan.jev_mode_changes and plan.jev_mode_after is None
    assert plan.to_dict()["jevMode"] == {"from": "enforce", "to": "local", "changed": True}


def test_no_jev_mode_says_nothing_and_changes_nothing():
    plan = _plan(add=["a"], current_jev_mode="enforce")
    assert plan.is_noop and "jevMode" not in plan.to_dict()


def test_an_unknown_jev_mode_is_a_usage_error():
    with pytest.raises(RefUsageError, match="not one of off, observe, enforce, local"):
        _plan(jev_mode="shadow")


def test_observe_on_a_jev_policy_is_refused_with_the_mode_that_does_it():
    kinds = version_kinds([PolicyVersion.from_dict(dict(SERVER_JEV, id="j", version=2))])
    with pytest.raises(RefUsageError, match="use --jev-mode observe"):
        _plan(add=["j:observe"], kinds=kinds)
    # enforce is fine, and so is observe on a `both` policy (it applies to the JS half).
    assert _plan(add=["j"], kinds=kinds).added[0].effect == "enforce"
    both = version_kinds([PolicyVersion.from_dict(dict(SERVER_BOTH, id="j", version=2))])
    assert _plan(add=["j:observe"], kinds=both).added[0].effect == "observe"


# ── the wire ──────────────────────────────────────────────────────────────────


def test_publish_sends_kind_and_semantic_and_no_source_for_jev(monkeypatch):
    sent = []
    monkeypatch.setattr(client, "_post_json", lambda ctx, path, body=None: sent.append(body) or {})
    client.publish_policy(None, "secrets", None, "d", kind="jev", semantic=[DECL])
    assert sent[-1] == {"id": "secrets", "description": "d", "kind": "jev", "semantic": [DECL]}

    client.publish_policy(None, "p", "export default 1;", "")
    assert sent[-1] == {"id": "p", "description": "", "source": "export default 1;"}


def test_publish_still_refuses_jev_fields_in_the_javascript(monkeypatch):
    from fp_cli.errors import ApiError

    monkeypatch.setattr(client, "_post_json", lambda *a, **k: pytest.fail("reached the server"))
    src = 'semanticPolicies.add({ name: "x" });'
    with pytest.raises(ApiError) as exc:
        client.publish_policy(None, "p", src, "", kind="both", semantic=[DECL])
    assert "--kind both --semantic" in (exc.value.hint or "")


def test_deploy_sends_jev_mode_only_when_given(monkeypatch):
    bodies = []
    monkeypatch.setattr(client, "_request_json",
                        lambda ctx, method, path, json_body=None: bodies.append(json_body) or {})
    client.deploy_policies(None, "m1", [PolicyRef("a", 1)])
    client.deploy_policies(None, "m1", [PolicyRef("a", 1)], jev_mode="local")
    assert "jevMode" not in bodies[0]
    assert bodies[1]["jevMode"] == "local"


# ── the commands, over HTTP ───────────────────────────────────────────────────


@respx.mock
def test_publish_a_jev_policy_from_a_semantic_file(logged_in, runner, tmp_path):
    checks = tmp_path / "checks.json"
    checks.write_text(json.dumps([DECL]))
    route = respx.post(f"{BASE}/api/enforcement/policies").mock(
        return_value=httpx.Response(200, json=dict(SERVER_JEV, id="prod-db-intent", semantic=[DECL])))
    respx.get(f"{BASE}/api/enforcement/deployments").mock(return_value=httpx.Response(200, json=[]))
    result = runner.invoke(app, ["--json", "policies", "publish", "prod-db-intent", "--semantic", str(checks)])
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body == {"id": "prod-db-intent", "description": "", "kind": "jev", "semantic": [DECL]}
    out = json.loads(result.stdout)
    assert out["kind"] == "jev" and out["syntax"]["checked"] is False


@respx.mock
def test_publish_both_sends_the_source_and_the_declarations(logged_in, runner, tmp_path):
    rule = tmp_path / "rule.mjs"
    rule.write_text('import { customPolicies, allow } from "failproofai";\n')
    checks = tmp_path / "checks.json"
    checks.write_text(json.dumps([DECL]))
    route = respx.post(f"{BASE}/api/enforcement/policies").mock(
        return_value=httpx.Response(200, json=SERVER_BOTH))
    respx.get(f"{BASE}/api/enforcement/deployments").mock(return_value=httpx.Response(200, json=[]))
    result = runner.invoke(app, ["policies", "publish", "no-prod-db", "--kind", "both",
                                 "--source", str(rule), "--semantic", str(checks), "--no-verify"])
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["kind"] == "both" and body["semantic"] == [DECL] and "customPolicies" in body["source"]
    assert "acme-prod-db" in result.stdout and "both" in result.stdout


@respx.mock
def test_publish_jev_with_source_is_a_usage_error_before_anything_is_sent(logged_in, runner, tmp_path):
    rule = tmp_path / "rule.mjs"
    rule.write_text("export default 1;\n")
    checks = tmp_path / "checks.json"
    checks.write_text(json.dumps([DECL]))
    result = runner.invoke(app, ["policies", "publish", "x", "--kind", "jev",
                                 "--source", str(rule), "--semantic", str(checks)])
    assert result.exit_code == 2
    assert not respx.calls


@respx.mock
def test_list_and_show_print_the_kind_and_the_jev_names(logged_in, runner):
    respx.get(f"{BASE}/api/enforcement/policies").mock(
        return_value=httpx.Response(200, json=[SERVER_BOTH, SERVER_JEV, SERVER_REGEX_OLD]))
    respx.get(f"{BASE}/api/enforcement/deployments").mock(return_value=httpx.Response(200, json=[]))
    listed = runner.invoke(app, ["policies", "list"])
    assert listed.exit_code == 0, listed.output
    cells = [ln.strip().strip("│").strip() for ln in listed.stdout.splitlines()]
    rows = {c.split()[0]: c for c in cells if c[:1].isalpha()}
    assert "both" in rows["no-prod-db"] and "acme-prod-db" in rows["no-prod-db"]
    assert "jev" in rows["secrets"] and "acme-secrets" in rows["secrets"]
    assert "regex" in rows["no-force-push"]

    shown = runner.invoke(app, ["policies", "show", "secrets"])
    assert shown.exit_code == 0, shown.output
    assert "jev" in shown.stdout and "acme-secrets" in shown.stdout
    # The declarations themselves, printed where the JavaScript source is.
    assert '"name": "acme-secrets"' in shown.stdout + (shown.stderr or "")

    js = json.loads(runner.invoke(app, ["--json", "policies", "show", "no-prod-db"]).stdout)
    assert js["kind"] == "both" and js["reviewedBy"] == ["acme-prod-db"] and js["semantic"] == [DECL]


def test_a_version_carries_its_jev_question_chars_and_regex_has_none():
    jev = PolicyVersion.from_dict(dict(SERVER_JEV, jevChars=412))
    assert jev.jev_chars == 412 and jev.to_dict()["jevChars"] == 412
    regex = PolicyVersion.from_dict(dict(SERVER_REGEX_OLD, jevChars=None))
    assert regex.jev_chars is None and "jevChars" not in regex.to_dict()


@respx.mock
def test_list_and_show_print_the_jev_question_chars(logged_in, runner):
    respx.get(f"{BASE}/api/enforcement/policies").mock(return_value=httpx.Response(
        200, json=[dict(SERVER_JEV, jevChars=18653), dict(SERVER_REGEX_OLD, jevChars=None)]))
    respx.get(f"{BASE}/api/enforcement/deployments").mock(return_value=httpx.Response(200, json=[]))
    listed = runner.invoke(app, ["policies", "list"], env={"COLUMNS": "200"})
    assert listed.exit_code == 0, listed.output
    rows = {c.split()[0]: c for c in (ln.strip().strip("│").strip() for ln in listed.stdout.splitlines())
            if c[:1].isalpha()}
    assert "18,653 chars" in rows["secrets"]
    assert "chars" not in rows["no-force-push"]

    shown = runner.invoke(app, ["policies", "show", "secrets"], env={"COLUMNS": "200"})
    assert shown.exit_code == 0, shown.output
    assert "18,653 question chars" in shown.stdout


@respx.mock
def test_a_jev_budget_refusal_names_each_policys_share_largest_first(logged_in, runner):
    # The server's deploy 422 (CONTRACT C9.2): the message has the total, the
    # body lists every contributing version — which is what says what to drop.
    _fleet_routes([])
    refusal = {
        "error": "the Jev checks of this deployment are over the machine's question budget "
                 "(37756 of 27591 characters)",
        "code": "jev_budget_exceeded", "used": 37756, "budget": 27591,
        "policies": [{"id": "e2e-prod-db", "version": 1, "chars": 415},
                     {"id": "e2e-big", "version": 1, "chars": 18653},
                     {"id": "e2e-big2", "version": 1, "chars": 18688}],
    }
    respx.put(f"{BASE}/api/enforcement/deployments/m1").mock(return_value=httpx.Response(422, json=refusal))
    human = runner.invoke(app, ["fleet", "deploy", "m1", "--add", "secrets", "--yes"], env={"COLUMNS": "400"})
    assert human.exit_code == 1
    text = " ".join((human.output + (human.stderr or "")).split())
    assert "37756 of 27591" in text
    assert "e2e-big2@1 18,688 · e2e-big@1 18,653 · e2e-prod-db@1 415" in text

    js = runner.invoke(app, ["--json", "fleet", "deploy", "m1", "--add", "secrets", "--yes"])
    out = json.loads(js.stdout)
    assert out["status"] == 422
    assert out["hint"].startswith("Jev question characters per policy: e2e-big2@1 18,688")

    # Any other refusal carries no such line.
    respx.put(f"{BASE}/api/enforcement/deployments/m1").mock(return_value=httpx.Response(
        422, json={"error": "bad", "code": "jev_effect_unsupported"}))
    other = json.loads(runner.invoke(app, ["--json", "fleet", "deploy", "m1", "--add", "secrets", "--yes"]).stdout)
    assert "hint" not in other


def _fleet_routes(current_policies, jev_mode=None, errors=None):
    machine = {"machineId": "m1", "deployment": 5, "appliedDeployment": 5, "deployed": True}
    if errors is not None:
        machine["policyErrors"] = errors
    if jev_mode:
        machine["jevMode"] = jev_mode
    dep = {"machineId": "m1", "deployment": 5, "policies": current_policies}
    if jev_mode:
        dep["jevMode"] = jev_mode
    respx.get(f"{BASE}/api/enforcement/machines").mock(return_value=httpx.Response(200, json=[machine]))
    respx.get(f"{BASE}/api/enforcement/deployments").mock(return_value=httpx.Response(200, json=[dep]))
    respx.get(f"{BASE}/api/enforcement/policies").mock(
        return_value=httpx.Response(200, json=[SERVER_BOTH, SERVER_JEV, SERVER_REGEX_OLD]))


@respx.mock
def test_fleet_deploy_jev_mode_alone_changes_only_the_mode_through_its_own_route(logged_in, runner):
    # CONTRACT C9.1: a mode change sent as a deploy rewrote the set the CLI had
    # read — which leaves out disabled policies' assignments, so they were lost.
    _fleet_routes([{"id": "no-force-push", "version": 2, "effect": "enforce"}])
    deploy = respx.put(f"{BASE}/api/enforcement/deployments/m1")
    mode = respx.put(f"{BASE}/api/enforcement/deployments/m1/jev-mode").mock(return_value=httpx.Response(
        200, json={"machineId": "m1", "deployment": 6, "jevMode": "observe", "changed": True,
                   "policies": [{"id": "no-force-push", "version": 2, "effect": "enforce"}]}))
    result = runner.invoke(app, ["--json", "fleet", "deploy", "m1", "--jev-mode", "observe", "--yes"])
    assert result.exit_code == 0, result.output
    assert not deploy.called
    assert json.loads(mode.calls.last.request.content) == {"jevMode": "observe"}
    out = json.loads(result.stdout)
    assert out["applied"] is True and out["jevModeOnly"] is True
    assert out["plan"]["jevMode"]["to"] == "observe" and out["deployment"]["deployment"] == 6


@respx.mock
def test_fleet_deploy_adds_a_jev_policy_and_leaves_the_mode_alone_without_the_flag(logged_in, runner):
    _fleet_routes([], jev_mode="enforce")
    put = respx.put(f"{BASE}/api/enforcement/deployments/m1").mock(return_value=httpx.Response(
        200, json={"machineId": "m1", "deployment": 6, "jevMode": "enforce",
                   "policies": [{"id": "secrets", "version": 1, "effect": "enforce"}]}))
    result = runner.invoke(app, ["fleet", "deploy", "m1", "--add", "secrets", "--yes"])
    assert result.exit_code == 0, result.output
    assert json.loads(put.calls.last.request.content) == {
        "policies": [{"id": "secrets", "version": 1, "effect": "enforce"}]}


@respx.mock
def test_fleet_deploy_refuses_observe_on_a_jev_policy_before_writing(logged_in, runner):
    _fleet_routes([])
    put = respx.put(f"{BASE}/api/enforcement/deployments/m1")
    result = runner.invoke(app, ["fleet", "deploy", "m1", "--add", "secrets:observe", "--yes"])
    assert result.exit_code == 2
    assert "--jev-mode observe" in result.output + (result.stderr or "")
    assert not put.called


@respx.mock
def test_fleet_show_and_list_show_the_jev_mode_and_the_reported_errors(logged_in, runner):
    errors = [{"id": "secrets", "version": 1, "kind": "jev", "message": "not loaded: failed integrity verification"},
              {"id": "jevMode", "version": None, "kind": "daemon", "message": "jev_unconfigured"}]
    _fleet_routes([{"id": "secrets", "version": 1, "effect": "enforce"}], jev_mode="observe", errors=errors)
    shown = runner.invoke(app, ["fleet", "show", "m1"])
    assert shown.exit_code == 0, shown.output
    assert "jev mode" in shown.stdout and "observe" in shown.stdout and "set by FailproofAI Cloud" in shown.stdout
    assert "2 policy errors" in shown.stdout and "jev_unconfigured" in shown.stdout
    assert "failed integrity verification" in shown.stdout

    listed = runner.invoke(app, ["fleet", "list"])
    assert listed.exit_code == 0, listed.output
    assert "2 errors" in listed.stdout

    js = json.loads(runner.invoke(app, ["--json", "fleet", "show", "m1"]).stdout)
    assert js["machine"]["policyErrors"] == errors and js["machine"]["jevMode"] == "observe"
    assert js["deployment"]["jevMode"] == "observe"


# ── Review fixes: the Jev mode route (C9.1), rollback and history (m6), help (m7) ──


def _fleet_many(deployments, machines=None):
    """`deployments`: {machine_id: jev_mode or None}; machines default to the same ids."""
    ids = machines if machines is not None else list(deployments)
    respx.get(f"{BASE}/api/enforcement/machines").mock(return_value=httpx.Response(200, json=[
        {"machineId": m, "deployment": 5, "appliedDeployment": 5, "deployed": m in deployments} for m in ids]))
    deps = []
    for m, mode in deployments.items():
        d = {"machineId": m, "deployment": 5, "policies": [{"id": "no-force-push", "version": 2, "effect": "enforce"}]}
        if mode:
            d["jevMode"] = mode
        deps.append(d)
    respx.get(f"{BASE}/api/enforcement/deployments").mock(return_value=httpx.Response(200, json=deps))
    respx.get(f"{BASE}/api/enforcement/policies").mock(
        return_value=httpx.Response(200, json=[SERVER_BOTH, SERVER_JEV, SERVER_REGEX_OLD]))


def _mode_route(machine_id, mode, deployment=6, status=200):
    body = ({"machineId": machine_id, "deployment": deployment, "jevMode": None if mode == "local" else mode,
             "changed": True, "policies": []} if status == 200
            else {"error": f"machine {machine_id} has no deployment", "code": "no_deployment"})
    return respx.put(f"{BASE}/api/enforcement/deployments/{machine_id}/jev-mode").mock(
        return_value=httpx.Response(status, json=body))


def test_set_jev_mode_sends_only_the_mode(monkeypatch):
    seen = {}

    def fake(ctx, method, path, json_body=None, **kw):
        seen.update(method=method, path=path, body=json_body)
        return {"machineId": "m1", "deployment": 9, "jevMode": "enforce", "changed": False, "policies": []}

    monkeypatch.setattr(client, "_request_json", fake)
    dep, changed = client.set_jev_mode(object(), "m1", "enforce")
    assert seen == {"method": "PUT", "path": "/api/enforcement/deployments/m1/jev-mode", "body": {"jevMode": "enforce"}}
    assert (dep.deployment, dep.jev_mode, changed) == (9, "enforce", False)


@respx.mock
def test_fleet_deploy_jev_mode_on_a_machine_with_no_deployment_deploys_its_first(logged_in, runner):
    respx.get(f"{BASE}/api/enforcement/machines").mock(return_value=httpx.Response(
        200, json=[{"machineId": "m1", "deployment": None, "deployed": False}]))
    respx.get(f"{BASE}/api/enforcement/deployments").mock(return_value=httpx.Response(200, json=[]))
    respx.get(f"{BASE}/api/enforcement/policies").mock(return_value=httpx.Response(200, json=[SERVER_JEV]))
    mode = respx.put(f"{BASE}/api/enforcement/deployments/m1/jev-mode")
    deploy = respx.put(f"{BASE}/api/enforcement/deployments/m1").mock(return_value=httpx.Response(
        200, json={"machineId": "m1", "deployment": 1, "jevMode": "observe", "policies": []}))
    result = runner.invoke(app, ["--json", "fleet", "deploy", "m1", "--jev-mode", "observe", "--yes"])
    assert result.exit_code == 0, result.output
    assert not mode.called
    assert json.loads(deploy.calls.last.request.content) == {"policies": [], "jevMode": "observe"}


@respx.mock
def test_fleet_deploy_with_a_set_change_and_a_mode_still_deploys_both_together(logged_in, runner):
    _fleet_routes([{"id": "no-force-push", "version": 2, "effect": "enforce"}])
    mode = respx.put(f"{BASE}/api/enforcement/deployments/m1/jev-mode")
    deploy = respx.put(f"{BASE}/api/enforcement/deployments/m1").mock(return_value=httpx.Response(
        200, json={"machineId": "m1", "deployment": 6, "jevMode": "enforce", "policies": []}))
    result = runner.invoke(app, ["fleet", "deploy", "m1", "--add", "secrets", "--jev-mode", "enforce", "--yes"])
    assert result.exit_code == 0, result.output
    assert not mode.called
    assert json.loads(deploy.calls.last.request.content)["jevMode"] == "enforce"


@respx.mock
def test_fleet_jev_mode_sets_named_machines_and_skips_one_already_there(logged_in, runner):
    _fleet_many({"m1": None, "m2": "enforce", "m3": "observe"})
    r1, r2, r3 = _mode_route("m1", "enforce"), _mode_route("m2", "enforce"), _mode_route("m3", "enforce", 7)
    deploy = respx.put(f"{BASE}/api/enforcement/deployments/m1")
    result = runner.invoke(app, ["--json", "fleet", "jev-mode", "m1", "m2", "m3", "enforce"])
    assert result.exit_code == 0, result.output
    assert r1.called and r3.called and not r2.called and not deploy.called
    assert json.loads(r1.calls.last.request.content) == {"jevMode": "enforce"}
    out = json.loads(result.stdout)
    assert out["mode"] == "enforce" and out["applied"] is True
    rows = {r["machineId"]: r for r in out["machines"]}
    assert rows["m1"]["from"] == "local" and rows["m1"]["to"] == "enforce" and rows["m1"]["deployment"] == 6
    assert rows["m2"]["changed"] is False
    assert rows["m3"]["from"] == "observe" and rows["m3"]["deployment"] == 7


@respx.mock
def test_fleet_jev_mode_all_covers_every_machine_with_a_deployment_only(logged_in, runner):
    _fleet_many({"m1": "enforce", "m2": "off"}, machines=["m1", "m2", "m-new"])
    r1, r2 = _mode_route("m1", "local"), _mode_route("m2", "local")
    fresh = respx.put(f"{BASE}/api/enforcement/deployments/m-new/jev-mode")
    result = runner.invoke(app, ["fleet", "jev-mode", "--all", "local"])
    assert result.exit_code == 0, result.output
    assert r1.called and r2.called and not fresh.called
    assert json.loads(r1.calls.last.request.content) == {"jevMode": "local"}
    assert "enforce → local" in result.stdout and "off → local" in result.stdout


@respx.mock
def test_fleet_jev_mode_when_nothing_changes_writes_nothing(logged_in, runner):
    _fleet_many({"m1": "observe"})
    route = _mode_route("m1", "observe")
    result = runner.invoke(app, ["fleet", "jev-mode", "m1", "observe"])
    assert result.exit_code == 0, result.output
    assert not route.called
    assert "already has jev mode observe" in result.output + (result.stderr or "")


@pytest.mark.parametrize("argv, needle", [
    (["fleet", "jev-mode"], "pass the mode"),
    (["fleet", "jev-mode", "m1", "shadow"], "is not a Jev mode"),
    (["fleet", "jev-mode", "observe"], "name at least one machine"),
    (["fleet", "jev-mode", "--all", "m1", "observe"], "do not name machines"),
])
def test_fleet_jev_mode_usage_errors_exit_2_before_any_request(logged_in, runner, argv, needle):
    with respx.mock(assert_all_called=False) as mock:
        result = runner.invoke(app, argv)
        assert result.exit_code == 2, result.output
        assert needle in result.output + (result.stderr or "")
        assert not mock.calls


@respx.mock
def test_fleet_jev_mode_refuses_a_named_machine_with_no_deployment_before_writing(logged_in, runner):
    _fleet_many({"m1": None}, machines=["m1", "m2"])
    r1 = _mode_route("m1", "observe")
    result = runner.invoke(app, ["fleet", "jev-mode", "m1", "m2", "observe"])
    assert result.exit_code == 1, result.output
    text = result.output + (result.stderr or "")
    assert "m2 has no deployment" in text and "fp fleet deploy <machine> --jev-mode observe" in text
    assert not r1.called


@respx.mock
def test_fleet_jev_mode_goes_on_past_a_machine_that_fails_and_names_it(logged_in, runner):
    _fleet_many({"m1": None, "m2": None})
    _mode_route("m1", "observe", status=404)
    r2 = _mode_route("m2", "observe")
    result = runner.invoke(app, ["--json", "fleet", "jev-mode", "m1", "m2", "observe"])
    assert result.exit_code == 1, result.output
    assert r2.called
    # The result document, then the error document the exit code comes with.
    out, end = json.JSONDecoder().raw_decode(result.stdout)
    rows = {r["machineId"]: r for r in out["machines"]}
    assert "error" in rows["m1"] and rows["m2"]["deployment"] == 6 and out["applied"] is False
    assert "could not be changed on m1" in result.stdout[end:] + (result.stderr or "")


@respx.mock
def test_fleet_rollback_says_which_jev_mode_it_restores(logged_in, runner):
    _fleet_many({"m1": "off"})
    respx.get(f"{BASE}/api/enforcement/deployments/m1/history").mock(return_value=httpx.Response(200, json=[
        {"deployment": 5, "policies": [], "updatedAt": "2026-09-30T02:00:00Z", "jevMode": "off"},
        {"deployment": 3, "policies": [], "updatedAt": "2026-09-29T02:00:00Z", "jevMode": "enforce"},
    ]))
    respx.post(f"{BASE}/api/enforcement/deployments/m1/rollback").mock(return_value=httpx.Response(
        200, json={"machineId": "m1", "deployment": 6, "rolledBackFrom": 3, "policies": [], "jevMode": "enforce"}))
    human = runner.invoke(app, ["fleet", "rollback", "m1", "3", "--yes"])
    assert human.exit_code == 0, human.output
    text = human.output + (human.stderr or "")
    assert "jev mode" in text and "off → enforce" in text

    js = runner.invoke(app, ["--json", "fleet", "rollback", "m1", "3", "--yes"])
    assert js.exit_code == 0, js.output
    out = json.loads(js.stdout)
    assert out["jevMode"] == "enforce" and out["jevModeBefore"] == "off"


@respx.mock
def test_fleet_history_shows_each_generations_jev_mode_and_a_mode_only_change(logged_in, runner):
    _fleet_many({"m1": "observe"})
    pols = [{"id": "no-force-push", "version": 2, "effect": "enforce"}]
    respx.get(f"{BASE}/api/enforcement/deployments/m1/history").mock(return_value=httpx.Response(200, json=[
        {"deployment": 6, "policies": pols, "updatedAt": "2026-09-30T02:00:00Z", "jevMode": "observe"},
        {"deployment": 5, "policies": pols, "updatedAt": "2026-09-30T01:00:00Z"},
    ]))
    result = runner.invoke(app, ["fleet", "history", "m1"])
    assert result.exit_code == 0, result.output
    assert "jev" in result.stdout
    assert "local→observe" in result.stdout
    lines = [ln for ln in result.stdout.splitlines() if "#6" in ln or "#5" in ln]
    assert any("observe" in ln for ln in lines if "#6" in ln)
    assert any("local" in ln for ln in lines if "#5" in ln)


def test_the_help_says_enforce_blocks_and_that_the_mode_is_machine_wide(runner):
    for argv in (["fleet", "deploy", "--help"], ["fleet", "jev-mode", "--help"]):
        result = runner.invoke(app, argv)
        assert result.exit_code == 0, result.output
        flat = " ".join(result.stdout.split())
        assert "BLOCK" in flat, argv
        assert "installed" in flat and "pack" in flat, argv


# ── CONTRACT C10.6: Jev checks run on FailproofAI Cloud (help text only) ──────


@pytest.mark.parametrize(
    "argv",
    [
        ["fleet", "deploy", "--help"],
        ["fleet", "jev-mode", "--help"],
        ["policies", "publish", "--help"],
    ],
)
def test_the_help_says_jev_checks_run_on_cloud_and_nothing_is_installed(runner, argv):
    result = runner.invoke(app, argv)
    assert result.exit_code == 0, result.output
    flat = " ".join(result.stdout.split())
    assert "Jev checks run on FailproofAI Cloud; nothing is installed on the machine" in flat, argv
    # The on-machine delivery it replaced is not described any more.
    assert "puts its Jev checks on the machine" not in flat, argv
    assert "AgentEye" not in flat, argv


@pytest.mark.parametrize("argv", [["fleet", "show", "--help"], ["fleet", "jev-mode", "--help"]])
def test_the_help_names_the_reasons_a_machine_cannot_ask(runner, argv):
    flat = " ".join(runner.invoke(app, argv).stdout.split())
    assert "transcripts_disabled" in flat, argv
    if argv[1] == "show":
        assert "jev_unconfigured" in flat
        assert "jev_budget" in flat
        # Review M3 and the name-clash split: the machine's own reports.
        for code in ("jev_rate_limited", "jev_unavailable", "jev_name_clash"):
            assert code in flat
        # A machine no longer parses Jev checks, so it cannot fail to.
        assert "could not parse" not in flat
