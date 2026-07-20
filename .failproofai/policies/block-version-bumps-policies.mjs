/**
 * block-version-bumps-policies.mjs — Prevent feature PRs from bumping package.json's
 * `version` field. Only release-cut PRs (branch name `luv-cut-X.Y.Z`) may.
 *
 * Why: PR #270 merged with package.json at 0.0.13-beta.1 because two parallel
 * feature branches (#266 OpenCode, #267 Pi) had each been speculatively
 * bumping the version. Stacked progression:
 *
 *   #245 Cursor merged       0.0.10-beta.1
 *   Pi dev branch            0.0.10-beta.2
 *   OpenCode dev branch      0.0.11-beta.1
 *   Pi+OpenCode unify merge  0.0.12-beta.1
 *   Pi subscribe expand      0.0.13-beta.1
 *   #270 merged              0.0.13-beta.1
 *
 * PR #284 then over-corrected to 0.0.9-beta.3 (older than the published
 * 0.0.9), which broke release readiness. Fix is procedural: only the
 * release-cut PR touches the version.
 */
import { customPolicies, allow, deny } from "failproofai";
import { execSync } from "node:child_process";

const VERSION_KEY_RE = /["']version["']\s*:/;
// Standalone semver-quoted value: matches `"0.0.10-beta.0"` but NOT `"react": "0.0.10-beta.0"`
// (the surrounding key would prevent the ^ / $ anchors from matching). Range-prefixed
// dep versions like `"^1.2.3"` also fall through because the leading `"` is followed by `^`,
// not a digit. So a value-only Edit on the package's own version is the only thing this
// catches without false-positiving on dep edits.
const STANDALONE_SEMVER_VALUE_RE = /^["']\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?["']$/;
const PKG_JSON_PATH_RE = /(^|[\\/])package\.json$/;
const VERSION_CMD_RE = /\b(npm|yarn|pnpm|bun(?:\s+pm)?)\s+version\b/;
// Lookaheads catch both orderings: `sed -i 's/.../.../' package.json` AND
// `jq '.version="x"' package.json`. Both must appear within the same shell segment.
const VERSION_FILE_MUNGE_RE =
  /\b(sed|awk|jq)\b(?=[^|;&]*package\.json)(?=[^|;&]*\bversion\b)/;
const CUT_BRANCH_RE = /^luv-cut-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isOnCutBranch(cwd) {
  if (!cwd) return false;
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    return CUT_BRANCH_RE.test(branch);
  } catch {
    return false;
  }
}

function editTouchesVersion(oldStr, newStr) {
  const o = String(oldStr ?? "");
  const n = String(newStr ?? "");
  if (VERSION_KEY_RE.test(o) || VERSION_KEY_RE.test(n)) return true;
  // Value-only swap: both sides are bare semver-quoted values that differ.
  // Catches `Edit { old_string: '"0.0.9-beta.3"', new_string: '"0.0.10-beta.0"' }`.
  const trimO = o.trim();
  const trimN = n.trim();
  return (
    STANDALONE_SEMVER_VALUE_RE.test(trimO) &&
    STANDALONE_SEMVER_VALUE_RE.test(trimN) &&
    trimO !== trimN
  );
}

const DENY_REASON =
  "Modifying package.json version is reserved for release-cut PRs " +
  "(branch name pattern: luv-cut-X.Y.Z). Feature PRs must leave the version " +
  "field alone — speculative bumps stack across PRs and produce drift " +
  "(see PR #270, where the version jumped 0.0.10-beta.1 → 0.0.13-beta.1 because " +
  "two parallel feature branches each bumped independently, and PR #284 which " +
  "then over-corrected to 0.0.9-beta.3, older than the already-published 0.0.9). " +
  "If you're cutting a release, switch to a `luv-cut-X.Y.Z` branch first.";

customPolicies.add({
  name: "block-version-bumps",
  description:
    "Block agents from bumping package.json version outside of release-cut branches",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    const cwd = ctx.session?.cwd;

    if (ctx.toolName === "Bash") {
      const cmd = String(ctx.toolInput?.command ?? "");
      const hits = VERSION_CMD_RE.test(cmd) || VERSION_FILE_MUNGE_RE.test(cmd);
      if (!hits) return allow();
      if (isOnCutBranch(cwd)) return allow();
      return deny(DENY_REASON);
    }

    if (ctx.toolName === "Edit" || ctx.toolName === "MultiEdit" || ctx.toolName === "Write") {
      const filePath = String(ctx.toolInput?.file_path ?? "");
      if (!PKG_JSON_PATH_RE.test(filePath)) return allow();

      let touchesVersion = false;
      if (ctx.toolName === "Write") {
        touchesVersion = VERSION_KEY_RE.test(String(ctx.toolInput?.content ?? ""));
      } else if (ctx.toolName === "Edit") {
        touchesVersion = editTouchesVersion(ctx.toolInput?.old_string, ctx.toolInput?.new_string);
      } else {
        const edits = Array.isArray(ctx.toolInput?.edits) ? ctx.toolInput.edits : [];
        touchesVersion = edits.some((e) => editTouchesVersion(e?.old_string, e?.new_string));
      }

      if (!touchesVersion) return allow();
      if (isOnCutBranch(cwd)) return allow();
      return deny(DENY_REASON);
    }

    return allow();
  },
});
