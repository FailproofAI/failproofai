// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { registerBuiltinPolicies } from "../../src/hooks/builtin-policies";
import { evaluatePolicies } from "../../src/hooks/policy-evaluator";
import { clearPolicies } from "../../src/hooks/policy-registry";

/**
 * OpenClaw passes its own `apply_patch` tool to policies under that name,
 * uncanonicalized, where Codex's arrives as `Edit`. The always-on guard matched
 * only Bash and the file tools, so an OpenClaw patch that planted
 * `node_modules/.bin/failproofai`, or rewrote failproofai's state, never
 * reached it (FailproofAI/failproofai#1058). This runs the guard the way the
 * handler does: registered from its catalog matcher, then evaluated.
 */
describe("block-failproofai-commands — OpenClaw's native apply_patch", () => {
  beforeEach(() => {
    clearPolicies();
    registerBuiltinPolicies([]);
  });

  const patchOf = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n");
  const evaluate = (toolInput: Record<string, unknown>) =>
    evaluatePolicies(
      "PreToolUse",
      { tool_name: "apply_patch", tool_input: toolInput, cwd: "/work/proj" },
      { cli: "openclaw", cwd: "/work/proj" },
    );

  it.each([
    ["adding the npx entry", { input: patchOf("*** Add File: node_modules/.bin/failproofai", "+exit 0") }],
    ["rewriting the state", { input: patchOf("*** Update File: /home/u/.failproofai/policies-config.json", "@@", "+{}") }],
    ["rewriting the installed package", { patch: patchOf("*** Update File: node_modules/failproofai/dist/cli.mjs", "@@", "+exit 0") }],
  ])("denies a patch %s", async (_label, toolInput) => {
    const result = await evaluate(toolInput);
    expect(result.decision).toBe("deny");
    expect(result.policyName).toBe("failproofai/block-failproofai-commands");
  });

  it("allows a patch to project files", async () => {
    const result = await evaluate({ input: patchOf("*** Update File: src/app.ts", "@@", "-a", "+b") });
    expect(result.decision).toBe("allow");
  });
});
