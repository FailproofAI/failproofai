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
///
/// Enforced as an ABSOLUTE DEADLINE per connection (see [`Deadline`]), not by
/// handing it to `set_read_timeout` alone. `SO_RCVTIMEO` bounds a single
/// `read(2)`, and `read_message` reads through `read_exact`, which loops until
/// the buffer is full — so every byte that arrives resets the clock. A peer
/// dribbling one byte every nine seconds satisfied that timeout forever while
/// pinning its handler thread, and 64 of them fill
/// [`MAX_INFLIGHT_CONNECTIONS`], at which point the daemon refuses every real
/// hook and a `daemonConfigured` machine fails closed on every tool call. The
/// doc comment above asserted the opposite invariant.
const CONNECTION_IO_TIMEOUT: Duration = Duration::from_secs(10);

/// Enforces [`CONNECTION_IO_TIMEOUT`] as a wall-clock budget across every
/// read and write on one connection, rather than per syscall.
///
/// Before each operation it re-arms the socket timeout with what is LEFT of
/// the budget, so a slow peer cannot extend its own deadline by making
/// progress. Once the budget is spent the operation fails rather than
/// blocking — the handler thread returns, and the client sees a dropped
/// connection, which is already its fail-closed path.
struct Deadline<'a> {
    stream: &'a UnixStream,
    expires_at: std::time::Instant,
}

impl<'a> Deadline<'a> {
    fn new(stream: &'a UnixStream, budget: Duration) -> Self {
        Self {
            stream,
            expires_at: std::time::Instant::now() + budget,
        }
    }

    /// The remaining budget, or `TimedOut` once it is gone. Never returns a
    /// zero duration: to `set_*_timeout` that means "block forever", which is
    /// exactly the state this type exists to prevent.
    fn remaining(&self) -> io::Result<Duration> {
        let left = self
            .expires_at
            .saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "connection exceeded its total I/O budget",
            ));
        }
        Ok(left)
    }
}

impl io::Read for Deadline<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.stream.set_read_timeout(Some(self.remaining()?))?;
        (&*self.stream).read(buf)
    }
}

impl io::Write for Deadline<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        (&*self.stream).write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        (&*self.stream).flush()
    }
}

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
        // `symlink_metadata`, not `exists()`. `Path::exists()` FOLLOWS
        // symlinks, so a DANGLING symlink at the socket path reports false,
        // is left in place, and `UnixListener::bind` then fails `EADDRINUSE`.
        // With `Restart=on-failure` in the unit that is a crash loop, and a
        // crash-looping daemon on a `daemonConfigured` machine denies every
        // tool call across every CLI — reachable with one `ln -s`.
        //
        // Unlinking unconditionally is safe for the same reason the old check
        // was: a live daemon is never listening on a leftover path (the
        // singleton flock in `lock.rs` is what actually prevents two daemons),
        // so anything here is debris.
        match fs::symlink_metadata(socket_path) {
            Ok(_) => fs::remove_file(socket_path)?,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
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
    // Bound the peer's share of this thread's life in both directions, as ONE
    // wall-clock budget across every read and write rather than per syscall
    // (see CONNECTION_IO_TIMEOUT and Deadline).
    let mut io = Deadline::new(&stream, CONNECTION_IO_TIMEOUT);

    let request: ClientMessage = match read_message(&mut io) {
        Ok(msg) => msg,
        Err(_) => return Ok(()), // malformed frame: nothing to respond to, nothing to act on
    };

    // The worker call is deliberately OUTSIDE the connection budget: it is our
    // own evaluation taking time, not the peer withholding bytes, and it has
    // its own 30s ceiling in `worker.rs` matched to the client's. The response
    // write below gets a fresh budget for the same reason — a peer that has
    // waited through a slow evaluation must not then be denied its answer
    // because the read half used the clock up.
    let response = dispatch(request, worker);
    let mut io = Deadline::new(&stream, CONNECTION_IO_TIMEOUT);
    write_message(&mut io, &response)
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

    /// `Path::exists()` follows symlinks, so a DANGLING one at the socket path
    /// reported false, was never unlinked, and `UnixListener::bind` then failed
    /// `EADDRINUSE`. With `Restart=on-failure` that is a crash loop, and a
    /// crash-looping daemon on a `daemonConfigured` machine denies every tool
    /// call across every CLI — reachable with a single `ln -s`.
    #[test]
    fn binds_over_a_dangling_symlink_left_at_the_socket_path() {
        let socket_path = temp_socket_path("dangling-symlink");
        let nowhere = temp_socket_path("target-that-never-existed");
        std::os::unix::fs::symlink(&nowhere, &socket_path).unwrap();
        assert!(
            !socket_path.exists(),
            "a dangling symlink must report exists() == false, or this test proves nothing"
        );

        let _guard = start_test_server(socket_path.clone());

        // Connecting at all is the assertion: it can only succeed if bind did.
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

    /// `SO_RCVTIMEO` bounds ONE `read(2)`, and `read_message` reads through
    /// `read_exact`, which loops until its buffer is full — so every byte that
    /// arrives reset the clock. A peer dribbling bytes slower than the timeout
    /// but faster than never satisfied it indefinitely while pinning a handler
    /// thread; 64 of those fill `MAX_INFLIGHT_CONNECTIONS` and the daemon stops
    /// answering real hooks entirely.
    ///
    /// The peer here announces a 4 KiB body and then sends one byte every
    /// 40 ms. Under the old per-read timeout that read completes in about 164
    /// SECONDS, having never once exceeded 10s between bytes.
    #[test]
    fn a_trickling_peer_cannot_hold_a_connection_past_its_budget() {
        use std::io::Write;

        let (server_side, mut client_side) = UnixStream::pair().unwrap();
        let dribbler = std::thread::spawn(move || {
            // A valid, in-range length prefix — the frame is well formed, it
            // simply never finishes arriving.
            if client_side.write_all(&4096u32.to_be_bytes()).is_err() {
                return;
            }
            let _ = client_side.flush();
            loop {
                if client_side.write_all(b"x").is_err() {
                    return;
                }
                if client_side.flush().is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        });

        let started = std::time::Instant::now();
        let mut io = Deadline::new(&server_side, Duration::from_millis(300));
        let result: Result<ClientMessage, _> = read_message(&mut io);
        let elapsed = started.elapsed();

        assert!(
            result.is_err(),
            "the deadline must cut a trickling peer off"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "gave up after {elapsed:?}; the budget was 300ms and the peer would \
             have taken ~164s to finish its frame"
        );

        drop(server_side);
        let _ = dribbler.join();
    }

    /// The budget is spent by elapsed time, not reset by progress — the exact
    /// property `set_read_timeout` alone does not give.
    #[test]
    fn the_connection_budget_does_not_reset_when_bytes_arrive() {
        let (server_side, _client_side) = UnixStream::pair().unwrap();
        let io = Deadline::new(&server_side, Duration::from_millis(80));
        assert!(io.remaining().is_ok());
        std::thread::sleep(Duration::from_millis(120));
        let err = io.remaining().expect_err("the budget must be spent");
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
    }
}
