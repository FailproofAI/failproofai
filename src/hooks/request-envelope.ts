/**
 * The canonical, location-independent evaluation-request envelope.
 *
 * Phase 1 / Stage 0 item **P4** ("move session-metadata resolution to the
 * caller"). Everything the evaluator needs to decide a hook event travels in
 * one typed value, so the same request is answerable by the in-process legacy
 * path today and by `failproofaid` over a framed socket tomorrow — without the
 * evaluator ever reading ambient host state (`homedir()`, `process.env`,
 * `process.cwd()`, or the user's transcript tree) for itself.
 *
 * ## Provenance is part of the contract
 *
 * Amendment #3 of
 * `desgin-docs/v1.0.0/phase-1-local-enforcement/implementation/03-risks-and-amendments.md`:
 * request context is **not** uniform, and pretending it is would ship a
 * security claim that is not true.
 *
 *   • `home` is **daemon-derived** — `getpwuid_r(peer_uid)` in Stage 1, i.e.
 *     read from the kernel's view of the peer, never from the request. This is
 *     not pedantry: `isAgentInternalPath` and `block-read-outside-cwd` both
 *     *widen* the allow set, so a client asserting `home: "/"` would make every
 *     path on the machine "agent internal" — a forged input relaxing a sealed
 *     verdict. A client-asserted `home` is therefore a **protocol error**
 *     ({@link EnvelopeProtocolError}), not a degraded input. On the in-process
 *     legacy path there is no peer to derive from — the reader and the subject
 *     are the same process — so the value comes from `os.homedir()` and is
 *     labeled `"local"`.
 *
 *   • `cwd`, `projectDir`, and `envFacts` genuinely cannot be derived —
 *     `/proc/<pid>/cwd` is TOCTOU-prone and unavailable on macOS to a
 *     non-matching UID — so they ride as `"client-asserted"` with explicit
 *     provenance. A decision whose deciding policy read one of them is
 *     `sealed_unattested` (see {@link sealedUnattested}); Stage 1+ records that
 *     in decision evidence and `policies explain` reports it. Provenance is
 *     what this records — which inputs the enforcer derived — and not verdict
 *     integrity, which v1.0.0's user scope does not claim.
 *
 * ## Import purity
 *
 * This module has **no runtime imports at all** — only `import type`, which
 * TypeScript erases. That is load-bearing, not tidiness: a later stage derives
 * a policy's sealed / `user-context` execution tier from its *resolved* import
 * graph, so anything reachable from a module that sits on the sealed path
 * decides that module's tier. Consequently the one function that needs host
 * state, {@link buildLocalEnvelope}, does not read it either — it takes
 * {@link LocalHostFacts} and only *labels* them. The single read site is
 * `readLocalHostFacts()` in `./local-host`, which owns the `node:os` import.
 */
import type { HookEventType, IntegrationType, SessionMetadata } from "./types";

/** Bumped when the wire shape below changes incompatibly. */
export const ENVELOPE_PROTOCOL_VERSION = 1;

// ── Environment facts ──────────────────────────────────────────────────────

/**
 * The closed set of environment variables a policy may observe.
 *
 * Deliberately an allowlist, never `process.env` wholesale: the envelope
 * crosses a privilege boundary in Stage 1, and the daemon must not become a
 * channel for a hook client's entire environment (tokens, keys, proxy creds).
 * `CLAUDE_PROJECT_DIR` is the only one any policy reads today —
 * `builtin-policies.ts` prefers it over `ctx.session.cwd` as the stable project
 * root. Adding a key here is a deliberate contract change.
 */
export const ENV_FACT_KEYS = ["CLAUDE_PROJECT_DIR"] as const;

export type EnvFactKey = (typeof ENV_FACT_KEYS)[number];

/** Bounded, explicitly enumerated environment facts. Never the whole env. */
export type EnvFacts = Readonly<Partial<Record<EnvFactKey, string>>>;

/**
 * Project `env` down to {@link ENV_FACT_KEYS}. Pure: the caller supplies the
 * environment, so this stays testable and host-free. Empty strings are dropped
 * — an exported-but-empty variable carries no more information than an unset
 * one, and treating it as a value would make `projectDir` an empty path.
 */
export function selectEnvFacts(env: Readonly<Record<string, string | undefined>>): EnvFacts {
  const out: Partial<Record<EnvFactKey, string>> = {};
  for (const key of ENV_FACT_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

// ── Host block ─────────────────────────────────────────────────────────────

/**
 * Where a host field's value came from.
 *
 *   • `daemon-derived` — the daemon computed it from the OS view of the peer
 *     (`getpwuid_r(peer_uid)`). Nothing the client sent could influence it.
 *   • `local`          — the in-process legacy path read it from its own
 *     process. Equally underived-from-the-request, because there is no
 *     boundary: the reader and the subject are the same process.
 *   • `client-asserted` — the requester supplied it and nothing verified it.
 */
export type HostFieldProvenance = "daemon-derived" | "local" | "client-asserted";

/** The provenances that are *not* client-asserted, i.e. attested. */
export type AttestedProvenance = Exclude<HostFieldProvenance, "client-asserted">;

export interface HostField<T, P extends HostFieldProvenance = HostFieldProvenance> {
  readonly value: T;
  readonly provenance: P;
}

/** Every host field a decision can be said to have "read". */
export const HOST_FIELD_NAMES = ["home", "cwd", "projectDir", "envFacts"] as const;

export type HostFieldName = (typeof HOST_FIELD_NAMES)[number];

/**
 * The host block **as it arrives**, before validation.
 *
 * `home` is typed with the full provenance union here on purpose: a forged,
 * client-asserted home must be *representable* in order to be *rejectable*.
 * If the type made it unspellable, the only way to encounter one would be an
 * unchecked cast at the boundary — which is exactly where it would go
 * unnoticed. {@link assertHostContext} narrows this to {@link HostContext}.
 */
export interface UnvalidatedHostContext {
  readonly home: HostField<string, HostFieldProvenance>;
  readonly cwd: HostField<string | undefined, "client-asserted">;
  readonly projectDir: HostField<string | undefined, "client-asserted">;
  readonly envFacts: HostField<EnvFacts, "client-asserted">;
}

/** A host block that has passed {@link assertHostContext}. */
export interface HostContext extends UnvalidatedHostContext {
  readonly home: HostField<string, AttestedProvenance>;
}

export type EnvelopeProtocolErrorCode = "client_asserted_home";

/** A malformed request, as distinct from a request that merely decides `allow`. */
export class EnvelopeProtocolError extends Error {
  readonly code: EnvelopeProtocolErrorCode;
  readonly field: HostFieldName;

  constructor(code: EnvelopeProtocolErrorCode, field: HostFieldName, message: string) {
    super(message);
    this.name = "EnvelopeProtocolError";
    this.code = code;
    this.field = field;
  }
}

/**
 * Non-throwing validation. Returns the violation, or `null` when the host
 * block is well-formed.
 */
export function checkHostContext(host: UnvalidatedHostContext): EnvelopeProtocolError | null {
  if (host.home.provenance === "client-asserted") {
    return new EnvelopeProtocolError(
      "client_asserted_home",
      "home",
      "protocol error: `home` must be daemon-derived (getpwuid_r of the peer UID) " +
        "or locally read; a client-asserted home widens isAgentInternalPath and " +
        "block-read-outside-cwd and is never accepted",
    );
  }
  return null;
}

/** Throwing form of {@link checkHostContext}; narrows to {@link HostContext}. */
export function assertHostContext(host: UnvalidatedHostContext): asserts host is HostContext {
  const violation = checkHostContext(host);
  if (violation) throw violation;
}

/**
 * Did this decision depend on anything the client asserted?
 *
 * `fieldsRead` is the set of host fields the deciding policy actually consumed
 * — not the set the envelope carried. A `block-sudo` verdict reads no host
 * field at all and is fully attested even though the envelope contains a
 * client-asserted `cwd`; a `block-read-outside-cwd` verdict reads `cwd` and is
 * therefore `sealed_unattested`.
 *
 * Stage 0 ships the type and the pure function only — nothing consumes it yet.
 * Stage 1+ writes the result into decision evidence and `policies explain`
 * surfaces it.
 *
 * Fails *toward* unattested: a client-asserted `home` (a protocol error that
 * should have been rejected upstream by {@link assertHostContext}) counts as
 * unattested here rather than silently passing as attested.
 */
export function sealedUnattested(
  host: UnvalidatedHostContext,
  fieldsRead: Iterable<HostFieldName>,
): boolean {
  for (const field of fieldsRead) {
    if (host[field]?.provenance === "client-asserted") return true;
  }
  return false;
}

// ── The envelope ───────────────────────────────────────────────────────────

/**
 * Session identity resolved **by the caller**, not by the evaluator.
 *
 * `transcriptPath` and `permissionMode` are the P4 headline: resolving them
 * means walking `~/.codex/sessions`, `~/.copilot/session-state`, and friends —
 * trees whose size is unbounded, on the enforcement deadline path. The client
 * is already walking them for the legacy path, so it resolves them once and
 * ships the answers rather than making the daemon repeat the walk while a tool
 * call waits.
 */
export interface EnvelopeSession {
  readonly sessionId?: string;
  readonly transcriptPath?: string;
  readonly permissionMode?: string;
  /** The stdin payload's `hook_event_name`, when present. */
  readonly hookEventName?: string;
}

/**
 * Everything the evaluator needs, and nothing it must go and find.
 *
 * `payload` is already canonicalized by the caller (per-CLI event name, tool
 * name, and tool-input keys), so the evaluator never re-derives them.
 */
export interface EvaluationRequest {
  readonly protocolVersion: typeof ENVELOPE_PROTOCOL_VERSION;
  readonly cli: IntegrationType;
  /** Canonical PascalCase event type. */
  readonly eventType: HookEventType;
  /** The CLI-side event name as passed on `--hook`, before canonicalization. */
  readonly rawEventType: string;
  /** Canonicalized hook stdin payload. */
  readonly payload: Record<string, unknown>;
  readonly session: EnvelopeSession;
  readonly host: HostContext;
}

// ── Construction ───────────────────────────────────────────────────────────

/**
 * Raw host state, as read from the in-process host by `readLocalHostFacts()`
 * in `./local-host` — the only module allowed to touch it.
 */
export interface LocalHostFacts {
  /** `os.homedir()`. */
  readonly home: string;
  /** {@link selectEnvFacts} over `process.env`. */
  readonly envFacts: EnvFacts;
}

export interface LocalEnvelopeInput {
  readonly cli: IntegrationType;
  readonly eventType: HookEventType;
  readonly rawEventType: string;
  readonly payload: Record<string, unknown>;
  /** Already resolved by `resolveCwd(cli, payload)`. */
  readonly cwd?: string;
  readonly sessionId?: string;
  /** Already resolved by `resolveTranscriptPath(cli, payload, sessionId)`. */
  readonly transcriptPath?: string;
  /** Already resolved by `resolvePermissionMode(cli, payload, sessionId)`. */
  readonly permissionMode?: string;
  readonly hookEventName?: string;
  readonly host: LocalHostFacts;
}

/**
 * Build the envelope for the in-process legacy path.
 *
 * Labels `home` `"local"` (this process read its own homedir — no boundary was
 * crossed) and everything the harness told us `"client-asserted"`.
 * `projectDir` is derived from the `CLAUDE_PROJECT_DIR` env fact, matching what
 * `builtin-policies.ts` reads today, and inherits that fact's provenance.
 *
 * Per the module header this function does **not** read the host itself; it
 * takes {@link LocalHostFacts} so this module stays import-pure.
 */
export function buildLocalEnvelope(input: LocalEnvelopeInput): EvaluationRequest {
  return {
    protocolVersion: ENVELOPE_PROTOCOL_VERSION,
    cli: input.cli,
    eventType: input.eventType,
    rawEventType: input.rawEventType,
    payload: input.payload,
    session: {
      sessionId: input.sessionId,
      transcriptPath: input.transcriptPath,
      permissionMode: input.permissionMode,
      hookEventName: input.hookEventName,
    },
    host: {
      home: { value: input.host.home, provenance: "local" },
      cwd: { value: input.cwd, provenance: "client-asserted" },
      projectDir: {
        value: input.host.envFacts.CLAUDE_PROJECT_DIR,
        provenance: "client-asserted",
      },
      envFacts: { value: input.host.envFacts, provenance: "client-asserted" },
    },
  };
}

/**
 * Project the envelope back onto the legacy `SessionMetadata` shape.
 *
 * The bridge that keeps P4 behavior-preserving: `handler.ts` builds the
 * envelope once and derives `session` from it, so there is exactly one source
 * of truth for session identity while every policy keeps seeing the object it
 * sees today.
 *
 * `home` and `projectDir` are projected too (P2), which is what makes the
 * legacy and daemon paths structurally identical rather than merely
 * equivalent: on both, a policy reads host context off the session object it
 * was handed, and neither reaches for `os.homedir()` or `process.env` on its
 * own. The values are the same ones `builtin-policies.ts` installs as its
 * fallback, so behaviour is unchanged; what changes is that the fallback is now
 * the *unused* path in production rather than the only path.
 *
 * `projectDir` is left undefined rather than empty-string when the env fact is
 * absent or blank, preserving the `process.env.CLAUDE_PROJECT_DIR || cwd`
 * falsy-check the policy used before P2.
 */
export function envelopeToSessionMetadata(request: EvaluationRequest): SessionMetadata {
  return {
    sessionId: request.session.sessionId,
    transcriptPath: request.session.transcriptPath,
    cwd: request.host.cwd.value,
    permissionMode: request.session.permissionMode,
    hookEventName: request.session.hookEventName,
    rawHookEventName: request.rawEventType,
    cli: request.cli,
    home: request.host.home.value || undefined,
    projectDir: request.host.projectDir.value || undefined,
  };
}
