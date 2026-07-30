/**
 * The seven builtin policies that genuinely need the host — 7 of 39.
 *
 * These cannot run in the `sealed` tier and are not meant to. They spawn `git`
 * and `gh`, and one of them reads and writes a sidecar file next to the
 * session transcript. That is *why* the split exists: without it all 39
 * builtins share one module importing `node:child_process`, import-graph tier
 * derivation routes every one of them to `user-context`, and the sealed tier is
 * empty while looking implemented.
 *
 * Routing here is a capability statement, not a security downgrade. Results
 * combine `deny` over `instruct` over `allow`, so a `user-context` policy can
 * only ever tighten a sealed verdict — never relax one.
 *
 * The registry that names, describes, and orders all 39 stays in
 * `../builtin-policies.ts`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { execSync, execFileSync } from "node:child_process";
import type { PolicyContext, PolicyResult } from "../policy-types";
import { allow, deny, instruct } from "../policy-helpers";
import { getCommand } from "./shared";

// blockWorkOnMain
const GIT_COMMIT_MERGE_RE = /git\s+(commit|merge|rebase|cherry-pick)\b/;

// Caches the current branch per cwd to avoid repeated execSync calls.
// Trade-off: if the user switches branches externally mid-session, the cache serves
// the stale value until the process restarts. This is acceptable since branch switches
// during an active Claude session are rare.
const gitBranchCache = new Map<string, string>();

/** Clears the git branch cache. Exposed for test isolation only. */
export function clearGitBranchCache(): void {
  gitBranchCache.clear();
}

function getCurrentBranch(cwd: string): string | null {
  try {
    let branch = gitBranchCache.get(cwd);
    if (branch === undefined) {
      branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        timeout: 3000,
      }).trim();
      gitBranchCache.set(cwd, branch);
    }
    return branch || null;
  } catch {
    return null;
  }
}

function getHeadSha(cwd: string): string | null {
  try {
    const sha = execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

interface CiCheck {
  name: string;
  status: string;
  conclusion: string;
}

/** Fetch third-party check runs (non-GitHub-Actions) for a commit via the Checks API. */
function getThirdPartyCheckRuns(cwd: string, sha: string): CiCheck[] {
  try {
    const json = execFileSync(
      "gh",
      [
        "api",
        `repos/{owner}/{repo}/commits/${sha}/check-runs`,
        "--jq",
        '.check_runs | map(select(.app.slug != "github-actions")) | map({name: .name, status: .status, conclusion: (.conclusion // "")})',
      ],
      {
        cwd,
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      },
    ).trim();

    if (!json || json === "[]") return [];
    return JSON.parse(json) as CiCheck[];
  } catch {
    return [];
  }
}

/** Fetch commit statuses (legacy Status API) and normalize to CiCheck format. */
function getCommitStatuses(cwd: string, sha: string): CiCheck[] {
  try {
    const json = execFileSync(
      "gh",
      [
        "api",
        `repos/{owner}/{repo}/commits/${sha}/statuses`,
        "--jq",
        'map({name: .context, state: .state}) | unique_by(.name)',
      ],
      {
        cwd,
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      },
    ).trim();

    if (!json || json === "[]") return [];
    const statuses = JSON.parse(json) as Array<{ name: string; state: string }>;
    return statuses.map((s) => ({
      name: s.name,
      status: s.state === "pending" ? "in_progress" : "completed",
      conclusion: s.state === "pending" ? "" : s.state === "success" ? "success" : "failure",
    }));
  } catch {
    return [];
  }
}

export function blockWorkOnMain(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  const match = cmd.match(GIT_COMMIT_MERGE_RE);
  if (!match) return allow();

  const cwd = ctx.session?.cwd;
  if (!cwd) return allow();

  const branch = getCurrentBranch(cwd);
  if (!branch) return allow();

  const protectedBranches = ((ctx.params?.protectedBranches ?? ["main", "master"]) as string[]);
  if (protectedBranches.includes(branch)) {
    return deny(
      `Git ${match[1]} on ${branch} is blocked. Create a feature branch first.`,
    );
  }
  return allow();
}

// Maximum size of the per-session tool-call sidecar before we stop updating it.
// If exceeded, repeated-call detection degrades gracefully (allows through) rather
// than growing the file unboundedly.
const TOOL_CALL_TRACKER_MAX_BYTES = 65_536; // 64 KB

export async function warnRepeatedToolCalls(ctx: PolicyContext): Promise<PolicyResult> {
  const THRESHOLD = 3;
  const transcriptPath = ctx.session?.transcriptPath;
  if (!transcriptPath || !ctx.toolName || !ctx.toolInput) return allow();

  // Sidecar file tracks { fingerprint: count } — O(1) per call vs O(transcript) per call.
  const trackerPath = `${transcriptPath}.tool-calls.json`;
  const fingerprint = JSON.stringify({ tool: ctx.toolName, input: ctx.toolInput });

  let counts: Record<string, number> = {};
  try {
    const raw = await readFile(trackerPath, "utf8");
    counts = JSON.parse(raw) as Record<string, number>;
  } catch { /* first call or unreadable — start fresh */ }

  const prevCount = counts[fingerprint] ?? 0;
  if (prevCount >= THRESHOLD) {
    return instruct(
      `STOP: You have already called ${ctx.toolName} ${prevCount} times with identical parameters. This is wasteful and unproductive. Do NOT repeat this call — use a different approach or ask the user for clarification.`,
    );
  }

  counts[fingerprint] = prevCount + 1;
  try {
    const serialized = JSON.stringify(counts);
    if (serialized.length <= TOOL_CALL_TRACKER_MAX_BYTES) {
      await writeFile(trackerPath, serialized, "utf8");
    }
  } catch { /* non-fatal */ }

  return allow();
}

// -- Workflow (Stop event) policies --

/**
 * Claude Code plan mode (permission_mode: "plan") is research-and-plan-only — the
 * agent makes no commits, pushes, or PRs by design. The Stop-workflow gates below
 * all assume the agent produced code changes, so in plan mode they demand actions
 * plan mode forbids (e.g. a push with nothing to push). Skip them there. Only Claude
 * reports "plan" today; every other CLI resolves to "default".
 */
function isPlanMode(ctx: PolicyContext): boolean {
  return ctx.session?.permissionMode === "plan";
}

export function requireCommitBeforeStop(ctx: PolicyContext): PolicyResult {
  if (isPlanMode(ctx)) return allow("Plan mode — no changes made, skipping commit check.");
  const cwd = ctx.session?.cwd;
  if (!cwd) return allow("No working directory available, skipping commit check.");

  try {
    const status = execSync("git status --porcelain", {
      cwd,
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    if (status.length > 0) {
      return deny(
        "You have uncommitted changes in the working directory. Commit all changes now.",
      );
    }
    return allow("All changes are committed.");
  } catch {
    return allow("Not a git repository, skipping commit check.");
  }
}

export function requirePushBeforeStop(ctx: PolicyContext): PolicyResult {
  if (isPlanMode(ctx)) return allow("Plan mode — no changes made, skipping push check.");
  const cwd = ctx.session?.cwd;
  if (!cwd) return allow("No working directory available, skipping push check.");

  try {
    const remotes = execSync("git remote", {
      cwd,
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();

    if (!remotes) return allow("No git remote configured, skipping push check.");

    const remote = (ctx.params?.remote as string) ?? "origin";

    const branch = getCurrentBranch(cwd);
    if (!branch || branch === "HEAD") return allow("Detached HEAD, skipping push check.");

    const baseBranch = (ctx.params?.baseBranch as string) ?? "main";

    // If on the base branch itself, no push of a feature branch is needed
    if (branch === baseBranch) {
      return allow(`On base branch "${baseBranch}", skipping push check.`);
    }

    // Check if branch has diverged from base in any meaningful way
    try {
      const ahead = execFileSync(
        "git",
        ["log", `${remote}/${baseBranch}..HEAD`, "--oneline"],
        { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
      ).trim();

      if (!ahead) {
        // No commits ahead — branch is fully merged (regular merge / fast-forward)
        return allow(`No commits ahead of ${remote}/${baseBranch}, skipping push check.`);
      }

      // Commits exist but might be from a squash-merged PR.
      // Check actual file diff — if trees are identical, work is already in base.
      const diff = execFileSync(
        "git",
        ["diff", "--stat", `${remote}/${baseBranch}`, "HEAD"],
        { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
      ).trim();

      if (!diff) {
        return allow(`No file changes compared to ${remote}/${baseBranch}, skipping push check.`);
      }
    } catch {
      // remote/{baseBranch} ref missing — fall through to existing push checks
    }

    // Check if remote tracking branch exists
    let hasTracking = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", `${remote}/${branch}`], {
        cwd,
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        timeout: 3000,
      });
      hasTracking = true;
    } catch {
      // Remote tracking branch does not exist
    }

    if (!hasTracking) {
      return deny(
        `Branch "${branch}" has not been pushed to remote "${remote}". ` +
        `Run now: git push -u ${remote} ${branch}`,
      );
    }

    // Check for unpushed commits
    const unpushed = execFileSync("git", ["log", `${remote}/${branch}..HEAD`, "--oneline"], {
      cwd,
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    if (unpushed.length > 0) {
      const commitCount = unpushed.split("\n").length;
      return deny(
        `You have ${commitCount} unpushed commit${commitCount > 1 ? "s" : ""} on branch "${branch}". ` +
        `Run now: git push`,
      );
    }

    return allow(`All commits pushed to "${remote}".`);
  } catch {
    return allow("Could not check push status, skipping.");
  }
}

export function requirePrBeforeStop(ctx: PolicyContext): PolicyResult {
  if (isPlanMode(ctx)) return allow("Plan mode — no changes made, skipping PR check.");
  const cwd = ctx.session?.cwd;
  if (!cwd) return allow("No working directory available, skipping PR check.");

  try {
    // Check if gh CLI is available
    try {
      execSync("gh --version", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 });
    } catch {
      return allow("GitHub CLI (gh) not installed, skipping PR check.");
    }

    const branch = getCurrentBranch(cwd);
    if (!branch || branch === "HEAD") return allow("Detached HEAD, skipping PR check.");

    const baseBranch = (ctx.params?.baseBranch as string) ?? "main";

    // If on the base branch itself, no PR is needed
    if (branch === baseBranch) {
      return allow(`On base branch "${baseBranch}", skipping PR check.`);
    }

    // Check if branch has diverged from base in any meaningful way
    try {
      const ahead = execFileSync(
        "git",
        ["log", `origin/${baseBranch}..HEAD`, "--oneline"],
        { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
      ).trim();

      if (!ahead) {
        // No commits ahead — branch is fully merged (regular merge / fast-forward)
        return allow(`No commits ahead of origin/${baseBranch}, skipping PR check.`);
      }

      // Commits exist but might be from a squash-merged PR.
      // Check actual file diff — if trees are identical, work is already in main.
      const diff = execFileSync(
        "git",
        ["diff", "--stat", `origin/${baseBranch}`, "HEAD"],
        { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
      ).trim();

      if (!diff) {
        return allow(`No file changes compared to origin/${baseBranch}, skipping PR check.`);
      }
    } catch {
      // origin/{baseBranch} ref missing or git error — fall through to gh pr view
    }

    // Check if a PR exists for this branch
    let prJson: string;
    try {
      prJson = execSync("gh pr view --json number,url,state", {
        cwd,
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      }).trim();
    } catch {
      // gh pr view exits non-zero when no PR exists
      return deny(
        `No pull request found for branch "${branch}". ` +
        `Run now: gh pr create`,
      );
    }

    const pr = JSON.parse(prJson) as { number: number; url: string; state: string };

    if (pr.state === "OPEN") {
      return allow(`PR #${pr.number} exists: ${pr.url}`);
    }

    // Trust GitHub's authoritative state. Local-ref reconciliation can never
    // converge after squash-merge or rebase-merge (the original branch commit
    // is orphaned, never an ancestor of base) or when base is auto-modified
    // post-merge (e.g. release-workflow version bumps). The PR being MERGED
    // is itself the proof that the work shipped.
    if (pr.state === "MERGED") {
      return allow(
        `PR #${pr.number} was merged: ${pr.url}. ` +
        `Switch off this branch (e.g. 'git checkout ${baseBranch} && git pull') before stopping again.`,
      );
    }

    // Reaches here only for CLOSED-without-merge — PR was rejected.
    return deny(
      `Pull request for branch "${branch}" is ${pr.state.toLowerCase()}. Run now: gh pr create`,
    );
  } catch {
    return allow("Could not check PR status, skipping.");
  }
}

export function requireNoConflictsBeforeStop(ctx: PolicyContext): PolicyResult {
  if (isPlanMode(ctx)) return allow("Plan mode — no changes made, skipping conflict check.");
  const cwd = ctx.session?.cwd;
  if (!cwd) return allow("No working directory available, skipping conflict check.");

  const branch = getCurrentBranch(cwd);
  if (!branch || branch === "HEAD") return allow("Detached HEAD, skipping conflict check.");

  const baseBranch = (ctx.params?.baseBranch as string) ?? "main";
  if (branch === baseBranch) {
    return allow(`On base branch "${baseBranch}", skipping conflict check.`);
  }

  // -- Precheck: only enforce when an OPEN PR exists on GitHub. Without a
  // confirmable merge target there is nothing to enforce, so we skip both
  // the local merge-tree probe and the GitHub mergeability probe.
  try {
    execSync("gh --version", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 });
  } catch {
    return allow("gh CLI not installed, skipping conflict check.");
  }

  let prJson: string;
  try {
    prJson = execSync("gh pr view --json mergeable,number,url,state", {
      cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000,
    }).trim();
  } catch {
    return allow("No pull request found for branch, skipping conflict check.");
  }

  let pr: { mergeable: string; number: number; url: string; state: string };
  try {
    pr = JSON.parse(prJson);
  } catch {
    return allow("Could not parse gh pr view output, skipping conflict check.");
  }

  // GitHub stops computing mergeability for non-OPEN PRs (returns UNKNOWN forever).
  if (pr.state !== "OPEN") {
    return allow(`PR #${pr.number} is ${pr.state.toLowerCase()}; skipping conflict check.`);
  }

  // -- Layer 1: local git merge-tree --
  try {
    execFileSync("git", ["rev-parse", "--verify", `origin/${baseBranch}`], {
      cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000,
    });

    const ahead = execFileSync(
      "git", ["log", `origin/${baseBranch}..HEAD`, "--oneline"],
      { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
    ).trim();

    if (ahead) {
      execFileSync(
        "git",
        ["merge-tree", "--write-tree", "--name-only", `origin/${baseBranch}`, "HEAD"],
        { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 },
      );
    }
    // !ahead or merge-tree exit 0 → fall through to Layer 2
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer };
    if (e.status === 1) {
      // git merge-tree exit 1 = conflicts. stdout: <tree>\n<file>\n<file>\n\n<messages>
      const out = (typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf8") ?? "").trim();
      const lines = out.split("\n");
      const files: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === "") break;
        files.push(line);
      }
      const fileList = files.length ? files.join(", ") : "one or more files";
      return deny(
        `Branch "${branch}" has merge conflicts with ${baseBranch} in: ${fileList}. ` +
        `Rebase or merge origin/${baseBranch} now and resolve the conflicts.`,
      );
    }
    // any other failure (e.g. missing origin/<base>, log failure) → fall through
  }

  // -- Layer 2: GitHub PR mergeability (reuses pr from precheck) --
  if (pr.mergeable === "CONFLICTING") {
    return deny(
      `PR #${pr.number} has merge conflicts per GitHub (${pr.url}). ` +
      `Rebase or merge origin/${baseBranch} now and resolve the conflicts.`,
    );
  }
  if (pr.mergeable === "UNKNOWN") {
    return deny(
      `GitHub is still computing mergeability for PR #${pr.number} (${pr.url}). ` +
      `Wait ~10 seconds, then re-check with \`gh pr view --json mergeable\` before attempting to stop again.`,
    );
  }
  return allow(`PR #${pr.number} merges cleanly per GitHub.`);
}

export function requireCiGreenBeforeStop(ctx: PolicyContext): PolicyResult {
  if (isPlanMode(ctx)) return allow("Plan mode — no changes made, skipping CI check.");
  const cwd = ctx.session?.cwd;
  if (!cwd) return allow("No working directory available, skipping CI check.");

  try {
    // Check if gh CLI is available
    try {
      execSync("gh --version", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 });
    } catch {
      return allow("GitHub CLI (gh) not installed, skipping CI check.");
    }

    const branch = getCurrentBranch(cwd);
    if (!branch || branch === "HEAD") return allow("Detached HEAD, skipping CI check.");

    // Resolve HEAD up front — the workflow-runs filter below uses it to
    // ignore runs targeting prior commits on the same branch (otherwise a
    // stale failure on commit X is still reported after the fix on Y lands).
    // Third-party checks and commit statuses (queried by SHA below) already
    // scope to HEAD via getThirdPartyCheckRuns / getCommitStatuses.
    const sha = getHeadSha(cwd);

    // 1. GitHub Actions workflow runs (filtered to current HEAD, deduped by name)
    let workflowRuns: CiCheck[] = [];
    try {
      // --limit 20 (was 5): a busy branch can push the latest run for some
      // workflow out of the top-5 window after the SHA filter. 20 covers
      // ~4 commits worth of runs for a 5-workflow repo without being slow.
      const runsJson = execFileSync(
        "gh",
        ["run", "list", "--branch", branch, "--limit", "20", "--json", "status,conclusion,name,headSha"],
        { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
      ).trim();

      if (runsJson && runsJson !== "[]") {
        const allWorkflowRuns = JSON.parse(runsJson) as Array<CiCheck & { headSha?: string }>;
        // Filter to runs targeting the current HEAD commit only — not
        // historical runs for prior commits on the same branch. When `sha`
        // is unavailable (e.g. brand-new repo with no commits) fall back
        // to the unfiltered list so the policy still has something to act on.
        const headRuns = sha
          ? allWorkflowRuns.filter((r) => r.headSha === sha)
          : allWorkflowRuns;
        // Dedupe by workflow name, keeping the first occurrence (gh run list
        // returns newest-first). This handles GitHub's "Re-run all jobs" which
        // creates a fresh run record with the same name + headSha — without
        // dedupe the older failed record would still trip the deny.
        const seen = new Set<string>();
        workflowRuns = headRuns.filter((r) => {
          if (seen.has(r.name)) return false;
          seen.add(r.name);
          return true;
        });
      }
    } catch {
      // fail-open for workflow runs; continue to check third-party checks
    }

    // 2. Third-party check runs (CodeRabbit, SonarCloud, Codecov, etc.)
    let thirdPartyChecks: CiCheck[] = [];
    let commitStatuses: CiCheck[] = [];
    if (sha) {
      thirdPartyChecks = getThirdPartyCheckRuns(cwd, sha);
      commitStatuses = getCommitStatuses(cwd, sha);
    }

    // 3. Merge all checks
    const allChecks = [...workflowRuns, ...thirdPartyChecks, ...commitStatuses];

    if (allChecks.length === 0) return allow(`No CI runs found for branch "${branch}".`);

    const failing = allChecks.filter(
      (r) =>
        r.status === "completed" &&
        r.conclusion !== "success" &&
        r.conclusion !== "skipped" &&
        r.conclusion !== "cancelled" &&
        r.conclusion !== "neutral",
    );
    if (failing.length > 0) {
      const names = failing.map((r) => `"${r.name}"`).join(", ");
      return deny(
        `CI checks are failing on branch "${branch}": ${names}. Fix the failing checks now.`,
      );
    }

    const pending = allChecks.filter(
      (r) => r.status === "in_progress" || r.status === "queued" || r.status === "waiting",
    );
    if (pending.length > 0) {
      const names = pending.map((r) => `"${r.name}"`).join(", ");
      return deny(
        `CI checks are still running on branch "${branch}": ${names}. Wait for all checks to complete, then verify they pass.`,
      );
    }

    return allow(`All CI checks passed on branch "${branch}".`);
  } catch {
    return allow("Could not check CI status, skipping.");
  }
}

/**
 * The `user-context` tier, as data. See PAYLOAD_ONLY_POLICIES for the
 * counterpart and why both lists exist.
 */
export const HOST_ACCESS_POLICIES: ReadonlyArray<{
  name: string;
  fn: (ctx: PolicyContext) => PolicyResult | Promise<PolicyResult>;
}> = [
  { name: "block-work-on-main", fn: blockWorkOnMain },
  { name: "warn-repeated-tool-calls", fn: warnRepeatedToolCalls },
  { name: "require-commit-before-stop", fn: requireCommitBeforeStop },
  { name: "require-push-before-stop", fn: requirePushBeforeStop },
  { name: "require-pr-before-stop", fn: requirePrBeforeStop },
  { name: "require-no-conflicts-before-stop", fn: requireNoConflictsBeforeStop },
  { name: "require-ci-green-before-stop", fn: requireCiGreenBeforeStop },
];
