/**
 * What is already set up on this machine, and where.
 *
 * Two questions live here, both of which used to be answered ad hoc in two
 * different places:
 *
 *   1. "Has this user ever completed setup?"  — drives first-run onboarding.
 *   2. "Is this cwd a project, a home directory, or both?" — drives which
 *      scope the wizard offers to configure.
 *
 * Both are pure functions over the filesystem so they can be unit-tested
 * without a TTY, a wizard, or a real home directory. Every path is derived
 * from an injectable `home`/`cwd` rather than read from the environment at
 * call time, because the wizard, the CLI entry point and the tests each have
 * a different idea of where "home" is.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { getIntegration } from "./integrations";
import { INTEGRATION_TYPES } from "./types";
import { globalPolicyConfigFile, launcherMarker as layoutLauncherMarker } from "./fp-home";

/** Which config a wizard run is going to write. */
export type SetupTarget = "user" | "project" | "both";

export interface SetupState {
  /** Absolute cwd this was resolved against. */
  cwd: string;
  /** Absolute home directory this was resolved against. */
  home: string;
  /**
   * The directory a project-scope write would land in — the nearest ancestor
   * holding a `.failproofai/`, else `cwd` itself. Never the home directory:
   * `~/.failproofai` is the GLOBAL config, and treating it as a project root
   * would make a wizard run from `~` offer to "configure this project" and
   * then write the global file under a project label.
   */
  projectRoot: string;
  /** `~/.failproofai/policies-config.json` exists. */
  hasGlobalConfig: boolean;
  /** `<projectRoot>/.failproofai/policies-config.json` exists. */
  hasProjectConfig: boolean;
  /** Any agent CLI has failproofai hooks installed at user scope. */
  hasGlobalHooks: boolean;
  /** The legacy first-run marker written by earlier versions. */
  hasLegacyMarker: boolean;
  /** cwd resolves to the home directory itself. */
  inHomeDir: boolean;
}

export function globalConfigPath(home: string = homedir()): string {
  return globalPolicyConfigFile(home);
}

export function projectConfigPath(projectRoot: string): string {
  return resolve(projectRoot, ".failproofai", "policies-config.json");
}

function legacyMarkerPath(home: string): string {
  return layoutLauncherMarker(home);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The nearest ancestor of `start` holding a `.failproofai/` directory, or
 * `start` itself when there is none.
 *
 * Mirrors `hooks-config.findProjectConfigDir`, but takes `home` as a
 * parameter instead of calling `homedir()` — the wizard needs to resolve this
 * against a caller-supplied home in tests, and the two must not disagree
 * about where the walk stops or the wizard would offer to write a project
 * config at a path the policy loader never reads.
 */
export function findProjectRoot(start: string, home: string = homedir()): string {
  // Both sides real-resolved for the same reason `detectSetupState` does it:
  // a symlinked home would never equal the walked path, so the walk would run
  // straight past home and could claim `~` — whose `.failproofai/` is the
  // global config — as a project root.
  const resolvedHome = realResolve(home);
  let dir = realResolve(start);
  while (dir !== resolvedHome) {
    if (isDir(resolve(dir, ".failproofai"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

/**
 * Whether any agent CLI carries failproofai hooks at user scope.
 *
 * Deliberately ignores project scope: a checkout that happens to contain
 * committed project hooks (this repo does) must not convince the wizard that
 * the MACHINE has been set up.
 */
export function hasGlobalHooksInstalled(): boolean {
  for (const id of INTEGRATION_TYPES) {
    try {
      if (getIntegration(id).hooksInstalledInSettings("user")) return true;
    } catch {
      // A malformed settings file is not evidence of an install.
    }
  }
  return false;
}

/**
 * `resolve()` plus symlink resolution, falling back to the lexical path.
 *
 * `$HOME` is very often a symlink (`/home/x` → `/mnt/data/x`, macOS
 * `/tmp` → `/private/tmp`) while a shell's cwd reports the real path. Compared
 * lexically, the two never match: `inHomeDir` reads false while standing in
 * home, and the wizard offers to "configure this project" pointing at the home
 * directory — whose `.failproofai/` is the GLOBAL config. Comparing real paths
 * is what makes "am I in my home directory" answerable.
 *
 * Falls back to the lexical path when the target does not exist (a cwd that
 * has been deleted, a home that has not been created yet), because a missing
 * path is not a reason to fail detection.
 */
function realResolve(path: string): string {
  const lexical = resolve(path);
  try {
    return realpathSync(lexical);
  } catch {
    return lexical;
  }
}

export function detectSetupState(
  cwd: string = process.cwd(),
  home: string = homedir(),
): SetupState {
  const resolvedCwd = realResolve(cwd);
  const resolvedHome = realResolve(home);
  const projectRoot = findProjectRoot(resolvedCwd, resolvedHome);

  return {
    cwd: resolvedCwd,
    home: resolvedHome,
    projectRoot,
    hasGlobalConfig: existsSync(globalConfigPath(resolvedHome)),
    // When cwd IS home, `projectRoot` is home and its `.failproofai` is the
    // global config — reporting that as a project config would double-count
    // one file as two scopes and offer "Both" for a single target.
    hasProjectConfig:
      projectRoot !== resolvedHome && existsSync(projectConfigPath(projectRoot)),
    hasGlobalHooks: hasGlobalHooksInstalled(),
    hasLegacyMarker: existsSync(legacyMarkerPath(resolvedHome)),
    inHomeDir: resolvedCwd === resolvedHome,
  };
}

/**
 * Whether this machine has ever completed setup.
 *
 * Deliberately NOT just the marker file. The marker is one of three
 * independent signals, and any of them means "configured":
 *
 *   • a global policies-config.json  — the wizard, or `policies --install`,
 *     has written real configuration
 *   • user-scope hooks in any agent CLI — enforcement is live even if the
 *     config file was hand-deleted
 *   • the legacy marker — so users onboarded by an earlier version are never
 *     shown the wizard a second time
 *
 * Relying on the marker alone made deleting one file re-run onboarding on a
 * fully configured machine; relying on hooks alone re-ran it for anyone who
 * had uninstalled hooks but kept their policy config. Requiring all three
 * would never fire for a genuinely fresh install. The union is the only
 * combination that is right in each case.
 */
export function isConfigured(state: SetupState = detectSetupState()): boolean {
  return state.hasGlobalConfig || state.hasGlobalHooks || state.hasLegacyMarker;
}

export interface TargetChoice {
  label: string;
  value: SetupTarget;
  hint: string;
  /** True when this target would UPDATE existing config rather than create it. */
  existing: boolean;
}

/**
 * The scope choices to offer, ordered so the most likely intent is first
 * (and therefore pre-selected).
 *
 * The ordering rule is "what did the user point us at": run from inside a
 * project, the project comes first; run from home — where there is no project
 * to configure — only the global row is offered, because a "Just this
 * project" row pointing at `~` would write `~/.failproofai/` and call the
 * machine-wide config a project.
 */
export function buildTargetChoices(state: SetupState): TargetChoice[] {
  const globalRow: TargetChoice = {
    label: state.hasGlobalConfig ? "Update my global policies" : "Set up global policies",
    value: "user",
    hint: "applies in every project on this machine",
    existing: state.hasGlobalConfig,
  };

  // From home (or anywhere with no project marker above it) there is no
  // second target to offer.
  if (state.inHomeDir || state.projectRoot === state.home) {
    return [globalRow];
  }

  const projectRow: TargetChoice = {
    label: state.hasProjectConfig
      ? "Update this project's policies"
      : "Set up this project's policies",
    value: "project",
    hint: homeify(state.projectRoot, state.home),
    existing: state.hasProjectConfig,
  };

  const bothRow: TargetChoice = {
    label: "Both",
    value: "both",
    hint: "global defaults, plus overrides for this project",
    existing: state.hasGlobalConfig && state.hasProjectConfig,
  };

  // Inside a project, the project is the likelier intent — unless nothing
  // global exists yet, in which case the machine has never been set up and
  // configuring only this one project would leave every other project
  // unprotected without saying so.
  return state.hasGlobalConfig
    ? [projectRow, globalRow, bothRow]
    : [globalRow, projectRow, bothRow];
}

/** `/home/x/y` → `~/y`, for display only. */
export function homeify(path: string, home: string = homedir()): string {
  const resolvedHome = resolve(home);
  const resolvedPath = resolve(path);
  if (resolvedPath === resolvedHome) return "~";
  return resolvedPath.startsWith(resolvedHome + "/")
    ? `~${resolvedPath.slice(resolvedHome.length)}`
    : resolvedPath;
}

/** The scopes a `SetupTarget` expands to. */
export function scopesFor(target: SetupTarget): Array<"user" | "project"> {
  return target === "both" ? ["user", "project"] : [target];
}
