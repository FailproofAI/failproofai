// @vitest-environment node
/**
 * The hook-sync agent stays retired (FailproofAI/agenteye#1797).
 *
 * `docker-hook-sync/` was a daily container that ran Claude Code headless with
 * `--dangerously-skip-permissions`, a GitHub write token and a Claude OAuth
 * token in its environment, and none of failproofai's own hooks. Its prompt had
 * it WebFetch upstream docs, one of them a third-party npm package's README,
 * and then edit the tool and event maps that decide whether a policy fires at
 * all. Whoever could edit that README could steer it into sending both tokens
 * out, or into opening a PR that quietly takes a tool out of enforcement.
 *
 * Nothing had run it since July, but `build-image.yml` still rebuilt the image
 * and pushed it, publicly, to ghcr.io every day. It was retired rather than
 * rebuilt.
 *
 * What this pins:
 *   - the agent's files are gone;
 *   - no workflow builds or pushes its image;
 *   - an agent is launched with its permission checks off only from files
 *     reviewed for it (REVIEWED_PERMISSION_BYPASS below).
 *
 * The last check reads command-line spellings only: the flag, and
 * `--permission-mode bypassPermissions` written as shell words or as an argv
 * array. An SDK option or a settings file that sets `bypassPermissions` is not
 * covered, because in this repo that string is mostly hook-payload data (the
 * dashboard, the permission-mode resolver, policy fixtures), which a text scan
 * cannot tell apart from a launch.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const WORKFLOWS = resolve(ROOT, ".github/workflows");
const THIS_FILE = "__tests__/ci/hook-sync-retired.test.ts";

/**
 * Files allowed to launch an agent with its permission checks off, and why.
 * A new entry deserves the scrutiny #1797 describes: an agent that approves its
 * own tool calls must not also read text other people control, or hold a token
 * that writes somewhere that matters.
 */
const REVIEWED_PERMISSION_BYPASS: Record<string, string> = {
  "integration-suite/probe-cli.sh":
    "the canary drives each CLI with fixed test prompts against a read-only " +
    "mount of the repo and pushes nothing to GitHub; it checks that failproofai " +
    "still denies when the CLI's own prompts are off",
};

/** Command-line ways to tell an agent to approve every tool call itself. */
const PERMISSION_BYPASS = [
  "--dangerously-skip-permissions", // Claude Code; Antigravity's `agy` takes the same flag
  "--permission-mode[= ]+[\"']?bypassPermissions", // shell words
  "--permission-mode[\"'][[:space:]]*,[[:space:]]*[\"']bypassPermissions", // argv array
].join("|");

/**
 * Committed files matching `pattern` (extended regex), outside prose. Markdown
 * is skipped because the docs and the changelog describe these flags, and this
 * file because it names them.
 */
function committedFilesMatching(pattern: string): string[] {
  const r = spawnSync(
    "git",
    [
      "grep", "-l", "-I", "-E", "-e", pattern, "--",
      ".", ":(exclude)*.md", ":(exclude)*.mdx", `:(exclude)${THIS_FILE}`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  // git grep exits 1 when nothing matches, and anything above that is an error
  // (not a git checkout, bad pathspec), which must not read as "no matches".
  if (r.status === 1) return [];
  if (r.status !== 0) throw new Error(`git grep failed (${r.status}): ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).sort();
}

describe("hook-sync agent stays retired (#1797)", () => {
  it("ships none of the agent's files", () => {
    const present = [
      "docker-hook-sync",
      "scripts/sync-agent-cli-harnesses-prompt.md",
      ".github/workflows/build-image.yml",
    ].filter((p) => existsSync(resolve(ROOT, p)));
    expect(present).toEqual([]);
  });

  it("no workflow builds or pushes the hook-sync image", () => {
    const offenders = readdirSync(WORKFLOWS)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .filter((f) =>
        /docker-hook-sync|ghcr\.io\/failproofai\/hook-sync\b/i.test(
          readFileSync(resolve(WORKFLOWS, f), "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("launches an agent with its permission checks off only from reviewed files", () => {
    expect(committedFilesMatching(PERMISSION_BYPASS)).toEqual(
      Object.keys(REVIEWED_PERMISSION_BYPASS).sort(),
    );
  });
});
