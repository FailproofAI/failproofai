import { describe, expect, it } from "vitest";
import { createFixtureEnv } from "../helpers/fixture-env";
import { assertPreToolUseDeny, runHook } from "../helpers/hook-runner";
import { Payloads } from "../helpers/payloads";

describe("CommonJS policies in the packaged Node CLI", () => {
  it("loads a CommonJS entry with a transitive CommonJS helper", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    env.writePolicyFile("helper.cjs", `
      const { deny } = require("failproofai");
      module.exports = () => deny("CommonJS helper enforced");
    `);
    env.writePolicyFile("node-policies.js", `
      const { customPolicies } = require("failproofai");
      const policy = require("./helper.cjs");
      customPolicies.add({ name: "node-cjs", match: { events: ["PreToolUse"] }, fn: async () => policy() });
    `);
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("ls", env.cwd), {
      homeDir: env.home, runtime: "node",
    });
    expect(result.exitCode, result.stderr).toBe(0);
    assertPreToolUseDeny(result);
    expect(result.stdout).toContain("CommonJS helper enforced");
  });

  it("loads an ESM entry importing a CommonJS helper", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    env.writePolicyFile("helper.cjs", `
      const { deny } = require("failproofai");
      module.exports = () => deny("ESM to CommonJS helper enforced");
    `);
    env.writePolicyFile("node-policies.mjs", `
      import { customPolicies } from "failproofai";
      import policy from "./helper.cjs";
      customPolicies.add({ name: "node-esm", match: { events: ["PreToolUse"] }, fn: async () => policy() });
    `);
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("ls", env.cwd), {
      homeDir: env.home, runtime: "node",
    });
    expect(result.exitCode, result.stderr).toBe(0);
    assertPreToolUseDeny(result);
    expect(result.stdout).toContain("ESM to CommonJS helper enforced");
  });
});
