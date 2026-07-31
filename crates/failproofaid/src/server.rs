//! The Unix-socket server: bind, accept, verify the peer, dispatch one
//! request per connection.
//!
//! `Hook` requests are relayed to the warm worker (see `worker.rs`); `Ping`
//! is answered directly. Any failure to reach/use the worker becomes a
//! client-facing `Error` response — never a hang, never a crash of the
//! connection-handling thread.

use crate::worker::Worker;
use fpai_ipc::{ClientMessage, PROTOCOL_VERSION, ServerMessage, peer, read_message, write_message};
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

/// Bounds how long a single connection may hold its handler thread waiting
/// on the peer. A client that connects and then sends nothing would
/// otherwise park a thread for the daemon's entire lifetime, and those
/// accumulate — the opposite of the "never a hang" promise above. Generous
/// for a real client (which writes its request immediately after connect,
/// over a local socket) and still bounded.
const CONNECTION_IO_TIMEOUT: Duration = Duration::from_secs(10);

/// Hard ceiling on connection-handling threads alive at once. The worker
/// serializes evaluation anyway, so more than a handful in flight already
/// means the daemon is badly backed up; refusing past this point turns
/// "spawn threads until the process dies" into a bounded, logged overload
/// that the client sees as an unreachable daemon (i.e. its own fail-closed
/// path), which is the correct outcome for a daemon in that state.
const MAX_INFLIGHT_CONNECTIONS: usize = 64;

pub struct Server {
    listener: UnixListener,
    socket_path: PathBuf,
    worker: Arc<Worker>,
}

/// Decrements the in-flight connection count on scope exit, including
/// during an unwind — a leaked count would permanently shrink the budget in
/// [`MAX_INFLIGHT_CONNECTIONS`] and eventually wedge the daemon.
struct InflightGuard(Arc<AtomicUsize>);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Server {
    /// Binds a fresh listener at `socket_path`, replacing a stale socket
    /// file left behind by a process that didn't shut down cleanly (a live
    /// daemon is never listening on a leftover file — the singleton lock in
    /// `lock.rs` is what actually prevents two daemons; this only clears
    /// the debris of one that's already gone).
    pub fn bind(socket_path: &Path, worker: Arc<Worker>) -> io::Result<Self> {
        if socket_path.exists() {
            fs::remove_file(socket_path)?;
        }
        let listener = UnixListener::bind(socket_path)?;
        fs::set_permissions(socket_path, fs::Permissions::from_mode(0o600))?;
        Ok(Server {
            listener,
            socket_path: socket_path.to_path_buf(),
            worker,
        })
    }

    /// Accepts and handles connections, one thread per connection, until
    /// `shutdown` is set to `true`. A short accept timeout keeps the loop
    /// polling `shutdown` instead of blocking forever in `accept()`, which
    /// is what lets tests stop a server cleanly instead of leaking a
    /// blocked thread for the rest of the test process's life.
    pub fn run_until(&self, shutdown: Arc<AtomicBool>) -> io::Result<()> {
        self.listener.set_nonblocking(true)?;
        let inflight = Arc::new(AtomicUsize::new(0));
        while !shutdown.load(Ordering::Relaxed) {
            match self.listener.accept() {
                Ok((stream, _addr)) => {
                    if inflight.load(Ordering::Relaxed) >= MAX_INFLIGHT_CONNECTIONS {
                        log_connection_error(&io::Error::other(format!(
                            "refusing connection: {MAX_INFLIGHT_CONNECTIONS} handlers already in flight"
                        )));
                        drop(stream);
                        continue;
                    }
                    inflight.fetch_add(1, Ordering::Relaxed);
                    let guard = InflightGuard(inflight.clone());
                    let worker = self.worker.clone();
                    std::thread::spawn(move || {
                        let _guard = guard;
                        if let Err(err) = handle_connection(stream, &worker) {
                            log_connection_error(&err);
                        }
                    });
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(err) => return Err(err),
            }
        }
        Ok(())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket_path);
    }
}

fn log_connection_error(err: &io::Error) {
    eprintln!("[failproofaid] connection error: {err}");
}

/// Handles exactly one request on `stream`: verify the peer is the same OS
/// user, read one framed [`ClientMessage`], dispatch it, write back one
/// framed [`ServerMessage`], then let the connection close.
pub fn handle_connection(stream: UnixStream, worker: &Worker) -> io::Result<()> {
    match peer::is_same_user(&stream) {
        Ok(true) => {}
        Ok(false) => {
            // Different OS user: drop the connection with no response at
            // all, rather than an Error message that would confirm a
            // daemon is listening here to a peer that has no business
            // asking.
            return Ok(());
        }
        Err(err) => return Err(err),
    }

    // `run_until` puts the *listener* in non-blocking mode. On Linux that
    // doesn't reach accepted sockets (std uses `accept4`), but on
    // BSD-derived systems — macOS, which this daemon supports via launchd —
    // the accepted socket inherits `O_NONBLOCK` from the listener. Left
    // inherited, `read_message` below returns `WouldBlock` the instant the
    // client's bytes haven't landed yet, which this function would treat as
    // a malformed frame and answer with silence: every hook call on macOS
    // would fail closed. Set the mode explicitly rather than relying on
    // per-platform accept semantics.
    stream.set_nonblocking(false)?;
    // Bound the peer's share of this thread's life in both directions (see
    // CONNECTION_IO_TIMEOUT).
    stream.set_read_timeout(Some(CONNECTION_IO_TIMEOUT))?;
    stream.set_write_timeout(Some(CONNECTION_IO_TIMEOUT))?;

    let mut reader = stream.try_clone()?;
    let mut writer = stream;

    let request: ClientMessage = match read_message(&mut reader) {
        Ok(msg) => msg,
        Err(_) => return Ok(()), // malformed frame: nothing to respond to, nothing to act on
    };

    let response = dispatch(request, worker);
    write_message(&mut writer, &response)
        .map_err(|e| io::Error::other(format!("failed to write response: {e}")))
}

fn dispatch(request: ClientMessage, worker: &Worker) -> ServerMessage {
    if request.protocol_version() != PROTOCOL_VERSION {
        return ServerMessage::Error {
            protocol_version: PROTOCOL_VERSION,
            message: format!(
                "protocol version mismatch: daemon speaks {PROTOCOL_VERSION}, client sent {}",
                request.protocol_version()
            ),
        };
    }

    match request {
        ClientMessage::Ping { .. } => ServerMessage::Pong {
            protocol_version: PROTOCOL_VERSION,
        },
        ClientMessage::Hook {
            hook_event,
            cli,
            stdin,
            cwd,
            ..
        } => match worker.call(&hook_event, &cli, &stdin, cwd.as_deref()) {
            Ok(outcome) => ServerMessage::HookResult {
                protocol_version: PROTOCOL_VERSION,
                exit_code: outcome.exit_code,
                stdout: outcome.stdout,
                stderr: outcome.stderr,
            },
            Err(err) => ServerMessage::Error {
                protocol_version: PROTOCOL_VERSION,
                message: format!("worker call failed: {err}"),
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::WorkerCommand;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    fn temp_socket_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "failproofaid-server-test-{}-{}-{}",
            std::process::id(),
            name,
            fastrand_ish()
        ))
    }

    // Avoids pulling in a `rand` dependency just to de-collide temp socket
    // paths across tests running in parallel threads.
    fn fastrand_ish() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
    }

    /// A `WorkerCommand` that never produces a working worker — for tests
    /// that don't care about Hook responses and just need *a* command
    /// (Ping never touches the worker at all).
    fn broken_worker_cmd() -> WorkerCommand {
        WorkerCommand::shell("true")
    }

    /// Owns a running test server + the worker it supervises. Shuts the
    /// server down and joins its thread on drop — including during an
    /// unwind from a failed `assert!`/`.unwrap()` — so a failing test
    /// cleans up its spawned worker process (via `Worker::drop`'s
    /// process-group kill, see worker.rs) exactly as reliably as a passing
    /// one. Before this guard existed, a panic between `start_test_server`
    /// and the manual `shutdown.store` + `handle.join()` at the end of a
    /// test permanently orphaned the server thread and its live `bun`
    /// worker subprocess — reproduced live: three orphaned
    /// `failproofai-worker.mjs` processes were still running, minutes
    /// later, from earlier iterations of this very test file.
    struct TestServerGuard {
        shutdown: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for TestServerGuard {
        fn drop(&mut self) {
            self.shutdown.store(true, Ordering::Relaxed);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn start_test_server_with_worker(
        socket_path: PathBuf,
        worker_cmd: WorkerCommand,
    ) -> TestServerGuard {
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = shutdown.clone();
        let worker_socket_path = temp_socket_path("worker-internal");
        let handle = std::thread::spawn(move || {
            let worker = Arc::new(crate::worker::Worker::new(worker_socket_path, worker_cmd));
            let server = Server::bind(&socket_path, worker).expect("bind should succeed");
            server
                .run_until(shutdown_clone)
                .expect("run_until should not error");
        });
        // Give the background thread a moment to actually bind before the
        // test tries to connect.
        std::thread::sleep(Duration::from_millis(50));
        TestServerGuard {
            shutdown,
            handle: Some(handle),
        }
    }

    fn start_test_server(socket_path: PathBuf) -> TestServerGuard {
        start_test_server_with_worker(socket_path, broken_worker_cmd())
    }

    #[test]
    fn ping_gets_pong() {
        let socket_path = temp_socket_path("ping");
        let _guard = start_test_server(socket_path.clone());

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
    }

    #[test]
    fn hook_request_gets_an_error_when_the_worker_cannot_be_reached() {
        let socket_path = temp_socket_path("hook-broken-worker");
        let _guard = start_test_server(socket_path.clone());

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &ClientMessage::Hook {
                protocol_version: PROTOCOL_VERSION,
                hook_event: "PreToolUse".to_string(),
                cli: "claude".to_string(),
                stdin: "{}".to_string(),
                cwd: None,
            },
        )
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).unwrap();
        match response {
            ServerMessage::Error { .. } => {}
            other => panic!("expected Error, got {other:?}"),
        }
    }

    /// The real end-to-end path: a real `failproofaid` server relaying a
    /// real Hook request to the real TypeScript worker (spawned via `bun`
    /// against this repo's own `bin/failproofai-worker.mjs`), which runs
    /// the actual, unmodified policy-evaluation engine. Proves Rust and TS
    /// sides of the wire protocol actually agree, not just that each side's
    /// own unit tests pass in isolation.
    #[test]
    fn relays_a_hook_request_to_the_real_typescript_worker_end_to_end() {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("crates/failproofaid should be two levels under the repo root")
            .to_path_buf();
        let worker_script = repo_root.join("bin").join("failproofai-worker.mjs");
        assert!(
            worker_script.exists(),
            "expected {worker_script:?} to exist"
        );

        // A real project dir with block-sudo enabled, so the response
        // proves real policy evaluation ran, not just that SOME response
        // came back.
        let project_dir = std::env::temp_dir().join(format!(
            "failproofaid-e2e-project-{}-{}",
            std::process::id(),
            fastrand_ish()
        ));
        std::fs::create_dir_all(project_dir.join(".failproofai")).unwrap();
        std::fs::write(
            project_dir
                .join(".failproofai")
                .join("policies-config.json"),
            r#"{"enabledPolicies":["block-sudo"]}"#,
        )
        .unwrap();

        let socket_path = temp_socket_path("hook-real-worker");
        let worker_cmd = WorkerCommand::shell(format!("bun {}", worker_script.display()));
        let _guard = start_test_server_with_worker(socket_path.clone(), worker_cmd);

        let stdin = serde_json::json!({
            "cwd": project_dir.to_string_lossy(),
            "tool_name": "Bash",
            "tool_input": { "command": "sudo rm -rf /" },
        })
        .to_string();

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        write_message(
            &mut stream,
            &ClientMessage::Hook {
                protocol_version: PROTOCOL_VERSION,
                hook_event: "PreToolUse".to_string(),
                cli: "claude".to_string(),
                stdin,
                cwd: Some(project_dir.to_string_lossy().to_string()),
            },
        )
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).unwrap();
        match response {
            ServerMessage::HookResult {
                exit_code, stdout, ..
            } => {
                // Claude's PreToolUse deny contract is JSON on stdout at
                // exit 0 (hookSpecificOutput.permissionDecision), not a
                // nonzero exit code.
                assert_eq!(exit_code, 0);
                assert!(
                    stdout.contains("\"permissionDecision\":\"deny\""),
                    "expected a real deny from block-sudo, got stdout: {stdout}"
                );
            }
            other => panic!("expected HookResult, got {other:?}"),
        }

        std::fs::remove_dir_all(&project_dir).ok();
    }

    #[test]
    fn mismatched_protocol_version_gets_an_explicit_error() {
        let socket_path = temp_socket_path("version-mismatch");
        let _guard = start_test_server(socket_path.clone());

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &ClientMessage::Ping {
                protocol_version: PROTOCOL_VERSION + 999,
            },
        )
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).unwrap();
        match response {
            ServerMessage::Error { message, .. } => {
                assert!(message.contains("version"));
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn bind_replaces_a_stale_socket_file() {
        let socket_path = temp_socket_path("stale");
        // Simulate a leftover file from a crashed daemon: not even a valid
        // socket, just a regular file at that path.
        std::fs::write(&socket_path, b"not a socket").unwrap();

        let worker = Arc::new(crate::worker::Worker::new(
            temp_socket_path("stale-worker"),
            broken_worker_cmd(),
        ));
        let server = Server::bind(&socket_path, worker).expect("bind should clear the stale file");
        drop(server);
        assert!(
            !socket_path.exists(),
            "Drop should clean up the socket file"
        );
    }

    #[test]
    fn bound_socket_file_is_owner_only() {
        let socket_path = temp_socket_path("perms");
        let worker = Arc::new(crate::worker::Worker::new(
            temp_socket_path("perms-worker"),
            broken_worker_cmd(),
        ));
        let server = Server::bind(&socket_path, worker).unwrap();
        let mode = std::fs::metadata(&socket_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        drop(server);
    }

    #[test]
    fn multiple_concurrent_pings_all_get_answered() {
        let socket_path = temp_socket_path("concurrent");
        let _guard = start_test_server(socket_path.clone());

        let clients: Vec<_> = (0..8)
            .map(|_| {
                let path = socket_path.clone();
                std::thread::spawn(move || {
                    let mut stream = UnixStream::connect(&path).unwrap();
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
                })
            })
            .collect();
        for c in clients {
            c.join().unwrap();
        }
    }
}
