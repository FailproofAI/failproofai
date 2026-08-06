// @vitest-environment node
/**
 * The fail-closed path, against the real evaluation engine.
 *
 * `forceDecision` is what `bin/failproofai.mjs` reaches for when a
 * daemon-configured machine cannot reach its daemon. It is the single most
 * consequential branch in the product — it denies EVERYTHING, on every CLI —
 * and it had no test at all: `grep -rn forceDecision __tests__/` returned
 * nothing, and the only coverage was a pair of shell scripts that hardcode an
 * absolute developer path, are outside the vitest glob, and run in no workflow.
 *
 * Deliberately unmocked apart from telemetry. What matters here is the exact
 * bytes an agent receives, and a mocked `policy-evaluator` would assert the
 * shape of a stub instead of the shape of a deny.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));

/** Captured so a degraded-but-silent failure is distinguishable from a clean run. */
const warnings: string[] = [];
vi.mock("../../src/hooks/hook-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/hook-logger")>();
  return {
    ...actual,
    hookLogWarn: vi.fn((msg: string) => {
      warnings.push(msg);
    }),
  };
});

import { evaluateHookEvent } from "../../src/hooks/handler";

const FORCED = {
  decision: "deny" as const,
  reason: "failproofaid could not be reached.",
};

let projectDir: string;

beforeEach(() => {
  warnings.length = 0;
  projectDir = mkdtempSync(join(tmpdir(), "fpai-fail-closed-"));
  mkdirSync(join(projectDir, ".failproofai"), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function stdin(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: "s1", cwd: projectDir, ...extra });
}

/** Claude's PreToolUse deny is JSON on stdout at exit 0, not a nonzero exit. */
function permissionDecisionOf(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    return parsed.hookSpecificOutput?.permissionDecision;
  } catch {
    return undefined;
  }
}

describe("hooks/handler forceDecision (fail-closed)", () => {
  it("denies a tool call and gives the operator the reason verbatim", async () => {
    const result = await evaluateHookEvent("PreToolUse", "claude", stdin({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    }), { forceDecision: FORCED });

    expect(permissionDecisionOf(result.stdout)).toBe("deny");
    expect(`${result.stdout}${result.stderr}`).toContain("failproofaid could not be reached");
  });

  it("denies a command no policy would ever object to", async () => {
    // The point of fail-closed: the verdict does not depend on the command.
    const result = await evaluateHookEvent("PreToolUse", "claude", stdin({
      tool_name: "Read",
      tool_input: { file_path: join(projectDir, "README.md") },
    }), { forceDecision: FORCED });

    expect(permissionDecisionOf(result.stdout)).toBe("deny");
  });

  // The synthetic policy registers with `match: {}` (handler.ts), which matches
  // EVERY event — including the one that carries what the user typed. So a
  // machine whose daemon is down cannot merely not run tools; it cannot hold a
  // conversation. That is the difference between "enforcement is degraded" and
  // "the product is bricked", and it is the reason a repair route exists at all
  // (see `probeDaemonEndToEnd` and `healDaemonFlag`). Pinned as the current,
  // deliberate behaviour so that changing it is a decision rather than an
  // accident.
  it("also denies UserPromptSubmit — the user cannot even talk to their agent", async () => {
    const result = await evaluateHookEvent("UserPromptSubmit", "claude", stdin({ prompt: "hello" }), {
      forceDecision: FORCED,
    });

    expect(`${result.stdout}${result.stderr}`).toContain("failproofaid could not be reached");
    expect(result.exitCode !== 0 || permissionDecisionOf(result.stdout) === "deny").toBe(true);
  });

  it("loads no project policy config — an unreachable daemon ran none of it", async () => {
    // A custom policy file that would throw if it were ever imported. The
    // fail-closed branch must not touch the project's configuration at all:
    // the daemon it could not reach never evaluated any of it either, so
    // loading it here would report a decision no daemon made.
    const policyPath = join(projectDir, "exploding-policies.mjs");
    writeFileSync(policyPath, `throw new Error("must never be imported on the fail-closed path");\n`);
    writeFileSync(
      join(projectDir, ".failproofai", "policies-config.json"),
      JSON.stringify({ enabledPolicies: [], customPoliciesPaths: [policyPath] }),
    );

    const result = await evaluateHookEvent("PreToolUse", "claude", stdin({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    }), { forceDecision: FORCED });

    expect(permissionDecisionOf(result.stdout)).toBe("deny");
    expect(`${result.stdout}${result.stderr}`).not.toContain("must never be imported");
  });
});

/**
 * The outer boundary in `bin/failproofai.mjs` — the last thing standing between
 * an unexpected throw and a silent allow.
 *
 * The header of the corrupt-manifest suite below already describes this failure
 * exactly: "the throw reaches the CLI's outer catch, which exits 2 with nothing
 * on stdout — a deny on Claude and Factory, but a warning followed by an ALLOW
 * on the [CLIs] that read a decision off stdout and ignore the exit code."
 * `readActiveCloudManagedPolicies` was wrapped to stop ONE source of such
 * throws, but the boundary itself still failed open for every other source —
 * including a throw from the forced-deny call that handles an unreachable
 * daemon, i.e. the fail-closed path failing open.
 */
describe("the fail-closed verdict is enforcing on every supported CLI", () => {
  // Every CLI the `--hook` entrypoint accepts. Kept literal rather than derived,
  // so adding a CLI without deciding how it denies fails here.
  const CLIS = [
    "claude", "codex", "copilot", "cursor", "opencode", "pi",
    "hermes", "openclaw", "factory", "devin", "antigravity", "goose",
  ] as const;

  // The CLIs that read their verdict from stdout JSON and IGNORE the exit code.
  // For these, an empty stdout is not a weak deny — it is an allow.
  const STDOUT_DRIVEN = [
    "cursor", "pi", "hermes", "openclaw", "devin", "antigravity", "goose",
  ] as const;

  it.each(CLIS)("%s receives a verdict that actually enforces", async (cli) => {
    const result = await evaluateHookEvent("PreToolUse", cli, stdin({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    }), { forceDecision: FORCED });

    const emitted = `${result.stdout}${result.stderr}`;
    expect(emitted).toContain("failproofaid could not be reached");
    expect(
      result.stdout.length > 0 || result.exitCode !== 0,
      "a verdict with no stdout and a zero exit is an allow",
    ).toBe(true);
  });

  it.each(STDOUT_DRIVEN)("%s gets its deny on stdout, not merely an exit code", async (cli) => {
    const result = await evaluateHookEvent("PreToolUse", cli, stdin({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    }), { forceDecision: FORCED });

    expect(result.stdout.length).toBeGreaterThan(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stdout).toContain("failproofaid could not be reached");
  });
});

/**
 * A tripwire on the `--hook` catch block itself.
 *
 * The logic lives in `bin/failproofai.mjs`, which cannot be imported by vitest
 * (a bare `package.json` import and extensionless TypeScript specifiers — see
 * CLAUDE.md), so its shape is asserted from source, the same way
 * `dogfood-configs.test.ts` guards the committed hook configs. Both properties
 * here regressed silently once already.
 */
describe("bin/failproofai.mjs --hook error boundary", () => {
  const source = readFileSync(
    join(__dirname, "..", "..", "bin", "failproofai.mjs"),
    "utf8",
  );
  // From `} catch (err) {` after the hook block to the end of that handler.
  const hookCatch = source.slice(
    source.indexOf("const hookIdx = args.indexOf(\"--hook\");"),
    source.indexOf("Centralised error handler for all CLI subcommands"),
  );

  it("writes a decision to stdout rather than exiting silently", () => {
    // The whole bug: the handler logged to stderr and exited, writing zero
    // bytes to stdout — which the stdout-driven CLIs above read as an allow.
    expect(hookCatch).toMatch(/catch \(err\)[\s\S]*process\.stdout\.write/);
  });

  it("never leaves the hook path through a bare process.exit", () => {
    // `process.exit` truncates pending pipe writes, and on this path those
    // writes ARE the decision. `exitAfterFlush` exists for exactly this.
    const afterCatch = hookCatch.slice(hookCatch.indexOf("} catch (err) {"));
    expect(afterCatch).not.toMatch(/\bprocess\.exit\(/);
    expect(afterCatch).toMatch(/await exitAfterFlush\(/);
  });
});

/**
 * A corrupt cloud-managed manifest must cost the cloud layer, not the machine.
 *
 * `readActiveCloudManagedPolicies()` has fourteen throw sites and sat bare
 * inside `evaluateHookEvent`'s `try`, whose only handler is a `finally` — so any
 * of them aborted the whole evaluation. The outcome then depended on where the
 * hook ran, and neither branch was the intended one: on a daemon machine the
 * client fail-closed denies everything, and off it the throw reaches the CLI's
 * outer catch, which exits 2 with nothing on stdout — a deny on Claude and
 * Factory, but a warning followed by an ALLOW on the five CLIs that read a
 * decision off stdout and ignore the exit code.
 */
describe("hooks/handler with a corrupt cloud-managed manifest", () => {
  let policyRoot: string;

  beforeEach(() => {
    policyRoot = mkdtempSync(join(tmpdir(), "fpai-corrupt-managed-"));
    process.env.FAILPROOFAI_CLOUD_POLICY_DIR = policyRoot;
  });

  afterEach(() => {
    delete process.env.FAILPROOFAI_CLOUD_POLICY_DIR;
    rmSync(policyRoot, { recursive: true, force: true });
  });

  it("keeps enforcing local policies instead of aborting the evaluation", async () => {
    writeFileSync(join(policyRoot, "active.json"), "{ this is not json");
    writeFileSync(
      join(projectDir, ".failproofai", "policies-config.json"),
      JSON.stringify({ enabledPolicies: ["block-sudo"] }),
    );

    // The local builtin still fires — the cloud layer degrades alone.
    const denied = await evaluateHookEvent("PreToolUse", "claude", stdin({
      tool_name: "Bash",
      tool_input: { command: "sudo rm -rf /" },
    }));
    expect(permissionDecisionOf(denied.stdout)).toBe("deny");

    // And a benign command is still allowed, rather than the whole machine
    // being denied (daemon path) or silently allowed (Copilot/Cursor/Goose/
    // Pi/Hermes, which ignore the exit code).
    const allowed = await evaluateHookEvent("PreToolUse", "claude", stdin({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    }));
    expect(permissionDecisionOf(allowed.stdout)).toBeUndefined();
    expect(allowed.exitCode).toBe(0);
  });

  it("says loudly that cloud policies are not being enforced", async () => {
    // Failing open silently would be the worse bug: a managed machine would
    // look protected and be enforcing only its local set.
    writeFileSync(
      join(policyRoot, "active.json"),
      JSON.stringify({ schemaVersion: 999, generation: 1, policies: [] }),
    );

    const result = await evaluateHookEvent("PreToolUse", "claude", stdin({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    }));

    expect(result.exitCode).toBe(0);
    expect(warnings.join("\n")).toMatch(/cloud-managed policies could NOT be loaded/i);
  });
});
