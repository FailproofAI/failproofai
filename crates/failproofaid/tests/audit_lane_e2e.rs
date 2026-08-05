//! The scheduled audit, against the REAL compiled daemon.
//!
//! Everything in `audit_lane`'s unit tests is a pure function or a lone child
//! process. What they cannot show is the part that actually broke during
//! development and would break again silently: that the lane, running inside the
//! real binary, reads the real `[audit]` table out of a real `config.toml`,
//! consults the schedule at the layout-2 path, persists it BEFORE spawning, and
//! launches the command the service unit hands it in `FAILPROOFAI_CLI_CMD`.
//!
//! A wrong TOML reader, a mistyped key, a path that disagrees with
//! `fp-home.ts`, or a lane nobody wired into `main.rs` all produce the same
//! symptom: nothing happens, ever, while the config says the scan is on. There
//! is no error to assert on — only the absence of a run — so this test asserts
//! the presence of one.

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn binary_path() -> &'static str {
    env!("CARGO_BIN_EXE_failproofaid")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// A never-before-existing home per test. `ensure_run_dir` refuses to adopt a
/// directory it did not create, so a shared one would fail the daemon at startup
/// rather than exercise anything.
fn scratch_home(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "failproofaid-audit-e2e-{}-{name}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct DaemonGuard {
    child: Option<Child>,
    stderr: Arc<Mutex<String>>,
}

impl DaemonGuard {
    fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            child.kill().ok();
            child.wait().ok();
        }
    }
}

/// Start the real daemon against an isolated home, with the audit lane ticking
/// fast enough for a test to watch.
fn spawn_daemon(home: &Path, cli_cmd: &str) -> DaemonGuard {
    let socket = home.join("run").join("failproofaid.sock");
    let mut child = Command::new(binary_path())
        .env("FAILPROOFAI_HOME", home)
        .env("FAILPROOFAI_DAEMON_SOCKET", &socket)
        .env("FAILPROOFAI_CLI_CMD", cli_cmd)
        .env("FAILPROOFAI_AUDIT_POLL_MS", "500")
        // Nothing here connects to the cloud; keep the other lanes quiet so the
        // stderr a failure prints is about the audit.
        .env("FAILPROOFAI_CLOUD_POLICY_RECONCILE_MS", "600000")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn failproofaid");

    let stderr_log = Arc::new(Mutex::new(String::new()));
    if let Some(pipe) = child.stderr.take() {
        let sink = stderr_log.clone();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(pipe).lines().map_while(Result::ok) {
                let mut buf = sink.lock().unwrap();
                buf.push_str(&line);
                buf.push('\n');
            }
        });
    }

    let guard = DaemonGuard {
        child: Some(child),
        stderr: stderr_log,
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !socket.exists() {
        if Instant::now() > deadline {
            panic!("daemon never bound its socket. stderr:\n{}", guard.stderr());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    guard
}

fn wait_for(path: &Path, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn schedule_path(home: &Path) -> PathBuf {
    home.join("state").join("audit-schedule.json")
}

fn write_schedule(home: &Path, body: &str) {
    let path = schedule_path(home);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

fn read_schedule(home: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(schedule_path(home)).unwrap()).unwrap()
}

/// A stand-in for the CLI: records that it ran (with the arguments the lane
/// appended) and exits with `exit_code`.
fn stub_cli(marker: &Path, exit_code: i32) -> String {
    format!(
        "sh -c 'printf \"%s\" \"$*\" > {} ; exit {exit_code}' fp",
        marker.display()
    )
}

#[test]
fn a_due_scan_actually_runs_and_the_schedule_advances() {
    let home = scratch_home("due");
    std::fs::write(
        home.join("config.toml"),
        "[audit]\nauto = true\ninterval_days = 7\n",
    )
    .unwrap();
    // Due an hour ago. Written by hand because seeding one is the OTHER branch:
    // a lane that has never run schedules its first scan an interval out rather
    // than scanning the moment the daemon starts.
    let due = now_ms() - 3_600_000;
    write_schedule(&home, &format!(r#"{{"schema":1,"next_due_at_ms":{due}}}"#));

    let marker = home.join("ran");
    let daemon = spawn_daemon(&home, &stub_cli(&marker, 0));

    assert!(
        wait_for(&marker, Duration::from_secs(20)),
        "the lane never launched the audit. daemon stderr:\n{}",
        daemon.stderr()
    );
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap(),
        "audit --scheduled",
        "the lane must invoke the headless entry point"
    );

    // Give the tick a moment to record the outcome, then assert the schedule
    // moved forward by an interval measured from NOW — not from the missed due
    // time, which is what would give a long-asleep laptop several scans in a row.
    std::thread::sleep(Duration::from_millis(1500));
    let state = read_schedule(&home);
    let next = state["next_due_at_ms"].as_i64().unwrap();
    assert!(
        next > now_ms() + 6 * 86_400_000,
        "next_due_at_ms should be ~7 days out, got {next} at {}",
        now_ms()
    );
    assert!(state["last_attempt_at_ms"].as_i64().unwrap() >= due);
    assert_eq!(state["last_exit_code"].as_i64(), Some(0));
    assert!(
        state["last_run_at_ms"].as_i64().is_some(),
        "a clean exit must record a completed run"
    );

    drop(daemon);
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn auto_off_is_the_default_and_nothing_scans() {
    // The user's decision: the scan reads the CONTENTS of every session
    // transcript on disk, so a config that never mentions [audit] — which is
    // every config written before this feature existed — must scan nothing, even
    // with a schedule sitting past due.
    let home = scratch_home("off");
    std::fs::write(home.join("config.toml"), "[collector]\nhooks = true\n").unwrap();
    let due = now_ms() - 3_600_000;
    write_schedule(&home, &format!(r#"{{"schema":1,"next_due_at_ms":{due}}}"#));

    let marker = home.join("ran");
    let daemon = spawn_daemon(&home, &stub_cli(&marker, 0));

    assert!(
        !wait_for(&marker, Duration::from_secs(4)),
        "an audit ran with auto off. daemon stderr:\n{}",
        daemon.stderr()
    );
    // And the schedule is left exactly as found: an inert lane writes nothing.
    assert_eq!(read_schedule(&home)["next_due_at_ms"].as_i64(), Some(due));

    drop(daemon);
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn a_first_start_schedules_instead_of_scanning_immediately() {
    // The daemon restarts on every upgrade and every boot. If "no schedule yet"
    // meant "scan now", enabling the feature — or any restart on a machine whose
    // state file cannot be kept — would cost a full scan at that moment.
    let home = scratch_home("seed");
    std::fs::write(
        home.join("config.toml"),
        "[audit]\nauto = true\ninterval_days = 7\n",
    )
    .unwrap();

    let marker = home.join("ran");
    let daemon = spawn_daemon(&home, &stub_cli(&marker, 0));

    assert!(
        wait_for(&schedule_path(&home), Duration::from_secs(20)),
        "the lane never wrote a schedule. daemon stderr:\n{}",
        daemon.stderr()
    );
    assert!(!marker.exists(), "nothing should have been scanned");
    let next = read_schedule(&home)["next_due_at_ms"].as_i64().unwrap();
    assert!(
        next > now_ms() + 6 * 86_400_000,
        "the first schedule should be an interval out, got {next}"
    );

    drop(daemon);
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn exit_75_is_retried_soon_and_is_not_recorded_as_a_run() {
    // 75 is EX_TEMPFAIL: `failproofai audit` or the dashboard already holds the
    // cross-process lock. A healthy machine that simply ran two audits close
    // together must not look like a failing one, and must not wait a full
    // interval for the scan it did not get.
    let home = scratch_home("locked");
    std::fs::write(
        home.join("config.toml"),
        "[audit]\nauto = true\ninterval_days = 7\n",
    )
    .unwrap();
    let due = now_ms() - 3_600_000;
    write_schedule(&home, &format!(r#"{{"schema":1,"next_due_at_ms":{due}}}"#));

    let marker = home.join("ran");
    let daemon = spawn_daemon(&home, &stub_cli(&marker, 75));

    assert!(
        wait_for(&marker, Duration::from_secs(20)),
        "the lane never launched the audit. daemon stderr:\n{}",
        daemon.stderr()
    );
    std::thread::sleep(Duration::from_millis(1500));

    let state = read_schedule(&home);
    let next = state["next_due_at_ms"].as_i64().unwrap();
    assert!(
        next < now_ms() + 20 * 60_000,
        "a held lock should be retried at the gap floor, not a full interval later (got {next})"
    );
    assert!(
        next > now_ms(),
        "and not immediately either — the floor is what stops a busy machine spinning"
    );
    assert_eq!(state["last_exit_code"].as_i64(), Some(75));
    assert!(
        state["last_run_at_ms"].is_null(),
        "nothing was scanned, so nothing may be recorded as a run"
    );

    drop(daemon);
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn a_schedule_that_cannot_be_written_is_reported_once_not_once_a_tick() {
    // A home the daemon cannot write a schedule into is PERMANENT — every tick
    // reads no schedule, decides to seed one, and fails again. The floor that
    // rate-limits the scanning branch does not cover this one, so without a
    // transition-only announcement this is a journal line every minute for the
    // life of the daemon, forever, on a machine that is already broken.
    let home = scratch_home("unwritable");
    std::fs::write(
        home.join("config.toml"),
        "[audit]\nauto = true\ninterval_days = 7\n",
    )
    .unwrap();
    // `state` as a regular file: create_dir_all fails with EEXIST, which is the
    // same shape as a read-only mount or a full disk and needs no root to set up.
    std::fs::write(home.join("state"), "not a directory").unwrap();

    let marker = home.join("ran");
    let daemon = spawn_daemon(&home, &stub_cli(&marker, 0));
    // ~16 ticks at the 500ms poll this harness sets.
    std::thread::sleep(Duration::from_secs(8));

    let complaints = daemon
        .stderr()
        .lines()
        .filter(|l| l.contains("its schedule cannot be written"))
        .count();
    assert_eq!(
        complaints,
        1,
        "expected exactly one line over many ticks, got {complaints}. stderr:\n{}",
        daemon.stderr()
    );
    assert!(
        !marker.exists(),
        "a lane that cannot record a schedule must not scan — an unadvanced \
         schedule plus Restart=on-failure is a scan on every restart"
    );

    drop(daemon);
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn a_shutdown_is_not_held_up_by_a_running_scan() {
    // The lane joins on the daemon's shutdown path. If it waited out its child,
    // a `systemctl stop` (or the restart every upgrade performs) would hang for
    // as long as the scan — and on a fail-closed machine a daemon that is slow
    // to come back is a machine denying tool calls.
    let home = scratch_home("shutdown");
    std::fs::write(
        home.join("config.toml"),
        "[audit]\nauto = true\ninterval_days = 7\n",
    )
    .unwrap();
    let due = now_ms() - 3_600_000;
    write_schedule(&home, &format!(r#"{{"schema":1,"next_due_at_ms":{due}}}"#));

    let marker = home.join("ran");
    // Records that it started, then hangs the way a wedged scan would.
    let cli = format!(
        "sh -c 'printf \"%s\" \"$*\" > {} ; sleep 300' fp",
        marker.display()
    );
    let mut daemon = spawn_daemon(&home, &cli);
    assert!(
        wait_for(&marker, Duration::from_secs(20)),
        "the lane never launched the audit. daemon stderr:\n{}",
        daemon.stderr()
    );

    let mut child = daemon.child.take().expect("daemon still running");
    let started = Instant::now();
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let status = child.wait().expect("daemon should exit after SIGTERM");
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "shutdown waited {:?} on the scan. stderr:\n{}",
        started.elapsed(),
        daemon.stderr()
    );
    assert!(
        status.success(),
        "daemon should exit 0 on SIGTERM: {status:?}"
    );

    std::fs::remove_dir_all(&home).ok();
}
