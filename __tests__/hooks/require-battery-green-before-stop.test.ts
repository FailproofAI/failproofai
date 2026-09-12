// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyContext } from "../../src/hooks/policy-types";

// Import the builtin policies array to get the policy function
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";

const policy = BUILTIN_POLICIES.find((p) => p.name === "require-battery-green-before-stop")!;

function makeCtx(overrides: Partial<PolicyContext>): PolicyContext {
  return {
    eventType: "Stop",
    payload: {},
    ...overrides,
  } as PolicyContext;
}

function repoWithBattery(exitCode: 0 | 1): string {
  const dir = mkdtempSync(join(tmpdir(), "fpai-battery-"));
  const scriptDir = join(dir, "scripts", "verify");
  mkdirSync(scriptDir, { recursive: true });
  const script = join(scriptDir, "battery.sh");
  writeFileSync(script, `#!/bin/sh\nexit ${exitCode}\n`);
  chmodSync(script, 0o755);
  return dir;
}

describe("require-battery-green-before-stop policy", () => {
  it("exists in BUILTIN_POLICIES, off by default, Stop-only", () => {
    expect(policy).toBeDefined();
    expect(policy.defaultEnabled).toBe(false);
    expect(policy.match.events).toEqual(["Stop"]);
  });

  it("allows when no cwd in session (graceful fallback)", async () => {
    const result = await policy.fn(makeCtx({}));
    expect(result.decision).toBe("allow");
  });

  it("allows when no battery script exists (fail-open)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fpai-nobattery-"));
    const result = await policy.fn(makeCtx({ session: { cwd: dir } }));
    expect(result.decision).toBe("allow");
    expect(result.reason).toMatch(/no .*battery/i);
  });

  it("allows when the battery passes", async () => {
    const dir = repoWithBattery(0);
    const result = await policy.fn(makeCtx({ session: { cwd: dir } }));
    expect(result.decision).toBe("allow");
  });

  it("denies when the battery fails", async () => {
    const dir = repoWithBattery(0);
    const sub = join(dir, "packages", "app");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, "scripts", "verify", "battery.sh"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, "scripts", "verify", "battery.sh"), 0o755);
    const result = await policy.fn(makeCtx({ session: { cwd: sub } }));
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/battery/i);
  });

  it("finds the battery from a nested working directory", async () => {
    const dir = repoWithBattery(0);
    const sub = join(dir, "a", "b");
    mkdirSync(sub, { recursive: true });
    const result = await policy.fn(makeCtx({ session: { cwd: sub } }));
    expect(result.decision).toBe("allow");
  });

  it("allows in plan mode without running anything", async () => {
    const result = await policy.fn(
      makeCtx({ session: { cwd: "/nonexistent", permissionMode: "plan" } }),
    );
    expect(result.decision).toBe("allow");
  });
});
