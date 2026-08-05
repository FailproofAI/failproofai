//! The scheduled local audit: spawn `failproofai audit --scheduled` as a
//! short-lived subprocess whenever the wall clock says one is due.
//!
//! # Why this can never run on the warm worker
//!
//! A full audit measured ~104 seconds over 3,277 transcripts. The warm worker
//! (`src/hooks/worker-server.ts`) serialises EVERY request through one promise
//! chain, [`crate::worker`] caps a call at 30 seconds, and `daemon-client.ts`
//! turns that timeout into a DENY — so an audit on that chain would be a
//! machine-wide fail-closed denial across all 12 agent CLIs for as long as it
//! ran. It therefore runs as its own process, at `nice(19)`, in its own process
//! group, with a hard timeout. `__tests__/hooks/worker-server.test.ts` carries a
//! tripwire so a later "optimisation" onto that chain fails loudly instead of
//! quietly denying a machine.
//!
//! # Wall clock decides "due"; monotonic time does everything else
//!
//! Every other lane in this daemon sleeps on `Instant`, and this one
//! deliberately does not use it to decide whether a scan is due: `Instant` does
//! not advance across suspend and restarts at zero on every process start, so a
//! monotonic seven-day timer never fires on a laptop that is shut each night or
//! on a daemon that restarts on every upgrade. The due time is a wall-clock
//! millisecond persisted to disk. `Instant` still measures the child's timeout,
//! the tick sleep and the minimum-gap floor, which is what a monotonic clock is
//! actually for.
//!
//! # The schedule is persisted BEFORE the child is spawned
//!
//! This inverts the collector's flush-then-advance rule
//! (`crates/fpai-collect/src/cursor.rs`) on purpose. There the protected
//! resource is data, and a crash between the two costs a re-ship the server
//! dedups. Here the protected resource is the machine's CPU and the unit is
//! `Restart=on-failure`: run-then-write means a scan that takes the daemon down
//! relaunches itself on every restart, forever. Writing first costs at most one
//! skipped audit.

use std::io;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Mirrors `DEFAULT_AUDIT_INTERVAL_DAYS` and the clamp in
/// `src/hooks/fp-config.ts`. Two readers of one file have to agree on what its
/// values mean, and the way that disagreement shows up is a machine scanning on
/// a cadence nobody chose.
const DEFAULT_INTERVAL_DAYS: u64 = 7;
const MIN_INTERVAL_DAYS: u64 = 1;
const MAX_INTERVAL_DAYS: u64 = 90;

/// The floor between two attempts, independent of the persisted schedule.
///
/// Deliberately redundant with `next_due_at_ms`, because the redundancy is the
/// point: the persisted half cannot protect a home the daemon is unable to
/// write to (a full disk, a read-only mount), and without a second in-memory
/// floor such a machine would start a fresh 104-second scan on every poll tick
/// forever. It is also what a child that exited 75 ("another audit holds the
/// lock") is retried against.
const MIN_ATTEMPT_GAP: Duration = Duration::from_secs(15 * 60);

/// How long a scan may run before it is killed.
///
/// ~17x the measured 104-second full scan, so a cold cache, a much larger
/// history or a slow disk all finish comfortably inside it. The ceiling exists
/// for the wedged case only — a child blocked on a network filesystem, say —
/// because a `nice(19)` process nobody is waiting on has no other way of ending,
/// and an inherited one would still hold the audit lock long after it stopped
/// making progress.
const CHILD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// `EX_TEMPFAIL`, and what `runScheduledAudit` returns when the cross-process
/// audit lock is already held (`EXIT_AUDIT_ALREADY_RUNNING` in
/// `src/audit/cli.ts`). NOT a failure: the machine is healthy and simply ran two
/// audits close together, so it is retried against the gap floor rather than
/// reported or counted as a run.
const EXIT_LOCK_HELD: i32 = 75;

/// Bumped only for a change no `#[serde(default)]` can absorb. A mismatch reads
/// as "no schedule yet", which re-seeds one interval out — never a scan the user
/// did not ask for.
const SCHEMA: u32 = 1;

// ── Configuration ────────────────────────────────────────────────────────────

/// The `[audit]` table of `config.toml`, resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AuditConfig {
    auto: bool,
    interval: Duration,
}

/// Read `[audit]` out of `config.toml`.
///
/// Every failure — absent file, unparseable TOML, an `[audit]` table of the
/// wrong shape — resolves to OFF rather than to an error or a default-on. The
/// asymmetry with [`crate::cloud_client`], which treats a malformed credential
/// as an error worth surfacing, is deliberate: this switch guards a scan that
/// reads the CONTENTS of every session transcript on disk, so the only safe
/// reading of "we could not tell" is "do not scan". The collector already
/// reports a malformed `config.toml` loudly on the same startup path, so nothing
/// is hidden by staying quiet here.
fn load_config(home: &Path) -> AuditConfig {
    let off = AuditConfig {
        auto: false,
        interval: Duration::from_secs(DEFAULT_INTERVAL_DAYS * 86_400),
    };
    let Ok(text) = std::fs::read_to_string(home.join("config.toml")) else {
        return off;
    };
    // `toml::from_str`, NOT `text.parse::<toml::Value>()`: `FromStr for Value`
    // parses a single VALUE, so it rejects a whole document at the first table
    // header ("unexpected content, expected nothing"). It compiles, it never
    // errors visibly, and it makes every `[audit]` table on every machine read
    // as absent — i.e. the feature would ship permanently off with no symptom.
    // The rest of the codebase reads this file the same way (see
    // `fpai_collect::config::load_settings`).
    let Ok(root) = toml::from_str::<toml::Value>(&text) else {
        return off;
    };
    let Some(audit) = root.get("audit") else {
        return off;
    };
    AuditConfig {
        // Only a literal `true`. Absent, misspelled and `"yes"` all read as off,
        // matching `readConfig` in fp-config.ts — the failure direction that
        // matters is a machine that starts reading every transcript it can find
        // on a timer nobody set.
        auto: audit.get("auto") == Some(&toml::Value::Boolean(true)),
        interval: Duration::from_secs(read_interval_days(audit.get("interval_days")) * 86_400),
    }
}

/// The clamp from `readIntervalDays` in `src/hooks/fp-config.ts`, value for
/// value.
///
/// 0, a negative, a fraction under a day and any non-number all resolve to the
/// DEFAULT rather than clamping up to the 1-day floor: a `0` almost certainly
/// means "off", and reading it as a DAILY full scan is the loudest possible way
/// to get that wrong. A too-large value is clamped DOWN to 90 instead, which is
/// the conservative direction there — falling back to 7 would scan an order of
/// magnitude more often than was asked for.
fn read_interval_days(raw: Option<&toml::Value>) -> u64 {
    let days = match raw {
        Some(toml::Value::Integer(n)) => *n as f64,
        Some(toml::Value::Float(f)) if f.is_finite() => *f,
        _ => return DEFAULT_INTERVAL_DAYS,
    };
    let days = days.floor();
    if days < MIN_INTERVAL_DAYS as f64 {
        return DEFAULT_INTERVAL_DAYS;
    }
    // Rust saturates float→int casts, so an absurd `interval_days = 1e30`
    // lands on u64::MAX here and then on MAX_INTERVAL_DAYS, not on 0.
    (days as u64).min(MAX_INTERVAL_DAYS)
}

// ── Persisted schedule ───────────────────────────────────────────────────────

/// `~/.failproofai/state/audit-schedule.json`. The daemon is its only writer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
struct ScheduleState {
    schema: u32,
    /// Wall clock, milliseconds since the epoch. Not an `Instant`: see the
    /// module header.
    next_due_at_ms: i64,
    /// When a scan was last STARTED — written before the child is spawned.
    #[serde(default)]
    last_attempt_at_ms: Option<i64>,
    /// When a scan last finished successfully. Never advanced by an exit 75,
    /// which means no scan ran at all.
    #[serde(default)]
    last_run_at_ms: Option<i64>,
    #[serde(default)]
    last_exit_code: Option<i32>,
}

/// A schedule with no history, for the two branches that have to build one from
/// nothing. `next_due_at_ms` is overwritten by every user of it, so the zero
/// here is a placeholder rather than "due at the epoch".
const BLANK: ScheduleState = ScheduleState {
    schema: SCHEMA,
    next_due_at_ms: 0,
    last_attempt_at_ms: None,
    last_run_at_ms: None,
    last_exit_code: None,
};

/// Load the schedule, or `None` if there is not a usable one.
///
/// Corruption and an unknown schema are both treated as absent and logged, not
/// propagated: a lane that refused to run because its state file was damaged
/// would be silently inert for as long as nobody looked, whereas re-seeding
/// costs one skipped interval and self-heals.
fn load_state(path: &Path) -> Option<ScheduleState> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<ScheduleState>(&text) {
        Ok(state) if state.schema == SCHEMA => Some(state),
        Ok(state) => {
            eprintln!(
                "[failproofaid] audit schedule {} has schema {} (expected {}); re-seeding",
                path.display(),
                state.schema,
                SCHEMA
            );
            None
        }
        Err(err) => {
            eprintln!(
                "[failproofaid] audit schedule {} is unreadable ({err}); re-seeding",
                path.display()
            );
            None
        }
    }
}

/// Persist atomically (tmp → fsync → rename) at owner-only permissions.
///
/// Atomic because a torn write here is not a lost byte but a lost schedule, and
/// a lost schedule re-seeds an interval out — which on a machine that crashes
/// mid-write repeatedly would mean the scan never runs at all. 0600 because the
/// file names process ids and scan times of the user's own machine; nothing else
/// under `state/` is world-readable either.
fn save_state(path: &Path, state: &ScheduleState) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string_pretty(state).map_err(io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    write_private(&tmp, body.as_bytes())?;
    std::fs::rename(&tmp, path)
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    std::fs::write(path, bytes)
}

// ── The due-time algorithm ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    /// There is no usable due time. Write one, one interval out, and do NOT scan
    /// now.
    ///
    /// Two cases reach it. **No schedule at all** — turning the switch on must
    /// not cost the user 104 seconds of disk at that moment, and the daemon
    /// restarts often enough (every upgrade, every boot) that "scan the first
    /// time you see no state" would be a scan per restart on any machine whose
    /// state file cannot be kept. **A due time further out than one whole
    /// interval** — which this lane cannot have written against the current
    /// clock, so either the clock moved backwards or the interval was shortened;
    /// see [`needs_rescheduling`].
    Reschedule,
    Wait,
    Run,
}

/// Whether the recorded due time is one this lane could plausibly have written.
///
/// `next_due_at_ms` is an ABSOLUTE wall-clock instant, and the lane only ever
/// writes `now + interval` — so anything further out than one interval means the
/// ground moved underneath it. The two ways that happens are a clock corrected
/// backwards (NTP after a dead RTC; a dual-boot box writing localtime to the
/// hardware clock) and an `interval_days` the user shortened. Both are
/// indistinguishable from here and both want the same repair.
///
/// It has to be a REWRITE rather than a clamp applied at read time. A clamp
/// would compute `min(next_due, now + interval)`, which is strictly in the
/// future at every `now` — so a machine whose clock jumped back a year would
/// wait forever, one interval at a time, while its config kept saying the scan
/// was on. Persisting the corrected value is what makes it fire one interval
/// later and then stay correct.
fn needs_rescheduling(state: &ScheduleState, now_ms: i64, interval_ms: i64) -> bool {
    state.next_due_at_ms > now_ms.saturating_add(interval_ms)
}

/// Pure decision, so the awkward cases — asleep long past due, a clock that
/// jumped backwards, a state file that cannot be written — are testable without
/// a daemon, a clock or a 104-second scan.
///
/// `since_last_attempt` is monotonic and in-memory: it is what holds the floor
/// when the persisted half cannot be written.
fn decide(
    state: Option<&ScheduleState>,
    now_ms: i64,
    interval_ms: i64,
    since_last_attempt: Option<Duration>,
) -> Decision {
    let Some(state) = state else {
        return Decision::Reschedule;
    };
    if needs_rescheduling(state, now_ms, interval_ms) {
        return Decision::Reschedule;
    }
    if now_ms < state.next_due_at_ms {
        return Decision::Wait;
    }
    if since_last_attempt.is_some_and(|elapsed| elapsed < MIN_ATTEMPT_GAP) {
        return Decision::Wait;
    }
    Decision::Run
}

/// The schedule to persist BEFORE spawning a scan.
///
/// The next due time is recomputed from `now`, never by adding an interval to
/// the one that was missed. A laptop asleep for 30 days wakes to exactly one
/// scan, not four back-to-back 104-second ones at the worst possible moment.
fn advanced(state: &ScheduleState, now_ms: i64, interval_ms: i64) -> ScheduleState {
    ScheduleState {
        schema: SCHEMA,
        next_due_at_ms: now_ms.saturating_add(interval_ms),
        last_attempt_at_ms: Some(now_ms),
        ..state.clone()
    }
}

// ── The lane ─────────────────────────────────────────────────────────────────

/// What the lane last said about itself, so a steady state does not print a line
/// every tick for the life of the daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Announced {
    Off,
    Scheduled,
    NoCliCommand,
}

#[derive(Default)]
struct Lane {
    announced: Option<Announced>,
    /// Monotonic, in-memory half of the attempt floor. Deliberately not restored
    /// from disk on startup: the persisted `next_due_at_ms` is the cross-restart
    /// guard, and this one exists precisely for the case where that write did
    /// not land.
    last_attempt: Option<Instant>,
}

/// Start the audit lane.
///
/// Its own thread, observing the same shutdown flag as the socket server, the
/// collector manager and the cloud lane, so one SIGTERM stops all four. Nothing
/// in here is propagated to `run()`: this daemon fails closed, so a fault in a
/// lane nobody is watching must never be able to take down the process and deny
/// every tool call on the machine.
///
/// The thread starts even when `auto = false`, which is the default and the
/// common case. It re-reads `config.toml` every tick for the same reason the
/// collector manager and the cloud lane do: `failproofai config` writes that
/// file without root while this is a SYSTEM unit, so resolving once at startup
/// would put `sudo systemctl restart` back into the flow that was built to avoid
/// it. The cost of being wrong the other way is one small file read a minute.
pub fn spawn(shutdown: Arc<AtomicBool>) -> JoinHandle<()> {
    let poll = poll_interval();
    std::thread::Builder::new()
        .name("fpai-audit-lane".to_string())
        .spawn(move || {
            let mut lane = Lane::default();
            while !shutdown.load(Ordering::Relaxed) {
                // A panic must not escape this thread. `panic = "unwind"` means
                // a thread panic would not by itself end the process today, but
                // it WOULD end the lane permanently and silently — the config
                // would still say the scan is on and nothing would ever run
                // again. Catching it keeps the next tick alive.
                if std::panic::catch_unwind(AssertUnwindSafe(|| lane.tick(&shutdown))).is_err() {
                    eprintln!("[failproofaid] audit lane panicked; it will try again next tick");
                }
                wait_until_shutdown(&shutdown, poll);
            }
        })
        .expect("failed to spawn the audit lane thread")
}

impl Lane {
    fn tick(&mut self, shutdown: &AtomicBool) {
        let Ok(home) = crate::paths::failproofai_home() else {
            return;
        };
        let config = load_config(&home);
        if !config.auto {
            self.announce(Announced::Off, "scheduled audit disabled");
            return;
        }

        // The single most likely way this feature fails on a real machine: an
        // install that predates `FAILPROOFAI_CLI_CMD` keeps its old service
        // unit, so the daemon has no way to launch the CLI and the lane is
        // permanently inert while the config says the scan is on. Loud, and once
        // — `ensureDaemonServiceCurrent()` in daemon-service.ts is what repairs
        // it, on the next `failproofai config`.
        let Some(cli_cmd) = cli_command() else {
            self.announce(
                Announced::NoCliCommand,
                "scheduled audit is ON but this service unit carries no FAILPROOFAI_CLI_CMD, \
                 so nothing can run it — re-run `failproofai config` to refresh the unit",
            );
            return;
        };

        let Ok(path) = crate::paths::audit_schedule_path() else {
            return;
        };
        let interval_ms = config.interval.as_millis() as i64;
        let now = now_ms();
        let state = load_state(&path);

        match decide(state.as_ref(), now, interval_ms, self.since_last_attempt()) {
            Decision::Wait => {
                self.announce(Announced::Scheduled, "scheduled audit enabled");
            }
            Decision::Reschedule => {
                // Carries the previous run's history forward rather than
                // starting a blank file: `last_run_at_ms` is what a status
                // readout means by "last audited", and losing it because the
                // laptop's clock was corrected would report a machine that has
                // been scanning for months as never having run.
                let rescheduled = ScheduleState {
                    schema: SCHEMA,
                    next_due_at_ms: now.saturating_add(interval_ms),
                    ..state.unwrap_or(BLANK)
                };
                if let Err(err) = save_state(&path, &rescheduled) {
                    eprintln!("[failproofaid] could not write the audit schedule: {err}");
                    return;
                }
                self.announce(Announced::Scheduled, "scheduled audit enabled");
            }
            Decision::Run => {
                // Before the write, not after: a write that keeps failing must
                // still be rate-limited to one attempt per gap rather than
                // producing a warning (and, without the guard below, a scan) on
                // every tick.
                self.last_attempt = Some(Instant::now());

                let mut next = advanced(&state.unwrap_or(BLANK), now, interval_ms);
                if let Err(err) = save_state(&path, &next) {
                    // Refusing to scan is the safe direction. Scanning anyway
                    // would leave the schedule unadvanced on disk, and the unit
                    // is Restart=on-failure — so any restart would launch
                    // another full scan, and a restart loop would launch them
                    // back to back forever.
                    eprintln!(
                        "[failproofaid] skipping the scheduled audit: could not persist the \
                         schedule first ({err})"
                    );
                    return;
                }

                self.announce(Announced::Scheduled, "scheduled audit enabled");
                match run_audit_child(&cli_cmd, shutdown) {
                    Outcome::Exited(EXIT_LOCK_HELD) => {
                        // Not a failure and not a run: another entry point (a
                        // manual `failproofai audit`, or the dashboard) holds
                        // the lock. Come back at the gap floor rather than a
                        // full interval, and leave `last_run_at_ms` alone —
                        // nothing was scanned.
                        next.next_due_at_ms =
                            now.saturating_add(MIN_ATTEMPT_GAP.as_millis() as i64);
                        next.last_exit_code = Some(EXIT_LOCK_HELD);
                        eprintln!(
                            "[failproofaid] scheduled audit skipped: another audit holds the lock"
                        );
                    }
                    Outcome::Exited(0) => {
                        // Read the clock again: the scan itself took real time, and
                        // "when did the last audit finish" is what a status
                        // readout means by last run.
                        next.last_run_at_ms = Some(now_ms());
                        next.last_exit_code = Some(0);
                    }
                    Outcome::Exited(code) => {
                        next.last_exit_code = Some(code);
                        eprintln!("[failproofaid] scheduled audit failed (exit {code})");
                    }
                    Outcome::Signalled => {
                        next.last_exit_code = None;
                        eprintln!("[failproofaid] scheduled audit was killed before it finished");
                    }
                    Outcome::NotStarted(err) => {
                        next.last_exit_code = None;
                        eprintln!("[failproofaid] could not start the scheduled audit: {err}");
                    }
                }
                // Best effort: the schedule that matters was already persisted
                // above, so failing here costs a status readout, not a cadence.
                if let Err(err) = save_state(&path, &next) {
                    eprintln!("[failproofaid] could not record the audit outcome: {err}");
                }
            }
        }
    }

    fn since_last_attempt(&self) -> Option<Duration> {
        self.last_attempt.map(|at| at.elapsed())
    }

    /// Log a state change once, never the state itself repeatedly.
    fn announce(&mut self, state: Announced, message: &str) {
        if self.announced == Some(state) {
            return;
        }
        self.announced = Some(state);
        eprintln!("[failproofaid] {message}");
    }
}

// ── The child process ────────────────────────────────────────────────────────

enum Outcome {
    Exited(i32),
    /// Killed by a signal — the hard timeout, or a shutdown mid-scan.
    Signalled,
    NotStarted(io::Error),
}

/// The command that runs one CLI task, from the service unit's environment.
///
/// Written there by `resolveCliCommand()` in `src/hooks/daemon-service.ts` as an
/// absolute runtime plus an absolute `dist/cli.mjs`, because a system-scope unit
/// has no login environment and the most common Node install (nvm) is on no
/// system PATH. There is deliberately no fallback to a bare `failproofai`: one
/// that resolved to a DIFFERENT installation than the one that wrote this unit
/// would scan with a different build's audit engine, silently.
fn cli_command() -> Option<String> {
    usable_cli_command(std::env::var("FAILPROOFAI_CLI_CMD").ok())
}

/// Split out so the "present but empty" case is testable without mutating
/// process-global environment, which Rust's parallel test harness makes a race
/// rather than a fixture.
fn usable_cli_command(raw: Option<String>) -> Option<String> {
    raw.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Run one scan to completion, killing it if it wedges or the daemon is stopping.
fn run_audit_child(cli_cmd: &str, shutdown: &AtomicBool) -> Outcome {
    let mut child = match spawn_audit_child(cli_cmd) {
        Ok(child) => child,
        Err(err) => return Outcome::NotStarted(err),
    };

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return match status.code() {
                    Some(code) => Outcome::Exited(code),
                    None => Outcome::Signalled,
                };
            }
            Ok(None) => {}
            Err(err) => {
                kill_process_group(&mut child);
                return Outcome::NotStarted(err);
            }
        }
        // Kill rather than orphan on shutdown. systemd's default
        // KillMode=control-group would reap it anyway, but leaving that to the
        // service manager means the daemon's own `join()` waits out a 104-second
        // scan on every restart — and on macOS nothing reaps it at all, so a
        // scan would outlive the daemon holding the audit lock.
        if shutdown.load(Ordering::Relaxed) {
            eprintln!("[failproofaid] stopping the scheduled audit for shutdown");
            kill_process_group(&mut child);
            return Outcome::Signalled;
        }
        if started.elapsed() > CHILD_TIMEOUT {
            eprintln!(
                "[failproofaid] scheduled audit exceeded {}s; killing it",
                CHILD_TIMEOUT.as_secs()
            );
            kill_process_group(&mut child);
            return Outcome::Signalled;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn spawn_audit_child(cli_cmd: &str) -> io::Result<Child> {
    use std::os::unix::process::CommandExt;

    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(format!("{cli_cmd} audit --scheduled"))
        .stdin(Stdio::null())
        // Piped and drained, exactly as the warm worker's spawn is and for the
        // same two reasons: inheriting this process's stdout hands the child a
        // copy of an fd that may belong to a pipeline (so that pipe never sees
        // EOF while the child lives), and an undrained pipe fills at ~64 KiB and
        // blocks the child mid-write — which for a scan means a wedged audit
        // holding the lock until the timeout above.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Its own process group, so the timeout can kill the whole tree: `sh -c`
        // is not guaranteed to exec(2) into the command in place, and killing
        // only the tracked pid would leave a real, orphaned scan running.
        .process_group(0);
    unsafe {
        // `setpriority` rather than prefixing the command with `nice`: this runs
        // through `sh -c` with a system unit's minimal PATH, and depending on an
        // external binary being on it is exactly the class of assumption that
        // made a bare `node` in ExecStart fail. The niceness survives exec, so
        // setting it here covers the whole tree.
        //
        // SAFETY: `setpriority` is a bare syscall — no allocation, no locks —
        // which is what a post-fork pre-exec closure is allowed to do. Lowering
        // one's own priority never fails in a way worth aborting the spawn over,
        // so the result is ignored: a scan at normal priority is still better
        // than no scan.
        command.pre_exec(|| {
            libc::setpriority(libc::PRIO_PROCESS, 0, 19);
            Ok(())
        });
    }

    let mut child = command.spawn()?;
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || forward_child_output("stdout", out));
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || forward_child_output("stderr", err));
    }
    Ok(child)
}

/// Relay one of the child's pipes to the daemon's stderr, which systemd/launchd
/// already capture. Ends on EOF when the child exits.
fn forward_child_output(label: &'static str, pipe: impl io::Read) {
    use std::io::BufRead;
    for line in io::BufReader::new(pipe).lines().map_while(Result::ok) {
        eprintln!("[failproofaid] audit {label}: {line}");
    }
}

/// Kills the whole group the child leads (see `.process_group(0)` above), then
/// reaps it so the daemon does not accumulate zombies over its lifetime.
fn kill_process_group(child: &mut Child) {
    let pgid = child.id() as libc::pid_t;
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
    let _ = child.wait();
}

// ── Timing helpers ───────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        // A clock set before 1970. Negative is the honest reading, and the
        // clamp in `effective_due` is what keeps the schedule usable once it is
        // corrected.
        Err(err) => -(err.duration().as_millis() as i64),
    }
}

/// How often to re-check whether a scan is due. A minute is far finer than the
/// coarsest schedule anyone can configure (one day), and the tick itself is one
/// small file read plus one small JSON read. The override exists so an e2e run
/// does not have to wait a minute for the first tick.
fn poll_interval() -> Duration {
    const DEFAULT_MS: u64 = 60_000;
    const MINIMUM_MS: u64 = 500;
    let ms = std::env::var("FAILPROOFAI_AUDIT_POLL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_MS);
    Duration::from_millis(ms.max(MINIMUM_MS))
}

/// Sleep in short slices so a SIGTERM is acted on within milliseconds rather
/// than at the end of a poll interval.
fn wait_until_shutdown(shutdown: &AtomicBool, interval: Duration) {
    let deadline = Instant::now() + interval;
    while !shutdown.load(Ordering::Relaxed) && Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        std::thread::sleep(remaining.min(Duration::from_millis(50)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const DAY_MS: i64 = 86_400_000;
    const WEEK_MS: i64 = 7 * DAY_MS;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fpai-audit-lane-{}-{name}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state_at(next_due_at_ms: i64) -> ScheduleState {
        ScheduleState {
            next_due_at_ms,
            ..BLANK
        }
    }

    // ── config ───────────────────────────────────────────────────────────────

    #[test]
    fn auto_is_off_unless_the_table_says_exactly_true() {
        let dir = scratch("auto");
        for (body, expected) in [
            ("[audit]\nauto = true\n", true),
            ("[audit]\nauto = false\n", false),
            ("[audit]\nauto = \"true\"\n", false),
            ("[audit]\nauto = 1\n", false),
            ("[audit]\n", false),
            ("[collector]\nhooks = true\n", false),
            ("", false),
        ] {
            std::fs::write(dir.join("config.toml"), body).unwrap();
            assert_eq!(load_config(&dir).auto, expected, "for config: {body:?}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_absent_or_unparseable_config_reads_as_off() {
        // "We could not tell" must never mean "scan every transcript on disk".
        let dir = scratch("bad-config");
        assert!(!load_config(&dir).auto, "no config.toml at all");
        std::fs::write(dir.join("config.toml"), "[audit\nauto = true").unwrap();
        assert!(!load_config(&dir).auto, "unparseable TOML");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn interval_days_matches_the_typescript_clamp_value_for_value() {
        // Two readers of one file. A disagreement here is a machine scanning on
        // a cadence nobody chose, which nothing reports.
        for (raw, expected_days) in [
            (Some(toml::Value::Integer(3)), 3_u64),
            (Some(toml::Value::Integer(1)), 1),
            (Some(toml::Value::Integer(90)), 90),
            // Clamped DOWN, because scanning less often than asked is the
            // conservative direction.
            (Some(toml::Value::Integer(3650)), 90),
            // 0 almost certainly means "off", which has its own switch — reading
            // it as a DAILY full scan is the loudest possible misreading.
            (Some(toml::Value::Integer(0)), DEFAULT_INTERVAL_DAYS),
            (Some(toml::Value::Integer(-5)), DEFAULT_INTERVAL_DAYS),
            (Some(toml::Value::Float(0.5)), DEFAULT_INTERVAL_DAYS),
            (Some(toml::Value::Float(7.9)), 7),
            (Some(toml::Value::Float(1e30)), 90),
            (Some(toml::Value::String("7".into())), DEFAULT_INTERVAL_DAYS),
            (None, DEFAULT_INTERVAL_DAYS),
        ] {
            assert_eq!(
                read_interval_days(raw.as_ref()),
                expected_days,
                "for {raw:?}"
            );
        }
    }

    // ── state persistence ────────────────────────────────────────────────────

    #[test]
    fn a_saved_schedule_round_trips() {
        let dir = scratch("roundtrip");
        let path = dir.join("state").join("audit-schedule.json");
        let state = ScheduleState {
            schema: SCHEMA,
            next_due_at_ms: 1_700_000_000_000,
            last_attempt_at_ms: Some(1_699_000_000_000),
            last_run_at_ms: Some(1_699_000_100_000),
            last_exit_code: Some(0),
        };
        save_state(&path, &state).unwrap();
        assert_eq!(load_state(&path), Some(state));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_schedule_file_is_owner_only_and_leaves_no_staging_file() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = scratch("mode");
            let path = dir.join("audit-schedule.json");
            save_state(&path, &state_at(1)).unwrap();
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "got {mode:o}");
            assert!(
                !dir.join("audit-schedule.json.tmp").exists(),
                "the atomic rename must not leave its staging file behind"
            );
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn a_corrupt_or_future_schedule_reads_as_absent_rather_than_wedging_the_lane() {
        // Refusing to run over a damaged state file would leave the lane
        // silently inert for as long as nobody looked. Re-seeding costs one
        // interval and self-heals.
        let dir = scratch("corrupt");
        let path = dir.join("audit-schedule.json");

        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(load_state(&path), None);

        std::fs::write(&path, r#"{"schema":99,"next_due_at_ms":5}"#).unwrap();
        assert_eq!(load_state(&path), None);

        assert_eq!(load_state(&dir.join("nope.json")), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── the due algorithm ────────────────────────────────────────────────────

    #[test]
    fn no_schedule_writes_one_instead_of_scanning_immediately() {
        // The daemon restarts on every upgrade and every boot. "Scan the first
        // time you see no state" would be a full scan per restart on any machine
        // whose state file cannot be kept.
        assert_eq!(decide(None, 1_000, WEEK_MS, None), Decision::Reschedule);
    }

    #[test]
    fn a_schedule_in_the_future_waits() {
        let now = 1_700_000_000_000;
        let state = state_at(now + DAY_MS);
        assert_eq!(decide(Some(&state), now, WEEK_MS, None), Decision::Wait);
    }

    #[test]
    fn a_due_schedule_runs() {
        let now = 1_700_000_000_000;
        let state = state_at(now);
        assert_eq!(decide(Some(&state), now, WEEK_MS, None), Decision::Run);
    }

    #[test]
    fn a_laptop_asleep_past_due_runs_exactly_once() {
        // Never four back-to-back 104-second scans on wake: the next due time is
        // recomputed from `now`, not by adding intervals to the missed one.
        let due = 1_700_000_000_000;
        let state = state_at(due);
        let wake = due + 30 * DAY_MS;

        assert_eq!(decide(Some(&state), wake, WEEK_MS, None), Decision::Run);

        let after = advanced(&state, wake, WEEK_MS);
        assert_eq!(after.next_due_at_ms, wake + WEEK_MS);
        assert_eq!(after.last_attempt_at_ms, Some(wake));
        // The very next tick (in-memory floor aside) must not run again.
        assert_eq!(decide(Some(&after), wake, WEEK_MS, None), Decision::Wait);
        assert_eq!(
            decide(Some(&after), wake + DAY_MS, WEEK_MS, None),
            Decision::Wait
        );
    }

    #[test]
    fn a_clock_jumped_backwards_is_repaired_rather_than_parked_forever() {
        // An absolute wall-clock due time sits a year out after an NTP correction
        // on a box with a dead RTC (or a dual-boot machine writing localtime to
        // the hardware clock). The lane must rewrite it — a read-time clamp is
        // always one interval ahead of `now`, so the scan would never fire while
        // the config kept saying it was on.
        let now = 1_700_000_000_000;
        let state = state_at(now + 400 * DAY_MS);
        assert_eq!(
            decide(Some(&state), now, WEEK_MS, None),
            Decision::Reschedule
        );

        // The rewrite is what recovers, and it is a one-shot: the very next tick
        // waits rather than rescheduling again.
        let repaired = ScheduleState {
            next_due_at_ms: now + WEEK_MS,
            ..state
        };
        assert_eq!(decide(Some(&repaired), now, WEEK_MS, None), Decision::Wait);
        assert_eq!(
            decide(Some(&repaired), now + WEEK_MS, WEEK_MS, None),
            Decision::Run
        );
    }

    #[test]
    fn a_reschedule_keeps_the_history_a_status_readout_shows() {
        // Losing last_run_at_ms because the laptop's clock was corrected would
        // report a machine that has been scanning for months as never audited.
        let now = 1_700_000_000_000;
        let state = ScheduleState {
            next_due_at_ms: now + 400 * DAY_MS,
            last_run_at_ms: Some(now - DAY_MS),
            last_exit_code: Some(0),
            ..BLANK
        };
        let rescheduled = ScheduleState {
            schema: SCHEMA,
            next_due_at_ms: now + WEEK_MS,
            ..state.clone()
        };
        assert_eq!(rescheduled.last_run_at_ms, state.last_run_at_ms);
        assert_eq!(rescheduled.last_exit_code, state.last_exit_code);
    }

    #[test]
    fn shortening_the_interval_takes_effect_without_waiting_out_the_old_one() {
        // Written under interval_days = 90, read back under 7.
        let now = 1_700_000_000_000;
        let state = state_at(now + 89 * DAY_MS);
        assert!(needs_rescheduling(&state, now, WEEK_MS));
        // And exactly one interval out is NOT rescheduled — otherwise every
        // schedule this lane writes would be rewritten on the next tick.
        assert!(!needs_rescheduling(&state_at(now + WEEK_MS), now, WEEK_MS));
    }

    #[test]
    fn the_in_memory_gap_floor_holds_even_when_the_schedule_says_due() {
        // The case it exists for: a home the daemon cannot write to. The
        // persisted schedule never advances there, so without this floor the
        // machine would start a fresh 104-second scan on every poll tick.
        let now = 1_700_000_000_000;
        let state = state_at(now - DAY_MS);
        assert_eq!(
            decide(Some(&state), now, WEEK_MS, Some(Duration::from_secs(60))),
            Decision::Wait
        );
        assert_eq!(
            decide(Some(&state), now, WEEK_MS, Some(MIN_ATTEMPT_GAP)),
            Decision::Run
        );
    }

    // ── the child ────────────────────────────────────────────────────────────

    #[test]
    fn the_child_runs_the_scheduled_entry_point_and_its_exit_code_is_reported() {
        // Proves the whole spawn recipe — `sh -c`, piped-and-drained stdio, its
        // own process group, the pre-exec niceness — actually executes and hands
        // back a code the tick can branch on. `printf` stands in for the CLI.
        let shutdown = AtomicBool::new(false);
        let out = scratch("child");
        let marker = out.join("argv");
        // An inner `sh -c … fp` so the appended arguments land as positional
        // parameters it can echo back; the outer shell reports its exit code.
        let cmd = format!(
            "sh -c 'printf \"%s\" \"$*\" > {} ; exit 75' fp",
            marker.display()
        );

        match run_audit_child(&cmd, &shutdown) {
            Outcome::Exited(code) => assert_eq!(code, EXIT_LOCK_HELD),
            _ => panic!("the child should have exited with a code"),
        }
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap(),
            "audit --scheduled",
            "the lane must invoke the headless entry point, never the interactive one"
        );
        std::fs::remove_dir_all(&out).ok();
    }

    #[test]
    fn a_shutdown_kills_a_running_scan_instead_of_orphaning_it() {
        // A restart must not wait out a 104-second scan, and on macOS nothing
        // reaps a child the daemon leaves behind — it would outlive the daemon
        // still holding the audit lock.
        let shutdown = Arc::new(AtomicBool::new(false));
        let flag = shutdown.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            flag.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        // `sleep 60` stands in for a wedged scan; `:` keeps the appended
        // arguments syntactically valid.
        match run_audit_child("sleep 60 ; :", &shutdown) {
            Outcome::Signalled => {}
            _ => panic!("a shutdown mid-scan must end the child"),
        }
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the lane must not wait out the child"
        );
    }

    #[test]
    fn a_command_that_cannot_run_is_reported_rather_than_panicking() {
        // `sh -c` itself always starts, so the failure surfaces as a nonzero
        // exit rather than a spawn error — either way the lane must record it
        // and carry on.
        let shutdown = AtomicBool::new(false);
        match run_audit_child("/nonexistent/failproofai-binary", &shutdown) {
            Outcome::Exited(code) => assert_ne!(code, 0),
            Outcome::NotStarted(_) => {}
            _ => panic!("expected a reportable failure"),
        }
    }

    #[test]
    fn an_empty_cli_command_is_not_a_command() {
        // A `FAILPROOFAI_CLI_CMD=""` in the unit would otherwise run a bare
        // `audit --scheduled` through `sh -c` on every tick, forever.
        assert_eq!(usable_cli_command(None), None);
        assert_eq!(usable_cli_command(Some(String::new())), None);
        assert_eq!(usable_cli_command(Some("   ".into())), None);
        assert_eq!(
            usable_cli_command(Some(" node /opt/dist/cli.mjs ".into())).as_deref(),
            Some("node /opt/dist/cli.mjs")
        );
    }
}
