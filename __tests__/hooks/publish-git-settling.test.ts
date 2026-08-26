// @vitest-environment node
//
// `publish` versions a pack by the commit it was built from, so it needs a
// commit. It used to refuse when there was not one and hand back two git
// commands; `settleGitState` now does that work itself — but only where doing
// it is safe, and never in CI.
//
// Real temporary git repositories throughout, for the reason
// `publish-authoring.test.ts` gives: these paths exist to read what git
// actually reports, and a stubbed `git` would assert my idea of its output.
// Two of the tests below cover regressions that only a real `git status` and a
// real `git add` can reproduce at all.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
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

/**
 * The manifest publish would upload, read back off disk.
 *
 * `dir` is where the build wrote, which is the cwd publish ran in — not the
 * repository root, once the policies live in a subdirectory.
 */
function manifest(dir: string = work): {
  id: string;
  version: string;
  commit?: string;
  policies: Array<{ name: string }>;
} {
  return JSON.parse(readFileSync(join(dir, "dist-pack", "failproofai-pack.json"), "utf8"));
}

/**
 * Whether git can see a committer identity.
 *
 * Pinned to a file this test owns rather than left to the machine's own
 * `~/.gitconfig`: `settleGitState` spawns git with the ambient environment, so
 * without this the identity branch would pass or fail depending on whose
 * checkout the suite is running in.
 */
function withIdentity(): void {
  writeFileSync(join(gitHome, "config"), "[user]\n\tname = Test\n\temail = test@example.com\n");
}
function withoutIdentity(): void {
  writeFileSync(join(gitHome, "config"), "[core]\n\tquotepath = false\n");
}

/** `publish` only carries the git work for a human at a terminal. */
function tty(on: boolean): void {
  (process.stdin as { isTTY?: boolean }).isTTY = on;
  (process.stdout as { isTTY?: boolean }).isTTY = on;
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
  // realpath because `skipOutDir` compares the resolved output directory
  // against `git rev-parse --show-toplevel`, and a tmpdir behind a symlink
  // would make those two spellings differ.
  work = realpathSync(mkdtempSync(join(tmpdir(), "fpai-settle-")));
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

describe("no git checkout at all", () => {
  it("starts a repository, commits, and versions from that commit", async () => {
    // The whole point of carrying the work: a folder of policies that has
    // never been a checkout used to end in two commands and a second attempt.
    // The version has to come out of the commit publish just made, or the
    // repository was created for nothing.
    tty(true);
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toMatch(/Started a git repository here and committed/);
    expect(existsSync(join(work, ".git"))).toBe(true);
    // Named after what it is for, so the history says why the commit exists.
    expect(git("log", "-1", "--format=%s")).toBe("publish me/x");
    expect(manifest().version).toBe(versionFromCommit(git("rev-parse", "HEAD")));
    // The provenance the caller carries forward has to be the one this commit
    // produced, not the null it started with: `commit` in the manifest is the
    // FULL sha the version abbreviates, and it only gets there if the settled
    // read was passed on to the build.
    expect(manifest().commit).toBe(git("rev-parse", "HEAD"));
  }, 60_000);

  it("counts what it committed from the index, not from the policy files", async () => {
    // The first commit takes the whole folder, so reporting the number of
    // POLICY files understates what was just committed on somebody's behalf.
    // Three files here and one of them a policy: a count of 1 is the bug.
    tty(true);
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    writeFileSync(join(work, "README.md"), "# guards\n");
    writeFileSync(join(work, ".gitignore"), "dist-pack/\n");
    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain("Started a git repository here and committed 3 files.");
    // The number and the tree have to agree. Counting the index is only the
    // right answer while the index is what got committed, so the commit is
    // read back rather than trusting the count that described it.
    expect(git("ls-tree", "-r", "--name-only", "HEAD").split("\n").sort()).toEqual([
      ".gitignore",
      "README.md",
      "p.mjs",
    ]);
  }, 60_000);

  it("makes a first commit that actually CONTAINS the files", async () => {
    // The double-separator regression. `skipOutDir` returns its own `--` and a
    // `:(top)` scope, so `git add -A -- . <spec>` passed two separators, git
    // read the second as a literal filename, the add staged nothing, and the
    // commit failed on an empty index — reported as "could not make the first
    // commit", which is true and explains nothing. Only the tree proves it.
    tty(true);
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    writeFileSync(join(work, "README.md"), "# guards\n");
    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).not.toMatch(/Could not make the first commit/);
    expect(git("ls-tree", "-r", "--name-only", "HEAD").split("\n").sort()).toEqual([
      "README.md",
      "p.mjs",
    ]);
  }, 60_000);

  it("leaves the build output out of the first commit", async () => {
    // A previous run's assets sit inside the checkout by default, and sweeping
    // them in would put the artifact inside the very commit that names it.
    // Pre-seeded here so the exclusion is exercised against a directory that
    // exists before `git add` runs, which is how a second publish finds it.
    tty(true);
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    mkdirSync(join(work, "dist-pack"));
    writeFileSync(join(work, "dist-pack", "stale.json"), "{}\n");
    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    const tracked = git("ls-tree", "-r", "--name-only", "HEAD").split("\n");
    expect(tracked).toContain("p.mjs");
    expect(tracked.filter((f) => f.startsWith("dist-pack/"))).toEqual([]);
    expect(r.lines.join("\n")).toContain("committed 1 file.");
  }, 60_000);

  it("makes the first commit in a repository that has one but no HEAD yet", async () => {
    // An initialised checkout with nothing committed reaches the SAME branch
    // as no repository at all, because `rev-parse HEAD` is what decides and an
    // unborn HEAD answers nothing. At the checkout's own root that is safe on
    // the same terms — but the commit has to land in THAT repository, and the
    // line reported must not claim to have started one that was already there.
    tty(true);
    git("init", "-q", "-b", "trunk");
    writeFileSync(join(work, "p.mjs"), policy("alpha"));

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain("Made this repository's first commit — 1 file.");
    expect(r.lines.join("\n")).not.toMatch(/Started a git repository/);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("trunk");
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("p.mjs");
    expect(manifest().version).toBe(versionFromCommit(git("rev-parse", "HEAD")));
  }, 60_000);

  it("refuses without a git identity, naming both commands", async () => {
    // A machine that has never configured a name fails INSIDE `git commit`
    // with a wall of advice about --global. Checked first so the refusal is
    // two commands rather than git's output quoted at someone who did not run
    // git, and so nothing is initialised before that refusal.
    tty(true);
    withoutIdentity();
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("git config --global user.name");
    expect(r.lines.join("\n")).toContain("git config --global user.email");
    expect(r.lines.join("\n")).toMatch(/--version/);
    expect(existsSync(join(work, ".git"))).toBe(false);
  }, 60_000);

  it("does none of it without a terminal", async () => {
    // A commit made in CI exists on the runner and nowhere else, so the
    // version would name provenance nobody can resolve. Non-TTY has to fall
    // through to the old refusal with the directory untouched.
    tty(false);
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/not a git checkout/);
    expect(existsSync(join(work, ".git"))).toBe(false);
  }, 60_000);
});

describe("a checkout with uncommitted policy files", () => {
  beforeEach(() => {
    git("init", "-q", "-b", "main");
  });

  it("commits the changed policy files and versions from the new commit", async () => {
    // `git add -A` is not safe here, so only the files publish is about to
    // bundle get committed. Two of them, both dirty, and the version must name
    // the commit that now contains the edits rather than the one before them.
    tty(true);
    writeFileSync(join(work, "a.mjs"), policy("alpha"));
    writeFileSync(join(work, "b.mjs"), policy("beta"));
    git("add", "-A");
    git("commit", "-qm", "init");
    const before = git("rev-parse", "HEAD");
    writeFileSync(join(work, "a.mjs"), policy("alpha") + "\n// edited\n");
    writeFileSync(join(work, "b.mjs"), policy("beta") + "\n// edited\n");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain("Committed 2 changed policy files.");
    const after = git("rev-parse", "HEAD");
    expect(after).not.toBe(before);
    expect(manifest().version).toBe(versionFromCommit(after));
    expect(git("show", "HEAD:a.mjs")).toContain("// edited");
    // BOTH of them. Staging only the first dirty path would leave the second
    // edit outside the commit the version names — the exact claim this scheme
    // exists to make true — and the count above would still read 2.
    expect(git("show", "HEAD:b.mjs")).toContain("// edited");
    expect(git("status", "--porcelain", "--", "a.mjs", "b.mjs")).toBe("");
  }, 60_000);

  it("reads the status of a SINGLE dirty file without eating a character", async () => {
    // The trimmed-status regression. The git helper trims its output, and a
    // porcelain line for an unstaged edit starts with a SPACE — so the first
    // line lost a character and `slice(3)` then ate the first letter of its
    // path. It reported `ards.mjs`, decided that was not a policy file, and
    // refused over a file that does not exist. Only the FIRST line is
    // affected, so a two-file fixture hides it.
    tty(true);
    writeFileSync(join(work, "guards.mjs"), policy("alpha"));
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(work, "guards.mjs"), policy("alpha") + "\n// edited\n");
    expect(git("status", "--porcelain")).toBe("M guards.mjs");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain("Committed 1 changed policy file.");
    expect(r.lines.join("\n")).not.toMatch(/uncommitted changes outside/);
    expect(git("show", "HEAD:guards.mjs")).toContain("// edited");
  }, 60_000);

  it("reads a RENAMED policy file as the name it now has", async () => {
    // A rename reads `R  old -> new` on one porcelain line, so the path this
    // has to recognise is the second half. Take that split away and the dirty
    // path becomes the literal string `guards.mjs -> policies.mjs`, which
    // matches no policy file — and publish refuses somebody's own rename as
    // "changes outside the policy files".
    tty(true);
    writeFileSync(join(work, "guards.mjs"), policy("alpha"));
    git("add", "-A");
    git("commit", "-qm", "init");
    git("mv", "guards.mjs", "policies.mjs");
    expect(git("status", "--porcelain")).toBe("R  guards.mjs -> policies.mjs");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).not.toMatch(/outside the policy files/);
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("policies.mjs");
    expect(manifest().version).toBe(versionFromCommit(git("rev-parse", "HEAD")));
  }, 60_000);

  it("reads a path git QUOTED because it has a space in it", async () => {
    // git wraps any path with a space in double quotes on the porcelain line,
    // so the quotes are part of the text and not part of the filename. Left
    // on, the path resolves to a file that does not exist, misses the set of
    // policy files, and publish refuses the very file it is about to bundle.
    tty(true);
    writeFileSync(join(work, "my guards.mjs"), policy("alpha"));
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(work, "my guards.mjs"), policy("alpha") + "\n// edited\n");
    expect(git("status", "--porcelain")).toBe('M "my guards.mjs"');

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain("Committed 1 changed policy file.");
    expect(r.lines.join("\n")).not.toMatch(/outside the policy files/);
    expect(git("show", "HEAD:my guards.mjs")).toContain("// edited");
  }, 60_000);

  it("does not read leftover build output as a dirty tree", async () => {
    // The self-inflicted refusal: publish writes `dist-pack/` into the
    // checkout it just read, so without the exclusion the next publish of an
    // unchanged, fully committed tree refuses over output it wrote itself.
    // Nothing is committed here, because nothing is dirty.
    tty(true);
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    git("add", "-A");
    git("commit", "-qm", "init");
    const head = git("rev-parse", "HEAD");
    mkdirSync(join(work, "dist-pack"));
    writeFileSync(join(work, "dist-pack", "stale.json"), "{}\n");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).not.toMatch(/Committed/);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(manifest().version).toBe(versionFromCommit(head));
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("p.mjs");
  }, 60_000);

  it("refuses when anything else is dirty, and commits nothing", async () => {
    // `git add -A` here would sweep up a half-finished edit, a scratch .env or
    // a debugging change nobody had decided on. "publish committed my
    // unrelated work" is a worse surprise than being asked to commit, so the
    // foreign paths get named and the tree is left exactly as it was.
    tty(true);
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    writeFileSync(join(work, "notes.txt"), "notes\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(work, "p.mjs"), policy("alpha") + "\n// edited\n");
    writeFileSync(join(work, "notes.txt"), "half-finished\n");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/uncommitted changes outside the policy files/);
    expect(r.lines.join("\n")).toContain("notes.txt");
    // The policy file was dirty too and must not have been committed on its
    // own: a partial commit is the surprise this refusal exists to avoid.
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("status", "--porcelain")).toContain("notes.txt");
    expect(git("status", "--porcelain")).toContain("p.mjs");
  }, 60_000);

  it("caps the list of foreign paths at eight", async () => {
    // A tree with thirty stray files must not answer with thirty lines. Ten
    // here, so the cap and the remainder count are both wrong if either the
    // slice or the arithmetic moves.
    tty(true);
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    git("add", "-A");
    git("commit", "-qm", "init");
    for (let i = 0; i < 10; i++) writeFileSync(join(work, `scratch-${i}.txt`), "x\n");

    const head = git("rev-parse", "HEAD");
    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    const named = r.lines.filter((l) => /^ {2}scratch-\d\.txt$/.test(l));
    // Named exactly, not merely counted: a slice that moved by one still hands
    // back eight lines, and the remainder is still 2, so a length check alone
    // passes over the off-by-one it exists to catch.
    expect(named).toEqual([
      "  scratch-0.txt",
      "  scratch-1.txt",
      "  scratch-2.txt",
      "  scratch-3.txt",
      "  scratch-4.txt",
      "  scratch-5.txt",
      "  scratch-6.txt",
      "  scratch-7.txt",
    ]);
    expect(r.lines.join("\n")).toContain("…and 2 more");
    expect(git("rev-parse", "HEAD")).toBe(head);
  }, 60_000);

  it("refuses without a git identity rather than letting git explain", async () => {
    // Same guard as the first-commit path, on the other branch. It runs AFTER
    // the foreign-path check, so reaching it means the files were committable
    // and only the identity was missing — and still nothing is committed.
    tty(true);
    withoutIdentity();
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    gitAt(work, "add", "-A");
    gitAt(work, "commit", "-qm", "init");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(work, "p.mjs"), policy("alpha") + "\n// edited\n");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("git config --global user.name");
    expect(r.lines.join("\n")).toContain("git config --global user.email");
    expect(git("rev-parse", "HEAD")).toBe(head);
    // And the INDEX is untouched, which is the half an unchanged HEAD cannot
    // show. Checking the identity after `git add` would refuse just the same
    // and still leave the file staged behind somebody's back, so that they
    // find a half-prepared commit they never made.
    expect(git("diff", "--cached", "--name-only")).toBe("");
  }, 60_000);

  it("does none of it without a terminal", async () => {
    // The CI half of the TTY gate, on a tree that WOULD have been settled at a
    // terminal. It has to refuse with the version's own message and leave the
    // commit where it was.
    tty(false);
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    git("add", "-A");
    git("commit", "-qm", "init");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(work, "p.mjs"), policy("alpha") + "\n// edited\n");

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/uncommitted changes/);
    expect(r.lines.join("\n")).not.toMatch(/Committed/);
    expect(git("rev-parse", "HEAD")).toBe(head);
  }, 60_000);
});

/**
 * Policies in a subdirectory of the checkout, which is the arrangement where
 * the repository root and the directory publish runs in are two different
 * places. Every test above has them at the same path, so a read that used the
 * entry's folder where it meant the repository root passes all of them: git
 * reports status paths relative to the ROOT whatever directory it was run in.
 */
describe("policies in a subdirectory of the checkout", () => {
  let sub: string;
  beforeEach(() => {
    git("init", "-q", "-b", "main");
    sub = join(work, "policies");
    mkdirSync(sub);
  });

  it("commits a changed policy file that lives below the repository root", async () => {
    // Resolve the porcelain path against the entry's folder instead of the
    // root and it becomes policies/policies/p.mjs — a file that does not
    // exist, so it matches nothing publish is bundling and the run refuses
    // over the one file it was asked to publish.
    tty(true);
    writeFileSync(join(sub, "p.mjs"), policy("alpha"));
    writeFileSync(join(work, "README.md"), "# root\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    const before = git("rev-parse", "HEAD");
    writeFileSync(join(sub, "p.mjs"), policy("alpha") + "\n// edited\n");
    process.chdir(sub);

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain("Committed 1 changed policy file.");
    const after = git("rev-parse", "HEAD");
    expect(after).not.toBe(before);
    expect(git("show", "HEAD:policies/p.mjs")).toContain("// edited");
    expect(manifest(sub).version).toBe(versionFromCommit(after));
  }, 60_000);

  it("commits a policy folder that git reports as ONE untracked directory", async () => {
    // The collapsed-directory regression. `git status --porcelain` does not
    // list the files inside a wholly untracked directory — it prints the
    // directory, `?? policies/`, once. That path is not any policy file, so it
    // read as somebody else's work and publish refused a brand new folder of
    // policies by naming the folder itself. The bootstrap case this whole
    // feature exists for, and only reproducible below the root: an untracked
    // file at the root is reported individually.
    tty(true);
    writeFileSync(join(work, "README.md"), "# root\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(sub, "a.mjs"), policy("alpha"));
    writeFileSync(join(sub, "b.mjs"), policy("beta"));
    expect(git("status", "--porcelain")).toBe("?? policies/");
    process.chdir(sub);

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).not.toMatch(/outside the policy files/);
    expect(r.lines.join("\n")).toContain("Committed 2 changed policy files.");
    expect(git("ls-tree", "-r", "--name-only", "HEAD").split("\n").sort()).toEqual([
      "README.md",
      "policies/a.mjs",
      "policies/b.mjs",
    ]);
    expect(manifest(sub).version).toBe(versionFromCommit(git("rev-parse", "HEAD")));
  }, 60_000);

  it("refuses rather than starting a SECOND repository inside the first", async () => {
    // The nested-repository regression, and the worst outcome this file
    // covers. A checkout with no commit yet answers nothing to `rev-parse
    // HEAD`, so publishing from a folder below its root took the no-repository
    // branch and ran `git init` there — creating a repository inside the
    // parent's work tree and committing into it. The pack was then versioned
    // by a commit that exists only in a repository nobody will ever push: the
    // parent still shows an untracked `policies/` and no commit at all. That
    // is provenance nobody can resolve, minted at a terminal, which is the one
    // thing the whole path exists to prevent.
    tty(true);
    // The block's own beforeEach initialised the checkout and never committed,
    // which is precisely the state this covers.
    writeFileSync(join(work, "half-finished.txt"), "not mine to commit\n");
    writeFileSync(join(sub, "p.mjs"), policy("alpha"));
    process.chdir(sub);

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/inside a git checkout that has no commits yet/);
    expect(existsSync(join(sub, ".git"))).toBe(false);
    // And nothing was swept into the parent instead: everything in an unborn
    // checkout is untracked, so the only add that would have worked is the one
    // that takes somebody's unfinished file with it.
    expect(git("status", "--porcelain")).toContain("half-finished.txt");
    expect(() => git("rev-parse", "HEAD")).toThrow();
  }, 60_000);

  it("names a foreign path as the repository sees it, not as ../", async () => {
    // The refusal is read by somebody standing in the policies folder, but the
    // paths it lists come from git and are root-relative. Printing them
    // relative to the entry's folder would spell the root's own files `../…`,
    // and a path that leaves the repository reads like a bug in the tool
    // rather than a file the reader has to go and commit.
    tty(true);
    writeFileSync(join(sub, "p.mjs"), policy("alpha"));
    mkdirSync(join(work, "docs"));
    writeFileSync(join(work, "docs", "notes.txt"), "notes\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(sub, "p.mjs"), policy("alpha") + "\n// edited\n");
    writeFileSync(join(work, "docs", "notes.txt"), "half-finished\n");
    process.chdir(sub);

    const r = await runPublishCommand(["--id", "me/x", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines).toContain("  docs/notes.txt");
    expect(r.lines.join("\n")).not.toMatch(/\.\.\//);
    expect(git("rev-parse", "HEAD")).toBe(head);
  }, 60_000);
});
