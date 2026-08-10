//! Black-box tests that spawn the real compiled `failproofaid` binary as a
//! subprocess and talk to it over a real Unix socket — closer to how the
//! installed systemd unit / launchd daemon invokes it than the
//! in-process unit tests in `src/server.rs` are.

use fpai_ipc::{ClientMessage, PROTOCOL_VERSION, ServerMessage, read_message, write_message};
use std::io::BufRead;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn binary_path() -> &'static str {
    env!("CARGO_BIN_EXE_failproofaid")
}

/// A dedicated, never-before-existing run directory per test — mirroring a
/// real deployment, where `~/.failproofai/run` is always failproofaid's own
/// directory that it creates itself. `ensure_run_dir` (see `src/paths.rs`)
/// deliberately refuses to chmod a pre-existing directory it didn't create,
/// so reusing a shared directory like the bare system temp dir here would
/// make every test in this file fail with a permissions error instead of
/// exercising the daemon at all.
fn unique_socket_path(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir()
        .join(format!(
            "failproofaid-e2e-{}-{}-{}",
            std::process::id(),
            name,
            nanos
        ))
        .join("failproofaid.sock")
}

/// A scratch failproofai home for a spawned daemon, beside its socket.
///
/// `FAILPROOFAI_DAEMON_SOCKET` relocates only `run/`; everything else the
/// daemon reads and writes — `config.json`, `state/` — still resolves from
/// `$HOME`. So without this, these tests ran the real binary against the
/// developer's own `~/.failproofai`: it would read their real telemetry
/// opt-out, write their real `state/daemon-run.json`, and POST a
/// `daemon_started` to the REAL PostHog endpoint on every `cargo test` and every
/// CI run. Found the moment the telemetry lane landed, by noticing files with a
/// fresh mtime in a home no test names.
fn scratch_home(socket_path: &std::path::Path) -> PathBuf {
    socket_path
        .parent()
        .expect("the socket path always has a parent")
        .join("home")
}

/// Owns a spawned daemon subprocess and guarantees it is killed and reaped
/// on scope exit — including during an unwind from a failed assertion.
/// Without this, any panic between `spawn_daemon` and a test's explicit
/// SIGTERM orphaned a live daemon (and the worker process group under it)
/// for the rest of the machine's uptime.
struct DaemonGuard {
    child: Option<Child>,
    /// Everything the daemon has written to stderr so far, drained
    /// continuously on a background thread. Drained rather than merely
    /// piped: an unread pipe fills at ~64 KiB and blocks the daemon
    /// mid-write, hanging these tests. Kept so a failure can report what
    /// the daemon itself said, which is the part actually worth reading.
    stderr: Arc<Mutex<String>>,
}

impl DaemonGuard {
    fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    /// SIGTERM, then wait — the clean-shutdown path a systemd `stop` /
    /// launchd unload takes. Consumes the child, so `Drop` becomes a no-op.
    fn terminate(&mut self) -> ExitStatus {
        let mut child = self.child.take().expect("daemon already reaped");
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        child.wait().expect("daemon should exit after SIGTERM")
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

fn spawn_daemon(socket_path: &PathBuf) -> DaemonGuard {
    let mut child = Command::new(binary_path())
        .env("FAILPROOFAI_DAEMON_SOCKET", socket_path)
        .env("FAILPROOFAI_HOME", scratch_home(socket_path))
        // Never report from a test. The scratch home above keeps the daemon out
        // of the developer's real `~/.failproofai`, but a home with no
        // config.json resolves telemetry to its shipped default — ON — so
        // without this every `cargo test` and every CI run would POST a real
        // `daemon_started` to the real PostHog endpoint.
        .env("FAILPROOFAI_TELEMETRY_DISABLED", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn failproofaid binary");

    let stderr_log = Arc::new(Mutex::new(String::new()));
    if let Some(pipe) = child.stderr.take() {
        let sink = stderr_log.clone();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(pipe).lines().map_while(Result::ok) {
                sink.lock().unwrap().push_str(&line);
                sink.lock().unwrap().push('\n');
            }
        });
    }
    let mut guard = DaemonGuard {
        child: Some(child),
        stderr: stderr_log,
    };

    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket_path.exists() {
        // A daemon that died during startup should report *why* rather than
        // burn the full deadline and then panic with no diagnosis.
        if let Some(status) = guard
            .child
            .as_mut()
            .expect("daemon still owned here")
            .try_wait()
            .expect("try_wait should not fail")
        {
            panic!(
                "daemon exited before creating its socket ({status}). stderr:\n{}",
                guard.stderr()
            );
        }
        if Instant::now() > deadline {
            panic!(
                "daemon never created its socket file within 5s. stderr:\n{}",
                guard.stderr()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    guard
}

#[test]
fn version_flag_prints_a_version_and_exits_without_binding_a_socket() {
    let output = Command::new(binary_path())
        .arg("--version")
        .output()
        .expect("failed to run --version");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.starts_with("failproofaid "), "got: {stdout:?}");
}

#[test]
fn real_binary_answers_ping_over_a_real_socket() {
    let socket_path = unique_socket_path("ping");
    let mut daemon = spawn_daemon(&socket_path);

    let mut stream = UnixStream::connect(&socket_path).expect("connect should succeed");
    write_message(
        &mut stream,
        &ClientMessage::Ping {
            protocol_version: PROTOCOL_VERSION,
        },
    )
    .unwrap();
    let response: ServerMessage = read_message(&mut stream).unwrap();
    assert_eq!(
        response,
        ServerMessage::Pong {
            protocol_version: PROTOCOL_VERSION
        }
    );

    let status = daemon.terminate();
    assert!(
        status.success(),
        "daemon should exit 0 on SIGTERM, got {status:?}"
    );
    assert!(
        !socket_path.exists(),
        "daemon should remove its socket file on clean shutdown"
    );
}

#[test]
fn a_second_daemon_on_the_same_socket_refuses_to_start() {
    let socket_path = unique_socket_path("singleton");
    let mut first = spawn_daemon(&socket_path);

    let second_output = Command::new(binary_path())
        .env("FAILPROOFAI_DAEMON_SOCKET", &socket_path)
        .env("FAILPROOFAI_HOME", scratch_home(&socket_path))
        .env("FAILPROOFAI_TELEMETRY_DISABLED", "1")
        .output()
        .expect("failed to run second instance");
    assert!(
        !second_output.status.success(),
        "a second daemon on the same socket must not exit 0"
    );
    let stderr = String::from_utf8_lossy(&second_output.stderr);
    assert!(
        stderr.contains("already running"),
        "expected an 'already running' message, got: {stderr:?}"
    );

    // First instance is still healthy and answers requests after the
    // second one's failed startup attempt.
    let mut stream = UnixStream::connect(&socket_path).unwrap();
    write_message(
        &mut stream,
        &ClientMessage::Ping {
            protocol_version: PROTOCOL_VERSION,
        },
    )
    .unwrap();
    let response: ServerMessage = read_message(&mut stream).unwrap();
    assert_eq!(
        response,
        ServerMessage::Pong {
            protocol_version: PROTOCOL_VERSION
        }
    );

    first.terminate();
}

#[test]
fn a_fresh_daemon_can_bind_again_after_the_previous_one_shut_down_cleanly() {
    let socket_path = unique_socket_path("restart");

    let mut first = spawn_daemon(&socket_path);
    let status = first.terminate();
    assert!(status.success());

    // The lock is released by the kernel when the process exits, so a
    // fresh daemon must be able to acquire it and bind immediately.
    let mut second = spawn_daemon(&socket_path);
    let mut stream = UnixStream::connect(&socket_path).unwrap();
    write_message(
        &mut stream,
        &ClientMessage::Ping {
            protocol_version: PROTOCOL_VERSION,
        },
    )
    .unwrap();
    let response: ServerMessage = read_message(&mut stream).unwrap();
    assert_eq!(
        response,
        ServerMessage::Pong {
            protocol_version: PROTOCOL_VERSION
        }
    );

    second.terminate();
}

/// Run the daemon against `home` and require that it EXITS, within a deadline.
///
/// A plain `Command::output()` would be simpler and is the wrong tool: if the
/// layout gate is ever removed, the daemon starts and serves normally, so
/// `output()` waits on a process that never ends and the test HANGS instead of
/// failing. Verified by deleting the gate — the suite wedged rather than going
/// red, which is the worse of the two failures for anything that runs in CI.
fn run_expecting_refusal(home: &std::path::Path) -> (ExitStatus, String) {
    let mut child = Command::new(binary_path())
        .env("FAILPROOFAI_HOME", home)
        .env_remove("FAILPROOFAI_DAEMON_SOCKET")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn the daemon");

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait().expect("try_wait") {
            Some(status) => {
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    use std::io::Read;
                    let _ = pipe.read_to_string(&mut stderr);
                }
                return (status, stderr);
            }
            None if Instant::now() >= deadline => {
                child.kill().ok();
                child.wait().ok();
                panic!(
                    "the daemon was still running after 10s — it SERVED a foreign layout \
                     instead of refusing it. The layout gate is gone or not reached."
                );
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

/// The real binary refuses to start against a home written by a layout it does
/// not speak, rather than reading and writing paths that moved.
///
/// The skew is ordinary rather than exotic: `npm i -g` replaces the CLI while the
/// binary under `~/.failproofai/bin/failproofaid-<version>` stays exactly where it
/// was, which is why `daemonVersionSkew()` exists on the CLI side at all. Before
/// this gate a daemon in that state read layout-3 paths in a layout-4 home and
/// said nothing — the daemon writing where nothing reads, which is the failure
/// `fp-home.ts` was created to end.
#[test]
fn real_binary_refuses_a_newer_layout_and_names_the_remedy() {
    let home = std::env::temp_dir().join(format!("fpaid-layout-future-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("temp home");
    std::fs::write(
        home.join("VERSION"),
        "{\"layout\": 99, \"cli\": \"9.9.9\"}\n",
    )
    .expect("write marker");

    let (status, stderr) = run_expecting_refusal(&home);

    assert!(
        !status.success(),
        "a foreign layout must be refused, not served"
    );
    assert!(stderr.contains("layout 99"), "got: {stderr}");
    // The remedy differs by direction, and a NEWER home means this binary is the
    // stale half — so the message must point at the update, not at a migration.
    assert!(stderr.contains("failproofai update"), "got: {stderr}");
    // Nothing was bound: refusing happens before the socket and before the lock.
    assert!(!home.join("run").join("failproofaid.sock").exists());

    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn real_binary_refuses_an_older_layout_and_points_at_the_migration() {
    let home = std::env::temp_dir().join(format!("fpaid-layout-stale-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("temp home");
    // Layout 2's marker was TOML, and it has to parse here: refusing to start on a
    // home that is merely OLD is the one case the CLI is about to fix by migrating
    // it, and a daemon that could not read the old format would report the wrong
    // remedy for the commonest upgrade there is.
    std::fs::write(home.join("VERSION"), "layout = 2\ncli = \"1.0.0-beta.5\"\n")
        .expect("write marker");

    let (status, stderr) = run_expecting_refusal(&home);

    assert!(!status.success());
    assert!(stderr.contains("layout 2"), "got: {stderr}");
    assert!(stderr.contains("migrate"), "got: {stderr}");

    let _ = std::fs::remove_dir_all(&home);
}

/// A home with NO marker starts normally. A fresh one has none until the first
/// CLI command stamps it, so refusing there would break the install itself.
#[test]
fn real_binary_starts_against_a_home_with_no_marker() {
    let socket_path = unique_socket_path("no-marker");
    let mut daemon = spawn_daemon(&socket_path);

    let mut stream = UnixStream::connect(&socket_path).expect("connect should succeed");
    write_message(
        &mut stream,
        &ClientMessage::Ping {
            protocol_version: PROTOCOL_VERSION,
        },
    )
    .expect("write ping");
    let reply: ServerMessage = read_message(&mut stream).expect("read pong");
    assert!(matches!(reply, ServerMessage::Pong { .. }), "got {reply:?}");
    drop(stream);
    daemon.terminate();
}
