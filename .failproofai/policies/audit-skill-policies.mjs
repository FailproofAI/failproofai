/**
 * audit-skill-policies.mjs — point the agent at the policy-author skill after
 * an audit run.
 *
 * A skill cannot invoke itself; it is pulled in when the model matches a
 * request against the skill description. That covers "fix these findings",
 * but not the case where the user just runs `failproofai audit` and looks at
 * the output. This closes that gap using failproofai's own policy engine.
 *
 * Repo scope on purpose: the policy-author skill lives in this repo's
 * .claude/skills/, so advertising it from other projects would point at
 * something that is not there.
 */
import { customPolicies, allow, instruct } from "failproofai";

customPolicies.add({
  name: "suggest-policy-author-after-audit",
  description: "After `failproofai audit`, point the agent at the policy-author skill",
  match: { events: ["PostToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolName !== "Bash") return allow();
    const command = String(ctx.toolInput?.command ?? "");

    // Match the audit subcommand only — not `policies`, `config`, or a bare
    // `--version`. Tolerates the npx / dev-hook / bare-binary invocations.
    if (!/\bfailproofai\b[^\n|;&]*\baudit\b/.test(command)) return allow();

    // `--help` is not a run, and there are no findings to triage.
    if (/\B--help\b|\B-h\b/.test(command)) return allow();

    return instruct(
      "An audit just ran. Findings are cached at ~/.failproofai/audit-dashboard.json " +
        "(the AuditResult is nested under `.result.results[]`). Use the policy-author " +
        "skill to triage them: enable builtins that already cover a finding, and author " +
        "custom policies only for what nothing covers. Re-read the live config rather " +
        "than trusting each finding's `enabledInConfig`, which is a stale snapshot.",
    );
  },
});
