// @vitest-environment node
//
// Everything `publish` works out BEFORE it touches GitHub: the starter file,
// finding the policy files, reading the repository off the git remote, taking a
// version from a tag, and collapsing several files into the one artifact a pack
// has to be.
//
// All of it runs against real temporary git repositories rather than mocks. The
// whole point of these paths is that they read what git actually reports, and a
// stubbed `git` would be asserting my idea of its output instead of its own.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runPublishCommand } from "@/src/hooks/pack-cli";

let work: string;
let prevCwd: string;
let prevDist: string | undefined;

/**
 * Where the loader finds `failproofai` itself.
 *
 * `findDistIndex` falls back to `process.cwd()/dist`, and these tests chdir into
 * a temp directory so discovery reads a clean folder — which takes that
 * fallback away. Pinned to the repo's own dist, and BUILT if it is not there:
 * `test` and `build` are separate CI jobs, so a checkout that has only run the
 * tests has no dist at all.
 */
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

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: work,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

/** The manifest publish would upload, read back off disk. */
function manifest(): { id: string; version: string; policies: Array<{ name: string }> } {
  return JSON.parse(readFileSync(join(work, "dist-pack", "failproofai-pack.json"), "utf8"));
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
  work = mkdtempSync(join(tmpdir(), "fpai-authoring-"));
  prevCwd = process.cwd();
  process.chdir(work);
  // `process.stdin.isTTY` is undefined under vitest, which is exactly the
  // non-TTY condition these paths branch on — so `--init` takes the
  // deterministic route and never prompts. Asserted rather than assumed.
  expect(process.stdin.isTTY).toBeFalsy();
});

afterEach(() => {
  if (prevDist === undefined) delete process.env.FAILPROOFAI_DIST_PATH;
  else process.env.FAILPROOFAI_DIST_PATH = prevDist;
  vi.restoreAllMocks();
  process.chdir(prevCwd);
  rmSync(work, { recursive: true, force: true });
});

describe("publish --init", () => {
  it("writes a file that already registers a working policy", async () => {
    const r = await runPublishCommand(["--init"]);
    expect(r.exitCode).toBe(0);
    const written = readFileSync(join(work, "my-policies.mjs"), "utf8");
    // Not a template with blanks: the point is that the first act is editing
    // something that runs, not authoring from a description.
    expect(written).toContain("customPolicies.add(");
    expect(written).toContain("block-force-push");
    expect(written).toMatch(/from "failproofai"/);
  });

  it("takes a name for the file when one is given", async () => {
    await runPublishCommand(["--init", "./deploy-guard.mjs"]);
    expect(existsSync(join(work, "deploy-guard.mjs"))).toBe(true);
  });

  it("refuses rather than overwriting work that is already there", async () => {
    writeFileSync(join(work, "my-policies.mjs"), "// mine\n");
    const r = await runPublishCommand(["--init"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/already exists/);
    expect(readFileSync(join(work, "my-policies.mjs"), "utf8")).toBe("// mine\n");
  });

  it("writes something publish itself accepts", async () => {
    // The scaffold has to survive the loader's own rules, or the first thing a
    // newcomer does after `--init` is read a validation error.
    await runPublishCommand(["--init"]);
    const r = await runPublishCommand(["./my-policies.mjs", "--id", "me/x", "--version", "1.0.0", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(manifest().policies.map((p) => p.name)).toContain("block-force-push");
  });
});

describe("finding the policy file", () => {
  it("finds it by CONTENT, not by name", async () => {
    writeFileSync(join(work, "guards.mjs"), policy("alpha"));
    writeFileSync(join(work, "README.md"), "# docs");
    writeFileSync(join(work, "helper.mjs"), "export const x = 1;\n");
    const r = await runPublishCommand(["--id", "me/x", "--version", "1.0.0", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(manifest().policies.map((p) => p.name)).toEqual(["alpha"]);
  });

  it("does not descend into subdirectories", async () => {
    // A fixture or an example getting published is the failure this avoids.
    writeFileSync(join(work, "top.mjs"), policy("top"));
    mkdirSync(join(work, "examples"));
    writeFileSync(join(work, "examples", "sample.mjs"), policy("sample"));
    await runPublishCommand(["--id", "me/x", "--version", "1.0.0", "--dry-run"]);
    expect(manifest().policies.map((p) => p.name)).toEqual(["top"]);
  });

  it("publishes exactly the named file when one is named", async () => {
    writeFileSync(join(work, "a.mjs"), policy("alpha"));
    writeFileSync(join(work, "b.mjs"), policy("beta"));
    await runPublishCommand(["./a.mjs", "--id", "me/x", "--version", "1.0.0", "--dry-run"]);
    expect(manifest().policies.map((p) => p.name)).toEqual(["alpha"]);
  });
});

describe("several files are one pack", () => {
  it("bundles every policy file in the directory into one artifact", async () => {
    // Splitting policies across files is the normal thing to do past about
    // three of them. They are one pack, so this is an answer, not an ambiguity.
    for (const n of ["deploys", "data", "hygiene"]) {
      writeFileSync(join(work, `${n}.mjs`), policy(n));
    }
    const r = await runPublishCommand(["--id", "me/x", "--version", "1.0.0", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(manifest().policies.map((p) => p.name).sort()).toEqual(["data", "deploys", "hygiene"]);
    expect(r.lines.join("\n")).toMatch(/Bundled 3 files/);
  });

  it("bundles an entry that imports its neighbours", async () => {
    // One entry file is a constraint on what is PUBLISHED — only the entry is
    // digest-pinned — never on how anybody writes.
    writeFileSync(join(work, "shared.mjs"), `export const cmd = (ctx) => String(ctx.toolInput?.command ?? "");\n`);
    writeFileSync(
      join(work, "index.mjs"),
      policy("shared-user", `import { cmd } from "./shared.mjs";\nvoid cmd;`),
    );
    const r = await runPublishCommand(["./index.mjs", "--id", "me/x", "--version", "1.0.0", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(manifest().policies.map((p) => p.name)).toEqual(["shared-user"]);
  });

  it("ships ONE artifact however many files went in", async () => {
    for (const n of ["one", "two"]) writeFileSync(join(work, `${n}.mjs`), policy(n));
    await runPublishCommand(["--id", "me/x", "--version", "1.0.0", "--dry-run"]);
    // The digest-pinning claim rests on there being a single entry to pin.
    const entry = readFileSync(join(work, "dist-pack", "failproofai-pack.mjs"), "utf8");
    expect(entry).toContain("one");
    expect(entry).toContain("two");
    // And it must not carry a second copy of the registry: policies would
    // register into an object nothing reads.
    expect(entry).not.toMatch(/customPolicies\s*=\s*\{/);
  });
});

describe("reading the repository from git", () => {
  it("takes it from an https remote", async () => {
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "https://github.com/acme/guards.git");
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    await runPublishCommand(["--version", "1.0.0", "--dry-run"]);
    expect(manifest().id).toBe("acme/guards");
  });

  it("takes it from an scp-style remote too", async () => {
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "git@github.com:acme/guards.git");
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    await runPublishCommand(["--version", "1.0.0", "--dry-run"]);
    expect(manifest().id).toBe("acme/guards");
  });

  it("dry-runs without a git repository, because that is what a dry run is for", async () => {
    // It used to refuse: the pack id comes from the git remote, and a folder
    // that has not been given one yet has no remote to read. That refused the
    // exact case a dry run exists for — looking at the pack BEFORE committing
    // to a repository for it. The folder name stands in, marked `local/` so a
    // manifest built here cannot be mistaken for one built for an account.
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    const r = await runPublishCommand(["--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toMatch(/local\//);
    // And it still says the thing that is actually missing.
    expect(r.lines.join("\n")).toMatch(/--repo/);
  });

  it("still refuses to PUBLISH without somewhere to publish to", async () => {
    // The fallback id is for building assets locally, never for reaching
    // GitHub — a guessed owner must not become a real release.
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    const r = await runPublishCommand([]);
    expect(r.lines.join("\n")).toMatch(/--repo/);
    expect(r.lines.join("\n")).not.toMatch(/Published/);
  });
});

describe("taking the version from a tag", () => {
  beforeEach(() => {
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "https://github.com/acme/guards.git");
    writeFileSync(join(work, "p.mjs"), policy("alpha"));
    git("add", "-A");
    git("commit", "-qm", "init");
  });

  it("uses a tag on HEAD, because it says what the release IS", async () => {
    git("tag", "v2.1.0");
    await runPublishCommand(["--dry-run"]);
    expect(manifest().version).toBe("v2.1.0");
  });

  it("refuses to publish edited bytes under a tag that names a commit", async () => {
    // The tag names a COMMIT, and these bytes are not in it — two artifacts
    // would end up claiming one version, which `id|version|sha256` compares in
    // both the audit key and the installed-pack upsert.
    git("tag", "v2.1.0");
    writeFileSync(join(work, "p.mjs"), policy("alpha") + "\n// edited\n");
    await runPublishCommand(["--dry-run"]);
    // Falls through to the counted version rather than the stale tag.
    expect(manifest().version).toBe("1.0.0");
  });

  it("ignores a tag that is not a usable version", async () => {
    git("tag", "nightly/2026-08-25");
    await runPublishCommand(["--dry-run"]);
    expect(manifest().version).toBe("1.0.0");
  });

  it("lets an explicit --version win over everything", async () => {
    git("tag", "v2.1.0");
    await runPublishCommand(["--version", "9.9.9", "--dry-run"]);
    expect(manifest().version).toBe("9.9.9");
  });
});
