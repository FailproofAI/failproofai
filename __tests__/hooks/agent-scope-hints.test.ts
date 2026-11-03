// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getIntegration } from "../../src/hooks/integrations";
import type { IntegrationType } from "../../src/hooks/types";

const SHELL_INTEGRATIONS: IntegrationType[] = [
  "claude", "codex", "copilot", "cursor",
  "factory", "devin", "antigravity", "goose",
];

describe("installed shell hooks carry their originating scope", () => {
  for (const cli of SHELL_INTEGRATIONS) {
    it(`${cli}: user and project commands carry different scope hints`, () => {
      const integration = getIntegration(cli);
      for (const scope of ["user", "project"] as const) {
        const entry = integration.buildHookEntry("/usr/local/bin/failproofai", "PreToolUse", scope);
        const command = typeof entry.command === "string" ? entry.command : entry.bash;
        expect(command).toContain(`--agent-scope ${scope}`);
        if (cli === "copilot") expect(entry.powershell).toContain(`--agent-scope ${scope}`);
      }
    });
  }

  it("Claude's local hook identifies the local settings file", () => {
    expect(getIntegration("claude").buildHookEntry("/bin/failproofai", "PreToolUse", "local"))
      .toMatchObject({ command: expect.stringContaining("--agent-scope local") });
  });
});
