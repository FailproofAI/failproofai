"use server";

import { readHooksConfig } from "@/src/hooks/hooks-config";
import { hooksInstalledInSettings, getSettingsPath } from "@/src/hooks/manager";
import { BUILTIN_POLICIES } from "@/src/hooks/builtin-policies";
import { listIntegrations } from "@/src/hooks/integrations";
import { HOOK_SCOPES } from "@/src/hooks/types";
import type { HookScope, IntegrationType } from "@/src/hooks/types";
import { getCliLabel } from "@/lib/cli-registry";
import { customPolicyId, conventionPolicyId, discoverPolicyFiles } from "@/src/hooks/custom-hooks-loader";
import { findProjectConfigDir } from "@/src/hooks/hooks-config";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

export interface PolicyParamSpec {
  type: string;
  description: string;
  default: unknown;
}

export interface PolicyInfo {
  name: string;
  description: string;
  category: string;
  defaultEnabled: boolean;
  beta: boolean;
  enabled: boolean;
  eventScope: string;
  params?: Record<string, PolicyParamSpec>;
  currentParams?: Record<string, unknown>;
}

export interface CustomPolicyInfo {
  name: string;
  description?: string;
  eventScope?: string;
  id: string;
  enabled: boolean;
}

/**
 * One convention-discovered policy file (`.failproofai/policies/*policies.mjs`)
 * and the policies it declares.
 *
 * These are registered by the filesystem, never by `policies-config.json` — the
 * whole point of the convention is that dropping a file in works with no config
 * at all. So the dashboard has to discover them the same way the hook path and
 * `failproofai policies --list` do; reading config alone renders nothing and
 * makes a working policy look absent.
 */
export interface ConventionPolicyFile {
  scope: "project" | "user";
  /** Basename, e.g. `security-policies.mjs`. */
  file: string;
  /** Absolute path, shown so the user knows which file to edit. */
  path: string;
  policies: CustomPolicyInfo[];
}

export interface CliInstallStatus {
  id: IntegrationType;
  label: string;
  installed: boolean;
  settingsPath: string;
  /** Whether the agent CLI's binary was found on PATH. */
  detected: boolean;
}

export interface HooksConfigPayload {
  enabledPolicies: string[];
  /** Claude-only legacy field; kept for back-compat. New UI should consume `clis`. */
  installedScopes: HookScope[];
  /** Claude-only legacy field; kept for back-compat. New UI should consume `clis`. */
  settingsPath: string;
  /** Per-CLI install state at user scope, in `INTEGRATION_TYPES` order. */
  clis: CliInstallStatus[];
  policies: PolicyInfo[];
  customPoliciesPath?: string;
  customPolicies?: CustomPolicyInfo[];
  /** Convention-discovered policy files, project scope first. */
  conventionPolicies: ConventionPolicyFile[];
}

/**
 * Discover `.failproofai/policies/*policies.{js,mjs,ts}` at project and user
 * scope and statically parse each one.
 *
 * Deliberately parsed, never imported: `manager.ts` executes these files to
 * list them, which is fine for a one-shot CLI but would run arbitrary user code
 * inside the long-lived dashboard server on every page load.
 * `parseCustomPoliciesFromFile` is a regex read, so a malformed policy file
 * degrades to "no policies listed" instead of taking the server down.
 */
async function discoverConventionPolicies(
  disabled: Set<string>,
  customPoliciesPath?: string,
): Promise<ConventionPolicyFile[]> {
  // Two corrections over a bare `process.cwd()`, both of which made real
  // project policies invisible here while enforcement loaded them fine:
  //   - the standalone server chdir()s into the package on startup, so the real
  //     launch directory arrives via FAILPROOFAI_LAUNCH_CWD (scripts/launch.ts);
  //   - enforcement resolves the project root by walking UP to the nearest
  //     `.failproofai` marker (custom-hooks-loader -> findProjectConfigDir), so
  //     resolving at the exact cwd disagrees with it from any subdirectory.
  const launchCwd = process.env.FAILPROOFAI_LAUNCH_CWD || process.cwd();
  const projectDir = resolve(findProjectConfigDir(launchCwd), ".failproofai", "policies");
  const userDir = resolve(homedir(), ".failproofai", "policies");

  const dirs: { scope: "project" | "user"; dir: string }[] = [
    { scope: "project", dir: projectDir },
    // Running the dashboard from $HOME makes both paths identical; listing the
    // same file twice would read as two separate installs.
    ...(userDir === projectDir ? [] : [{ scope: "user" as const, dir: userDir }]),
  ];

  const out: ConventionPolicyFile[] = [];
  const explicitPath = customPoliciesPath
    ? resolve(findProjectConfigDir(launchCwd), customPoliciesPath)
    : undefined;
  for (const { scope, dir } of dirs) {
    // Isolate per directory and per file. `parseCustomPoliciesFromFile` guards
    // non-existence but `readFile` still throws on EACCES, a file deleted
    // between listing and reading, or a directory entry — and that rejection
    // propagates out of the action, where both callers swallow it, leaving the
    // Configure Policies tab stuck on "Loading…" with no error. One unreadable
    // file must cost that file's policy list, not the whole page.
    let files: string[] = [];
    try {
      files = discoverPolicyFiles(dir);
    } catch {
      continue;
    }
    for (const filePath of files) {
      // Runtime loads an explicitly configured file only once and treats it as
      // explicit even when it also matches the convention. Mirror that here so
      // the dashboard cannot show a second toggle that controls no runtime hook.
      if (filePath === explicitPath) continue;
      let policies: CustomPolicyInfo[] = [];
      try {
        policies = (await parseCustomPoliciesFromFile(filePath)).map((policy) => {
          const id = conventionPolicyId(scope, basename(filePath), policy.name);
          return { ...policy, id, enabled: !disabled.has(id) };
        });
      } catch {
        // Still list the file — it IS installed and enforcing; we just cannot
        // read its contents to name the policies.
      }
      out.push({ scope, file: basename(filePath), path: filePath, policies });
    }
  }
  return out;
}

async function parseCustomPoliciesFromFile(filePath: string): Promise<CustomPolicyInfo[]> {
  if (!existsSync(filePath)) return [];
  const source = await readFile(filePath, "utf-8");
  const policies: CustomPolicyInfo[] = [];
  const segments = source.split(/customPolicies\.add\s*\(/);
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const nameMatch = seg.match(/name:\s*["'`]([^"'`]+)["'`]/);
    if (!nameMatch) continue;
    const descMatch = seg.match(/description:\s*["'`]([^"'`]+)["'`]/);
    const eventsMatch = seg.match(/events:\s*\[([^\]]+)\]/);
    const eventScope = eventsMatch
      ? eventsMatch[1].replace(/["'`\s]/g, "").split(",").filter(Boolean).join(", ")
      : undefined;
    policies.push({ name: nameMatch[1], description: descMatch?.[1], eventScope, id: "", enabled: true });
  }
  return policies;
}

function buildEventScope(match: { events?: string[]; toolNames?: string[] }): string {
  const events = match.events?.join(", ") ?? "";
  const tools = match.toolNames ? ` · ${match.toolNames.join(", ")}` : "";
  return `${events}${tools}`;
}

export async function getHooksConfigAction(): Promise<HooksConfigPayload> {
  const config = readHooksConfig();
  const disabledCustomPolicies = new Set(config.disabledCustomPolicies ?? []);
  const enabledSet = new Set(config.enabledPolicies);

  const installedScopes = HOOK_SCOPES.filter((s) => hooksInstalledInSettings(s));
  const primaryScope: HookScope = installedScopes[0] ?? "user";
  const settingsPath = getSettingsPath(primaryScope);

  const clis: CliInstallStatus[] = listIntegrations().map((integration) => ({
    id: integration.id,
    label: getCliLabel(integration.id),
    installed: integration.hooksInstalledInSettings("user"),
    settingsPath: integration.getSettingsPath("user"),
    detected: integration.detectInstalled(),
  }));

  const policies: PolicyInfo[] = BUILTIN_POLICIES.map((p) => ({
    name: p.name,
    description: p.description,
    category: p.category,
    defaultEnabled: p.defaultEnabled,
    beta: !!p.beta,
    enabled: enabledSet.has(p.name),
    eventScope: buildEventScope(p.match),
    params: p.params
      ? Object.fromEntries(
          Object.entries(p.params).map(([k, v]) => [k, { type: v.type, description: v.description, default: v.default }])
        )
      : undefined,
    currentParams: p.params ? (config.policyParams?.[p.name] ?? {}) : undefined,
  }));

  const customPolicies = config.customPoliciesPath
    ? (await parseCustomPoliciesFromFile(config.customPoliciesPath)).map((policy) => {
        const id = customPolicyId(policy.name);
        return { ...policy, id, enabled: !disabledCustomPolicies.has(id) };
      })
    : undefined;

  const conventionPolicies = await discoverConventionPolicies(
    disabledCustomPolicies,
    config.customPoliciesPath,
  );

  return {
    enabledPolicies: config.enabledPolicies,
    installedScopes,
    settingsPath,
    clis,
    policies,
    customPoliciesPath: config.customPoliciesPath,
    customPolicies: customPolicies?.length ? customPolicies : undefined,
    conventionPolicies,
  };
}
