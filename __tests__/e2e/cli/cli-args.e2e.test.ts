/**
 * E2E tests for CLI argument handling.
 *
 * Verifies that every invalid/missing argument combination produces a clean
 * error message (no raw stack traces) and the correct exit code.
 *
 * Run `bun build src/index.ts --outdir dist --target node --format cjs` once
 * before running these tests.
 */
import { describe, it, expect } from "vitest";
import { runCli, assertCleanError, assertSuccess } from "../helpers/cli-runner";

// ── Top-level flags ───────────────────────────────────────────────────────────

describe("policies: --version is rejected as unknown flag (not top-level hijack)", () => {
  it("policies --version errors with unknown-flag message not 'Unexpected argument: policies'", () => {
    const result = runCli("policies", "--version");
    assertCleanError(result, "Unknown flag: --version");
  });
});

describe("top-level: --version", () => {
  it("prints version and exits 0", () => {
    const result = runCli("--version");
    assertSuccess(result);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("-v shorthand prints version and exits 0", () => {
    const result = runCli("-v");
    assertSuccess(result);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rejects extra argument after --version", () => {
    const result = runCli("--version", "adw");
    assertCleanError(result, "Unexpected argument: adw");
  });

  it("rejects extra argument after -v", () => {
    const result = runCli("-v", "adw");
    assertCleanError(result, "Unexpected argument: adw");
  });
});

describe("top-level: --help", () => {
  it("prints help and exits 0", () => {
    const result = runCli("--help");
    assertSuccess(result);
    expect(result.stdout).toContain("USAGE");
    expect(result.stdout).toContain("policies");
  });

  it("-h shorthand prints help and exits 0", () => {
    const result = runCli("-h");
    assertSuccess(result);
    expect(result.stdout).toContain("USAGE");
  });

  it("rejects extra argument after --help", () => {
    const result = runCli("--help", "o");
    assertCleanError(result, "Unexpected argument: o");
  });

  it("rejects extra argument after -h", () => {
    const result = runCli("-h", "o");
    assertCleanError(result, "Unexpected argument: o");
  });
});

describe("top-level: unknown command", () => {
  it("rejects unknown subcommand with clean error", () => {
    const result = runCli("unknowncommand");
    assertCleanError(result, "Unknown command: unknowncommand");
  });

  it("always offers a runnable suggestion for an unknown subcommand", () => {
    // Deliberately NOT pinned to a specific word. "unknowncommand" is a typo of
    // nothing, so which subcommand comes out nearest is an artefact of the
    // command LIST, not a contract: it read "policies" only because three names
    // tied at distance 12 and `SUBCOMMANDS[0]` broke the tie. Adding
    // `uninstall` (distance 10) changed the winner without changing any
    // behaviour anyone relies on. The contract is that a suggestion is offered
    // and names a real subcommand; the nearest-match behaviour itself is
    // covered by the tests below, which use inputs that ARE typos of something.
    const result = runCli("unknowncommand");
    const match = /Did you mean: failproofai (\S+)\?/.exec(result.stderr);
    expect(match).not.toBeNull();
    expect(["policies", "policy", "audit", "config", "uninstall"]).toContain(match![1]);
  });

  it("suggests the NEAREST subcommand, not a hardcoded one", () => {
    // The suggestion was the literal string "policies" for every input, which
    // was right only when the typo happened to be a typo of that word.
    expect(runCli("confg").stderr).toContain("failproofai config");
    expect(runCli("audits").stderr).toContain("failproofai audit");
  });

  it("points a stale `auth` at audit rather than somewhere unrelated", () => {
    // `auth` was a real subcommand until it was removed, so an old script or
    // plain muscle memory lands here. It must not be answered with the one
    // command that has nothing to do with what was typed.
    const result = runCli("auth", "login");
    assertCleanError(result, "Unknown command: auth");
    expect(result.stderr).toContain("failproofai audit");
  });
});

describe("top-level: unknown flag", () => {
  it("rejects unknown flag with clean error", () => {
    const result = runCli("--unknownflag");
    assertCleanError(result, "Unknown flag: --unknownflag");
  });

  it("suggests closest known flag", () => {
    const result = runCli("--unknownflag");
    expect(result.stderr).toContain("Did you mean");
  });
});

describe("top-level: --hook", () => {
  it("errors cleanly when no event type is provided", () => {
    const result = runCli("--hook");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing event type after --hook");
  });
});

// ── policies (list / default) ─────────────────────────────────────────────────

describe("policies: list (default)", () => {
  it("lists policies and exits 0 with no args", () => {
    const result = runCli("policies");
    assertSuccess(result);
    expect(result.stdout).toContain("failproofai policies");
    expect(result.stdout).not.toContain("block-sudo");
  });

  it("lists policies when --list alias is used", () => {
    const result = runCli("policies", "--list");
    assertSuccess(result);
    expect(result.stdout).toContain("failproofai policies");
  });

  it("p shorthand lists policies", () => {
    const result = runCli("p");
    assertSuccess(result);
    expect(result.stdout).toContain("failproofai policies");
  });

  it("rejects unexpected positional argument", () => {
    const result = runCli("policies", "hi");
    assertCleanError(result, "Unexpected argument: hi");
  });

  it("rejects --list with extra positional arg", () => {
    const result = runCli("policies", "--list", "hi");
    assertCleanError(result, "Unexpected argument: hi");
  });

  it("rejects unknown flag", () => {
    const result = runCli("policies", "--unknown-flag");
    assertCleanError(result, "Unknown flag: --unknown-flag");
  });
});

describe("policies: --help", () => {
  it("prints policies help and exits 0", () => {
    const result = runCli("policies", "--help");
    assertSuccess(result);
    expect(result.stdout).toContain("--install");
    expect(result.stdout).toContain("--uninstall");
  });

  it("-h shorthand prints policies help", () => {
    const result = runCli("policies", "-h");
    assertSuccess(result);
    expect(result.stdout).toContain("--install");
  });
});

describe("pack: --help", () => {
  it("prints help when the flag follows a nested subcommand", () => {
    const result = runCli("pack", "add", "--help");
    assertSuccess(result);
    expect(result.stdout).toContain("install policy packs");
  });
});

// ── policies --install ────────────────────────────────────────────────────────

describe("policies --install: unknown flags", () => {
  it("rejects unknown flag with clean error", () => {
    const result = runCli("policies", "--install", "--typo");
    assertCleanError(result, "Unknown flag: --typo");
  });

  it("rejects unknown flag even with valid policy names present", () => {
    const result = runCli("policies", "--install", "block-sudo", "--typo");
    assertCleanError(result, "Unknown flag: --typo");
  });
});

describe("policies --uninstall: unknown flags", () => {
  it("rejects unknown flag with clean error (prevents silent destructive operation)", () => {
    const result = runCli("policies", "--uninstall", "--typo");
    assertCleanError(result, "Unknown flag: --typo");
  });

  it("rejects unknown flag even with valid policy names present", () => {
    const result = runCli("policies", "--uninstall", "block-sudo", "--typo");
    assertCleanError(result, "Unknown flag: --typo");
  });
});

describe("policies --install: unknown policy names", () => {
  it("rejects single unknown policy name", () => {
    const result = runCli("policies", "--install", "okayyy");
    assertCleanError(result, "Unknown policy name(s): okayyy");
  });

  it("rejects multiple unknown policy names", () => {
    const result = runCli("policies", "--install", "foo", "bar");
    assertCleanError(result, "Unknown policy name(s): foo, bar");
  });

  it("lists valid policies in error message", () => {
    const result = runCli("policies", "--install", "okayyy");
    expect(result.stderr).toContain("Valid policies:");
    expect(result.stderr).toContain("block-sudo");
  });
});

describe("policies --install: 'all' keyword", () => {
  it("rejects unknown name even when mixed with 'all'", () => {
    const result = runCli("policies", "--install", "all", "okayyy");
    assertCleanError(result, "Unknown policy name(s): okayyy");
  });

  it("rejects 'all' combined with valid policy name", () => {
    const result = runCli("policies", "--install", "all", "block-sudo");
    assertCleanError(result, '"all" cannot be combined with specific policy names');
  });
});

describe("policies --install: --scope", () => {
  it("rejects --scope with no value", () => {
    const result = runCli("policies", "--install", "--scope");
    assertCleanError(result, "Missing value for --scope");
  });

  it("rejects invalid scope value", () => {
    const result = runCli("policies", "--install", "--scope", "badvalue");
    assertCleanError(result, "Invalid scope: badvalue");
    expect(result.stderr).toContain("user, project, local");
  });

  it("accepts valid scope: user", () => {
    const result = runCli("policies", "--install", "okayyy", "--scope", "user");
    // still errors on unknown policy, not on scope
    assertCleanError(result, "Unknown policy name(s): okayyy");
  });

  it("accepts valid scope: project", () => {
    const result = runCli("policies", "--install", "okayyy", "--scope", "project");
    assertCleanError(result, "Unknown policy name(s): okayyy");
  });

  it("accepts valid scope: local", () => {
    const result = runCli("policies", "--install", "okayyy", "--scope", "local");
    assertCleanError(result, "Unknown policy name(s): okayyy");
  });
});

describe("policies --install: --custom / -c", () => {
  it("rejects --custom with no path", () => {
    const result = runCli("policies", "--install", "--custom");
    assertCleanError(result, "Missing path after --custom/-c");
  });

  it("rejects -c with no path", () => {
    const result = runCli("policies", "--install", "-c");
    assertCleanError(result, "Missing path after --custom/-c");
  });

  it("rejects --custom when next token is a flag", () => {
    const result = runCli("policies", "--install", "--custom", "--beta");
    assertCleanError(result, "Missing path after --custom/-c");
  });

  it("rejects nonexistent custom policy file", () => {
    const result = runCli("policies", "--install", "--custom", "/nonexistent/path.js");
    // Should error cleanly (no stack trace) — either binary-not-found or file-not-found
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toMatch(/at \w+ \(.*:\d+:\d+\)/);
  });
});

// ── policies --uninstall ──────────────────────────────────────────────────────

describe("policies --uninstall: unknown policy names", () => {
  it("rejects single unknown policy name", () => {
    const result = runCli("policies", "--uninstall", "okayyy");
    assertCleanError(result, "Unknown policy name(s): okayyy");
  });

  it("rejects multiple unknown policy names", () => {
    const result = runCli("policies", "--uninstall", "foo", "bar");
    assertCleanError(result, "Unknown policy name(s): foo, bar");
  });
});

describe("policies --uninstall: --scope", () => {
  it("rejects --scope with no value", () => {
    const result = runCli("policies", "--uninstall", "--scope");
    assertCleanError(result, "Missing value for --scope");
  });

  it("rejects invalid scope value", () => {
    const result = runCli("policies", "--uninstall", "--scope", "badvalue");
    assertCleanError(result, "Invalid scope: badvalue");
    expect(result.stderr).toContain("user, project, local, all");
  });

  it("accepts valid scope: all (uninstall only)", () => {
    const result = runCli("policies", "--uninstall", "okayyy", "--scope", "all");
    assertCleanError(result, "Unknown policy name(s): okayyy");
  });
});

describe("policies -i / -u shorthands", () => {
  it("-i with unknown policy name errors cleanly", () => {
    const result = runCli("policies", "-i", "okayyy");
    assertCleanError(result, "Unknown policy name(s): okayyy");
  });

  it("-u with unknown policy name errors cleanly", () => {
    const result = runCli("policies", "-u", "okayyy");
    assertCleanError(result, "Unknown policy name(s): okayyy");
  });
});

// ── mixed valid + invalid policy names ───────────────────────────────────────

describe("policies --install: mixed valid and invalid names", () => {
  it("rejects when one valid + one invalid — reports only the invalid in unknown line", () => {
    const result = runCli("policies", "--install", "block-sudo", "fakeone");
    assertCleanError(result, "Unknown policy name(s): fakeone");
    // valid name must NOT appear in the unknown names line
    expect(result.stderr).toMatch(/Unknown policy name\(s\): fakeone$/m);
  });

  it("rejects when multiple valid + multiple invalid — reports only the invalids in unknown line", () => {
    const result = runCli("policies", "--install", "block-sudo", "sanitize-jwt", "fakeone", "faketwo");
    assertCleanError(result, "Unknown policy name(s): fakeone, faketwo");
    // valid names must NOT appear in the unknown names line
    expect(result.stderr).toMatch(/Unknown policy name\(s\): fakeone, faketwo$/m);
  });

  it("rejects when all names are invalid", () => {
    const result = runCli("policies", "--install", "fakeone", "faketwo");
    assertCleanError(result, "Unknown policy name(s): fakeone, faketwo");
  });
});

describe("policies --uninstall: mixed valid and invalid names", () => {
  it("rejects when one valid + one invalid — reports only the invalid in unknown line", () => {
    const result = runCli("policies", "--uninstall", "block-sudo", "fakeone");
    assertCleanError(result, "Unknown policy name(s): fakeone");
    expect(result.stderr).toMatch(/Unknown policy name\(s\): fakeone$/m);
  });

  it("rejects when multiple valid + multiple invalid — reports only the invalids in unknown line", () => {
    const result = runCli("policies", "--uninstall", "block-sudo", "sanitize-jwt", "fakeone", "faketwo");
    assertCleanError(result, "Unknown policy name(s): fakeone, faketwo");
    expect(result.stderr).toMatch(/Unknown policy name\(s\): fakeone, faketwo$/m);
  });
});

describe("policies --install: positional token named 'user' (scope default collision)", () => {
  it("treats 'user' as a policy name, not as consumed scope value", () => {
    const result = runCli("policies", "--install", "user");
    // "user" is not a valid policy name — should error on policy validation, not silently ignore
    assertCleanError(result, "Unknown policy name(s): user");
  });
});

describe("policies --uninstall: positional token named 'user' (scope default collision)", () => {
  it("treats 'user' as a policy name, not as consumed scope value (prevents remove-all)", () => {
    const result = runCli("policies", "--uninstall", "user");
    // "user" is not a valid policy name — should error on policy validation
    assertCleanError(result, "Unknown policy name(s): user");
  });
});

describe("policies --uninstall: all valid names", () => {
  it("succeeds with a single valid policy name", () => {
    // uninstall doesn't need the global binary — just updates config
    const result = runCli("policies", "--uninstall", "block-sudo");
    assertSuccess(result);
  });

  it("succeeds with multiple valid policy names", () => {
    const result = runCli("policies", "--uninstall", "block-sudo", "sanitize-jwt");
    assertSuccess(result);
  });
});
