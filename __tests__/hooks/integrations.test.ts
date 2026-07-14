/**
 * Unit tests for the per-CLI Integration adapter (src/hooks/integrations.ts).
 *
 * Covers Claude Code, OpenAI Codex, and GitHub Copilot:
 *   • per-scope settings path
 *   • hook entry shape + idempotent install
 *   • mark/detect/remove
 *   • Codex-specific snake → Pascal mapping in settings keys
 *   • Copilot bash/powershell entry shape + PascalCase keys
 *   • registry (getIntegration / listIntegrations)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
  hermes,
  openclaw,
  factory,
  devin,
  antigravity,
  goose,
  getIntegration,
  listIntegrations,
} from "../../src/hooks/integrations";
import {
  CODEX_HOOK_EVENT_TYPES,
  CODEX_EVENT_MAP,
  COPILOT_HOOK_EVENT_TYPES,
  CURSOR_HOOK_EVENT_TYPES,
  CURSOR_EVENT_MAP,
  OPENCODE_HOOK_EVENT_TYPES,
  OPENCODE_EVENT_MAP,
  PI_HOOK_EVENT_TYPES,
  PI_EVENT_MAP,
  HERMES_HOOK_EVENT_TYPES,
  HERMES_EVENT_MAP,
  FACTORY_HOOK_EVENT_TYPES,
  DEVIN_HOOK_EVENT_TYPES,
  ANTIGRAVITY_HOOK_EVENT_TYPES,
  GOOSE_HOOK_EVENT_TYPES,
  HOOK_EVENT_TYPES,
  FAILPROOFAI_HOOK_MARKER,
  type CodexHookEventType,
  type CursorHookEventType,
  type OpenCodeHookEventType,
  type PiHookEventType,
  type HermesHookEventType,
} from "../../src/hooks/types";
import { homedir } from "node:os";
import { parse } from "yaml";
import { dirname } from "node:path";

let tempDir: string;
const ORIG_CWD = process.cwd();

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "fp-integrations-"));
});

afterEach(() => {
  // Restore cwd before removing tempDir so subsequent tests' process.cwd()
  // doesn't ENOENT (the OpenCode tests chdir into tempDir to exercise the
  // project-scope plugin shim path).
  try {
    process.chdir(ORIG_CWD);
  } catch {
    // Best-effort
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("integrations registry", () => {
  it("listIntegrations returns claude, codex, copilot, cursor, opencode, pi, hermes, and openclaw in declared order", () => {
    const ids = listIntegrations().map((i) => i.id);
    expect(ids).toEqual(["claude", "codex", "copilot", "cursor", "opencode", "pi", "hermes", "openclaw", "factory", "devin", "antigravity", "goose"]);
  });

  it("getIntegration('claude') returns claudeCode", () => {
    expect(getIntegration("claude")).toBe(claudeCode);
  });

  it("getIntegration('codex') returns codex", () => {
    expect(getIntegration("codex")).toBe(codex);
  });

  it("getIntegration('copilot') returns copilot", () => {
    expect(getIntegration("copilot")).toBe(copilot);
  });

  it("getIntegration('cursor') returns cursor", () => {
    expect(getIntegration("cursor")).toBe(cursor);
  });

  it("getIntegration('opencode') returns opencode", () => {
    expect(getIntegration("opencode")).toBe(opencode);
  });

  it("getIntegration('pi') returns pi", () => {
    expect(getIntegration("pi")).toBe(pi);
  });

  it("getIntegration('hermes') returns hermes", () => {
    expect(getIntegration("hermes")).toBe(hermes);
  });

  it("getIntegration('openclaw') returns openclaw", () => {
    expect(getIntegration("openclaw")).toBe(openclaw);
  });

  it("getIntegration('factory') returns factory", () => {
    expect(getIntegration("factory")).toBe(factory);
  });

  it("getIntegration('antigravity') returns antigravity", () => {
    expect(getIntegration("antigravity")).toBe(antigravity);
  });

  it("getIntegration('goose') returns goose", () => {
    expect(getIntegration("goose")).toBe(goose);
  });

  it("getIntegration('devin') returns devin", () => {
    expect(getIntegration("devin")).toBe(devin);
  });

  it("getIntegration throws for unknown id", () => {
    // @ts-expect-error — testing error path
    expect(() => getIntegration("unknown-cli")).toThrow();
  });
});

describe("Claude Code integration", () => {
  it("getSettingsPath maps each scope to the expected file", () => {
    expect(claudeCode.getSettingsPath("project", tempDir)).toBe(
      resolve(tempDir, ".claude", "settings.json"),
    );
    expect(claudeCode.getSettingsPath("local", tempDir)).toBe(
      resolve(tempDir, ".claude", "settings.local.json"),
    );
    expect(claudeCode.getSettingsPath("user")).toMatch(/\.claude\/settings\.json$/);
  });

  it("scopes include user|project|local", () => {
    expect(claudeCode.scopes).toEqual(["user", "project", "local"]);
  });

  it("buildHookEntry omits --cli for back-compat", () => {
    const entry = claudeCode.buildHookEntry("/usr/bin/failproofai", "PreToolUse", "user");
    expect(entry.command).toBe('"/usr/bin/failproofai" --hook PreToolUse');
    expect(entry.command).not.toContain("--cli");
    expect(entry.timeout).toBe(60);
    expect(entry[FAILPROOFAI_HOOK_MARKER]).toBe(true);
  });

  it("project scope uses npx -y failproofai (portable)", () => {
    const entry = claudeCode.buildHookEntry("/usr/bin/failproofai", "PreToolUse", "project");
    expect(entry.command).toBe("npx -y failproofai --hook PreToolUse");
  });

  it("writeHookEntries adds a matcher per HOOK_EVENT_TYPES event", () => {
    const settings: Record<string, unknown> = {};
    claudeCode.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    const hooks = settings.hooks as Record<string, unknown[]>;
    for (const eventType of HOOK_EVENT_TYPES) {
      expect(hooks[eventType]).toBeDefined();
    }
  });

  it("re-running writeHookEntries is idempotent (replaces, doesn't duplicate)", () => {
    const settings: Record<string, unknown> = {};
    claudeCode.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    claudeCode.writeHookEntries(settings, "/new/path/failproofai", "user");
    const hooks = settings.hooks as Record<string, Array<{ hooks: unknown[] }>>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].hooks).toHaveLength(1);
  });

  it("removeHooksFromFile clears all failproofai entries", () => {
    const settingsPath = resolve(tempDir, ".claude", "settings.json");
    const settings: Record<string, unknown> = {};
    claudeCode.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    claudeCode.writeSettings(settingsPath, settings);

    const removed = claudeCode.removeHooksFromFile(settingsPath);
    expect(removed).toBe(HOOK_EVENT_TYPES.length);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(after.hooks).toBeUndefined();
  });

  it("hooksInstalledInSettings detects an installed hook", () => {
    const settingsPath = claudeCode.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    claudeCode.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    claudeCode.writeSettings(settingsPath, settings);

    expect(claudeCode.hooksInstalledInSettings("project", tempDir)).toBe(true);
  });

  it("hooksInstalledInSettings returns false when file is missing", () => {
    expect(claudeCode.hooksInstalledInSettings("project", tempDir)).toBe(false);
  });
});

describe("OpenAI Codex integration", () => {
  it("getSettingsPath maps user → ~/.codex/hooks.json and project → <cwd>/.codex/hooks.json", () => {
    expect(codex.getSettingsPath("project", tempDir)).toBe(
      resolve(tempDir, ".codex", "hooks.json"),
    );
    expect(codex.getSettingsPath("user")).toMatch(/\.codex\/hooks\.json$/);
  });

  it("scopes are user|project (no local)", () => {
    expect(codex.scopes).toEqual(["user", "project"]);
  });

  it("eventTypes are exactly the 10 documented Codex events (snake_case)", () => {
    expect(codex.eventTypes).toEqual(CODEX_HOOK_EVENT_TYPES);
    // PR 185 omitted permission_request — make sure we have it.
    expect(codex.eventTypes).toContain("permission_request");
  });

  it("buildHookEntry includes --cli codex on the command line", () => {
    const entry = codex.buildHookEntry("/usr/bin/failproofai", "pre_tool_use", "user");
    expect(entry.command).toContain("--cli codex");
    expect(entry.command).toContain("--hook pre_tool_use");
    expect(entry[FAILPROOFAI_HOOK_MARKER]).toBe(true);
  });

  it("buildHookEntry sets timeout in SECONDS (60), not milliseconds", () => {
    // Codex reads `timeout` as seconds (its `timeout_sec` field); 60000 would be ~16.7h.
    const entry = codex.buildHookEntry("/usr/bin/failproofai", "pre_tool_use", "user");
    expect(entry.timeout).toBe(60);
  });

  it("project scope uses npx -y failproofai", () => {
    const entry = codex.buildHookEntry("/usr/bin/failproofai", "pre_tool_use", "project");
    expect(entry.command).toBe("npx -y failproofai --hook pre_tool_use --cli codex");
  });

  it("writeHookEntries stores keys in PascalCase via CODEX_EVENT_MAP", () => {
    const settings: Record<string, unknown> = {};
    codex.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    const hooks = settings.hooks as Record<string, unknown[]>;
    // Pascal keys (per Codex docs)
    for (const snake of CODEX_HOOK_EVENT_TYPES) {
      const pascal = CODEX_EVENT_MAP[snake as CodexHookEventType];
      expect(hooks[pascal]).toBeDefined();
      // Snake-case keys must NOT be present (Codex stores under Pascal)
      expect(hooks[snake]).toBeUndefined();
    }
    // Settings file does NOT carry version (Codex strictly expects only `hooks`)
    expect(settings.version).toBeUndefined();
  });

  it("writeHookEntries removes version on existing files if present", () => {
    const settings: Record<string, unknown> = { version: 1, hooks: {} };
    codex.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    expect(settings.version).toBeUndefined();
  });

  it("removeHooksFromFile removes version on existing files even if no failproofai hooks are present", () => {
    const settingsPath = resolve(tempDir, ".codex", "hooks.json");
    mkdirSync(resolve(tempDir, ".codex"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ version: 1, hooks: {} }));
    codex.removeHooksFromFile(settingsPath);
    const read = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(read.version).toBeUndefined();
  });

  it("re-running writeHookEntries is idempotent", () => {
    const settings: Record<string, unknown> = {};
    codex.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    codex.writeHookEntries(settings, "/different/path/failproofai", "user");
    const hooks = settings.hooks as Record<string, Array<{ hooks: unknown[] }>>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].hooks).toHaveLength(1);
  });

  it("removeHooksFromFile clears all failproofai entries (returns count)", () => {
    const settingsPath = codex.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    codex.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    codex.writeSettings(settingsPath, settings);
    expect(existsSync(settingsPath)).toBe(true);

    const removed = codex.removeHooksFromFile(settingsPath);
    expect(removed).toBe(CODEX_HOOK_EVENT_TYPES.length);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(after.hooks).toBeUndefined();
  });

  it("hooksInstalledInSettings detects installed hooks under PascalCase keys", () => {
    const settingsPath = codex.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    codex.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    codex.writeSettings(settingsPath, settings);

    expect(codex.hooksInstalledInSettings("project", tempDir)).toBe(true);
  });
});

describe("CODEX_EVENT_MAP", () => {
  it("maps every Codex snake_case event to a PascalCase HookEventType", () => {
    expect(CODEX_EVENT_MAP.pre_tool_use).toBe("PreToolUse");
    expect(CODEX_EVENT_MAP.post_tool_use).toBe("PostToolUse");
    expect(CODEX_EVENT_MAP.permission_request).toBe("PermissionRequest");
    expect(CODEX_EVENT_MAP.session_start).toBe("SessionStart");
    expect(CODEX_EVENT_MAP.user_prompt_submit).toBe("UserPromptSubmit");
    expect(CODEX_EVENT_MAP.stop).toBe("Stop");
  });
});

describe("GitHub Copilot integration", () => {
  it("getSettingsPath maps user → ~/.copilot/hooks/failproofai.json and project → <cwd>/.github/hooks/failproofai.json", () => {
    expect(copilot.getSettingsPath("project", tempDir)).toBe(
      resolve(tempDir, ".github", "hooks", "failproofai.json"),
    );
    expect(copilot.getSettingsPath("user")).toMatch(/\.copilot\/hooks\/failproofai\.json$/);
  });

  it("scopes are user|project (no local)", () => {
    expect(copilot.scopes).toEqual(["user", "project"]);
  });

  it("eventTypes are the PascalCase Copilot events", () => {
    expect(copilot.eventTypes).toEqual(COPILOT_HOOK_EVENT_TYPES);
    expect(copilot.eventTypes).toContain("PreToolUse");
    expect(copilot.eventTypes).toContain("PostToolUse");
    expect(copilot.eventTypes).toContain("UserPromptSubmit");
    expect(copilot.eventTypes).toContain("SessionStart");
    expect(copilot.eventTypes).toContain("SessionEnd");
    expect(copilot.eventTypes).toContain("Stop");
    expect(copilot.eventTypes).toContain("SubagentStop");
  });

  it("buildHookEntry uses bash + powershell keys with --cli copilot", () => {
    const entry = copilot.buildHookEntry("/usr/bin/failproofai", "PreToolUse", "user") as Record<string, unknown>;
    expect(entry.type).toBe("command");
    expect(entry.bash).toBe('"/usr/bin/failproofai" --hook PreToolUse --cli copilot');
    expect(entry.powershell).toBe('"/usr/bin/failproofai" --hook PreToolUse --cli copilot');
    expect(entry.timeoutSec).toBe(60);
    expect(entry[FAILPROOFAI_HOOK_MARKER]).toBe(true);
    // Copilot entries do NOT use the Claude-style `command` field
    expect(entry.command).toBeUndefined();
    expect(entry.timeout).toBeUndefined();
  });

  it("project scope uses npx -y failproofai (portable)", () => {
    const entry = copilot.buildHookEntry("/usr/bin/failproofai", "PreToolUse", "project") as Record<string, unknown>;
    expect(entry.bash).toBe("npx -y failproofai --hook PreToolUse --cli copilot");
    expect(entry.powershell).toBe("npx -y failproofai --hook PreToolUse --cli copilot");
  });

  it("writeHookEntries stores PascalCase event keys and version: 1", () => {
    const settings: Record<string, unknown> = {};
    copilot.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    const hooks = settings.hooks as Record<string, unknown[]>;
    for (const eventType of COPILOT_HOOK_EVENT_TYPES) {
      expect(hooks[eventType]).toBeDefined();
    }
    expect(settings.version).toBe(1);
  });

  it("readSettings backfills version: 1 on existing files without it", () => {
    const settingsPath = resolve(tempDir, ".github", "hooks", "failproofai.json");
    mkdirSync(resolve(tempDir, ".github", "hooks"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
    const read = copilot.readSettings(settingsPath);
    expect(read.version).toBe(1);
  });

  it("re-running writeHookEntries is idempotent", () => {
    const settings: Record<string, unknown> = {};
    copilot.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    copilot.writeHookEntries(settings, "/different/path/failproofai", "user");
    const hooks = settings.hooks as Record<string, Array<{ hooks: unknown[] }>>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].hooks).toHaveLength(1);
  });

  it("removeHooksFromFile clears all failproofai entries (returns count)", () => {
    const settingsPath = copilot.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    copilot.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    copilot.writeSettings(settingsPath, settings);
    expect(existsSync(settingsPath)).toBe(true);

    const removed = copilot.removeHooksFromFile(settingsPath);
    expect(removed).toBe(COPILOT_HOOK_EVENT_TYPES.length);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(after.hooks).toBeUndefined();
  });

  it("hooksInstalledInSettings detects installed hooks under PascalCase keys", () => {
    const settingsPath = copilot.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    copilot.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    copilot.writeSettings(settingsPath, settings);

    expect(copilot.hooksInstalledInSettings("project", tempDir)).toBe(true);
  });

  it("hooksInstalledInSettings returns false when file is missing", () => {
    expect(copilot.hooksInstalledInSettings("project", tempDir)).toBe(false);
  });
});

describe("Cursor Agent integration", () => {
  it("getSettingsPath maps user → ~/.cursor/hooks.json and project → <cwd>/.cursor/hooks.json", () => {
    expect(cursor.getSettingsPath("project", tempDir)).toBe(
      resolve(tempDir, ".cursor", "hooks.json"),
    );
    expect(cursor.getSettingsPath("user")).toMatch(/\.cursor\/hooks\.json$/);
  });

  it("scopes are user|project (no local)", () => {
    expect(cursor.scopes).toEqual(["user", "project"]);
  });

  it("eventTypes are the camelCase Cursor events", () => {
    expect(cursor.eventTypes).toEqual(CURSOR_HOOK_EVENT_TYPES);
    expect(cursor.eventTypes).toContain("preToolUse");
    expect(cursor.eventTypes).toContain("postToolUse");
    expect(cursor.eventTypes).toContain("beforeSubmitPrompt");
    expect(cursor.eventTypes).toContain("sessionStart");
    expect(cursor.eventTypes).toContain("sessionEnd");
    expect(cursor.eventTypes).toContain("stop");
    // subagentStop subscribed for parity with Copilot — custom policies
    // matching SubagentStop are reachable on Cursor subagent boundaries.
    expect(cursor.eventTypes).toContain("subagentStop");
  });

  it("buildHookEntry uses Claude-shaped {command,timeout} with --cli cursor", () => {
    const entry = cursor.buildHookEntry("/usr/bin/failproofai", "preToolUse", "user") as Record<string, unknown>;
    expect(entry.type).toBe("command");
    expect(entry.command).toBe('"/usr/bin/failproofai" --hook preToolUse --cli cursor');
    expect(entry.timeout).toBe(60);
    expect(entry[FAILPROOFAI_HOOK_MARKER]).toBe(true);
    // Cursor entries use the Claude-style `command` field, not Copilot's bash/powershell split.
    expect(entry.bash).toBeUndefined();
    expect(entry.powershell).toBeUndefined();
  });

  it("project scope uses npx -y failproofai (portable)", () => {
    const entry = cursor.buildHookEntry("/usr/bin/failproofai", "preToolUse", "project") as Record<string, unknown>;
    expect(entry.command).toBe("npx -y failproofai --hook preToolUse --cli cursor");
  });

  it("writeHookEntries stores camelCase event keys with version: 1 in a FLAT array (no matcher wrapper)", () => {
    const settings: Record<string, unknown> = {};
    cursor.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    const hooks = settings.hooks as Record<string, unknown[]>;
    for (const eventType of CURSOR_HOOK_EVENT_TYPES) {
      expect(hooks[eventType]).toBeDefined();
      const entries = hooks[eventType] as Array<Record<string, unknown>>;
      // Flat array: each element IS a hook entry, not a {hooks: [...]} matcher.
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].type).toBe("command");
      expect(typeof entries[0].command).toBe("string");
      expect(entries[0].hooks).toBeUndefined(); // no nested matcher wrapper
    }
    expect(settings.version).toBe(1);
  });

  it("readSettings backfills version: 1 on existing files without it", () => {
    const settingsPath = resolve(tempDir, ".cursor", "hooks.json");
    mkdirSync(resolve(tempDir, ".cursor"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
    const read = cursor.readSettings(settingsPath);
    expect(read.version).toBe(1);
  });

  it("re-running writeHookEntries is idempotent (replaces, doesn't duplicate)", () => {
    const settings: Record<string, unknown> = {};
    cursor.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    cursor.writeHookEntries(settings, "/different/path/failproofai", "user");
    const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;
    expect(hooks.preToolUse).toHaveLength(1);
    // Second call's binary path should win.
    expect(hooks.preToolUse[0].command).toBe('"/different/path/failproofai" --hook preToolUse --cli cursor');
  });

  it("removeHooksFromFile clears all failproofai entries (returns count)", () => {
    const settingsPath = cursor.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    cursor.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    cursor.writeSettings(settingsPath, settings);
    expect(existsSync(settingsPath)).toBe(true);

    const removed = cursor.removeHooksFromFile(settingsPath);
    expect(removed).toBe(CURSOR_HOOK_EVENT_TYPES.length);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(after.hooks).toBeUndefined();
  });

  it("hooksInstalledInSettings detects installed hooks under camelCase keys", () => {
    const settingsPath = cursor.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    cursor.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    cursor.writeSettings(settingsPath, settings);

    expect(cursor.hooksInstalledInSettings("project", tempDir)).toBe(true);
  });

  it("hooksInstalledInSettings returns false when file is missing", () => {
    expect(cursor.hooksInstalledInSettings("project", tempDir)).toBe(false);
  });
});

describe("CURSOR_EVENT_MAP", () => {
  it("maps every Cursor camelCase event to a PascalCase HookEventType", () => {
    expect(CURSOR_EVENT_MAP.preToolUse).toBe("PreToolUse");
    expect(CURSOR_EVENT_MAP.postToolUse).toBe("PostToolUse");
    expect(CURSOR_EVENT_MAP.beforeSubmitPrompt).toBe("UserPromptSubmit");
    expect(CURSOR_EVENT_MAP.sessionStart).toBe("SessionStart");
    expect(CURSOR_EVENT_MAP.sessionEnd).toBe("SessionEnd");
    expect(CURSOR_EVENT_MAP.stop).toBe("Stop");
    expect(CURSOR_EVENT_MAP.subagentStop).toBe("SubagentStop");
  });

  it("CURSOR_EVENT_MAP keys exactly match CURSOR_HOOK_EVENT_TYPES", () => {
    const mapKeys = Object.keys(CURSOR_EVENT_MAP).sort();
    const eventTypes = [...CURSOR_HOOK_EVENT_TYPES].sort();
    expect(mapKeys).toEqual(eventTypes);
  });

  // Reference cursor + CursorHookEventType so both stay in scope.
  it("CursorHookEventType is exhaustive", () => {
    const sample: CursorHookEventType = "preToolUse";
    expect(CURSOR_EVENT_MAP[sample]).toBe("PreToolUse");
  });
});

describe("Hermes integration", () => {
  // Hermes config is user-scope only at ~/.hermes/config.yaml. Redirect HOME to
  // the per-test tempDir so getSettingsPath / hooksInstalledInSettings operate
  // on a throwaway file instead of the developer's real home.
  let origHome: string | undefined;
  beforeEach(() => {
    origHome = process.env.HOME;
    process.env.HOME = tempDir;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  });

  it("getSettingsPath is user-scope ~/.hermes/config.yaml regardless of scope/cwd", () => {
    expect(hermes.getSettingsPath("user")).toBe(resolve(tempDir, ".hermes", "config.yaml"));
    // scope/cwd are ignored — Hermes has no project config.
    expect(hermes.getSettingsPath("project", "/some/other/dir")).toBe(
      resolve(tempDir, ".hermes", "config.yaml"),
    );
  });

  it("scopes are user-only", () => {
    expect(hermes.scopes).toEqual(["user"]);
  });

  it("eventTypes are the snake_case Hermes events (no Stop — Hermes has no turn end)", () => {
    expect(hermes.eventTypes).toEqual(HERMES_HOOK_EVENT_TYPES);
    expect(hermes.eventTypes).toContain("pre_tool_call");
    expect(hermes.eventTypes).toContain("post_tool_call");
    expect(hermes.eventTypes).toContain("on_session_start");
    expect(hermes.eventTypes).toContain("on_session_end");
    expect(hermes.eventTypes).toContain("subagent_stop");
  });

  it("buildHookEntry uses {command,timeout} with --cli hermes, timeout in SECONDS (30)", () => {
    const entry = hermes.buildHookEntry("/usr/bin/failproofai", "pre_tool_call", "user") as Record<string, unknown>;
    expect(entry.command).toBe('"/usr/bin/failproofai" --hook pre_tool_call --cli hermes');
    expect(entry.timeout).toBe(30);
    expect(entry[FAILPROOFAI_HOOK_MARKER]).toBe(true);
  });

  it("project scope uses npx -y failproofai (portable)", () => {
    const entry = hermes.buildHookEntry("/usr/bin/failproofai", "pre_tool_call", "project") as Record<string, unknown>;
    expect(entry.command).toBe("npx -y failproofai --hook pre_tool_call --cli hermes");
  });

  it("writeHookEntries builds a flat hooks: map keyed by snake_case events + hooks_auto_accept", () => {
    const path = hermes.getSettingsPath("user");
    const settings = hermes.readSettings(path); // empty Document (file absent)
    hermes.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    hermes.writeSettings(path, settings);
    const parsed = parse(readFileSync(path, "utf-8")) as {
      hooks?: Record<string, Array<Record<string, unknown>>>;
      hooks_auto_accept?: boolean;
    };
    for (const eventType of HERMES_HOOK_EVENT_TYPES) {
      expect(Array.isArray(parsed.hooks?.[eventType])).toBe(true);
      const first = parsed.hooks![eventType][0];
      expect(first.command).toContain("--cli hermes");
      expect(first.timeout).toBe(30);
      expect(first[FAILPROOFAI_HOOK_MARKER]).toBe(true);
    }
    // Headless-gateway consent: declared hooks auto-accepted.
    expect(parsed.hooks_auto_accept).toBe(true);
  });

  it("readSettings/writeSettings preserve the user's other keys AND comments", () => {
    const path = hermes.getSettingsPath("user");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "# my hermes config\nmodel: gpt-5  # the good one\nprovider: openai\n");
    const settings = hermes.readSettings(path);
    hermes.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    hermes.writeSettings(path, settings);
    const raw = readFileSync(path, "utf-8");
    const parsed = parse(raw) as Record<string, unknown>;
    // Unrelated keys survive...
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.provider).toBe("openai");
    expect((parsed.hooks as Record<string, unknown>).pre_tool_call).toBeDefined();
    // ...and so do the user's comments (this is why we use the Document API).
    expect(raw).toContain("# my hermes config");
    expect(raw).toContain("# the good one");
  });

  it("re-running writeHookEntries is idempotent (replaces, doesn't duplicate)", () => {
    const path = hermes.getSettingsPath("user");
    const settings = hermes.readSettings(path);
    hermes.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    hermes.writeHookEntries(settings, "/different/failproofai", "user");
    hermes.writeSettings(path, settings);
    const parsed = parse(readFileSync(path, "utf-8")) as { hooks: Record<string, unknown[]> };
    expect(parsed.hooks.pre_tool_call).toHaveLength(1);
    expect((parsed.hooks.pre_tool_call[0] as Record<string, unknown>).command).toBe(
      '"/different/failproofai" --hook pre_tool_call --cli hermes',
    );
  });

  it("removeHooksFromFile strips only our entries + auto-accept, preserving user keys", () => {
    const path = hermes.getSettingsPath("user");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "model: gpt-5\n");
    const settings = hermes.readSettings(path);
    hermes.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    hermes.writeSettings(path, settings);

    const removed = hermes.removeHooksFromFile(path);
    expect(removed).toBe(HERMES_HOOK_EVENT_TYPES.length);
    const parsed = parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.hooks_auto_accept).toBeUndefined();
    expect(parsed.model).toBe("gpt-5"); // user key survives
  });

  it("removeHooksFromFile drops hooks_auto_accept even when the hooks were already removed manually", () => {
    // Regression (CodeRabbit): the auto-accept flag must not linger and silently
    // auto-accept future operator hooks after our hooks are gone.
    const path = hermes.getSettingsPath("user");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "model: gpt-5\nhooks_auto_accept: true\n"); // no `hooks:` block
    const removed = hermes.removeHooksFromFile(path);
    expect(removed).toBe(0);
    const parsed = parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(parsed.hooks_auto_accept).toBeUndefined(); // dropped despite 0 hooks removed
    expect(parsed.model).toBe("gpt-5");
  });

  it("hooksInstalledInSettings detects installed hooks / false when missing", () => {
    expect(hermes.hooksInstalledInSettings("user")).toBe(false);
    const path = hermes.getSettingsPath("user");
    const settings = hermes.readSettings(path);
    hermes.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    hermes.writeSettings(path, settings);
    expect(hermes.hooksInstalledInSettings("user")).toBe(true);
  });
});

describe("HERMES_EVENT_MAP", () => {
  it("maps every snake_case Hermes event to a PascalCase HookEventType", () => {
    expect(HERMES_EVENT_MAP.pre_tool_call).toBe("PreToolUse");
    expect(HERMES_EVENT_MAP.post_tool_call).toBe("PostToolUse");
    expect(HERMES_EVENT_MAP.on_session_start).toBe("SessionStart");
    expect(HERMES_EVENT_MAP.on_session_end).toBe("SessionEnd");
    expect(HERMES_EVENT_MAP.subagent_stop).toBe("SubagentStop");
  });

  it("has NO Stop mapping — Hermes has no turn-end event", () => {
    expect(Object.values(HERMES_EVENT_MAP)).not.toContain("Stop");
  });

  it("HERMES_EVENT_MAP keys exactly match HERMES_HOOK_EVENT_TYPES", () => {
    expect(Object.keys(HERMES_EVENT_MAP).sort()).toEqual([...HERMES_HOOK_EVENT_TYPES].sort());
  });

  it("HermesHookEventType is exhaustive", () => {
    const sample: HermesHookEventType = "pre_tool_call";
    expect(HERMES_EVENT_MAP[sample]).toBe("PreToolUse");
  });
});

describe("OpenCode integration", () => {
  it("getSettingsPath maps user and project to the expected files", () => {
    expect(opencode.getSettingsPath("project", tempDir)).toBe(
      resolve(tempDir, ".opencode", "opencode.json"),
    );
    expect(opencode.getSettingsPath("user")).toMatch(
      new RegExp(`${[".config", "opencode", "opencode.json"].join("/")}$`),
    );
  });

  it("getSettingsPath('local') falls back to project (no opencode local scope)", () => {
    expect(opencode.getSettingsPath("local", tempDir)).toBe(
      resolve(tempDir, ".opencode", "opencode.json"),
    );
  });

  it("scopes are exactly user|project", () => {
    expect(opencode.scopes).toEqual(["user", "project"]);
    expect(opencode.scopes).not.toContain("local");
  });

  it("eventTypes are the OpenCode dotted/keyed events", () => {
    expect(opencode.eventTypes).toEqual(OPENCODE_HOOK_EVENT_TYPES);
    expect(opencode.eventTypes).toContain("tool.execute.before");
    expect(opencode.eventTypes).toContain("tool.execute.after");
    expect(opencode.eventTypes).toContain("session.created");
    expect(opencode.eventTypes).toContain("session.deleted");
    expect(opencode.eventTypes).toContain("session.idle");
    expect(opencode.eventTypes).toContain("message.updated");
    expect(opencode.eventTypes).toContain("permission.ask");
  });

  it("buildHookEntry returns a relative spec for project scope", () => {
    const entry = opencode.buildHookEntry("/usr/bin/failproofai", "tool.execute.before", "project") as Record<string, unknown>;
    expect(entry.spec).toBe("./plugins/failproofai.mjs");
    expect(entry[FAILPROOFAI_HOOK_MARKER]).toBe(true);
  });

  it("buildHookEntry returns a file:// absolute URL for user scope", () => {
    const entry = opencode.buildHookEntry("/abs/path/failproofai", "tool.execute.before", "user") as Record<string, unknown>;
    const expectedAbs = resolve(homedir(), ".config", "opencode", "plugins", "failproofai.mjs");
    expect(entry.spec).toBe(`file://${expectedAbs}`);
  });

  it("isFailproofaiHook accepts string entries", () => {
    expect(opencode.isFailproofaiHook("./plugins/failproofai.mjs")).toBe(true);
    expect(opencode.isFailproofaiHook("file:///home/u/somewhere/failproofai.mjs")).toBe(true);
    expect(opencode.isFailproofaiHook("./plugins/some-other.mjs")).toBe(false);
  });

  it("isFailproofaiHook accepts [spec, options] tuple entries", () => {
    expect(opencode.isFailproofaiHook(["./plugins/failproofai.mjs", { foo: 1 }])).toBe(true);
    expect(opencode.isFailproofaiHook(["./plugins/some-other.mjs", { foo: 1 }])).toBe(false);
  });

  it("writeHookEntries writes the plugin file with the marker and hook keys", () => {
    process.chdir(tempDir);
    const settings: Record<string, unknown> = {};
    opencode.writeHookEntries(settings, "/usr/bin/failproofai", "project");

    const pluginPath = resolve(tempDir, ".opencode", "plugins", "failproofai.mjs");
    expect(existsSync(pluginPath)).toBe(true);
    const content = readFileSync(pluginPath, "utf8");
    expect(content).toContain(FAILPROOFAI_HOOK_MARKER);
    expect(content).toContain('"tool.execute.before"');
    expect(content).toContain('"tool.execute.after"');
    expect(content).toContain('"permission.ask"');
    expect(content).toContain('"session.created"');
    expect(content).toContain('"session.idle"');
    expect(content).toContain('"message.updated"');
  });

  it("writeHookEntries project-scope embeds npx, not the absolute binary", () => {
    process.chdir(tempDir);
    opencode.writeHookEntries({}, "/usr/bin/failproofai", "project");
    const pluginPath = resolve(tempDir, ".opencode", "plugins", "failproofai.mjs");
    const content = readFileSync(pluginPath, "utf8");
    expect(content).toContain("npx");
    expect(content).toContain("USE_NPX = true");
    expect(content).not.toContain("/usr/bin/failproofai");
  });

  it("writeHookEntries adds our entry to the plugin array", () => {
    process.chdir(tempDir);
    const path = opencode.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    opencode.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    opencode.writeSettings(path, settings);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.plugin).toContain("./plugins/failproofai.mjs");
  });

  it("writeHookEntries is idempotent — second call yields identical bytes", () => {
    process.chdir(tempDir);
    const path = opencode.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    opencode.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    opencode.writeSettings(path, settings);
    const firstJson = readFileSync(path, "utf8");
    const firstPlugin = readFileSync(resolve(tempDir, ".opencode", "plugins", "failproofai.mjs"), "utf8");

    const settings2 = JSON.parse(firstJson);
    opencode.writeHookEntries(settings2, "/usr/bin/failproofai", "project");
    opencode.writeSettings(path, settings2);
    expect(readFileSync(path, "utf8")).toBe(firstJson);
    expect(readFileSync(resolve(tempDir, ".opencode", "plugins", "failproofai.mjs"), "utf8")).toBe(firstPlugin);
  });

  it("writeHookEntries preserves pre-existing plugin entries", () => {
    process.chdir(tempDir);
    const path = opencode.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {
      plugin: ["@some/npm-plugin", ["./plugins/other.mjs", { foo: 1 }]],
    };
    opencode.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    opencode.writeSettings(path, settings);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.plugin).toContain("@some/npm-plugin");
    expect(written.plugin).toContainEqual(["./plugins/other.mjs", { foo: 1 }]);
    expect(written.plugin).toContain("./plugins/failproofai.mjs");
    expect(written.plugin).toHaveLength(3);
  });

  it("writeHookEntries preserves the rest of opencode.json", () => {
    process.chdir(tempDir);
    const path = opencode.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      agent: { mine: { prompt: "hello" } },
      command: { foo: { template: "bar" } },
    };
    opencode.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    opencode.writeSettings(path, settings);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.$schema).toBe("https://opencode.ai/config.json");
    expect(written.agent).toEqual({ mine: { prompt: "hello" } });
    expect(written.command).toEqual({ foo: { template: "bar" } });
  });

  it("removeHooksFromFile deletes our plugin entry AND the plugin file", () => {
    process.chdir(tempDir);
    const path = opencode.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    opencode.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    opencode.writeSettings(path, settings);
    const pluginPath = resolve(tempDir, ".opencode", "plugins", "failproofai.mjs");
    expect(existsSync(pluginPath)).toBe(true);

    const removed = opencode.removeHooksFromFile(path);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(pluginPath)).toBe(false);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.plugin ?? []).not.toContain("./plugins/failproofai.mjs");
  });

  it("removeHooksFromFile does NOT delete a hand-written plugin file lacking the marker", () => {
    process.chdir(tempDir);
    const path = opencode.getSettingsPath("project", tempDir);
    const pluginPath = resolve(tempDir, ".opencode", "plugins", "failproofai.mjs");
    mkdirSync(resolve(tempDir, ".opencode", "plugins"), { recursive: true });
    writeFileSync(pluginPath, "// hand-written plugin without the marker\nexport default async () => ({});\n");
    writeFileSync(path, JSON.stringify({ plugin: ["./plugins/other.mjs"] }));

    opencode.removeHooksFromFile(path);
    expect(existsSync(pluginPath)).toBe(true); // file untouched
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.plugin).toContain("./plugins/other.mjs"); // user's plugin preserved
  });

  it("removeHooksFromFile leaves other plugins in the array", () => {
    process.chdir(tempDir);
    const path = opencode.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = { plugin: ["@some/npm-plugin"] };
    opencode.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    opencode.writeSettings(path, settings);

    opencode.removeHooksFromFile(path);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.plugin).toContain("@some/npm-plugin");
    expect(after.plugin).not.toContain("./plugins/failproofai.mjs");
  });

  it("hooksInstalledInSettings lifecycle: false → install → true → uninstall → false", () => {
    process.chdir(tempDir);
    const path = opencode.getSettingsPath("project", tempDir);
    expect(opencode.hooksInstalledInSettings("project", tempDir)).toBe(false);
    const settings: Record<string, unknown> = {};
    opencode.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    opencode.writeSettings(path, settings);
    expect(opencode.hooksInstalledInSettings("project", tempDir)).toBe(true);
    opencode.removeHooksFromFile(path);
    expect(opencode.hooksInstalledInSettings("project", tempDir)).toBe(false);
  });

  it("hooksInstalledInSettings returns false when entry exists but plugin file is missing", () => {
    process.chdir(tempDir);
    const path = opencode.getSettingsPath("project", tempDir);
    mkdirSync(resolve(tempDir, ".opencode"), { recursive: true });
    writeFileSync(path, JSON.stringify({ plugin: ["./plugins/failproofai.mjs"] }));
    expect(opencode.hooksInstalledInSettings("project", tempDir)).toBe(false);
  });
});

describe("OPENCODE_EVENT_MAP", () => {
  it("maps every OpenCode plugin event to a PascalCase HookEventType", () => {
    expect(OPENCODE_EVENT_MAP["tool.execute.before"]).toBe("PreToolUse");
    expect(OPENCODE_EVENT_MAP["tool.execute.after"]).toBe("PostToolUse");
    expect(OPENCODE_EVENT_MAP["session.created"]).toBe("SessionStart");
    expect(OPENCODE_EVENT_MAP["session.deleted"]).toBe("SessionEnd");
    expect(OPENCODE_EVENT_MAP["session.idle"]).toBe("Stop");
    expect(OPENCODE_EVENT_MAP["message.updated"]).toBe("UserPromptSubmit");
    expect(OPENCODE_EVENT_MAP["permission.ask"]).toBe("PermissionRequest");
  });

  it("OPENCODE_EVENT_MAP keys exactly match OPENCODE_HOOK_EVENT_TYPES", () => {
    const mapKeys = Object.keys(OPENCODE_EVENT_MAP).sort();
    const eventTypes = [...OPENCODE_HOOK_EVENT_TYPES].sort();
    expect(mapKeys).toEqual(eventTypes);
  });

  it("every mapped target is a valid HookEventType", () => {
    for (const target of Object.values(OPENCODE_EVENT_MAP)) {
      expect(HOOK_EVENT_TYPES).toContain(target);
    }
  });

  it("OpenCodeHookEventType is exhaustive", () => {
    const sample: OpenCodeHookEventType = "tool.execute.before";
    expect(OPENCODE_EVENT_MAP[sample]).toBe("PreToolUse");
  });
});

describe("Pi integration", () => {
  it("getSettingsPath user → ~/.pi/agent/settings.json (NOT ~/.pi/settings.json)", () => {
    const userPath = pi.getSettingsPath("user");
    expect(userPath).toContain(".pi");
    expect(userPath.endsWith(`/.pi/agent/settings.json`)).toBe(true);
  });

  it("getSettingsPath project → <cwd>/.pi/settings.json", () => {
    expect(pi.getSettingsPath("project", tempDir)).toBe(resolve(tempDir, ".pi", "settings.json"));
  });

  it("scopes are user|project (no local)", () => {
    expect([...pi.scopes]).toEqual(["user", "project"]);
  });

  it("eventTypes are exactly the 7 Pi events (snake_case)", () => {
    expect([...pi.eventTypes]).toEqual([...PI_HOOK_EVENT_TYPES]);
    // Pin the canonical set so reordering / accidental removals are caught.
    expect([...pi.eventTypes].sort()).toEqual([
      "agent_end",
      "input",
      "session_shutdown",
      "session_start",
      "tool_call",
      "tool_result",
      "user_bash",
    ]);
  });

  it("buildHookEntry includes the FAILPROOFAI_HOOK_MARKER", () => {
    const entry = pi.buildHookEntry("/usr/local/bin/failproofai", "tool_call", "user");
    expect(entry[FAILPROOFAI_HOOK_MARKER]).toBe(true);
  });

  it("writeHookEntries adds a packages-array entry to a fresh settings.json", () => {
    const settings: Record<string, unknown> = {};
    pi.writeHookEntries(settings, "/usr/local/bin/failproofai", "user");
    const packages = (settings as { packages?: unknown[] }).packages;
    expect(Array.isArray(packages)).toBe(true);
    expect(packages?.length).toBe(1);
    const entry = (packages?.[0] ?? "") as string;
    expect(typeof entry).toBe("string");
    expect(entry).toContain("pi-extension");
    expect(entry).toContain("failproofai");
  });

  it("writeHookEntries appends to an existing packages array, preserving user entries", () => {
    const settings: Record<string, unknown> = { packages: ["npm:@user/foo"] };
    pi.writeHookEntries(settings, "/usr/local/bin/failproofai", "user");
    const packages = (settings as { packages?: unknown[] }).packages ?? [];
    expect(packages.length).toBe(2);
    expect(packages[0]).toBe("npm:@user/foo");
    expect(typeof packages[1]).toBe("string");
    expect((packages[1] as string)).toContain("pi-extension");
  });

  it("writeHookEntries is idempotent — re-running replaces (not duplicates) failproofai", () => {
    const settings: Record<string, unknown> = {};
    pi.writeHookEntries(settings, "/usr/local/bin/failproofai", "user");
    pi.writeHookEntries(settings, "/usr/local/bin/failproofai", "user");
    const packages = (settings as { packages?: unknown[] }).packages ?? [];
    expect(packages.filter((p) => typeof p === "string" && (p as string).includes("pi-extension")).length).toBe(1);
  });

  it("writeHookEntries with --scope project writes a relative path under <cwd>", () => {
    // Set cwd to tempDir so the project-scope relative-path computation lines up.
    const origCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const settings: Record<string, unknown> = {};
      pi.writeHookEntries(settings, "/usr/local/bin/failproofai", "project");
      // The entry will only be relative if pi-extension lives under cwd. Since
      // we're in a temp dir, the helper falls back to absolute — so just assert
      // an entry was written and it looks like a path.
      const packages = (settings as { packages?: unknown[] }).packages ?? [];
      expect(packages.length).toBe(1);
      expect(typeof packages[0]).toBe("string");
    } finally {
      process.chdir(origCwd);
    }
  });

  it("removeHooksFromFile filters out the failproofai entry, keeps user entries", () => {
    const settingsPath = resolve(tempDir, ".pi", "settings.json");
    mkdirSync(resolve(tempDir, ".pi"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        packages: [
          "npm:@user/foo",
          "/usr/local/lib/node_modules/failproofai/pi-extension",
        ],
      }),
    );
    const removed = pi.removeHooksFromFile(settingsPath);
    expect(removed).toBe(1);
    const after = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown[] };
    expect(after.packages).toEqual(["npm:@user/foo"]);
  });

  it("removeHooksFromFile drops the empty packages array after removing the last failproofai entry", () => {
    const settingsPath = resolve(tempDir, ".pi", "settings.json");
    mkdirSync(resolve(tempDir, ".pi"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        packages: ["/usr/local/lib/node_modules/failproofai/pi-extension"],
      }),
    );
    pi.removeHooksFromFile(settingsPath);
    const after = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(after.packages).toBeUndefined();
  });

  it("removeHooksFromFile returns 0 when no failproofai entry was present", () => {
    const settingsPath = resolve(tempDir, ".pi", "settings.json");
    mkdirSync(resolve(tempDir, ".pi"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:@user/foo"] }));
    expect(pi.removeHooksFromFile(settingsPath)).toBe(0);
  });

  it("removeHooksFromFile returns 0 when settings.json doesn't exist", () => {
    const settingsPath = resolve(tempDir, ".pi", "settings.json");
    expect(pi.removeHooksFromFile(settingsPath)).toBe(0);
  });

  it("hooksInstalledInSettings finds the entry by source-path substring", () => {
    const settingsPath = resolve(tempDir, ".pi", "settings.json");
    mkdirSync(resolve(tempDir, ".pi"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        packages: ["/usr/local/lib/node_modules/failproofai/pi-extension"],
      }),
    );
    expect(pi.hooksInstalledInSettings("project", tempDir)).toBe(true);
  });

  it("hooksInstalledInSettings returns false when settings.json doesn't exist", () => {
    expect(pi.hooksInstalledInSettings("project", tempDir)).toBe(false);
  });

  it("hooksInstalledInSettings returns false on corrupt JSON (fail-open)", () => {
    const settingsPath = resolve(tempDir, ".pi", "settings.json");
    mkdirSync(resolve(tempDir, ".pi"), { recursive: true });
    writeFileSync(settingsPath, "{not json");
    expect(pi.hooksInstalledInSettings("project", tempDir)).toBe(false);
  });

  it("isFailproofaiHook detects {source: '...pi-extension/failproofai'}", () => {
    expect(pi.isFailproofaiHook({ source: "/path/to/failproofai/pi-extension" })).toBe(true);
    expect(pi.isFailproofaiHook({ source: "npm:@user/other" })).toBe(false);
  });

  it("isFailproofaiHook detects FAILPROOFAI_HOOK_MARKER=true", () => {
    expect(pi.isFailproofaiHook({ [FAILPROOFAI_HOOK_MARKER]: true })).toBe(true);
  });
});

describe("PI_EVENT_MAP", () => {
  it("maps every Pi event to a PascalCase HookEventType", () => {
    expect(PI_EVENT_MAP.tool_call).toBe("PreToolUse");
    expect(PI_EVENT_MAP.user_bash).toBe("PreToolUse");
    expect(PI_EVENT_MAP.input).toBe("UserPromptSubmit");
    expect(PI_EVENT_MAP.session_start).toBe("SessionStart");
    expect(PI_EVENT_MAP.session_shutdown).toBe("SessionEnd");
    expect(PI_EVENT_MAP.tool_result).toBe("PostToolUse");
    expect(PI_EVENT_MAP.agent_end).toBe("Stop");
  });

  it("PI_EVENT_MAP keys exactly match PI_HOOK_EVENT_TYPES", () => {
    const mapKeys = Object.keys(PI_EVENT_MAP).sort();
    const eventTypes = [...PI_HOOK_EVENT_TYPES].sort();
    expect(mapKeys).toEqual(eventTypes);
  });

  it("PiHookEventType is exhaustive", () => {
    const sample: PiHookEventType = "tool_call";
    expect(PI_EVENT_MAP[sample]).toBe("PreToolUse");
  });
});

describe("OpenClaw integration", () => {
  it("is user-scope only and points at ~/.openclaw/openclaw.json", () => {
    expect(openclaw.scopes).toEqual(["user"]);
    // getSettingsPath ignores scope/cwd (OpenClaw has no project config).
    const p = openclaw.getSettingsPath("user");
    expect(p).toBe(join(homedir(), ".openclaw", "openclaw.json"));
    expect(openclaw.getSettingsPath("project", "/some/where")).toBe(p);
  });

  it("writeHookEntries registers the plugin path + enables the entry with allowConversationAccess", () => {
    const settings: Record<string, unknown> = {};
    openclaw.writeHookEntries(settings, "");
    const plugins = settings.plugins as Record<string, any>;
    expect(Array.isArray(plugins.load.paths)).toBe(true);
    expect(plugins.load.paths.some((p: string) => p.endsWith("openclaw-plugin"))).toBe(true);
    expect(plugins.entries.failproofai.enabled).toBe(true);
    expect(plugins.entries.failproofai.hooks.allowConversationAccess).toBe(true);
  });

  it("writeHookEntries is idempotent (double install → single path entry)", () => {
    const settings: Record<string, unknown> = {};
    openclaw.writeHookEntries(settings, "");
    openclaw.writeHookEntries(settings, "");
    const plugins = settings.plugins as Record<string, any>;
    const ours = plugins.load.paths.filter((p: string) => p.includes("openclaw-plugin"));
    expect(ours).toHaveLength(1);
  });

  it("writeHookEntries preserves operator config (other plugins, deny list, load extras)", () => {
    const settings: Record<string, unknown> = {
      plugins: {
        deny: ["untrusted"],
        load: { paths: ["/opt/other-plugin"], watch: true },
        entries: { other: { enabled: true, config: { x: 1 } } },
      },
    };
    openclaw.writeHookEntries(settings, "");
    const plugins = settings.plugins as Record<string, any>;
    expect(plugins.deny).toEqual(["untrusted"]);
    expect(plugins.load.watch).toBe(true);
    expect(plugins.load.paths).toContain("/opt/other-plugin");
    expect(plugins.entries.other).toEqual({ enabled: true, config: { x: 1 } });
    expect(plugins.entries.failproofai.enabled).toBe(true);
  });

  it("isFailproofaiHook recognizes our load.paths string entry and the marked sentinel", () => {
    expect(openclaw.isFailproofaiHook("/x/failproofai/openclaw-plugin")).toBe(true);
    expect(openclaw.isFailproofaiHook("/abs/openclaw-plugin")).toBe(true);
    expect(openclaw.isFailproofaiHook("/opt/other-plugin")).toBe(false);
    expect(openclaw.isFailproofaiHook({ [FAILPROOFAI_HOOK_MARKER]: true })).toBe(true);
  });

  it("removeHooksFromFile reverses install and prunes empties, leaving operator config intact", () => {
    const file = join(tempDir, "openclaw.json");
    const settings: Record<string, unknown> = {
      plugins: { deny: ["untrusted"], load: { paths: ["/opt/other-plugin"] }, entries: { other: { enabled: true } } },
    };
    openclaw.writeHookEntries(settings, "");
    writeFileSync(file, JSON.stringify(settings));

    const removed = openclaw.removeHooksFromFile(file);
    expect(removed).toBeGreaterThanOrEqual(2); // path + entry

    const after = JSON.parse(readFileSync(file, "utf-8")) as Record<string, any>;
    expect(after.plugins.entries.failproofai).toBeUndefined();
    expect(after.plugins.entries.other).toEqual({ enabled: true });
    expect(after.plugins.load.paths).toEqual(["/opt/other-plugin"]);
    expect(after.plugins.deny).toEqual(["untrusted"]);
  });

  it("removeHooksFromFile deletes an empty plugins object when nothing else remains", () => {
    const file = join(tempDir, "openclaw2.json");
    const settings: Record<string, unknown> = {};
    openclaw.writeHookEntries(settings, "");
    writeFileSync(file, JSON.stringify(settings));

    openclaw.removeHooksFromFile(file);
    const after = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    expect(after.plugins).toBeUndefined();
  });
});

describe("Factory Droid integration", () => {
  it("getSettingsPath maps user → ~/.factory/hooks.json and project → <cwd>/.factory/hooks.json", () => {
    expect(factory.getSettingsPath("project", tempDir)).toBe(
      resolve(tempDir, ".factory", "hooks.json"),
    );
    expect(factory.getSettingsPath("user")).toMatch(/\.factory\/hooks\.json$/);
  });

  it("scopes are user|project (no local)", () => {
    expect(factory.scopes).toEqual(["user", "project"]);
  });

  it("buildHookEntry includes --cli factory and a 30s timeout", () => {
    const entry = factory.buildHookEntry("/usr/bin/failproofai", "PreToolUse", "user");
    expect(entry.command).toContain("--cli factory");
    expect(entry.command).toContain("--hook PreToolUse");
    expect(entry.timeout).toBe(30);
    expect(entry[FAILPROOFAI_HOOK_MARKER]).toBe(true);
  });

  it("project scope uses npx -y failproofai", () => {
    const entry = factory.buildHookEntry("/usr/bin/failproofai", "PreToolUse", "project");
    expect(entry.command).toBe("npx -y failproofai --hook PreToolUse --cli factory");
  });

  it("writeHookEntries stores event names at the TOP LEVEL (no `hooks` wrapper)", () => {
    const settings: Record<string, unknown> = {};
    factory.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    // No wrapper key — the file IS the events object.
    expect(settings.hooks).toBeUndefined();
    for (const eventType of FACTORY_HOOK_EVENT_TYPES) {
      expect(Array.isArray(settings[eventType])).toBe(true);
    }
  });

  it("writeHookEntries adds matcher:'*' for tool events and omits it elsewhere", () => {
    const settings: Record<string, unknown> = {};
    factory.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    const pre = (settings.PreToolUse as Array<Record<string, unknown>>)[0];
    const post = (settings.PostToolUse as Array<Record<string, unknown>>)[0];
    const stop = (settings.Stop as Array<Record<string, unknown>>)[0];
    expect(pre.matcher).toBe("*");
    expect(post.matcher).toBe("*");
    expect(stop.matcher).toBeUndefined();
  });

  it("re-running writeHookEntries is idempotent", () => {
    const settings: Record<string, unknown> = {};
    factory.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    factory.writeHookEntries(settings, "/different/path/failproofai", "user");
    const pre = settings.PreToolUse as Array<{ hooks: unknown[] }>;
    expect(pre).toHaveLength(1);
    expect(pre[0].hooks).toHaveLength(1);
  });

  it("removeHooksFromFile clears all failproofai entries (returns count)", () => {
    const settingsPath = factory.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    factory.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    factory.writeSettings(settingsPath, settings);
    expect(existsSync(settingsPath)).toBe(true);

    const removed = factory.removeHooksFromFile(settingsPath);
    expect(removed).toBe(FACTORY_HOOK_EVENT_TYPES.length);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    for (const eventType of FACTORY_HOOK_EVENT_TYPES) {
      expect(after[eventType]).toBeUndefined();
    }
  });

  it("removeHooksFromFile preserves a user's own hook entries", () => {
    const settingsPath = factory.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "my-own-hook" }] }],
    };
    factory.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    factory.writeSettings(settingsPath, settings);

    factory.removeHooksFromFile(settingsPath);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, any>;
    // The user's own hook survives; only the failproofai-marked entry is gone.
    const flattened = (after.PreToolUse ?? []).flatMap((m: any) => m.hooks ?? []);
    expect(flattened.some((h: any) => h.command === "my-own-hook")).toBe(true);
    expect(flattened.some((h: any) => h[FAILPROOFAI_HOOK_MARKER] === true)).toBe(false);
  });

  it("hooksInstalledInSettings detects installed hooks", () => {
    const settingsPath = factory.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    factory.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    factory.writeSettings(settingsPath, settings);

    expect(factory.hooksInstalledInSettings("project", tempDir)).toBe(true);
  });
});

describe("Devin CLI integration", () => {
  it("getSettingsPath maps user → ~/.config/devin/config.json and project → <cwd>/.devin/config.json", () => {
    expect(devin.getSettingsPath("project", tempDir)).toBe(
      resolve(tempDir, ".devin", "config.json"),
    );
    expect(devin.getSettingsPath("user")).toMatch(/\.config\/devin\/config\.json$/);
  });

  it("scopes are user|project (no local)", () => {
    expect(devin.scopes).toEqual(["user", "project"]);
  });

  it("subscribes to the 7 verified devin events", () => {
    expect(DEVIN_HOOK_EVENT_TYPES).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
      "Stop",
      "SessionEnd",
    ]);
  });

  it("every devin event is a canonical HookEventType (no event map needed)", () => {
    const canonical = new Set<string>(HOOK_EVENT_TYPES);
    for (const ev of DEVIN_HOOK_EVENT_TYPES) {
      expect(canonical.has(ev), `${ev} must be a HookEventType`).toBe(true);
    }
  });

  it("buildHookEntry includes --cli devin and a 60s timeout", () => {
    const entry = devin.buildHookEntry("/usr/bin/failproofai", "PreToolUse", "user");
    expect(entry.command).toContain("--cli devin");
    expect(entry.command).toContain("--hook PreToolUse");
    expect(entry.command).toBe(`"/usr/bin/failproofai" --hook PreToolUse --cli devin`);
    expect(entry.timeout).toBe(60);
    expect(entry[FAILPROOFAI_HOOK_MARKER]).toBe(true);
  });

  it("project scope uses npx -y failproofai", () => {
    const entry = devin.buildHookEntry("/usr/bin/failproofai", "PreToolUse", "project");
    expect(entry.command).toBe("npx -y failproofai --hook PreToolUse --cli devin");
  });

  it("writeHookEntries stores events under a Claude-style `hooks` wrapper", () => {
    const settings: Record<string, unknown> = {};
    devin.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks).toBeDefined();
    for (const eventType of DEVIN_HOOK_EVENT_TYPES) {
      expect(Array.isArray(hooks[eventType])).toBe(true);
    }
  });

  it("writeHookEntries preserves other top-level config keys (org_id, theme_mode)", () => {
    const settings: Record<string, unknown> = { org_id: "acme", theme_mode: "dark" };
    devin.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    expect(settings.org_id).toBe("acme");
    expect(settings.theme_mode).toBe("dark");
  });

  it("re-running writeHookEntries is idempotent", () => {
    const settings: Record<string, unknown> = {};
    devin.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    devin.writeHookEntries(settings, "/different/path/failproofai", "user");
    const hooks = settings.hooks as Record<string, Array<{ hooks: unknown[] }>>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].hooks).toHaveLength(1);
  });

  it("removeHooksFromFile clears all failproofai entries (returns count)", () => {
    const settingsPath = devin.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    devin.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    devin.writeSettings(settingsPath, settings);
    expect(existsSync(settingsPath)).toBe(true);

    const removed = devin.removeHooksFromFile(settingsPath);
    expect(removed).toBe(DEVIN_HOOK_EVENT_TYPES.length);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(after.hooks).toBeUndefined();
  });

  it("removeHooksFromFile preserves a user's own hook entries and other keys", () => {
    const settingsPath = devin.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {
      org_id: "acme",
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "my-own-hook" }] }],
      },
    };
    devin.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    devin.writeSettings(settingsPath, settings);

    devin.removeHooksFromFile(settingsPath);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, any>;
    expect(after.org_id).toBe("acme");
    const flattened = (after.hooks?.PreToolUse ?? []).flatMap((m: any) => m.hooks ?? []);
    expect(flattened.some((h: any) => h.command === "my-own-hook")).toBe(true);
    expect(flattened.some((h: any) => h[FAILPROOFAI_HOOK_MARKER] === true)).toBe(false);
  });

  it("hooksInstalledInSettings detects installed hooks", () => {
    const settingsPath = devin.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    devin.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    devin.writeSettings(settingsPath, settings);

    expect(devin.hooksInstalledInSettings("project", tempDir)).toBe(true);
  });
});

describe("Antigravity CLI integration", () => {
  it("getSettingsPath maps user → ~/.gemini/config/hooks.json and project → <cwd>/.agents/hooks.json", () => {
    expect(antigravity.getSettingsPath("project", tempDir)).toBe(
      resolve(tempDir, ".agents", "hooks.json"),
    );
    expect(antigravity.getSettingsPath("user")).toMatch(/\.gemini\/config\/hooks\.json$/);
  });

  it("scopes are user|project (no local)", () => {
    expect(antigravity.scopes).toEqual(["user", "project"]);
  });

  it("subscribes to the 4 verified agy events", () => {
    expect(ANTIGRAVITY_HOOK_EVENT_TYPES).toEqual([
      "PreToolUse",
      "PostToolUse",
      "PreInvocation",
      "Stop",
    ]);
  });

  it("buildHookEntry includes --cli antigravity and a 30s timeout", () => {
    const entry = antigravity.buildHookEntry("/usr/bin/failproofai", "PreToolUse", "user");
    expect(entry.command).toContain("--cli antigravity");
    expect(entry.command).toContain("--hook PreToolUse");
    expect(entry.timeout).toBe(30);
    expect(entry[FAILPROOFAI_HOOK_MARKER]).toBe(true);
  });

  it("project scope uses npx -y failproofai", () => {
    const entry = antigravity.buildHookEntry("/usr/bin/failproofai", "PreToolUse", "project");
    expect(entry.command).toBe("npx -y failproofai --hook PreToolUse --cli antigravity");
  });

  it("writeHookEntries nests events under a named 'failproofai' hook key", () => {
    const settings: Record<string, unknown> = {};
    antigravity.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    const named = settings.failproofai as Record<string, unknown>;
    expect(named).toBeDefined();
    for (const eventType of ANTIGRAVITY_HOOK_EVENT_TYPES) {
      expect(Array.isArray(named[eventType])).toBe(true);
    }
  });

  it("tool events use a {matcher:'*', hooks} wrapper; PreInvocation/Stop are flat handler arrays", () => {
    const settings: Record<string, unknown> = {};
    antigravity.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    const named = settings.failproofai as Record<string, any[]>;

    // Tool events → wrapper with matcher "*".
    const pre = named.PreToolUse[0];
    const post = named.PostToolUse[0];
    expect(pre.matcher).toBe("*");
    expect(Array.isArray(pre.hooks)).toBe(true);
    expect(pre.hooks[0][FAILPROOFAI_HOOK_MARKER]).toBe(true);
    expect(post.matcher).toBe("*");

    // Flat events → the handler object sits directly in the array (no wrapper).
    const preInvocation = named.PreInvocation[0];
    const stop = named.Stop[0];
    expect(preInvocation.matcher).toBeUndefined();
    expect(preInvocation.hooks).toBeUndefined();
    expect(preInvocation.type).toBe("command");
    expect(preInvocation[FAILPROOFAI_HOOK_MARKER]).toBe(true);
    expect(stop.matcher).toBeUndefined();
    expect(stop.type).toBe("command");
    expect(stop[FAILPROOFAI_HOOK_MARKER]).toBe(true);
  });

  it("re-running writeHookEntries is idempotent (tool wrapper + flat handler)", () => {
    const settings: Record<string, unknown> = {};
    antigravity.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    antigravity.writeHookEntries(settings, "/different/path/failproofai", "user");
    const named = settings.failproofai as Record<string, any[]>;
    expect(named.PreToolUse).toHaveLength(1);
    expect(named.PreToolUse[0].hooks).toHaveLength(1);
    expect(named.Stop).toHaveLength(1);
  });

  it("removeHooksFromFile clears all failproofai entries (returns count)", () => {
    const settingsPath = antigravity.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    antigravity.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    antigravity.writeSettings(settingsPath, settings);
    expect(existsSync(settingsPath)).toBe(true);

    const removed = antigravity.removeHooksFromFile(settingsPath);
    expect(removed).toBe(ANTIGRAVITY_HOOK_EVENT_TYPES.length);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    // The named hook is dropped entirely once empty.
    expect(after.failproofai).toBeUndefined();
  });

  it("removeHooksFromFile preserves other named hooks", () => {
    const settingsPath = antigravity.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {
      "lint-checker": {
        PostToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "./lint.sh" }] }],
      },
    };
    antigravity.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    antigravity.writeSettings(settingsPath, settings);

    antigravity.removeHooksFromFile(settingsPath);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, any>;
    // The user's own named hook survives; the failproofai named hook is gone.
    expect(after["lint-checker"]).toBeDefined();
    expect(after["lint-checker"].PostToolUse[0].hooks[0].command).toBe("./lint.sh");
    expect(after.failproofai).toBeUndefined();
  });

  it("hooksInstalledInSettings detects installed hooks", () => {
    const settingsPath = antigravity.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    antigravity.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    antigravity.writeSettings(settingsPath, settings);

    expect(antigravity.hooksInstalledInSettings("project", tempDir)).toBe(true);
  });
});

describe("Goose integration", () => {
  it("getSettingsPath maps user/project to the Open Plugins hooks.json in the plugin dir", () => {
    expect(goose.getSettingsPath("project", tempDir)).toBe(
      resolve(tempDir, ".agents", "plugins", "failproofai", "hooks", "hooks.json"),
    );
    expect(goose.getSettingsPath("user")).toMatch(
      /\.agents\/plugins\/failproofai\/hooks\/hooks\.json$/,
    );
  });

  it("scopes are user|project (no local)", () => {
    expect(goose.scopes).toEqual(["user", "project"]);
  });

  it("subscribes to the 5 verified events and NOT Stop (goose has none)", () => {
    expect(GOOSE_HOOK_EVENT_TYPES).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "SessionEnd",
    ]);
    expect(GOOSE_HOOK_EVENT_TYPES).not.toContain("Stop");
  });

  it("buildHookEntry emits a clean {type, command} with --cli goose and NO marker field", () => {
    const entry = goose.buildHookEntry("/usr/bin/failproofai", "PreToolUse", "user");
    expect(entry.type).toBe("command");
    expect(entry.command).toContain("--cli goose");
    expect(entry.command).toContain("--hook PreToolUse");
    // Goose parses this file, so we add NO __failproofai_hook__ marker.
    expect(entry[FAILPROOFAI_HOOK_MARKER]).toBeUndefined();
    expect(entry.timeout).toBeUndefined();
  });

  it("project scope uses npx -y failproofai", () => {
    const entry = goose.buildHookEntry("/usr/bin/failproofai", "PreToolUse", "project");
    expect(entry.command).toBe("npx -y failproofai --hook PreToolUse --cli goose");
  });

  it("writeHookEntries writes the Open Plugins schema (top-level 'hooks' wrapper, matcher OMITTED)", () => {
    const settings: Record<string, unknown> = {};
    goose.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    const hooks = settings.hooks as Record<string, any[]>;
    expect(hooks).toBeDefined();
    for (const eventType of GOOSE_HOOK_EVENT_TYPES) {
      expect(Array.isArray(hooks[eventType])).toBe(true);
      const matcherObj = hooks[eventType][0];
      // matcher must be OMITTED — a bare "*" is an invalid regex that matches nothing.
      expect(matcherObj.matcher).toBeUndefined();
      expect(Array.isArray(matcherObj.hooks)).toBe(true);
      expect(matcherObj.hooks[0].command).toContain("--cli goose");
    }
  });

  it("re-running writeHookEntries is idempotent (updates in place, no dup)", () => {
    const settings: Record<string, unknown> = {};
    goose.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    goose.writeHookEntries(settings, "/different/path/failproofai", "user");
    const hooks = settings.hooks as Record<string, any[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].hooks).toHaveLength(1);
    // Updated to the new binary path.
    expect(hooks.PreToolUse[0].hooks[0].command).toContain("/different/path/failproofai");
  });

  it("removeHooksFromFile clears all failproofai entries (returns count)", () => {
    const settingsPath = goose.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    goose.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    goose.writeSettings(settingsPath, settings);
    expect(existsSync(settingsPath)).toBe(true);

    const removed = goose.removeHooksFromFile(settingsPath);
    expect(removed).toBe(GOOSE_HOOK_EVENT_TYPES.length);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(after.hooks).toBeUndefined();
  });

  it("removeHooksFromFile preserves a user's own non-failproofai plugin hooks", () => {
    const settingsPath = goose.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "${PLUGIN_ROOT}/scripts/log.sh" }] }],
      },
    };
    goose.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    goose.writeSettings(settingsPath, settings);

    goose.removeHooksFromFile(settingsPath);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, any>;
    // The user's own log hook survives; failproofai's is gone.
    const postHooks = after.hooks.PostToolUse.flatMap((m: any) => m.hooks);
    expect(postHooks.some((h: any) => h.command.includes("log.sh"))).toBe(true);
    expect(postHooks.some((h: any) => h.command.includes("--cli goose"))).toBe(false);
  });

  it("hooksInstalledInSettings detects installed hooks", () => {
    const settingsPath = goose.getSettingsPath("project", tempDir);
    const settings: Record<string, unknown> = {};
    goose.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    goose.writeSettings(settingsPath, settings);

    expect(goose.hooksInstalledInSettings("project", tempDir)).toBe(true);
  });
});
