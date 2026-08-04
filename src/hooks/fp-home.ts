/**
 * Every path inside `~/.failproofai`, in one place.
 *
 * Before this module the layout was ~40 hardcoded `resolve(homedir(),
 * ".failproofai", …)` calls in TypeScript and ~10 more in Rust, and the two
 * sides had drifted into three different ideas of where things lived
 * (`cache/hook-activity` vs `hook-activity`, `spool` at the root vs under
 * state). Moving anything meant finding every one of them, and missing one
 * meant the daemon wrote where the dashboard did not read — silently, because
 * an absent directory is indistinguishable from an idle one.
 *
 * So: nothing outside this file may join a path onto the failproofai home.
 * The Rust side mirrors it in `crates/failproofaid/src/paths.rs`, and
 * `__tests__/hooks/fp-home.test.ts` asserts the two agree.
 *
 * ## Layout 2
 *
 * ```
 * ~/.failproofai/
 *   VERSION                  layout / cli / daemon versions
 *   config.toml       0644   non-secret: mode, daemon, collector prefs
 *   credentials.toml  0600   every token
 *   bin/                     downloaded daemon binaries, one per version
 *   policies/
 *     local-policies/        the builtin enable/disable set
 *     cloud-policies/        content-addressed artifacts + active generation
 *     custom-policies/       user convention policies (*.mjs)
 *   cursors/<source>/        per-source collector watermarks
 *   audit/                   audit report + per-session cache
 *   hook-activity/           decision log the dashboard reads
 *   custom-agents/           SDK spool (events/ + failed/)
 *   run/                     sockets + flock  — MUST stay shallow, see below
 *   state/                   daemon scratch: spool, failed, health, pauses
 * ```
 *
 * **`run/` is deliberately NOT under `state/`.** A Unix socket path must fit
 * in `sockaddr_un.sun_path` (~108 bytes) and we have hit that ceiling twice
 * already during development. Every directory level spends part of a budget
 * that a long `$HOME` has already eaten into, so the socket stays as close to
 * the root as it can.
 *
 * ## Project scope is NOT here
 *
 * `<project>/.failproofai/` keeps its old shape — `policies-config.json` and
 * `policies/*.mjs` at the top. Those files are committed to users' git repos,
 * so reorganising them would rewrite history in every repo that adopted
 * failproofai. `hooks-config.ts` still owns those paths.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * The on-disk layout this build speaks.
 *
 * Bumped whenever a path in this file moves. Recorded in `VERSION`, and what
 * `detectLayout()` compares against — a home written by a different layout is
 * refused rather than half-read, because reading a moved directory silently
 * yields "no data" instead of an error.
 *
 * 1 — the original flat/`cache`-based layout, through 1.0.0-beta.5.
 * 2 — this file.
 */
export const LAYOUT_VERSION = 2;

/**
 * `~/.failproofai`, or `FAILPROOFAI_HOME`.
 *
 * The override is load-bearing for tests and containers: everything below is
 * derived from it, so pointing it elsewhere relocates the entire layout
 * atomically rather than per-path.
 */
export function failproofaiHome(): string {
  return process.env.FAILPROOFAI_HOME || resolve(homedir(), ".failproofai");
}

const at = (...parts: string[]): string => resolve(failproofaiHome(), ...parts);

// ── Top level ────────────────────────────────────────────────────────────────

/** Layout / CLI / daemon versions. Also the layout marker. */
export const versionFile = () => at("VERSION");

/** Non-secret configuration. World-readable by design; never holds a token. */
export const configFile = () => at("config.toml");

/**
 * Every credential, owner-only.
 *
 * Split from `config.toml` because that file is written with a bare
 * `writeFileSync` and inherits the umask (0664 on a normal machine). A token
 * there would be readable by every local user on the box — which is exactly
 * why `ingest.json` and `cloud.json` were separate files before this.
 */
export const credentialsFile = () => at("credentials.toml");

// ── Daemon binaries ──────────────────────────────────────────────────────────

export const binDir = () => at("bin");

/**
 * One file per version, never overwritten in place: an in-place write hits
 * `ETXTBSY` against the running daemon on Linux, and would silently repoint a
 * live service unit at a binary built from different source.
 */
export const daemonBinary = (version: string) => resolve(binDir(), `failproofaid-${version}`);

// ── Policies ─────────────────────────────────────────────────────────────────

export const policiesDir = () => at("policies");

/** The builtin enable/disable set and per-policy params, GLOBAL scope only. */
export const localPoliciesDir = () => resolve(policiesDir(), "local-policies");
export const globalPolicyConfigFile = () => resolve(localPoliciesDir(), "policies-config.json");

/** Cloud-managed generations: `active.json` plus content-addressed artifacts. */
export const cloudPoliciesDir = () => resolve(policiesDir(), "cloud-policies");

/** User convention policies (`*.mjs`) that load without any flag. */
export const customPoliciesDir = () => resolve(policiesDir(), "custom-policies");

// ── Collector ────────────────────────────────────────────────────────────────

/** Per-source watermarks. One directory per source — never shared: the cursor
 *  store rewrites its whole map atomically, so two sources sharing a file
 *  clobber each other and the loser re-reads from zero after every restart. */
export const cursorsDir = (source?: string) =>
  source ? resolve(at("cursors"), source) : at("cursors");

/** The SDK spool root. Mirrors `~/.agenteye/`, which stays supported. */
export const customAgentsDir = () => at("custom-agents");
export const customAgentsEventsDir = () => resolve(customAgentsDir(), "events");
export const customAgentsFailedDir = () => resolve(customAgentsDir(), "failed");

// ── Audit ────────────────────────────────────────────────────────────────────

export const auditDir = () => at("audit");
export const auditDashboardFile = () => resolve(auditDir(), "dashboard.json");
export const auditCacheDir = () => resolve(auditDir(), "cache");

// ── Hook activity ────────────────────────────────────────────────────────────

/** The decision log: page-sized JSONL the dashboard's activity tab reads. */
export const hookActivityDir = () => at("hook-activity");

// ── Runtime ──────────────────────────────────────────────────────────────────

/** Sockets and the singleton flock. Shallow on purpose — see the header note. */
export const runDir = () => at("run");
export const daemonSocket = () =>
  process.env.FAILPROOFAI_DAEMON_SOCKET || resolve(runDir(), "failproofaid.sock");
export const workerSocket = () => resolve(runDir(), "worker.sock");
export const daemonLock = () => resolve(runDir(), "failproofaid.lock");

// ── Daemon scratch state ─────────────────────────────────────────────────────

/** Everything the daemon writes that a human would never open by hand. */
export const stateDir = () => at("state");
export const spoolDir = () => resolve(stateDir(), "spool");
export const failedDir = () => resolve(stateDir(), "failed");
export const collectorHealthFile = () => resolve(stateDir(), "collector-health.json");
/** Per-session enforcement pauses, keyed by a hash of the session id. */
export const sessionPauseDir = () => resolve(stateDir(), "sessions");
export const launcherMarker = () => resolve(stateDir(), "launcher-configured");
export const onboardingLockFile = () => resolve(stateDir(), "onboarding.lock");
export const codexSessionPathsFile = () => resolve(stateDir(), "codex-session-paths.json");

export const logsDir = () => at("logs");

// ── Layout 1 (legacy) ────────────────────────────────────────────────────────

/**
 * Where layout 1 kept things.
 *
 * Retained ONLY so `detectLayout()` can recognise an old home and so the reset
 * can delete it. Nothing reads data from these paths: the decision was
 * wipe-and-re-setup rather than migrate, because a half-migrated home that
 * silently reads "no data" is worse than one that says so.
 */
export const legacy = {
  policyConfig: () => at("policies-config.json"),
  policyConfigLocal: () => at("policies-config.local.json"),
  cloudCredentials: () => at("cloud.json"),
  ingestCredentials: () => at("ingest.json"),
  launcherMarker: () => at(".launcher-configured"),
  lastVersion: () => at("last-version"),
  auditDashboard: () => at("audit-dashboard.json"),
  cacheDir: () => at("cache"),
  hookActivityDir: () => at("cache", "hook-activity"),
  auditCacheDir: () => at("cache", "audit"),
  codexSessionPaths: () => at("cache", "codex-session-paths.json"),
  spoolDir: () => at("spool"),
  failedDir: () => at("failed"),
  collectorHealth: () => at("collector-health.json"),
  sessionPauseDir: () => at("state", "sessions"),
  cloudManagedPolicies: () => at("policies", "cloud-managed"),
  onboardingLock: () => at(".onboarding.lock"),
} as const;

/**
 * Every path a reset must remove, in the order it should remove them.
 *
 * Enumerated rather than "delete the home directory" so a reset never takes
 * out something a future layout adds and this list has not been taught about
 * — and so the function is auditable at a glance, which matters for anything
 * that deletes user data.
 */
export function resettablePaths(): string[] {
  return [
    // Layout 1
    legacy.policyConfig(),
    legacy.policyConfigLocal(),
    legacy.cloudCredentials(),
    legacy.ingestCredentials(),
    legacy.launcherMarker(),
    legacy.lastVersion(),
    legacy.auditDashboard(),
    legacy.cacheDir(),
    legacy.spoolDir(),
    legacy.failedDir(),
    legacy.collectorHealth(),
    legacy.onboardingLock(),
    at("policies"),
    at("cursors"),
    at("state"),
    // Layout 2
    versionFile(),
    configFile(),
    credentialsFile(),
    auditDir(),
    hookActivityDir(),
    customAgentsDir(),
    logsDir(),
    // NOT bin/ — a downloaded daemon binary is large, version-pinned and
    // re-verified on use, so deleting it only forces a needless re-download.
    // NOT run/ — sockets belong to a running daemon; removing them out from
    // under it breaks a live process rather than resetting configuration.
  ];
}
