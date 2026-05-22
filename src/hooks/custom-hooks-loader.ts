/**
 * Loads user-authored policy files with ESM import rewriting.
 * Supports transitive local imports and `import { ... } from 'failproofai'`.
 *
 * Two loading modes:
 * 1. Explicit: a single file via `customPoliciesPath` in policies-config.json
 * 2. Convention: auto-discovered *policies.{js,mjs,ts} files from
 *    .failproofai/policies/ at project and user level (git-hooks style)
 *
 * Fail-open: any error (file not found, syntax error, import failure) is logged
 * and results in an empty hook list for that file. Builtins continue normally.
 */
import { resolve, isAbsolute, basename } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { hookLogWarn, hookLogError, hookLogInfo } from "./hook-logger";
import { getCustomHooks, clearCustomHooks } from "./custom-hooks-registry";
import { findDistIndex, rewriteFileTree, TMP_SUFFIX, cleanupTmpFiles } from "./loader-utils";
import { findProjectConfigDir } from "./hooks-config";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";
import type { CustomHook } from "./policy-types";

const LOADING_KEY = "__FAILPROOFAI_LOADING_HOOKS__";

/** Regex matching convention policy filenames: *policies.{js,mjs,ts} */
const CONVENTION_FILE_RE = /policies\.(js|mjs|ts)$/;

/**
 * Scan a directory for convention policy files (*policies.{js,mjs,ts}).
 * Returns sorted absolute paths. Returns [] if the directory doesn't exist.
 */
export function discoverPolicyFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && CONVENTION_FILE_RE.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => resolve(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Load a single policy file into the globalThis custom hooks registry.
 * Does NOT clear the registry — caller is responsible for that.
 */
async function loadSingleFile(
  absPath: string,
  opts?: { strict?: boolean; conventionScope?: "project" | "user" },
): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  g[LOADING_KEY] = true;

  let tmpFiles: string[] = [];
  try {
    const distIndex = await findDistIndex();
    const distUrl = distIndex ? pathToFileURL(distIndex).href : null;

    tmpFiles = await rewriteFileTree(absPath, distUrl, distIndex);

    const entryTmp = absPath + TMP_SUFFIX;
    const fileUrl = pathToFileURL(entryTmp).href;
    await import(/* webpackIgnore: true */ fileUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorType = /Cannot find module|MODULE_NOT_FOUND|ENOENT/i.test(msg)
      ? "module_not_found"
      : /SyntaxError|Unexpected token/i.test(msg)
        ? "syntax_error"
        : "runtime_error";
    void trackHookEvent(getInstanceId(), "custom_hooks_load_error", {
      error_type: errorType,
      is_convention: !!opts?.conventionScope,
      convention_scope: opts?.conventionScope ?? null,
      file_basename: basename(absPath),
    });
    if (opts?.strict) throw new Error(`Failed to load custom hooks from ${absPath}: ${msg}`);
    hookLogError(`failed to load custom hooks from ${absPath}: ${msg}`);
  } finally {
    g[LOADING_KEY] = false;
    await cleanupTmpFiles(tmpFiles);
  }
}

/**
 * Load a single explicit custom hooks file (legacy API).
 * Clears the registry, loads the file, returns registered hooks.
 */
export async function loadCustomHooks(
  customPoliciesPath: string | undefined,
  opts?: { strict?: boolean; sessionCwd?: string },
): Promise<CustomHook[]> {
  if (!customPoliciesPath) return [];

  const absPath = isAbsolute(customPoliciesPath)
    ? customPoliciesPath
    : resolve(opts?.sessionCwd ?? process.cwd(), customPoliciesPath);

  if (!existsSync(absPath)) {
    if (opts?.strict) throw new Error(`Custom hooks file not found: ${absPath}`);
    hookLogWarn(`customPoliciesPath not found: ${absPath}`);
    return [];
  }

  clearCustomHooks();
  await loadSingleFile(absPath, opts);
  return getCustomHooks();
}

/** Source metadata for a loaded convention policy file. */
export interface ConventionSource {
  scope: "project" | "user";
  file: string;
  hookNames: string[];
}

/** Result of loadAllCustomHooks with source metadata. */
export interface LoadAllResult {
  hooks: CustomHook[];
  conventionSources: ConventionSource[];
}

/**
 * Load ALL custom hooks: explicit customPoliciesPath + convention-discovered files.
 *
 * Load order:
 * 1. Explicit customPoliciesPath (if configured)
 * 2. Project convention: {cwd}/.failproofai/policies/*policies.{js,mjs,ts} (alphabetical)
 * 3. User convention: ~/.failproofai/policies/*policies.{js,mjs,ts} (alphabetical)
 *
 * Each file is loaded independently (fail-open per file).
 * Convention hooks are tagged with __conventionScope so the handler can build scoped prefixes.
 */
export async function loadAllCustomHooks(
  customPoliciesPath: string | undefined,
  opts?: { sessionCwd?: string },
): Promise<LoadAllResult> {
  clearCustomHooks();

  const conventionSources: ConventionSource[] = [];

  const projectRoot = findProjectConfigDir(opts?.sessionCwd ?? process.cwd());

  // 1. Explicit customPoliciesPath (existing behavior)
  if (customPoliciesPath) {
    const absPath = isAbsolute(customPoliciesPath)
      ? customPoliciesPath
      : resolve(projectRoot, customPoliciesPath);
    if (existsSync(absPath)) {
      await loadSingleFile(absPath);
    } else {
      hookLogWarn(`customPoliciesPath not found: ${absPath}`);
    }
  }

  const hooksBeforeConvention = getCustomHooks().length;

  // 2. Project convention: {projectRoot}/.failproofai/policies/*policies.{js,mjs,ts}
  const projectDir = resolve(projectRoot, ".failproofai", "policies");
  const projectFiles = discoverPolicyFiles(projectDir);
  for (const file of projectFiles) {
    const hooksBefore = getCustomHooks().length;
    await loadSingleFile(file, { conventionScope: "project" });
    const newHooks = getCustomHooks().slice(hooksBefore);
    if (newHooks.length > 0) {
      conventionSources.push({
        scope: "project",
        file: basename(file),
        hookNames: newHooks.map((h) => h.name),
      });
    }
  }

  // 3. User convention: ~/.failproofai/policies/*policies.{js,mjs,ts}
  const userDir = resolve(homedir(), ".failproofai", "policies");
  const userFiles = discoverPolicyFiles(userDir);
  for (const file of userFiles) {
    const hooksBefore = getCustomHooks().length;
    await loadSingleFile(file, { conventionScope: "user" });
    const newHooks = getCustomHooks().slice(hooksBefore);
    if (newHooks.length > 0) {
      conventionSources.push({
        scope: "user",
        file: basename(file),
        hookNames: newHooks.map((h) => h.name),
      });
    }
  }

  const allHooks = getCustomHooks();
  const conventionCount = allHooks.length - hooksBeforeConvention;

  if (projectFiles.length > 0 || userFiles.length > 0) {
    hookLogInfo(
      `convention policies: ${projectFiles.length} project file(s), ${userFiles.length} user file(s), ${conventionCount} hook(s)`,
    );
  }

  // Tag convention hooks with their scope so the handler can build scoped prefixes.
  // Build a name→scope map from conventionSources, then tag by object reference
  // to avoid mis-tagging an explicit custom hook that shares the same name.
  const hookNameToScope = new Map<string, string>();
  for (const source of conventionSources) {
    for (const name of source.hookNames) {
      hookNameToScope.set(name, source.scope);
    }
  }
  const conventionHookRefs = new Set<CustomHook>();
  for (const hook of allHooks.slice(hooksBeforeConvention)) {
    conventionHookRefs.add(hook);
  }
  for (const hook of allHooks) {
    if (conventionHookRefs.has(hook)) {
      (hook as CustomHook & { __conventionScope?: string }).__conventionScope =
        hookNameToScope.get(hook.name) ?? "project";
    }
  }

  return { hooks: allHooks, conventionSources };
}
