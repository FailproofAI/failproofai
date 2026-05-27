/**
 * Read/write the hooks configuration file at ~/.failproofai/policies-config.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { HooksConfig } from "./policy-types";
import type { HookScope } from "./types";
import { hookLogInfo, hookLogWarn } from "./hook-logger";

function readConfigAt(path: string): Partial<HooksConfig> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Partial<HooksConfig>;
  } catch (err) {
    hookLogWarn(`failed to parse config at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/**
 * Walk up from `start` until a `.failproofai/` directory is found, and return that
 * dir as the project root. Stops at homedir (the global `~/.failproofai/` is not a
 * project root) or filesystem root. If no marker is found, returns the original
 * `start` so callers fall through to the global-only config merge.
 *
 * Fixes #200: when Claude Code's Bash tool drifts CWD into a subdirectory, the
 * project policy config was silently missed because we resolved it at the exact
 * cwd instead of walking up.
 */
export function findProjectConfigDir(start: string): string {
  const home = homedir();
  let dir = resolve(start);
  while (dir !== home) {
    const marker = resolve(dir, ".failproofai");
    try {
      if (statSync(marker).isDirectory()) return dir;
    } catch {
      // not present or unreadable — keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

/**
 * Read and merge hooks config from three scopes in priority order:
 *   1. {cwd}/.failproofai/policies-config.json        (project)
 *   2. {cwd}/.failproofai/policies-config.local.json  (local)
 *   3. ~/.failproofai/policies-config.json             (global)
 *
 * Merge rules:
 *   enabledPolicies: union + dedup across all three
 *   policyParams:    per-policy key, first scope that defines it wins entirely
 *   customPoliciesPath: first scope that defines it wins
 *   llm:            first scope that defines it wins
 */
export function readMergedHooksConfig(cwd?: string): HooksConfig {
  const base = findProjectConfigDir(cwd ?? process.cwd());
  const projectPath = resolve(base, ".failproofai", "policies-config.json");
  const localPath = resolve(base, ".failproofai", "policies-config.local.json");
  const globalPath = resolve(homedir(), ".failproofai", "policies-config.json");

  const project = readConfigAt(projectPath);
  const local = readConfigAt(localPath);
  const global_ = readConfigAt(globalPath);

  // enabledPolicies: union + dedup
  const enabledSet = new Set<string>([
    ...(project.enabledPolicies ?? []),
    ...(local.enabledPolicies ?? []),
    ...(global_.enabledPolicies ?? []),
  ]);

  // policyParams: per-policy, first scope wins
  const mergedParams: Record<string, Record<string, unknown>> = {};
  for (const scope of [project, local, global_]) {
    if (!scope.policyParams) continue;
    for (const [policyName, params] of Object.entries(scope.policyParams)) {
      if (!(policyName in mergedParams)) {
        mergedParams[policyName] = params;
      }
    }
  }

  // customPoliciesPath: first scope wins
  const customPoliciesPath =
    project.customPoliciesPath ?? local.customPoliciesPath ?? global_.customPoliciesPath;

  // llm: first scope wins
  const llm = project.llm ?? local.llm ?? global_.llm;

  return {
    enabledPolicies: [...enabledSet],
    ...(Object.keys(mergedParams).length > 0 ? { policyParams: mergedParams } : {}),
    ...(customPoliciesPath !== undefined ? { customPoliciesPath } : {}),
    ...(llm !== undefined ? { llm } : {}),
  };
}

function getConfigPath(): string {
  return resolve(homedir(), ".failproofai", "policies-config.json");
}

export function readHooksConfig(): HooksConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { enabledPolicies: [] };
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw) as HooksConfig;
  } catch (err) {
    hookLogWarn(`failed to parse config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    return { enabledPolicies: [] };
  }
}

export function writeHooksConfig(config: HooksConfig): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8", { mode: 0o600 });
}

/**
 * Resolve the policies-config path for a specific scope.
 */
export function getConfigPathForScope(scope: HookScope, cwd?: string): string {
  switch (scope) {
    case "user":
      return resolve(homedir(), ".failproofai", "policies-config.json");
    case "project":
      return resolve(findProjectConfigDir(cwd ?? process.cwd()), ".failproofai", "policies-config.json");
    case "local":
      return resolve(findProjectConfigDir(cwd ?? process.cwd()), ".failproofai", "policies-config.local.json");
  }
}

/**
 * Read hooks config from a single specific scope (not merged).
 */
export function readScopedHooksConfig(scope: HookScope, cwd?: string): HooksConfig {
  const configPath = getConfigPathForScope(scope, cwd);
  if (!existsSync(configPath)) {
    return { enabledPolicies: [] };
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw) as HooksConfig;
  } catch (err) {
    hookLogWarn(`failed to parse config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    return { enabledPolicies: [] };
  }
}

/**
 * Write hooks config to the scope-appropriate path.
 */
export function writeScopedHooksConfig(config: HooksConfig, scope: HookScope, cwd?: string): void {
  const configPath = getConfigPathForScope(scope, cwd);
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8", { mode: 0o600 });
}

export interface ResolvedLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function readLlmConfig(cwd?: string): ResolvedLlmConfig | null {
  const config = readMergedHooksConfig(cwd);
  const baseUrl =
    process.env.FAILPROOFAI_LLM_BASE_URL ?? config.llm?.baseUrl ?? "https://api.openai.com/v1";
  const apiKey = process.env.FAILPROOFAI_LLM_API_KEY ?? config.llm?.apiKey;
  const model = process.env.FAILPROOFAI_LLM_MODEL ?? config.llm?.model ?? "gpt-4o-mini";
  const apiKeySource = process.env.FAILPROOFAI_LLM_API_KEY ? "env" : config.llm?.apiKey ? "file" : "missing";
  const baseUrlSource = process.env.FAILPROOFAI_LLM_BASE_URL ? "env" : config.llm?.baseUrl ? "file" : "default";
  const modelSource = process.env.FAILPROOFAI_LLM_MODEL ? "env" : config.llm?.model ? "file" : "default";
  hookLogInfo(`llm-config: apiKey=${apiKeySource} baseUrl=${baseUrlSource}(${baseUrl}) model=${modelSource}(${model})`);
  if (!apiKey) return null;
  return { baseUrl, apiKey, model };
}
