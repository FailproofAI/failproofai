import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

let baseDir: string | null = null;

/**
 * Where this SDK writes its event spool.
 *
 * Resolution order, most explicit first:
 *
 *   1. `setBaseDir()`                 — a caller said so outright
 *   2. `~/.failproofai/custom-agents` — always
 *
 * There is no environment variable that redirects the spool off the umbrella,
 * and that is the point. `FAILPROOFAI_HOME` (honoured by
 * `failproofaiCustomAgentsDir()` below) MOVES the umbrella; it cannot take you
 * outside it, because the `custom-agents` segment is appended unconditionally.
 * Wherever the home is, the spool is inside it.
 *
 * ## Why `$AGENTEYE_HOME` does not resolve here
 *
 * In the Python SDK it used to sit at step 2 and win over the default, which
 * made it possible to aim the SDK at `~/.agenteye` — or anywhere else — from
 * the environment. That is a redirect with no confirmation and no error:
 * batches land in a directory, something may or may not read it, and an unread
 * spool is indistinguishable from an idle one. An operator who exports it for
 * the OTHER component that reads it (the older `agenteye-collector`) moved the
 * SDK's spool as a side effect they never asked for. This SDK never had it.
 *
 * ## Nothing is stranded by this
 *
 * `failproofaid`, the daemon this SDK ships beside, watches BOTH
 * `~/.failproofai/custom-agents/events` AND `~/.agenteye/events`
 * (`crates/fpai-collect/src/config.rs`, `spool_dirs`). Batches sitting under
 * the legacy root still drain.
 *
 * ## The one case that needs a deliberate choice
 *
 * A host running the older `agenteye-collector` and nothing else. That
 * collector never learned the umbrella, so it does not watch where this SDK
 * writes. The supported bridges, in order of preference:
 *
 *   * run `failproofaid` instead — it watches both roots; or
 *   * point the collector AT the SDK with
 *     `AGENTEYE_HOME=~/.failproofai/custom-agents`; or
 *   * `configure({ baseDir: "~/.agenteye" })` in the application, which is
 *     explicit, visible at the call site, and cannot happen by inheriting
 *     somebody else's environment.
 *
 * `test/spool-contract.test.ts` reads the Rust, the TypeScript in `src/hooks/`
 * and the Python resolver and fails if any of them drifts from this.
 */
export function getBaseDir(): string {
  if (baseDir !== null) return baseDir;
  return failproofaiCustomAgentsDir();
}

/**
 * `~/.failproofai/custom-agents`, honouring `$FAILPROOFAI_HOME`.
 *
 * Mirrors `customAgentsDir()` in `src/hooks/fp-home.ts`,
 * `custom_agents_events_dir()` in `crates/fpai-collect/src/config.rs` and
 * `failproofai_custom_agents_dir()` in the Python SDK. All four must agree; a
 * divergence would mean this SDK writes somewhere the daemon never reads, with
 * NO error on either side.
 *
 * Returns a path unconditionally and never checks whether it exists. The caller
 * creates it: `writer`'s file write already does a recursive `mkdir` on the
 * directory it is about to write into. An existence check here is what made an
 * earlier opt-in dead — a spool root that must pre-exist can never be the place
 * a first batch is written.
 */
export function failproofaiCustomAgentsDir(): string {
  const fpHome = process.env.FAILPROOFAI_HOME;
  const base = fpHome ? expandUser(fpHome) : join(homedir(), ".failproofai");
  return join(base, "custom-agents");
}

/**
 * `~/.agenteye` — the root the SDK family wrote to before the default moved.
 *
 * Not part of resolution, and no environment variable can put it back — see
 * `getBaseDir`. Kept as a named constant because the migration notes and the
 * tests still refer to it, and because `failproofaid` goes on watching
 * `~/.agenteye/events`. Spelling it in four places is how the sides drift apart.
 */
export function legacyAgenteyeDir(): string {
  return join(homedir(), ".agenteye");
}

/**
 * Expand a leading `~` against the current user's home.
 *
 * Load-bearing, not a nicety: the migration bridge this module itself
 * prescribes — `configure({ baseDir: "~/.agenteye" })`, listed in `getBaseDir`'s
 * docs and in the README as the explicit, visible-at-the-call-site option — is
 * a RELATIVE path whose first segment is the literal character `~`. Without
 * this, the writer's recursive `mkdir` cheerfully creates a `~` directory under
 * the process's cwd and spools into it: nothing on the machine watches that
 * path, so 100% of the telemetry is lost, which is the precise "an unread spool
 * is indistinguishable from an idle one" failure the prose above is written to
 * prevent.
 */
export function expandUser(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`) || path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function setBaseDir(path: string | null | undefined): void {
  if (path === null || path === undefined) {
    baseDir = null;
    return;
  }
  const expanded = expandUser(path);
  baseDir = isAbsolute(expanded) ? expanded : resolve(expanded);
}
