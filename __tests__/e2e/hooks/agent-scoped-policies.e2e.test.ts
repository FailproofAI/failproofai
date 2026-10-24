// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFixtureEnv } from "../helpers/fixture-env";
import { assertAllow, assertPreToolUseDeny, runHook } from "../helpers/hook-runner";

describe("real CLI hook distinguishes simultaneous project and user profiles", () => {
  it("applies targeted Cloud JS only when the installed hook carries its actual settings scope", () => {
    const fixture = createFixtureEnv();
    const projectSettings = join(fixture.cwd, ".claude", "settings.json");
    const userSettings = join(fixture.home, ".claude", "settings.json");
    mkdirSync(join(fixture.cwd, ".claude"), { recursive: true });
    mkdirSync(join(fixture.home, ".claude"), { recursive: true });
    writeFileSync(projectSettings, '{"hooks":"failproofai --hook PreToolUse --agent-scope project"}');
    writeFileSync(userSettings, '{"hooks":"failproofai --hook PreToolUse --agent-scope user"}');

    const fpHome = join(fixture.home, ".failproofai");
    const rosterDir = join(fpHome, "agents");
    mkdirSync(rosterDir, { recursive: true });
    const projectId = "agt_1234567890abcdef";
    const userId = "agt_abcdef1234567890";
    const roster = join(rosterDir, "roster.json");
    writeFileSync(roster, JSON.stringify({
      schemaVersion: 1, generation: 2,
      agents: [
        { integration: "claude", instanceId: projectId, settingsPath: projectSettings,
          profileLabel: "project", scope: "project", hookInstalled: true },
        { integration: "claude", instanceId: userId, settingsPath: userSettings,
          profileLabel: "user", scope: "user", hookInstalled: true },
      ],
    }), { mode: 0o600 });
    chmodSync(roster, 0o600);

    const cloudDir = join(fpHome, "policies", "cloud-policies");
    mkdirSync(join(cloudDir, "artifacts"), { recursive: true });
    const source = `import { customPolicies, deny } from "failproofai";
customPolicies.add({
  name: "only-project", description: "Only this installation",
  match: { events: ["PreToolUse"] },
  fn: async () => deny("project agent"),
});`;
    const digest = createHash("sha256").update(source).digest("hex");
    const artifact = `artifacts/${digest}.mjs`;
    writeFileSync(join(cloudDir, artifact), source);
    writeFileSync(join(cloudDir, "active.json"), JSON.stringify({
      schemaVersion: 3, deployment: 1,
      policies: [{
        id: "scope-check", version: 1, sha256: digest, path: artifact, effect: "enforce",
        agentTargets: [{ integration: "claude", instanceId: projectId }],
      }],
    }));

    const payload = {
      session_id: "scope-test", hook_event_name: "PreToolUse",
      tool_name: "Bash", tool_input: { command: "ls" }, cwd: fixture.cwd,
    };
    const project = runHook("PreToolUse", payload, {
      homeDir: fixture.home, cwd: fixture.cwd, agentScope: "project",
    });
    assertPreToolUseDeny(project);

    const user = runHook("PreToolUse", payload, {
      homeDir: fixture.home, cwd: fixture.cwd, agentScope: "user",
    });
    assertAllow(user);

    const legacyAmbiguous = runHook("PreToolUse", payload, {
      homeDir: fixture.home, cwd: fixture.cwd,
    });
    assertAllow(legacyAmbiguous);
    const report = JSON.parse(readFileSync(join(cloudDir, "errors.json"), "utf8"));
    expect(report.errors).toContainEqual(expect.objectContaining({
      id: "agentScope", message: expect.stringContaining("agent_scope_unresolved"),
    }));
  });
});
