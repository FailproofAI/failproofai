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
  /**
   * The policy's declared params, carried HERE rather than looked up in a map
   * built from the builtin catalog. That map could only ever describe policies
   * compiled into this build, so anything arriving from a pack, a cloud
   * assignment or a custom file fell through to `params: {}` — which discarded
   * the user's OWN configured `policyParams` for it, not merely the defaults.
   */
  params?: PolicyParamsSchema;
  /** Whether Jev may clear this policy's deny/instruct; see {@link effectiveAuthority}. */
  authority?: PolicyAuthority;
  /** The semantic policies (`src/hooks/semantic/policies.ts`) that must all come back clear. */
  reviewedBy?: string[];
}

/**
 * Who has the last word on a policy's deny or instruct when Jev is configured.
 *
 * - `hard`: final. Jev can never clear it.
 * - `reviewable`: Jev may clear it, but only through the semantic policies
 *   named in `reviewedBy`, and only when every one of them was actually asked
 *   and came back clear.
 */
export type PolicyAuthority = "hard" | "reviewable";

/**
 * The authority a policy actually has. `reviewable` only when it is declared
 * `reviewable`, names at least one semantic policy in `reviewedBy`, and is not
 * `alwaysOn`. Anything else — absent, invalid, an empty `reviewedBy`, the
 * self-protection guard — is `hard`, so an unknown custom, cloud or third-party
 * policy can never be weakened by Jev.
 *
 * This is the §7 contract every task builds against, and it is deliberately
 * the looser of two rules: one usable name is enough here. REGISTRATION is
 * stricter — `resolvePolicyAuthority` in `policy-authority.ts` makes the whole
 * declaration hard if any entry is malformed or is not a semantic policy this
 * build has, and that is what `registerPolicy` stores. So a registered policy's
 * `reviewedBy` is already clean, and the two rules agree on everything that
 * reaches the registry.
 */
export function effectiveAuthority(p: {
  authority?: unknown;
  reviewedBy?: unknown;
  alwaysOn?: boolean;
}): PolicyAuthority {
  if (p.alwaysOn === true) return "hard";
  if (p.authority !== "reviewable") return "hard";
  if (!Array.isArray(p.reviewedBy)) return "hard";
  const named = p.reviewedBy.filter((n) => typeof n === "string" && n.length > 0);
  return named.length > 0 ? "reviewable" : "hard";
}

export interface PolicyParamsSchema {
  [paramName: string]: {
    type: "string" | "number" | "boolean" | "string[]" | "pattern[]";
    description: string;
    default: unknown;
  };
}

/**
 * A builtin policy minus its implementation — exactly what `policy-catalog.ts`
 * holds. Derived from {@link BuiltinPolicyDefinition} rather than declared
 * separately so a field added to one can never be forgotten on the other.
 */
export type PolicyCatalogEntry = Omit<BuiltinPolicyDefinition, "fn">;

export interface BuiltinPolicyDefinition {
  name: string;
  description: string;
  fn: PolicyFunction;
  match: PolicyMatcher;
  defaultEnabled: boolean;
  /**
   * Registered on every evaluation regardless of the user's `enabledPolicies`,
   * an active session pause, or an unreadable config — and never eligible to
   * move out of the package into a fetched pack. Reserved for the guard that
   * stops an agent from disabling failproofai itself; a guard the agent can
   * switch off by the same means it is meant to prevent is decorative.
   *
   * `defaultEnabled` stays `true` alongside it so the policy still appears
   * enabled everywhere the catalog is listed rather than looking switched off.
   */
  alwaysOn?: boolean;
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
  /** See {@link PolicyAuthority}. Absent means `hard`. */
  authority?: PolicyAuthority;
  /** See {@link RegisteredPolicy.reviewedBy}. */
  reviewedBy?: string[];
}

export interface CustomHook {
  name: string;
  description?: string;
  match?: {
    events?: HookEventType[];
  };
  fn: (ctx: PolicyContext) => PolicyResult | Promise<PolicyResult>;
  /**
   * See {@link PolicyAuthority}. Absent means `hard`.
   *
   * Honored for the user's own local policy files (explicit paths and
   * `.failproofai/policies/`). For a pack policy the pack's MANIFEST decides,
   * and for a cloud-managed one the cloud ARTIFACT record does — the same split
   * as `params`, so the declaration a user reviewed in a listing is the one
   * that takes effect.
   */
  authority?: PolicyAuthority;
  /** See {@link RegisteredPolicy.reviewedBy}. */
  reviewedBy?: string[];
}

export interface LlmConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/**
 * The collector's non-secret settings. The ingest credential deliberately does
 * NOT live here: this file is written with a bare `writeFileSync`, so it
 * inherits the umask and lands at 0664 inside a 0775 `~/.failproofai/` — an API
 * key here would be readable by every local user. It lives in
 * `~/.failproofai/ingest.json` at 0600 instead.
 *
 * Read by the Rust daemon (`crates/fpai-collect/src/config.rs`); the field
 * names must stay in step with the `Settings` struct there.
 */
export interface CollectorConfig {
  /**
   * Ship agent session transcripts. Defaults to false and is a SEPARATE opt-in
   * from configuring a key, because transcripts carry prompts, file contents
   * and whatever was pasted into a terminal.
   */
  sessions?: boolean;
  /** Ship hook activity. Carries decisions and tool names, never file contents. */
  hooks?: boolean;
  /** `decisions` keeps every deny/instruct exact and aggregates the ~99% allows. */
  hooksVerbosity?: "all" | "decisions" | "off";
  redact?: "minimal" | "off";
  /** Label stamped on every event. Must not contain a comma — ingest skips those lines. */
  environment?: string;
}

export interface HooksConfig {
  enabledPolicies: string[];
  /** Collector settings; see {@link CollectorConfig}. Absent means unconfigured. */
  collector?: CollectorConfig;
  llm?: LlmConfig;
  policyParams?: Record<string, Record<string, unknown>>;
  /** Explicit custom policy files, loaded in array order. */
  customPoliciesPaths?: string[];
  /** @deprecated Use customPoliciesPaths. Kept for existing config files. */
  customPoliciesPath?: string;
  /** Source-qualified custom policy IDs that should not be registered. */
  disabledCustomPolicies?: string[];
  /**
   * Turn off convention-discovered custom policies (`.failproofai/policies/`)
   * without deleting or renaming the files. Absent means enabled — the default
   * has to be "on" so that dropping a policy file in works with no config at
   * all, and so existing installs don't lose their custom rules on upgrade.
   * Only ever written explicitly as `false`.
   */
  customPoliciesEnabled?: boolean;
  /**
   * Record of the convention policies (`.failproofai/policies/*policies.mjs`)
   * discovered at this scope the last time a failproofai command ran.
   *
   * DESCRIPTIVE, NEVER AUTHORITATIVE. Enforcement always discovers from the
   * filesystem (`loadAllCustomHooks`) and never reads this key — a policy file
   * dropped in enforces on the very next tool call whether or not this list has
   * caught up. Making the loader trust it would mean a freshly-copied policy
   * silently doing nothing until some command refreshed the config, which is
   * the exact silent-non-enforcement failure this project exists to remove.
   *
   * Refreshed wholesale (not merged) by `failproofai policies` and the setup
   * wizard, so a deleted file disappears from the record on the next run. It is
   * deliberately NOT written from the hook path: that runs on every tool call,
   * and a read-modify-write from concurrent short-lived hook processes with no
   * locking would corrupt the file that governs enforcement.
   */
  conventionPolicies?: ConventionPolicyRecord[];
  /**
   * `true` once `failproofai config` has installed and started the
   * failproofaid background daemon for this machine. Global scope ONLY —
   * whether *this specific machine* has a running daemon is not something a
   * committed project config should be able to assert on a teammate's
   * behalf, so `readMergedHooksConfig` does not merge this key across
   * scopes the way `enabledPolicies` merges. See `daemon-client.ts`.
   *
   * Governs the fail-closed/in-process split entirely: unset (or `false`)
   * means this machine has never been daemon-configured, so hooks run the
   * same full in-process evaluation they always have, with no socket
   * attempt at all. Once `true`, an unreachable daemon fails closed instead
   * of silently falling back — see the plan's "Confirmed scope decisions".
   */
  daemonConfigured?: boolean;
}

/** One convention policy file and the hooks it registered, as last observed. */
export interface ConventionPolicyRecord {
  /** Basename, e.g. `hermes-guardrails.policies.mjs`. */
  file: string;
  /** Hook names the file registered, or `[]` if it failed to load. */
  hooks: string[];
}
