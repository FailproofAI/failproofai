/**
 * Install/remove/list failproofai hooks for one or more agent CLIs.
 *
 * Per-CLI path resolution and settings I/O live in `./integrations` (one
 * `Integration` impl per CLI). This module orchestrates: validation, policy
 * selection, telemetry, multi-scope warnings, and console output.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { homedir, platform, arch, release, hostname } from "node:os";
import {
  HOOK_SCOPES,
  type HookScope,
  type IntegrationType,
} from "./types";
import { claudeCode, getIntegration } from "./integrations";
import { promptPolicySelection } from "./install-prompt";
import { readMergedHooksConfig, readScopedHooksConfig, writeScopedHooksConfig } from "./hooks-config";
import type { HooksConfig } from "./policy-types";
import { BUILTIN_POLICIES } from "./builtin-policies";
import { loadCustomHooks, discoverPolicyFiles } from "./custom-hooks-loader";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId, hashToId } from "../../lib/telemetry-id";
import { CliError } from "../cli-error";

const VALID_POLICY_NAMES = new Set(BUILTIN_POLICIES.map((p) => p.name));

/** Settings path for the Claude Code integration. Kept as a public export for `app/actions/get-hooks-config.ts`. */
export function getSettingsPath(scope: HookScope, cwd?: string): string {
  return claudeCode.getSettingsPath(scope, cwd);
}

function scopeLabel(scope: HookScope): string {
  switch (scope) {
    case "user":
      return `~/.claude/settings.json`;
    case "project":
      return `{cwd}/.claude/settings.json`;
    case "local":
      return `{cwd}/.claude/settings.local.json`;
  }
}

function resolveFailproofaiBinary(): string {
  // Test/CI override: lets E2E tests point at the in-tree bin/failproofai.mjs
  // without requiring `npm install -g` or `bun link`.
  const override = process.env.FAILPROOFAI_BINARY_OVERRIDE;
  if (override && override.trim()) return override.trim();
  try {
    const cmd = process.platform === "win32" ? "where failproofai" : "which failproofai";
    const result = execSync(cmd, { encoding: "utf8" }).trim();
    // `where` on Windows may return multiple lines; take the first
    return result.split("\n")[0].trim();
  } catch {
    throw new CliError(
      "failproofai binary not found in PATH.\n" +
      "Install it globally first: npm install -g failproofai"
    );
  }
}

function validatePolicyNames(names: string[]): void {
  const invalid = names.filter((n) => !VALID_POLICY_NAMES.has(n));
  if (invalid.length > 0) {
    const validList = [...VALID_POLICY_NAMES].join(", ");
    throw new CliError(
      `Unknown policy name(s): ${invalid.join(", ")}\n` +
      `Valid policies: ${validList}`
    );
  }
}

/** Return only scopes whose settings paths are unique (first wins). */
function deduplicateScopes(scopes: readonly HookScope[], cwd?: string): HookScope[] {
  const seen = new Set<string>();
  return scopes.filter((s) => {
    const p = getSettingsPath(s, cwd);
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

export function hooksInstalledInSettings(scope: HookScope, cwd?: string): boolean {
  return claudeCode.hooksInstalledInSettings(scope, cwd);
}

/**
 * Install hooks into Claude Code settings.
 *
 * @param policyNames — if provided, skip interactive prompt:
 *   - `["all"]` → enable all policies
 *   - `["block-sudo", "block-rm-rf"]` → enable specific policies
 *   - `undefined` → interactive prompt (pre-loads current config if exists)
 * @param scope — settings scope to write to (default: "user")
 */
export async function installHooks(
  policyNames?: string[],
  scope: HookScope = "user",
  cwd?: string,
  includeBeta = false,
  source?: string,
  customPoliciesPath?: string,
  removeCustomHooks = false,
  cli?: IntegrationType[],
): Promise<void> {
  // Validate user input first before any system checks
  if (policyNames !== undefined && policyNames.length > 0) {
    const nonAllNames = policyNames.filter((n) => n !== "all");
    // Check unknown names first (most actionable error for the user)
    if (nonAllNames.length > 0) validatePolicyNames(nonAllNames);
    // Then check if "all" is mixed with valid specific names
    if (policyNames.includes("all") && nonAllNames.length > 0) {
      throw new CliError(
        `"all" cannot be combined with specific policy names.\n` +
        `Use either: --install all  or  --install block-sudo sanitize-jwt ...`
      );
    }
  }

  // Back-compat default: ["claude"]. Callers (bin/failproofai.mjs) prompt
  // the user for multi-CLI selection before reaching here when --cli is omitted.
  const selectedClis: IntegrationType[] = cli && cli.length > 0 ? [...new Set(cli)] : ["claude"];

  // Per-CLI scope validation: Codex doesn't have a "local" scope.
  for (const cliId of selectedClis) {
    const integration = getIntegration(cliId);
    if (!integration.scopes.includes(scope)) {
      try {
        await trackHookEvent(getInstanceId(), "scope_validation_failed", {
          cli: cliId,
          scope,
          supported_scopes: integration.scopes,
        });
      } catch {}
      throw new CliError(
        `Scope "${scope}" is not supported by ${integration.displayName}. ` +
          `Valid scopes: ${integration.scopes.join(", ")}`
      );
    }
  }

  const binaryPath = resolveFailproofaiBinary();

  // Capture existing config before overwriting (used for telemetry diff)
  const previousConfig = readScopedHooksConfig(scope, cwd);
  const previousEnabled = new Set(previousConfig.enabledPolicies);

  let selectedPolicies: string[];

  if (policyNames !== undefined) {
    // Non-interactive path: explicit array was provided (may be empty)
    let incoming: string[];
    if (policyNames.length === 1 && policyNames[0] === "all") {
      incoming = BUILTIN_POLICIES
        .filter((p) => includeBeta || !p.beta)
        .map((p) => p.name);
    } else {
      incoming = policyNames;
    }
    // Additive: union with whatever was already enabled, deduplicated.
    selectedPolicies = [...new Set([...previousConfig.enabledPolicies, ...incoming])];
  } else {
    // Interactive — pre-load current config if it exists
    const preSelected = previousConfig.enabledPolicies.length > 0 ? previousConfig.enabledPolicies : undefined;
    selectedPolicies = await promptPolicySelection(preSelected, { includeBeta });
  }

  // Preserve existing config fields (policyParams, customPoliciesPath, llm) when updating
  const configToWrite = { ...previousConfig, enabledPolicies: selectedPolicies };
  if (removeCustomHooks) {
    delete configToWrite.customPoliciesPath;
  } else if (customPoliciesPath) {
    configToWrite.customPoliciesPath = resolve(customPoliciesPath);
    // Validate the file before committing it to config
    let validatedHooks: Awaited<ReturnType<typeof loadCustomHooks>> = [];
    try {
      validatedHooks = await loadCustomHooks(configToWrite.customPoliciesPath, { strict: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await trackHookEvent(getInstanceId(), "custom_policy_validation_failed", {
          scope,
          error_type: /not found/i.test(msg) ? "file_not_found" : "load_error",
        });
      } catch {}
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
    if (validatedHooks.length === 0) {
      try {
        await trackHookEvent(getInstanceId(), "custom_policy_validation_failed", {
          scope,
          error_type: "no_hooks_registered",
        });
      } catch {}
      console.error(
        `Error: no hooks registered in ${customPoliciesPath}. ` +
          `Make sure your file calls customPolicies.add(...) at least once.`,
      );
      process.exit(1);
    }
    console.log(
      `\nValidated ${validatedHooks.length} custom hook(s): ${validatedHooks.map((h) => h.name).join(", ")}`,
    );
  }
  writeScopedHooksConfig(configToWrite, scope, cwd);
  console.log(`\nEnabled ${selectedPolicies.length} policy(ies): ${selectedPolicies.join(", ")}\n`);
  if (removeCustomHooks) {
    console.log("Custom hooks path cleared.");
  } else if (configToWrite.customPoliciesPath) {
    console.log(`Custom hooks path: ${configToWrite.customPoliciesPath}`);
  }

  // Write hooks for each selected CLI
  const writtenSettingsPaths: { cli: IntegrationType; path: string }[] = [];
  for (const cliId of selectedClis) {
    const integration = getIntegration(cliId);
    const settingsPath = integration.getSettingsPath(scope, cwd);
    try {
      const settings = integration.readSettings(settingsPath);
      integration.writeHookEntries(settings, binaryPath, scope);
      integration.writeSettings(settingsPath, settings);
      writtenSettingsPaths.push({ cli: cliId, path: settingsPath });
    } catch (err) {
      const errorType = err instanceof Error && /EACCES|EPERM/.test(err.message)
        ? "permission_denied"
        : err instanceof Error && /ENOENT|ENOTDIR/.test(err.message)
          ? "path_not_found"
          : "write_error";
      try {
        await trackHookEvent(getInstanceId(), "hook_write_failed", {
          cli: cliId,
          scope,
          error_type: errorType,
        });
      } catch {}
      throw err;
    }
  }

  // Telemetry: track successful hook installation (with diff vs previous config)
  try {
    const newSet = new Set(selectedPolicies);
    const policiesAdded = selectedPolicies.filter((p) => !previousEnabled.has(p));
    const policiesRemoved = [...previousEnabled].filter((p) => !newSet.has(p));
    const distinctId = getInstanceId();
    await trackHookEvent(distinctId, "hooks_installed", {
      scope,
      cli: selectedClis,
      cli_count: selectedClis.length,
      policies: selectedPolicies,
      policy_count: selectedPolicies.length,
      policies_added: policiesAdded,
      policies_removed: policiesRemoved,
      ...(source ? { source } : {}),
      platform: platform(),
      arch: arch(),
      os_release: release(),
      hostname_hash: hashToId(hostname()),
      has_custom_hooks_path: !!(configToWrite.customPoliciesPath),
      has_policy_params: !!(configToWrite.policyParams && Object.keys(configToWrite.policyParams).length > 0),
      param_policy_names: configToWrite.policyParams ? Object.keys(configToWrite.policyParams) : [],
      command_format: scope === "project" ? "npx" : "absolute",
    });

    if (includeBeta) {
      const betaNames = new Set(BUILTIN_POLICIES.filter((p) => p.beta).map((p) => p.name));
      const installedBeta = selectedPolicies.filter((p) => betaNames.has(p));
      if (installedBeta.length > 0) {
        await trackHookEvent(distinctId, "beta_policies_installed", {
          scope,
          cli: selectedClis,
          beta_count: installedBeta.length,
          beta_policy_names: installedBeta,
          ...(source ? { source } : {}),
        });
      }
    }
  } catch {
    // Telemetry is best-effort — never block the operation
  }

  for (const { cli: cliId, path } of writtenSettingsPaths) {
    const integration = getIntegration(cliId);
    console.log(
      `Failproof AI hooks installed for ${integration.displayName} ` +
        `(${integration.eventTypes.length} event types, scope: ${scope}).`
    );
    console.log(`Settings: ${path}`);
  }
  if (scope === "project") {
    console.log(`Command:  npx -y failproofai`);
    console.log(`\nThis file can be committed to git — no machine-specific paths.`);
  } else {
    console.log(`Binary:   ${binaryPath}`);
  }

  // Warn about duplicate-scope installations (Claude Code only — uses HOOK_SCOPES)
  const otherScopes = deduplicateScopes(HOOK_SCOPES, cwd).filter((s) => s !== scope);
  const duplicates = otherScopes.filter((s) => hooksInstalledInSettings(s, cwd));
  if (duplicates.length > 0) {
    const scopeList = duplicates.map((s) => `${s} (${scopeLabel(s)})`).join(", ");
    console.log();
    console.log(`\x1B[33mWarning: Failproof AI hooks are also installed at ${scopeList}.\x1B[0m`);
    console.log(`Having hooks in multiple scopes may cause duplicate policy evaluation.`);
    console.log(`Use \`failproofai policies --uninstall --scope ${duplicates[0]}\` to remove the other installation,`);
    console.log(`or \`failproofai policies\` to see all scopes.`);
    try {
      await trackHookEvent(getInstanceId(), "multi_scope_warning_shown", {
        new_scope: scope,
        existing_scopes: duplicates,
        cli: selectedClis,
      });
    } catch {}
  }
}

/**
 * Remove hooks from Claude Code settings.
 *
 * @param policyNames — if provided:
 *   - `undefined` or `["all"]` → remove all failproofai hooks from settings (original behavior)
 *   - `["block-sudo"]` → disable specific policies in config, keep hooks installed
 * @param scope — settings scope to remove from (default: "user"), or "all" to remove from all scopes
 * @param opts.betaOnly — set to true when removing only beta policies (adds beta_only flag to telemetry)
 */
export async function removeHooks(policyNames?: string[], scope: HookScope | "all" = "user", cwd?: string, opts?: { betaOnly?: boolean; source?: string; removeCustomHooks?: boolean; cli?: IntegrationType[] }): Promise<void> {
  // Resolve the effective config scope ("all" falls back to "user" for config reads/writes)
  const configScope: HookScope = scope === "all" ? "user" : scope;
  // Back-compat default: ["claude"]. The bin layer prompts for CLI selection
  // when --cli is omitted and an interactive TTY is attached.
  const selectedClis: IntegrationType[] =
    opts?.cli && opts.cli.length > 0 ? [...new Set(opts.cli)] : ["claude"];

  // Clear custom hooks path if requested
  if (opts?.removeCustomHooks) {
    const config = readScopedHooksConfig(configScope, cwd);
    delete config.customPoliciesPath;
    writeScopedHooksConfig(config, configScope, cwd);
    console.log("Custom hooks path cleared.");
  }

  // Remove specific policies from config (keep hooks installed)
  if (policyNames && policyNames.length > 0 && !(policyNames.length === 1 && policyNames[0] === "all")) {
    validatePolicyNames(policyNames);
    const config = readScopedHooksConfig(configScope, cwd);
    const removeSet = new Set(policyNames);
    const remaining = config.enabledPolicies.filter((p) => !removeSet.has(p));
    const notEnabled = policyNames.filter((p) => !config.enabledPolicies.includes(p));
    if (notEnabled.length > 0) {
      console.log(`Warning: policy(ies) not currently enabled: ${notEnabled.join(", ")}`);
    }
    const { policyParams: existingParams, ...baseConfig } = config;
    const filteredParams = existingParams
      ? Object.fromEntries(Object.entries(existingParams).filter(([k]) => !removeSet.has(k)))
      : null;
    const updatedConfig: HooksConfig = {
      ...baseConfig,
      enabledPolicies: remaining,
      ...(filteredParams && Object.keys(filteredParams).length > 0 ? { policyParams: filteredParams } : {}),
    };
    writeScopedHooksConfig(updatedConfig, configScope, cwd);

    // Telemetry: track policy-only removal from config
    try {
      const distinctId = getInstanceId();
      const actuallyRemoved = policyNames.filter((p) => config.enabledPolicies.includes(p));
      await trackHookEvent(distinctId, "hooks_removed", {
        scope,
        cli: selectedClis,
        removal_mode: opts?.betaOnly ? "beta_policies" : "policies",
        beta_only: opts?.betaOnly ?? false,
        policies_removed: actuallyRemoved,
        removed_count: actuallyRemoved.length,
        ...(opts?.source ? { source: opts.source } : {}),
        platform: platform(),
        arch: arch(),
        os_release: release(),
        hostname_hash: hashToId(hostname()),
      });
    } catch {
      // Telemetry is best-effort — never block the operation
    }

    console.log(`Disabled ${policyNames.length - notEnabled.length} policy(ies).`);
    console.log(`Remaining: ${remaining.length > 0 ? remaining.join(", ") : "(none)"}`);
    return;
  }

  // Capture enabled policies before clearing (used for accurate telemetry below)
  const configBeforeRemoval = readScopedHooksConfig(configScope, cwd);

  // Remove failproofai hooks from each selected CLI's settings file(s)
  let totalRemoved = 0;
  let nothingToReport = false;

  for (const cliId of selectedClis) {
    const integration = getIntegration(cliId);
    // For "all" scope, iterate over the integration's scopes; otherwise, only
    // touch the single scope (skipping CLIs that don't support it).
    const scopesToRemove: HookScope[] =
      scope === "all"
        ? [...integration.scopes]
        : integration.scopes.includes(scope)
          ? [scope]
          : [];

    for (const s of scopesToRemove) {
      const settingsPath = integration.getSettingsPath(s, cwd);

      if (!existsSync(settingsPath)) {
        if (scope !== "all" && selectedClis.length === 1) {
          console.log("No settings file found. Nothing to remove.");
          nothingToReport = true;
        }
        continue;
      }

      const removed = integration.removeHooksFromFile(settingsPath);
      if (removed === 0 && scope !== "all" && selectedClis.length === 1) {
        console.log("No hooks found in settings. Nothing to remove.");
        nothingToReport = true;
        continue;
      }
      totalRemoved += removed;

      if (scope !== "all") {
        console.log(`Removed ${removed} failproofai hook(s) from ${integration.displayName} settings.`);
        console.log(`Settings: ${settingsPath}`);
      }
    }
  }

  if (nothingToReport && totalRemoved === 0) return;

  if (scope === "all") {
    console.log(`Removed ${totalRemoved} failproofai hook(s) from all scopes.`);
    for (const cliId of selectedClis) {
      const integration = getIntegration(cliId);
      for (const s of integration.scopes) {
        console.log(`  ${integration.displayName} / ${s}: ${integration.getSettingsPath(s, cwd)}`);
      }
    }
  }

  // Telemetry: track full hook removal from settings
  try {
    const distinctId = getInstanceId();
    await trackHookEvent(distinctId, "hooks_removed", {
      scope,
      cli: selectedClis,
      removal_mode: "hooks",
      policies_removed: configBeforeRemoval.enabledPolicies,
      removed_count: totalRemoved,
      ...(opts?.source ? { source: opts.source } : {}),
      platform: platform(),
      arch: arch(),
      os_release: release(),
      hostname_hash: hashToId(hostname()),
    });
  } catch {
    // Telemetry is best-effort — never block the operation
  }

  // Clear policy config when removing from all scopes, or when no hooks remain in any scope
  if (scope === "all") {
    // Clear config across all three scopes
    for (const s of HOOK_SCOPES) {
      const existing = readScopedHooksConfig(s, cwd);
      if (existing.enabledPolicies.length > 0 || existing.customPoliciesPath || existing.policyParams) {
        const { customPoliciesPath: _drop, policyParams: _dropParams, ...rest } = existing;
        writeScopedHooksConfig({ ...rest, enabledPolicies: [] }, s, cwd);
      }
    }
  } else if (!HOOK_SCOPES.some((s) => hooksInstalledInSettings(s, cwd))) {
    const existing = readScopedHooksConfig(configScope, cwd);
    const { customPoliciesPath: _drop, policyParams: _dropParams, ...rest } = existing;
    writeScopedHooksConfig({ ...rest, enabledPolicies: [] }, configScope, cwd);
  }
}

/**
 * List all available policies with their per-scope enabled status.
 * Layout adapts to the number of installed scopes:
 *   0 scopes: compact "not installed" summary
 *   1 scope:  table with header + checkmarks, beta policies in a separate section
 *   2+ scopes: column table with per-scope status, beta policies in a separate section
 *
 * Also shows:
 *   - Configured policyParams values beneath each policy
 *   - Warnings for unknown policyParams keys
 *   - Custom Hooks section if customPoliciesPath is set
 */
export async function listHooks(cwd?: string): Promise<void> {
  const config = readMergedHooksConfig(cwd);
  const enabledSet = new Set(config.enabledPolicies);

  // Determine which scopes have hooks installed (deduplicate when paths overlap, e.g. cwd === home)
  const uniqueScopes = deduplicateScopes(HOOK_SCOPES, cwd);
  const installedScopes = uniqueScopes.filter((s) => hooksInstalledInSettings(s, cwd));

  // Separate beta from regular policies
  const regularPolicies = BUILTIN_POLICIES.filter((p) => !p.beta);
  const betaPolicies = BUILTIN_POLICIES.filter((p) => p.beta);

  // Dynamic name column width based on longest policy name
  const nameColWidth = Math.max(...BUILTIN_POLICIES.map((p) => p.name.length)) + 2;

  // All known builtin policy names (for unknown policyParams key detection)
  const builtinPolicyNames = new Set(BUILTIN_POLICIES.map((p) => p.name));

  // Helper: print params summary lines beneath a policy row
  const printParamsSummary = (policyName: string, indent: string) => {
    const params = config.policyParams?.[policyName];
    if (!params) return;
    for (const [key, val] of Object.entries(params)) {
      console.log(`${indent}  ${key}: ${JSON.stringify(val)}`);
    }
  };

  const statusCol = 8;
  const printSimpleRow = (policy: { name: string; description: string }) => {
    const mark = enabledSet.has(policy.name) ? `\x1B[32m\u2713\x1B[0m` : " ";
    console.log(`  ${mark}${" ".repeat(statusCol - 1)}${policy.name.padEnd(nameColWidth)}${policy.description}`);
    printParamsSummary(policy.name, `  ${" ".repeat(statusCol)}`);
  };
  const printBetaSection = (printRow: (p: { name: string; description: string }) => void) => {
    if (betaPolicies.length > 0) {
      console.log(`\n  \x1B[2m\u2500\u2500 Beta \u2500\u2500\x1B[0m`);
      for (const policy of betaPolicies) printRow(policy);
    }
  };

  if (installedScopes.length === 0) {
    // State A: No hooks installed — show table with configured state + descriptions
    console.log("\nFailproof AI Policies \u2014 not installed\n");

    console.log(`  ${"Status".padEnd(statusCol)}${"Name".padEnd(nameColWidth)}Description`);
    console.log(`  ${"\u2500".repeat(6)}  ${"\u2500".repeat(nameColWidth - 2)}  ${"\u2500".repeat(38)}`);

    for (const policy of regularPolicies) printSimpleRow(policy);
    printBetaSection(printSimpleRow);

    if (config.enabledPolicies.length > 0) {
      console.log("\n  Policies not installed. Run `failproofai policies --install` to activate.");
    } else {
      console.log("\n  Run `failproofai policies --install` to get started.");
    }
    console.log("  Config: ~/.failproofai/policies-config.json\n");
  } else if (installedScopes.length === 1) {
    // State B: Single scope — table with header row
    const scope = installedScopes[0];
    console.log(`\nFailproof AI Hook Policies (${scope})\n`);

    console.log(`  ${"Status".padEnd(statusCol)}${"Name".padEnd(nameColWidth)}Description`);
    console.log(`  ${"\u2500".repeat(6)}  ${"\u2500".repeat(nameColWidth - 2)}  ${"\u2500".repeat(38)}`);

    for (const policy of regularPolicies) printSimpleRow(policy);
    printBetaSection(printSimpleRow);

    console.log("\n  Config: ~/.failproofai/policies-config.json\n");
  } else {
    // State C: Multiple scopes — column table
    const COL = 9;
    const scopeLabelMap: Record<HookScope, string> = {
      user: "User",
      project: "Project",
      local: "Local",
    };

    console.log("\nFailproof AI Hook Policies\n");

    // Header with only installed scope columns + separator
    const buildScopePrefix = () => {
      let s = "  ";
      for (const sc of installedScopes) s += scopeLabelMap[sc].padEnd(COL);
      return s;
    };
    const scopeHeaderWidth = installedScopes.length * COL;
    console.log(`${buildScopePrefix()}${"Name".padEnd(nameColWidth)}Description`);
    console.log(`  ${"\u2500".repeat(scopeHeaderWidth)}${"\u2500".repeat(nameColWidth)}${"\u2500".repeat(38)}`);

    const printMultiScopeRow = (policy: { name: string; description: string }) => {
      const enabled = enabledSet.has(policy.name);
      let row = "  ";
      for (const _scope of installedScopes) {
        if (enabled) {
          row += `\x1B[32m\u2713 ON\x1B[0m` + " ".repeat(COL - 4);
        } else {
          row += "  OFF" + " ".repeat(COL - 5);
        }
      }
      row += policy.name.padEnd(nameColWidth) + policy.description;
      console.log(row);
      printParamsSummary(policy.name, `  ${" ".repeat(scopeHeaderWidth)}`);
    };

    for (const policy of regularPolicies) printMultiScopeRow(policy);

    if (betaPolicies.length > 0) {
      console.log(`\n  \x1B[2m\u2500\u2500 Beta \u2500\u2500\x1B[0m`);
      for (const policy of betaPolicies) printMultiScopeRow(policy);
    }

    console.log("\n  Config: ~/.failproofai/policies-config.json");

    // Multi-scope warning
    const scopeNames = installedScopes.join(", ");
    console.log();
    console.log(`\x1B[33m\u26A0 Hooks in multiple scopes (${scopeNames}).\x1B[0m`);
    console.log("  Consider keeping one. Remove with: failproofai policies --uninstall --scope <scope>\n");
  }

  // Warn about unknown policyParams keys
  if (config.policyParams) {
    const unknownKeys: string[] = [];
    for (const key of Object.keys(config.policyParams)) {
      if (!builtinPolicyNames.has(key)) {
        console.log(`  \x1B[33mWarning: unknown policyParams key "${key}" — possible typo\x1B[0m`);
        unknownKeys.push(key);
      }
    }
    if (unknownKeys.length > 0) {
      try {
        await trackHookEvent(getInstanceId(), "policy_params_validation_warning", {
          unknown_keys_count: unknownKeys.length,
          unknown_keys: unknownKeys,
        });
      } catch {}
    }
  }

  // Custom Policies section
  if (config.customPoliciesPath) {
    console.log(`\n  \u2500\u2500 Custom Policies (${config.customPoliciesPath}) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    if (!existsSync(config.customPoliciesPath)) {
      console.log(`  \x1B[31m\u2717 File not found: ${config.customPoliciesPath}\x1B[0m`);
    } else {
      const hooks = await loadCustomHooks(config.customPoliciesPath);
      if (hooks.length === 0) {
        console.log(`  \x1B[31m\u2717 ERR  failed to load (check ~/.failproofai/logs/hooks.log)\x1B[0m`);
      } else {
        const descColWidth = nameColWidth;
        for (const hook of hooks) {
          console.log(`  \x1B[32m\u2713\x1B[0m       ${hook.name.padEnd(descColWidth)}${hook.description ?? ""}`);
        }
      }
    }
    console.log();
  }

  // Convention Policies section (.failproofai/policies/*policies.{js,mjs,ts})
  const base = cwd ? resolve(cwd) : process.cwd();
  const conventionDirs: { label: string; dir: string }[] = [
    { label: "Project", dir: resolve(base, ".failproofai", "policies") },
    { label: "User", dir: resolve(homedir(), ".failproofai", "policies") },
  ];

  for (const { label, dir } of conventionDirs) {
    const files = discoverPolicyFiles(dir);
    if (files.length === 0) continue;

    console.log(`\n  \u2500\u2500 Convention Policies \u2014 ${label} (${dir}) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    for (const file of files) {
      try {
        const hooks = await loadCustomHooks(file);
        if (hooks.length === 0) {
          const filename = basename(file);
          console.log(`  \x1B[31m\u2717\x1B[0m       ${filename.padEnd(nameColWidth)}\x1B[31mfailed to load\x1B[0m`);
        } else {
          const filename = basename(file);
          const hookSummary = hooks.map((h) => h.name).join(", ");
          console.log(`  \x1B[32m\u2713\x1B[0m       ${filename.padEnd(nameColWidth)}${hooks.length} hook(s): ${hookSummary}`);
        }
      } catch {
        const filename = basename(file);
        console.log(`  \x1B[31m\u2717\x1B[0m       ${filename.padEnd(nameColWidth)}\x1B[31merror\x1B[0m`);
      }
    }
    console.log();
  }
}
