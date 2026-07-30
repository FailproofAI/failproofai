/**
 * The sealed policy worker's entry point.
 *
 * This module is bundled (by `scripts/build-sealed-bundle.ts`) into a single
 * self-contained JavaScript file and evaluated inside a QuickJS context that
 * has **no bindings registered** — no `require`, no module resolution, no
 * `process`, no filesystem, no sockets. The only channel in or out is the one
 * function this file installs on `globalThis`.
 *
 * It lives under `src/` rather than in a build directory so that
 * `tsc --noEmit` and eslint already cover it — the sealed runtime is not a
 * place to discover a type error at runtime.
 *
 * ## What it is for
 *
 * **Not verdict integrity, in v1.0.0.** That argument needed the daemon to run
 * as a UID the governed agent could not administer; user scope makes them the
 * same user, so the agent can `ptrace` the daemon, preload into it, or replace
 * the binary. Any sentence here claiming a verdict computed in this file cannot
 * be forged would be false, so there isn't one. `crates/PROTOCOL.md` states the
 * scope; the managed install that would restore the claim is deferred.
 *
 * What the tier buys instead is real and is a different thing: a warm evaluator
 * rather than a fresh interpreter per event, no `.__failproofai_tmp__.mjs`
 * written beside the user's own source on every tool call, a deadline a
 * watchdog actually enforces, and a deny-by-default context that contains a
 * *buggy or over-reaching* policy — protection against mistakes, not against an
 * adversary who is already this user. See
 * [03-daemon-architecture.md](../../desgin-docs/v1.0.0/phase-1-local-enforcement/03-daemon-architecture.md#execution-tiers).
 *
 * ## Why it reuses `evaluateVerdicts` / `encodeResponse` rather than reimplementing
 *
 * `policy-evaluator.ts` encodes roughly a dozen mutually incompatible vendor
 * response contracts, each annotated with the version it was verified against.
 * A "semantically equivalent" reimplementation of that matrix is a silent-allow
 * generator. So the sealed worker runs *the same TypeScript*, bundled — the
 * only difference between the sealed and legacy paths is which process and UID
 * it runs in, and which bindings exist.
 *
 * ## State, and why the soak test matters
 *
 * Every hook today runs in a fresh process, so the `globalThis` policy
 * registry, the memoised policy index, and every hoisted `/g` regex start
 * clean. A resident worker changes all of that at once, and the failure mode is
 * a *wrong verdict*, not a crash. `evaluate()` therefore rebuilds the registry
 * from scratch on every call, and
 * `__tests__/policy-runtime/sealed-soak.test.ts` runs the whole corpus twice
 * through one warm worker and then once in randomised order, asserting
 * identical bytes all three times.
 */
import type { HookEventType, IntegrationType, SessionMetadata } from "../hooks/types";
import type { HooksConfig } from "../hooks/policy-types";
import { clearPolicies } from "../hooks/policy-registry";
import { registerBuiltinPolicies } from "../hooks/builtin-policies";
import {
  evaluateVerdicts,
  encodeResponse,
  type EvaluationResult,
} from "../hooks/policy-evaluator";
import { PAYLOAD_ONLY_POLICIES } from "../hooks/builtin/payload-only";
import { setHostContextFallback } from "../hooks/builtin/host-context";
import { setPolicyWarnSink } from "../hooks/builtin/warn";

/** The names the sealed tier is permitted to run, as a set for O(1) filtering. */
const SEALED_ELIGIBLE = new Set(PAYLOAD_ONLY_POLICIES.map((p) => p.name));

/** Canonical names (`failproofai/<name>`), which is what config carries. */
const SEALED_ELIGIBLE_CANONICAL = new Set(
  PAYLOAD_ONLY_POLICIES.map((p) => `failproofai/${p.name}`),
);

/**
 * The request the daemon hands in. Deliberately a plain JSON shape rather than
 * an imported interface: this crosses a process and a language boundary, and
 * `crates/PROTOCOL.md` is its contract.
 */
export interface SealedRequest {
  eventType: HookEventType;
  payload: Record<string, unknown>;
  session: SessionMetadata & { cli?: IntegrationType };
  /** Enabled policy names and params, from the daemon's active generation. */
  config: HooksConfig;
}

export interface SealedResponse {
  ok: true;
  result: EvaluationResult;
  /** Policies that matched but are not sealed-eligible; the daemon routes these. */
  needsUserContext: string[];
  /** Whether any evaluated policy read a client-asserted host field. */
  readClientAssertedHost: boolean;
}

export interface SealedError {
  ok: false;
  error: string;
  stack?: string;
}

/**
 * Restrict an incoming config to what the sealed tier may actually run.
 *
 * The daemon is supposed to have partitioned this already, but the worker does
 * not take that on trust. A host-access policy reaching the sealed context
 * would not be a security hole — the stubs would throw — but it *would* turn a
 * routing bug into a per-event circuit-breaker trip that is hard to attribute.
 * Filtering here makes the same bug show up as an explicit `needsUserContext`
 * entry the daemon can report.
 */
function partitionEnabled(enabled: readonly string[]): {
  sealed: string[];
  needsUserContext: string[];
} {
  const sealed: string[] = [];
  const needsUserContext: string[] = [];
  for (const name of enabled) {
    if (SEALED_ELIGIBLE.has(name) || SEALED_ELIGIBLE_CANONICAL.has(name)) sealed.push(name);
    else needsUserContext.push(name);
  }
  return { sealed, needsUserContext };
}

/**
 * Evaluate one hook event.
 *
 * Returns a discriminated result rather than throwing, because a throw across
 * the QuickJS boundary loses its message. A `SealedError` is *not* an allow:
 * the daemon treats it as an evaluation failure, counts it toward the
 * artifact's circuit breaker, and falls back per the configured failure mode.
 */
export async function evaluate(request: SealedRequest): Promise<SealedResponse | SealedError> {
  try {
    const { sealed, needsUserContext } = partitionEnabled(request.config.enabledPolicies ?? []);

    // Rebuild from scratch every call. This is what makes a resident worker
    // behave like the fresh process the legacy path gets — see the soak test.
    clearPolicies();
    registerBuiltinPolicies(sealed);

    // Host context comes from the request, never from this process: the worker
    // is resident and answers for sessions it did not start, so any ambient
    // home it could read would be the launching environment's rather than the
    // request's — and it would be that for every session at once. `home` was
    // derived by the daemon from `getpwuid_r(peer_uid)`; a client-asserted one
    // is rejected at the socket.
    // The fallback is inert so a missing value fails closed rather than
    // silently borrowing the worker's environment.
    setHostContextFallback({
      home: () => "",
      projectDir: () => undefined,
    });

    // The sealed context has no filesystem to write a log to. Warnings are
    // diagnostic only and never affect a verdict, so discarding is correct;
    // the daemon captures anything it needs from the structured result.
    setPolicyWarnSink(() => {});

    const verdicts = await evaluateVerdicts(
      request.eventType,
      request.payload,
      request.session,
      request.config,
    );
    const result = encodeResponse(verdicts, request.eventType, request.session);

    return {
      ok: true,
      result,
      needsUserContext,
      // `cwd` and `project_dir` cannot be derived by the daemon and ride as
      // client-asserted, so a decision that read one is `sealed_unattested`
      // rather than `sealed`. Reported honestly rather than claiming an
      // integrity property the input does not support.
      readClientAssertedHost: Boolean(request.session.cwd || request.session.projectDir),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
  }
}

/** The sealed-eligible policy names, so the daemon can build its generation. */
export function sealedPolicyNames(): string[] {
  return [...SEALED_ELIGIBLE];
}

/**
 * Install the QuickJS-facing surface.
 *
 * Strings in, strings out. QuickJS and Rust exchange JSON rather than structured
 * values so there is exactly one serialisation format to reason about, and so
 * the same worker is drivable from a Node harness in tests (which is how the
 * soak and parity suites run it without a Rust build).
 */
declare const globalThis: {
  __fpai_sealed_evaluate?: (requestJson: string) => Promise<string>;
  __fpai_sealed_policies?: () => string;
  __fpai_sealed_version?: string;
} & typeof global;

export function installSealedGlobals(): void {
  globalThis.__fpai_sealed_evaluate = async (requestJson: string): Promise<string> => {
    let request: SealedRequest;
    try {
      request = JSON.parse(requestJson) as SealedRequest;
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: `sealed worker: request is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      } satisfies SealedError);
    }
    return JSON.stringify(await evaluate(request));
  };
  globalThis.__fpai_sealed_policies = () => JSON.stringify(sealedPolicyNames());
  globalThis.__fpai_sealed_version = "1";
}

installSealedGlobals();
