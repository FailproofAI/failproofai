"""Syntax checking and the local policy runner.

The gap these close: nothing between an author and a fleet parsed policy source.
The CLI rejected a NUL byte, the server checked the id and a size ceiling, and a
file that was not JavaScript at all published, deployed, and failed on the
machine at enforcement time.

Every test here needs `node`, so each skips without it rather than failing —
node is a real dependency of the check but deliberately not of the CLI.
"""
from __future__ import annotations

import pytest

from fp_cli.policy_check import check_syntax, node_available, run_policy

needs_node = pytest.mark.skipif(not node_available(), reason="node is not on PATH")

VALID = '''import { customPolicies, allow, deny, instruct } from "failproofai";
customPolicies.add({
  name: "t", description: "d", match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    const cmd = String(ctx.toolInput?.command ?? "");
    if (cmd.includes("force")) return deny("nope");
    if (cmd.includes("apply")) return instruct("add a note");
    return allow();
  },
});'''


# ── syntax ───────────────────────────────────────────────────────────────────


@needs_node
def test_a_real_policy_parses():
    r = check_syntax(VALID)
    assert r.ok and r.checked and r.message == ""


@needs_node
@pytest.mark.parametrize("src,label", [
    ("this is not javascript at all {{{", "prose"),
    ("export default { name: 'x'", "unclosed brace"),
    ("const x = ;", "bad expression"),
    ("# python comment\nprint('hi')", "python"),
    ("function f( {", "unclosed paren"),
])
def test_broken_source_is_caught(src, label):
    r = check_syntax(src)
    assert r.ok is False and r.checked is True, label
    assert r.message, "a refusal with no explanation is not a refusal"


@needs_node
def test_esm_import_syntax_is_accepted():
    """Policies are ESM. Checking them as a script would reject every real one."""
    assert check_syntax('import { deny } from "failproofai";\nexport const x = 1;').ok


@needs_node
def test_top_level_await_is_valid_in_a_module():
    assert check_syntax('const x = await Promise.resolve(1);\nexport default x;').ok


@needs_node
def test_the_error_keeps_the_caret_and_drops_nodes_own_stack():
    """The caret is the useful part; node's internal frames and version banner
    are node talking about itself inside an error about the user's policy."""
    msg = check_syntax("this is not javascript {{{").message
    assert "^" in msg
    assert "node:internal" not in msg and "Node.js v" not in msg


def test_a_missing_node_is_reported_as_unchecked_not_as_passing(monkeypatch):
    """"we did not look" must never render as "we looked and it passed"."""
    monkeypatch.setattr("fp_cli.policy_check.node_available", lambda: False)
    r = check_syntax("anything at all")
    assert r.ok is True and r.checked is False and "node" in r.message


# ── running ──────────────────────────────────────────────────────────────────


@needs_node
@pytest.mark.parametrize("cmd,expected", [
    ("git push --force origin main", "deny"),
    ("kubectl apply -f x.yaml", "instruct"),
    ("git status", "allow"),
])
def test_the_policy_decides_per_input(cmd, expected):
    run = run_policy(VALID, tool="Bash", command=cmd)
    assert run.ok and run.decision == expected


@needs_node
def test_the_bare_failproofai_import_resolves():
    """The file under test is byte-identical to the one that gets published, so
    its bare specifier has to resolve the way node resolves it in production."""
    assert run_policy(VALID, command="git status").ok


@needs_node
def test_the_strictest_decision_wins():
    """One refusal is a refusal regardless of what the other policies said."""
    two = VALID + '''
customPolicies.add({ name: "always-allow", match: { events: ["PreToolUse"] },
  fn: async () => allow() });'''
    run = run_policy(two, command="git push --force x")
    assert run.decision == "deny" and len(run.results) == 2


@needs_node
def test_a_file_registering_nothing_says_so():
    """An empty result is not an allow — it means the file never called add()."""
    run = run_policy('export const x = 1;')
    assert run.ok is False and "registered no policies" in run.error


@needs_node
def test_a_policy_that_throws_is_reported_per_policy_not_as_a_crash():
    boom = '''import { customPolicies } from "failproofai";
customPolicies.add({ name: "boom", fn: async () => { throw new Error("kaboom"); } });'''
    run = run_policy(boom, command="x")
    assert run.ok and "kaboom" in run.results[0]["error"]


@needs_node
def test_an_infinite_loop_times_out_instead_of_hanging():
    """A policy that cannot decide in five seconds cannot sit on a hook either."""
    spin = '''import { customPolicies } from "failproofai";
customPolicies.add({ name: "spin", fn: async () => { while (true) {} } });'''
    run = run_policy(spin, command="x")
    assert run.ok is False and "finish" in run.error


@needs_node
def test_file_path_inputs_reach_the_policy():
    src = '''import { customPolicies, allow, deny } from "failproofai";
customPolicies.add({ name: "env", fn: async (ctx) =>
  /\\.env/.test(String(ctx.toolInput?.file_path ?? "")) ? deny("no") : allow() });'''
    assert run_policy(src, tool="Write", file_path=".env").decision == "deny"
    assert run_policy(src, tool="Write", file_path="README.md").decision == "allow"


def test_running_without_node_fails_loudly(monkeypatch):
    monkeypatch.setattr("fp_cli.policy_check.node_available", lambda: False)
    run = run_policy(VALID, command="x")
    assert run.ok is False and "node" in run.error


def test_a_slow_machine_is_not_reported_as_a_bad_policy(monkeypatch):
    """A syntax-check timeout says nothing about the source.

    `node --check` runs none of the policy, so a timeout is a statement about the
    machine, not the file. It used to share the EXECUTION budget (5s, sized so a
    looping policy fails instead of hanging) and report `ok=False` — which reads
    as "your policy is broken" and made `fp policies publish` refuse a perfectly
    good file because the box was busy. Seen on CI the moment the fp-cloud-cli matrix
    widened to four concurrent interpreters: three legs passed and the fourth
    timed out on this same source.

    `checked=False` is the honest verdict and the one `SyntaxResult` already
    models — the same shape as node being absent entirely.
    """
    import subprocess

    from fp_cli import policy_check

    def _timeout(*a, **kw):
        raise subprocess.TimeoutExpired(cmd="node", timeout=policy_check._SYNTAX_TIMEOUT_SECS)

    monkeypatch.setattr(policy_check, "node_available", lambda: True)
    monkeypatch.setattr(subprocess, "run", _timeout)

    result = check_syntax(VALID)
    assert result.ok is True, "a busy machine must not be reported as a syntax error"
    assert result.checked is False, "'we did not look' must never render as 'we looked and it passed'"
    assert "not checked" in result.message


def test_parsing_and_executing_have_separate_budgets():
    """The tight budget is a product statement about hook latency.

    It applies to running a policy, where an accidental infinite loop must fail
    the command rather than hang it. Parsing runs no user code, so nothing there
    can loop and the same number is only a cold-start race.
    """
    from fp_cli import policy_check

    assert policy_check._TIMEOUT_SECS == 5
    assert policy_check._SYNTAX_TIMEOUT_SECS > policy_check._TIMEOUT_SECS
