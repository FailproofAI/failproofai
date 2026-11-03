/**
 * Public API for failproofai custom hooks.
 *
 * Used as the bundle entry point for `dist/index.js` (CJS) and re-exported
 * by the ESM shim that rewrites `from 'failproofai'` in user hook files.
 */
export {
  customPolicies,
  semanticPolicies,
  getCustomHooks,
  getSemanticRegistrations,
  clearCustomHooks,
} from "./hooks/custom-hooks-registry";
export { allow, deny, instruct } from "./hooks/policy-helpers";
export type {
  PolicyContext,
  PolicyResult,
  CustomHook,
  PolicyDecision,
  PolicyFunction,
  PolicyAuthority,
  SemanticPolicyDeclaration,
  SemanticProbeDeclaration,
  SemanticToolClass,
} from "./hooks/policy-types";
