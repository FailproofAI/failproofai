/**
 * Deny-by-default stubs for the host modules, substituted into the sealed
 * bundle at build time.
 *
 * The sealed tier's guarantee is stated in
 * [03-daemon-architecture.md](../../desgin-docs/v1.0.0/phase-1-local-enforcement/03-daemon-architecture.md#execution-tiers):
 *
 * > The `sealed` context is deny-by-default: it exposes no filesystem, process,
 * > or network bindings, so a policy that under-declares does not escape into a
 * > privileged tier, it fails inside the tier it was routed to.
 *
 * These stubs are the second, independent mechanism behind that sentence. The
 * first is import-graph tier derivation, which routes a policy touching the host
 * to `user-context` before it ever reaches the sealed worker. Derivation is
 * static, so it can be wrong — a dynamic `import()`, a specifier it failed to
 * resolve, a bundler edge case. Runtime enforcement does not depend on
 * derivation having been right.
 *
 * Note what is *not* here: the enforcement is not primarily these throws. The
 * QuickJS context registers no bindings at all, so there is no `require`, no
 * module resolution, no `process`, and no way to reach a real `fs` even if a
 * policy asked for one. These stubs exist because the sealed bundle also
 * contains failproofai's own evaluator scaffolding — the policy registry, the
 * params map, the response encoder — which is reached through modules that
 * statically import `node:os` and `node:fs` for the *legacy* path. Replacing
 * those imports with throwing stubs keeps the bundle buildable while making any
 * accidental call a loud, attributable failure instead of a silent one.
 *
 * A throw from here is not an allow. It propagates as a policy evaluation
 * error, which the daemon counts toward that artifact's circuit breaker and
 * surfaces in health — it never degrades to a permissive verdict.
 */

/** Thrown when sealed code reaches for a capability the tier does not have. */
export class SealedCapabilityError extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(
      `failproofai sealed tier: '${capability}' is not available. ` +
        `The sealed execution tier has no filesystem, subprocess, or network access. ` +
        `A policy needing one of those is routed to the user-context tier at admission; ` +
        `reaching this error means something bypassed that routing.`,
    );
    this.name = "SealedCapabilityError";
    this.capability = capability;
  }
}

function forbid(capability: string): (...args: unknown[]) => never {
  return () => {
    throw new SealedCapabilityError(capability);
  };
}

// -- node:os --
export const homedir = forbid("os.homedir");
export const tmpdir = forbid("os.tmpdir");
export const userInfo = forbid("os.userInfo");
export const hostname = forbid("os.hostname");
export const platform = forbid("os.platform");

// -- node:child_process --
export const execSync = forbid("child_process.execSync");
export const execFileSync = forbid("child_process.execFileSync");
export const exec = forbid("child_process.exec");
export const execFile = forbid("child_process.execFile");
export const spawn = forbid("child_process.spawn");
export const spawnSync = forbid("child_process.spawnSync");

// -- node:fs / node:fs/promises --
export const readFile = forbid("fs.readFile");
export const writeFile = forbid("fs.writeFile");
export const readFileSync = forbid("fs.readFileSync");
export const writeFileSync = forbid("fs.writeFileSync");
export const appendFileSync = forbid("fs.appendFileSync");
export const renameSync = forbid("fs.renameSync");
export const mkdirSync = forbid("fs.mkdirSync");
export const existsSync = forbid("fs.existsSync");
export const statSync = forbid("fs.statSync");
export const stat = forbid("fs.stat");
export const open = forbid("fs.open");
export const openSync = forbid("fs.openSync");
export const readSync = forbid("fs.readSync");
export const closeSync = forbid("fs.closeSync");
export const readdirSync = forbid("fs.readdirSync");
export const unlinkSync = forbid("fs.unlinkSync");
export const rmSync = forbid("fs.rmSync");

// Some call sites do `import * as fs from "node:fs"` — give them an object
// whose every property throws on call rather than being undefined, so the
// failure names the capability instead of surfacing as "not a function".
const namespace = {
  homedir, tmpdir, userInfo, hostname, platform,
  execSync, execFileSync, exec, execFile, spawn, spawnSync,
  readFile, writeFile, readFileSync, writeFileSync, appendFileSync,
  renameSync, mkdirSync, existsSync, statSync, stat, open, openSync,
  readSync, closeSync, readdirSync, unlinkSync, rmSync,
};

export default namespace;
