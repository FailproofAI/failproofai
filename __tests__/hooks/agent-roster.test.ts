// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntimeAgentIdentity, runtimeAgentSettingsPath } from "../../src/hooks/agent-roster";
import { agentTargetsMatch, parseAgentTargets } from "../../src/hooks/agent-targets";

const roots: string[] = [];
const previousHome = process.env.FAILPROOFAI_HOME;
const previousHermes = process.env.HERMES_HOME;
const previousClaude = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (previousHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = previousHome;
  if (previousHermes === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = previousHermes;
  if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime agent identity", () => {
  it("detects a project-only hook and refuses to guess when project and user hooks both apply", () => {
    const root = mkdtempSync(join(tmpdir(), "fpai-agent-scopes-"));
    roots.push(root);
    delete process.env.CLAUDE_CONFIG_DIR;
    const user = join(root, "user");
    const project = join(root, "repo");
    const nested = join(project, "src");
    const projectSettings = join(project, ".claude", "settings.json");
    const userSettings = join(user, ".claude", "settings.json");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(join(user, ".claude"), { recursive: true });
    writeFileSync(projectSettings, '{"hooks":"failproofai --hook PreToolUse"}');
    expect(runtimeAgentSettingsPath("claude", nested, user)).toBe(projectSettings);
    writeFileSync(userSettings, '{"hooks":"failproofai --hook PreToolUse"}');
    expect(runtimeAgentSettingsPath("claude", nested, user)).toBeNull();
    expect(runtimeAgentSettingsPath("claude", nested, user, "project")).toBe(projectSettings);
    expect(runtimeAgentSettingsPath("claude", nested, user, "user")).toBe(userSettings);
    const localSettings = join(project, ".claude", "settings.local.json");
    writeFileSync(localSettings, '{"hooks":"failproofai --hook PreToolUse"}');
    expect(runtimeAgentSettingsPath("claude", nested, user, "local")).toBe(localSettings);
    expect(runtimeAgentSettingsPath("claude", nested, user, "project")).toBe(projectSettings);
    rmSync(projectSettings);
    rmSync(localSettings);
    expect(runtimeAgentSettingsPath("claude", nested, user)).toBe(userSettings);
  });

  it("counts Pi's relative project extension when deciding whether two scopes are ambiguous", () => {
    const root = mkdtempSync(join(tmpdir(), "fpai-pi-scopes-"));
    roots.push(root);
    const user = join(root, "user");
    const project = join(root, "repo");
    const projectSettings = join(project, ".pi", "settings.json");
    const userSettings = join(user, ".pi", "agent", "settings.json");
    mkdirSync(join(project, ".pi"), { recursive: true });
    mkdirSync(join(user, ".pi", "agent"), { recursive: true });
    writeFileSync(projectSettings, '{"packages":["../pi-extension"]}');
    expect(runtimeAgentSettingsPath("pi", project, user)).toBe(projectSettings);
    writeFileSync(userSettings, '{"packages":["/opt/failproofai/pi-extension"]}');
    expect(runtimeAgentSettingsPath("pi", project, user)).toBeNull();
    // A package-level Pi extension cannot stamp which settings file loaded
    // it. Without that proof an exact-profile assignment matches neither.
    expect(readRuntimeAgentIdentity("pi", runtimeAgentSettingsPath("pi", project, user))).toBeNull();
  });

  it("resolves a named profile from the invoking hook's config path", () => {
    const root = mkdtempSync(join(tmpdir(), "fpai-agent-roster-"));
    roots.push(root);
    process.env.FAILPROOFAI_HOME = root;
    process.env.HERMES_HOME = join(root, "profiles", "work");
    const path = runtimeAgentSettingsPath("hermes");
    const rosterPath = join(root, "agents", "roster.json");
    mkdirSync(join(root, "agents"));
    writeFileSync(rosterPath, JSON.stringify({
      schemaVersion: 1, generation: 5,
      agents: [
        { integration: "hermes", instanceId: "agt_1234567890abcdef",
          settingsPath: path, profileLabel: "work", scope: "user", hookInstalled: true },
        { integration: "hermes", instanceId: "agt_abcdef1234567890",
          settingsPath: join(root, "profiles", "personal", "config.yaml"),
          profileLabel: "personal", scope: "user", hookInstalled: true },
      ],
    }));
    chmodSync(rosterPath, 0o600);
    expect(readRuntimeAgentIdentity("hermes", path)).toEqual({
      integration: "hermes", instanceId: "agt_1234567890abcdef",
    });
    expect(readRuntimeAgentIdentity("hermes", join(root, "profiles", "absent", "config.yaml"))).toBeNull();
    expect(readRuntimeAgentIdentity("codex", path)).toBeNull();
    const exact = parseAgentTargets([{ integration: "hermes", instanceId: "agt_1234567890abcdef" }], 3);
    expect(agentTargetsMatch(exact, readRuntimeAgentIdentity("hermes", path))).toBe(true);
    expect(agentTargetsMatch(exact, null)).toBe(false);
  });

  it("withholds a scoped identity if the roster is unreadable or not owner-only", () => {
    const root = mkdtempSync(join(tmpdir(), "fpai-agent-roster-"));
    roots.push(root);
    process.env.FAILPROOFAI_HOME = root;
    const path = join(root, "agent", "config.yaml");
    const rosterPath = join(root, "agents", "roster.json");
    mkdirSync(join(root, "agents"));
    writeFileSync(rosterPath, JSON.stringify({
      schemaVersion: 1, agents: [
        { integration: "hermes", instanceId: "agt_1234567890abcdef", settingsPath: path },
      ],
    }));
    chmodSync(rosterPath, 0o644);
    expect(readRuntimeAgentIdentity("hermes", path)).toBeNull();
    chmodSync(rosterPath, 0o600);
    writeFileSync(rosterPath, "not JSON");
    expect(readRuntimeAgentIdentity("hermes", path)).toBeNull();
  });
});
