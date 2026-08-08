//! Daemon telemetry, against the REAL compiled binary and a REAL HTTP server.
//!
//! The module's unit tests cover pure functions and the transport in isolation.
//! What they cannot show is the thing that has to be true before any of it
//! matters: that a daemon which was told not to report makes **zero** requests,
//! and that one which was not actually makes them.
//!
//! Both failures are silent from inside the process. A lane nobody wired into
//! `main.rs`, a gate resolved against the wrong file, an event recorded before
//! the buffer exists — every one of them looks exactly like "telemetry is off",
//! and an opt-out that does not hold looks exactly like one that does. So these
//! run the binary and count what arrives on a socket.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn binary_path() -> &'static str {
    env!("CARGO_BIN_EXE_failproofaid")
}

/// A never-before-existing home per test. `ensure_run_dir` refuses to adopt a
/// directory it did not create, so a shared one would fail the daemon at startup
/// rather than exercise anything.
fn scratch_home(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "failproofaid-telemetry-e2e-{}-{name}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// ── A minimal PostHog stand-in ───────────────────────────────────────────────

/// Records every request body it is handed and answers 200.
///
/// Deliberately not wiremock here: this collector has to outlive the test
/// function's own runtime and be readable from a plain blocking loop while a
/// separate process posts into it, and a hand-rolled listener is both shorter
/// and easier to reason about than driving an async server across that boundary.
struct Collector {
    base_url: String,
    bodies: Arc<Mutex<Vec<String>>>,
}

impl Collector {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let sink = bodies.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let sink = sink.clone();
                std::thread::spawn(move || serve_one(stream, sink));
            }
        });
        Collector { base_url, bodies }
    }

    fn bodies(&self) -> Vec<String> {
        self.bodies.lock().unwrap().clone()
    }

    /// Every event name delivered so far, across every batch.
    fn events(&self) -> Vec<String> {
        self.bodies()
            .iter()
            .filter_map(|body| serde_json::from_str::<serde_json::Value>(body).ok())
            .flat_map(|body| {
                body["batch"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
            })
            .filter_map(|entry| entry["event"].as_str().map(str::to_string))
            .collect()
    }

    fn wait_for_event(&self, name: &str, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if self.events().iter().any(|e| e == name) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// The first delivered entry for `name`, for asserting on its properties.
    fn entry(&self, name: &str) -> Option<serde_json::Value> {
        self.bodies()
            .iter()
            .filter_map(|body| serde_json::from_str::<serde_json::Value>(body).ok())
            .flat_map(|body| {
                body["batch"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
            })
            .find(|entry| entry["event"].as_str() == Some(name))
    }
}

fn serve_one(mut stream: TcpStream, sink: Arc<Mutex<Vec<String>>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; content_length];
    if reader.read_exact(&mut body).is_ok() {
        sink.lock()
            .unwrap()
            .push(String::from_utf8_lossy(&body).to_string());
    }
    let _ =
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
}

// ── The daemon ───────────────────────────────────────────────────────────────

struct DaemonGuard {
    child: Option<Child>,
    stderr: Arc<Mutex<String>>,
}

impl DaemonGuard {
    fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    fn pid(&self) -> i32 {
        self.child.as_ref().unwrap().id() as i32
    }

    /// SIGTERM and wait — the ordinary `systemctl stop`, and the path that has
    /// to flush `daemon_stopped` before the process is gone.
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            child.kill().ok();
            child.wait().ok();
        }
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

/// Start the real daemon against an isolated home, pointed at a local collector.
fn spawn_daemon(home: &Path, collector: &Collector, extra_env: &[(&str, &str)]) -> DaemonGuard {
    let socket = home.join("run").join("failproofaid.sock");
    let mut command = Command::new(binary_path());
    command
        .env("FAILPROOFAI_HOME", home)
        .env("FAILPROOFAI_DAEMON_SOCKET", &socket)
        .env("FAILPROOFAI_POSTHOG_HOST", &collector.base_url)
        .env("FAILPROOFAI_POSTHOG_KEY", "phc_e2e")
        .env("FAILPROOFAI_TELEMETRY_FLUSH_MS", "200")
        // A worker that exits before binding: deterministic, needs no node or
        // bun on PATH, and produces the `exited_early` outcome quickly instead
        // of waiting out the five-second startup deadline.
        .env("FAILPROOFAI_WORKER_CMD", "exit 0")
        // Nothing here connects to a cloud; keep the other lanes quiet so a
        // failure's stderr is about telemetry.
        .env("FAILPROOFAI_CLOUD_POLICY_RECONCILE_MS", "600000")
        .env("FAILPROOFAI_AUDIT_POLL_MS", "600000")
        // Explicitly cleared unless a test sets it: a stray export in the
        // developer's own shell would otherwise silence the daemon and make the
        // "reports" tests fail for a reason nothing on screen explains.
        .env_remove("FAILPROOFAI_TELEMETRY_DISABLED")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for (key, value) in extra_env {
        command.env(key, value);
    }
    let mut child = command.spawn().expect("failed to spawn failproofaid");

    let stderr_log = Arc::new(Mutex::new(String::new()));
    if let Some(pipe) = child.stderr.take() {
        let sink = stderr_log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
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

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn no_test_in_this_crate_can_report_to_the_real_posthog() {
    // The tripwire for a mistake this step actually made. `FAILPROOFAI_DAEMON_SOCKET`
    // relocates only `run/`, so a daemon spawned without `FAILPROOFAI_HOME`
    // reads the developer's real config.json — where telemetry resolves to its
    // shipped default, ON — and posts `daemon_started` to the real endpoint from
    // `cargo test` and from CI. It is silent from inside the test: everything
    // passes, and the only evidence is events arriving in production from a
    // machine nobody was using.
    //
    // Grep-based on purpose, because the failure is a file that does not exist
    // yet. A new e2e here must either switch telemetry off or point the host at
    // something local, and this fails until it does one of the two.
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let source = std::fs::read_to_string(&path).unwrap();
        if !source.contains("CARGO_BIN_EXE_failproofaid") {
            continue;
        }
        checked += 1;
        assert!(
            source.contains("FAILPROOFAI_TELEMETRY_DISABLED")
                || source.contains("FAILPROOFAI_POSTHOG_HOST"),
            "{} spawns the real daemon without disabling telemetry or redirecting \
             the endpoint, so running it reports to production",
            path.display()
        );
    }
    assert!(
        checked >= 3,
        "expected to find the e2e files, saw {checked}"
    );
}

#[test]
fn a_real_daemon_reports_its_lifecycle_to_the_batch_endpoint() {
    let home = scratch_home("lifecycle");
    // No telemetry object at all — the shape of a default install, and the one
    // that has to read as ON or the shipped default is unreachable.
    std::fs::write(
        home.join("config.json"),
        r#"{"mode":{"kind":"oss"},"collector":{"machine_id":"m-e2e"}}"#,
    )
    .unwrap();
    let collector = Collector::start();
    let mut daemon = spawn_daemon(&home, &collector, &[]);

    assert!(
        collector.wait_for_event("daemon_started", Duration::from_secs(10)),
        "no daemon_started arrived. stderr:\n{}",
        daemon.stderr()
    );
    // The worker is on the hook path, so its supervision is the part of this
    // that most needs to be visible from outside the machine.
    assert!(
        collector.wait_for_event("daemon_worker_spawned", Duration::from_secs(10)),
        "no daemon_worker_spawned arrived. stderr:\n{}",
        daemon.stderr()
    );

    let started = collector.entry("daemon_started").unwrap();
    let props = &started["properties"];
    assert_eq!(props["$lib"], serde_json::json!("failproofai-daemon"));
    assert_eq!(props["product"], serde_json::json!("failproofai-oss"));
    assert_eq!(props["machine_id"], serde_json::json!("m-e2e"));
    // Never run before in this home, and reported as such rather than as a
    // crash — the direction that matters, since an unwritable state directory
    // would otherwise report every start as one.
    assert_eq!(props["previous_exit"], serde_json::json!("first_start"));
    assert!(
        started["distinct_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );

    let worker = collector.entry("daemon_worker_spawned").unwrap();
    assert_eq!(worker["properties"]["reason"], serde_json::json!("initial"));
    assert_eq!(
        worker["properties"]["outcome"],
        serde_json::json!("exited_early")
    );

    // The privacy envelope, checked against what actually went over the wire.
    // The home path and the worker command are both things this daemon knows and
    // must never send; a `format!("{err}")` slipped into a property is exactly
    // how one of them would end up there.
    let wire = collector.bodies().join("\n");
    assert!(
        !wire.contains(home.to_str().unwrap()),
        "a filesystem path reached the wire:\n{wire}"
    );
    assert!(
        !wire.contains("exit 0"),
        "the worker command reached the wire:\n{wire}"
    );

    daemon.stop();
    assert!(
        collector.wait_for_event("daemon_stopped", Duration::from_secs(10)),
        "a stopping daemon must flush its last events. stderr:\n{}",
        daemon.stderr()
    );
    let stopped = collector.entry("daemon_stopped").unwrap();
    assert_eq!(stopped["properties"]["reason"], serde_json::json!("signal"));
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn the_config_file_opt_out_makes_the_daemon_completely_silent() {
    // The whole reason `telemetry.enabled` exists: this is a system-scope
    // service unit whose environment carries essentially nothing, so the file is
    // the ONLY switch that can reach it. If this test can be made to pass by a
    // daemon that sends one request, the opt-out does not exist.
    let home = scratch_home("opt-out-file");
    std::fs::write(
        home.join("config.json"),
        r#"{"mode":{"kind":"oss"},"telemetry":{"enabled":false}}"#,
    )
    .unwrap();
    let collector = Collector::start();
    let mut daemon = spawn_daemon(&home, &collector, &[]);

    // Long enough for ~15 flush ticks at 200ms, well past the start, the worker
    // spawn and several lane wakeups.
    std::thread::sleep(Duration::from_secs(3));
    daemon.stop();
    // Including the shutdown flush, which runs after the lane thread has joined
    // and is the one send that does not go through the lane's own gate check.
    std::thread::sleep(Duration::from_millis(500));

    assert_eq!(
        collector.bodies(),
        Vec::<String>::new(),
        "a daemon told not to report made a request. stderr:\n{}",
        daemon.stderr()
    );
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn the_environment_opt_out_also_makes_the_daemon_silent() {
    // The env half is kept because people already rely on it, and it must be
    // able to switch OFF a file that says on — the more-restrictive rule.
    let home = scratch_home("opt-out-env");
    std::fs::write(
        home.join("config.json"),
        r#"{"mode":{"kind":"oss"},"telemetry":{"enabled":true}}"#,
    )
    .unwrap();
    let collector = Collector::start();
    let mut daemon = spawn_daemon(
        &home,
        &collector,
        &[("FAILPROOFAI_TELEMETRY_DISABLED", "1")],
    );

    std::thread::sleep(Duration::from_secs(3));
    daemon.stop();
    std::thread::sleep(Duration::from_millis(500));

    assert_eq!(
        collector.bodies(),
        Vec::<String>::new(),
        "the environment must be able to switch off a file that says on. stderr:\n{}",
        daemon.stderr()
    );
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn switching_the_opt_out_off_mid_run_stops_the_reporting_without_a_restart() {
    // `failproofai config` writes config.json WITHOUT root while this is a
    // system unit, so an opt-out that only took effect on restart would need a
    // `sudo systemctl restart` to hold — which is exactly the flow the file
    // exists to avoid. Anything memoised for the life of the process fails here.
    let home = scratch_home("opt-out-live");
    std::fs::write(home.join("config.json"), "[mode]\nkind = \"oss\"\n").unwrap();
    let collector = Collector::start();
    let mut daemon = spawn_daemon(&home, &collector, &[]);
    assert!(
        collector.wait_for_event("daemon_started", Duration::from_secs(10)),
        "premise: it reports before the switch. stderr:\n{}",
        daemon.stderr()
    );

    std::fs::write(
        home.join("config.json"),
        r#"{"mode":{"kind":"oss"},"telemetry":{"enabled":false}}"#,
    )
    .unwrap();
    // One tick to notice, then a settling window.
    std::thread::sleep(Duration::from_secs(1));
    let before = collector.bodies().len();
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(
        collector.bodies().len(),
        before,
        "the daemon kept reporting after the file said stop. stderr:\n{}",
        daemon.stderr()
    );

    // And the stop event does not slip out either: `shutdown_flush` re-resolves
    // the gate from disk rather than trusting the cached one.
    daemon.stop();
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(collector.bodies().len(), before);
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn a_daemon_that_was_killed_says_so_on_its_next_start() {
    // The one signal here worth alerting on, and it is invisible everywhere
    // else: systemd restarts the unit and the next log line reads like an
    // ordinary start. On a fail-closed machine the window between the two is
    // every tool call denied.
    let home = scratch_home("unclean");
    std::fs::write(home.join("config.json"), "[mode]\nkind = \"oss\"\n").unwrap();
    let first = Collector::start();
    let daemon = spawn_daemon(&home, &first, &[]);
    assert!(
        first.wait_for_event("daemon_started", Duration::from_secs(10)),
        "stderr:\n{}",
        daemon.stderr()
    );
    // SIGKILL: no handler runs, no marker is flipped — a crash, an OOM kill or a
    // power cut, which are the same thing from here.
    unsafe { libc::kill(daemon.pid(), libc::SIGKILL) };
    drop(daemon);

    let second = Collector::start();
    let mut restarted = spawn_daemon(&home, &second, &[]);
    assert!(
        second.wait_for_event("daemon_started", Duration::from_secs(10)),
        "stderr:\n{}",
        restarted.stderr()
    );
    assert_eq!(
        second.entry("daemon_started").unwrap()["properties"]["previous_exit"],
        serde_json::json!("unclean")
    );
    restarted.stop();

    // And a clean stop is reported as one, so "unclean" means something.
    let third = Collector::start();
    let mut again = spawn_daemon(&home, &third, &[]);
    assert!(
        third.wait_for_event("daemon_started", Duration::from_secs(10)),
        "stderr:\n{}",
        again.stderr()
    );
    assert_eq!(
        third.entry("daemon_started").unwrap()["properties"]["previous_exit"],
        serde_json::json!("clean")
    );
    again.stop();
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn a_daemon_that_cannot_bind_its_socket_still_says_so_before_it_dies() {
    // The most interesting failure this daemon has, and the easiest one to lose:
    // on a `daemonConfigured` machine a socket nothing is listening on is every
    // tool call across all 12 CLIs denied, in a `Restart=on-failure` loop. A
    // bare `?` on the bind returns past every join in `run()`, including the
    // telemetry flush — so `daemon_started` would be buffered and then taken to
    // the grave. Found by running the real binary, not by reading it.
    let home = scratch_home("bind-failure");
    std::fs::write(home.join("config.json"), "[mode]\nkind = \"oss\"\n").unwrap();
    let collector = Collector::start();

    // A `sockaddr_un.sun_path` is ~108 bytes on Linux and 104 on macOS, so this
    // fails the bind deterministically on both without needing a port conflict.
    let too_long = home.join("run").join(format!("{}.sock", "x".repeat(160)));
    let status = Command::new(binary_path())
        .env("FAILPROOFAI_HOME", &home)
        .env("FAILPROOFAI_DAEMON_SOCKET", &too_long)
        .env("FAILPROOFAI_POSTHOG_HOST", &collector.base_url)
        .env("FAILPROOFAI_POSTHOG_KEY", "phc_e2e")
        .env("FAILPROOFAI_TELEMETRY_FLUSH_MS", "200")
        .env("FAILPROOFAI_WORKER_CMD", "exit 0")
        .env("FAILPROOFAI_CLOUD_POLICY_RECONCILE_MS", "600000")
        .env("FAILPROOFAI_AUDIT_POLL_MS", "600000")
        .env_remove("FAILPROOFAI_TELEMETRY_DISABLED")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("failed to spawn failproofaid");
    assert!(!status.success(), "premise: the bind must fail");

    let events = collector.events();
    assert!(
        events.iter().any(|e| e == "daemon_started"),
        "the start was buffered and never delivered: {events:?}"
    );
    assert_eq!(
        collector
            .entry("daemon_stopped")
            .map(|e| e["properties"]["reason"].clone()),
        Some(serde_json::json!("bind_failed")),
        "the reason the daemon died has to reach the wire: {events:?}"
    );
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn the_id_the_cli_resolved_is_the_one_the_daemon_reports_under() {
    // A daemon reporting under a different id than the CLI does not fail — it
    // files one machine as two PostHog persons, and nothing in the data says so.
    let home = scratch_home("identity");
    std::fs::write(home.join("config.json"), "[mode]\nkind = \"oss\"\n").unwrap();
    std::fs::create_dir_all(home.join("state")).unwrap();
    std::fs::write(home.join("state").join("telemetry-id"), "cli-resolved-id").unwrap();

    let collector = Collector::start();
    let mut daemon = spawn_daemon(&home, &collector, &[]);
    assert!(
        collector.wait_for_event("daemon_started", Duration::from_secs(10)),
        "stderr:\n{}",
        daemon.stderr()
    );
    let started = collector.entry("daemon_started").unwrap();
    assert_eq!(
        started["distinct_id"],
        serde_json::json!("cli-resolved-id"),
        "the daemon must read the id from the path fp-home.ts writes it to"
    );
    assert_eq!(started["properties"]["id_source"], serde_json::json!("cli"));
    daemon.stop();
    std::fs::remove_dir_all(&home).ok();
}
