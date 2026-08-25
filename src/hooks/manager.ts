/**
 * Install/remove/list failproofai hooks for one or more agent harnesses.
 *
 * Per-CLI path resolution and settings I/O live in `./integrations` (one
 * `Integration` impl per CLI). This module orchestrates: validation, policy
 * selection, telemetry, multi-scope warnings, and console output.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { platform, arch, release, hostname } from "node:os";
import {
  HOOK_SCOPES,
  type HookScope,
  type IntegrationType,
} from "./types";
import { claudeCode, getIntegration, settingsPathsFor } from "./integrations";
import { promptPolicySelection } from "./install-prompt";
import { configuredCustomPolicyPaths, readMergedHooksConfig, readScopedHooksConfig, writeScopedHooksConfig, syncConventionPolicies, findProjectConfigDir } from "./hooks-config";
import type { HooksConfig, ConventionPolicyRecord } from "./policy-types";
import { BUILTIN_POLICIES } from "./builtin-policies";
import { loadCustomHooks, discoverPolicyFiles } from "./custom-hooks-loader";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId, hashToId } from "../../lib/telemetry-id";
import { CliError } from "../cli-error";
import { hookLogWarn } from "./hook-logger";
import { customPoliciesDir, globalPolicyConfigFile } from "./fp-home";
import { readActiveCloudManagedPolicies } from "./cloud-managed-policies";
import { CORE_SOURCE, addPack, setPackPolicyEnabled } from "./pack-store";
import type { ResolvedPack } from "./pack-manifest";
import { hasInstalledPacks, readInstalledPacks } from "./pack-manifest";
import {
  chip,
  note,
  nextStep,
  optsFor,
  printBlock,
  rule,
  stack,
  table,
  title,
  warning,
  type ChipState,
  type TableRow,
} from "./tui";

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

/** One policy of one installed pack, resolved from a name the user typed. */
interface PackPolicyRef {
  packId: string;
  packVersion: string;
  name: string;
  /** The `disabledCustomPolicies` entry the dashboard writes for it. */
  disabledKey: string;
}

/**
 * Split names the user typed into builtins and installed-pack policies.
 *
 * Without this, every name went through `validatePolicyNames`, whose set is the
 * compiled builtins — so `policies --disable block-big-refund` on a pack the
 * user had just installed answered "Unknown policy name" and listed 39 names
 * that were not the one they meant. A pack could be installed and then not
 * managed at all.
 *
 * A builtin wins a bare name, because that is the name people have typed for a
 * year and a third-party pack must not be able to capture it. Two packs
 * declaring the same name is the one case that cannot be guessed, so it is
 * refused with the qualified `<pack-id>:<name>` form spelled out.
 */
function resolvePolicyNames(names: string[]): { builtins: string[]; packs: PackPolicyRef[] } {
  const builtins: string[] = [];
  const packs: PackPolicyRef[] = [];
  const unknown: string[] = [];

  let installed: ResolvedPack[] = [];
  try {
    installed = readInstalledPacks().packs;
  } catch {
    // No packs, or an unreadable manifest: names simply resolve as builtins and
    // an unknown one gets the ordinary error. A listing-adjacent command must
    // not fail because a pack manifest is corrupt.
  }

  const refsFor = (packId: string | null, policyName: string): PackPolicyRef[] =>
    installed
      .filter((pack) => (packId === null || pack.id === packId))
      .filter((pack) => pack.policies.some((p) => p.name === policyName))
      .map((pack) => ({
        packId: pack.id,
        packVersion: pack.version,
        name: policyName,
        disabledKey: `pack:${pack.id}@${pack.version}:${policyName}`,
      }));

  for (const raw of names) {
    // A PACK first, then the compiled set. This order is the whole fix for
    // `policy remove block-sudo` printing "Disabled 0" while `block-sudo` kept
    // denying: the name resolved to a builtin, the command edited
    // `enabledPolicies`, and `enabledPolicies` stopped deciding anything when
    // this build stopped registering builtins. The pack is where the switch is.
    const direct = refsFor(null, raw);
    if (direct.length === 1) {
      packs.push(direct[0]);
      continue;
    }
    if (direct.length > 1) {
      throw new CliError(
        `"${raw}" is declared by ${direct.length} installed packs.\n` +
          `Name the one you mean:\n` +
          direct.map((m) => `  ${m.packId}:${m.name}`).join("\n"),
      );
    }
    // No pack carries it. Falls back to the compiled name set, which is what a
    // machine still running on the migration shim has.
    if (VALID_POLICY_NAMES.has(raw)) {
      builtins.push(raw);
      continue;
    }
    // `acme/finance:block-big-refund` — a pack id holds a slash, never a colon,
    // so the last colon separates them unambiguously.
    const colon = raw.lastIndexOf(":");
    const qualified = colon > 0
      ? { packId: raw.slice(0, colon), name: raw.slice(colon + 1) }
      : null;
    const matches = qualified
      ? refsFor(qualified.packId, qualified.name)
      : refsFor(null, raw);

    if (matches.length === 1) {
      packs.push(matches[0]);
      continue;
    }
    if (matches.length > 1) {
      throw new CliError(
        `"${raw}" is declared by ${matches.length} installed packs.\n` +
          `Name the one you mean:\n` +
          matches.map((m) => `  ${m.packId}:${m.name}`).join("\n"),
      );
    }
    unknown.push(raw);
  }

  if (unknown.length > 0) {
    const packNames = installed.flatMap((pack) =>
      pack.policies.map((p) => `${pack.id}:${p.name}`),
    );
    throw new CliError(
      `Unknown policy name(s): ${unknown.join(", ")}\n` +
        `Valid policies: ${[...VALID_POLICY_NAMES].join(", ")}` +
        (packNames.length > 0 ? `\nFrom installed packs: ${packNames.join(", ")}` : ""),
    );
  }
  return { builtins, packs };
}

/** Turn pack policies on or off, and say what happened. */
function applyPackPolicies(
  refs: PackPolicyRef[],
  on: boolean,
  scope: HookScope,
  cwd?: string,
): void {
  if (refs.length === 0) return;
  for (const ref of refs) {
    const result = setPackPolicyEnabled(ref.packId, ref.name, on);
    if (!result.ok) {
      throw new CliError(`Could not ${on ? "enable" : "disable"} ${ref.name}: ${result.reason}`);
    }
  }
  if (on) {
    // Clearing the dashboard's key too. The selection and the disabled key are
    // two different switches for one policy, and leaving the second one set
    // would report the policy enabled while it stayed off.
    const config = readScopedHooksConfig(scope, cwd);
    const keys = new Set(refs.map((r) => r.disabledKey));
    const remaining = (config.disabledCustomPolicies ?? []).filter((k) => !keys.has(k));
    if (remaining.length !== (config.disabledCustomPolicies ?? []).length) {
      const next: HooksConfig = { ...config, disabledCustomPolicies: remaining };
      if (remaining.length === 0) delete next.disabledCustomPolicies;
      writeScopedHooksConfig(next, scope, cwd);
    }
  }
  for (const ref of refs) {
    console.log(
      `${on ? "Enabled" : "Disabled"} ${ref.name} from pack ${ref.packId}@${ref.packVersion}.`,
    );
  }
}

/**
 * Refuse to "disable" a policy that will register anyway.
 *
 * Removing an `alwaysOn` name from `enabledPolicies` succeeds at the file level
 * and changes nothing at the enforcement level, so without this the CLI reports
 * a policy disabled while it keeps denying — the operator's mental model and the
 * machine's behaviour diverge silently, which is the failure this policy exists
 * to prevent in the first place.
 */
function rejectAlwaysOnPolicies(names: string[]): void {
  const alwaysOn = new Set(BUILTIN_POLICIES.filter((p) => p.alwaysOn).map((p) => p.name));
  const refused = names.filter((n) => alwaysOn.has(n));
  if (refused.length > 0) {
    throw new CliError(
      `Cannot disable: ${refused.join(", ")}\n` +
      `This policy stops an agent from switching off failproofai itself, so it ` +
      `is always on and ships with the package. A guard the agent can disable ` +
      `by the means it is meant to prevent is not a guard.`
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

export interface InstallHooksOptions {
  /** Replace the enabled set at this scope instead of unioning (default: additive). */
  replace?: boolean;
  /** Suppress this module's installation logging (for callers that render their
   * own UI, like the configure wizard). Errors still surface via console.error. */
  quiet?: boolean;
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
  customPoliciesPath?: string | string[],
  removeCustomHooks = false,
  cli?: IntegrationType[],
  options: InstallHooksOptions = {},
): Promise<void> {
  const { replace = false, quiet = false } = options;
  if (!quiet) {
    return installHooksImpl(
      policyNames, scope, cwd, includeBeta, source, customPoliciesPath, removeCustomHooks, cli, replace,
    );
  }
  // Quiet mode: this module logs exclusively via console.log, so muting it for
  // the duration of the call silences installation output at its owner rather
  // than at every call site. console.error (real failures) still flows.
  const origLog = console.log;
  console.log = () => {};
  try {
    return await installHooksImpl(
      policyNames, scope, cwd, includeBeta, source, customPoliciesPath, removeCustomHooks, cli, replace,
    );
  } finally {
    console.log = origLog;
  }
}

async function installHooksImpl(
  policyNames?: string[],
  scope: HookScope = "user",
  cwd?: string,
  includeBeta = false,
  source?: string,
  customPoliciesPath?: string | string[],
  removeCustomHooks = false,
  cli?: IntegrationType[],
  replace = false,
): Promise<void> {
  // Validate user input first before any system checks
  if (policyNames !== undefined && policyNames.length > 0) {
    const nonAllNames = policyNames.filter((n) => n !== "all");
    // Check unknown names first (most actionable error for the user). Pack
    // policies are applied here and taken out of the list: the rest of this
    // function writes `enabledPolicies`, which is a builtin-only set.
    if (nonAllNames.length > 0) {
      const resolved = resolvePolicyNames(nonAllNames);
      applyPackPolicies(resolved.packs, true, scope, cwd);
      if (resolved.packs.length > 0) {
        policyNames = policyNames.filter((n) => n === "all" || resolved.builtins.includes(n));
        // Named ONLY pack policies: the work is done. Carrying on would resolve
        // the failproofai binary and rewrite every CLI's settings to enable a
        // set of builtins nobody asked about — and would fail outright on a
        // machine where the binary is not on PATH, AFTER the pack change landed.
        if (policyNames.length === 0) return;
      }
    }
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
    // Default is additive (union with whatever was already enabled). The
    // configure wizard passes replace=true so the chosen set becomes the full
    // enabled set at this scope (unticking a policy actually removes it).
    selectedPolicies = replace
      ? [...new Set(incoming)]
      : [...new Set([...previousConfig.enabledPolicies, ...incoming])];
  } else {
    // Interactive — pre-load current config if it exists
    const preSelected = previousConfig.enabledPolicies.length > 0 ? previousConfig.enabledPolicies : undefined;
    selectedPolicies = await promptPolicySelection(preSelected, { includeBeta });
  }

  // Preserve existing config fields when updating. New writes use the plural
  // form, while reads continue to accept the legacy singular field.
  const configToWrite = { ...previousConfig, enabledPolicies: selectedPolicies };
  if (removeCustomHooks) {
    delete configToWrite.customPoliciesPath;
    delete configToWrite.customPoliciesPaths;
  } else if (
    customPoliciesPath &&
    (typeof customPoliciesPath === "string" || customPoliciesPath.length > 0)
  ) {
    const incoming = (typeof customPoliciesPath === "string" ? [customPoliciesPath] : customPoliciesPath)
      .map((path) => resolve(path));

    // Additive by default, mirroring `enabledPolicies` directly above: a second
    // `--custom` ADDS to what is configured rather than silently discarding it.
    // Replacing was the surprising half of the old single-path field — running
    // `-c a` then `-c b` left only `b`, with nothing printed to say `a` had
    // stopped applying. `replace` (passed by the configure wizard) still makes
    // the given set authoritative, exactly as it does for enabled policies.
    //
    // Carried-over paths are filtered by existence first: a file deleted after
    // it was configured must not make every future install fail, which is what
    // the strict validation below would do.
    const carried = (
      previousConfig.customPoliciesPaths ??
      (previousConfig.customPoliciesPath ? [previousConfig.customPoliciesPath] : [])
    )
      .map((path) => resolve(path))
      .filter((path) => {
        if (existsSync(path)) return true;
        console.log(`Dropping custom policies path (file no longer exists): ${path}`);
        return false;
      });

    configToWrite.customPoliciesPaths = replace
      ? [...new Set(incoming)]
      : [...new Set([...carried, ...incoming])];
    delete configToWrite.customPoliciesPath;

    // Validate only what this invocation added. Carried-over paths were
    // validated when they were added, and re-validating them here would let one
    // stale file block an unrelated install.
    for (const path of incoming) {
      let validatedHooks: Awaited<ReturnType<typeof loadCustomHooks>> = [];
      try {
        validatedHooks = await loadCustomHooks(path, { strict: true });
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
          `Error: no hooks registered in ${path}. ` +
            `Make sure your file calls customPolicies.add(...) at least once.`,
        );
        process.exit(1);
      }
      console.log(
        `\nValidated ${validatedHooks.length} custom hook(s) from ${path}: ${validatedHooks.map((h) => h.name).join(", ")}`,
      );
    }
  }
  writeScopedHooksConfig(configToWrite, scope, cwd);

  // Choosing policies IS selecting from the pack now. Nothing registers these
  // names from this build any more, so writing `enabledPolicies` and stopping
  // would leave a freshly set-up machine enforcing nothing at all — which is
  // the failure mode this whole product exists to prevent.
  //
  // Fetched from the pack's GitHub release: there is no copy in this package,
  // cannot fail behind a proxy, and the machine is guarded the moment it is
  // configured rather than the moment it next reaches github.com.
  // The always-on guard is excluded: a pack may not declare `alwaysOn`, so the
  // pack does not carry it and asking for it by name is a selection the pack
  // cannot satisfy. It ships compiled in and registers regardless.
  const alwaysOnNames = new Set(BUILTIN_POLICIES.filter((p) => p.alwaysOn).map((p) => p.name));
  const fromPack = selectedPolicies.filter((name) => !alwaysOnNames.has(name));
  if (fromPack.length > 0) {
    // ONLY when there is no pack yet. Fetching the core pack with
    // `only: <selection>` REPLACES whatever the machine had chosen, and
    // `selectedPolicies` is derived from `enabledPolicies` — which is empty on a
    // machine whose pack came from `pack add core`. `policy add block-rm-rf`
    // therefore took a machine from ten guards to one, silently, and nine
    // policies went from denying to allowing.
    //
    // With a pack already installed the names are switched on individually
    // instead, which is additive and touches nothing else.
    if (!hasInstalledPacks()) {
      // Fetched, not unpacked from this package: there is no copy in here any
      // more. That makes this the one path in `policies --install` that needs
      // the network, so its failure is reported rather than thrown — the names
      // are already written to config, and the no-pack fallback enforces them
      // until a pack arrives.
      try {
        await addPack(CORE_SOURCE, { only: fromPack });
      } catch (err) {
        console.log(
          `\nWarning: could not fetch the policy pack (${err instanceof Error ? err.message : String(err)}).\n` +
            `Run \`failproofai policies add core\` once you are online.`,
        );
      }
    } else {
      for (const name of fromPack) {
        for (const pack of readInstalledPacks().packs) {
          if (pack.policies.some((p) => p.name === name)) {
            setPackPolicyEnabled(pack.id, name, true);
            break;
          }
        }
      }
    }
  }
  console.log(`\nEnabled ${selectedPolicies.length} policy(ies): ${selectedPolicies.join(", ")}\n`);
  if (removeCustomHooks) {
    console.log("Custom hooks path cleared.");
  } else if (configToWrite.customPoliciesPaths?.length || configToWrite.customPoliciesPath) {
    const paths = configToWrite.customPoliciesPaths ?? [configToWrite.customPoliciesPath!];
    console.log(`Custom hooks paths: ${paths.join(", ")}`);
  }

  // Write hooks for each selected CLI
  const writtenSettingsPaths: { cli: IntegrationType; path: string }[] = [];
  for (const cliId of selectedClis) {
    const integration = getIntegration(cliId);
    // Usually one path; Hermes returns one per profile (each is a separate home
    // dir with its own config.yaml, and a missed one runs unhooked in silence).
    const settingsPaths = settingsPathsFor(integration, scope, cwd);
    try {
      for (const settingsPath of settingsPaths) {
        const settings = integration.readSettings(settingsPath);
        integration.writeHookEntries(settings, binaryPath, scope);
        integration.writeSettings(settingsPath, settings);
        writtenSettingsPaths.push({ cli: cliId, path: settingsPath });
      }
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
      has_custom_hooks_path: !!(configToWrite.customPoliciesPaths?.length || configToWrite.customPoliciesPath),
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
    delete config.customPoliciesPaths;
    writeScopedHooksConfig(config, configScope, cwd);
    console.log("Custom hooks path cleared.");
  }

  // Remove specific policies from config (keep hooks installed)
  if (policyNames && policyNames.length > 0 && !(policyNames.length === 1 && policyNames[0] === "all")) {
    const resolved = resolvePolicyNames(policyNames);
    applyPackPolicies(resolved.packs, false, configScope, cwd);
    policyNames = resolved.builtins;
    rejectAlwaysOnPolicies(policyNames);
    // Named ONLY pack policies: they are off now and there is nothing else to
    // do. Falling through would reach the hook-removal path below with an empty
    // name list, which is the "remove failproofai from every CLI" branch — so
    // `--uninstall <a-pack-policy>` would have torn out every hook on the
    // machine.
    if (resolved.packs.length > 0 && policyNames.length === 0) return;
  }
  if (policyNames && policyNames.length > 0 && !(policyNames.length === 1 && policyNames[0] === "all")) {
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
      // Usually one path; Hermes returns one per profile.
      const settingsPaths = settingsPathsFor(integration, s, cwd);
      const existing = settingsPaths.filter((p) => existsSync(p));

      if (existing.length === 0) {
        if (scope !== "all" && selectedClis.length === 1) {
          console.log("No settings file found. Nothing to remove.");
          nothingToReport = true;
        }
        continue;
      }

      let removedHere = 0;
      for (const settingsPath of existing) {
        const removed = integration.removeHooksFromFile(settingsPath);
        removedHere += removed;
        if (removed > 0 && scope !== "all") {
          console.log(`Removed ${removed} failproofai hook(s) from ${integration.displayName} settings.`);
          console.log(`Settings: ${settingsPath}`);
        }
      }

      if (removedHere === 0 && scope !== "all" && selectedClis.length === 1) {
        console.log("No hooks found in settings. Nothing to remove.");
        nothingToReport = true;
        continue;
      }
      totalRemoved += removedHere;
    }
  }

  if (nothingToReport && totalRemoved === 0) return;

  if (scope === "all") {
    console.log(`Removed ${totalRemoved} failproofai hook(s) from all scopes.`);
    for (const cliId of selectedClis) {
      const integration = getIntegration(cliId);
      for (const s of integration.scopes) {
        for (const p of settingsPathsFor(integration, s, cwd)) {
          console.log(`  ${integration.displayName} / ${s}: ${p}`);
        }
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
      if (existing.enabledPolicies.length > 0 || existing.customPoliciesPaths?.length || existing.customPoliciesPath || existing.policyParams) {
        const { customPoliciesPath: _drop, customPoliciesPaths: _dropMany, policyParams: _dropParams, ...rest } = existing;
        writeScopedHooksConfig({ ...rest, enabledPolicies: [] }, s, cwd);
      }
    }
  } else if (!HOOK_SCOPES.some((s) => hooksInstalledInSettings(s, cwd))) {
    const existing = readScopedHooksConfig(configScope, cwd);
    const { customPoliciesPath: _drop, customPoliciesPaths: _dropMany, policyParams: _dropParams, ...rest } = existing;
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
  const disabledCustomSet = new Set(config.disabledCustomPolicies ?? []);
  const opts = optsFor(process.stdout);

  // Determine which scopes have hooks installed (deduplicate when paths overlap, e.g. cwd === home)
  const uniqueScopes = deduplicateScopes(HOOK_SCOPES, cwd);
  const installedScopes = uniqueScopes.filter((s) => hooksInstalledInSettings(s, cwd));

  // Names a `policyParams` key may legitimately use: every policy an installed
  // pack carries. Previously the compiled catalog, which no longer describes
  // what runs.
  const knownPolicyNames = new Set<string>();
  try {
    for (const pack of readInstalledPacks().packs) {
      for (const policy of pack.policies) knownPolicyNames.add(policy.name);
    }
  } catch {
    // Unreadable manifest: skip the typo warning rather than invent one.
  }

  const groups: Array<string[] | null> = [];
  const packCount = (() => {
    try {
      return readInstalledPacks().packs.reduce(
        (n, pack) => n + (pack.enabled ?? pack.policies.map((p) => p.name)).length,
        0,
      );
    } catch {
      return 0;
    }
  })();
  groups.push(
    title(
      "failproofai policies",
      installedScopes.length === 0
        ? "not installed"
        : `${installedScopes.join(" + ")} · ${packCount} on`,
      opts,
    ),
  );

  if (installedScopes.length === 0) {
    groups.push(
      nextStep(
        "failproofai policies --install",
        config.enabledPolicies.length > 0
          ? "These are configured but NOT installed — no hook is running them:"
          : "Nothing is installed yet. Get started with:",
        opts,
      ),
    );
  }
  // Held back to the end rather than printed here. Everything below this point
  // is another section of the same listing, and a footer in the middle of it
  // reads as the end of the output — while a warning at the very end is the one
  // a reader scrolling back from their prompt actually sees.
  const footer: Array<string[] | null> = [note(`Config: ${globalPolicyConfigFile()}`, opts)];

  if (installedScopes.length > 1) {
    footer.push(
      warning(
        [
          `Hooks in multiple scopes (${installedScopes.join(", ")}).`,
          "Consider keeping one. Remove with: failproofai policies --uninstall --scope <scope>",
        ],
        opts,
      ),
    );
  }

  // Warn about unknown policyParams keys
  if (config.policyParams) {
    const unknownKeys: string[] = [];
    for (const key of Object.keys(config.policyParams)) {
      if (knownPolicyNames.size > 0 && !knownPolicyNames.has(key)) unknownKeys.push(key);
    }
    if (unknownKeys.length > 0) {
      footer.push(
        warning(
          unknownKeys.map((key) => `unknown policyParams key "${key}" — possible typo`),
          opts,
        ),
      );
      try {
        await trackHookEvent(getInstanceId(), "policy_params_validation_warning", {
          unknown_keys_count: unknownKeys.length,
          unknown_keys: unknownKeys,
        });
      } catch {}
    }
  }

  // Explicit Custom Policies section
  const explicitPaths = configuredCustomPolicyPaths(config);
  if (explicitPaths.length > 0) {
    groups.push(rule("Custom Policies", opts));
    for (const path of explicitPaths) {
      // Enforcement resolves configured paths from the project config root.
      // Use the same canonical path here so the ID checked by the CLI exactly
      // matches the ID written by the dashboard.
      const absPath = resolve(findProjectConfigDir(cwd ?? process.cwd()), path);
      groups.push(note(absPath, opts));
      if (!existsSync(absPath)) {
        groups.push(warning([`file not found: ${absPath}`], opts));
        continue;
      }
      const hooks = await loadCustomHooks(absPath);
      if (hooks.length === 0) {
        groups.push(
          warning(["failed to load (check ~/.failproofai/logs/hooks.log)"], opts),
        );
      } else {
        groups.push(
          table(
            {
              head: ["", "Name", "Description"],
              rows: hooks.map((hook) => [
                chip(disabledCustomSet.has(`custom:${absPath}:${hook.name}`) ? "off" : "on", opts),
                hook.name,
                hook.description ?? "",
              ]),
            },
            opts,
          ),
        );
      }
    }
  }

  // Convention Policies section (.failproofai/policies/*policies.{js,mjs,ts})
  // Walk up to the project root like enforcement does
  // (custom-hooks-loader -> findProjectConfigDir); resolving at the exact cwd
  // meant running this from a subdirectory listed no project policies while the
  // hook path was loading them.
  const base = findProjectConfigDir(cwd ?? process.cwd());
  const projectDir = resolve(base, ".failproofai", "policies");
  const userDir = customPoliciesDir();
  const sameDir = userDir === projectDir;
  const conventionDirs: { label: string; dir: string }[] = [
    { label: sameDir ? "Project + User" : "Project", dir: projectDir },
    // Running from $HOME makes both paths identical. Listing the directory
    // twice printed every file a second time as "failed to load" — the file was
    // already imported by the first pass, so the module cache short-circuits
    // `customPolicies.add` and `loadCustomHooks` legitimately returns 0 hooks.
    // Nothing was wrong with the policy; the second listing was.
    ...(sameDir ? [] : [{ label: "User", dir: userDir }]),
  ];

  // Record of what was found, mirrored into policies-config.json below so the
  // config shows installed convention policies and not only enabled builtins.
  const discovered: Record<"project" | "user", ConventionPolicyRecord[]> = {
    project: [],
    user: [],
  };

  for (const { label, dir } of conventionDirs) {
    const files = discoverPolicyFiles(dir);
    if (files.length === 0) continue;

    // A shared project/user directory is listed once but belongs to both, so
    // its record is written to both scopes' config files.
    const targets: ("project" | "user")[] =
      dir === projectDir && dir === userDir ? ["project", "user"] : dir === projectDir ? ["project"] : ["user"];
    // When both directories are the same, runtime discovery loads the file as
    // project convention policy and skips the duplicate user pass.
    const policyScope: "project" | "user" = dir === projectDir ? "project" : "user";
    const record = (file: string, hooks: string[]) => {
      for (const t of targets) discovered[t].push({ file, hooks });
    };

    groups.push(rule(`Convention Policies — ${label}`, opts));
    groups.push(note(dir, opts));
    const rows: TableRow[] = [];
    for (const file of files) {
      const filename = basename(file);
      try {
        const hooks = await loadCustomHooks(file);
        record(filename, hooks.map((h) => h.name));
        if (hooks.length === 0) {
          rows.push({ cells: [chip("failed", opts), filename, "failed to load"] });
          continue;
        }
        const hookStates = hooks.map((hook) => ({
          hook,
          disabled: disabledCustomSet.has(`convention:${policyScope}:${filename}:${hook.name}`),
        }));
        const disabledCount = hookStates.filter((entry) => entry.disabled).length;
        const state: ChipState =
          disabledCount === 0 ? "on" : disabledCount === hooks.length ? "off" : "mixed";
        const hookSummary = hookStates
          .map(({ hook, disabled }) => `${hook.name}${disabled ? " (OFF)" : ""}`)
          .join(", ");
        rows.push({
          cells: [chip(state, opts), filename, `${hooks.length} hook(s): ${hookSummary}`],
        });
      } catch {
        record(filename, []);
        rows.push({ cells: [chip("failed", opts), filename, "error"] });
      }
    }
    groups.push(table({ head: ["", "File", "Hooks"], rows }, opts));
  }

  // Installed packs. They enforce on this machine exactly like every section
  // above, and until now the only way to see one was `failproofai policies` —
  // so the command that answers "what is enforcing here?" answered it with a
  // subset, for the one source a person had to go out of their way to install.
  try {
    const { packs, errors } = readInstalledPacks();
    for (const pack of packs) {
      const taken = pack.enabled ?? pack.policies.map((p) => p.name);
      groups.push(rule(`Pack — ${pack.id}@${pack.version}`, opts));
      groups.push(
        table(
          {
            head: ["", "Name", "Description"],
            rows: pack.policies.map((policy) => {
              const disabled = disabledCustomSet.has(
                `pack:${pack.id}@${pack.version}:${policy.name}`,
              );
              // `observe` evaluates and discards its verdict, so a row reading
              // ON would claim enforcement the pack deliberately is not doing.
              const state: ChipState =
                pack.effect === "observe"
                  ? "observe"
                  : !taken.includes(policy.name) || disabled
                    ? "off"
                    : "pack";
              return [chip(state, opts), policy.name, policy.description];
            }),
          },
          opts,
        ),
      );
    }
    if (errors.length > 0) {
      groups.push(
        warning(
          errors.map((err) => `pack ${err.id ?? "(unnamed)"} will not load: ${err.reason}`),
          opts,
        ),
      );
    }
  } catch {
    // Same rule as the cloud section below: a listing must not be the thing
    // that turns an unreadable manifest into a broken command.
  }

  // Cloud-managed policies. These enforce on this machine exactly like the two
  // sections above, but nothing here listed them — so `failproofai policies`
  // answered "what is enforcing?" with a subset, and the policies an operator
  // pushed to a fleet were the ones invisible to the person running the
  // command on it.
  //
  // Read-only on purpose: these are owned by the deployment, not by local
  // config. `--uninstall <name>` cannot switch one off, and printing them
  // beside toggleable rows without saying so would imply it can.
  try {
    const cloud = readActiveCloudManagedPolicies();
    if (cloud.length > 0) {
      groups.push(rule(`Cloud-managed — deployment ${cloud[0].deployment}`, opts));
      groups.push(
        table(
          {
            head: ["", "Policy", "Version"],
            rows: cloud.map((artifact) => [
              // `observe` is evaluated and then has its verdict discarded, so a
              // row that read "ON" would claim enforcement this policy
              // deliberately is not doing.
              chip(artifact.effect === "observe" ? "observe" : "cloud", opts),
              artifact.id,
              `v${artifact.version}`,
            ]),
            flex: 1,
          },
          opts,
        ),
      );
      groups.push(
        note("Managed from the dashboard — not switchable with `failproofai policies`.", opts),
      );
    }
  } catch {
    // A machine with no deployment, or an unreadable manifest, simply has no
    // section. The hook path reports its own failures; a listing must not be
    // the thing that turns a bad manifest into a broken command.
  }

  printBlock(process.stdout, stack(...groups, ...footer));

  // Mirror what was just listed into the USER config. Safe here because
  // `failproofai policies` is a one-shot command — never do this on the hook
  // path (see the HooksConfig.conventionPolicies doc comment).
  //
  // User scope only, deliberately. A project's `.failproofai/policies-config.json`
  // is routinely committed (this repo tracks its own), so writing the record
  // there would make a plain `failproofai policies` dirty the working tree and
  // put a spurious diff in front of every contributor — a read command must not
  // do that. `discovered.project` is still collected so the listing above can
  // report it; it simply is not persisted.
  try {
    syncConventionPolicies(discovered.user, "user");
  } catch (err) {
    // Listing must never fail because the mirror could not be written.
    hookLogWarn(
      `could not record convention policies in config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
