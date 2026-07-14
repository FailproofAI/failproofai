/**
 * Per-CLI hook integration registry.
 *
 * An `Integration` describes how failproofai hooks are installed, detected, and
 * read for a specific agent CLI (Claude Code, OpenAI Codex). The runtime hot
 * path (`handler.ts`, `policy-evaluator.ts`, `BUILTIN_POLICIES`, `policy-helpers`)
 * is agent-agnostic — only install/uninstall plumbing varies.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parseDocument, type Document } from "yaml";
import {
  HOOK_EVENT_TYPES,
  HOOK_SCOPES,
  CODEX_HOOK_EVENT_TYPES,
  CODEX_HOOK_SCOPES,
  CODEX_EVENT_MAP,
  COPILOT_HOOK_EVENT_TYPES,
  COPILOT_HOOK_SCOPES,
  CURSOR_HOOK_EVENT_TYPES,
  CURSOR_HOOK_SCOPES,
  OPENCODE_HOOK_EVENT_TYPES,
  OPENCODE_HOOK_SCOPES,
  PI_HOOK_EVENT_TYPES,
  PI_HOOK_SCOPES,
  HERMES_HOOK_EVENT_TYPES,
  HERMES_HOOK_SCOPES,
  OPENCLAW_HOOK_EVENT_TYPES,
  OPENCLAW_HOOK_SCOPES,
  FACTORY_HOOK_EVENT_TYPES,
  FACTORY_HOOK_SCOPES,
  DEVIN_HOOK_EVENT_TYPES,
  DEVIN_HOOK_SCOPES,
  ANTIGRAVITY_HOOK_EVENT_TYPES,
  ANTIGRAVITY_HOOK_SCOPES,
  GOOSE_HOOK_EVENT_TYPES,
  GOOSE_HOOK_SCOPES,
  FAILPROOFAI_HOOK_MARKER,
  INTEGRATION_TYPES,
  type IntegrationType,
  type HookScope,
  type ClaudeSettings,
  type ClaudeHookMatcher,
  type ClaudeHookEntry,
  type CodexHookEventType,
} from "./types";

// ── Generic helpers ─────────────────────────────────────────────────────────

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeJsonFile(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Read a YAML file as a `Document` so writes round-trip the user's other keys +
 *  comments (a plain parse→stringify would strip comments). Empty / missing /
 *  corrupt → an empty Document. Used by the Hermes integration, whose config
 *  lives in `~/.hermes/config.yaml`. */
function readYamlDoc(path: string): Document {
  try {
    return existsSync(path) ? parseDocument(readFileSync(path, "utf8")) : parseDocument("");
  } catch {
    return parseDocument("");
  }
}

function writeYamlDoc(path: string, doc: Document): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, doc.toString(), "utf8");
}

function isMarkedHook(hook: unknown): boolean {
  if (!hook || typeof hook !== "object") return false;
  const h = hook as Record<string, unknown>;
  if (h[FAILPROOFAI_HOOK_MARKER] === true) return true;
  // Fallback for legacy installs predating the marker
  const cmd = typeof h.command === "string" ? h.command : "";
  return cmd.includes("failproofai") && cmd.includes("--hook");
}

function stripLegacyVersion(settings: Record<string, unknown>): boolean {
  if ("version" in settings) {
    delete settings.version;
    return true;
  }
  return false;
}

function binaryExists(name: string): boolean {
  try {
    const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
    execSync(cmd, { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ── Integration interface ───────────────────────────────────────────────────

export interface Integration {
  id: IntegrationType;
  displayName: string;
  /** Settings scopes this integration supports (e.g. claude: user/project/local; codex: user/project). */
  scopes: readonly HookScope[];
  /** Hook events this integration fires (Claude: PascalCase, Codex: snake_case stored as Pascal in settings). */
  eventTypes: readonly string[];

  /** Resolve the per-scope settings/hooks file path. */
  getSettingsPath(scope: HookScope, cwd?: string): string;

  /** Read the raw settings/hooks file (returns {} when missing). */
  readSettings(settingsPath: string): Record<string, unknown>;

  /** Write the settings/hooks file. */
  writeSettings(settingsPath: string, settings: Record<string, unknown>): void;

  /** Build a single hook entry for a given event. */
  buildHookEntry(binaryPath: string, eventType: string, scope?: HookScope): Record<string, unknown>;

  /** Whether a hook entry is owned by failproofai. Entry shape varies per CLI (object for Claude/Codex/Copilot/Cursor; string or tuple for OpenCode). */
  isFailproofaiHook(hook: unknown): boolean;

  /** Mutate `settings` in place, registering failproofai across all event types. Idempotent. */
  writeHookEntries(settings: Record<string, unknown>, binaryPath: string, scope?: HookScope): void;

  /** Remove all failproofai hook entries from a settings file. Returns the number removed. */
  removeHooksFromFile(settingsPath: string): number;

  /** Whether failproofai hooks are present in a given scope. */
  hooksInstalledInSettings(scope: HookScope, cwd?: string): boolean;

  /** Whether the agent CLI binary is installed (probes PATH). */
  detectInstalled(): boolean;
}

// ── Claude Code integration ─────────────────────────────────────────────────

export const claudeCode: Integration = {
  id: "claude",
  displayName: "Claude Code",
  scopes: HOOK_SCOPES,
  eventTypes: HOOK_EVENT_TYPES,

  getSettingsPath(scope, cwd) {
    const base = cwd ? resolve(cwd) : process.cwd();
    switch (scope) {
      case "user":
        return resolve(homedir(), ".claude", "settings.json");
      case "project":
        return resolve(base, ".claude", "settings.json");
      case "local":
        return resolve(base, ".claude", "settings.local.json");
    }
  },

  readSettings(settingsPath) {
    return readJsonFile(settingsPath);
  },

  writeSettings(settingsPath, settings) {
    writeJsonFile(settingsPath, settings);
  },

  buildHookEntry(binaryPath, eventType, scope) {
    // No --cli flag on the Claude command line: the handler defaults to
    // claude when --cli is omitted, preserving back-compat with hooks
    // installed before multi-CLI support was added.
    const command =
      scope === "project"
        ? `npx -y failproofai --hook ${eventType}`
        : `"${binaryPath}" --hook ${eventType}`;
    return {
      type: "command",
      command,
      // Claude reads `timeout` in SECONDS per https://code.claude.com/docs/en/hooks
      // ("Seconds before canceling. Defaults: 600 for command ...; 60 for agent"),
      // NOT milliseconds. 60 = 60s; the old 60000 meant ~16.7h. (#482-class unit fix)
      timeout: 60,
      [FAILPROOFAI_HOOK_MARKER]: true,
    };
  },

  isFailproofaiHook: isMarkedHook,

  writeHookEntries(settings, binaryPath, scope) {
    const s = settings as ClaudeSettings;
    if (!s.hooks) s.hooks = {};

    for (const eventType of HOOK_EVENT_TYPES) {
      const hookEntry = this.buildHookEntry(binaryPath, eventType, scope) as unknown as ClaudeHookEntry;
      if (!s.hooks[eventType]) s.hooks[eventType] = [];
      const matchers: ClaudeHookMatcher[] = s.hooks[eventType];

      let found = false;
      for (const matcher of matchers) {
        if (!matcher.hooks) continue;
        const idx = matcher.hooks.findIndex((h) => isMarkedHook(h as Record<string, unknown>));
        if (idx >= 0) {
          matcher.hooks[idx] = hookEntry;
          found = true;
          break;
        }
      }
      if (!found) matchers.push({ hooks: [hookEntry] });
    }
  },

  removeHooksFromFile(settingsPath) {
    const settings = this.readSettings(settingsPath) as ClaudeSettings;
    if (!settings.hooks) return 0;

    let removed = 0;
    for (const eventType of Object.keys(settings.hooks)) {
      const matchers = settings.hooks[eventType];
      if (!Array.isArray(matchers)) continue;
      for (let i = matchers.length - 1; i >= 0; i--) {
        const matcher = matchers[i];
        if (!matcher.hooks) continue;
        const before = matcher.hooks.length;
        matcher.hooks = matcher.hooks.filter((h) => !isMarkedHook(h as Record<string, unknown>));
        removed += before - matcher.hooks.length;
        if (matcher.hooks.length === 0) matchers.splice(i, 1);
      }
      if (matchers.length === 0) delete settings.hooks[eventType];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    this.writeSettings(settingsPath, settings as Record<string, unknown>);
    return removed;
  },

  hooksInstalledInSettings(scope, cwd) {
    const settingsPath = this.getSettingsPath(scope, cwd);
    if (!existsSync(settingsPath)) return false;
    try {
      const settings = this.readSettings(settingsPath) as ClaudeSettings;
      if (!settings.hooks) return false;
      for (const matchers of Object.values(settings.hooks)) {
        if (!Array.isArray(matchers)) continue;
        for (const matcher of matchers) {
          if (!matcher.hooks) continue;
          if (matcher.hooks.some((h) => isMarkedHook(h as Record<string, unknown>))) return true;
        }
      }
    } catch {
      // Corrupt settings — treat as not installed
    }
    return false;
  },

  detectInstalled() {
    return binaryExists("claude") || binaryExists("claude-code");
  },
};

// ── OpenAI Codex integration ────────────────────────────────────────────────
//
// Codex's hook protocol is Claude-compatible by design (see the parity matrix
// in plans/great-in-failproofai-i-vectorized-treasure.md). The only material
// differences are:
//   • Settings paths: ~/.codex/hooks.json (user) and <cwd>/.codex/hooks.json (project)
//   • Stdin event names arrive snake_case (pre_tool_use); we canonicalize to PascalCase before policy lookup
//   • No "local" scope
//   • Settings file does NOT carry a top-level "version" marker (Codex strictly expects only `hooks`)

interface CodexSettingsFile {
  hooks?: Record<string, ClaudeHookMatcher[]>;
  [key: string]: unknown;
}

export const codex: Integration = {
  id: "codex",
  displayName: "OpenAI Codex",
  scopes: CODEX_HOOK_SCOPES,
  eventTypes: CODEX_HOOK_EVENT_TYPES,

  getSettingsPath(scope, cwd) {
    const base = cwd ? resolve(cwd) : process.cwd();
    switch (scope) {
      case "user":
        return resolve(homedir(), ".codex", "hooks.json");
      case "project":
        return resolve(base, ".codex", "hooks.json");
      case "local":
        // Codex has no "local" scope; fall back to project so callers don't crash.
        // The CLI rejects --cli codex --scope local before reaching here.
        return resolve(base, ".codex", "hooks.json");
    }
  },

  readSettings(settingsPath) {
    return readJsonFile(settingsPath);
  },

  writeSettings(settingsPath, settings) {
    writeJsonFile(settingsPath, settings);
  },

  buildHookEntry(binaryPath, eventType, scope) {
    // `eventType` here is the snake_case Codex event name; Codex stores under
    // PascalCase keys but invokes the command with the snake_case form, which
    // we canonicalize on the way into policy-evaluator.
    const command =
      scope === "project"
        ? `npx -y failproofai --hook ${eventType} --cli codex`
        : `"${binaryPath}" --hook ${eventType} --cli codex`;
    return {
      type: "command",
      // Codex reads `timeout` in SECONDS (the field is literally `timeout`,
      // default 600 per https://developers.openai.com/codex/hooks) — same unit as
      // Claude/Cursor/Copilot. 60 = 60s.
      command,
      timeout: 60,
      [FAILPROOFAI_HOOK_MARKER]: true,
    };
  },

  isFailproofaiHook: isMarkedHook,

  writeHookEntries(settings, binaryPath, scope) {
    const s = settings as CodexSettingsFile;
    stripLegacyVersion(s as Record<string, unknown>);
    if (!s.hooks) s.hooks = {};

    for (const eventType of CODEX_HOOK_EVENT_TYPES) {
      const pascalKey = CODEX_EVENT_MAP[eventType as CodexHookEventType];
      const hookEntry = this.buildHookEntry(binaryPath, eventType, scope) as unknown as ClaudeHookEntry;
      if (!s.hooks[pascalKey]) s.hooks[pascalKey] = [];
      const matchers: ClaudeHookMatcher[] = s.hooks[pascalKey];

      let found = false;
      for (const matcher of matchers) {
        if (!matcher.hooks) continue;
        const idx = matcher.hooks.findIndex((h) => isMarkedHook(h as Record<string, unknown>));
        if (idx >= 0) {
          matcher.hooks[idx] = hookEntry;
          found = true;
          break;
        }
      }
      if (!found) matchers.push({ hooks: [hookEntry] });
    }
  },

  removeHooksFromFile(settingsPath) {
    const settings = this.readSettings(settingsPath) as CodexSettingsFile;
    const hadVersion = stripLegacyVersion(settings as Record<string, unknown>);
    if (!settings.hooks) {
      if (hadVersion) this.writeSettings(settingsPath, settings as Record<string, unknown>);
      return 0;
    }

    let removed = 0;
    for (const eventType of Object.keys(settings.hooks)) {
      const matchers = settings.hooks[eventType];
      if (!Array.isArray(matchers)) continue;
      for (let i = matchers.length - 1; i >= 0; i--) {
        const matcher = matchers[i];
        if (!matcher.hooks) continue;
        const before = matcher.hooks.length;
        matcher.hooks = matcher.hooks.filter((h) => !isMarkedHook(h as Record<string, unknown>));
        removed += before - matcher.hooks.length;
        if (matcher.hooks.length === 0) matchers.splice(i, 1);
      }
      if (matchers.length === 0) delete settings.hooks[eventType];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    if (removed > 0 || hadVersion) {
      this.writeSettings(settingsPath, settings as Record<string, unknown>);
    }
    return removed;
  },

  hooksInstalledInSettings(scope, cwd) {
    const settingsPath = this.getSettingsPath(scope, cwd);
    if (!existsSync(settingsPath)) return false;
    try {
      const settings = this.readSettings(settingsPath) as CodexSettingsFile;
      if (!settings.hooks) return false;
      for (const matchers of Object.values(settings.hooks)) {
        if (!Array.isArray(matchers)) continue;
        for (const matcher of matchers) {
          if (!matcher.hooks) continue;
          if (matcher.hooks.some((h) => isMarkedHook(h as Record<string, unknown>))) return true;
        }
      }
    } catch {
      // Corrupt settings — treat as not installed
    }
    return false;
  },

  detectInstalled() {
    return binaryExists("codex");
  },
};

// ── GitHub Copilot CLI integration ──────────────────────────────────────────
//
// Copilot CLI accepts two hook payload formats: a camelCase native form and a
// "VS Code compatible" PascalCase form. We install with PascalCase keys, which
// gets us:
//   • PascalCase `hook_event_name` on stdin (matches Claude — no canonicalization)
//   • snake_case fields like `tool_name`/`tool_input` (matches Claude payload parser)
//   • `hookSpecificOutput.permissionDecision` honored on stdout (matches Claude
//     output shape — policy-evaluator works unchanged)
//
// Hook entries differ from Claude/Codex: each entry uses OS-keyed `bash` and
// `powershell` command fields and a `timeoutSec` (seconds) instead of Claude's
// single `command` field with `timeout` (milliseconds). Top-level wrapper is
// `{ "version": 1, "hooks": {...} }`, mirroring Codex.

interface CopilotHookEntry {
  type: "command";
  bash: string;
  powershell: string;
  timeoutSec: number;
  [FAILPROOFAI_HOOK_MARKER]: true;
}

interface CopilotSettingsFile {
  version?: number;
  hooks?: Record<string, ClaudeHookMatcher[]>;
  [key: string]: unknown;
}

function isMarkedCopilotHook(hook: Record<string, unknown>): boolean {
  if (hook[FAILPROOFAI_HOOK_MARKER] === true) return true;
  // Fallback for legacy installs predating the marker — Copilot entries store
  // commands under `bash`/`powershell` rather than `command`, so check both.
  const bash = typeof hook.bash === "string" ? hook.bash : "";
  const ps = typeof hook.powershell === "string" ? hook.powershell : "";
  for (const cmd of [bash, ps]) {
    if (cmd.includes("failproofai") && cmd.includes("--hook")) return true;
  }
  return false;
}

export const copilot: Integration = {
  id: "copilot",
  displayName: "GitHub Copilot",
  scopes: COPILOT_HOOK_SCOPES,
  eventTypes: COPILOT_HOOK_EVENT_TYPES,

  getSettingsPath(scope, cwd) {
    const base = cwd ? resolve(cwd) : process.cwd();
    switch (scope) {
      case "user":
        return resolve(homedir(), ".copilot", "hooks", "failproofai.json");
      case "project":
        return resolve(base, ".github", "hooks", "failproofai.json");
      case "local":
        // Copilot has no "local" scope; CLI rejects --cli copilot --scope local
        // before reaching here, but fall back to project so callers don't crash.
        return resolve(base, ".github", "hooks", "failproofai.json");
    }
  },

  readSettings(settingsPath) {
    const raw = readJsonFile(settingsPath);
    if (raw.version === undefined) raw.version = 1;
    return raw;
  },

  writeSettings(settingsPath, settings) {
    writeJsonFile(settingsPath, settings);
  },

  buildHookEntry(binaryPath, eventType, scope) {
    const cmd =
      scope === "project"
        ? `npx -y failproofai --hook ${eventType} --cli copilot`
        : `"${binaryPath}" --hook ${eventType} --cli copilot`;
    return {
      type: "command",
      bash: cmd,
      powershell: cmd,
      timeoutSec: 60,
      [FAILPROOFAI_HOOK_MARKER]: true,
    };
  },

  isFailproofaiHook: isMarkedCopilotHook,

  writeHookEntries(settings, binaryPath, scope) {
    const s = settings as CopilotSettingsFile;
    if (s.version === undefined) s.version = 1;
    if (!s.hooks) s.hooks = {};

    for (const eventType of COPILOT_HOOK_EVENT_TYPES) {
      const hookEntry = this.buildHookEntry(binaryPath, eventType, scope) as unknown as CopilotHookEntry;
      if (!s.hooks[eventType]) s.hooks[eventType] = [];
      const matchers: ClaudeHookMatcher[] = s.hooks[eventType];

      let found = false;
      for (const matcher of matchers) {
        if (!matcher.hooks) continue;
        const idx = matcher.hooks.findIndex((h) => isMarkedCopilotHook(h as Record<string, unknown>));
        if (idx >= 0) {
          matcher.hooks[idx] = hookEntry as unknown as ClaudeHookEntry;
          found = true;
          break;
        }
      }
      if (!found) matchers.push({ hooks: [hookEntry as unknown as ClaudeHookEntry] });
    }
  },

  removeHooksFromFile(settingsPath) {
    const settings = this.readSettings(settingsPath) as CopilotSettingsFile;
    if (!settings.hooks) return 0;

    let removed = 0;
    for (const eventType of Object.keys(settings.hooks)) {
      const matchers = settings.hooks[eventType];
      if (!Array.isArray(matchers)) continue;
      for (let i = matchers.length - 1; i >= 0; i--) {
        const matcher = matchers[i];
        if (!matcher.hooks) continue;
        const before = matcher.hooks.length;
        matcher.hooks = matcher.hooks.filter((h) => !isMarkedCopilotHook(h as Record<string, unknown>));
        removed += before - matcher.hooks.length;
        if (matcher.hooks.length === 0) matchers.splice(i, 1);
      }
      if (matchers.length === 0) delete settings.hooks[eventType];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    this.writeSettings(settingsPath, settings as Record<string, unknown>);
    return removed;
  },

  hooksInstalledInSettings(scope, cwd) {
    const settingsPath = this.getSettingsPath(scope, cwd);
    if (!existsSync(settingsPath)) return false;
    try {
      const settings = this.readSettings(settingsPath) as CopilotSettingsFile;
      if (!settings.hooks) return false;
      for (const matchers of Object.values(settings.hooks)) {
        if (!Array.isArray(matchers)) continue;
        for (const matcher of matchers) {
          if (!matcher.hooks) continue;
          if (matcher.hooks.some((h) => isMarkedCopilotHook(h as Record<string, unknown>))) return true;
        }
      }
    } catch {
      // Corrupt settings — treat as not installed
    }
    return false;
  },

  detectInstalled() {
    return binaryExists("copilot");
  },
};

// ── Cursor Agent CLI integration ───────────────────────────────────────────
//
// Cursor's hooks.json schema is a FLAT array of hook entries per event —
// `{ hooks: { preToolUse: [{ command, type, timeout, ... }] } }` — without
// the Claude-style `{ hooks: [...] }` matcher wrapper. The settings file
// carries `version: 1` like Codex/Copilot. Differences from Claude:
//   • Settings paths: ~/.cursor/hooks.json (user) and <cwd>/.cursor/hooks.json (project)
//   • Event keys are camelCase (`preToolUse`, `beforeSubmitPrompt`, …); we
//     canonicalize to PascalCase in handler.ts before policy lookup
//   • Stdout decision shape differs (`{permission, user_message, agent_message,
//     additional_context}`); the Cursor branch in policy-evaluator.ts emits it
//   • No "local" scope
//   • Detected via the `cursor-agent` binary (preferred) or `agent` (legacy alias)
//
// Ref: https://cursor.com/docs/hooks (Schema section).

interface CursorSettingsFile {
  version?: number;
  /** Flat array of hook entries per event — NOT wrapped in `{ hooks: [...] }`. */
  hooks?: Record<string, Array<ClaudeHookEntry | Record<string, unknown>>>;
  [key: string]: unknown;
}

export const cursor: Integration = {
  id: "cursor",
  displayName: "Cursor Agent",
  scopes: CURSOR_HOOK_SCOPES,
  eventTypes: CURSOR_HOOK_EVENT_TYPES,

  getSettingsPath(scope, cwd) {
    const base = cwd ? resolve(cwd) : process.cwd();
    switch (scope) {
      case "user":
        return resolve(homedir(), ".cursor", "hooks.json");
      case "project":
        return resolve(base, ".cursor", "hooks.json");
      case "local":
        // Cursor has no "local" scope; CLI rejects --cli cursor --scope local
        // before reaching here, but fall back to project so callers don't crash.
        return resolve(base, ".cursor", "hooks.json");
    }
  },

  readSettings(settingsPath) {
    const raw = readJsonFile(settingsPath);
    if (raw.version === undefined) raw.version = 1;
    return raw;
  },

  writeSettings(settingsPath, settings) {
    writeJsonFile(settingsPath, settings);
  },

  buildHookEntry(binaryPath, eventType, scope) {
    const command =
      scope === "project"
        ? `npx -y failproofai --hook ${eventType} --cli cursor`
        : `"${binaryPath}" --hook ${eventType} --cli cursor`;
    // `timeout` is documented in SECONDS in Cursor's schema per
    // https://cursor.com/docs/hooks ("Execution timeout in seconds"; doc examples
    // use 30 and 10), NOT milliseconds. 60 = 60s; the old 60000 meant ~16.7h.
    return {
      type: "command",
      command,
      timeout: 60,
      [FAILPROOFAI_HOOK_MARKER]: true,
    };
  },

  isFailproofaiHook: isMarkedHook,

  writeHookEntries(settings, binaryPath, scope) {
    const s = settings as CursorSettingsFile;
    if (s.version === undefined) s.version = 1;
    if (!s.hooks) s.hooks = {};

    for (const eventType of CURSOR_HOOK_EVENT_TYPES) {
      const hookEntry = this.buildHookEntry(binaryPath, eventType, scope) as unknown as ClaudeHookEntry;
      const existing = s.hooks[eventType];
      const entries: Array<ClaudeHookEntry | Record<string, unknown>> = existing ?? [];
      if (!existing) s.hooks[eventType] = entries;

      // Idempotent: replace an existing failproofai-marked entry; otherwise append.
      const idx = entries.findIndex((h) => isMarkedHook(h as Record<string, unknown>));
      if (idx >= 0) {
        entries[idx] = hookEntry;
      } else {
        entries.push(hookEntry);
      }
    }
  },

  removeHooksFromFile(settingsPath) {
    const settings = this.readSettings(settingsPath) as CursorSettingsFile;
    if (!settings.hooks) return 0;

    let removed = 0;
    for (const eventType of Object.keys(settings.hooks)) {
      const entries = settings.hooks[eventType];
      if (!Array.isArray(entries)) continue;
      const before = entries.length;
      const filtered = entries.filter((h) => !isMarkedHook(h as Record<string, unknown>));
      removed += before - filtered.length;
      if (filtered.length === 0) {
        delete settings.hooks[eventType];
      } else {
        settings.hooks[eventType] = filtered;
      }
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    this.writeSettings(settingsPath, settings as Record<string, unknown>);
    return removed;
  },

  hooksInstalledInSettings(scope, cwd) {
    const settingsPath = this.getSettingsPath(scope, cwd);
    if (!existsSync(settingsPath)) return false;
    try {
      const settings = this.readSettings(settingsPath) as CursorSettingsFile;
      if (!settings.hooks) return false;
      for (const entries of Object.values(settings.hooks)) {
        if (!Array.isArray(entries)) continue;
        if (entries.some((h) => isMarkedHook(h as Record<string, unknown>))) return true;
      }
    } catch {
      // Corrupt settings — treat as not installed
    }
    return false;
  },

  detectInstalled() {
    return binaryExists("cursor-agent") || binaryExists("agent");
  },
};

// ── OpenCode (sst/opencode) integration ────────────────────────────────────
//
// OpenCode does not have an external-command hook system. Plugins are
// in-process JS/TS modules registered via the `plugin: []` array in
// `opencode.json`. To reuse the existing failproofai evaluator without
// forking the codebase, this integration drops a generated plugin shim
// at `.opencode/plugins/failproofai.mjs` (project) or
// `~/.config/opencode/plugins/failproofai.mjs` (user) AND edits the
// adjacent `opencode.json` to register it. The shim subprocess-calls the
// failproofai binary with `--cli opencode` and translates the binary's
// Claude-shape JSON response back into plugin semantics:
//   • exit 2 OR `permissionDecision: "deny"` → `throw new Error(reason)`
//     (which OpenCode surfaces as a tool-call failure to the agent)
//   • `additionalContext` → `client.session.prompt(...)` (fire-and-forget)
//   • everything else → no-op (allow)
//
// Settings paths:
//   user    → ~/.config/opencode/opencode.json (+ plugins/failproofai.mjs)
//   project → <cwd>/.opencode/opencode.json     (+ plugins/failproofai.mjs)
// OpenCode has no `local` scope.
//
// Verified live against opencode v1.14.31 — see the Live findings section
// of the implementation plan for the full event surface and SDK shape.
//
// Ref: https://opencode.ai/docs/plugins/

interface OpenCodeSettingsFile {
  /** OpenCode plugin registration array — npm spec OR file:// URL OR relative path OR [spec, options] tuple. */
  plugin?: Array<string | [string, Record<string, unknown>]>;
  [key: string]: unknown;
}

/** Path of the generated plugin shim file relative to opencode.json. */
const OPENCODE_PLUGIN_REL_PATH = "./plugins/failproofai.mjs";

/** Returns the absolute path of the plugin shim, given the opencode.json settings path. */
function opencodePluginFilePath(settingsPath: string): string {
  return resolve(dirname(settingsPath), "plugins", "failproofai.mjs");
}

/**
 * Generate the plugin shim source. Embeds a binary command so the shim is
 * self-contained — it doesn't need to resolve `failproofai` at runtime.
 *   • project scope: spawn `npx -y failproofai` (portable across machines)
 *   • user scope: spawn the absolute binary path (avoids npm round-trip on
 *     every tool call — failproofai's hooks are hot-path)
 */
function buildOpenCodePluginShim(binaryPath: string, scope: HookScope): string {
  const useNpx = scope === "project";
  // For project scope, do NOT embed the installer's absolute binary path —
  // it's machine-specific (changes between dev boxes / CI / production
  // installs). The shim only uses FAILPROOFAI_BIN when USE_NPX is false,
  // so an empty string is safe.
  const escapedBin = useNpx ? '""' : JSON.stringify(binaryPath);
  return `// AUTO-GENERATED by failproofai. ${FAILPROOFAI_HOOK_MARKER}
// Re-generate via: failproofai policies --install --cli opencode
// Plugin shim that bridges OpenCode's plugin API to the failproofai binary.
// See: https://opencode.ai/docs/plugins/
import { spawnSync } from "node:child_process";

// Map opencode bus-event types → canonical failproofai event names.
// (The binary sees PascalCase — the binary's --cli=opencode flag is for
// telemetry / activity tagging only; no opencode branch in handler.ts.)
const BUS_EVENT_MAP = {
  "session.created": "SessionStart",
  "session.deleted": "SessionEnd",
  "session.idle":    "Stop",
  // message.updated is handled separately (filter to role:user); see below.
};

// Map opencode lowercase tool IDs (\`input.tool\`) → Claude PascalCase canonical
// names. Builtin failproofai policies match on PascalCase via case-sensitive
// \`Array.includes\`, so without this every Bash/Read/Write/Edit builtin
// silently no-ops under opencode. Keep in sync with OPENCODE_TOOL_MAP in
// failproofai/src/hooks/types.ts (this shim is loaded in-process by opencode
// and must be self-contained — no imports from the failproofai package).
// Unknown tools pass through unchanged via \`?? raw\`.
const TOOL_NAME_MAP = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  glob: "Glob",
  grep: "Grep",
  list: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
};
function canonicalizeTool(raw) {
  if (!raw) return raw;
  return TOOL_NAME_MAP[raw] != null ? TOOL_NAME_MAP[raw] : raw;
}

// Per-tool input-key translation: opencode native tools deliver args as
// camelCase (\`filePath\`, \`oldString\`, …) but failproofai builtin policies
// (\`block-read-outside-cwd\`, \`block-env-files\`, \`block-secrets-write\`)
// read \`ctx.toolInput.file_path\` etc. Without this map every Read/Write/Edit
// path-check silently no-ops on opencode. Keys are PascalCase canonical tool
// names so the lookup pairs with canonicalizeTool's output. Tools outside the
// map (MCP \`mcp_*\`, plugins) pass through unchanged. Keep in sync with
// OPENCODE_TOOL_INPUT_MAP in failproofai/src/hooks/types.ts.
const TOOL_INPUT_MAP = {
  Read: { filePath: "file_path" },
  Write: { filePath: "file_path" },
  Edit: { filePath: "file_path", oldString: "old_string", newString: "new_string", replaceAll: "replace_all" },
};
function canonicalizeToolInput(canonicalToolName, args) {
  if (!args || typeof args !== "object") return args;
  const map = TOOL_INPUT_MAP[canonicalToolName];
  if (!map) return args;
  const out = {};
  for (const k of Object.keys(args)) out[map[k] != null ? map[k] : k] = args[k];
  return out;
}

const FAILPROOFAI_BIN = ${escapedBin};
const USE_NPX = ${useNpx};

function runFailproofai(eventName, payload, directory) {
  const cmd = USE_NPX ? "npx" : FAILPROOFAI_BIN;
  const args = USE_NPX
    ? ["-y", "failproofai", "--hook", eventName, "--cli", "opencode"]
    : ["--hook", eventName, "--cli", "opencode"];
  const r = spawnSync(cmd, args, {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 60_000,
    cwd: directory,
  });
  return { exitCode: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function applyDecision(result, ctx, eventName) {
  // Deny path 1: exit 2 (Claude Stop-style or any non-Pre/Post deny).
  if (result.exitCode === 2) {
    throw new Error((result.stderr || "").trim() || "Blocked by failproofai");
  }
  // Deny path 2: stdout JSON with hookSpecificOutput.permissionDecision === "deny".
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* fail-open allow */ }
  if (!parsed) return;
  const out = parsed.hookSpecificOutput;
  if (out && out.permissionDecision === "deny") {
    throw new Error(out.permissionDecisionReason || "Blocked by failproofai");
  }
  // Codex-shape PermissionRequest deny: hookSpecificOutput.decision.behavior.
  if (out && out.decision && out.decision.behavior === "deny") {
    throw new Error((out.decision.message) || "Blocked by failproofai");
  }
  // Forward additional context as a prompt to the session. For Stop /
  // SubagentStop the prompt is the only force-retry channel (session.idle
  // already fired), so AWAIT to ensure the SDK round-trip completes before
  // the plugin handler returns. For tool events keep fire-and-forget so we
  // don't add latency to every tool call.
  const ctxText = out && out.additionalContext;
  if (ctxText && ctx && ctx.client && ctx.sessionID) {
    const prompt = ctx.client.session.prompt({
      path: { id: ctx.sessionID },
      body: { parts: [{ type: "text", text: ctxText }] },
    });
    if (eventName === "Stop" || eventName === "SubagentStop") {
      try { await prompt; } catch { /* swallow — agent is exiting anyway */ }
    } else {
      Promise.resolve(prompt).catch(() => {});
    }
  }
}

export default async function failproofaiPlugin({ client, directory }) {
  return {
    // Generic bus events: session lifecycle + user-prompt detection.
    event: async ({ event }) => {
      if (!event || !event.type) return;

      // UserPromptSubmit — filter message.updated to user role only so we
      // don't fire on every assistant token. Forward the prompt text so
      // prompt-based policies (sanitize-* on input, content checks) see it.
      if (event.type === "message.updated") {
        const props = event.properties || {};
        const info = props.info || props.message || {};
        const role = info.role || props.role;
        if (role !== "user") return;
        const sessionID = info.sessionID || info.sessionId || info.session_id || props.sessionID;
        // OpenCode's message shape: parts is an array of {type, text, ...}.
        // Concatenate text parts to reconstruct the user-facing prompt.
        // Fall back to direct text/content fields if a future shape differs.
        let prompt = "";
        const parts = info.parts || props.parts || [];
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p && typeof p === "object" && typeof p.text === "string") prompt += p.text;
          }
        }
        if (!prompt) prompt = (info.text || info.content || props.text || "").toString();
        const r = runFailproofai("UserPromptSubmit", {
          session_id: sessionID, cwd: directory, hook_event_name: "UserPromptSubmit", prompt,
        }, directory);
        await applyDecision(r, { client, sessionID }, "UserPromptSubmit");
        return;
      }

      const claudeEvent = BUS_EVENT_MAP[event.type];
      if (!claudeEvent) return;
      const props = event.properties || {};
      const sessionID = props.sessionID || (props.session && props.session.id) || props.id;
      const r = runFailproofai(claudeEvent, {
        session_id: sessionID, cwd: directory, hook_event_name: claudeEvent,
      }, directory);
      await applyDecision(r, { client, sessionID }, claudeEvent);
    },

    // First-class PreToolUse hook. Note: tool args live on output.args (mutable).
    "tool.execute.before": async (input, output) => {
      const canonicalTool = canonicalizeTool(input.tool);
      const r = runFailproofai("PreToolUse", {
        session_id: input.sessionID,
        cwd: directory,
        tool_name: canonicalTool,
        tool_input: canonicalizeToolInput(canonicalTool, output.args),
        hook_event_name: "PreToolUse",
      }, directory);
      await applyDecision(r, { client, sessionID: input.sessionID }, "PreToolUse");
    },

    // First-class PostToolUse hook. Note: tool args live on input.args here.
    "tool.execute.after": async (input, output) => {
      const canonicalTool = canonicalizeTool(input.tool);
      const r = runFailproofai("PostToolUse", {
        session_id: input.sessionID,
        cwd: directory,
        tool_name: canonicalTool,
        tool_input: canonicalizeToolInput(canonicalTool, input.args),
        tool_response: { title: output.title, output: output.output, metadata: output.metadata },
        hook_event_name: "PostToolUse",
      }, directory);
      await applyDecision(r, { client, sessionID: input.sessionID }, "PostToolUse");
    },

    // Cleaner deny UX for prompted tools — mutate output.status instead of throwing.
    "permission.ask": async (input, output) => {
      const canonicalTool = canonicalizeTool(input.tool);
      const r = runFailproofai("PermissionRequest", {
        session_id: input.sessionID,
        cwd: directory,
        tool_name: canonicalTool || input.command || "permission",
        tool_input: canonicalizeToolInput(canonicalTool, input),
        hook_event_name: "PermissionRequest",
      }, directory);
      try {
        await applyDecision(r, { client, sessionID: input.sessionID }, "PermissionRequest");
      } catch {
        output.status = "deny";
      }
    },
  };
}
`;
}

export const opencode: Integration = {
  id: "opencode",
  displayName: "OpenCode",
  scopes: OPENCODE_HOOK_SCOPES,
  eventTypes: OPENCODE_HOOK_EVENT_TYPES,

  getSettingsPath(scope, cwd) {
    const base = cwd ? resolve(cwd) : process.cwd();
    switch (scope) {
      case "user":
        return resolve(homedir(), ".config", "opencode", "opencode.json");
      case "project":
        return resolve(base, ".opencode", "opencode.json");
      case "local":
        // OpenCode has no "local" scope — fall back to project so callers don't crash.
        return resolve(base, ".opencode", "opencode.json");
    }
  },

  readSettings(settingsPath) {
    return readJsonFile(settingsPath);
  },

  writeSettings(settingsPath, settings) {
    writeJsonFile(settingsPath, settings);
  },

  /**
   * Returns the plugin entry that gets pushed into opencode.json's `plugin`
   * array. Project scope uses a relative path (resolved against the config
   * file's directory by opencode); user scope uses a `file://` URL with the
   * absolute path so it works regardless of the user's cwd at startup.
   */
  buildHookEntry(_binaryPath, _eventType, scope) {
    if (scope === "user") {
      const abs = resolve(homedir(), ".config", "opencode", "plugins", "failproofai.mjs");
      return { spec: `file://${abs}`, [FAILPROOFAI_HOOK_MARKER]: true };
    }
    return { spec: OPENCODE_PLUGIN_REL_PATH, [FAILPROOFAI_HOOK_MARKER]: true };
  },

  /** True if the array entry references our plugin filename. */
  isFailproofaiHook(hook) {
    if (typeof hook === "string") return hook.includes("failproofai.mjs");
    if (Array.isArray(hook)) return typeof hook[0] === "string" && hook[0].includes("failproofai.mjs");
    return false;
  },

  /**
   * Atomically install: (a) write the plugin shim file (overwrite is OK —
   * marker keeps user files safe in removeHooksFromFile); (b) merge our
   * plugin entry into opencode.json's `plugin` array.
   */
  writeHookEntries(settings, binaryPath, scope) {
    const s = settings as OpenCodeSettingsFile;
    const effectiveScope: HookScope = scope ?? "project";

    // Compute the settings path so we know where to drop the shim.
    // We can't introspect cwd from `settings` alone, so use the convention
    // that callers always pass settings read from the path they're about
    // to write back to. For user scope the homedir resolves; for project
    // scope we infer from process.cwd() — which matches the codepath in
    // hooksInstalledInSettings/getSettingsPath without a cwd arg.
    const settingsPath = effectiveScope === "user"
      ? resolve(homedir(), ".config", "opencode", "opencode.json")
      : resolve(process.cwd(), ".opencode", "opencode.json");
    const pluginPath = opencodePluginFilePath(settingsPath);

    // (a) Write the shim file. mkdirSync is recursive so the plugins/ dir
    // is created on first install.
    mkdirSync(dirname(pluginPath), { recursive: true });
    writeFileSync(pluginPath, buildOpenCodePluginShim(binaryPath, effectiveScope), "utf8");

    // (b) Merge our entry into the plugin array idempotently. Replace any
    // existing failproofai-marked entry; otherwise append.
    if (!Array.isArray(s.plugin)) s.plugin = [];
    const desired: string = effectiveScope === "user" ? `file://${pluginPath}` : OPENCODE_PLUGIN_REL_PATH;
    const idx = s.plugin.findIndex((entry) => this.isFailproofaiHook(entry));
    if (idx >= 0) {
      s.plugin[idx] = desired;
    } else {
      s.plugin.push(desired);
    }
  },

  /**
   * Uninstall: (a) remove our plugin entry from the array; if the array is
   * empty, delete the key. (b) Delete the plugin file ONLY if it has the
   * failproofai marker — never delete a hand-written plugin file at the
   * same path.
   */
  removeHooksFromFile(settingsPath) {
    let removed = 0;
    const settings = this.readSettings(settingsPath) as OpenCodeSettingsFile;
    if (Array.isArray(settings.plugin)) {
      const before = settings.plugin.length;
      settings.plugin = settings.plugin.filter((entry) => !this.isFailproofaiHook(entry));
      removed += before - settings.plugin.length;
      if (settings.plugin.length === 0) delete settings.plugin;
    }
    this.writeSettings(settingsPath, settings as Record<string, unknown>);

    const pluginPath = opencodePluginFilePath(settingsPath);
    if (existsSync(pluginPath)) {
      try {
        const content = readFileSync(pluginPath, "utf8");
        if (content.includes(FAILPROOFAI_HOOK_MARKER)) {
          unlinkSync(pluginPath);
          if (removed === 0) removed = 1; // file existed; treat as removed even if array was clean
        }
      } catch {
        // Best-effort cleanup; ignore read/unlink failures.
      }
    }
    return removed;
  },

  hooksInstalledInSettings(scope, cwd) {
    const settingsPath = this.getSettingsPath(scope, cwd);
    if (!existsSync(settingsPath)) return false;
    try {
      const settings = this.readSettings(settingsPath) as OpenCodeSettingsFile;
      if (!Array.isArray(settings.plugin)) return false;
      const hasEntry = settings.plugin.some((entry) => this.isFailproofaiHook(entry));
      if (!hasEntry) return false;
      const pluginPath = opencodePluginFilePath(settingsPath);
      if (!existsSync(pluginPath)) return false;
      const content = readFileSync(pluginPath, "utf8");
      return content.includes(FAILPROOFAI_HOOK_MARKER);
    } catch {
      return false;
    }
  },

  detectInstalled() {
    return binaryExists("opencode");
  },
};


// ── Pi (pi-coding-agent) integration ───────────────────────────────────────
//
// Pi loads TypeScript extension packages registered in `.pi/settings.json`.
// Schema (verified empirically against pi-coding-agent v0.72.1):
//
//   {"packages": ["./relative/path", "/abs/path", "npm:@scope/name"]}
//
// Entries are PLAIN STRINGS — there's no per-entry object where the
// FAILPROOFAI_HOOK_MARKER could live. We identify failproofai's entry by a
// path-substring match (`includes("pi-extension") && includes("failproofai")`).
//
// Path semantics: a relative entry like `../pi-extension` is resolved relative
// to the directory containing settings.json (i.e. `<cwd>/.pi/`). For dogfood
// where the extension lives at `<cwd>/pi-extension/`, the correct entry is
// `"../pi-extension"`. For user-scope global installs where failproofai lives
// in the npm global root, we write the absolute path.
//
// Settings file paths (verified — `~/.pi/settings.json` does NOT exist on a
// fresh install; user-scope is under `~/.pi/agent/`):
//   user    → ~/.pi/agent/settings.json
//   project → <cwd>/.pi/settings.json
//
// Pi events arrive as `tool_call` / `user_bash` / `input` / `session_start`
// (underscore_lower_snake_case); handler.ts canonicalizes via PI_EVENT_MAP.
// Tool-call payloads use camelCase: `event.toolName`, `event.input`,
// `event.toolCallId`. `tool_call` handlers can `return { block: true, reason }`
// to veto the tool call — this is how PreToolUse deny is enforced.
//
// Detected via the `pi` binary on PATH.

interface PiSettingsFile {
  packages?: string[];
  [key: string]: unknown;
}

/** Returns the absolute path to the failproofai-shipped Pi extension package. */
function getPiExtensionPath(): string {
  // Resolve relative to the installed failproofai package root, falling back
  // to FAILPROOFAI_PACKAGE_ROOT (set by bin/failproofai.mjs) for dev mode.
  const fromEnv = process.env.FAILPROOFAI_PACKAGE_ROOT;
  if (fromEnv) return resolve(fromEnv, "pi-extension");
  // Fallback: walk up from this file (src/hooks/integrations.ts) two levels.
  return resolve(fileURLToPath(import.meta.url), "..", "..", "..", "pi-extension");
}

/** True iff a Pi packages-array entry was written by failproofai. */
function isFailproofaiPiEntry(source: unknown): boolean {
  if (typeof source !== "string") return false;
  // Project-scope writes a relative `../pi-extension` (or similar) — these
  // must be detected as ours so reinstall/uninstall/hooksInstalledInSettings
  // don't double-write or leak entries.
  if (/(?:^|\/)pi-extension\/?$/.test(source)) return true;
  // Absolute / scoped forms include "failproofai" somewhere in the path
  // (the canonical `<failproofai-install>/pi-extension/` and a future
  // `@failproofai/pi-extension` npm scope both qualify).
  return source.includes("pi-extension") && source.includes("failproofai");
}

export const pi: Integration = {
  id: "pi",
  displayName: "Pi",
  scopes: PI_HOOK_SCOPES,
  eventTypes: PI_HOOK_EVENT_TYPES,

  getSettingsPath(scope, cwd) {
    const base = cwd ? resolve(cwd) : process.cwd();
    switch (scope) {
      case "user":
        return resolve(homedir(), ".pi", "agent", "settings.json");
      case "project":
        return resolve(base, ".pi", "settings.json");
      case "local":
        // Pi has no "local" scope; CLI rejects --cli pi --scope local before
        // reaching here, but fall back to project so callers don't crash.
        return resolve(base, ".pi", "settings.json");
    }
  },

  readSettings(settingsPath) {
    return readJsonFile(settingsPath);
  },

  writeSettings(settingsPath, settings) {
    writeJsonFile(settingsPath, settings);
  },

  buildHookEntry(_binaryPath, _eventType, scope) {
    // Pi registers extensions at the package level — one entry covers all
    // events. The package's index.ts wires the four pi.on(...) handlers.
    // The "entry" returned here is a sentinel object so the Integration
    // interface's typing is satisfied; writeHookEntries resolves the actual
    // string entry below.
    return {
      [FAILPROOFAI_HOOK_MARKER]: true,
      _piPackagePath: getPiExtensionPath(),
      _piScope: scope,
    };
  },

  isFailproofaiHook(hook) {
    // Real on-disk entries are plain strings (a packages array entry).
    if (typeof hook === "string") return isFailproofaiPiEntry(hook);
    if (!hook || typeof hook !== "object") return false;
    const h = hook as Record<string, unknown>;
    if (h[FAILPROOFAI_HOOK_MARKER] === true) return true;
    // Test fixtures sometimes pass a wrapper `{source: "..."}`; preserve that shape.
    if (typeof h.source === "string") return isFailproofaiPiEntry(h.source);
    return false;
  },

  writeHookEntries(settings, _binaryPath, scope) {
    const s = settings as PiSettingsFile;
    if (!Array.isArray(s.packages)) s.packages = [];

    const extPath = getPiExtensionPath();
    // Project-scope writes a relative path (resolved by Pi at load time
    // against `<cwd>/.pi/`) so a committed `.pi/settings.json` is portable
    // across contributors. User-scope writes an absolute path because each
    // user's failproofai install has its own absolute location.
    const entry = scope === "project"
      ? makePiProjectRelativeEntry(extPath)
      : extPath;

    // Idempotent: replace any existing failproofai entry, otherwise append.
    const idx = s.packages.findIndex((p) => isFailproofaiPiEntry(p));
    if (idx >= 0) {
      s.packages[idx] = entry;
    } else {
      s.packages.push(entry);
    }
  },

  removeHooksFromFile(settingsPath) {
    if (!existsSync(settingsPath)) return 0;
    const settings = this.readSettings(settingsPath) as PiSettingsFile;
    if (!Array.isArray(settings.packages)) return 0;

    const before = settings.packages.length;
    settings.packages = settings.packages.filter((p) => !isFailproofaiPiEntry(p));
    const removed = before - settings.packages.length;

    if (settings.packages.length === 0) delete settings.packages;
    this.writeSettings(settingsPath, settings as Record<string, unknown>);
    return removed;
  },

  hooksInstalledInSettings(scope, cwd) {
    const settingsPath = this.getSettingsPath(scope, cwd);
    if (!existsSync(settingsPath)) return false;
    try {
      const settings = this.readSettings(settingsPath) as PiSettingsFile;
      if (!Array.isArray(settings.packages)) return false;
      return settings.packages.some((p) => isFailproofaiPiEntry(p));
    } catch {
      // Corrupt settings — treat as not installed
      return false;
    }
  },

  detectInstalled() {
    return binaryExists("pi");
  },
};

/**
 * Compute a relative path from `<settings.json's parent>` to the extension
 * directory, so the entry is portable across contributors who clone the repo
 * to different absolute paths.
 *
 * For project scope, settings.json lives at `<cwd>/.pi/settings.json`, and
 * the extension at `<cwd>/pi-extension/`. The relative path Pi expects
 * (resolved against `<cwd>/.pi/`) is `../pi-extension`.
 *
 * If the extension path is not under the project root (e.g. failproofai is
 * installed globally and being written to a project), falls back to the
 * absolute path so resolution still works on this machine.
 */
function makePiProjectRelativeEntry(extPath: string): string {
  const cwd = process.cwd();
  const cwdResolved = resolve(cwd);
  const extResolved = resolve(extPath);
  if (extResolved.startsWith(cwdResolved + "/") || extResolved === cwdResolved) {
    // Walk back up from <cwd>/.pi/ to <cwd>/, then forward to the extension.
    const fromSettingsDir = "../" + extResolved.slice(cwdResolved.length + 1);
    return fromSettingsDir;
  }
  // Extension lives outside the project — keep it absolute. Not portable, but
  // works for the local user.
  return extResolved;
}
// ── Hermes (hermes-agent) — live hooks (Pillar 1) ────────────────────────────
//
// External-command CLI like codex/cursor, but its config is YAML
// (`~/.hermes/config.yaml`) under a `hooks:` map, so the I/O layer uses the yaml
// Document API (comment-preserving). Flat per-event arrays like cursor:
// `hooks: { pre_tool_call: [ { command, timeout, <marker> } ], … }`. Hermes
// reads a `{"decision":"block",…}` JSON response on stdout (see
// policy-evaluator.ts); exit codes are ignored. User-scope only.

/** One hook entry as stored under a `hooks:` event key in config.yaml. */
interface HermesHookEntry {
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

export const hermes: Integration = {
  id: "hermes",
  displayName: "Hermes",
  scopes: HERMES_HOOK_SCOPES,
  eventTypes: HERMES_HOOK_EVENT_TYPES,

  // Hermes config is USER-scope only (`~/.hermes/config.yaml`); there is no
  // project/local file, so scope/cwd are irrelevant here.
  getSettingsPath() {
    return resolve(homedir(), ".hermes", "config.yaml");
  },

  readSettings(settingsPath) {
    // Return the yaml Document (cast) so writeHookEntries/writeSettings can
    // round-trip it while preserving the user's other keys + comments.
    return readYamlDoc(settingsPath) as unknown as Record<string, unknown>;
  },

  writeSettings(settingsPath, settings) {
    writeYamlDoc(settingsPath, settings as unknown as Document);
  },

  buildHookEntry(binaryPath, eventType, scope) {
    // No matcher → fires for ALL tools / all platforms (slack/telegram/cli/cron)
    // and internal subagents. `timeout` is in seconds; Hermes runs the command
    // via shlex.split (shell=false).
    const command =
      scope === "project"
        ? `npx -y failproofai --hook ${eventType} --cli hermes`
        : `"${binaryPath}" --hook ${eventType} --cli hermes`;
    return {
      command,
      timeout: 30,
      [FAILPROOFAI_HOOK_MARKER]: true,
    };
  },

  isFailproofaiHook: isMarkedHook,

  writeHookEntries(settings, binaryPath, scope) {
    const doc = settings as unknown as Document;
    // Read the current hooks map as plain JS, then re-set ONLY the `hooks` key —
    // preserving comments on every other part of config.yaml.
    const js = (doc.toJS() ?? {}) as { hooks?: Record<string, HermesHookEntry[]> };
    const hooks: Record<string, HermesHookEntry[]> =
      js.hooks && typeof js.hooks === "object" ? js.hooks : {};

    for (const eventType of HERMES_HOOK_EVENT_TYPES) {
      const entry = this.buildHookEntry(binaryPath, eventType, scope) as unknown as HermesHookEntry;
      const arr = Array.isArray(hooks[eventType]) ? hooks[eventType] : [];
      const idx = arr.findIndex((h) => isMarkedHook(h));
      if (idx >= 0) arr[idx] = entry;
      else arr.push(entry);
      hooks[eventType] = arr;
    }
    doc.set("hooks", hooks);
    // The headless gateway has no TTY to answer Hermes's first-use hook-consent
    // prompt, so auto-accept declared hooks. Tradeoff: also auto-accepts any
    // other hook the operator adds; a targeted `shell-hooks-allowlist.json`
    // pre-seed is a future refinement.
    doc.set("hooks_auto_accept", true);
  },

  removeHooksFromFile(settingsPath) {
    if (!existsSync(settingsPath)) return 0;
    const doc = readYamlDoc(settingsPath);
    const js = (doc.toJS() ?? {}) as { hooks?: Record<string, HermesHookEntry[]> };
    const hooks = js.hooks;

    let removed = 0;
    if (hooks && typeof hooks === "object") {
      for (const eventType of Object.keys(hooks)) {
        const entries = hooks[eventType];
        if (!Array.isArray(entries)) continue;
        const before = entries.length;
        const filtered = entries.filter((h) => !isMarkedHook(h));
        removed += before - filtered.length;
        if (filtered.length === 0) delete hooks[eventType];
        else hooks[eventType] = filtered;
      }
      if (removed > 0) {
        if (Object.keys(hooks).length === 0) doc.delete("hooks");
        else doc.set("hooks", hooks);
      }
    }

    // Always drop our headless-consent flag on uninstall — even if the hooks were
    // already removed manually — so it can't silently auto-accept future operator
    // hooks. `doc.delete` returns true iff the key was present.
    const droppedAutoAccept = doc.delete("hooks_auto_accept");
    if (removed > 0 || droppedAutoAccept) writeYamlDoc(settingsPath, doc);
    return removed;
  },

  hooksInstalledInSettings(scope, cwd) {
    const settingsPath = this.getSettingsPath(scope, cwd);
    if (!existsSync(settingsPath)) return false;
    try {
      const doc = readYamlDoc(settingsPath);
      const js = (doc.toJS() ?? {}) as { hooks?: Record<string, HermesHookEntry[]> };
      const hooks = js.hooks;
      if (!hooks || typeof hooks !== "object") return false;
      for (const entries of Object.values(hooks)) {
        if (Array.isArray(entries) && entries.some((h) => isMarkedHook(h))) return true;
      }
    } catch {
      // Corrupt config — treat as not installed.
    }
    return false;
  },

  detectInstalled() {
    return binaryExists("hermes");
  },
};

// ── OpenClaw integration ────────────────────────────────────────────────────
//
// OpenClaw is a self-hosted assistant gateway. Enforcement is via its in-process
// PLUGIN hooks (file-based "internal hooks" are observation-only), so failproofai
// ships a static plugin package (`openclaw-plugin/`, like Pi's pi-extension) that
// async-spawns the binary and maps verdicts back. Install registers the plugin in
// `~/.openclaw/openclaw.json` (JSON):
//   • plugins.load.paths[]  → the shipped openclaw-plugin dir (absolute path)
//   • plugins.entries.failproofai = { enabled: true, hooks: { allowConversationAccess: true } }
//     (allowConversationAccess is required for the raw-conversation hooks
//      before_agent_run / before_agent_finalize; verified live v2026.7.1).
// USER scope only — OpenClaw has no project config (workspace plugins are
// disabled by default). We NEVER delete the shipped plugin dir on uninstall
// (unlike OpenCode's generated shim) — uninstall only edits openclaw.json.
// Detected via the `openclaw` binary on PATH.

const OPENCLAW_PLUGIN_ID = "failproofai";

interface OpenClawPluginsSection {
  load?: { paths?: string[]; [k: string]: unknown };
  entries?: Record<string, Record<string, unknown>>;
  allow?: string[];
  deny?: string[];
  [k: string]: unknown;
}
interface OpenClawSettingsFile {
  plugins?: OpenClawPluginsSection;
  [k: string]: unknown;
}

/** Absolute path to the failproofai-shipped OpenClaw plugin package. */
function getOpenClawPluginPath(): string {
  const fromEnv = process.env.FAILPROOFAI_PACKAGE_ROOT;
  if (fromEnv) return resolve(fromEnv, "openclaw-plugin");
  return resolve(fileURLToPath(import.meta.url), "..", "..", "..", "openclaw-plugin");
}

/** True iff a plugins.load.paths entry was written by failproofai. */
function isFailproofaiOpenClawPath(p: unknown): boolean {
  if (typeof p !== "string") return false;
  return /(?:^|\/)openclaw-plugin\/?$/.test(p) || (p.includes("openclaw-plugin") && p.includes("failproofai"));
}

export const openclaw: Integration = {
  id: "openclaw",
  displayName: "OpenClaw",
  scopes: OPENCLAW_HOOK_SCOPES,
  eventTypes: OPENCLAW_HOOK_EVENT_TYPES,

  // USER scope only (~/.openclaw/openclaw.json); OpenClaw has no project config.
  getSettingsPath() {
    return resolve(homedir(), ".openclaw", "openclaw.json");
  },

  readSettings(settingsPath) {
    return readJsonFile(settingsPath);
  },

  writeSettings(settingsPath, settings) {
    writeJsonFile(settingsPath, settings);
  },

  buildHookEntry() {
    // OpenClaw registers plugins at the package level — one registration covers
    // all hooks (the plugin's index.js wires every api.on(...) handler). This
    // sentinel satisfies the interface; writeHookEntries does the real work.
    return {
      [FAILPROOFAI_HOOK_MARKER]: true,
      _openclawPluginPath: getOpenClawPluginPath(),
    };
  },

  isFailproofaiHook(hook) {
    if (typeof hook === "string") return isFailproofaiOpenClawPath(hook);
    if (!hook || typeof hook !== "object") return false;
    const h = hook as Record<string, unknown>;
    if (h[FAILPROOFAI_HOOK_MARKER] === true) return true;
    if (typeof h.source === "string") return isFailproofaiOpenClawPath(h.source);
    return false;
  },

  writeHookEntries(settings) {
    const s = settings as OpenClawSettingsFile;
    const plugins = (s.plugins ??= {});
    const load = (plugins.load ??= {});
    if (!Array.isArray(load.paths)) load.paths = [];
    const dir = getOpenClawPluginPath();
    // Idempotent: replace any existing failproofai path, otherwise append.
    const idx = load.paths.findIndex((p) => isFailproofaiOpenClawPath(p));
    if (idx >= 0) load.paths[idx] = dir;
    else load.paths.push(dir);

    // Enable the plugin + grant conversation access (needed for before_agent_run
    // / before_agent_finalize). Only set our own keys — operator config on this
    // entry (e.g. hooks.timeouts.<hookName>) and other entries are preserved.
    const entries = (plugins.entries ??= {});
    const entry = (entries[OPENCLAW_PLUGIN_ID] ??= {});
    entry.enabled = true;
    const hooks = ((entry.hooks as Record<string, unknown>) ??= {});
    hooks.allowConversationAccess = true;
  },

  removeHooksFromFile(settingsPath) {
    if (!existsSync(settingsPath)) return 0;
    const settings = this.readSettings(settingsPath) as OpenClawSettingsFile;
    const plugins = settings.plugins;
    if (!plugins) return 0;
    let removed = 0;

    if (Array.isArray(plugins.load?.paths)) {
      const before = plugins.load.paths.length;
      plugins.load.paths = plugins.load.paths.filter((p) => !isFailproofaiOpenClawPath(p));
      removed += before - plugins.load.paths.length;
      if (plugins.load.paths.length === 0) delete plugins.load.paths;
      if (plugins.load && Object.keys(plugins.load).length === 0) delete plugins.load;
    }
    if (plugins.entries && OPENCLAW_PLUGIN_ID in plugins.entries) {
      delete plugins.entries[OPENCLAW_PLUGIN_ID];
      removed += 1;
      if (Object.keys(plugins.entries).length === 0) delete plugins.entries;
    }
    // Prune an empty plugins object so uninstall leaves openclaw.json clean.
    if (Object.keys(plugins).length === 0) delete settings.plugins;

    this.writeSettings(settingsPath, settings as Record<string, unknown>);
    return removed;
  },

  hooksInstalledInSettings(scope, cwd) {
    const settingsPath = this.getSettingsPath(scope, cwd);
    if (!existsSync(settingsPath)) return false;
    try {
      const settings = this.readSettings(settingsPath) as OpenClawSettingsFile;
      const paths = settings.plugins?.load?.paths;
      const pathPresent = Array.isArray(paths) && paths.some((p) => isFailproofaiOpenClawPath(p));
      const entryEnabled = settings.plugins?.entries?.[OPENCLAW_PLUGIN_ID]?.enabled === true;
      return pathPresent && entryEnabled;
    } catch {
      return false;
    }
  },

  detectInstalled() {
    return binaryExists("openclaw");
  },
};

// ── Factory Droid (droid) integration ───────────────────────────────────────
//
// Factory's droid CLI uses a Claude-compatible external-command hook system,
// but its hooks.json puts event names at the TOP LEVEL — there is NO `"hooks"`
// wrapper (the file IS the events object). Verified live against droid
// v0.171.0: a `{"hooks":{…}}` wrapper is rejected with `WARN Ignoring unknown
// hook event keys keys:["hooks"]`. Tool events (PreToolUse / PostToolUse) carry
// `"matcher": "*"`; non-tool events omit the matcher. Deny is exit-2 + stderr
// (see policy-evaluator.ts). Event names are already PascalCase, so no event
// canonicalization is needed. Settings paths: ~/.factory/hooks.json (user) and
// <cwd>/.factory/hooks.json (project); no "local" scope.

interface FactoryHookMatcher {
  matcher?: string;
  hooks: Array<ClaudeHookEntry | Record<string, unknown>>;
}

/** The Factory settings file IS the top-level events map (no wrapper key). */
type FactorySettingsFile = Record<string, FactoryHookMatcher[] | unknown>;

export const factory: Integration = {
  id: "factory",
  displayName: "Factory Droid",
  scopes: FACTORY_HOOK_SCOPES,
  eventTypes: FACTORY_HOOK_EVENT_TYPES,

  getSettingsPath(scope, cwd) {
    const base = cwd ? resolve(cwd) : process.cwd();
    switch (scope) {
      case "user":
        return resolve(homedir(), ".factory", "hooks.json");
      case "project":
        return resolve(base, ".factory", "hooks.json");
      case "local":
        // Factory has no "local" scope; the CLI rejects --cli factory --scope
        // local before reaching here, but fall back to project so callers don't
        // crash.
        return resolve(base, ".factory", "hooks.json");
    }
  },

  readSettings(settingsPath) {
    return readJsonFile(settingsPath);
  },

  writeSettings(settingsPath, settings) {
    writeJsonFile(settingsPath, settings);
  },

  buildHookEntry(binaryPath, eventType, scope) {
    const command =
      scope === "project"
        ? `npx -y failproofai --hook ${eventType} --cli factory`
        : `"${binaryPath}" --hook ${eventType} --cli factory`;
    return {
      type: "command",
      command,
      // droid reads `timeout` in SECONDS (verified against droid v0.171.0). 30s.
      timeout: 30,
      [FAILPROOFAI_HOOK_MARKER]: true,
    };
  },

  isFailproofaiHook: isMarkedHook,

  writeHookEntries(settings, binaryPath, scope) {
    const s = settings as Record<string, FactoryHookMatcher[]>;

    for (const eventType of FACTORY_HOOK_EVENT_TYPES) {
      const hookEntry = this.buildHookEntry(binaryPath, eventType, scope) as unknown as ClaudeHookEntry;
      if (!Array.isArray(s[eventType])) s[eventType] = [];
      const matchers: FactoryHookMatcher[] = s[eventType];

      let found = false;
      for (const matcher of matchers) {
        if (!matcher.hooks) continue;
        const idx = matcher.hooks.findIndex((h) => isMarkedHook(h as Record<string, unknown>));
        if (idx >= 0) {
          matcher.hooks[idx] = hookEntry;
          found = true;
          break;
        }
      }
      if (!found) {
        // Tool events match all tools via `matcher: "*"`; non-tool events carry
        // no matcher (verified live against droid v0.171.0).
        const isToolEvent = eventType === "PreToolUse" || eventType === "PostToolUse";
        matchers.push(isToolEvent ? { matcher: "*", hooks: [hookEntry] } : { hooks: [hookEntry] });
      }
    }
  },

  removeHooksFromFile(settingsPath) {
    const settings = this.readSettings(settingsPath) as FactorySettingsFile;

    let removed = 0;
    for (const eventType of Object.keys(settings)) {
      const matchers = settings[eventType];
      if (!Array.isArray(matchers)) continue;
      for (let i = matchers.length - 1; i >= 0; i--) {
        const matcher = matchers[i] as FactoryHookMatcher;
        if (!matcher || !matcher.hooks) continue;
        const before = matcher.hooks.length;
        matcher.hooks = matcher.hooks.filter((h) => !isMarkedHook(h as Record<string, unknown>));
        removed += before - matcher.hooks.length;
        if (matcher.hooks.length === 0) matchers.splice(i, 1);
      }
      if (matchers.length === 0) delete settings[eventType];
    }

    this.writeSettings(settingsPath, settings as Record<string, unknown>);
    return removed;
  },

  hooksInstalledInSettings(scope, cwd) {
    const settingsPath = this.getSettingsPath(scope, cwd);
    if (!existsSync(settingsPath)) return false;
    try {
      const settings = this.readSettings(settingsPath) as FactorySettingsFile;
      for (const matchers of Object.values(settings)) {
        if (!Array.isArray(matchers)) continue;
        for (const matcher of matchers as FactoryHookMatcher[]) {
          if (!matcher || !matcher.hooks) continue;
          if (matcher.hooks.some((h) => isMarkedHook(h as Record<string, unknown>))) return true;
        }
      }
    } catch {
      // Corrupt settings — treat as not installed
    }
    return false;
  },

  detectInstalled() {
    return binaryExists("droid");
  },
};

// ── Devin CLI (devin) integration ────────────────────────────────────────────
//
// Devin's CLI (Cognition) is a **pure Claude-clone** external-command hook
// system, verified live against devin v3000.1.27. It uses the standard Claude
// `"hooks"`-wrapper schema, so this Integration mirrors `claudeCode` verbatim —
// only the settings paths and the `--cli devin` command flag differ. The
// config file also carries the operator's own keys (`org_id`, `theme_mode`,
// …), so readSettings/writeSettings use the merge-preserving JSON helpers.
//
// Settings paths (verified against devin v3000.1.27):
//   user    → ~/.config/devin/config.json  (the `"hooks"` key)
//   project → <cwd>/.devin/config.json      (the `"hooks"` key)
// No "local" scope. Event names are already PascalCase (no event map / no
// handler branch); the stdin payload is Claude snake_case (no normalization).
// Deny/instruct semantics live in policy-evaluator.ts's `cli === "devin"`
// branch (`{decision:"block", reason}` on stdout at exit 0).

export const devin: Integration = {
  id: "devin",
  displayName: "Devin CLI",
  scopes: DEVIN_HOOK_SCOPES,
  eventTypes: DEVIN_HOOK_EVENT_TYPES,

  getSettingsPath(scope, cwd) {
    const base = cwd ? resolve(cwd) : process.cwd();
    switch (scope) {
      case "user":
        return resolve(homedir(), ".config", "devin", "config.json");
      case "project":
        return resolve(base, ".devin", "config.json");
      case "local":
        // Devin has no "local" scope; the CLI rejects --cli devin --scope local
        // before reaching here, but fall back to project so callers don't crash.
        return resolve(base, ".devin", "config.json");
    }
  },

  readSettings(settingsPath) {
    return readJsonFile(settingsPath);
  },

  writeSettings(settingsPath, settings) {
    writeJsonFile(settingsPath, settings);
  },

  buildHookEntry(binaryPath, eventType, scope) {
    const command =
      scope === "project"
        ? `npx -y failproofai --hook ${eventType} --cli devin`
        : `"${binaryPath}" --hook ${eventType} --cli devin`;
    return {
      type: "command",
      command,
      // Devin reads `timeout` in SECONDS like Claude. 60 = 60s.
      timeout: 60,
      [FAILPROOFAI_HOOK_MARKER]: true,
    };
  },

  isFailproofaiHook: isMarkedHook,

  writeHookEntries(settings, binaryPath, scope) {
    const s = settings as ClaudeSettings;
    if (!s.hooks) s.hooks = {};

    for (const eventType of DEVIN_HOOK_EVENT_TYPES) {
      const hookEntry = this.buildHookEntry(binaryPath, eventType, scope) as unknown as ClaudeHookEntry;
      if (!s.hooks[eventType]) s.hooks[eventType] = [];
      const matchers: ClaudeHookMatcher[] = s.hooks[eventType];

      let found = false;
      for (const matcher of matchers) {
        if (!matcher.hooks) continue;
        const idx = matcher.hooks.findIndex((h) => isMarkedHook(h as Record<string, unknown>));
        if (idx >= 0) {
          matcher.hooks[idx] = hookEntry;
          found = true;
          break;
        }
      }
      if (!found) matchers.push({ hooks: [hookEntry] });
    }
  },

  removeHooksFromFile(settingsPath) {
    const settings = this.readSettings(settingsPath) as ClaudeSettings;
    if (!settings.hooks) return 0;

    let removed = 0;
    for (const eventType of Object.keys(settings.hooks)) {
      const matchers = settings.hooks[eventType];
      if (!Array.isArray(matchers)) continue;
      for (let i = matchers.length - 1; i >= 0; i--) {
        const matcher = matchers[i];
        if (!matcher.hooks) continue;
        const before = matcher.hooks.length;
        matcher.hooks = matcher.hooks.filter((h) => !isMarkedHook(h as Record<string, unknown>));
        removed += before - matcher.hooks.length;
        if (matcher.hooks.length === 0) matchers.splice(i, 1);
      }
      if (matchers.length === 0) delete settings.hooks[eventType];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    this.writeSettings(settingsPath, settings as Record<string, unknown>);
    return removed;
  },

  hooksInstalledInSettings(scope, cwd) {
    const settingsPath = this.getSettingsPath(scope, cwd);
    if (!existsSync(settingsPath)) return false;
    try {
      const settings = this.readSettings(settingsPath) as ClaudeSettings;
      if (!settings.hooks) return false;
      for (const matchers of Object.values(settings.hooks)) {
        if (!Array.isArray(matchers)) continue;
        for (const matcher of matchers) {
          if (!matcher.hooks) continue;
          if (matcher.hooks.some((h) => isMarkedHook(h as Record<string, unknown>))) return true;
        }
      }
    } catch {
      // Corrupt settings — treat as not installed
    }
    return false;
  },

  detectInstalled() {
    return binaryExists("devin");
  },
};

// ── Antigravity CLI (antigravity) integration ────────────────────────────────
//
// Antigravity's `agy` CLI uses a NAMED-hook schema: the hooks.json top-level key
// is a hook *name* ("failproofai"), whose value is an event→handlers map. Tool
// events (PreToolUse / PostToolUse) wrap handlers in `{matcher, hooks:[…]}`;
// non-tool events (PreInvocation / Stop) are FLAT arrays of handler objects.
// Verified live against agy v1.1.2. Settings paths:
//   user    → ~/.gemini/config/hooks.json
//   project → <cwd>/.agents/hooks.json
// No "local" scope. Deny/instruct semantics live in policy-evaluator.ts's
// `cli === "antigravity"` branch (Antigravity's OWN `{decision:"deny"}` /
// `{decision:"continue"}` / `{injectSteps}` shapes — NOT Claude's).

/** The Antigravity settings file is `{ "<hookName>": { <event>: … } }`. Our
 *  named hook is "failproofai". */
const ANTIGRAVITY_HOOK_NAME = "failproofai";

interface AntigravityToolMatcher {
  matcher?: string;
  hooks: Array<ClaudeHookEntry | Record<string, unknown>>;
}
/** An Antigravity named-hook body: tool events → `{matcher, hooks}[]`; flat
 *  events (PreInvocation / Stop) → `handler[]`. */
type AntigravityNamedHook = Record<
  string,
  AntigravityToolMatcher[] | Array<ClaudeHookEntry | Record<string, unknown>>
>;

const ANTIGRAVITY_TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

export const antigravity: Integration = {
  id: "antigravity",
  displayName: "Antigravity CLI",
  scopes: ANTIGRAVITY_HOOK_SCOPES,
  eventTypes: ANTIGRAVITY_HOOK_EVENT_TYPES,

  getSettingsPath(scope, cwd) {
    const base = cwd ? resolve(cwd) : process.cwd();
    switch (scope) {
      case "user":
        return resolve(homedir(), ".gemini", "config", "hooks.json");
      case "project":
        return resolve(base, ".agents", "hooks.json");
      case "local":
        // Antigravity has no "local" scope; the CLI rejects it before reaching
        // here, but fall back to project so callers don't crash.
        return resolve(base, ".agents", "hooks.json");
    }
  },

  readSettings(settingsPath) {
    return readJsonFile(settingsPath);
  },

  writeSettings(settingsPath, settings) {
    writeJsonFile(settingsPath, settings);
  },

  buildHookEntry(binaryPath, eventType, scope) {
    const command =
      scope === "project"
        ? `npx -y failproofai --hook ${eventType} --cli antigravity`
        : `"${binaryPath}" --hook ${eventType} --cli antigravity`;
    return {
      type: "command",
      command,
      // Antigravity reads `timeout` in SECONDS (verified agy v1.1.2). 30s.
      timeout: 30,
      [FAILPROOFAI_HOOK_MARKER]: true,
    };
  },

  isFailproofaiHook: isMarkedHook,

  writeHookEntries(settings, binaryPath, scope) {
    const s = settings as Record<string, unknown>;
    if (!s[ANTIGRAVITY_HOOK_NAME] || typeof s[ANTIGRAVITY_HOOK_NAME] !== "object") {
      s[ANTIGRAVITY_HOOK_NAME] = {};
    }
    const named = s[ANTIGRAVITY_HOOK_NAME] as AntigravityNamedHook;

    for (const eventType of ANTIGRAVITY_HOOK_EVENT_TYPES) {
      const hookEntry = this.buildHookEntry(binaryPath, eventType, scope) as unknown as ClaudeHookEntry;
      const isToolEvent = ANTIGRAVITY_TOOL_EVENTS.has(eventType);

      if (isToolEvent) {
        if (!Array.isArray(named[eventType])) named[eventType] = [] as AntigravityToolMatcher[];
        const matchers = named[eventType] as AntigravityToolMatcher[];
        let found = false;
        for (const matcher of matchers) {
          if (!matcher.hooks) continue;
          const idx = matcher.hooks.findIndex((h) => isMarkedHook(h as Record<string, unknown>));
          if (idx >= 0) {
            matcher.hooks[idx] = hookEntry;
            found = true;
            break;
          }
        }
        if (!found) matchers.push({ matcher: "*", hooks: [hookEntry] });
      } else {
        // Flat array of handler objects (PreInvocation / Stop).
        if (!Array.isArray(named[eventType])) named[eventType] = [] as Array<ClaudeHookEntry | Record<string, unknown>>;
        const handlers = named[eventType] as Array<ClaudeHookEntry | Record<string, unknown>>;
        const idx = handlers.findIndex((h) => isMarkedHook(h as Record<string, unknown>));
        if (idx >= 0) handlers[idx] = hookEntry;
        else handlers.push(hookEntry);
      }
    }
  },

  removeHooksFromFile(settingsPath) {
    const settings = this.readSettings(settingsPath) as Record<string, unknown>;
    const named = settings[ANTIGRAVITY_HOOK_NAME];
    if (!named || typeof named !== "object") {
      this.writeSettings(settingsPath, settings);
      return 0;
    }
    const namedHook = named as AntigravityNamedHook;

    let removed = 0;
    for (const eventType of Object.keys(namedHook)) {
      const value = namedHook[eventType];
      if (!Array.isArray(value)) continue;
      if (ANTIGRAVITY_TOOL_EVENTS.has(eventType)) {
        const matchers = value as AntigravityToolMatcher[];
        for (let i = matchers.length - 1; i >= 0; i--) {
          const matcher = matchers[i];
          if (!matcher || !matcher.hooks) continue;
          const before = matcher.hooks.length;
          matcher.hooks = matcher.hooks.filter((h) => !isMarkedHook(h as Record<string, unknown>));
          removed += before - matcher.hooks.length;
          if (matcher.hooks.length === 0) matchers.splice(i, 1);
        }
        if (matchers.length === 0) delete namedHook[eventType];
      } else {
        const handlers = value as Array<Record<string, unknown>>;
        const before = handlers.length;
        const filtered = handlers.filter((h) => !isMarkedHook(h));
        removed += before - filtered.length;
        if (filtered.length === 0) delete namedHook[eventType];
        else namedHook[eventType] = filtered as Array<ClaudeHookEntry | Record<string, unknown>>;
      }
    }
    // Drop the named hook entirely if it has no remaining events.
    if (Object.keys(namedHook).length === 0) delete settings[ANTIGRAVITY_HOOK_NAME];

    this.writeSettings(settingsPath, settings);
    return removed;
  },

  hooksInstalledInSettings(scope, cwd) {
    const settingsPath = this.getSettingsPath(scope, cwd);
    if (!existsSync(settingsPath)) return false;
    try {
      const settings = this.readSettings(settingsPath) as Record<string, unknown>;
      const named = settings[ANTIGRAVITY_HOOK_NAME];
      if (!named || typeof named !== "object") return false;
      for (const value of Object.values(named as AntigravityNamedHook)) {
        if (!Array.isArray(value)) continue;
        for (const item of value) {
          if (isMarkedHook(item as Record<string, unknown>)) return true;
          const matcher = item as AntigravityToolMatcher;
          if (matcher && Array.isArray(matcher.hooks) && matcher.hooks.some((h) => isMarkedHook(h as Record<string, unknown>))) {
            return true;
          }
        }
      }
    } catch {
      // Corrupt settings — treat as not installed
    }
    return false;
  },

  detectInstalled() {
    return binaryExists("agy");
  },
};

// ── Goose (codename goose, Block) integration ────────────────────────────────
//
// Goose's "hooks" system follows the cross-agent Open Plugins spec: a plugin
// directory whose hooks/hooks.json wires shell commands into agent events.
// failproofai owns the entire `failproofai` plugin dir and writes an Open
// Plugins hooks.json — `{"hooks": {<Event>: [{"hooks": [{type, command}]}]}}`.
// Two differences from Factory (verified live against goose v1.43.0):
//   1. the schema DOES carry the top-level "hooks" wrapper (like Claude), and
//   2. the matcher is OMITTED on every event — a bare "*" is an invalid regex
//      that matches NOTHING (omitted = match all tools).
// Entries are the clean `{type, command}` shape with NO marker field — Goose
// parses this file, so we identify our hooks by the `--cli goose` command
// substring instead of injecting `__failproofai_hook__`. Goose auto-discovers
// the dir at startup (no config edit) and self-registers it into
// ~/.config/goose/config.yaml; uninstall clears our entries (the emptied
// hooks.json and the auto-added config `plugins:` entry are left for Goose to
// reconcile on next start — it logs the empty plugin and continues, harmless).
// Deny is PreToolUse-only JSON (see policy-evaluator.ts). Settings paths:
// ~/.agents/plugins/failproofai/hooks/hooks.json (user) and
// <cwd>/.agents/plugins/failproofai/hooks/hooks.json (project); no "local" scope.

interface GooseHookMatcher {
  matcher?: string;
  hooks: Array<Record<string, unknown>>;
}
/** The Open Plugins hooks file: { "hooks": { <Event>: GooseHookMatcher[] } }. */
interface GooseHooksFile {
  hooks?: Record<string, GooseHookMatcher[]>;
  [key: string]: unknown;
}

/** failproofai owns the `failproofai` Goose plugin dir; identify our hook
 *  entries by the `--cli goose` command substring (the file is Goose-parsed, so
 *  entries stay the clean {type, command} shape with no marker field). */
function isGooseFailproofaiHook(hook: unknown): boolean {
  if (!hook || typeof hook !== "object") return false;
  const cmd = (hook as { command?: unknown }).command;
  return typeof cmd === "string" && cmd.includes("failproofai") && cmd.includes("--cli goose");
}

export const goose: Integration = {
  id: "goose",
  displayName: "Goose",
  scopes: GOOSE_HOOK_SCOPES,
  eventTypes: GOOSE_HOOK_EVENT_TYPES,

  getSettingsPath(scope, cwd) {
    const base = cwd ? resolve(cwd) : process.cwd();
    switch (scope) {
      case "user":
        return resolve(homedir(), ".agents", "plugins", "failproofai", "hooks", "hooks.json");
      case "project":
        return resolve(base, ".agents", "plugins", "failproofai", "hooks", "hooks.json");
      case "local":
        // Goose has no "local" scope; the CLI rejects --scope local before
        // reaching here, but fall back to project so callers don't crash.
        return resolve(base, ".agents", "plugins", "failproofai", "hooks", "hooks.json");
    }
  },

  readSettings(settingsPath) {
    return readJsonFile(settingsPath);
  },

  writeSettings(settingsPath, settings) {
    writeJsonFile(settingsPath, settings);
  },

  buildHookEntry(binaryPath, eventType, scope) {
    const command =
      scope === "project"
        ? `npx -y failproofai --hook ${eventType} --cli goose`
        : `"${binaryPath}" --hook ${eventType} --cli goose`;
    // Open Plugins command entry: { type, command } only (Goose applies its own
    // timeout; no marker field — see isGooseFailproofaiHook).
    return { type: "command", command };
  },

  isFailproofaiHook: isGooseFailproofaiHook,

  writeHookEntries(settings, binaryPath, scope) {
    const s = settings as GooseHooksFile;
    if (!s.hooks) s.hooks = {};

    for (const eventType of GOOSE_HOOK_EVENT_TYPES) {
      const hookEntry = this.buildHookEntry(binaryPath, eventType, scope);
      if (!Array.isArray(s.hooks[eventType])) s.hooks[eventType] = [];
      const matchers: GooseHookMatcher[] = s.hooks[eventType];

      let found = false;
      for (const matcher of matchers) {
        if (!matcher.hooks) continue;
        const idx = matcher.hooks.findIndex((h) => isGooseFailproofaiHook(h));
        if (idx >= 0) {
          matcher.hooks[idx] = hookEntry;
          found = true;
          break;
        }
      }
      // matcher OMITTED on every event (a bare "*" matches nothing; omitted =
      // match all tools — verified live against goose v1.43.0).
      if (!found) matchers.push({ hooks: [hookEntry] });
    }
  },

  removeHooksFromFile(settingsPath) {
    const settings = this.readSettings(settingsPath) as GooseHooksFile;
    if (!settings.hooks) return 0;

    let removed = 0;
    for (const eventType of Object.keys(settings.hooks)) {
      const matchers = settings.hooks[eventType];
      if (!Array.isArray(matchers)) continue;
      for (let i = matchers.length - 1; i >= 0; i--) {
        const matcher = matchers[i];
        if (!matcher || !matcher.hooks) continue;
        const before = matcher.hooks.length;
        matcher.hooks = matcher.hooks.filter((h) => !isGooseFailproofaiHook(h));
        removed += before - matcher.hooks.length;
        if (matcher.hooks.length === 0) matchers.splice(i, 1);
      }
      if (matchers.length === 0) delete settings.hooks[eventType];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    this.writeSettings(settingsPath, settings as Record<string, unknown>);
    return removed;
  },

  hooksInstalledInSettings(scope, cwd) {
    const settingsPath = this.getSettingsPath(scope, cwd);
    if (!existsSync(settingsPath)) return false;
    try {
      const settings = this.readSettings(settingsPath) as GooseHooksFile;
      if (!settings.hooks) return false;
      for (const matchers of Object.values(settings.hooks)) {
        if (!Array.isArray(matchers)) continue;
        for (const matcher of matchers) {
          if (!matcher || !matcher.hooks) continue;
          if (matcher.hooks.some((h) => isGooseFailproofaiHook(h))) return true;
        }
      }
    } catch {
      // Corrupt settings — treat as not installed
    }
    return false;
  },

  detectInstalled() {
    return binaryExists("goose");
  },
};

// ── Registry ────────────────────────────────────────────────────────────────

// `Partial` is kept (not every IntegrationType is guaranteed installable for
// LIVE hooks / Pillar 1) so a future audit-only CLI can omit its entry without a
// type error. `hermes` now has BOTH an audit adapter
// (src/audit/cli-adapters/hermes.ts) AND live-hook install support, so it is
// registered here.
const INTEGRATIONS: Partial<Record<IntegrationType, Integration>> = {
  claude: claudeCode,
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
};

export function getIntegration(id: IntegrationType): Integration {
  const integration = INTEGRATIONS[id];
  if (!integration) {
    // A future audit-only CLI (one with an audit adapter but no INTEGRATIONS
    // entry) reaches here when someone tries to install live hooks for it. Be
    // explicit rather than "unknown integration". (hermes is NOT audit-only — it
    // has a live-hook entry — so it never reaches this branch.)
    throw new Error(
      `"${id}" is audit-only — live-hook install is not supported for it yet. Installable: ${listInstallableIds().join(", ")}`,
    );
  }
  return integration;
}

/** IntegrationTypes that support live-hook install (i.e. have an INTEGRATIONS
 *  entry). Any audit-only CLI (one with an audit adapter but no hook install)
 *  is excluded so it never appears in install menus. */
export function listInstallableIds(): IntegrationType[] {
  return INTEGRATION_TYPES.filter((id) => INTEGRATIONS[id] !== undefined);
}

export function listIntegrations(): Integration[] {
  return INTEGRATION_TYPES.map((id) => INTEGRATIONS[id]).filter(
    (i): i is Integration => i !== undefined,
  );
}

/** Detect which agent CLIs are installed on PATH. Only considers CLIs that
 *  support live-hook install (audit-only CLIs have no INTEGRATIONS entry). */
export function detectInstalledClis(): IntegrationType[] {
  return INTEGRATION_TYPES.filter((id) => INTEGRATIONS[id]?.detectInstalled());
}
