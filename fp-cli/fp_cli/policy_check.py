"""Check a policy before it reaches a fleet.

Nothing between an author and a machine validates policy source today. The CLI
rejects a NUL byte, the server checks the id charset and a 1 MiB ceiling — and
neither looks at whether the file is parseable JavaScript at all. So this
publishes, deploys, and reaches every machine in the fleet:

    echo 'this is not javascript {{{' | fp policies publish broken

It then fails at enforcement time, on the machine, where nobody is watching.
That is the worst available place for a syntax error to surface, which is what
these two checks exist to move.

``check_syntax`` is the cheap one and runs before every publish. ``run_policy``
is the deliberate one behind ``fp policies test``: it actually executes the
policy against a context you describe, so an author — human or agent — can see
allow/deny/instruct before anyone's machine does.

Both shell out to ``node``. Neither makes it a hard dependency: a machine
without node still publishes, with a stated reason rather than a silent skip.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import re
import tempfile
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

#: Budget for EXECUTING a policy. Short on purpose: a policy with an accidental
#: infinite loop must fail the command instead of hanging it, and a policy that
#: cannot decide in five seconds cannot sit on a hook either. This is a product
#: statement about hook latency, so it stays tight.
_TIMEOUT_SECS = 5

#: Budget for PARSING one — `node --check`, which runs no user code at all.
#:
#: Separate from the number above because the reasoning above does not apply to
#: it: parsing is bounded work whose only real variable is how long a cold node
#: process takes to start, and that is a property of the machine, not of the
#: policy. Sharing the execution budget made the syntax check fail on a busy
#: runner and report `the syntax check timed out` — which reads as "your policy
#: is bad" for what is actually "this box was loaded". Seen on CI once the
#: fp-cli matrix widened to four concurrent interpreters: three legs passed and
#: the fourth timed out on the same source.
#:
#: Generous rather than tight, because nothing here can loop: if `node --check`
#: has not answered in thirty seconds, node is wedged and saying so is right.
_SYNTAX_TIMEOUT_SECS = 30

#: SGR escapes node emits around its stack frames.
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def node_available() -> bool:
    return shutil.which("node") is not None


@dataclass
class SyntaxResult:
    ok: bool
    #: None when the check could not run at all (no node). Distinct from `ok`,
    #: because "we did not look" must never render as "we looked and it passed".
    checked: bool
    message: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {"ok": self.ok, "checked": self.checked, "message": self.message}


def check_syntax(source: str) -> SyntaxResult:
    """Parse-check policy source with ``node --check``.

    Written to a ``.mjs`` file so node parses it as a module: policies are ESM
    (`import { deny } from "failproofai"`), and checking that as a script would
    reject every real policy for using `import`.
    """
    if not node_available():
        return SyntaxResult(
            ok=True, checked=False,
            message="node was not found on PATH, so the policy was not syntax-checked",
        )
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "policy.mjs")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(source)
        try:
            proc = subprocess.run(
                ["node", "--check", path],
                capture_output=True, text=True, timeout=_SYNTAX_TIMEOUT_SECS,
            )
        except subprocess.TimeoutExpired:
            # `checked=False`, not `ok=False`. A timeout here says nothing about
            # the SOURCE — `node --check` runs none of it — so reporting a syntax
            # failure blamed the user's policy for the machine being busy, and
            # `fp policies publish` refused a perfectly good file. "We could not
            # look" is the honest verdict, and it is the one `SyntaxResult`
            # already models: the same shape as node being absent entirely.
            return SyntaxResult(
                ok=True, checked=False,
                message=(
                    f"the syntax check did not finish within {_SYNTAX_TIMEOUT_SECS}s, "
                    "so the source was not checked"
                ),
            )
        except OSError as exc:
            return SyntaxResult(ok=True, checked=False,
                                message=f"could not run node ({exc}); source not checked")
    if proc.returncode == 0:
        return SyntaxResult(ok=True, checked=True)
    # node prints the offending line, a caret, the SyntaxError — and then its own
    # internal stack and version banner. The first three are the whole value of
    # the check; the rest is node talking about itself inside an error box about
    # the user's policy.
    raw = (proc.stderr or proc.stdout or "").strip().replace(path, "<policy>")
    # node colourises its stack frames, so the marker lines arrive with ANSI
    # prefixes and a plain startswith() sails straight past them. Strip escapes
    # before matching, and from the kept text too — this is going inside a box
    # the CLI is already styling.
    raw = _ANSI.sub("", raw)
    keep = []
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped.startswith("at ") or stripped.startswith("Node.js v"):
            break
        keep.append(line)
    detail = "\n".join(keep).strip() or raw
    return SyntaxResult(ok=False, checked=True, message=detail)


#: A stand-in for the `failproofai` package a policy imports. Policies are
#: authored against the real one; this provides the same three helpers and
#: collects what `customPolicies.add` registers, so a policy can be executed
#: without installing anything.
_SHIM = """\
export const allow = (reason) => reason ? { decision: "allow", reason } : { decision: "allow" };
export const deny = (reason) => ({ decision: "deny", reason });
export const instruct = (reason) => ({ decision: "instruct", reason });
export const registered = [];
export const customPolicies = { add: (p) => { registered.push(p); } };
export default { allow, deny, instruct, customPolicies };
"""

_RUNNER = """\
import { registered } from "failproofai";
import "./policy.mjs";

const ctx = JSON.parse(process.argv[2]);
const out = [];
for (const p of registered) {
  // The SAME filter the engine applies before it ever calls `fn`
  // (`src/hooks/policy-registry.ts`): a policy whose `match` does not cover this
  // event or this tool is never RUN on a real machine, so running it here and
  // folding its verdict into the overall decision reported a DENY the daemon
  // would never have produced. `--event`/`--tool` only shaped the synthetic ctx;
  // they did not gate registration. A `match: { events: ["PostToolUse"],
  // toolNames: ["Write"] }` policy printed a red DENY under the default
  // `--event PreToolUse`, and `--expect deny` passed in CI, while the machine
  // allowed the command.
  const m = p.match ?? {};
  const evs = m.events ?? [];
  const tools = m.toolNames ?? [];
  if (evs.length > 0 && !evs.includes(ctx.eventType)) {
    out.push({ name: p.name ?? "(unnamed)", description: p.description ?? null,
               decision: "skipped", reason: `match.events does not include ${ctx.eventType}` });
    continue;
  }
  if (tools.length > 0 && (!ctx.toolName || !tools.includes(ctx.toolName))) {
    out.push({ name: p.name ?? "(unnamed)", description: p.description ?? null,
               decision: "skipped", reason: `match.toolNames does not include ${ctx.toolName ?? "(none)"}` });
    continue;
  }
  try {
    const r = await p.fn(ctx);
    out.push({ name: p.name ?? "(unnamed)", description: p.description ?? null,
               decision: r?.decision ?? "allow", reason: r?.reason ?? null });
  } catch (e) {
    out.push({ name: p.name ?? "(unnamed)", error: String(e && e.message || e) });
  }
}
process.stdout.write(JSON.stringify({ policies: out }));
"""


@dataclass
class PolicyRun:
    ok: bool
    results: List[Dict[str, Any]]
    error: str = ""

    @property
    def decision(self) -> str:
        """The strictest decision any policy returned.

        deny beats instruct beats allow, because that is how a fleet of policies
        composes: one refusal is a refusal regardless of what the others said.
        """
        decisions = [r.get("decision") for r in self.results if "decision" in r]
        for level in ("deny", "instruct"):
            if level in decisions:
                return level
        return "allow"

    def to_dict(self) -> Dict[str, Any]:
        return {"ok": self.ok, "decision": self.decision,
                "policies": self.results, "error": self.error}


def run_policy(
    source: str,
    *,
    tool: str = "Bash",
    command: Optional[str] = None,
    file_path: Optional[str] = None,
    event: str = "PreToolUse",
    tool_input: Optional[Dict[str, Any]] = None,
) -> PolicyRun:
    """Execute a policy against one synthetic context and report each verdict.

    Runs in a temp directory with the shim beside it, so the policy's
    `import ... from "failproofai"` resolves without a node_modules anywhere.
    Nothing is installed and nothing outside the temp directory is written.

    This is a DRY RUN, not the enforcement path: it proves the policy parses,
    registers, and returns a decision for the input described. It cannot prove
    the daemon will feed it the same context.
    """
    if not node_available():
        return PolicyRun(ok=False, results=[],
                         error="node was not found on PATH, so the policy could not be run")

    payload: Dict[str, Any] = dict(tool_input or {})
    if command is not None:
        payload.setdefault("command", command)
    if file_path is not None:
        payload.setdefault("file_path", file_path)
    ctx = {"eventType": event, "toolName": tool, "toolInput": payload, "payload": payload}

    with tempfile.TemporaryDirectory() as tmp:
        # The shim goes in `node_modules/failproofai/` rather than beside the
        # policy, so the bare specifier a real policy writes —
        # `import { deny } from "failproofai"` — resolves by node's ordinary
        # lookup. The policy under test is then byte-identical to the one that
        # gets published; an import map would have meant testing a rewritten
        # file, and import-map support also varies by node version.
        pkg = os.path.join(tmp, "node_modules", "failproofai")
        os.makedirs(pkg)
        with open(os.path.join(pkg, "package.json"), "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"name": "failproofai", "version": "0.0.0",
                                 "type": "module", "main": "index.mjs",
                                 "exports": "./index.mjs"}))
        with open(os.path.join(pkg, "index.mjs"), "w", encoding="utf-8") as fh:
            fh.write(_SHIM)
        for name, body in (("policy.mjs", source), ("run.mjs", _RUNNER)):
            with open(os.path.join(tmp, name), "w", encoding="utf-8") as fh:
                fh.write(body)
        with open(os.path.join(tmp, "package.json"), "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "module"}))
        try:
            proc = subprocess.run(
                ["node", "run.mjs", json.dumps(ctx)],
                cwd=tmp, capture_output=True, text=True, timeout=_TIMEOUT_SECS,
            )
        except subprocess.TimeoutExpired:
            return PolicyRun(ok=False, results=[],
                             error=f"the policy did not finish within {_TIMEOUT_SECS}s")
        except OSError as exc:
            return PolicyRun(ok=False, results=[], error=f"could not run node: {exc}")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        return PolicyRun(ok=False, results=[],
                         error="\n".join(detail[:6]) or "the policy failed to run")
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return PolicyRun(ok=False, results=[], error="the policy produced no readable result")

    results = data.get("policies") or []
    if not results:
        return PolicyRun(
            ok=False, results=[],
            error=("the file registered no policies — a policy calls "
                   "`customPolicies.add({...})`; check it does, and that the call runs "
                   "at import time"),
        )
    return PolicyRun(ok=True, results=results)
