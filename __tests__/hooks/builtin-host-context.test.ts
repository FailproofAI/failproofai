/**
 * Stage 0 / P2 — host context arrives as request data, not as an ambient read.
 *
 * `block-read-outside-cwd.test.ts` (632 lines) already proves the *legacy*
 * behaviour is unchanged: with no `home` / `projectDir` on the session, the
 * policies fall back to this process's `os.homedir()` and
 * `$CLAUDE_PROJECT_DIR` exactly as before. That suite is the compatibility
 * gate and is deliberately untouched.
 *
 * This suite proves the other half — the half the daemon depends on and that
 * nothing else covers: when the session DOES carry `home` / `projectDir`, the
 * policies use those and ignore the host entirely.
 *
 * Why that matters concretely: the daemon evaluates on behalf of another UID,
 * so its own `homedir()` is `_failproofai`'s. A sealed `block-read-outside-cwd`
 * reading the ambient home would whitelist `/var/lib/failproofai/.claude`
 * instead of the requesting user's `~/.claude` — quietly wrong in both
 * directions at once. And because `isAgentInternalPath` *widens* the allow set,
 * getting it wrong relaxes a verdict rather than tightening one, which is the
 * failure mode that does not announce itself.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { blockReadOutsideCwd, blockRmRf } from "../../src/hooks/builtin/payload-only";
import {
  resolveHome,
  resolveProjectDir,
  setHostContextFallback,
  resetHostContextFallback,
} from "../../src/hooks/builtin/host-context";
import type { PolicyContext } from "../../src/hooks/policy-types";
// Importing the registry installs the real host fallback as a side effect —
// which is exactly the wiring under test.
import "../../src/hooks/builtin-policies";

const PROJECT = "/srv/work/project";
/** A home that is definitely not this process's, so a leak is unambiguous. */
const OTHER_HOME = "/home/enrolled-user";

function ctx(overrides: Partial<PolicyContext> & { session?: PolicyContext["session"] }): PolicyContext {
  return {
    eventType: "PreToolUse",
    payload: {},
    params: {},
    ...overrides,
  } as PolicyContext;
}

describe("resolveHome / resolveProjectDir", () => {
  afterEach(() => {
    // Restore the wiring `builtin-policies.ts` installs at import.
    setHostContextFallback({
      home: () => homedir(),
      projectDir: () => process.env.CLAUDE_PROJECT_DIR,
    });
  });

  it("prefers request data over the host", () => {
    const c = ctx({ session: { home: OTHER_HOME, projectDir: PROJECT } });
    expect(resolveHome(c)).toBe(OTHER_HOME);
    expect(resolveHome(c)).not.toBe(homedir());
    expect(resolveProjectDir(c)).toBe(PROJECT);
  });

  it("falls back to the host when the envelope carried nothing", () => {
    expect(resolveHome(ctx({ session: {} }))).toBe(homedir());
    expect(resolveHome(ctx({}))).toBe(homedir());
  });

  it("treats an empty-string home as absent rather than as root", () => {
    // A `home: ""` reaching `join("", ".claude")` would produce the relative
    // path `.claude`, and an empty `$HOME` expansion would turn `~/x` into
    // `/x`. Both are wrong; absent-means-fallback is the safe reading.
    expect(resolveHome(ctx({ session: { home: "" } }))).toBe(homedir());
  });

  it("treats an empty-string projectDir as absent, matching the `||` it replaced", () => {
    // The code this replaced was `process.env.CLAUDE_PROJECT_DIR || cwd`, so an
    // env var set to "" fell through to cwd. `??` would have changed that.
    expect(resolveProjectDir(ctx({ session: { projectDir: "" } }))).toBeUndefined();
  });

  it("fails closed when neither request data nor a fallback is available", () => {
    resetHostContextFallback();
    expect(resolveHome(ctx({ session: {} }))).toBe("");
    expect(resolveProjectDir(ctx({ session: {} }))).toBeUndefined();
  });
});

describe("block-read-outside-cwd reads home from the request", () => {
  const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  it("whitelists the REQUESTING user's agent dir, not the evaluating process's", () => {
    const result = blockReadOutsideCwd(
      ctx({
        toolName: "Read",
        toolInput: { file_path: `${OTHER_HOME}/.claude/CLAUDE.md` },
        session: { cwd: PROJECT, home: OTHER_HOME },
      }),
    );
    expect(result.decision).toBe("allow");
  });

  it("does NOT whitelist the evaluating process's agent dir when a home was supplied", () => {
    // The inverse, and the one that actually catches a leak: with the request
    // naming a different home, this process's own ~/.claude must be treated
    // like any other out-of-project path.
    const result = blockReadOutsideCwd(
      ctx({
        toolName: "Read",
        toolInput: { file_path: `${homedir()}/.claude/CLAUDE.md` },
        session: { cwd: PROJECT, home: OTHER_HOME },
      }),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("outside project directory");
  });

  it("prefers session.projectDir over session.cwd", () => {
    // cwd has drifted into a subdirectory; projectDir is the stable root, so a
    // sibling under the root is in-project.
    const result = blockReadOutsideCwd(
      ctx({
        toolName: "Read",
        toolInput: { file_path: `${PROJECT}/docs/readme.md` },
        session: { cwd: `${PROJECT}/src/deep/nested`, projectDir: PROJECT, home: OTHER_HOME },
      }),
    );
    expect(result.decision).toBe("allow");
  });

  it("expands ~ in a Bash read against the request's home", () => {
    const result = blockReadOutsideCwd(
      ctx({
        toolName: "Bash",
        toolInput: { command: "cat ~/secrets.txt" },
        session: { cwd: PROJECT, home: OTHER_HOME },
      }),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain(`${OTHER_HOME}/secrets.txt`);
  });

  it("still blocks an agent settings file even inside the request's own home", () => {
    // Settings files are checked BEFORE the internal-path whitelist, and that
    // ordering must survive the threading.
    const result = blockReadOutsideCwd(
      ctx({
        toolName: "Read",
        toolInput: { file_path: `${OTHER_HOME}/.claude/settings.json` },
        session: { cwd: PROJECT, home: OTHER_HOME },
      }),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("agent settings file");
  });
});

describe("block-rm-rf expands ~ against the request's home", () => {
  it("counts a delete of the request's home as catastrophic", () => {
    const result = blockRmRf(
      ctx({
        toolName: "Bash",
        toolInput: { command: "rm -rf ~/" },
        session: { cwd: PROJECT, home: OTHER_HOME },
      }),
    );
    expect(result.decision).toBe("deny");
  });

  // Note the deliberate use of home-relative COMMAND tokens below. An absolute
  // `/home/<user>/scratch` is three segments deep and therefore never
  // catastrophic, so it would exit `blockRmRf` before the allowlist is
  // consulted and the assertion would pass without testing anything. `~/scratch`
  // is one segment below the home root, which is what puts it on the
  // catastrophic path where `expandHomePrefix` — and therefore `home` — decides
  // the outcome.

  it("matches an allowPaths entry that expands against the request's home", () => {
    const result = blockRmRf(
      ctx({
        toolName: "Bash",
        toolInput: { command: "rm -rf ~/scratch" },
        params: { allowPaths: [`${OTHER_HOME}/scratch`] },
        session: { cwd: PROJECT, home: OTHER_HOME },
      }),
    );
    expect(result.decision).toBe("allow");
  });

  it("does not match that same allowPaths entry when the request names a different home", () => {
    // Identical command and identical allowlist; only `home` changes. The
    // target now expands somewhere the allowlist does not cover, so the delete
    // is refused. This is the assertion that a leaked ambient `homedir()`
    // would break.
    const result = blockRmRf(
      ctx({
        toolName: "Bash",
        toolInput: { command: "rm -rf ~/scratch" },
        params: { allowPaths: [`${OTHER_HOME}/scratch`] },
        session: { cwd: PROJECT, home: "/home/someone-else" },
      }),
    );
    expect(result.decision).toBe("deny");
  });
});
