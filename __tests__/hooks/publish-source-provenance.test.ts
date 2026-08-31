// @vitest-environment node
//
// A pack's version names a commit, and that is a claim about the BYTES in the
// artifact — every file publish BUNDLES, not the checkout they happen to sit
// in. Three ways a source reached the artifact without reaching that commit
// were open at once: `.gitignore` hid a bundled file from the tree read so it
// counted as clean, the tag path checked only the ENTRY while publish bundles
// every discovered file, and the porcelain parser mangled any path git does
// not print plainly. `sourcesInHead` closes all three, and BOTH the sha path
// and the tag path run it, which is the property the last block here pins.
//
// Real temporary checkouts throughout, following publish-git-settling.test.ts:
// every one of these is about what git actually reports — an ignored file
// omitted from `status`, a NUL-separated path, a tag on HEAD — and a stubbed
// `git` would assert my idea of its output rather than its own.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runPublishCommand, versionFromCommit } from "@/src/hooks/pack-cli";

let work: string;
let prevCwd: string;
let prevDist: string | undefined;
let gitHome: string;
let prevConfigGlobal: string | undefined;
let prevConfigSystem: string | undefined;
let prevStdinTTY: boolean | undefined;
let prevStdoutTTY: boolean | undefined;

/** See the note in publish-authoring.test.ts: discovery needs a real dist. */
const REPO = resolve(__dirname, "..", "..");

/** A policy file that registers exactly one policy, named after the file. */
const policy = (name: string, extra = "") => `import { customPolicies, allow, deny } from "failproofai";
${extra}
customPolicies.add({
  name: "${name}",
  description: "guards ${name}",
  category: "Test",
  defaultEnabled: true,
  match: { events: ["PreToolUse"] },
  fn: async (ctx) =>
    String(ctx.toolInput?.command ?? "").includes("${name}") ? deny("no ${name}") : allow(),
});
`;

function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

function git(...args: string[]): string {
  return gitAt(work, ...args);
}

/** The manifest publish would upload, read back off disk. `dir` for the cases
 *  that publish from somewhere other than the fixture root — a linked worktree,
 *  a checkout reached through a symlink. */
function manifest(dir: string = work): {
  id: string;
  version: string;
  commit?: string;
  policies: Array<{ name: string }>;
} {
  return JSON.parse(readFileSync(join(dir, "dist-pack", "failproofai-pack.json"), "utf8"));
}

/** The three assets a release needs. None of them may exist after a refusal. */
const ASSETS = ["failproofai-pack.json", "failproofai-pack.mjs", "SHA256SUMS"];

/**
 * Whether git can see a committer identity.
 *
 * Pinned to a file this test owns rather than left to the machine's own
 * `~/.gitconfig`, for the reason publish-git-settling.test.ts gives: publish
 * spawns git with the ambient environment, so the settling paths would
 * otherwise pass or fail depending on whose checkout the suite runs in.
 */
function withIdentity(): void {
  writeFileSync(join(gitHome, "config"), "[user]\n\tname = Test\n\temail = test@example.com\n");
}

/** `publish` only carries the git work for a human at a terminal. */
function tty(on: boolean): void {
  (process.stdin as { isTTY?: boolean }).isTTY = on;
  (process.stdout as { isTTY?: boolean }).isTTY = on;
}

/** The paths a refusal named, which are printed absolute and two-space indented. */
function offending(lines: string[]): string[] {
  return lines.filter((l) => l.startsWith("  /"));
}

beforeAll(() => {
  if (!existsSync(join(REPO, "dist", "index.js"))) {
    execFileSync("bun", ["build", "--target=node", "--format=cjs", "--outfile", "dist/index.js", "src/index.ts"], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "inherit"],
    });
  }
}, 120_000);

beforeEach(() => {
  prevDist = process.env.FAILPROOFAI_DIST_PATH;
  process.env.FAILPROOFAI_DIST_PATH = join(REPO, "dist");
  // realpath because the refusal prints paths git resolved from
  // `rev-parse --show-toplevel`, and a tmpdir behind a symlink would make
  // those disagree with the ones this test builds with `join(work, …)`.
  work = realpathSync(mkdtempSync(join(tmpdir(), "fpai-prov-")));
  gitHome = realpathSync(mkdtempSync(join(tmpdir(), "fpai-gitcfg-")));
  prevConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  prevConfigSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = join(gitHome, "config");
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  withIdentity();
  prevCwd = process.cwd();
  process.chdir(work);
  prevStdinTTY = (process.stdin as { isTTY?: boolean }).isTTY;
  prevStdoutTTY = (process.stdout as { isTTY?: boolean }).isTTY;
});

afterEach(() => {
  if (prevDist === undefined) delete process.env.FAILPROOFAI_DIST_PATH;
  else process.env.FAILPROOFAI_DIST_PATH = prevDist;
  if (prevConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = prevConfigGlobal;
  if (prevConfigSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = prevConfigSystem;
  (process.stdin as { isTTY?: boolean }).isTTY = prevStdinTTY;
  (process.stdout as { isTTY?: boolean }).isTTY = prevStdoutTTY;
  process.chdir(prevCwd);
  rmSync(work, { recursive: true, force: true });
  rmSync(gitHome, { recursive: true, force: true });
});

/**
 * A committed checkout whose second policy file is hidden by `.gitignore`.
 *
 * Nothing here is unusual: a `.gitignore` wide enough to catch a policy file
 * — `*.local.mjs`, a `secrets` prefix, a stray `secret.mjs` line — is one edit
 * away in any pack repository, and the file is still discovered, still
 * bundled, and still shipped.
 */
function ignoredFixture(): void {
  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "p.mjs"), policy("visible"));
  writeFileSync(join(work, "secret.mjs"), policy("hidden"));
  writeFileSync(join(work, ".gitignore"), "secret.mjs\n");
  git("add", "-A");
  git("commit", "-qm", "init");
}

describe("a bundled source that .gitignore hides", () => {
  it("refuses, because a clean tree does not mean the bytes are in HEAD", async () => {
    // The whole shape of the bug in one assertion pair: `git status` reports
    // NOTHING — it omits ignored paths even with `--untracked-files=all` — so
    // the tree-wide read called this publishable, the file was bundled, and
    // the manifest recorded HEAD as the commit it came from. HEAD does not
    // contain it. Asking about the sources BY NAME is the only way to see it.
    tty(false);
    ignoredFixture();
    expect(git("status", "--porcelain")).toBe("");
    expect(git("ls-files", "secret.mjs")).toBe("");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/are not in it — ignored, or never committed/);
    // Exactly the one file, not just "at least" it. A check that condemned the
    // whole source set — every path measuring as outside the repository, say —
    // would satisfy a `toContain` and name a committed, clean `p.mjs` as
    // missing, which is a refusal nobody can act on.
    expect(offending(r.lines)).toEqual([`  ${join(work, "secret.mjs")}`]);
    // The remedy is the point of giving this its own refusal. `git add -A`,
    // which the generic dirty message recommends, does not add an ignored
    // file — so that advice would send somebody round the same loop forever.
    expect(r.lines.join("\n")).toMatch(/git add -f/);
    expect(r.lines.join("\n")).not.toMatch(/uncommitted changes/);
  }, 60_000);

  it("builds nothing, so there is no artifact left to upload by hand", async () => {
    // A refusal that still writes the three release assets is half a refusal:
    // the bytes are sitting in dist-pack with a manifest claiming a commit
    // that does not contain them, ready for anyone to attach to a release.
    tty(false);
    ignoredFixture();

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    for (const asset of ASSETS) {
      expect(existsSync(join(work, "dist-pack", asset))).toBe(false);
    }
  }, 60_000);

  it("is not rescued by the settling that runs at a terminal", async () => {
    // At a TTY publish carries the git work itself, and `settleGitState` reads
    // the tree the same way the old check did — so it finds nothing to commit
    // and hands back null. The refusal has to survive that, and the ignored
    // file must not be force-added behind the author's back: that is a decision
    // about a file they deliberately ignored, and it is theirs to make.
    tty(true);
    ignoredFixture();
    const head = git("rev-parse", "HEAD");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/git add -f/);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("ls-files", "secret.mjs")).toBe("");
  }, 60_000);

  it("still publishes under --version, recording NO commit", async () => {
    // The escape hatch every refusal names has to work, and the manifest must
    // then make no claim it cannot support: `commit` is written only when the
    // tree is clean, so an ignored source leaves it absent rather than
    // recording a HEAD that does not contain these bytes.
    tty(false);
    ignoredFixture();

    const r = await runPublishCommand(["--id", "me/x", "--version", "1.0.0", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(manifest().version).toBe("1.0.0");
    expect(manifest().commit).toBeUndefined();
    // And the ignored file really was going into the artifact, which is what
    // makes the refusal above necessary rather than pedantic. Without this the
    // whole block would pass against a publish that quietly skipped the file.
    expect(manifest().policies.map((p) => p.name).sort()).toEqual(["hidden", "visible"]);
  }, 60_000);

  it("says nothing about an ignored file that is not going into the artifact", async () => {
    // The check has to be scoped to the BUNDLED set, not to the folder. Naming
    // the entry publishes that file alone, so `secret.mjs` is not in the
    // artifact and its state is none of this command's business — an
    // implementation that scanned the directory instead would refuse a publish
    // that is entirely correct, and `--version` would be the only way out.
    tty(false);
    ignoredFixture();

    const r = await runPublishCommand([join(work, "p.mjs"), "--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(manifest().commit).toBe(git("rev-parse", "HEAD"));
    expect(manifest().policies.map((p) => p.name)).toEqual(["visible"]);
  }, 60_000);

  it("refuses one hidden by core.excludesFile just the same", async () => {
    // Ignore rules are not only `.gitignore`. A global excludes file is the
    // common way `*.local.*` and friends get hidden on a developer's machine,
    // and it is invisible in the checkout — so a check that read the repo's own
    // ignore file rather than asking git would pass this and ship the bytes.
    tty(false);
    writeFileSync(join(gitHome, "ignore"), "secret.mjs\n");
    writeFileSync(
      join(gitHome, "config"),
      "[user]\n\tname = Test\n\temail = test@example.com\n" +
        `[core]\n\texcludesFile = ${join(gitHome, "ignore")}\n`,
    );
    git("init", "-q", "-b", "main");
    writeFileSync(join(work, "p.mjs"), policy("visible"));
    writeFileSync(join(work, "secret.mjs"), policy("hidden"));
    git("add", "-A");
    git("commit", "-qm", "init");
    // Same starting point as the `.gitignore` fixture, reached a different way.
    expect(git("status", "--porcelain")).toBe("");
    expect(git("ls-files", "secret.mjs")).toBe("");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/are not in it — ignored, or never committed/);
    expect(offending(r.lines)).toEqual([`  ${join(work, "secret.mjs")}`]);
  }, 60_000);

  it("publishes at the sha once `git add -f` has put the file in a commit", async () => {
    // The remedy the refusal prints has to actually clear it. Ignore rules do
    // not apply to a TRACKED file, so once it is committed the by-name read
    // reports nothing and the sha path answers normally.
    tty(false);
    ignoredFixture();
    git("add", "-f", "secret.mjs");
    git("commit", "-qm", "force-add the ignored policy");
    const head = git("rev-parse", "HEAD");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(manifest().version).toBe(versionFromCommit(head));
    expect(manifest().commit).toBe(head);
    expect(manifest().policies.map((p) => p.name).sort()).toEqual(["hidden", "visible"]);
  }, 60_000);
});

describe("a tag names a commit, and every bundled file has to be in it", () => {
  beforeEach(() => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(work, "a.mjs"), policy("alpha"));
    writeFileSync(join(work, "b.mjs"), policy("beta"));
    git("add", "-A");
    git("commit", "-qm", "init");
    git("tag", "v2.1.0");
  });

  it("uses the tag when every discovered file is in it", async () => {
    // The case the tag exists for, kept alongside the refusals so a check that
    // over-fires is as visible as one that under-fires. Somebody who tagged
    // v2.1.0 has SAID what this release is, and nothing here contradicts them.
    tty(false);

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(manifest().version).toBe("v2.1.0");
    expect(manifest().commit).toBe(git("rev-parse", "HEAD"));
    // Both files really are in the artifact, which is what makes the two
    // refusals below about the SET rather than about the entry. Without this
    // the block would read the same against a publish that bundled `a.mjs`
    // alone — and then checking only the entry would have been correct.
    expect(manifest().policies.map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
  }, 60_000);

  it("refuses when a SIBLING of the entry is modified", async () => {
    // The finding. `inferTaggedVersion` checked the ENTRY's status and nothing
    // else, while publish bundles every discovered file — so a tagged commit, a
    // clean `a.mjs` and an edited `b.mjs` shipped b's edits under a tag naming a
    // commit without them, and two artifacts then claim one version.
    tty(false);
    writeFileSync(join(work, "b.mjs"), policy("beta") + "\n// edited\n");
    // The entry is spotless, which is exactly why the old check passed.
    expect(git("status", "--porcelain", "--", "a.mjs")).toBe("");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/these policy files differ from it/);
    // The sibling and nothing else. `a.mjs` is committed and untouched, so a
    // refusal naming it too would be telling the author to fix a file that has
    // nothing wrong with it.
    expect(offending(r.lines)).toEqual([`  ${join(work, "b.mjs")}`]);
    // Not the tag, and not the sha either. A fallback would be no better here:
    // the sha names the same commit the tag does, and these bytes are not in
    // it under either name, so the only correct answer is to build nothing.
    expect(r.lines.join("\n")).not.toMatch(/v2\.1\.0/);
    expect(r.lines.join("\n")).not.toContain(versionFromCommit(git("rev-parse", "HEAD")));
    expect(existsSync(join(work, "dist-pack", "failproofai-pack.json"))).toBe(false);
  }, 60_000);

  it("refuses when a sibling is UNTRACKED", async () => {
    // The other way a bundled source is absent from the tagged commit: never
    // added at all. Discovery reads the DIRECTORY, so `c.mjs` is found and
    // bundled the moment it is written — the tag has no idea it exists.
    tty(false);
    writeFileSync(join(work, "c.mjs"), policy("gamma"));
    expect(git("status", "--porcelain", "--", "a.mjs", "b.mjs")).toBe("");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/are not in it — ignored, or never committed/);
    expect(offending(r.lines)).toEqual([`  ${join(work, "c.mjs")}`]);
    expect(r.lines.join("\n")).not.toMatch(/v2\.1\.0/);
    expect(existsSync(join(work, "dist-pack", "failproofai-pack.json"))).toBe(false);
  }, 60_000);

  it("refuses a source that is staged but has never been committed", async () => {
    // `ls-files` would answer yes for this file — it is in the index — and the
    // artifact would then carry bytes HEAD does not hold, which is the whole
    // failure. `cat-file -e HEAD:<path>` is the question that separates
    // committed from merely added, and this is the case that tells them apart.
    tty(false);
    writeFileSync(join(work, "c.mjs"), policy("gamma"));
    git("add", "c.mjs");
    expect(git("ls-files", "c.mjs")).toBe("c.mjs");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    // The "missing" refusal specifically. Reading the index as good enough
    // leaves the generic dirty-tree message to fire instead, whose remedy
    // (`git add -A`) stages what is already staged and changes nothing.
    expect(r.lines.join("\n")).toMatch(/are not in it — ignored, or never committed/);
    expect(offending(r.lines)).toEqual([`  ${join(work, "c.mjs")}`]);
  }, 60_000);
});

/**
 * Filenames git cannot print plainly. All three are legal on this filesystem,
 * and each one broke a parser that read `git status` as lines of text: the
 * quoting is git's, not the filename's, and the ` -> ` is the filename's, not
 * git's. `-z` settles both — provided the rename field it introduces is
 * consumed rather than read as another entry.
 */
describe("paths git does not print plainly", () => {
  /** Commit the named policy file at a terminal, then edit it. */
  function commitThenEdit(name: string): void {
    tty(true);
    git("init", "-q", "-b", "main");
    writeFileSync(join(work, name), policy("alpha"));
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(work, name), policy("alpha") + "\n// edited\n");
  }

  it("commits a policy file whose name contains ' -> '", async () => {
    // The arrow is part of the FILENAME here, and the plain porcelain line
    // prints a rename with that same arrow. Splitting on it took
    // `guards -> final.mjs` down to `final.mjs` — a path on no disk and in no
    // file set — so publish filed its own source under changes that were not
    // its to commit and refused to publish the file it had been handed.
    const name = "guards -> final.mjs";
    commitThenEdit(name);
    // git's own output, stated rather than assumed: it quotes this path, so
    // the text a line parser reads is not the filename in two separate ways.
    expect(git("status", "--porcelain")).toBe('M "guards -> final.mjs"');

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).not.toMatch(/outside the policy files/);
    expect(r.lines.join("\n")).toContain("Committed 1 changed policy file.");
    expect(git("show", `HEAD:${name}`)).toContain("// edited");
    expect(manifest().version).toBe(versionFromCommit(git("rev-parse", "HEAD")));
  }, 60_000);

  it("commits a policy file whose name contains a double quote", async () => {
    // git C-QUOTES this path, so the value a line parser reads carries git's
    // own quotes AND a backslash escape inside them. Stripping the outer pair
    // was never enough: the escape stayed, the path resolved to nothing, and
    // publish refused a file it had mangled itself.
    const name = 'my"guards.mjs';
    commitThenEdit(name);
    expect(git("status", "--porcelain")).toBe('M "my\\"guards.mjs"');

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).not.toMatch(/outside the policy files/);
    expect(r.lines.join("\n")).toContain("Committed 1 changed policy file.");
    expect(git("show", `HEAD:${name}`)).toContain("// edited");
  }, 60_000);

  it("commits a policy file whose name contains a NEWLINE", async (ctx) => {
    // The worst case for a line parser: one file would arrive as two lines,
    // and the C-quoted form git prints instead resolves to no file at all.
    // Skipped rather than deleted where the filesystem refuses the name,
    // because the parser still has to survive it everywhere it is legal —
    // which is every Linux and macOS checkout this ships to.
    const name = "guards\nmore.mjs";
    try {
      writeFileSync(join(work, name), "probe\n");
      rmSync(join(work, name));
    } catch {
      ctx.skip();
      return;
    }
    commitThenEdit(name);

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).not.toMatch(/outside the policy files/);
    expect(r.lines.join("\n")).toContain("Committed 1 changed policy file.");
    expect(git("show", `HEAD:${name}`)).toContain("// edited");
  }, 60_000);

  it("names a C-quoted path as it is on disk when it REFUSES", async () => {
    // The three tests above prove the parser inside the commit path. This one
    // proves the other parser — `sourcesInHead`'s — because away from a TTY
    // nothing is committed and the same porcelain output is read to build the
    // refusal. Read as lines, the offending path is git's quoted spelling
    // (`"my\"guards.mjs"`), which names no file and cannot be acted on.
    tty(false);
    const name = 'my"guards.mjs';
    git("init", "-q", "-b", "main");
    writeFileSync(join(work, name), policy("alpha"));
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(work, name), policy("alpha") + "\n// edited\n");
    expect(git("status", "--porcelain")).toBe('M "my\\"guards.mjs"');

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/these policy files differ from it/);
    expect(offending(r.lines)).toEqual([`  ${join(work, name)}`]);
  }, 60_000);
});

/**
 * Checkouts that are not one plain directory with a `.git` folder in it.
 *
 * Both of these turn on the same fact: `git rev-parse --show-toplevel` answers
 * with a path of git's choosing — the worktree's own root, symlinks resolved —
 * and every source is measured against it. A source path that spells the same
 * file differently measures as outside the repository and is reported missing,
 * which is a refusal naming a file that is committed and clean.
 */
describe("worktrees and symlinked paths", () => {
  it("reads the LINKED WORKTREE's HEAD, not the checkout it was made from", async () => {
    // `git worktree add ../release v1.0.0` is how a release gets built from a
    // tag while work continues on main, and there `.git` is a FILE, HEAD is
    // detached, and the worktree's commit is not the repository's. Everything
    // here has to come from the worktree: the tag, the commit recorded in the
    // manifest, and the paths the source check measures.
    tty(false);
    const repo = join(work, "repo");
    mkdirSync(repo);
    gitAt(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.mjs"), policy("alpha"));
    gitAt(repo, "add", "-A");
    gitAt(repo, "commit", "-qm", "init");
    gitAt(repo, "tag", "v1.0.0");
    const tagged = gitAt(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.mjs"), policy("alpha") + "\n// later work\n");
    gitAt(repo, "add", "-A");
    gitAt(repo, "commit", "-qm", "later");
    const wt = join(work, "wt");
    gitAt(repo, "worktree", "add", "-q", "--detach", wt, "v1.0.0");
    process.chdir(wt);

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(manifest(wt).version).toBe("v1.0.0");
    expect(manifest(wt).commit).toBe(tagged);
    expect(manifest(wt).commit).not.toBe(gitAt(repo, "rev-parse", "HEAD"));
  }, 60_000);

  it("refuses a source edited inside a linked worktree", async () => {
    // The refusal has to work there too, and name the path in the worktree.
    // Measuring against the main checkout's root would put every source
    // outside the repository and report all of them missing.
    tty(false);
    const repo = join(work, "repo");
    mkdirSync(repo);
    gitAt(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.mjs"), policy("alpha"));
    writeFileSync(join(repo, "b.mjs"), policy("beta"));
    gitAt(repo, "add", "-A");
    gitAt(repo, "commit", "-qm", "init");
    const wt = join(work, "wt");
    gitAt(repo, "worktree", "add", "-q", "--detach", wt, "HEAD");
    writeFileSync(join(wt, "b.mjs"), policy("beta") + "\n// edited\n");
    process.chdir(wt);

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/these policy files differ from it/);
    expect(offending(r.lines)).toEqual([`  ${join(wt, "b.mjs")}`]);
  }, 60_000);

  it("publishes a committed source named through a SYMLINKED directory", async () => {
    // `failproofai publish ~/policies/guards.mjs`, where `~/policies` is a
    // symlink into a checkout — an ordinary way to keep policies to hand. git
    // answers `--show-toplevel` with the resolved path while the argument keeps
    // the link, so the two spellings disagree, the source measures as outside
    // the repository, and a committed clean file is refused as never committed
    // — with `git add -f` as the advice, which changes nothing.
    tty(false);
    const real = join(work, "real");
    mkdirSync(real);
    gitAt(real, "init", "-q", "-b", "main");
    writeFileSync(join(real, "a.mjs"), policy("alpha"));
    gitAt(real, "add", "-A");
    gitAt(real, "commit", "-qm", "init");
    symlinkSync(real, join(work, "link"));
    // git's own answer, stated rather than assumed: the link is not in it.
    expect(gitAt(join(work, "link"), "rev-parse", "--show-toplevel")).toBe(real);

    const r = await runPublishCommand([join(work, "link", "a.mjs"), "--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(manifest().commit).toBe(gitAt(real, "rev-parse", "HEAD"));
    expect(manifest().version).toBe(versionFromCommit(gitAt(real, "rev-parse", "HEAD")));
  }, 60_000);

  it("still refuses when the symlink leads OUT of the repository", async () => {
    // The same resolution, cutting the other way. `guards.mjs` is committed —
    // as a LINK, whose blob is the target's name — while the bytes bundled are
    // the target's, from a directory this repository knows nothing about. A
    // check that only asked about the link's own path would call that
    // publishable and record a commit holding none of those bytes.
    tty(false);
    const repo = join(work, "repo");
    const outside = join(work, "outside");
    mkdirSync(repo);
    mkdirSync(outside);
    writeFileSync(join(outside, "guards.mjs"), policy("alpha"));
    gitAt(repo, "init", "-q", "-b", "main");
    symlinkSync(join(outside, "guards.mjs"), join(repo, "guards.mjs"));
    gitAt(repo, "add", "-A");
    gitAt(repo, "commit", "-qm", "init");
    expect(gitAt(repo, "status", "--porcelain")).toBe("");
    process.chdir(repo);

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/are not in it — ignored, or never committed/);
    expect(offending(r.lines)).toEqual([`  ${join(outside, "guards.mjs")}`]);
  }, 60_000);
});

/**
 * A file reaches the artifact by being IMPORTED, not only by being discovered.
 *
 * `findEntry` recognises policy files — ones that import failproofai and call
 * `customPolicies.add` — but `bundleEntry` inlines whatever those files import.
 * A plain module of shared patterns is in nobody's source list and in every
 * byte of the bundle, so ignoring it reopens the original bug with a different
 * file on the end of it.
 */
describe("a file the bundle pulls in but discovery never names", () => {
  /**
   * A policy whose matching lives next door, with the neighbour ignored. The
   * helper is CALLED from the policy body so the bundler cannot shake it out
   * — an unused export would leave the artifact identical either way, and the
   * first test below asserts the bytes are really in there.
   */
  function helperFixture(): void {
    git("init", "-q", "-b", "main");
    writeFileSync(
      join(work, "patterns.mjs"),
      'export const looksBad = (cmd) => cmd.includes("rm -rf /");\n',
    );
    writeFileSync(
      join(work, "guards.mjs"),
      `import { customPolicies, allow, deny } from "failproofai";
import { looksBad } from "./patterns.mjs";
customPolicies.add({
  name: "alpha",
  description: "guards alpha",
  category: "Test",
  defaultEnabled: true,
  match: { events: ["PreToolUse"] },
  fn: async (ctx) =>
    looksBad(String(ctx.toolInput?.command ?? "")) ? deny("no") : allow(),
});
`,
    );
    writeFileSync(join(work, ".gitignore"), "patterns.mjs\n");
    git("add", "-A");
    git("commit", "-qm", "init");
  }

  it("carries the helper's bytes into the artifact", async () => {
    // The premise, proven rather than asserted: under `--version` the publish
    // goes through, and the string only `patterns.mjs` contains is in the entry
    // asset. Without this the refusal below could be passing against a bundle
    // that never included the file.
    tty(false);
    helperFixture();

    const r = await runPublishCommand(["--id", "me/x", "--version", "1.0.0", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(work, "dist-pack", "failproofai-pack.mjs"), "utf8")).toContain(
      "rm -rf /",
    );
    // And the manifest makes no claim it cannot support, the same way it does
    // not for an ignored policy file: those bytes are in no commit.
    expect(manifest().commit).toBeUndefined();
  }, 60_000);

  it("refuses when that helper is ignored, and names it", async () => {
    // `git status` reports NOTHING here — the helper is ignored and the policy
    // file is committed and clean — so the tree read passes, and checking only
    // the discovered policy files passes too. The bundle still ships bytes HEAD
    // does not contain, under a version naming HEAD.
    tty(false);
    helperFixture();
    expect(git("status", "--porcelain")).toBe("");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/are not in it — ignored, or never committed/);
    expect(offending(r.lines)).toEqual([`  ${join(work, "patterns.mjs")}`]);
    for (const asset of ASSETS) {
      expect(existsSync(join(work, "dist-pack", asset))).toBe(false);
    }
  }, 60_000);

  it("publishes at the sha once the helper is committed too", async () => {
    // The check must not stand in the way of the ordinary case: a committed
    // helper is in HEAD, so the import graph adds nothing to complain about
    // and the sha path answers normally. A scan that resolved imports wrongly
    // — to a path that does not exist, say — would refuse this.
    tty(false);
    helperFixture();
    git("add", "-f", "patterns.mjs");
    git("commit", "-qm", "commit the helper");
    const head = git("rev-parse", "HEAD");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(manifest().version).toBe(versionFromCommit(head));
    expect(manifest().commit).toBe(head);
    expect(manifest().policies.map((p) => p.name)).toEqual(["alpha"]);
  }, 60_000);
});

describe("one check, run by both paths", () => {
  it("refuses the SAME source set with a tag on HEAD and without one", async () => {
    // The reason `sourcesInHead` is one function. Both paths decide whether a
    // version may be minted, and they used to ask different questions of
    // different file sets — the tag path about the entry alone, the sha path
    // about the whole tree. That drift is invisible when it returns: the
    // publish succeeds, under a version naming a commit without the bytes.
    //
    // Two ignored siblings make it a SET rather than one path, and the entry
    // is committed and clean, so a check that just listed every discovered
    // file would name it too and still pass a length test.
    tty(false);
    git("init", "-q", "-b", "main");
    writeFileSync(join(work, "a.mjs"), policy("alpha"));
    writeFileSync(join(work, "hidden-one.mjs"), policy("one"));
    writeFileSync(join(work, "hidden-two.mjs"), policy("two"));
    writeFileSync(join(work, ".gitignore"), "hidden-*.mjs\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    git("tag", "v2.1.0");
    const expected = [`  ${join(work, "hidden-one.mjs")}`, `  ${join(work, "hidden-two.mjs")}`];

    const tagged = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(tagged.exitCode).toBe(1);
    // A tag path that still checked only the entry would find `a.mjs` clean
    // and publish all three files as v2.1.0.
    expect(tagged.lines.join("\n")).not.toMatch(/v2\.1\.0/);
    expect(offending(tagged.lines)).toEqual(expected);
    expect(tagged.lines).not.toContain(`  ${join(work, "a.mjs")}`);

    git("tag", "-d", "v2.1.0");
    const bare = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(bare.exitCode).toBe(1);
    // Identical, path for path. This is what "one shared check" means in
    // practice, and the only assertion that fails if the two paths are given
    // separate copies of it again.
    expect(offending(bare.lines)).toEqual(offending(tagged.lines));
    expect(offending(bare.lines)).toEqual(expected);
    for (const asset of ASSETS) {
      expect(existsSync(join(work, "dist-pack", asset))).toBe(false);
    }
  }, 60_000);
});
