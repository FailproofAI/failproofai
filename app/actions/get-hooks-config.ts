"use server";

import { configuredCustomPolicyPaths, readMergedHooksConfig } from "@/src/hooks/hooks-config";
import { hooksInstalledInSettings, getSettingsPath } from "@/src/hooks/manager";
import { listIntegrations } from "@/src/hooks/integrations";
import { HOOK_SCOPES } from "@/src/hooks/types";
import type { HookScope, IntegrationType } from "@/src/hooks/types";
import { getCliLabel } from "@/lib/cli-registry";
import { customPolicyId, conventionPolicyId, discoverPolicyFiles } from "@/src/hooks/custom-hooks-loader";
import { findProjectConfigDir } from "@/src/hooks/hooks-config";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { customPoliciesDir } from "@/src/hooks/fp-home";
import { readInstalledPacks } from "@/src/hooks/pack-manifest";
import type { PackError, ResolvedPack } from "@/src/hooks/pack-manifest";

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
  /** The pack this policy came from — every policy has one now. */
  packId: string;
  packVersion: string;
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

/** One policy carried by an installed pack. */
export interface PackPolicyInfo {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
}

export interface InstalledPackInfo {
  id: string;
  version: string;
  /** Where it came from, verbatim — `github:acme/ops@v1.0.0` or `bundled:...`. */
  source: string;
  effect: "enforce" | "observe";
  policies: PackPolicyInfo[];
  /** Set when the record itself could not be read, e.g. its digest changed. */
  error?: string;
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
  customPoliciesPaths?: string[];
  /** Legacy singular path retained for older dashboard clients. */
  customPoliciesPath?: string;
  customPolicies?: CustomPolicyInfo[];
  /** Convention-discovered policy files, project scope first. */
  conventionPolicies: ConventionPolicyFile[];
  /** Installed policy packs, read from `installed.json`. */
  packs: InstalledPackInfo[];
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
  explicitPaths: Set<string>,
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
  const userDir = customPoliciesDir();

  const dirs: { scope: "project" | "user"; dir: string }[] = [
    { scope: "project", dir: projectDir },
    // Running the dashboard from $HOME makes both paths identical; listing the
    // same file twice would read as two separate installs.
    ...(userDir === projectDir ? [] : [{ scope: "user" as const, dir: userDir }]),
  ];

  const out: ConventionPolicyFile[] = [];
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
      if (explicitPaths.has(filePath)) continue;
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
  const launchCwd = process.env.FAILPROOFAI_LAUNCH_CWD || process.cwd();
  // Match runtime enforcement: project, local, and user config all
  // contribute to the effective policy state shown by the dashboard.
  const config = readMergedHooksConfig(launchCwd);
  const disabledCustomPolicies = new Set(config.disabledCustomPolicies ?? []);

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

  // Read once, ahead of everything that needs it: the policy list IS the packs'
  // policies now, and the pack listing further down describes the same read.
  let installedPacks: ResolvedPack[] = [];
  let packErrors: PackError[] = [];
  try {
    const result = readInstalledPacks();
    installedPacks = result.packs;
    packErrors = result.errors;
  } catch {
    // A listing must not be the thing that turns an unreadable manifest into a
    // broken page.
  }

  // Every policy that enforces here comes from an installed PACK. Nothing is
  // compiled into this build any more except the always-on self-protection
  // guard — which no listing can switch off, so it has no row.
  const policies: PolicyInfo[] = [];
  for (const pack of installedPacks) {
    const taken = pack.enabled ?? pack.policies.map((p) => p.name);
    for (const policy of pack.policies) {
      policies.push({
        name: policy.name,
        description: policy.description,
        category: policy.category,
        defaultEnabled: policy.defaultEnabled,
        beta: false,
        enabled:
          taken.includes(policy.name) &&
          !disabledCustomPolicies.has(`pack:${pack.id}@${pack.version}:${policy.name}`),
        eventScope: buildEventScope(policy.match),
        packId: pack.id,
        packVersion: pack.version,
        ...(policy.params
          ? {
              params: Object.fromEntries(
                Object.entries(policy.params).map(([k, v]) => [
                  k,
                  { type: v.type, description: v.description, default: v.default },
                ]),
              ),
              currentParams: config.policyParams?.[policy.name] ?? {},
            }
          : {}),
      });
    }
  }

  const customPoliciesPaths = configuredCustomPolicyPaths(config);
  const launchRoot = findProjectConfigDir(launchCwd);
  const resolvedCustomPaths = customPoliciesPaths.map((path) => resolve(launchRoot, path));
  const parsedCustomPolicies = await Promise.all(resolvedCustomPaths.map(async (path) => {
    try {
      return (await parseCustomPoliciesFromFile(path)).map((policy) => {
        const id = customPolicyId(path, policy.name);
        return { ...policy, id, enabled: !disabledCustomPolicies.has(id) };
      });
    } catch {
      // Keep the rest of the dashboard usable when one configured file is
      // unreadable or disappears between existsSync and readFile.
      return [];
    }
  }));
  const customPolicies = parsedCustomPolicies.flat();

  const conventionPolicies = await discoverConventionPolicies(
    disabledCustomPolicies,
    new Set(resolvedCustomPaths),
  );

  // Metadata only — deliberately never imported. Same rule as the convention
  // files above: this runs on every page load, and importing a pack's artifact
  // would execute a third party's code inside the long-lived dashboard server.
  // The import check that proves a pack still loads belongs to the CLI and to
  // the user-initiated install action.
  const packs: InstalledPackInfo[] = installedPacks.map((pack) => {
    const taken = pack.enabled ?? pack.policies.map((p) => p.name);
    return {
      id: pack.id,
      version: pack.version,
      source: pack.source,
      effect: pack.effect,
      policies: pack.policies.map((policy) => ({
        name: policy.name,
        description: policy.description,
        category: policy.category,
        enabled:
          taken.includes(policy.name) &&
          !disabledCustomPolicies.has(`pack:${pack.id}@${pack.version}:${policy.name}`),
      })),
    };
  });
  for (const err of packErrors) {
    // A pack that will not load is what the machine denies for; a listing that
    // omitted it would be the quietest possible way to report that.
    packs.push({
      id: err.id ?? "(unnamed pack)",
      version: "",
      source: "",
      effect: "enforce",
      policies: [],
      error: err.reason,
    });
  }

  return {
    enabledPolicies: config.enabledPolicies,
    installedScopes,
    settingsPath,
    clis,
    policies,
    customPoliciesPaths: customPoliciesPaths.length ? customPoliciesPaths : undefined,
    customPoliciesPath: customPoliciesPaths.length === 1 ? customPoliciesPaths[0] : undefined,
    customPolicies: customPolicies.length ? customPolicies : undefined,
    conventionPolicies,
    packs,
  };
}
