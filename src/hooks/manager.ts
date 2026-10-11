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
import { INTEGRATION_TYPES,
  HOOK_SCOPES,
  type HookScope,
  type IntegrationType,
} from "./types";
import { claudeCode, getIntegration, settingsPathsFor, type Integration } from "./integrations";
import { configuredCustomPolicyPaths, readMergedHooksConfig, readScopedHooksConfig, writeScopedHooksConfig, syncConventionPolicies, findProjectConfigDir } from "./hooks-config";
import type { HooksConfig, ConventionPolicyRecord } from "./policy-types";
import { BUILTIN_POLICIES } from "./builtin-policies";
import { loadCustomHooks, discoverPolicyFiles } from "./custom-hooks-loader";
import { getSemanticRegistrations } from "./custom-hooks-registry";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId, hashToId } from "../../lib/telemetry-id";
import { CliError } from "../cli-error";
import { hookLogWarn } from "./hook-logger";
import { customPoliciesDir } from "./fp-home";
import { readActiveCloudManagedPolicies } from "./cloud-managed-policies";
import { CORE_SOURCE, addPack, setPackPolicyEnabled } from "./pack-store";
import type { ResolvedPack } from "./pack-manifest";
import { hasInstalledRegexPacks, readInstalledPacks } from "./pack-manifest";
import { packPolicyParamKey } from "./policy-evaluator";
import { probeDaemonPolicyEvaluation } from "./daemon-service";
import { keepAgentSelectionTrue } from "./agent-selection";
import { INDENT, colorsEnabled, optsFor, printBlock, screenKit, type ScreenKitOpts } from "./tui";

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
      "Install it globally first:  `npm install -g failproofai`"
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
          direct.map((m) => `  \`${m.packId}:${m.name}\``).join("\n"),
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
          matches.map((m) => `  \`${m.packId}:${m.name}\``).join("\n"),
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
  const kit = screenKit(optsFor(process.stdout));
  for (const ref of refs) {
    console.log(kit.ok(`${on ? "Enabled" : "Disabled"} ${ref.name} from pack ${ref.packId}@${ref.packVersion}.`));
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
      `It stops an agent from switching failproofai off, so it is always on.`
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

/**
 * Is ANY agent CLI wired to call failproofai at this scope?
 *
 * Asked Claude Code and only Claude Code, which made it wrong for every machine
 * guarded through one of the other eleven. A user with hooks in `~/.codex/` was
 * told nothing was installed — quietly, while this only tinted a subtitle, and
 * loudly once the listing started warning that every policy shown was inert.
 * Reported from a real machine set up for codex.
 *
 * Any one integration answering yes is enough: the question is whether
 * enforcement can reach this machine at all, not whether a particular agent is
 * covered. Which agents specifically is a different question, and the per-CLI
 * rows of the listing already answer it.
 */
export function hooksInstalledInSettings(scope: HookScope, cwd?: string): boolean {
  return integrationsInstalledAt(scope, cwd).length > 0;
}

/**
 * Which integrations are wired at EXACTLY this scope — the honest form of the
 * question above, and the one the multi-scope warning needs.
 *
 * Two ways an integration answers yes for a scope it is not actually installed
 * at, both of which made `failproofai policies` warn about "hooks in multiple
 * scopes" on a machine whose hooks are in exactly one file:
 *
 *  - It does not SUPPORT the scope. Hermes and OpenClaw are user-scope only
 *    (`HERMES_HOOK_SCOPES = ["user"]`) and their `getSettingsPath` ignores the
 *    scope argument entirely, so they hand back the user file — and report it
 *    installed — for `project` and `local` alike. `scopes` already declares
 *    this; nothing was reading it.
 *  - Its project path RESOLVES to its user path. Run this from `$HOME` and
 *    `<cwd>/.claude/settings.json` is `~/.claude/settings.json`: one file,
 *    counted as two scopes. Cheap to detect and impossible to get right by
 *    asking each integration separately.
 */
export function integrationsInstalledAt(scope: HookScope, cwd?: string): IntegrationType[] {
  return INTEGRATION_TYPES.filter((id) => {
    try {
      const integration = getIntegration(id);
      if (!integration.scopes.includes(scope)) return false;
      if (!integration.hooksInstalledInSettings(scope, cwd)) return false;
      // A narrower scope that lands on the same file as a wider one is that
      // wider one, seen twice. Attribute it to the widest scope that resolves
      // there so exactly one of them counts.
      const here = integration.getSettingsPath(scope, cwd);
      return !HOOK_SCOPES.some(
        (other) =>
          other !== scope &&
          HOOK_SCOPES.indexOf(other) < HOOK_SCOPES.indexOf(scope) &&
          integration.scopes.includes(other) &&
          safeSettingsPath(integration, other, cwd) === here,
      );
    } catch {
      // An integration whose settings file is unreadable is not evidence that
      // nothing is installed — keep asking the rest.
      return false;
    }
  });
}

/**
 * Why the policies on this machine are not enforcing, or `null` when they are.
 *
 * ONE answer for every screen that warns about it — `failproofai policies`, the
 * dashboard launch screen — so two screens can never disagree about whether
 * this machine is protected. The redesign shows one generic warning whatever
 * the cause (decision D18); the cause is returned anyway, for tests and so a
 * screen that wants the specific fix can have it.
 *
 * Cheap enough for the launch path on purpose: it reads files and imports no
 * policy file and probes no daemon.
 *
 * Deliberately NOT causes, because each needs its own words:
 *  - A refused pack and a down daemon on a daemon-configured machine. Both
 *    FAIL CLOSED: they DENY tool calls rather than let them through, so "not
 *    enforcing" would tell the user the opposite of what is happening.
 *  - A session pause. It belongs to one session, not to the machine, and
 *    `config --status` lists it.
 */
export type NotEnforcingReason = "no-hooks" | "no-policies" | "observe-only";

export function notEnforcingReason(cwd?: string): NotEnforcingReason | null {
  const wired = deduplicateScopes(HOOK_SCOPES, cwd).some((scope) => hooksInstalledInSettings(scope, cwd));
  if (!wired) return "no-hooks";

  const config = readMergedHooksConfig(cwd);
  const disabled = new Set(config.disabledCustomPolicies ?? []);
  let observing = false;

  // Installed packs: a policy enforces when its pack is not observe-only, it
  // was taken at install, and nobody switched it off afterwards.
  try {
    const installed = readInstalledPacks();
    // A pack that failed to load FAILS CLOSED: the calls it covers are denied,
    // which is the opposite of "not enforcing" (see the doc comment above). An
    // observe pack that fails does not deny, so it does not count.
    if (installed.errors.some((error) => error.effect !== "observe")) return null;
    for (const pack of installed.packs) {
      const taken = pack.enabled ?? pack.policies.map((policy) => policy.name);
      const on = taken.filter((name) => !disabled.has(`pack:${pack.id}@${pack.version}:${name}`));
      if (on.length === 0) continue;
      if (pack.effect === "observe") observing = true;
      else return null;
    }
  } catch {
    // An unreadable manifest is reported by the listing itself.
  }

  // Cloud-managed policies, pushed from a deployment.
  try {
    for (const artifact of readActiveCloudManagedPolicies()) {
      if (artifact.effect === "observe") observing = true;
      else return null;
    }
  } catch {
    // No deployment, or an unreadable one: nothing enforces from there.
  }

  // A configured custom policy file, or convention files on disk. Loading them
  // to ask what they hold would import user code on every launch, so their
  // presence counts: the listing below reports a file that fails to load.
  if (configuredCustomPolicyPaths(config).length > 0) return null;
  const projectDir = resolve(findProjectConfigDir(cwd ?? process.cwd()), ".failproofai", "policies");
  if (discoverPolicyFiles(projectDir).length > 0 || discoverPolicyFiles(customPoliciesDir()).length > 0) {
    return null;
  }

  // A machine still on the pre-pack migration shim runs its legacy builtins.
  if (config.enabledPolicies.length > 0 && !hasInstalledRegexPacks()) return null;

  return observing ? "observe-only" : "no-policies";
}

/**
 * How many policies enforce on this machine, for the line that says so.
 *
 * Counted the same way `notEnforcingReason` decides, so the two never disagree:
 * pack policies that are taken and not switched off, cloud-managed policies, and
 * the legacy builtins of a machine still on the migration shim — observe-only
 * ones excluded. Custom policy files cannot be counted without importing them,
 * so their presence is reported on its own.
 */
export function enforcingPolicyCount(cwd?: string): { count: number; custom: boolean } {
  const config = readMergedHooksConfig(cwd);
  const disabled = new Set(config.disabledCustomPolicies ?? []);
  let count = 0;
  try {
    for (const pack of readInstalledPacks().packs) {
      if (pack.effect === "observe") continue;
      const taken = pack.enabled ?? pack.policies.map((policy) => policy.name);
      count += taken.filter((name) => !disabled.has(`pack:${pack.id}@${pack.version}:${name}`)).length;
    }
  } catch {
    // An unreadable manifest counts nothing, as it enforces nothing.
  }
  try {
    for (const artifact of readActiveCloudManagedPolicies()) {
      if (artifact.effect !== "observe") count++;
    }
  } catch {
    // No deployment.
  }
  if (!hasInstalledRegexPacks()) count += config.enabledPolicies.length;
  const projectDir = resolve(findProjectConfigDir(cwd ?? process.cwd()), ".failproofai", "policies");
  const custom =
    configuredCustomPolicyPaths(config).length > 0 ||
    discoverPolicyFiles(projectDir).length > 0 ||
    discoverPolicyFiles(customPoliciesDir()).length > 0;
  return { count, custom };
}

function safeSettingsPath(
  integration: Integration,
  scope: HookScope,
  cwd?: string,
): string | null {
  try {
    return integration.getSettingsPath(scope, cwd);
  } catch {
    return null;
  }
}

export interface InstallHooksOptions {
  /** Replace the enabled set at this scope instead of unioning (default: additive). */
  replace?: boolean;
  /** Suppress this module's installation logging (for callers that render their
   * own UI, like the configure wizard). Errors still surface via console.error. */
  quiet?: boolean;
  /**
   * Trace every agent this call hooks, at whatever scope, and say so in one line
   * after everything else it prints (decision D2, `./agent-selection`).
   * Otherwise the next `failproofai config` takes these hooks out again.
   *
   * Asked for by the commands a person runs — `policies --install`,
   * `policies add`, the dashboard — and off by default, because the one other
   * caller is `failproofai config`, which writes the selection itself.
   */
  syncAgentSelection?: boolean;
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
  const { replace = false, quiet = false, syncAgentSelection = false } = options;
  if (!quiet) {
    return installHooksImpl(
      policyNames, scope, cwd, includeBeta, source, customPoliciesPath, removeCustomHooks, cli, replace,
      syncAgentSelection,
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
      syncAgentSelection,
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
  syncAgentSelection = false,
): Promise<void> {
  // Validate user input first before any system checks
  if (policyNames !== undefined && policyNames.length > 0) {
    const nonAllNames = policyNames.filter((n) => n !== "all");
    // Check unknown names first (most actionable error for the user). Pack
    // policies are applied here and taken out of the list: the rest of this
    // function writes `enabledPolicies`, which is a builtin-only set.
    let wireHooksOnly = false;
    if (nonAllNames.length > 0) {
      const resolved = resolvePolicyNames(nonAllNames);
      applyPackPolicies(resolved.packs, true, scope, cwd);
      if (resolved.packs.length > 0) {
        policyNames = policyNames.filter((n) => n === "all" || resolved.builtins.includes(n));
        if (policyNames.length === 0) {
          // Named ONLY pack policies. Two different requests hide in that
          // shape, and treating them alike wired no hooks for three days
          // across nine agent CLIs while reporting success.
          //
          // A THIRD-PARTY name (`policies add block-big-refund`) implies no
          // hook work: the switch IS the request. Carrying on would resolve
          // the failproofai binary and rewrite every CLI's settings to enable
          // a set of builtins nobody asked about — and would fail outright on
          // a machine where the binary is not on PATH, AFTER the pack change
          // landed. So that one still stops here.
          //
          // A BUILTIN name is an ordinary install — `policies --install
          // block-sudo --cli codex`, the form 16 CLAUDE.md references and the
          // quickstart both name. Every builtin is ALSO declared by the
          // bundled pack, so from the first install onward every such command
          // looked "pack-only" and returned here: exit 0, a reassuring
          // `Enabled … from pack` line, and no settings file for that CLI,
          // with --cli/--scope/--custom dropped on the way out. The first
          // install per machine worked and every one after it was dead, which
          // is why it survived manual testing.
          if (!nonAllNames.some((n) => VALID_POLICY_NAMES.has(n))) return;
          wireHooksOnly = true;
        }
      }
    }
    if (wireHooksOnly) {
      // Wire the hooks, touch no policy — the same path `--install` with no
      // names takes. `applyPackPolicies` above already flipped these on in the
      // pack, which is where the switch lives now; re-writing them into
      // `enabledPolicies` would resurrect the stale-key problem the pack lane
      // exists to end (see the `fromPack` note below).
      policyNames = undefined;
    } else if (policyNames.includes("all") && nonAllNames.length > 0) {
      // Then check if "all" is mixed with valid specific names
      throw new CliError(
        `"all" cannot be combined with specific policy names.\n` +
        "Use either  `failproofai policies --install all`  or  `failproofai policies --install block-sudo sanitize-jwt`"
      );
    }
  }

  // Back-compat default: ["claude"]. Callers (bin/failproofai.mjs) prompt
  // the user for multi-CLI selection before reaching here when --cli is omitted.
  const selectedClis: IntegrationType[] = cli && cli.length > 0 ? [...new Set(cli)] : ["claude"];

  const selectedIntegrations = selectedClis.map((cliId) => ({
    cliId,
    integration: getIntegration(cliId),
  }));

  // Per-CLI scope validation: Codex doesn't have a "local" scope.
  for (const { cliId, integration } of selectedIntegrations) {
    if (!integration.scopes.includes(scope)) {
      try {
        await trackHookEvent(getInstanceId(), "scope_validation_failed", {
          cli: cliId,
          scope,
          supported_scopes: integration.scopes,
        });
      } catch {}
      throw new CliError(
        `Scope "${scope}" is not supported by ${integration.displayName}.\n` +
          `Use one of: ${integration.scopes.join(", ")}`
      );
    }
  }

  // Daemon-only native integrations fail closed when their evaluator cannot be
  // reached. Never enable one until a real policy request succeeds; otherwise
  // a direct `policies --install` can lock every tool call. Shell-hook and CLI-
  // backed integrations retain their local evaluator fallback and therefore do
  // not opt into this requirement.
  const daemonRequiredBy = selectedIntegrations
    .map(({ integration }) => integration)
    .filter((integration) => integration.requiresHealthyDaemon);
  if (daemonRequiredBy.length > 0 && !(await probeDaemonPolicyEvaluation())) {
    const names = daemonRequiredBy.map((integration) => integration.displayName).join(", ");
    const verb = daemonRequiredBy.length === 1 ? "requires" : "require";
    throw new CliError(
      `${names} ${verb} a compatible failproofaid daemon with native policy evaluation before FailproofAI enforcement can be enabled.\n` +
        "Install or update the daemon with  `failproofai config`,  then run this again.",
    );
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
    // NOT a policy picker. `--install` wires hooks; choosing what they enforce
    // is `policies add` / `policies remove`.
    //
    // It used to open a second picker here, over `BUILTIN_POLICIES` — the
    // COMPILED catalog, which is no longer how policies arrive. So it offered a
    // list that did not match what was installed, in an older prompt engine
    // that looks nothing like the rest, and wrote its answer to
    // `enabledPolicies` while every pack records its selection in
    // `installed.json`.
    //
    // Two independent enabled-sets, and this one silently overwrote the other:
    // `policies remove block-env-files` followed by `policies --install` put
    // block-env-files straight back on, because the picker pre-ticked from the
    // legacy key and saved all of it again. A command whose job is wiring must
    // not undo a policy decision made somewhere else.
    //
    // Whatever was enabled stays enabled. Explicit names still work
    // (`--install block-sudo`) for the migration shim, which has only this key.
    selectedPolicies = previousConfig.enabledPolicies;
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
        process.stderr.write(`${screenKit({ color: colorsEnabled(process.stderr) }).notice("fail", msg).join("\n")}\n`);
        process.exit(1);
      }
      const semanticCount = getSemanticRegistrations().length;
      if (semanticCount > 0) {
        console.error(
          `Note: ${path} declares ${semanticCount} Jev check(s) with semanticPolicies.add. They take effect only in a ` +
            "pack published with `failproofai publish`, and are never asked from a policy file.",
        );
      }
      if (validatedHooks.length === 0) {
        try {
          await trackHookEvent(getInstanceId(), "custom_policy_validation_failed", {
            scope,
            error_type: "no_hooks_registered",
          });
        } catch {}
        process.stderr.write(
          `${screenKit({ color: colorsEnabled(process.stderr) })
            .notice(
              "fail",
              `No hooks are registered in ${path}.\n` +
                "Make sure the file calls  `customPolicies.add(...)`  at least once.",
            )
            .join("\n")}\n`,
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
  // ONLY names the caller actually asked for.
  //
  // This used to take whatever sat in `enabledPolicies` and switch those names
  // on in the pack. It is additive — it can turn a policy on and never off — so
  // a stale entry in that key resurrected a policy the user had deliberately
  // removed, on the next `policies --install`, with no mention of it.
  // `remove block-env-files` then `--install` put it straight back.
  //
  // And the key goes stale by design now: nothing writes pack selections there,
  // so anything left in it is a leftover from before packs, kept only for the
  // migration shim. Re-applying a leftover as if it were a decision is how a
  // machine ends up enforcing something its owner switched off.
  const fromPack = policyNames === undefined
    ? []
    : selectedPolicies.filter((name) => !alwaysOnNames.has(name));
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
    // A Jev-only pack has no policy to switch on, so it does not count here.
    if (!hasInstalledRegexPacks()) {
      // Fetched, not unpacked from this package: there is no copy in here any
      // more. That makes this the one path in `policies --install` that needs
      // the network, so its failure is reported rather than thrown — the names
      // are already written to config, and the no-pack fallback enforces them
      // until a pack arrives.
      try {
        await addPack(CORE_SOURCE, { only: fromPack });
      } catch (err) {
        console.log(
          screenKit(optsFor(process.stdout)).caution(
            `Couldn't fetch the policy pack (${err instanceof Error ? err.message : String(err)}). Once you are online:`,
            "failproofai policies add FailproofAI/policies",
          ),
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
  // Only when this run actually changed something. `--install` with no names
  // wires hooks and touches no policy, and announcing "Enabled 0 policy(ies):"
  // with an empty list described work it had not done — or worse, re-stated a
  // stale key as though it were this run's decision.
  if (policyNames !== undefined && selectedPolicies.length > 0) {
    const n = selectedPolicies.length;
    console.log(screenKit(optsFor(process.stdout)).ok(`Enabled ${n} ${n === 1 ? "policy" : "policies"}: ${selectedPolicies.join(", ")}`));
  }
  if (removeCustomHooks) {
    console.log(screenKit(optsFor(process.stdout)).ok("Custom hooks path cleared."));
  } else if (configToWrite.customPoliciesPaths?.length || configToWrite.customPoliciesPath) {
    const paths = configToWrite.customPoliciesPaths ?? [configToWrite.customPoliciesPath!];
    for (const line of screenKit(optsFor(process.stdout)).kv([["custom", paths.join(", ")]])) console.log(line);
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
        integration.prepareInstall?.(settingsPath);
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

  // One ✓ per agent, with where it was written under it; then how the hooks
  // call failproofai. Drawn with the kit, so colour follows the terminal and a
  // pipe gets plain text.
  const kit = screenKit(optsFor(process.stdout));
  for (const { cli: cliId, path } of writtenSettingsPaths) {
    const integration = getIntegration(cliId);
    console.log(
      kit.ok(
        cliId === "hermes"
          ? `${integration.displayName} plugin installed (8 hooks, ${scope} scope).`
          : `${integration.displayName} hooks installed (${integration.eventTypes.length} events, ${scope} scope).`,
      ),
    );
    for (const line of kit.kv([["settings", path]])) console.log(line);
  }
  for (const line of kit.kv(scope === "project" ? [["command", "npx -y failproofai"]] : [["binary", binaryPath]])) {
    console.log(line);
  }
  if (scope === "project") console.log(`${INDENT}This file can be committed to git: it has no machine-specific paths.`);

  // Warn about duplicate-scope installations (Claude Code only — uses HOOK_SCOPES)
  const otherScopes = deduplicateScopes(HOOK_SCOPES, cwd).filter((s) => s !== scope);
  const duplicates = otherScopes.filter((s) => hooksInstalledInSettings(s, cwd));
  if (duplicates.length > 0) {
    const scopeList = duplicates.map((s) => `${s} (${scopeLabel(s)})`).join(", ");
    console.log(
      kit.caution(
        `Hooks are also installed at ${scopeList}, so each policy may run twice.`,
        `failproofai policies --uninstall --scope ${duplicates[0]}`,
      ),
    );
    try {
      await trackHookEvent(getInstanceId(), "multi_scope_warning_shown", {
        new_scope: scope,
        existing_scopes: duplicates,
        cli: selectedClis,
      });
    } catch {}
  }

  // Last, after everything above: the agents whose hooks were actually written.
  // A call that returned early (only a third-party pack's policies were named)
  // or threw wrote none and changes nothing.
  if (syncAgentSelection) {
    const note = keepAgentSelectionTrue("installed", writtenSettingsPaths.map((written) => written.cli));
    if (note) console.log(note);
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
 * @param opts.syncAgentSelection — when hooks are taken out at user scope or
 *   every scope, stop tracing those agents and say so in one line (decision D2,
 *   `./agent-selection`). Asked for by `policies --uninstall`, `policies remove`
 *   and the dashboard; `failproofai uninstall` leaves the selection alone.
 * @param opts.silent — print nothing; for a caller that reports the outcome itself
 *   (`failproofai uninstall` says what it removed in its own lines, under its
 *   question, and these old-style rows landed between the two)
 */
export async function removeHooks(policyNames?: string[], scope: HookScope | "all" = "user", cwd?: string, opts?: { betaOnly?: boolean; source?: string; removeCustomHooks?: boolean; cli?: IntegrationType[]; syncAgentSelection?: boolean; silent?: boolean }): Promise<void> {
  const say = (line: string): void => {
    if (!opts?.silent) console.log(line);
  };
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
    say("Custom hooks path cleared.");
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
      say(`Warning: policy(ies) not currently enabled: ${notEnabled.join(", ")}`);
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

    say(`Disabled ${policyNames.length - notEnabled.length} policy(ies).`);
    say(`Remaining: ${remaining.length > 0 ? remaining.join(", ") : "(none)"}`);
    return;
  }

  // Capture enabled policies before clearing (used for accurate telemetry below)
  const configBeforeRemoval = readScopedHooksConfig(configScope, cwd);

  // Every agent this removal acted on stops being traced, including one that
  // turned out to have nothing to remove: the command still said "not this
  // agent", and leaving it traced would let the next `failproofai config` hook
  // it. Project and local scope never count; the selection is per machine.
  const untraceRemoved = (): void => {
    if (!opts?.syncAgentSelection || (scope !== "user" && scope !== "all")) return;
    const acted = selectedClis.filter((id) => scope === "all" || getIntegration(id).scopes.includes("user"));
    const note = keepAgentSelectionTrue("removed", acted);
    if (note) say(note);
  };

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
      // A Hermes install copies its managed plugin before updating config.yaml.
      // If the config write is interrupted, uninstall must still call the
      // integration so it can remove that orphaned managed directory.
      const existing =
        cliId === "hermes" ? settingsPaths : settingsPaths.filter((p) => existsSync(p));

      if (existing.length === 0) {
        if (scope !== "all" && selectedClis.length === 1) {
          say(screenKit(optsFor(process.stdout)).ok("No settings file found, so there is nothing to remove."));
          nothingToReport = true;
        }
        continue;
      }

      let removedHere = 0;
      for (const settingsPath of existing) {
        const removed = integration.removeHooksFromFile(settingsPath);
        removedHere += removed;
        if (removed > 0 && scope !== "all") {
          say(screenKit(optsFor(process.stdout)).ok(`Removed ${removed} failproofai ${removed === 1 ? "hook" : "hooks"} from ${integration.displayName} settings.`));
          for (const line of screenKit(optsFor(process.stdout)).kv([["settings", settingsPath]])) say(line);
        }
      }

      if (removedHere === 0 && scope !== "all" && selectedClis.length === 1) {
        say(screenKit(optsFor(process.stdout)).ok("No hooks found in settings, so there is nothing to remove."));
        nothingToReport = true;
        continue;
      }
      totalRemoved += removedHere;
    }
  }

  if (nothingToReport && totalRemoved === 0) {
    untraceRemoved();
    return;
  }

  if (scope === "all") {
    say(screenKit(optsFor(process.stdout)).ok(`Removed ${totalRemoved} failproofai ${totalRemoved === 1 ? "hook" : "hooks"} from every scope.`));
    for (const cliId of selectedClis) {
      const integration = getIntegration(cliId);
      for (const s of integration.scopes) {
        for (const p of settingsPathsFor(integration, s, cwd)) {
          say(`${INDENT}${integration.displayName}, ${s}:  ${p}`);
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

  untraceRemoved();
}

/** A row in one of the listing's plain sections: custom, convention, cloud. */
export interface PoliciesScreenRow {
  state: "on" | "off" | "failed";
  name: string;
  description: string;
  /** Grey qualifier after the description — `observe` on a cloud policy. */
  tag?: string;
}

/**
 * Everything `failproofai policies` draws, gathered by {@link listHooks} and
 * drawn by {@link renderPoliciesScreen}.
 *
 * Split in two so the drawing is a pure function of this value: it can be
 * asserted with colour on and off, at any width and with any version, without
 * a terminal, a home directory or a pack on disk.
 */
export interface PoliciesScreen {
  /** Installed packs that loaded, in `installed.json` order. */
  packs: Array<{
    id: string;
    version: string;
    /** Where it was fetched from — shown only when it is not the repository the id names. */
    source: string;
    observe: boolean;
    /** Jev checks this pack brings that Jev asks. Zero for an observe pack, whose checks are never asked. */
    jevChecks: number;
    policies: Array<{ name: string; description: string; category: string; on: boolean }>;
  }>;
  /** Packs that are installed and refused to load. */
  refused: Array<{ id: string | null; reason: string }>;
  /** The one line that needs attention, already chosen by severity. */
  attention: { failed: boolean; text: string; fix?: string } | null;
  custom: PoliciesScreenRow[];
  convention: Array<{ scope: string; rows: PoliciesScreenRow[] }>;
  cloud: { deployment: number; rows: PoliciesScreenRow[] } | null;
  /**
   * Builtins this build enforces itself because no pack is installed: the
   * migration shim (`handler.ts` registers `enabledPolicies` when
   * `hasInstalledRegexPacks()` is false). Listed so the screen does not show
   * nothing for a machine enforcing all of them.
   */
  legacy?: Array<{ name: string; description: string }>;
}

/**
 * The policies screen (decision D14: "the policies list exactly as designed").
 *
 * Packs say where their policies come from once, as `pack` rows at the top,
 * and every policy is ● on or ○ off. Off policies fold into one "○ n more off"
 * line per category; `all` lists every one instead.
 *
 * Where the design is silent on a real machine, a pack row carries a grey tag
 * rather than a new state: `observe` for a pack that evaluates and blocks
 * nothing, so it can never read as enforcing; its Jev checks; the source it
 * came from when that is not the repository its self-declared id names; and
 * `failed to load` with the reason for a pack that is installed and refused.
 */
export function renderPoliciesScreen(
  screen: PoliciesScreen,
  opts: ScreenKitOpts & { all?: boolean } = {},
): string[] {
  const kit = screenKit(opts);
  const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const glyph = (state: PoliciesScreenRow["state"]): string =>
    state === "on" ? kit.on : state === "off" ? kit.off : kit.failed;
  const out: string[] = [kit.header("Policies")];

  const kvRows: Array<[string, string]> = [];
  for (const pack of screen.packs) {
    const tags: string[] = [];
    if (pack.observe) tags.push("observe");
    if (pack.jevChecks > 0) tags.push(count(pack.jevChecks, "Jev check", "Jev checks"));
    // The id is whatever the manifest claims; the source is the repository this
    // CLI actually fetched it from. Equal on every ordinary install, so the row
    // is exactly the design's — and when they differ, saying so is the point.
    const repo = pack.source.replace(/^github:/i, "").replace(/@[^@]*$/, "");
    if (repo.toLowerCase() !== pack.id.toLowerCase()) tags.push(`from ${pack.source}`);
    kvRows.push(["pack", `${pack.id}@${pack.version}${tags.map((t) => `${kit.sep}${kit.meta(t)}`).join("")}`]);
  }
  for (const pack of screen.refused) {
    kvRows.push(["pack", `${pack.id ?? "(unnamed)"}${kit.sep}${kit.meta(`failed to load: ${pack.reason}`)}`]);
  }
  const total = screen.packs.reduce((n, pack) => n + pack.policies.length, 0);
  const enabled = screen.packs.reduce((n, pack) => n + pack.policies.filter((p) => p.on).length, 0);
  if (total > 0) kvRows.push(["enabled", `${enabled} of ${total}`]);
  if (kvRows.length > 0) out.push("", ...kit.kv(kvRows));

  const empty =
    screen.packs.length === 0 &&
    screen.refused.length === 0 &&
    screen.custom.length === 0 &&
    screen.convention.length === 0 &&
    !screen.cloud &&
    !screen.legacy?.length;
  if (screen.attention || empty) out.push("");
  if (screen.attention) {
    const { failed, text, fix } = screen.attention;
    out.push(failed ? kit.fail(text, fix) : kit.caution(text, fix));
  }
  if (empty) {
    // Ours first is a convenience, not a channel: a screen that named only ours
    // would read as the place policies come from.
    out.push(
      `${INDENT}Turn on ours:  ${kit.cmd(`failproofai policies add ${CORE_SOURCE}`)}`,
      `${INDENT}Or anyone's:   ${kit.cmd("failproofai policies add <owner>/<repo>")}`,
    );
  }

  // Category headings name their pack only when two packs could each have a
  // category of the same name. A pack of Jev checks alone has no categories, so
  // the shipped FailproofAI/policies + FailproofAI/jev-policies pairing still
  // reads exactly as designed.
  const sectioned = screen.packs.filter((pack) => pack.policies.length > 0);
  const prefixed = sectioned.length > 1;
  let folded = 0;
  const sections: Array<{ heading: string; meta: string; items: Array<[string, string?]> }> = [];
  for (const pack of sectioned) {
    // First appearance orders the categories, and a category is gathered
    // wherever it appears: "Dangerous Commands" comes back after "Infra
    // Commands" in our own pack, and two headings for it would read as two.
    for (const category of [...new Set(pack.policies.map((p) => p.category))]) {
      const inCategory = pack.policies.filter((p) => p.category === category);
      const on = inCategory.filter((p) => p.on).length;
      const shown = opts.all ? inCategory : inCategory.filter((p) => p.on);
      const items: Array<[string, string?]> = shown.map((p) => [
        `${p.on ? kit.on : kit.off} ${p.name}`,
        p.description,
      ]);
      const hidden = inCategory.length - shown.length;
      if (hidden > 0) items.push([`${kit.off} ${hidden} more off`]);
      folded += hidden;
      sections.push({ heading: prefixed ? `${pack.id} · ${category}` : category, meta: `${on} of ${inCategory.length}`, items });
    }
  }
  // One description column for every pack section, so they line up down the
  // screen: at least the design's 32 for the name, always two spaces past the
  // longest one shown.
  const columnFor = (names: string[]): number => Math.max(34, ...names.map((name) => name.length + 4));
  const packColumn = columnFor(
    sectioned.flatMap((pack) => pack.policies.filter((p) => opts.all || p.on).map((p) => p.name)),
  );
  for (const section of sections) {
    out.push("", kit.head(section.heading, section.meta), ...kit.rows(section.items, packColumn));
  }

  const plain = (heading: string, meta: string | undefined, rows: PoliciesScreenRow[]): void => {
    const items = rows.map((row): [string, string] => [
      `${glyph(row.state)} ${row.name}`,
      row.tag ? `${row.description}${kit.sep}${kit.meta(row.tag)}` : row.description,
    ]);
    const column = columnFor(rows.filter((row) => row.description).map((row) => row.name));
    out.push("", kit.head(heading, meta), ...kit.rows(items, column));
  };
  // A count, not the names: since packs carry the policies, this screen lists
  // no builtin by name (#738 pins that), but it must not draw a machine that is
  // enforcing thirty of them as if nothing were there.
  if (screen.legacy?.length) {
    out.push(
      "",
      kit.head("Built in", `${screen.legacy.length} on, from before packs`),
      `${INDENT}Move them into a pack:  ${kit.cmd(`failproofai policies add ${CORE_SOURCE}`)}`,
    );
  }
  if (screen.custom.length > 0) plain("Custom policies", undefined, screen.custom);
  for (const { scope, rows } of screen.convention) plain("Convention policies", scope, rows);
  if (screen.cloud) plain("Cloud-managed", `deployment ${screen.cloud.deployment}`, screen.cloud.rows);

  if (folded > 0) out.push("", `See all ${total} with ${kit.cmd("failproofai policies --all")}`);
  return out;
}

/**
 * `failproofai policies`: every policy on this machine and whether it is on.
 *
 * Gathers the screen and draws it with {@link renderPoliciesScreen}. At most
 * one line asks for attention, the most severe first: a pack that will not load
 * and so DENIES what it covers, then the machine not enforcing at all
 * ({@link notEnforcingReason}, the same answer the launch screen gives), then a
 * custom policy file that is not running, hooks in more than one scope, and an
 * unknown `policyParams` key.
 *
 * `all` lists every policy instead of folding the off ones.
 */
export async function listHooks(cwd?: string, { all = false }: { all?: boolean } = {}): Promise<void> {
  const config = readMergedHooksConfig(cwd);
  const disabledCustomSet = new Set(config.disabledCustomPolicies ?? []);

  // Determine which scopes have hooks installed (deduplicate when paths overlap, e.g. cwd === home)
  const uniqueScopes = deduplicateScopes(HOOK_SCOPES, cwd);
  const installedScopes = uniqueScopes.filter((s) => hooksInstalledInSettings(s, cwd));

  // One read of the pack store for the whole listing. It never throws by
  // contract; the guard is for a listing never being the thing that turns an
  // unreadable manifest into a broken command.
  const packRead: Pick<ReturnType<typeof readInstalledPacks>, "packs" | "errors"> = (() => {
    try {
      const read = readInstalledPacks();
      return { packs: read?.packs ?? [], errors: read?.errors ?? [] };
    } catch {
      return { packs: [], errors: [] };
    }
  })();
  const packErrors = packRead.errors;

  // Names a `policyParams` key may legitimately use: every policy an installed
  // pack carries. Previously the compiled catalog, which no longer describes
  // what runs.
  //
  // BOTH spellings, because both are read at runtime. The dashboard writes the
  // pack-qualified `packPolicyParamKey` and the evaluator prefers it; the bare
  // name is the legacy key still honoured for our own pack. Knowing only the
  // bare one made this command call every parameter saved through the UI a
  // "possible typo" — and fire a `policy_params_validation_warning` for it —
  // the moment the dashboard started qualifying its keys. Built with the shared
  // helper rather than a third copy of the `pack/<id>/<name>` format.
  const knownPolicyNames = new Set<string>();
  try {
    for (const pack of packRead.packs) {
      for (const policy of pack.policies) {
        knownPolicyNames.add(policy.name);
        knownPolicyNames.add(packPolicyParamKey(pack.id, policy.name));
      }
    }
  } catch {
    // Unreadable manifest: skip the typo warning rather than invent one.
  }

  // Unknown policyParams keys. The event fires whenever there is one, whether or
  // not a more severe line takes the screen's one attention slot.
  const unknownKeys: string[] = [];
  if (config.policyParams) {
    for (const key of Object.keys(config.policyParams)) {
      if (knownPolicyNames.size > 0 && !knownPolicyNames.has(key)) unknownKeys.push(key);
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

  // Explicit custom policy files.
  const custom: PoliciesScreenRow[] = [];
  let customProblem: string | null = null;
  for (const path of configuredCustomPolicyPaths(config)) {
    // Enforcement resolves configured paths from the project config root.
    // Use the same canonical path here so the ID checked by the CLI exactly
    // matches the ID written by the dashboard.
    const absPath = resolve(findProjectConfigDir(cwd ?? process.cwd()), path);
    if (!existsSync(absPath)) {
      custom.push({ state: "failed", name: absPath, description: "not found" });
      customProblem ??= "A custom policy file was not found, so its policies are not running.";
      continue;
    }
    const hooks = await loadCustomHooks(absPath);
    if (hooks.length === 0) {
      custom.push({ state: "failed", name: absPath, description: "failed to load" });
      customProblem ??= "A custom policy file failed to load, so its policies are not running.";
      continue;
    }
    for (const hook of hooks) {
      custom.push({
        state: disabledCustomSet.has(`custom:${absPath}:${hook.name}`) ? "off" : "on",
        name: hook.name,
        description: hook.description ?? "",
      });
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
  const conventionDirs: { scope: string; dir: string }[] = [
    { scope: sameDir ? "project + user" : "project", dir: projectDir },
    // Running from $HOME makes both paths identical. Listing the directory
    // twice printed every file a second time as "failed to load" — the file was
    // already imported by the first pass, so the module cache short-circuits
    // `customPolicies.add` and `loadCustomHooks` legitimately returns 0 hooks.
    // Nothing was wrong with the policy; the second listing was.
    ...(sameDir ? [] : [{ scope: "user", dir: userDir }]),
  ];

  // Record of what was found, mirrored into policies-config.json below so the
  // config shows installed convention policies and not only enabled builtins.
  const discovered: Record<"project" | "user", ConventionPolicyRecord[]> = {
    project: [],
    user: [],
  };

  const convention: PoliciesScreen["convention"] = [];
  for (const { scope, dir } of conventionDirs) {
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

    // One row per FILE: ● while any of its hooks is on, ○ once all of them are
    // off, and a count of the ones switched off when it is some of them.
    const rows: PoliciesScreenRow[] = [];
    for (const file of files) {
      const filename = basename(file);
      try {
        const hooks = await loadCustomHooks(file);
        record(filename, hooks.map((h) => h.name));
        if (hooks.length === 0) {
          rows.push({ state: "failed", name: filename, description: "failed to load" });
          continue;
        }
        const off = hooks.filter((hook) =>
          disabledCustomSet.has(`convention:${policyScope}:${filename}:${hook.name}`),
        ).length;
        rows.push({
          state: off === hooks.length ? "off" : "on",
          name: filename,
          description:
            `${hooks.length} ${hooks.length === 1 ? "hook" : "hooks"}` +
            (off > 0 && off < hooks.length ? ` (${off} off)` : ""),
        });
      } catch {
        record(filename, []);
        rows.push({ state: "failed", name: filename, description: "failed to load" });
      }
    }
    convention.push({ scope, rows });
  }

  // Installed packs. They enforce on this machine exactly like every section
  // above, and until now the only way to see one was `failproofai policies` —
  // so the command that answers "what is enforcing here?" answered it with a
  // subset, for the one source a person had to go out of their way to install.
  const packs: PoliciesScreen["packs"] = [];
  try {
    for (const pack of packRead.packs) {
      const taken = pack.enabled ?? pack.policies.map((p) => p.name);
      packs.push({
        id: pack.id,
        version: pack.version,
        source: pack.source,
        observe: pack.effect === "observe",
        jevChecks: pack.effect === "observe" ? 0 : (pack.semantic?.length ?? 0),
        policies: pack.policies.map((policy) => ({
          name: policy.name,
          description: policy.description,
          category: policy.category,
          on:
            taken.includes(policy.name) &&
            !disabledCustomSet.has(`pack:${pack.id}@${pack.version}:${policy.name}`),
        })),
      });
    }
  } catch {
    // Same rule as the cloud section below: a listing must not be the thing
    // that turns an unreadable manifest into a broken command.
  }
  const refused = packErrors.map((err) => ({ id: err.id, reason: err.reason }));

  // Cloud-managed policies. These enforce on this machine exactly like the
  // sections above, but nothing here listed them — so `failproofai policies`
  // answered "what is enforcing?" with a subset, and the policies an operator
  // pushed to a fleet were the ones invisible to the person running the
  // command on it. Read-only: they belong to the deployment, which the heading
  // says, and `--uninstall <name>` cannot switch one off.
  let cloud: PoliciesScreen["cloud"] = null;
  try {
    const active = readActiveCloudManagedPolicies();
    if (active.length > 0) {
      cloud = {
        deployment: active[0].deployment,
        rows: active.map((artifact) => ({
          state: "on" as const,
          name: artifact.id,
          description: `v${artifact.version}`,
          // `observe` is evaluated and then has its verdict discarded, so the
          // row says so rather than reading as plain enforcement.
          ...(artifact.effect === "observe" ? { tag: "observe" } : {}),
        })),
      };
    }
  } catch {
    // A machine with no deployment, or an unreadable manifest, simply has no
    // section. The hook path reports its own failures; a listing must not be
    // the thing that turns a bad manifest into a broken command.
  }

  // The one attention line, most severe first. A refused pack that fails closed
  // is a FAILURE, not "not enforcing": it denies the calls its policies cover
  // (pack-failclosed.ts), so it is named before anything else.
  const failClosed = packErrors.filter((err) => err.effect !== "observe" && !err.semanticOnly);
  let attention: PoliciesScreen["attention"] = null;
  if (failClosed.length > 0) {
    const [first] = failClosed;
    const many = failClosed.length > 1;
    attention = {
      failed: true,
      text:
        `${first.id ?? "A pack"}${many ? ` and ${failClosed.length - 1} more` : ""} failed to load, ` +
        `so the calls ${many ? "they cover" : "it covers"} are denied.`,
      fix: `failproofai policies remove ${first.id ?? "<id>"}`,
    };
  } else if (notEnforcingReason(cwd) !== null) {
    // One generic line whatever the cause (decision D18).
    attention = { failed: false, text: "Policies are not enforcing yet.", fix: "failproofai config" };
  } else if (customProblem) {
    attention = { failed: false, text: customProblem };
  } else if (installedScopes.length > 1) {
    attention = {
      failed: false,
      text: `Hooks are installed in multiple scopes: ${installedScopes.join(", ")}.`,
      fix: "failproofai policies --uninstall --scope <scope>",
    };
  } else if (unknownKeys.length > 0) {
    attention = {
      failed: false,
      text:
        unknownKeys.length === 1
          ? `Unknown policyParams key "${unknownKeys[0]}", possibly a typo.`
          : `Unknown policyParams keys ${unknownKeys.map((key) => `"${key}"`).join(", ")}, possibly typos.`,
    };
  }

  // The same test the hook path uses to decide it enforces these itself.
  const legacy = hasInstalledRegexPacks()
    ? []
    : BUILTIN_POLICIES.filter((p) => config.enabledPolicies.includes(p.name)).map((p) => ({
        name: p.name,
        description: p.description,
      }));

  printBlock(
    process.stdout,
    renderPoliciesScreen(
      { packs, refused, attention, custom, convention, cloud, legacy },
      // Descriptions are shortened only for a terminal; a pipe keeps every word.
      { ...optsFor(process.stdout), fit: Boolean(process.stdout.isTTY), all },
    ),
  );

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
