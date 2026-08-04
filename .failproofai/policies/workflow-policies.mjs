/**
 * workflow-policies.mjs — Convention-based workflow policies for this repo
 *
 * Automatically loaded from .failproofai/policies/ — no config changes needed.
 */
import { customPolicies, allow, instruct } from "failproofai";

/**
 * Match `<verb-phrase>` only when it appears at a command boundary (start of
 * string, `;`, `&&`, `||`, `|`, or newline). Avoids false-positive matches
 * when the literal phrase appears inside a HEREDOC or a quoted argument
 * (e.g. `gh pr edit --body "...gh pr create..."` would previously trigger
 * `release-prep-check` because the regex matched anywhere in the string).
 */
function matchesCommand(cmd, verbPhrasePattern) {
  return new RegExp(
    String.raw`(?:^|[;\n|]|&&|\|\|)\s*` + verbPhrasePattern + String.raw`\b`,
  ).test(cmd);
}

// Remind to update CHANGELOG before committing
customPolicies.add({
  name: "changelog-check",
  description: "Remind Claude to update CHANGELOG.md before committing",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolName !== "Bash") return allow();
    const cmd = String(ctx.toolInput?.command ?? "");
    if (matchesCommand(cmd, String.raw`git\s+commit`)) {
      return instruct(
        "Check whether CHANGELOG.md needs an update for this commit. " +
        "Every PR must include an entry under the current `## <version> — <YYYY-MM-DD>` section " +
        "(matching `version` in package.json + today's date). If that section does not exist yet, " +
        "create it above the previous version's section — there is no `## Unreleased` section. " +
        "Use the appropriate subsection: Features, Fixes, Docs, or Dependencies."
      );
    }
    return allow();
  },
});

// Remind to update docs, README, and examples before committing
customPolicies.add({
  name: "docs-check",
  description: "Remind Claude to update documentation, README, and examples if relevant",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolName !== "Bash") return allow();
    const cmd = String(ctx.toolInput?.command ?? "");
    if (matchesCommand(cmd, String.raw`git\s+commit`)) {
      return instruct(
        "Check whether documentation needs updating for this change. " +
        "Consider: docs/*.mdx files, README.md, and examples/ directory. " +
        "If you added or changed a feature, make sure the relevant docs reflect it."
      );
    }
    return allow();
  },
});

// Remind to update PR description if a PR is open
customPolicies.add({
  name: "pr-description-check",
  description: "Remind Claude to update the PR description after pushing",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolName !== "Bash") return allow();
    const cmd = String(ctx.toolInput?.command ?? "");
    if (matchesCommand(cmd, String.raw`git\s+push`)) {
      return instruct(
        "After pushing, check if there is an open PR for this branch. " +
        "If so, update the PR description to reflect the latest changes."
      );
    }
    return allow();
  },
});

// On `gh pr create`, instruct the agent to ensure CHANGELOG entries live
// under a versioned `## <version> — <date>` section so the PR ships
// release-ready. There is no `## Unreleased` section.
customPolicies.add({
  name: "release-prep-check",
  description:
    "On `gh pr create`, instruct the agent to ensure CHANGELOG entries are under a versioned `## <version> — <date>` section",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolName !== "Bash") return allow();
    const cmd = String(ctx.toolInput?.command ?? "");
    if (!matchesCommand(cmd, String.raw`gh\s+pr\s+create`)) return allow();
    return instruct(
      "Before creating the PR, ensure CHANGELOG.md entries land under a versioned section so the PR ships release-ready:\n" +
      "  1. Read `version` from package.json (e.g. `0.0.10-beta.10`).\n" +
      "  2. Ensure your changelog entries are under a `## <version> — <today's date in YYYY-MM-DD>` heading. If that heading does not exist yet, create it above the previous version's section. There is NO `## Unreleased` section — entries always go under a dated, versioned heading.\n" +
      "  3. If you are on a `luv-cut-X.Y.Z` branch, the cut PR handles version bump itself."
    );
  },
});
