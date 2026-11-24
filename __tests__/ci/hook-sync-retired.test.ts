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
 * rebuilt: the daily integration-suite canary already catches the drift it
 * looked for, by driving every CLI @latest and asserting the deny.
 *
 * What this pins:
 *   - the agent's files are gone;
 *   - no workflow builds or pushes its image;
 *   - Claude Code runs with its permission checks off only where that was
 *     reviewed. Today that is the canary's probe alone, which drives fixed test
 *     prompts in a throwaway sandbox WITH failproofai's hooks installed: what it
 *     measures is that the hooks deny when nothing else would. Adding a file to
 *     that list deserves the scrutiny #1797 describes.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const WORKFLOWS = resolve(ROOT, ".github/workflows");

/**
 * Committed files matching `pattern` (extended regex), outside prose and tests.
 * Markdown is excluded because docs and the changelog describe the flag; this
 * directory is excluded because this file names it.
 */
function committedFilesMatching(pattern: string): string[] {
  const r = spawnSync(
    "git",
    [
      "grep", "-l", "-I", "-E", "-e", pattern, "--",
      ".", ":(exclude)*.md", ":(exclude)*.mdx", ":(exclude)__tests__/**",
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

  it("runs Claude Code with permission checks off only in the reviewed canary probe", () => {
    // Both spellings Claude Code accepts for "approve every tool call".
    const bypass = "--dangerously-skip-permissions|--permission-mode[= ]+[\"']?bypassPermissions";
    expect(committedFilesMatching(bypass)).toEqual(["integration-suite/probe-cli.sh"]);
  });
});
