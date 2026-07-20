/**
 * Types for the hook policy system.
 */
import type { HookEventType, IntegrationType, SessionMetadata } from "./types";

export type PolicyDecision = "allow" | "deny" | "instruct";

export interface PolicyContext {
  eventType: HookEventType;
  payload: Record<string, unknown>;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  session?: SessionMetadata;
  params?: Record<string, unknown>;
  /** Which agent CLI fired this hook. Mirrors session.cli; exposed at the top level for ergonomics. */
  cli?: IntegrationType;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason?: string;
  message?: string;
}

export type PolicyFunction = (ctx: PolicyContext) => PolicyResult | Promise<PolicyResult>;

export interface PolicyMatcher {
  events?: HookEventType[];
  toolNames?: string[];
}

export interface RegisteredPolicy {
  name: string;
  description: string;
  fn: PolicyFunction;
  match: PolicyMatcher;
  priority: number;
}

export interface PolicyParamsSchema {
  [paramName: string]: {
    type: "string" | "number" | "boolean" | "string[]" | "pattern[]";
    description: string;
    default: unknown;
  };
}

export interface BuiltinPolicyDefinition {
  name: string;
  description: string;
  fn: PolicyFunction;
  match: PolicyMatcher;
  defaultEnabled: boolean;
  category: string;
  beta?: boolean;
  params?: PolicyParamsSchema;
  /** User-facing past-tense phrase used in `failproofai audit` output.
   *  Frames the agent's action as something the user observes after-the-fact,
   *  e.g. "Tried to push to main branch" or "Redacted JWT from tool output".
   *  Falls back to `description` when omitted. */
  displayTitle?: string;
  /** One short clause describing the consequence of the action, used as a
   *  secondary line in the audit report. e.g. "Could leak code from neighboring
   *  repos to the model." */
  impact?: string;
}

export interface CustomHook {
  name: string;
  description?: string;
  match?: {
    events?: HookEventType[];
  };
  fn: (ctx: PolicyContext) => PolicyResult | Promise<PolicyResult>;
}

export interface LlmConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface HooksConfig {
  enabledPolicies: string[];
  llm?: LlmConfig;
  policyParams?: Record<string, Record<string, unknown>>;
  customPoliciesPath?: string;
  /**
   * Turn off convention-discovered custom policies (`.failproofai/policies/`)
   * without deleting or renaming the files. Absent means enabled — the default
   * has to be "on" so that dropping a policy file in works with no config at
   * all, and so existing installs don't lose their custom rules on upgrade.
   * Only ever written explicitly as `false`.
   */
  customPoliciesEnabled?: boolean;
}
