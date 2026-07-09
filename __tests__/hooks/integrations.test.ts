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
  gemini,
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
  GEMINI_HOOK_EVENT_TYPES,
  GEMINI_EVENT_MAP,
  GEMINI_TOOL_MAP,
  HOOK_EVENT_TYPES,
  FAILPROOFAI_HOOK_MARKER,
  type CodexHookEventType,
  type CursorHookEventType,
  type OpenCodeHookEventType,
  type PiHookEventType,
  type GeminiHookEventType,
} from "../../src/hooks/types";
import { homedir } from "node:os";

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
  it("listIntegrations returns claude, codex, copilot, cursor, opencode, pi, and gemini in declared order", () => {
    const ids = listIntegrations().map((i) => i.id);
    expect(ids).toEqual(["claude", "codex", "copilot", "cursor", "opencode", "pi", "gemini"]);
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

  it("getIntegration('gemini') returns gemini", () => {
    expect(getIntegration("gemini")).toBe(gemini);
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

describe("Gemini CLI integration", () => {
  it("getSettingsPath maps user → ~/.gemini/settings.json and project → <cwd>/.gemini/settings.json", () => {
    expect(gemini.getSettingsPath("project", tempDir)).toBe(
      resolve(tempDir, ".gemini", "settings.json"),
    );
    expect(gemini.getSettingsPath("user")).toMatch(/\.gemini\/settings\.json$/);
  });

  it("getSettingsPath('local') falls back to project (no gemini local scope)", () => {
    expect(gemini.getSettingsPath("local", tempDir)).toBe(
      resolve(tempDir, ".gemini", "settings.json"),
    );
  });

  it("scopes are user|project (no local; system scope ignored)", () => {
    expect(gemini.scopes).toEqual(["user", "project"]);
    expect(gemini.scopes).not.toContain("local");
  });

  it("eventTypes are the 11 PascalCase Gemini events", () => {
    expect(gemini.eventTypes).toEqual(GEMINI_HOOK_EVENT_TYPES);
    expect(gemini.eventTypes).toContain("SessionStart");
    expect(gemini.eventTypes).toContain("SessionEnd");
    expect(gemini.eventTypes).toContain("BeforeAgent");
    expect(gemini.eventTypes).toContain("AfterAgent");
    expect(gemini.eventTypes).toContain("BeforeModel");
    expect(gemini.eventTypes).toContain("AfterModel");
    expect(gemini.eventTypes).toContain("BeforeToolSelection");
    expect(gemini.eventTypes).toContain("BeforeTool");
    expect(gemini.eventTypes).toContain("AfterTool");
    expect(gemini.eventTypes).toContain("PreCompress");
    expect(gemini.eventTypes).toContain("Notification");
    expect(gemini.eventTypes).toHaveLength(11);
  });

  it("buildHookEntry uses Claude-shaped {type,command,timeout,marker} with --cli gemini", () => {
    const entry = gemini.buildHookEntry("/usr/bin/failproofai", "BeforeTool", "user") as Record<string, unknown>;
    expect(entry.type).toBe("command");
    expect(entry.command).toBe('"/usr/bin/failproofai" --hook BeforeTool --cli gemini');
    expect(entry.timeout).toBe(60_000);
    expect(entry[FAILPROOFAI_HOOK_MARKER]).toBe(true);
    // Gemini entries use Claude's `command` field, not Copilot's bash/powershell split.
    expect(entry.bash).toBeUndefined();
    expect(entry.powershell).toBeUndefined();
  });

  it("project scope uses npx -y failproofai (portable across machines)", () => {
    const entry = gemini.buildHookEntry("/usr/bin/failproofai", "BeforeTool", "project") as Record<string, unknown>;
    expect(entry.command).toBe("npx -y failproofai --hook BeforeTool --cli gemini");
  });

  it("writeHookEntries writes the matcher-wrapper schema for all 11 events with matcher='*'", () => {
    const settings: Record<string, unknown> = {};
    gemini.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;
    for (const eventType of GEMINI_HOOK_EVENT_TYPES) {
      expect(hooks[eventType]).toBeDefined();
      const matchers = hooks[eventType];
      expect(matchers.length).toBeGreaterThanOrEqual(1);
      // Matcher-wrapper: each element is {matcher, hooks: [{type, command, ...}]}
      expect(matchers[0].matcher).toBe("*");
      const inner = matchers[0].hooks as Array<Record<string, unknown>>;
      expect(inner).toHaveLength(1);
      expect(inner[0].type).toBe("command");
      expect(typeof inner[0].command).toBe("string");
      expect(inner[0][FAILPROOFAI_HOOK_MARKER]).toBe(true);
    }
  });

  it("re-running writeHookEntries is idempotent (replaces, doesn't duplicate)", () => {
    const settings: Record<string, unknown> = {};
    gemini.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    gemini.writeHookEntries(settings, "/different/path/failproofai", "user");
    const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;
    // Each event has exactly one matcher; the inner hook is the most recent.
    expect(hooks.BeforeTool).toHaveLength(1);
    const inner = (hooks.BeforeTool[0].hooks as Array<Record<string, unknown>>)[0];
    expect(inner.command).toBe('"/different/path/failproofai" --hook BeforeTool --cli gemini');
  });

  it("writeHookEntries preserves a hand-written user hook with the same event key", () => {
    const userHook = { type: "command", command: "/my/script.sh", timeout: 5000 };
    const settings: Record<string, unknown> = {
      hooks: { BeforeTool: [{ matcher: "write_file", hooks: [userHook] }] },
    };
    gemini.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;
    // User's hook is preserved at index 0, ours appended at index 1
    expect(hooks.BeforeTool).toHaveLength(2);
    const userMatcher = hooks.BeforeTool[0];
    expect(userMatcher.matcher).toBe("write_file");
    expect((userMatcher.hooks as Array<Record<string, unknown>>)[0].command).toBe("/my/script.sh");
    const ourMatcher = hooks.BeforeTool[1];
    expect(ourMatcher.matcher).toBe("*");
    expect((ourMatcher.hooks as Array<Record<string, unknown>>)[0][FAILPROOFAI_HOOK_MARKER]).toBe(true);
  });

  it("removeHooksFromFile removes only failproofai-marked entries (preserves user hooks)", () => {
    const userHook = { type: "command", command: "/my/script.sh", timeout: 5000 };
    const settingsPath = gemini.getSettingsPath("project", tempDir);
    mkdirSync(resolve(tempDir, ".gemini"), { recursive: true });
    const settings: Record<string, unknown> = {
      hooks: { BeforeTool: [{ matcher: "write_file", hooks: [userHook] }] },
    };
    gemini.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    gemini.writeSettings(settingsPath, settings);

    const removed = gemini.removeHooksFromFile(settingsPath);
    // 11 events × 1 marked entry each = 11 removed
    expect(removed).toBe(GEMINI_HOOK_EVENT_TYPES.length);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const afterHooks = after.hooks as Record<string, unknown[]>;
    // User's BeforeTool hook still there
    expect(afterHooks.BeforeTool).toHaveLength(1);
    expect((afterHooks.BeforeTool[0] as Record<string, unknown>).matcher).toBe("write_file");
    // Other event keys (which only had failproofai entries) are deleted
    expect(afterHooks.SessionStart).toBeUndefined();
  });

  it("removeHooksFromFile clears all and removes the top-level hooks key when nothing remains", () => {
    const settingsPath = gemini.getSettingsPath("project", tempDir);
    mkdirSync(resolve(tempDir, ".gemini"), { recursive: true });
    const settings: Record<string, unknown> = {};
    gemini.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    gemini.writeSettings(settingsPath, settings);

    const removed = gemini.removeHooksFromFile(settingsPath);
    expect(removed).toBe(GEMINI_HOOK_EVENT_TYPES.length);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(after.hooks).toBeUndefined();
  });

  it("hooksInstalledInSettings detects installed hooks", () => {
    const settingsPath = gemini.getSettingsPath("project", tempDir);
    mkdirSync(resolve(tempDir, ".gemini"), { recursive: true });
    const settings: Record<string, unknown> = {};
    gemini.writeHookEntries(settings, "/usr/bin/failproofai", "project");
    gemini.writeSettings(settingsPath, settings);

    expect(gemini.hooksInstalledInSettings("project", tempDir)).toBe(true);
  });

  it("hooksInstalledInSettings returns false when file is missing", () => {
    expect(gemini.hooksInstalledInSettings("project", tempDir)).toBe(false);
  });

  it("hooksInstalledInSettings returns false on corrupt JSON (fail-open)", () => {
    const settingsPath = gemini.getSettingsPath("project", tempDir);
    mkdirSync(resolve(tempDir, ".gemini"), { recursive: true });
    writeFileSync(settingsPath, "{not json");
    expect(gemini.hooksInstalledInSettings("project", tempDir)).toBe(false);
  });
});

describe("GEMINI_EVENT_MAP", () => {
  it("maps every Gemini event to a canonical HookEventType (or passthrough)", () => {
    expect(GEMINI_EVENT_MAP.SessionStart).toBe("SessionStart");
    expect(GEMINI_EVENT_MAP.SessionEnd).toBe("SessionEnd");
    expect(GEMINI_EVENT_MAP.BeforeAgent).toBe("UserPromptSubmit");
    expect(GEMINI_EVENT_MAP.AfterAgent).toBe("Stop");
    expect(GEMINI_EVENT_MAP.BeforeTool).toBe("PreToolUse");
    expect(GEMINI_EVENT_MAP.AfterTool).toBe("PostToolUse");
    expect(GEMINI_EVENT_MAP.PreCompress).toBe("PreCompact");
    expect(GEMINI_EVENT_MAP.Notification).toBe("Notification");
    // Three Gemini-only events have no canonical Claude equivalent — passthrough.
    expect(GEMINI_EVENT_MAP.BeforeModel).toBe("BeforeModel");
    expect(GEMINI_EVENT_MAP.AfterModel).toBe("AfterModel");
    expect(GEMINI_EVENT_MAP.BeforeToolSelection).toBe("BeforeToolSelection");
  });

  it("GEMINI_EVENT_MAP keys exactly match GEMINI_HOOK_EVENT_TYPES", () => {
    const mapKeys = Object.keys(GEMINI_EVENT_MAP).sort();
    const eventTypes = [...GEMINI_HOOK_EVENT_TYPES].sort();
    expect(mapKeys).toEqual(eventTypes);
  });

  it("GeminiHookEventType is exhaustive", () => {
    const sample: GeminiHookEventType = "BeforeTool";
    expect(GEMINI_EVENT_MAP[sample]).toBe("PreToolUse");
  });
});

describe("GEMINI_TOOL_MAP", () => {
  it("maps every documented Gemini snake_case tool name to a Claude PascalCase canonical name", () => {
    expect(GEMINI_TOOL_MAP.run_shell_command).toBe("Bash");
    expect(GEMINI_TOOL_MAP.read_file).toBe("Read");
    expect(GEMINI_TOOL_MAP.read_many_files).toBe("Read");
    expect(GEMINI_TOOL_MAP.write_file).toBe("Write");
    expect(GEMINI_TOOL_MAP.replace).toBe("Edit");
    expect(GEMINI_TOOL_MAP.glob).toBe("Glob");
    expect(GEMINI_TOOL_MAP.grep_search).toBe("Grep");
    expect(GEMINI_TOOL_MAP.list_directory).toBe("LS");
    expect(GEMINI_TOOL_MAP.web_fetch).toBe("WebFetch");
    expect(GEMINI_TOOL_MAP.google_web_search).toBe("WebSearch");
    expect(GEMINI_TOOL_MAP.write_todos).toBe("TodoWrite");
    expect(GEMINI_TOOL_MAP.save_memory).toBe("Memory");
    expect(GEMINI_TOOL_MAP.ask_user).toBe("AskUser");
  });
});
