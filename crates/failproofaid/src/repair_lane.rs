//! Keep this machine's hook configs wired up, without anyone watching.
//!
//! When a vendor changes the SHAPE of its hook config, our installed entry
//! stops being valid and that CLI runs with no enforcement at all — every
//! policy, silently. Five of the incidents on record are that class. On a
//! desktop a person eventually notices; on the headless servers this daemon was
//! built for there is nobody to notice, and a warning in a log nobody opens is
//! indistinguishable from everything working.
//!
//! So the lane repairs rather than warns. What makes that defensible is the
//! failure symmetry, not confidence: unmonitored, NOT repairing means
//! enforcement is silently absent, and repairing BADLY means enforcement is
//! silently absent plus a mangled file. Nobody sees either. The CLI side is
//! therefore built so the worst case of repairing is no worse than not
//! repairing — it backs up, rewrites, verifies by re-running detection, and
//! restores the previous bytes when it does not verify (see
//! `src/hooks/config-repair.ts`).
//!
//! Structurally this is `audit_lane`'s twin and deliberately so: own thread,
//! same shutdown flag, config re-read every tick, every fault swallowed. It
//! spawns the TypeScript CLI rather than reaching into the warm worker, because
//! that socket speaks only `hook`, a committed test fails if anyone adds a
//! second message type, and its 30s cap turns into a machine-wide deny.
//!
//! USER scope only. Project scope needs a session cwd, which this daemon does
//! not have and `PROTOCOL.md` forbids it inventing — that half belongs on the
//! hook path, where a real cwd arrives with every request.

use std::io;
use std::panic::AssertUnwindSafe;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// How often the lane wakes. Config drift arrives with a vendor UPDATE, so the
/// interesting timescale is days; hourly is already far tighter than the event
/// it watches for, and cheap because a clean check spawns nothing at all.
const DEFAULT_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// How long to wait before the FIRST check.
///
/// A daemon start is frequently the middle of a setup, not the end of one:
/// `failproofai config` installs the service and THEN goes on connecting and
/// writing hook entries, so a lane that repaired the instant it started would
/// be reading configs mid-write and "fixing" a machine that was three seconds
/// from being correct. Nothing here is urgent either — config drift arrives
/// with a vendor UPDATE, so the timescale is days.
const FIRST_TICK_DELAY: Duration = Duration::from_secs(5 * 60);

/// Long enough for twelve integrations on a slow disk, short enough that a
/// wedged child cannot hold the lane past the next tick.
const CHILD_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// `doctor`'s contract. 2 is "could not check", which is NOT the same as
/// finding a problem and must not be reported as one.
const EXIT_CANNOT_CHECK: i32 = 2;

enum Outcome {
    Exited(i32),
    Signalled,
    NotStarted(io::Error),
}

#[derive(Default)]
struct Lane {
    /// So a permanent condition — no CLI command in the unit, repair switched
    /// off — is said once rather than every hour for the life of the machine.
    announced: Option<&'static str>,
}

/// Start the repair lane.
///
/// Returns `None` when the OS refused the thread. Deliberately not `.expect()`:
/// this daemon fails closed, so panicking `run()` because a machine hit its
/// thread limit would deny every tool call across all twelve CLIs. Losing
/// scheduled repair is a feature being off; losing the daemon is a machine
/// being unusable.
pub fn spawn(shutdown: Arc<AtomicBool>) -> Option<JoinHandle<()>> {
    std::thread::Builder::new()
        .name("fpai-repair-lane".to_string())
        .spawn(move || {
            let mut lane = Lane::default();
            wait_until_shutdown(&shutdown, FIRST_TICK_DELAY);
            while !shutdown.load(Ordering::Relaxed) {
                // A panic here would end the lane permanently and silently while
                // the machine kept reporting that repair was on — the shape of
                // failure this whole feature exists to remove.
                if std::panic::catch_unwind(AssertUnwindSafe(|| lane.tick(&shutdown))).is_err() {
                    eprintln!("[failproofaid] repair lane panicked; it will try again next tick");
                }
                wait_until_shutdown(&shutdown, DEFAULT_INTERVAL);
            }
        })
        .inspect_err(|err| {
            eprintln!(
                "[failproofaid] could not start the repair lane: {err}; \
                 hook configs will not be checked this run"
            );
        })
        .ok()
}

impl Lane {
    fn tick(&mut self, shutdown: &AtomicBool) {
        // Read every tick rather than at startup: `failproofai config` writes
        // this file WITHOUT root while this is a system unit, so resolving once
        // would put `sudo systemctl restart` back into a flow built to avoid it.
        if !repair_enabled() {
            self.announce("off", "hook-config repair is disabled");
            return;
        }

        // The most likely way this feature is silently inert on a real machine:
        // an install predating `FAILPROOFAI_CLI_CMD` keeps its old unit, so the
        // daemon has no way to launch the CLI while the config says repair is
        // on. `ensureDaemonServiceCurrent()` repairs the unit on the next
        // `failproofai config`.
        let Some(cli_cmd) = cli_command() else {
            self.announce(
                "no-cli",
                "hook-config repair is ON but this service unit carries no FAILPROOFAI_CLI_CMD, \
                 so nothing can run it — re-run `failproofai config` to refresh the unit",
            );
            return;
        };

        self.announced = None;
        match run_child(&cli_cmd, shutdown) {
            // 0 = clean or repaired, 1 = findings a human should see. Both mean
            // the check ran; `doctor` has already said which on stderr.
            Outcome::Exited(0) | Outcome::Exited(1) => {}
            Outcome::Exited(EXIT_CANNOT_CHECK) => {
                eprintln!(
                    "[failproofaid] hook-config repair could not check this machine; \
                     run `failproofai doctor` to see why"
                );
            }
            Outcome::Exited(code) => {
                eprintln!("[failproofaid] hook-config repair exited {code}");
            }
            Outcome::Signalled => {}
            Outcome::NotStarted(err) => {
                eprintln!("[failproofaid] could not run hook-config repair: {err}");
            }
        }
    }

    fn announce(&mut self, key: &'static str, message: &str) {
        if self.announced == Some(key) {
            return;
        }
        self.announced = Some(key);
        eprintln!("[failproofaid] {message}");
    }
}

/// Default ON. The knob exists for operators who would rather their config
/// files were never touched unattended; the default matches the machines this
/// runs on, where nobody is reading warnings.
fn repair_enabled() -> bool {
    let Ok(home) = crate::paths::failproofai_home() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(home.join("config.json")) else {
        return true;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return true;
    };
    value
        .get("hooks")
        .and_then(|h| h.get("auto_repair"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}

fn cli_command() -> Option<String> {
    usable_cli_command(std::env::var("FAILPROOFAI_CLI_CMD").ok())
}

/// Split out so "present but empty" is testable without mutating process-global
/// environment, which Rust's parallel harness makes a race rather than a fixture.
fn usable_cli_command(raw: Option<String>) -> Option<String> {
    raw.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn run_child(cli_cmd: &str, shutdown: &AtomicBool) -> Outcome {
    let mut child = match spawn_child(cli_cmd) {
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
        // Kill rather than orphan: leaving it to the service manager means the
        // daemon's own join() waits out a full repair on every restart, and on
        // macOS nothing reaps it at all.
        if shutdown.load(Ordering::Relaxed) {
            kill_process_group(&mut child);
            return Outcome::Signalled;
        }
        if started.elapsed() > CHILD_TIMEOUT {
            eprintln!(
                "[failproofaid] hook-config repair exceeded {}s; killing it",
                CHILD_TIMEOUT.as_secs()
            );
            kill_process_group(&mut child);
            return Outcome::Signalled;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn spawn_child(cli_cmd: &str) -> io::Result<Child> {
    use std::os::unix::process::CommandExt;

    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(format!("{cli_cmd} doctor --fix --scheduled --user"))
        .stdin(Stdio::null())
        // Piped and drained for the same two reasons the worker's spawn is:
        // inheriting this process's stdout hands the child an fd that may belong
        // to a pipeline, and an undrained pipe fills at ~64 KiB and blocks the
        // child mid-write.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Its own group, so the timeout can kill the whole tree: `sh -c` is not
        // guaranteed to exec(2) in place, and killing only the tracked pid would
        // leave a real repair running against files nobody is watching.
        .process_group(0);

    let mut child = command.spawn()?;
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || forward_child_output("stdout", out));
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || forward_child_output("stderr", err));
    }
    Ok(child)
}

fn forward_child_output(label: &'static str, pipe: impl io::Read) {
    use std::io::BufRead;
    for line in io::BufReader::new(pipe).lines().map_while(Result::ok) {
        eprintln!("[failproofaid] repair {label}: {line}");
    }
}

fn kill_process_group(child: &mut Child) {
    let pgid = child.id() as libc::pid_t;
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
    let _ = child.wait();
}

/// Sleep in slices so a SIGTERM during the hour-long gap is noticed promptly
/// rather than after it.
fn wait_until_shutdown(shutdown: &AtomicBool, total: Duration) {
    let slice = Duration::from_millis(200);
    let mut waited = Duration::ZERO;
    while waited < total {
        if shutdown.load(Ordering::Relaxed) {
            return;
        }
        std::thread::sleep(slice);
        waited += slice;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_or_empty_cli_command_is_not_usable() {
        // Both mean the same thing operationally — the unit cannot launch the
        // CLI — and treating "" as usable would spawn `sh -c " doctor --fix"`.
        assert_eq!(usable_cli_command(None), None);
        assert_eq!(usable_cli_command(Some(String::new())), None);
        assert_eq!(usable_cli_command(Some("   ".to_string())), None);
        assert_eq!(
            usable_cli_command(Some("  /usr/bin/node /x/cli.mjs  ".to_string())),
            Some("/usr/bin/node /x/cli.mjs".to_string())
        );
    }

    #[test]
    fn the_lane_says_a_permanent_condition_once() {
        // Announced every hour, a permanent condition trains people to skip the
        // daemon's log — which is where the interesting lines also live.
        let mut lane = Lane::default();
        lane.announce("off", "first");
        assert_eq!(lane.announced, Some("off"));
        lane.announce("off", "second");
        lane.announce("no-cli", "different condition");
        assert_eq!(lane.announced, Some("no-cli"));
    }

    #[test]
    fn waiting_returns_promptly_once_shutdown_is_set() {
        let flag = AtomicBool::new(true);
        let started = Instant::now();
        wait_until_shutdown(&flag, Duration::from_secs(3600));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
