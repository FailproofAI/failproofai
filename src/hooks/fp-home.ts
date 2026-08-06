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
 * The Rust side mirrors it in `crates/failproofaid/src/paths.rs`. The test that
 * asserts the two agree lives THERE, not here —
 * `paths::tests::every_mirrored_path_agrees_with_fp_home_ts` imports this module
 * in a child process and compares every mirrored path against its own.
 *
 * This line used to cite `__tests__/hooks/fp-home.test.ts`, which contains no
 * reference to `crates/` and never checked anything cross-language. While both
 * files claimed the guard existed, three paths were wrong at once: the daemon's
 * `run/` ignored `FAILPROOFAI_HOME` (so a healthy daemon on a fail-closed
 * machine denied every tool call), its cloud policy directory still said
 * `cloud-managed`, and its credential still said `cloud.json`.
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
export function failproofaiHome(home?: string): string {
  if (home) return resolve(home, ".failproofai");
  return process.env.FAILPROOFAI_HOME || resolve(homedir(), ".failproofai");
}

const at = (...parts: string[]): string => resolve(failproofaiHome(), ...parts);

/**
 * Same, against an explicitly supplied HOME (not the failproofai home).
 *
 * `setup-state` and `onboarding-lock` take a `home` parameter purely so their
 * tests can point at a temp directory, and a helper that silently ignored it
 * would send those tests at the developer's real home — which is precisely the
 * bug this overload exists to make impossible.
 */
const atHome = (home: string | undefined, ...parts: string[]): string =>
  home ? resolve(failproofaiHome(home), ...parts) : at(...parts);

// ── Top level ────────────────────────────────────────────────────────────────

/** Layout / CLI / daemon versions. Also the layout marker. */
export const versionFile = (home?: string) => atHome(home, "VERSION");

/** Non-secret configuration. World-readable by design; never holds a token. */
export const configFile = (home?: string) => atHome(home, "config.toml");

/**
 * Every credential, owner-only.
 *
 * Split from `config.toml` because that file is written with a bare
 * `writeFileSync` and inherits the umask (0664 on a normal machine). A token
 * there would be readable by every local user on the box — which is exactly
 * why `ingest.json` and `cloud.json` were separate files before this.
 */
export const credentialsFile = (home?: string) => atHome(home, "credentials.toml");

// ── Daemon binaries ──────────────────────────────────────────────────────────

export const binDir = (home?: string) => atHome(home, "bin");

/**
 * One file per version, never overwritten in place: an in-place write hits
 * `ETXTBSY` against the running daemon on Linux, and would silently repoint a
 * live service unit at a binary built from different source.
 */
export const daemonBinary = (version: string, home?: string) =>
  resolve(binDir(home), `failproofaid-${version}`);

// ── Policies ─────────────────────────────────────────────────────────────────

export const policiesDir = (home?: string) => atHome(home, "policies");

/** The builtin enable/disable set and per-policy params, GLOBAL scope only. */
export const localPoliciesDir = (home?: string) => atHome(home, "policies", "local-policies");
export const globalPolicyConfigFile = (home?: string) =>
  resolve(localPoliciesDir(home), "policies-config.json");

/** Cloud-managed generations: `active.json` plus content-addressed artifacts. */
export const cloudPoliciesDir = (home?: string) => resolve(policiesDir(home), "cloud-policies");

/** User convention policies (`*.mjs`) that load without any flag. */
export const customPoliciesDir = (home?: string) => resolve(policiesDir(home), "custom-policies");

// ── Collector ────────────────────────────────────────────────────────────────

/** Per-source watermarks. One directory per source — never shared: the cursor
 *  store rewrites its whole map atomically, so two sources sharing a file
 *  clobber each other and the loser re-reads from zero after every restart. */
export const cursorsDir = (source?: string, home?: string) =>
  source ? resolve(atHome(home, "cursors"), source) : atHome(home, "cursors");

/** The SDK spool root. Mirrors `~/.agenteye/`, which stays supported. */
export const customAgentsDir = (home?: string) => atHome(home, "custom-agents");
export const customAgentsEventsDir = (home?: string) => resolve(customAgentsDir(home), "events");
export const customAgentsFailedDir = (home?: string) => resolve(customAgentsDir(home), "failed");

// ── Audit ────────────────────────────────────────────────────────────────────

export const auditDir = (home?: string) => atHome(home, "audit");
export const auditDashboardFile = (home?: string) => resolve(auditDir(home), "dashboard.json");
export const auditCacheDir = (home?: string) => resolve(auditDir(home), "cache");

// ── Hook activity ────────────────────────────────────────────────────────────

/** The decision log: page-sized JSONL the dashboard's activity tab reads. */
export const hookActivityDir = (home?: string) => atHome(home, "hook-activity");

// ── Runtime ──────────────────────────────────────────────────────────────────

/** Sockets and the singleton flock. Shallow on purpose — see the header note. */
export const runDir = (home?: string) => atHome(home, "run");
export const daemonSocket = () =>
  process.env.FAILPROOFAI_DAEMON_SOCKET || resolve(runDir(), "failproofaid.sock");
export const workerSocket = (home?: string) => resolve(runDir(home), "worker.sock");
export const daemonLock = (home?: string) => resolve(runDir(home), "failproofaid.lock");

/**
 * Single-flight lock for the audit.
 *
 * Three separate processes can start one — a scheduled run, `failproofai
 * audit`, and the dashboard's re-run — and all three write the same
 * sha1-keyed cache files, so the lock has to be visible across processes.
 * It sits in `run/` with the other runtime files rather than under `audit/`,
 * which holds results a human might keep and a reset is expected to clear.
 *
 * NOT mirrored in `crates/failproofaid/src/paths.rs` yet: nothing in Rust
 * takes this lock until the daemon grows its audit lane, and a `pub fn` no
 * caller uses is a dead_code failure under `-D warnings`.
 */
export const auditLockFile = (home?: string) => resolve(runDir(home), "audit.lock");

// ── Daemon scratch state ─────────────────────────────────────────────────────

/** Everything the daemon writes that a human would never open by hand. */
export const stateDir = (home?: string) => atHome(home, "state");
export const spoolDir = (home?: string) => resolve(stateDir(home), "spool");
export const failedDir = (home?: string) => resolve(stateDir(home), "failed");
export const collectorHealthFile = (home?: string) => resolve(stateDir(home), "collector-health.json");
/** Per-session enforcement pauses, keyed by a hash of the session id. */
export const sessionPauseDir = () => resolve(stateDir(), "sessions");
/**
 * When the scheduled audit last ran, and when the next one is due.
 *
 * The DAEMON is the sole writer (`crates/failproofaid/src/audit_lane.rs`, which
 * mirrors this path in `paths.rs`) — it owns the schedule, and a second writer
 * racing it could hand a machine two full scans back to back. Everything on this
 * side reads it: the interval itself lives in `config.toml`'s `[audit]` table,
 * which a human edits, while this file is derived state a human never opens,
 * which is why it sits under `state/` rather than beside the audit results.
 */
export const auditScheduleFile = (home?: string) => resolve(stateDir(home), "audit-schedule.json");
/**
 * The anonymous instance id this machine reports telemetry under.
 *
 * The mirror image of `auditScheduleFile()` above: here the CLI is the sole
 * writer (`getInstanceId()` in `lib/telemetry-id.ts`, which persists whatever it
 * resolved) and **failproofaid** only reads, through `telemetry_id_path()` in
 * `crates/failproofaid/src/paths.rs`. The daemon cannot re-derive the value —
 * `getInstanceId`'s middle tier hashes Node-formatted strings (`os.arch()` is
 * `x64` where Rust says `x86_64`), and a near-miss there does not fail, it
 * silently files one machine under two PostHog persons — so this file is how the
 * two agree. Derived state a human never opens, hence `state/` rather than
 * beside `config.toml`.
 */
export const telemetryIdFile = (home?: string) => resolve(stateDir(home), "telemetry-id");
export const launcherMarker = (home?: string) => resolve(stateDir(home), "launcher-configured");
/**
 * The version that last reported an install, so an upgrade is reported once.
 *
 * Under `state/` in layout 2 like every other piece of derived state, and that
 * placement fixes a real bug rather than being tidiness: at the root it was
 * `~/.failproofai/last-version`, which `detectLayout()` lists as a LAYOUT-1
 * MARKER — while the code that writes it still runs under layout 2, and runs
 * BEFORE the layout check. So on a genuinely fresh machine the CLI created the
 * file, then immediately read it back as evidence of an old layout, classified
 * a brand-new home as stale, and opened every new user's first command with
 * "failproofai reorganised … Removed 1 item(s) from the old layout."
 */
export const lastVersionFile = (home?: string) => resolve(stateDir(home), "last-version");
export const onboardingLockFile = (home?: string) => resolve(stateDir(home), "onboarding.lock");
export const codexSessionPathsFile = (home?: string) => resolve(stateDir(home), "codex-session-paths.json");

export const logsDir = (home?: string) => atHome(home, "logs");

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
    legacy.cloudManagedPolicies(),
    // The MACHINE-OWNED children of `policies/`, never the parent.
    //
    // `at("policies")` stood here, and on layout 1 that directory IS the
    // documented home for hand-written personal policies — `docs/
    // configuration.mdx` names `~/.failproofai/policies/` as the user scope,
    // and `manager.ts` read it. Those are source files a person wrote; nothing
    // regenerates them, nothing backed them up, and the reset message named
    // only "policy config, activity history and audit cache". Worse, the
    // machine then reported itself configured — `isConfigured()` is a union
    // that still sees the agent CLIs' untouched settings files — so the wizard
    // was skipped and hooks kept firing against an empty policy set.
    //
    // `custom-policies/` is deliberately absent from this list for the same
    // reason. Both directories below are re-derived: `local-policies/` by
    // setup, `cloud-policies/` by the next daemon poll.
    localPoliciesDir(),
    cloudPoliciesDir(),
    at("cursors"),
    at("state"),
    // Layout 2.
    // NOT versionFile() — it is the layout marker, not user data, and the
    // reset rewrites it immediately afterwards. Listing it made a no-op reset
    // report "removed 1 item" for a file it had just recreated.
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
