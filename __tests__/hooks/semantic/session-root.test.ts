// @vitest-environment node
/**
 * The project root is pinned when a session starts and a `cd` never moves it.
 *
 * Before `session-root.ts`, `facts.projectRoot` came from the hook payload's
 * live cwd. A session opened in a directory that later `cd`d into one of its
 * own sub-repos had every other file of the opened directory judged
 * `outside_project_in_home`, and `read-outside-workspace` fired on them. The
 * fix must not go the other way — a root that FOLLOWS the `cd` would make
 * `cd ~/.ssh` then `cat id_rsa` an inside-the-project read.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeFacts, scanCommand } from "../../../src/hooks/semantic/facts";
import { outsideProject } from "../../../src/hooks/semantic/policies";
import { SESSION_ROOT_MAX_AGE_MS, sessionProjectRoot } from "../../../src/hooks/semantic/session-root";

const HOME_VAR = "FAILPROOFAI" + "_HOME";
let fpHome: string;
let saved: string | undefined;
/** A fake user home: `launch` (no git) holding a git repo `launch/api`. */
let userHome: string;
let launch: string;
let api: string;

const rootsDir = (): string => resolve(fpHome, "state", "semantic", "roots");

function factsFor(command: string, cwd: string, pinned: string | null) {
  return computeFacts("Bash", { command }, cwd, null, scanCommand(command), pinned);
}

beforeEach(() => {
  saved = process.env[HOME_VAR];
  fpHome = mkdtempSync(join(tmpdir(), "fp-session-root-"));
  process.env[HOME_VAR] = fpHome;
  userHome = mkdtempSync(join(tmpdir(), "fp-user-home-"));
  launch = resolve(userHome, "work");
  api = resolve(launch, "api");
  mkdirSync(resolve(api, ".git"), { recursive: true });
});

afterEach(() => {
  if (saved === undefined) delete process.env[HOME_VAR];
  else process.env[HOME_VAR] = saved;
  rmSync(fpHome, { recursive: true, force: true });
  rmSync(userHome, { recursive: true, force: true });
});

describe("sessionProjectRoot", () => {
  it("pins the first cwd seen and ignores every later cd", () => {
    expect(sessionProjectRoot("s1", launch)).toBe(launch);
    // The agent ran `cd api`; the payload now reports it, and its git root.
    expect(sessionProjectRoot("s1", api)).toBe(launch);
    expect(sessionProjectRoot("s1", "/etc")).toBe(launch);
  });

  it("pins the git root when the session starts below it", () => {
    mkdirSync(resolve(api, "src"));
    expect(sessionProjectRoot("s2", resolve(api, "src"))).toBe(api);
  });

  it("keeps sessions apart", () => {
    sessionProjectRoot("a", launch);
    expect(sessionProjectRoot("b", api)).toBe(api);
  });

  it("writes the pin 0600 in a 0700 directory", () => {
    sessionProjectRoot("s3", launch);
    if (process.platform === "win32") return;
    expect(statSync(rootsDir()).mode & 0o777).toBe(0o700);
    expect(statSync(resolve(rootsDir(), "s3.json")).mode & 0o777).toBe(0o600);
  });

  it("falls back to the live root without a usable session id, and stores nothing", () => {
    expect(sessionProjectRoot(undefined, api)).toBe(api);
    expect(sessionProjectRoot("../../etc/passwd", api)).toBe(api);
    expect(() => readdirSync(rootsDir())).toThrow();
  });

  it("returns null without a cwd", () => {
    expect(sessionProjectRoot("s4", undefined)).toBeNull();
  });

  it("ignores a stored root that is not a plain absolute path, or is /", () => {
    mkdirSync(rootsDir(), { recursive: true, mode: 0o700 });
    for (const root of ["/", "relative/dir", "/a/../b", 42]) {
      writeFileSync(resolve(rootsDir(), "bad.json"), JSON.stringify({ root }), { mode: 0o600 });
      expect(sessionProjectRoot("bad", api)).toBe(api);
    }
  });

  it.skipIf(process.platform === "win32")("ignores the store when someone else can write its directory", () => {
    sessionProjectRoot("s5", launch);
    chmodSync(rootsDir(), 0o777);
    // A root this user wrote is still there, but a directory anyone could
    // write to cannot prove that — so the live root answers.
    expect(sessionProjectRoot("s5", api)).toBe(api);
  });

  it("prunes pins older than a week when a new session is pinned", () => {
    sessionProjectRoot("old", launch);
    const old = resolve(rootsDir(), "old.json");
    const past = (Date.now() - SESSION_ROOT_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(old, past, past);
    sessionProjectRoot("new", launch);
    expect(readdirSync(rootsDir()).sort()).toEqual(["new.json"]);
  });
});

describe("pinned root in the facts Jev is shown", () => {
  it("a sibling file of the opened directory stays inside the project after a cd", () => {
    const readme = resolve(launch, "README.md");
    const drifted = factsFor(`cat ${readme}`, api, null);
    expect(["inside_project", "project_root"]).not.toContain(drifted.paths[0].relation); // the old, false fire
    const pinned = factsFor(`cat ${readme}`, api, launch);
    expect(pinned.projectRoot).toBe(launch);
    expect(pinned.paths[0].relation).toBe("inside_project");
    // Still ASKED: the regex partner measures from the live cwd and can deny
    // this read, and a deny whose question is never asked can never clear.
    expect(outsideProject(pinned, pinned.paths[0])).toBe(true);
  });

  it("a cd out of the project cannot bring a secret inside it", () => {
    const f = factsFor("cd ~/.ssh && cat ./id_rsa", launch, launch);
    expect(f.paths.map((p) => p.relation)).toEqual(["outside_project_in_home", "outside_project_in_home"]);
    // And across two calls: the live cwd is now ~/.ssh, the pin is not.
    const ssh = resolve(userHome, ".ssh");
    const next = computeFacts("Read", { file_path: "./id_rsa" }, ssh, null, null, launch);
    expect(next.projectRoot).toBe(launch);
    expect(next.paths[0].relation).not.toBe("inside_project");
  });

  it("relative paths still resolve against the live cwd", () => {
    const f = factsFor("cat ./server.js", api, launch);
    expect(f.paths[0].resolved).toBe(resolve(api, "server.js"));
    expect(f.paths[0].relation).toBe("inside_project");
  });

  it("the branch is still read from the live cwd, where a commit would land", () => {
    writeFileSync(resolve(api, ".git", "HEAD"), "ref: refs/heads/feature-x\n");
    expect(factsFor("git commit -m x", api, launch).currentGitBranch).toBe("feature-x");
  });

  it("without a pin, facts are exactly what they were", () => {
    const cmd = `cat ${resolve(launch, "README.md")}`;
    expect(computeFacts("Bash", { command: cmd }, api, null, scanCommand(cmd))).toEqual(factsFor(cmd, api, null));
  });
});
