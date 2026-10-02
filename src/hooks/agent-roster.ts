/**
 * Read the daemon-owned profile roster. The telemetry agent_id and transcript
 * path are not profile evidence. A scoped Cloud assignment is withheld unless
 * this invocation resolves to one of the daemon's recorded config paths.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { agentRosterFile } from "./fp-home";
import { validAgentIdentity, type AgentIdentity } from "./agent-targets";
import type { HookScope, IntegrationType } from "./types";

const USER_SETTINGS: Partial<Record<IntegrationType, string>> = {
  claude: ".claude/settings.json",
  codex: ".codex/hooks.json",
  copilot: ".copilot/hooks/failproofai.json",
  cursor: ".cursor/hooks.json",
  opencode: ".config/opencode/opencode.json",
  pi: ".pi/agent/settings.json",
  factory: ".factory/hooks.json",
  devin: ".config/devin/config.json",
  antigravity: ".gemini/config/hooks.json",
  goose: ".agents/plugins/failproofai/hooks/hooks.json",
};

const PROJECT_SETTINGS: Partial<Record<IntegrationType, string[]>> = {
  claude: [".claude/settings.local.json", ".claude/settings.json"],
  codex: [".codex/hooks.json"],
  copilot: [".github/hooks/failproofai.json"],
  cursor: [".cursor/hooks.json"],
  opencode: [".opencode/opencode.json"],
  pi: [".pi/settings.json"],
  factory: [".factory/hooks.json"],
  devin: [".devin/config.json"],
  antigravity: [".agents/hooks.json"],
  goose: [".agents/plugins/failproofai/hooks/hooks.json"],
};

function installedHookAt(path: string, cli: IntegrationType): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 131_072) return false;
    const text = readFileSync(path, "utf8");
    if (text.includes("failproofai")) return true;
    // Pi's project entry is portable and relative to `.pi/settings.json`:
    // `../pi-extension` contains no product name. Missing it here let a
    // simultaneously installed user hook masquerade as this project's Pi.
    if (cli !== "pi") return false;
    const config: unknown = JSON.parse(text);
    if (!config || typeof config !== "object" || Array.isArray(config)) return false;
    const packages = (config as { packages?: unknown }).packages;
    return Array.isArray(packages) && packages.some(
      (entry) => typeof entry === "string" && /(?:^|\/)pi-extension\/?$/.test(entry),
    );
  } catch {
    return false;
  }
}

/** Called in the originating hook process; the worker's env may be different. */
export function runtimeAgentSettingsPath(
  cli: IntegrationType,
  cwd?: string,
  userHome = homedir(),
  hookScope?: HookScope,
): string | null {
  if (cli === "hermes") {
    if (hookScope && hookScope !== "user") return null;
    const home = process.env.HERMES_HOME;
    return resolve(home?.trim() ? home : resolve(userHome, ".hermes"), "config.yaml");
  }
  if (cli === "openclaw") {
    if (hookScope && hookScope !== "user") return null;
    const config = process.env.OPENCLAW_CONFIG_PATH;
    if (config?.trim()) return resolve(config);
    const state = process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_HOME;
    return resolve(state?.trim() ? state : resolve(userHome, ".openclaw"), "openclaw.json");
  }
  const relative = USER_SETTINGS[cli];
  if (!relative) return null;
  const override = cli === "codex" ? process.env.CODEX_HOME
    : cli === "claude" ? process.env.CLAUDE_CONFIG_DIR : undefined;
  const user = resolve(override?.trim() ? override : userHome, override?.trim()
    ? cli === "codex" ? "hooks.json" : "settings.json"
    : relative);
  if (hookScope === "user") return user;

  const scopeFiles = hookScope === "local"
    ? cli === "claude" ? [".claude/settings.local.json"] : []
    : hookScope === "project"
      ? (PROJECT_SETTINGS[cli] ?? []).filter((name) => name !== ".claude/settings.local.json")
      : PROJECT_SETTINGS[cli] ?? [];
  const matches = new Set<string>();
  if (hookScope === undefined && installedHookAt(user, cli)) matches.add(user);
  let dir = resolve(cwd ?? process.cwd());
  const userRoot = resolve(userHome);
  for (let depth = 0; depth < 16 && dir !== userRoot; depth++) {
    for (const candidate of scopeFiles) {
      const path = resolve(dir, candidate);
      if (installedHookAt(path, cli)) matches.add(path);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No source hint can tell WHICH installed hook fired if both user and
  // project/local scopes contain us. A guessed profile would let an exact
  // assignment match another installation: withhold it instead.
  if (matches.size > 1) return null;
  if (hookScope === "project" || hookScope === "local") return matches.values().next().value ?? null;
  return matches.values().next().value ?? user;
}

export function readRuntimeAgentIdentity(cli: IntegrationType, settingsPath: string | null): AgentIdentity | null {
  if (!settingsPath) return null;
  try {
    const path = agentRosterFile();
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 256_000) return null;
    const roster: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!roster || typeof roster !== "object" || Array.isArray(roster)) return null;
    const data = roster as Record<string, unknown>;
    if (data.schemaVersion !== 1 || !Array.isArray(data.agents) || data.agents.length > 64) return null;
    const absolute = resolve(settingsPath);
    const agent = data.agents.find((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      return record.integration === cli && record.settingsPath === absolute &&
        validAgentIdentity({ integration: record.integration, instanceId: record.instanceId });
    });
    const instanceId = (agent as Record<string, unknown> | undefined)?.instanceId;
    return validAgentIdentity({ integration: cli, instanceId })
      ? { integration: cli, instanceId: instanceId as string }
      : null;
  } catch {
    // Unavailable, malformed or old roster: never infer a profile from cwd,
    // transcript, or the display name and widen a scoped deployment.
    return null;
  }
}
