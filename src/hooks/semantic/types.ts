/**
 * Types for the semantic (Jev-backed) evaluator.
 *
 * The regex engine answers "does this string match"; this one asks TypeSafe's
 * Jev a set of typed yes/no questions about the tool call and decides from the
 * probabilities. Everything here is plain data so the decision can be replayed
 * offline from a recorded response — see `decide.ts`.
 */

/** Coarse class of a tool, derived deterministically from its canonical name. */
export type ToolClass = "shell" | "write" | "read" | "network" | "other";

/** A single yes/no question sent to Jev (the `noul` primitive). */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface JevRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, NoulQuestion>;
}

export interface JevNoulAnswer {
  type?: "noul";
  noul: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevNoulAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Set when the provider did not report which Jev version answered (Cloudflare's unversioned alias). */
  modelUnverified?: boolean;
}

/** A yes/no probe. A policy fires only when every one of its probes holds. */
export interface Probe {
  id: string;
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface SemanticPolicy {
  /** Short slug; registered as `semantic/<name>` in reasons and logs. */
  name: string;
  /** Past-tense, human-readable description of what was caught. */
  title: string;
  /** Tool classes this policy is asked about. Unknown/MCP tools get every policy. */
  appliesTo: ReadonlyArray<ToolClass>;
  /**
   * `deny` policies block when the evidence is strong and instruct when it is
   * moderate; `instruct` policies only ever warn.
   */
  mode: "deny" | "instruct";
  /**
   * Whether the user's own explicit request may clear this policy. False for
   * the few things a prompt injection most wants to be approved for.
   */
  userCanOverride: boolean;
  /** Every probe must hold for the policy to fire (conjunction). */
  probes: ReadonlyArray<Probe>;
  /** If this holds, the policy does not fire — the documented exceptions. */
  exempt?: Probe;
  /** Deterministic precondition over the facts; when false nothing is asked. */
  precondition?: (facts: Facts) => boolean;
  /** Shown to the agent when the policy fires. */
  guidance: string;
  /** The pack that declared it; absent for the compiled-in set. Attribution only. */
  origin?: { packId: string; packVersion?: string };
}

export interface PathFact {
  asWritten: string;
  resolved: string;
  relation: "inside_project" | "project_root" | "outside_project_in_home" | "home_root" | "system" | "root";
}

/** Deterministic facts computed locally, so Jev never has to count or resolve. */
export interface Facts {
  toolName: string;
  toolClass: ToolClass;
  /** False for tools no canonical map recognised — MCP tools, skills, etc. */
  toolIsKnown: boolean;
  cwd: string | null;
  projectRoot: string | null;
  currentGitBranch: string | null;
  paths: PathFact[];
  permissionMode: string | null;
}

export interface SemanticInput {
  eventType: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd?: string;
  /**
   * The project root pinned for the session (`session-root.ts`), so a `cd`
   * cannot move what counts as inside the project. Absent: derived from `cwd`.
   */
  projectRoot?: string;
  permissionMode?: string;
  /** What the human typed recently, oldest first. Trusted channel only. */
  userSaid: string[];
  /**
   * The agent's last visible message before the human's latest one — what a
   * reply like "yes" or "do it" refers to. Agent-written, so it may only ever
   * explain a human reply; it is never consent on its own.
   */
  agentLastMessage?: string | null;
}

/**
 * How "did the human ask for this?" is put to Jev.
 *
 * - `v0`: one `user_asked` question per policy, phrased as the policy's harm,
 *   plus a global `scope` question. Measured to clear a policy 6 times in
 *   1,332 cases.
 * - `v1`: three task-level questions asked once per call — is this a step
 *   toward the human's task, did they ask for this exact operation, does it
 *   reach beyond what they asked — judged only against the human's own words
 *   with harness-written text removed.
 */
export type IntentMode = "v0" | "v1";

export interface PolicyOutcome {
  policy: string;
  mode: "deny" | "instruct";
  /** The policy's own `userCanOverride`: false is a check no consent can clear. */
  userCanOverride?: boolean;
  /** min over probe probabilities — one weak probe spoils the evidence. */
  evidence: number;
  exempt: number | null;
  userAsked: number | null;
  targetNamedByUser: boolean;
  /** Fired, and the request also addressed the reviewer — so it was blocked outright. */
  escalatedByInjection: boolean;
  verdict: "deny" | "instruct" | "overridden" | "none";
  /** v1 only: why an override applied, or that a deny was softened to instruct. */
  intent?: "op-requested" | "task-step" | "downgraded-task-step";
}

export interface SemanticVerdict {
  decision: "allow" | "deny" | "instruct";
  reason: string | null;
  outcomes: PolicyOutcome[];
  injectionSuspected: number | null;
  /** The `scope` answer: does the request stay within what the user asked? null when not asked. */
  scopeWithinRequest: number | null;
  /** v1 only: set when the call was flagged for reaching beyond the human's task. */
  beyondTask?: boolean;
}
