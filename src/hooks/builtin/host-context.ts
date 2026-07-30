/**
 * Host context for sealed-tier policies — Stage 0 / P2.
 *
 * Three sealed-eligible policies need to know where the user's home directory
 * and project root are: `block-read-outside-cwd` (whitelists `~/.claude/` and
 * friends, and prefers `$CLAUDE_PROJECT_DIR` over the drifting shell cwd),
 * `block-rm-rf` (expands `~` / `$HOME` before deciding whether a delete target
 * is catastrophic), and `block-secrets-write` indirectly through the same path
 * helpers.
 *
 * Reading them from `os.homedir()` and `process.env` inside the policy has two
 * problems. The obvious one is the import graph: `node:os` disqualifies the
 * whole module from the sealed tier. The load-bearing one is that the daemon is
 * resident and answers for sessions it did not start, so its own ambient
 * `homedir()` and `$CLAUDE_PROJECT_DIR` belong to whatever environment it was
 * launched from — a sealed policy reading them would whitelist the wrong tree,
 * and would do it for every session on the machine at once.
 *
 * So both values arrive as request data on `SessionMetadata`, and this module
 * resolves them with an injectable fallback for the legacy in-process path.
 *
 * **Direction of trust matters here.** `isAgentInternalPath` and
 * `block-read-outside-cwd` both *widen* the allow set, so a caller that could
 * assert `home: "/"` would make every path "agent internal" and relax a sealed
 * verdict. That is why, in the daemon, `home` is derived from
 * `getpwuid_r(peer_uid)` and a client-supplied `home` is a protocol error —
 * see 03-risks-and-amendments.md amendment #3. This module is only the reader;
 * it does not and cannot enforce that, which is exactly why the enforcement
 * lives at the socket boundary instead.
 */
import type { PolicyContext } from "../policy-types";

export interface HostContextFallback {
  /** The invoking user's home directory, or `""` when unknown. */
  home(): string;
  /** The stable project root (`$CLAUDE_PROJECT_DIR`), or `undefined`. */
  projectDir(): string | undefined;
}

/**
 * Deny-by-default: with no fallback installed, `home` resolves to `""`, which
 * makes `isAgentInternalPath` match nothing and `expandHomePrefix` a no-op.
 * Both directions fail *closed* (nothing extra is whitelisted), which is the
 * right posture for a context that could not be established.
 */
const inertFallback: HostContextFallback = {
  home: () => "",
  projectDir: () => undefined,
};

let fallback: HostContextFallback = inertFallback;

/** Install the host-side fallback. Called by `builtin-policies.ts` at load. */
export function setHostContextFallback(next: HostContextFallback): void {
  fallback = next;
}

/** Restore the inert default. Exposed for test isolation. */
export function resetHostContextFallback(): void {
  fallback = inertFallback;
}

/**
 * The requesting user's home directory.
 *
 * Request data wins; the fallback answers only when the envelope did not carry
 * one, which is the legacy in-process path.
 */
export function resolveHome(ctx: PolicyContext): string {
  const fromRequest = ctx.session?.home;
  if (typeof fromRequest === "string" && fromRequest !== "") return fromRequest;
  return fallback.home();
}

/**
 * The stable project root, or `undefined`.
 *
 * Note the falsy — not nullish — check. The legacy behaviour this preserves is
 * `process.env.CLAUDE_PROJECT_DIR || ctx.session?.cwd`, where an env var set to
 * the empty string falls through to cwd. Using `??` here would change that.
 */
export function resolveProjectDir(ctx: PolicyContext): string | undefined {
  const fromRequest = ctx.session?.projectDir;
  if (fromRequest) return fromRequest;
  return fallback.projectDir() || undefined;
}
