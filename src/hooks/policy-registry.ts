/**
 * Module-level singleton policy registry backed by globalThis.
 *
 * Policies are keyed by name — registering a duplicate name replaces
 * the previous entry. Using globalThis ensures the registry survives
 * chunk splitting and remains a true singleton across dynamic imports.
 */
import type { HookEventType } from "./types";
import type { PolicyFunction, PolicyMatcher, PolicyParamsSchema, RegisteredPolicy } from "./policy-types";

const REGISTRY_KEY = "__FAILPROOFAI_POLICY_REGISTRY__";
const INDEX_CACHE_KEY = "__FAILPROOFAI_POLICY_INDEX_CACHE__";

/**
 * The default namespace applied to any policy name registered without a
 * `<namespace>/` prefix. Builtins live under this namespace; custom hooks
 * loaded by the handler get their own prefixes (e.g. `custom/foo`).
 */
export const DEFAULT_POLICY_NAMESPACE = "failproofai";

/**
 * Canonicalize a policy name. If the name already contains a `/`, it is
 * treated as already-namespaced and returned unchanged. Otherwise the
 * default namespace is prepended.
 */
export function normalizePolicyName(name: string): string {
  return name.includes("/") ? name : `${DEFAULT_POLICY_NAMESPACE}/${name}`;
}

interface GlobalWithRegistry {
  [REGISTRY_KEY]?: RegisteredPolicy[];
}

interface GlobalWithCache extends GlobalWithRegistry {
  [INDEX_CACHE_KEY]?: Map<string, RegisteredPolicy[]> | null;
}

function getIndexCache(): Map<string, RegisteredPolicy[]> | null | undefined {
  return (globalThis as GlobalWithCache)[INDEX_CACHE_KEY];
}

function setIndexCache(cache: Map<string, RegisteredPolicy[]> | null): void {
  (globalThis as GlobalWithCache)[INDEX_CACHE_KEY] = cache;
}

function getRegistry(): RegisteredPolicy[] {
  const g = globalThis as GlobalWithRegistry;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = [];
  }
  return g[REGISTRY_KEY];
}

export function registerPolicy(
  name: string,
  description: string,
  fn: PolicyFunction,
  match: PolicyMatcher,
  priority: number = 0,
  params?: PolicyParamsSchema,
): void {
  const canonical = normalizePolicyName(name);
  const registry = getRegistry();
  const idx = registry.findIndex((p) => p.name === canonical);
  const entry: RegisteredPolicy = {
    name: canonical, description, fn, match, priority,
    // Absent stays absent: `evaluatePolicies` distinguishes "declares a schema"
    // from "declares none", and a spread `params: undefined` is neither.
    ...(params ? { params } : {}),
  };
  if (idx >= 0) {
    registry[idx] = entry;
  } else {
    registry.push(entry);
  }
  setIndexCache(null); // invalidate on any registry change
}

export function getPoliciesForEvent(
  eventType: HookEventType,
  toolName?: string,
): RegisteredPolicy[] {
  let cache = getIndexCache();
  if (!cache) {
    cache = new Map();
    setIndexCache(cache);
  }
  const key = `${eventType}:${toolName ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const result = getRegistry()
    .filter((p) => {
      // If events specified, must match
      if (p.match.events && p.match.events.length > 0) {
        if (!p.match.events.includes(eventType)) return false;
      }
      // If toolNames specified, must match
      if (p.match.toolNames && p.match.toolNames.length > 0) {
        if (!toolName || !p.match.toolNames.includes(toolName)) return false;
      }
      return true;
    })
    .sort((a, b) => b.priority - a.priority);
  cache.set(key, result);
  return result;
}

export function clearPolicies(): void {
  const g = globalThis as GlobalWithRegistry;
  g[REGISTRY_KEY] = [];
  setIndexCache(null);
}

/**
 * Snapshot the current registry. Returns a shallow copy so callers can hold
 * a stable reference while the registry is mutated by other code paths
 * (notably the audit replay engine, which clears the registry to load only
 * builtins).
 */
export function getAllPolicies(): RegisteredPolicy[] {
  return [...getRegistry()];
}

/**
 * Replace the registry wholesale. Pair with `getAllPolicies()` to take a
 * snapshot before destructive operations and restore it afterwards.
 */
export function setAllPolicies(policies: RegisteredPolicy[]): void {
  const g = globalThis as GlobalWithRegistry;
  g[REGISTRY_KEY] = [...policies];
  setIndexCache(null);
}
