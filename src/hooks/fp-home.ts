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
 * ## Layout 3
 *
 * Three things changed from layout 2, all of them about a directory saying what
 * it holds:
 *
 * - **Everything is JSON.** `config.toml` and `credentials.toml` are now
 *   `.json`. Two serialisation formats in one home meant two parsers, two
 *   escaping rules, and a `toml` dependency in both the CLI and the daemon to
 *   read files that were only ever flat key/value.
 * - **`policies/` holds policies, and only policies.** It also held
 *   `local-policies/` — our config, not a policy at all, and the one file a
 *   user must not hand-edit sitting among the ones they should. That moved to
 *   the root. What stays is every policy on the machine: the user's own `*.mjs`
 *   directly in it, the fleet's under `cloud-policies/`. Nesting them is safe
 *   because the convention loader does not recurse (see `cloudPoliciesDir`),
 *   and it means one directory answers "what governs this machine".
 * - **No per-deployment directories.** `cloud-policies/generations/<n>/` held a
 *   full copy of every artifact per deployment — a tree to create, prune and
 *   keep consistent with the manifest, on top of the `artifacts/` copy. They
 *   are content-addressed and therefore immutable, so the copies bought nothing
 *   the digests did not already give. `cloud-policies/` is flat now: one
 *   `artifacts/` directory, and `active.json` naming what is live — see
 *   `cloud_policies.rs` for why activation is still atomic without them.
 *
 * ```
 * ~/.failproofai/
 *   VERSION                  layout / cli / daemon versions
 *   config.json       0644   non-secret: mode, daemon, collector prefs
 *   credentials.json  0600   every token
 *   policies-config.json     the builtin enable/disable set + params
 *   bin/                     downloaded daemon binaries, one per version
 *   policies/                every policy: the user's *.mjs sit directly here
 *     cloud-policies/        the fleet's — flat: active.json, desired-state.json, artifacts/
 *   cursors/<source>/        per-source collector watermarks
 *   audit/                   MIXED — see the classification note below
 *     dashboard.json         last result          (derived)
 *     cache/                 per-transcript cache (derived)
 *     schedule.json          daemon's scan timer  (derived)
 *     session.json    0600   the signed-in user   (user-typed)
 *     machine.json           this machine's report identity (identity)
 *   hook-activity/           decision log the dashboard reads
 *   custom-agents/           SDK spool (events/ + failed/)
 *   run/                     sockets + flock  — MUST stay shallow, see below
 *   state/                   daemon scratch: spool, failed, health, pauses, shims
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
 * 2 — `config.toml` / `credentials.toml`, policies nested two levels down.
 * 3 — JSON config + credentials, policies flattened back up.
 * 4 — everything the audit owns moved under `audit/`: the signed-in session
 *     (from `auth.json`), the daemon's scan timer (from
 *     `state/audit-schedule.json`), and the re-audit reminder (from
 *     `next-audit.json`, parked at `audit/reminder.json` and retired in the
 *     same release — see `legacy.auditReminder`). The point is that one
 *     directory now answers "what does the audit know about this machine", the
 *     way `policies/` answers it for enforcement.
 */
export const LAYOUT_VERSION = 4;

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
export const configFile = (home?: string) => atHome(home, "config.json");

/**
 * Every credential, owner-only.
 *
 * Split from `config.toml` because that file is written with a bare
 * `writeFileSync` and inherits the umask (0664 on a normal machine). A token
 * there would be readable by every local user on the box — which is exactly
 * why `ingest.json` and `cloud.json` were separate files before this.
 */
export const credentialsFile = (home?: string) => atHome(home, "credentials.json");

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

/**
 * Where the user drops convention policies (`*.mjs`), loaded with no flag.
 *
 * Layout 3 made this the WHOLE meaning of the directory. It used to hold two
 * subdirectories the user did not put there — `local-policies/` (our config)
 * and `cloud-policies/` (the fleet's) — so "mine" and "not mine" shared a
 * folder and nothing said which was which.
 */
export const policiesDir = (home?: string) => atHome(home, "policies");

/** Convention policies ARE the policies directory now; kept as an alias. */
export const customPoliciesDir = policiesDir;

/**
 * The builtin enable/disable set and per-policy params, GLOBAL scope only.
 *
 * At the root in layout 3. It is configuration, not a policy, and burying it
 * two levels inside a directory users are told to drop files into put the one
 * file they must not hand-edit among the ones they should.
 */
export const globalPolicyConfigFile = (home?: string) =>
  atHome(home, "policies-config.json");

/**
 * Cloud-managed deployments: `active.json`, `desired-state.json`, and
 * content-addressed `artifacts/`.
 *
 * A CHILD of `policies/`, so everything that is a policy lives under one
 * directory and the home root stays readable — every policy on the machine is
 * under `policies/`, whoever put it there.
 *
 * Safe to nest because the convention loader does not recurse:
 * `discoverPolicyFiles()` and `findSkippedPolicyFiles()` both filter
 * `isFile()`, so this directory is invisible to it. That is the property that
 * makes the nesting safe rather than a coincidence — if either ever walks
 * subdirectories, every cloud artifact becomes a convention policy loaded
 * WITHOUT its digest being checked, which is the one path this whole module
 * exists to prevent. `fp-home.test.ts` pins it.
 *
 * What is flat is the INSIDE of this directory: `artifacts/` holds every
 * content-addressed policy for every deployment, and `active.json` names which
 * of them is live. There is no `deployments/<n>/` tree — a per-deployment
 * directory is one more moving part that has to be created, pruned and kept
 * consistent with the manifest, and it bought nothing the digests did not
 * already give.
 */
export const cloudPoliciesDir = (home?: string) => resolve(policiesDir(home), "cloud-policies");

/**
 * Installed policy packs — a sibling of `cloudPoliciesDir` and flat for the same
 * reason: `artifacts/<sha256>.mjs` is content-addressed, so an install can only
 * ever write a file that does not exist yet and is structurally incapable of
 * disturbing what is currently live. `installed.json` names which artifacts are
 * active and is written last, so activation is one atomic flip.
 *
 * Living under `policies/` is safe ONLY because the convention loader does not
 * recurse — `discoverPolicyFiles` and `findSkippedPolicyFiles` both filter on
 * `isFile()`, so nothing under `packs/` can be picked up as an unverified
 * convention policy. `fp-home.test.ts` pins that non-recursion.
 */
export const packsDir = (home?: string) => resolve(policiesDir(home), "packs");

/** The activation pointer. Written last and atomically. */
export const packsInstalledFile = (home?: string) => resolve(packsDir(home), "installed.json");

/** Content-addressed pack artifacts, shared across packs and versions. */
export const packArtifactsDir = (home?: string) => resolve(packsDir(home), "artifacts");

// ── Collector ────────────────────────────────────────────────────────────────

/** Per-source watermarks. One directory per source — never shared: the cursor
 *  store rewrites its whole map atomically, so two sources sharing a file
 *  clobber each other and the loser re-reads from zero after every restart. */
export const cursorsDir = (source?: string, home?: string) =>
  source ? resolve(atHome(home, "cursors"), source) : atHome(home, "cursors");

/** The SDK spool root, and the ONLY root `failproofai-sdk` writes to.
 *
 *  The daemon additionally watches `~/.agenteye/events` (see `spool_dirs` in
 *  `crates/fpai-collect/src/config.rs`) so that SDKs old enough to write there,
 *  and batches already sitting there, keep being collected. But no current SDK
 *  puts anything in it: `$AGENTEYE_HOME` used to redirect the spool and no
 *  longer does, precisely so that exporting it for the older
 *  `agenteye-collector` cannot relocate the SDK as a side effect. */
export const customAgentsDir = (home?: string) => atHome(home, "custom-agents");
export const customAgentsEventsDir = (home?: string) => resolve(customAgentsDir(home), "events");
export const customAgentsFailedDir = (home?: string) => resolve(customAgentsDir(home), "failed");

// ── Audit ────────────────────────────────────────────────────────────────────

/**
 * Everything the audit owns, and a MIXED directory as of layout 4.
 *
 * `auditDir` is deliberately NOT classified in `HOME_CLASSES`, for exactly the
 * reason `stateDir` is not: it now holds a credential and a machine identity
 * alongside two caches, so one class cannot be right for all of it. Before
 * layout 4 the whole directory was `derived` — correct then, and the trap the
 * moment `session.json` moved in, because `resettablePaths()` is a filter over
 * that table and would have deleted the user's tokens on every reset and every
 * future migration. Classify the CHILDREN; never the parent.
 */
export const auditDir = (home?: string) => atHome(home, "audit");
export const auditDashboardFile = (home?: string) => resolve(auditDir(home), "dashboard.json");
export const auditCacheDir = (home?: string) => resolve(auditDir(home), "cache");

/**
 * The signed-in user's tokens. `0600`, written only by the dashboard's auth
 * routes and the audit child (`lib/auth/auth-store.ts`).
 *
 * Layout 3 kept this at the home root as `auth.json`, where it was invisible to
 * `HOME_CLASSES` altogether — neither classified nor deleted, safe by accident
 * rather than by decision. It is `user-typed`: nothing regenerates a session,
 * and dropping it silently signs the machine out.
 *
 * TS-only, so it is absent from `paths.rs` by design: the daemon never opens
 * it. The audit child does the reporting precisely so the daemon holds no human
 * credential — see `audit_lane.rs`.
 */
export const auditSessionFile = (home?: string) => resolve(auditDir(home), "session.json");

/**
 * This machine's report identity: the id the api-server keys reports on, and
 * the watermark saying how far the last digest reached.
 *
 * SEPARATE from `auditSessionFile` on purpose, and the separation is the whole
 * design. Both fields have to outlive a sign-out: regenerate the id and the
 * server sees a brand-new machine and burns a slot off the account's cap on
 * every logout; reset the watermark and the next digest re-reports months of
 * history as though it just happened. So this is `identity` — never deleted,
 * like `cursors/` and `telemetryIdFile` — while the tokens beside it come and
 * go with the session.
 *
 * Minted fresh rather than reusing `telemetryIdFile`, so opting into emailed
 * reports never links the anonymous telemetry person to a verified address.
 */
export const auditMachineFile = (home?: string) => resolve(auditDir(home), "machine.json");


// ── fp-cloud-cli ───────────────────────────────────────────────────────────────────

/**
 * The Cloud CLI's own directory (`fp-cloud-cli` on PyPI, command `fp`).
 *
 * Written by PYTHON, not by anything in this repo's TypeScript or Rust — the
 * CLI resolves it independently in `fp-cloud-cli/fp_cli/config.py`. It is declared
 * here anyway because this file is the register of what may exist in the home,
 * and a path absent from it is only safe by accident: `resettablePaths()` is a
 * filter over `HOME_CLASSES`, so an unregistered directory survives today and
 * survives the next migration only until someone lists its parent.
 *
 * Not classified itself — `auditDir`'s rule applies, classify the children. The
 * directory may grow a cache later; the credential in it must never be dropped.
 */
export const fpcliDir = (home?: string) => atHome(home, "fpcli");

/**
 * The CLI's signed-in session. `0600`, written only by `fp login` / `fp logout`.
 *
 * Was `~/.fp/cli.json` — a third top-level dotfile for one product. The old
 * file is deliberately left where it is: `load_config` in
 * `fp-cloud-cli/fp_cli/config.py` reads it when nothing is here yet, writes the
 * session to this path, and does NOT delete the original, so downgrading to a
 * previous `fp` finds its session intact. Adoption is best-effort — an
 * unwritable home hands back the session it found rather than logging the
 * machine out — and it costs the user no login.
 *
 * This paragraph said the opposite until it was checked against the code: that
 * there was no migration and the upgrade cost a login. There is one, it is
 * covered by `fp-cloud-cli/tests/test_failproofai_home.py`, and the only true half
 * was that the old file survives.
 *
 * `user-typed` for the same reason as `auditSessionFile` beside it: nothing
 * regenerates a session, and dropping it silently signs the machine out.
 *
 * TS-side only, like `auditSessionFile`, and absent from `paths.rs` by design —
 * the daemon has no reason to open a human credential, and mirroring a path
 * only Python writes would give `paths.rs` an entry nothing there reads.
 */
export const fpcliAuthFile = (home?: string) => resolve(fpcliDir(home), "cli-auth.json");

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
/**
 * Where the policy loader writes its ESM shim.
 *
 * Under the user's own home rather than beside the installed package: that
 * directory belongs to whoever installed failproofai, and on a system-wide
 * install it is root-owned, which made every non-root hook fail to load
 * cloud-managed and custom policies — silently, and open.
 */
export const shimsDir = (home?: string) => resolve(stateDir(home), "shims");
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
 * side reads it: the interval itself lives in `config.json`'s `audit` object,
 * which a human edits, while this file is derived state a human never opens.
 *
 * Layout 4 moved it out of `state/` and in beside the audit results. It stays
 * `derived` — losing it costs one rescheduled scan, nothing more — but it now
 * sits with the rest of what the audit owns rather than in the daemon's scratch
 * drawer, which is what makes `audit/` answerable as one directory.
 *
 * Declared here, below `stateDir`, only because the section order of this file
 * is historical; the path itself is under `auditDir`.
 */
export const auditScheduleFile = (home?: string) => resolve(auditDir(home), "schedule.json");
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
 * beside `config.json`.
 */
export const telemetryIdFile = (home?: string) => resolve(stateDir(home), "telemetry-id");
export const launcherMarker = (home?: string) => resolve(stateDir(home), "launcher-configured");
/**
 * The last first-run setup attempt that ABORTED, and why.
 *
 * Deliberately NOT one of `isConfigured()`'s signals: a failed attempt must
 * never make a machine read as set up. It exists only so the next command can
 * tell "never tried" from "tried and could not finish" — the wizard writes
 * nothing on an abort, so without this the two are identical and setup
 * relaunches on every single command forever.
 *
 * Under `state/` with the other derived markers a human never opens.
 */
export const onboardingAttemptFile = (home?: string) =>
  resolve(stateDir(home), "onboarding-attempt.json");
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

// ── Migration state ──────────────────────────────────────────────────────────

/**
 * Where a migration records what it did, and what it saved first.
 *
 * The migration CODE ships in the npm package, never here. A home written by
 * 1.0.0 contains only 1.0.0's migrations, and the steps that get that machine
 * forward are precisely the ones its old install never had — so the installed
 * CLI, always the newest thing on the machine, is the only correct source. What
 * belongs in the home is the STATE: which steps have run, and the files they
 * saved before running. Exactly the split a database makes, where migrations are
 * code in the repo and the applied set is a table.
 */
export const migrationsDir = (home?: string) => atHome(home, "migrations");

/** One line per step that has run: `{from, to, cli, at, durationMs, ok}`. */
export const migrationLedgerFile = (home?: string) =>
  resolve(migrationsDir(home), "applied.json");

/**
 * Copies of the irreplaceable files, taken before the layout-`n` migration ran.
 *
 * NOT a copy of the whole home, and the reason is that `HOME_CLASSES` already
 * made one unnecessary: a migration deletes only `derived` and `refetchable`
 * paths, so there is no longer anything irreplaceable for it to lose by design.
 * What remains worth insuring against is a BUG in a step — and for that, the few
 * kilobytes of `config.json`, `credentials.json`, `policies-config.json`, the
 * marker, and the retired layout's own config are a real undo, where a full-home
 * copy would cost a duplicate of `bin/` and `hook-activity/` and need a
 * two-rename window that also has to dodge a live daemon holding `run/`.
 */
export const migrationBackupDir = (layout: number, home?: string) =>
  resolve(migrationsDir(home), `backup-layout${layout}`);

// ── What each path HOLDS ─────────────────────────────────────────────────────

/**
 * What kind of data a path in the home holds, which is what decides whether an
 * upgrade may throw it away.
 *
 * The rule, stated once: **derived and re-fetchable may be dropped; anything a
 * person typed, anything not yet delivered, and anything that identifies the
 * machine is carried.**
 */
export type DataClass =
  /** A person set this and nothing regenerates it. Never deleted. */
  | "user-typed"
  /** Recorded here and not yet shipped anywhere. Never deleted. */
  | "undelivered"
  /** Stable ids and watermarks. Never deleted — a new one is a new machine. */
  | "identity"
  /** Rebuilt on demand. May be dropped. */
  | "derived"
  /** The server is the source of truth. May be dropped and re-fetched. */
  | "refetchable"
  /** Sockets, locks, binaries: live process state. Never touched by a reset. */
  | "ephemeral";

/**
 * Every path in the home, and what it holds.
 *
 * `resettablePaths()` is DERIVED from this rather than hand-listed beside it,
 * and that is the whole point. Before this table one path was declared in four
 * places — as a function above, again in `legacy` once it moved, again in the
 * delete list, and again in `CARRIED_POLICY_CONFIG_KEYS` if it held carried
 * keys — with nothing making the four agree. **Every silent-data-loss bug this
 * module has had is one of those lists falling out of sync with a path that
 * moved:** layout 1's `policies/` (hand-written source, deleted), layout 2's
 * nested policy config (enabled policies, emptied), `cache/hook-activity` (the
 * whole decision log, deleted with its parent), the layout-2 `credentials.toml`
 * (a live token left behind), and `collector.sources.extra_paths` — which was
 * on the delete list by way of `config.json` and would have taken every extra
 * path a user typed at the next layout bump.
 *
 * Two consequences worth naming:
 *
 *  - **Forgetting is now safe.** A path absent from this table is not deleted,
 *    because the delete list is a filter over what is here rather than a
 *    catch-all. The failure mode of an oversight becomes a stale file — loud
 *    and recoverable — instead of a deleted cloud token.
 *  - **`state/` is not classified as a whole**, because it is mixed: its
 *    `spool/` and `telemetry-id` are things we must never drop, and everything
 *    else under it is scratch. Listing the parent is exactly how a reset came
 *    to delete undelivered events and the machine's own telemetry identity.
 *
 * `__tests__/hooks/fp-home.test.ts` asserts every exported path function in
 * this module is either classified here or covered by a classified parent, so
 * the next path added to the home cannot skip the one question that matters.
 *
 * It cited `home-classification.test.ts` until that was checked — a file that
 * has never existed. The guard was real and in the wrong place, which is the
 * failure this header already describes happening once before: a citation is
 * only load-bearing if somebody follows it, and the person who does is looking
 * for the rule they are about to break.
 */
export const HOME_CLASSES: readonly { path: (home?: string) => string; class: DataClass }[] = [
  // ── Never deleted: a person typed it ──
  // The cloud enrolment. Deleting it drops the machine out of cloud-managed
  // policy silently — it keeps enforcing whatever it last had, reports healthy,
  // and never reconciles again. Nothing re-derives a token.
  { path: credentialsFile, class: "user-typed" },
  // Holds `daemon.configured` (the flag that makes the machine fail closed),
  // the collector preferences, `[audit] auto`, the telemetry opt-out, and
  // `collector.sources.*.extra_paths` — the entire output of `harness add-path`.
  { path: configFile, class: "user-typed" },
  // The builtin enable/disable set and per-policy params. `resetHome` used to
  // clear this and carry eight named keys back over; it is simply kept now.
  { path: globalPolicyConfigFile, class: "user-typed" },
  // The user's own convention policies, the `lib/` they import and the data
  // files they read. `at("policies")` was on the delete list once: hand-written
  // source destroyed, while `isConfigured()` still read true so the wizard never
  // re-asked and hooks kept firing against an empty policy set.
  { path: policiesDir, class: "user-typed" },
  // The signed-in session. `auth.json` at the home root through layout 3, where
  // it was in NEITHER this table nor the delete list — undeleted by oversight
  // rather than by decision, which is the state this table exists to make
  // impossible. Nothing regenerates a session; losing it signs the machine out
  // with no notice, and the machine only finds out the next time it tries to
  // report.
  { path: auditSessionFile, class: "user-typed" },
  // The Cloud CLI's session, written by Python (`fp-cloud-cli/fp_cli/config.py`). The
  // one entry here whose writer is outside this repo's TS and Rust, which is
  // exactly why it needs listing: nothing in a migration would otherwise know a
  // credential lives under `fpcli/`.
  { path: fpcliAuthFile, class: "user-typed" },

  // ── Never deleted: recorded and not yet shipped ──
  // Batches read out of transcripts and queued for upload. The reason losing
  // these is PERMANENT and not merely slow is `cursorsDir` below: the watermark
  // has already advanced past them, so nothing will ever read that range again.
  { path: spoolDir, class: "undelivered" },
  { path: failedDir, class: "undelivered" },
  // The SDK spool (`events/` + `failed/`), same argument.
  { path: customAgentsDir, class: "undelivered" },
  // The decision log the dashboard's activity tab reads. Neither derived nor
  // re-fetchable: it is the record of what this machine did, and nothing
  // regenerates it. Deleting its layout-1 parent threw away every decision a
  // machine had recorded, which is why `migrateHookActivity()` exists.
  { path: hookActivityDir, class: "undelivered" },
  // Requests the CLI wrote for the daemon to drain on its next tick. The file's
  // existence IS the pending state, so deleting one silently cancels something
  // a person asked for. Rust-only paths (`crates/failproofaid/src/paths.rs`),
  // hence spelled here rather than exported — nothing on this side reads them.
  { path: (home) => resolve(stateDir(home), "flush-request.json"), class: "undelivered" },
  { path: (home) => resolve(stateDir(home), "backfill-request.json"), class: "undelivered" },

  // ── Never deleted: it names the machine ──
  // Per-source watermarks. Kept out of the reset so pages carried by
  // `migrateHookActivity()` are not re-shipped in full — it MOVES them, which
  // preserves the inode a cursor is keyed on. A cursor whose file is gone is
  // inert (`retain_existing` drops it), so keeping them costs nothing.
  { path: cursorsDir, class: "identity" },
  // The anonymous instance id both the CLI and the daemon report under. Tiers 1
  // and 2 of `getInstanceId()` re-derive the same value, so most machines would
  // survive losing it — but a machine that fell through to the daemon's own
  // fallback would come back as a brand-new PostHog person, and no analysis
  // spans that split.
  { path: telemetryIdFile, class: "identity" },
  { path: (home) => resolve(stateDir(home), "daemon-telemetry-id"), class: "identity" },
  // The layout marker itself. Not user data, and `resetHome` rewrites it
  // immediately — but listing it made a no-op reset report "removed 1 item" for
  // a file it had just recreated.
  { path: versionFile, class: "identity" },
  // The record of what this machine has been migrated through, and the copies a
  // step took before running. A migration deleting its own audit trail would
  // leave "what has this home been through?" answerable only by guessing, and
  // deleting the backup is deleting the undo for the step that just ran.
  { path: migrationsDir, class: "identity" },

  // This machine's report identity + digest watermark. `identity` for the same
  // reason `cursorsDir` is: a new id is a new machine to the api-server, which
  // burns a slot off the account's machine cap, and a reset watermark re-reports
  // history the user was already told about. Kept OUT of `auditSessionFile`
  // precisely so both survive a sign-out.
  { path: auditMachineFile, class: "identity" },

  // ── May be dropped: rebuilt on demand ──
  // NOTE: `auditDir` itself is deliberately absent. Layout 4 made it MIXED — it
  // holds the session and the machine identity above alongside these three — so
  // it is classified per-file, exactly like `stateDir`. Listing the parent here
  // (which layout 3 did, correctly for what it then held) would put the token on
  // the delete list.
  { path: auditDashboardFile, class: "derived" },
  { path: auditCacheDir, class: "derived" },
  { path: auditScheduleFile, class: "derived" },
  { path: collectorHealthFile, class: "derived" },
  { path: codexSessionPathsFile, class: "derived" },
  { path: shimsDir, class: "derived" },
  { path: sessionPauseDir, class: "derived" },
  { path: logsDir, class: "derived" },
  { path: lastVersionFile, class: "derived" },
  { path: launcherMarker, class: "derived" },
  { path: onboardingLockFile, class: "derived" },
  { path: onboardingAttemptFile, class: "derived" },

  // ── May be dropped: the server has it ──
  // Re-fetched and digest-verified on the next daemon poll. This is the whole
  // reason the delete list is per-entry rather than `rm -rf policies/`: one
  // directory holds both the files a person wrote and the ones the fleet sent,
  // and only the second kind may be thrown away.
  { path: cloudPoliciesDir, class: "refetchable" },
  // Installed packs. Third-party packs are re-fetchable by `failproofai pack
  // add`; the bundled default pack is restored from the package immediately
  // after reset. So this is the fleet's argument again: one directory holds both
  // what a person wrote and what a command fetched, and only the second kind may
  // be thrown away. Without this row `packs/` inherits `policiesDir`'s
  // `user-typed` and survives a reset that is supposed to clear re-fetchable
  // state.
  { path: packsDir, class: "refetchable" },

  // ── Never touched ──
  // A downloaded daemon binary is large, version-pinned and re-verified on use,
  // so deleting it only forces a needless re-download.
  { path: binDir, class: "ephemeral" },
  // Sockets and the singleton flock belong to a process that may be alive right
  // now; removing them breaks it rather than resetting configuration.
  { path: runDir, class: "ephemeral" },
];

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
  /**
   * Layout 1's policy config — at the home root.
   *
   * Layout 3 puts the CURRENT config back at this exact path, so this is not a
   * discriminating landmark on its own. `detectLayout()` checks for a layout-2+
   * marker before consulting it; see the comment there.
   */
  policyConfig: () => at("policies-config.json"),
  /**
   * Layout 2's `config.toml`. A landmark in its own right now: layout 1 had no
   * such file, so its presence proves a home is newer than layout 1 even when
   * `VERSION` is missing.
   */
  configToml: () => at("config.toml"),
  /** Layout 2's credentials, replaced by `credentials.json`. */
  credentialsToml: () => at("credentials.toml"),
  /** Layout 2 nested the policy config two levels down. */
  localPoliciesDir: () => at("policies", "local-policies"),
  /**
   * Layout 2's policy config, at its nested path.
   *
   * The file `readCarriedPolicyConfig()` reads and `localPoliciesDir()` above
   * deletes — so on the layout-2 leg this, not `policyConfig()`, is the policy
   * selection the migration destroys. Named separately because its BASENAME is
   * identical to the layout-1 root copy's, and the backup directory is flat.
   */
  localPolicyConfig: () => at("policies", "local-policies", "policies-config.json"),
  /** Layout 2 kept convention policies in a subdirectory. */
  customPoliciesDir: () => at("policies", "custom-policies"),
  // NO `cloudPoliciesDir` HERE. Layout 2 put cloud deployments at
  // `policies/cloud-policies`, which is where layout 3 puts them too — so there
  // is no old location to migrate from or prune, and an entry here would be a
  // "legacy" path identical to the live one. That is not a harmless duplicate:
  // it is exactly the shape that made `legacy.policyConfig()` unusable as a
  // landmark, and anything treating this list as "safe to delete, it's old"
  // would be deleting the current deployment. What DID change inside it is the
  // shape — `deployments/<n>/` trees flattened into one `artifacts/` dir —
  // which `cloud_policies.rs` prunes after the flip, not this list.
  policyConfigLocal: () => at("policies-config.local.json"),
  cloudCredentials: () => at("cloud.json"),
  ingestCredentials: () => at("ingest.json"),
  launcherMarker: () => at(".launcher-configured"),
  lastVersion: () => at("last-version"),
  auditDashboard: () => at("audit-dashboard.json"),
  /**
   * Layout 3's audit-owned files, before layout 4 gathered them under `audit/`.
   *
   * The first two were never classified in `HOME_CLASSES`, so unlike every other
   * entry in this map they were not on any delete list — the layout-4 step MOVES
   * them and there is no older copy to prune. They are here so that step can
   * find them, and so `filesToBackUp()` copies them aside first: a bug in the
   * move would otherwise take a live session with it.
   */
  authJson: () => at("auth.json"),
  nextAudit: () => at("next-audit.json"),
  /**
   * Layout 4's `audit/reminder.json`, retired before it was ever written to.
   *
   * The layout-4 step MOVES `next-audit.json` here rather than deleting it,
   * because the scheduled-audit work that replaces reminders had not landed yet
   * and dropping a cadence someone chose would have been unrecoverable if it
   * slipped. It has landed; the reminder concept is gone, and this is the
   * position the file was parked in. Listed so a reset clears it.
   */
  auditReminder: () => at("audit", "reminder.json"),
  auditSchedule: () => at("state", "audit-schedule.json"),
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
 *
 * TWO HALVES, and they are not maintained the same way. The paths of layouts
 * that no longer exist are listed by hand below, because a retired path has no
 * definition left to hang a class off — it exists only in this file. The paths
 * of the CURRENT layout are DERIVED from `HOME_CLASSES`, so a path that moves
 * or is added cannot silently fall off (or onto) the list. See `HOME_CLASSES`
 * for what each class means and which incidents the split is answering.
 */
export function resettablePaths(): string[] {
  return [
    ...retiredLayoutPaths(),
    // The current layout, by what each path HOLDS. `user-typed`, `undelivered`
    // and `identity` are absent from this list by construction rather than by
    // anyone remembering to leave them out.
    ...HOME_CLASSES.filter((e) => e.class === "derived" || e.class === "refetchable").map((e) =>
      e.path(),
    ),
  ];
}

/**
 * The paths of layouts this build no longer writes.
 *
 * Hand-listed, and they have to be: a retired path has no definition to carry a
 * class, and `legacy` is the only place it still exists. Each entry is here
 * because an upgrade would otherwise leave it behind — see the notes inline,
 * every one of which records something that actually happened.
 *
 * Phase-splitting these per migration step is what the migration registry does
 * with them next; until then they are one list because `resetHome` is one step.
 */
function retiredLayoutPaths(): string[] {
  return [
    // Layout 1
    //
    // NOT `legacy.policyConfig()`. It is `at("policies-config.json")` — the
    // EXACT path layout 3 puts the live config back at, which `legacy`'s own
    // note records and `detectLayout()` has a whole ordering rule about. Listing
    // it here while `HOME_CLASSES` calls the same path `user-typed` would have
    // the two halves of this function contradict each other, and the delete
    // would win.
    //
    // Leaving it in place is also strictly better than what it replaced. The old
    // sequence was delete-then-carry-eight-named-keys, so every key outside
    // `CARRIED_POLICY_CONFIG_KEYS` was dropped on a layout-1 upgrade; now the
    // file is simply not touched and keeps everything. `readCarriedPolicyConfig`
    // is narrowed to layout 2's NESTED copy accordingly — that path really is
    // deleted (`legacy.localPoliciesDir()`, below) and really does need carrying.
    //
    // The project-scope `policies-config.local.json` is a different file at a
    // different path (`{cwd}/.failproofai/`, see `hooks-config.ts`); the global
    // one below is a layout-1 artefact nothing reads.
    legacy.policyConfigLocal(),
    legacy.cloudCredentials(),
    legacy.ingestCredentials(),
    legacy.launcherMarker(),
    legacy.lastVersion(),
    legacy.auditDashboard(),
    // `legacy.cacheDir()` — the whole of `cache/` — stood here, and it CONTAINS
    // `cache/hook-activity`: layout 1's decision log. Deleting the parent threw
    // away every decision the machine had ever recorded, which is the data the
    // dashboard's activity tab exists to show. Its children are now named
    // individually so the log can be carried across by
    // `migrateHookActivity()`, and everything else in `cache/` still goes —
    // both remaining entries are re-derived on demand.
    legacy.auditCacheDir(),
    // The reminder, at the position layout 4 parked it in. It is on this list
    // rather than in `HOME_CLASSES` because the path is RETIRED: nothing writes
    // it any more, so it has no class to carry — only a location to clear.
    legacy.auditReminder(),
    legacy.codexSessionPaths(),
    legacy.spoolDir(),
    legacy.failedDir(),
    legacy.collectorHealth(),
    legacy.onboardingLock(),
    legacy.cloudManagedPolicies(),
    // Layout 2's files, by their layout-2 names. Without these a layout-2 home
    // upgrading to 3 keeps `config.toml` and `credentials.toml` sitting next to
    // the new `.json` pair — two configs, one of them stale, and the reset that
    // was supposed to clear the old layout leaving its most important files
    // behind. `credentials.toml` is the worse half: a live token in a file
    // nothing reads any more and nothing will clean up.
    legacy.configToml(),
    legacy.credentialsToml(),
    legacy.localPoliciesDir(),
    // NOT `legacy.customPoliciesDir()`. `migrateConventionPolicies()` empties it
    // and removes it itself, and whatever it could NOT move is the user's own
    // hand-written source — which this list would delete moments after that
    // function deliberately decided to preserve it. That is not hypothetical:
    // a `lib/` of helpers colliding with a stale `policies/lib/` was destroyed
    // outright, and the policy that did move was left importing a file that no
    // longer existed.
    //
    // Everything that used to follow here — `globalPolicyConfigFile()`,
    // `cloudPoliciesDir()`, `at("state")`, `configFile()`, `credentialsFile()`,
    // `auditDir()`, `customAgentsDir()`, `logsDir()` — was the CURRENT layout,
    // hand-listed. It is derived from `HOME_CLASSES` now, and five of those
    // entries stopped being deleted as a result, each for a reason recorded on
    // its row: the cloud token, the whole of `config.json` (including the
    // `extra_paths` a user typed), the undelivered spool, the SDK spool, and the
    // machine's telemetry identity.
    //
    // `at("state")` is the sharpest of them. It is MIXED — `spool/` and
    // `telemetry-id` sit under it beside a dozen scratch files — so listing the
    // parent is precisely how a reset came to delete events that were recorded,
    // queued, and then unreachable forever, because `cursors/` deliberately
    // survives and the watermark had already moved past them. Its scratch
    // children are classified individually now and the parent is not listed at
    // all, so anything under it this table has not been taught about survives
    // rather than being swept up.
    //
    // Two notes worth keeping from the old list, because they explain absences
    // that still hold:
    //
    // `policies/` is `user-typed`, not absent by oversight. On layout 1 that
    // directory IS the documented home for hand-written personal policies —
    // `docs/configuration.mdx` names `~/.failproofai/policies/` as the user
    // scope, and `manager.ts` read it. It stood on this list once: source files
    // a person wrote, nothing regenerating them, nothing backing them up, and a
    // reset message that named only "policy config, activity history and audit
    // cache". Worse, the machine then reported itself configured —
    // `isConfigured()` is a union that still sees the agent CLIs' untouched
    // settings files — so the wizard was skipped and hooks kept firing against
    // an empty policy set. Its `cloud-policies/` CHILD is `refetchable` and does
    // still go, which is the whole reason this is a per-entry list and not
    // `rm -rf policies/`.
    //
    // `cursors/` is `identity` for a reason load-bearing to the activity
    // migration rather than a separate opinion. Cursors are keyed on
    // `(device, inode)`; `migrateHookActivity()` MOVES pages, which preserves
    // the inode, so a surviving cursor still points at the file it belongs to
    // and resumes at the right offset. Delete the cursors and every carried page
    // reads as new and re-ships in full — the outcome the move exists to avoid.
    // A cursor whose file is gone is inert (`retain_existing` drops it), so
    // keeping them costs nothing when there is nothing to resume.
    //
    // And `hook-activity/` is `undelivered`, never listed: it is the DESTINATION
    // `migrateHookActivity()` moves layout 1's log into, so listing it deleted
    // the migration moments after it happened — the reset runs every path in
    // this list after the migrations.
  ];
}
