//! Black-box tests that spawn the real compiled `failproofaid` binary as a
//! subprocess and talk to it over a real Unix socket — closer to how a
//! systemd unit / launchd agent will actually invoke it (Stage 4) than the
//! in-process unit tests in `src/server.rs` are.

use fpai_ipc::{ClientMessage, PROTOCOL_VERSION, ServerMessage, read_message, write_message};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
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

fn spawn_daemon(socket_path: &PathBuf) -> Child {
    let child = Command::new(binary_path())
        .env("FAILPROOFAI_DAEMON_SOCKET", socket_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn failproofaid binary");

    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket_path.exists() {
        if Instant::now() > deadline {
            panic!("daemon never created its socket file within 5s");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    child
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
    let mut child = spawn_daemon(&socket_path);

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

    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let status = child.wait().expect("daemon should exit after SIGTERM");
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

    unsafe {
        libc::kill(first.id() as libc::pid_t, libc::SIGTERM);
    }
    first.wait().ok();
}

#[test]
fn a_fresh_daemon_can_bind_again_after_the_previous_one_shut_down_cleanly() {
    let socket_path = unique_socket_path("restart");

    let mut first = spawn_daemon(&socket_path);
    unsafe {
        libc::kill(first.id() as libc::pid_t, libc::SIGTERM);
    }
    let status = first.wait().unwrap();
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

    unsafe {
        libc::kill(second.id() as libc::pid_t, libc::SIGTERM);
    }
    second.wait().ok();
}
