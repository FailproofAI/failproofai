/**
 * `failproofai policies` warned "Hooks in multiple scopes (user, local)" on a
 * machine whose hooks live in exactly one file. Two separate causes, both of
 * which `integrationsInstalledAt` now has to rule out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-scope-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** A user-scope Claude config with a failproofai hook in it. */
function writeClaudeUserHooks(): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "npx -y failproofai --hook PreToolUse", __failproofai_hook__: true }] },
        ],
      },
    }),
    "utf8",
  );
}

describe("which scopes actually hold hooks", () => {
  it("does not count a scope an integration declares it does not support", async () => {
    // Hermes is user-scope only, and its getSettingsPath ignores the scope
    // argument — so with a hermes config present it reported the SAME user
    // file as installed at `local` and `project` too, and the listing warned
    // about "hooks in multiple scopes" on a single-scope machine.
    const { getIntegration } = await import("../../src/hooks/integrations");
    expect(getIntegration("hermes").scopes).toEqual(["user"]);

    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "config.yaml"),
      [
        "hooks:",
        "  pre_tool_call:",
        "    - type: command",
        '      command: "failproofai --hook PreToolUse --cli hermes"',
        "      __failproofai_hook__: true",
        "",
      ].join("\n"),
      "utf8",
    );

    const { integrationsInstalledAt } = await import("../../src/hooks/manager");
    // Run from a directory that is NOT home, so the project-path collision
    // in the next test cannot account for the result.
    const elsewhere = mkdtempSync(join(tmpdir(), "fpai-cwd-"));
    try {
      // The precondition: hermes IS installed, at user scope.
      expect(integrationsInstalledAt("user", elsewhere)).toContain("hermes");
      // And is not therefore also installed at the two scopes it has no
      // concept of.
      expect(integrationsInstalledAt("local", elsewhere)).not.toContain("hermes");
      expect(integrationsInstalledAt("project", elsewhere)).not.toContain("hermes");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("counts a project path that resolves to the user file once, as user", async () => {
    // Run `failproofai policies` from $HOME and <cwd>/.claude/settings.json IS
    // ~/.claude/settings.json. One file, and it used to be reported as two
    // scopes — which is what produced the warning on a single-scope machine.
    writeClaudeUserHooks();
    const { integrationsInstalledAt } = await import("../../src/hooks/manager");
    expect(integrationsInstalledAt("user", home)).toContain("claude");
    expect(integrationsInstalledAt("project", home)).not.toContain("claude");
  });

  it("still reports a genuine project install from a real project dir", async () => {
    // The fix must not silence the warning it exists to give: hooks in two
    // actually-different files are still two scopes.
    writeClaudeUserHooks();
    const project = mkdtempSync(join(tmpdir(), "fpai-proj-"));
    try {
      mkdirSync(join(project, ".claude"), { recursive: true });
      writeFileSync(
        join(project, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "*", hooks: [{ type: "command", command: "npx -y failproofai --hook PreToolUse", __failproofai_hook__: true }] },
            ],
          },
        }),
        "utf8",
      );
      const { integrationsInstalledAt } = await import("../../src/hooks/manager");
      expect(integrationsInstalledAt("user", project)).toContain("claude");
      expect(integrationsInstalledAt("project", project)).toContain("claude");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("hooksInstalledInSettings still answers yes for a non-Claude CLI", async () => {
    // The regression this whole path was built to fix: a machine set up for
    // codex was told nothing was installed.
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "npx -y failproofai --hook PreToolUse --cli codex" }] }] },
      }),
      "utf8",
    );
    const { hooksInstalledInSettings } = await import("../../src/hooks/manager");
    expect(hooksInstalledInSettings("user", home)).toBe(true);
  });
});
