/**
 * The single place the in-process legacy path reads ambient host state.
 *
 * Split out of `request-envelope.ts` deliberately (Phase 1 / Stage 0, P4):
 * the envelope module must stay free of runtime imports because a later stage
 * derives a policy's sealed / `user-context` execution tier from the *resolved*
 * import graph. `node:os` lives here instead, and this module is the only edge
 * into it.
 *
 * There is no daemon equivalent of this file. Under `failproofaid` the same
 * facts arrive as `daemon-derived` — `home` from `getpwuid_r(peer_uid)`, never
 * from the request (see `request-envelope.ts` for why a client-asserted home
 * would relax a sealed verdict).
 */
import { homedir } from "node:os";
import { selectEnvFacts, type LocalHostFacts } from "./request-envelope";

/**
 * Read the host facts the envelope needs from the current process.
 *
 * `homedir()` is read per call rather than memoized at module scope so tests
 * (and anything that rewrites `$HOME`) observe the current value, matching how
 * `builtin-policies.ts` and `hooks-config.ts` call it today.
 */
export function readLocalHostFacts(): LocalHostFacts {
  return {
    home: homedir(),
    envFacts: selectEnvFacts(process.env),
  };
}
