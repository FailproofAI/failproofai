/**
 * GlobalThis-backed registry for custom hooks.
 * Shared via globalThis so that the user's hook file (which imports customPolicies
 * from 'failproofai') and the hook handler (which reads from this file) share the
 * same in-process state when running within the same Node.js process.
 */
import type { CustomHook, SemanticPolicyDeclaration } from "./policy-types";

const REGISTRY_KEY = "__failproofai_custom_hooks__";
/**
 * Beside the hook registry, on the same key namespace and cleared by the same
 * call — the two are one registration pass and a build step reads both.
 */
const SEMANTIC_KEY = "__failproofai_semantic_policies__";

function getRegistry(): CustomHook[] {
  const g = globalThis as Record<string, unknown>;
  if (!Array.isArray(g[REGISTRY_KEY])) g[REGISTRY_KEY] = [];
  return g[REGISTRY_KEY] as CustomHook[];
}

function getSemanticRegistry(): SemanticPolicyDeclaration[] {
  const g = globalThis as Record<string, unknown>;
  if (!Array.isArray(g[SEMANTIC_KEY])) g[SEMANTIC_KEY] = [];
  return g[SEMANTIC_KEY] as SemanticPolicyDeclaration[];
}

export const customPolicies = {
  add(hook: CustomHook): void {
    getRegistry().push(hook);
  },
};

/**
 * Register a semantic (Jev) policy — a question set for the classifier, read by
 * `failproofai publish` and emitted as the pack manifest's `semantic` array.
 *
 * A SEPARATE namespace from `customPolicies`, deliberately, rather than a
 * `customPolicies.addSemantic`. A semantic policy has no `fn` and no `match`,
 * and nothing about it ever executes on a user's machine: what installs is the
 * declaration in the manifest, and the artifact's call here matters only at
 * build time. Putting it behind the object whose entries return
 * `allow()`/`deny()` invites exactly the shape confusion the manifest parser
 * would then have to catch — a function on a semantic entry, a probe list on a
 * regex one — and both mistakes would be silent until somebody read a manifest.
 *
 * Nothing is validated here. `parsePackSemanticPolicy` in `pack-manifest.ts`
 * owns every rule, and it is applied at BUILD time (where the author can still
 * fix it) and again at load time (where the bytes may have come from anywhere).
 * Validating a third time in the setter would be a third copy of the rules.
 */
export const semanticPolicies = {
  add(policy: SemanticPolicyDeclaration): void {
    getSemanticRegistry().push(policy);
  },
};

export function getCustomHooks(): CustomHook[] {
  return getRegistry();
}

export function getSemanticRegistrations(): SemanticPolicyDeclaration[] {
  return getSemanticRegistry();
}

export function clearCustomHooks(): void {
  const g = globalThis as Record<string, unknown>;
  g[REGISTRY_KEY] = [];
  // Both maps, on one call. A loader that cleared only the hooks would carry
  // one entry file's semantic policies into the next file's build — and since
  // the semantic half is read after the load rather than during it, the extras
  // would be published under the wrong pack with nothing to notice.
  g[SEMANTIC_KEY] = [];
}
