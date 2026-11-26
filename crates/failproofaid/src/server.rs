//! The Unix-socket server: bind, accept, verify the peer, dispatch one
//! request per connection.
//!
//! `Hook` requests are relayed to the warm worker (see `worker.rs`); `Ping`
//! is answered directly. Any failure to reach/use the worker becomes a
//! client-facing `Error` response — never a hang, never a crash of the
//! connection-handling thread.

use crate::worker::Worker;
use fpai_ipc::{
    ClientMessage, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, ServerMessage,
    is_supported_protocol_version, peer, read_message, write_message,
};
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
    /// Binds a fresh listener at `socket_path`, replacing a stale socket file
    /// left behind by a process that didn't shut down cleanly.
    ///
    /// "Stale" is established by PROBING the path, not by assuming it: if
    /// something is still accepting there, this refuses with `AddrInUse` rather
    /// than unlinking a socket a live daemon is serving. See the note below on
    /// why the singleton `flock` is not sufficient on its own.
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
        //
        // "Anything here is debris" rested entirely on `flock()` guaranteeing
        // there is no second daemon, and flock does NOT provide that across
        // hosts on an NFS-mounted home: pre-NFSv4 locks are client-local
        // without an active lockd, and `failproofai_home()` never checks what
        // filesystem `$HOME`/`FAILPROOFAI_HOME` lives on. The same user on two
        // machines sharing a home would then have the second daemon believe it
        // held the lock and unlink the first one's LIVE socket, silently
        // orphaning every client of a daemon that is still running — and on a
        // fail-closed machine those clients deny every tool call. (`audit-lock.ts`
        // already engineers around NFS for `O_EXCL`, so the deployment shape is
        // one this codebase accounts for elsewhere.)
        //
        // So the liveness question is answered directly instead of inferred:
        // if something is actually accepting on that path, it is a live daemon
        // and this one refuses to start rather than stealing it. A connect that
        // fails means nothing is listening, which is what debris looks like on
        // any filesystem.
        match fs::symlink_metadata(socket_path) {
            Ok(_) => {
                if UnixStream::connect(socket_path).is_ok() {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        format!(
                            "a failproofaid is already accepting connections on {} — refusing to \
                             replace it",
                            socket_path.display()
                        ),
                    ));
                }
                fs::remove_file(socket_path)?
            }
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
                    // `Builder::spawn`, not `std::thread::spawn`, for the same
                    // reason the telemetry, audit and collector lanes use it:
                    // the plain function PANICS when the OS refuses a thread
                    // (`RLIMIT_NPROC`, a pids cgroup ceiling, transient
                    // `pthread_create` EAGAIN). This one runs on the daemon's
                    // MAIN thread, once per connection — by far the most
                    // frequent spawn in the process — and nothing above `run()`
                    // catches an unwind, so a single refusal killed the whole
                    // daemon. On a `daemonConfigured` machine that denies every
                    // tool call across every CLI, and `Restart=on-failure` then
                    // turns it into a crash loop that re-arrives at the same
                    // exhausted thread limit.
                    //
                    // Dropping the connection instead is a bounded, logged
                    // overload — the same outcome as exceeding
                    // `MAX_INFLIGHT_CONNECTIONS` above, and the client's own
                    // fail-closed path. Dropping the closure releases `stream`
                    // and `guard`, so the in-flight count is restored by
                    // `InflightGuard::drop` and does not leak the slot.
                    //
                    // The error is NOT written back to the peer first: that
                    // would put a blocking write on the accept loop, and a peer
                    // that never reads would then stall every other connection
                    // — trading a rare refused thread for a wedged daemon.
                    if let Err(err) = std::thread::Builder::new()
                        .name("fpai-conn".to_string())
                        .spawn(move || {
                            let _guard = guard;
                            if let Err(err) = handle_connection(stream, &worker) {
                                log_connection_error(&err);
                            }
                        })
                    {
                        log_connection_error(&io::Error::other(format!(
                            "could not start a handler thread, dropping this connection: {err}"
                        )));
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                // Out of file descriptors, an aborted handshake, a signal:
                // the listener is fine and the next accept can succeed.
                // Returning here exited the daemon, and until the service
                // manager restarted it every hook on the machine was denied.
                Err(err) if is_transient_accept_error(&err) => {
                    log_connection_error(&io::Error::other(format!(
                        "accept failed, retrying: {err}"
                    )));
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(err) => return Err(err),
            }
        }
        Ok(())
    }
}

/// An `accept()` failure that says nothing about the listener itself.
fn is_transient_accept_error(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::Interrupted
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::OutOfMemory
    ) || matches!(
        err.raw_os_error(),
        Some(libc::EMFILE | libc::ENFILE | libc::ENOBUFS | libc::ENOMEM)
    )
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket_path);
    }
}

fn log_connection_error(err: &io::Error) {
    tracing::warn!("connection error: {err}");
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
    let started = std::time::Instant::now();
    let response = dispatch(request, worker);
    let took = started.elapsed();
    let mut io = Deadline::new(&stream, CONNECTION_IO_TIMEOUT);
    write_message(&mut io, &response).map_err(|e| {
        if peer_hung_up(&e) {
            // The client stopped waiting and its own fail-closed path already
            // answered the call. On macOS this surfaced only as "Invalid
            // argument (os error 22)": setsockopt on a socket the peer closed
            // is EINVAL there. How long the evaluation took is the useful part.
            io::Error::other(format!(
                "the client had closed the connection when its verdict was written \
                 (evaluation took {} ms)",
                took.as_millis()
            ))
        } else {
            io::Error::other(format!("failed to write response: {e}"))
        }
    })
}

/// Whether a write failed because the peer had already gone.
fn peer_hung_up(err: &fpai_ipc::FramingError) -> bool {
    let fpai_ipc::FramingError::Io(io) = err else {
        return false;
    };
    matches!(
        io.kind(),
        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset | io::ErrorKind::NotConnected
    ) || io.raw_os_error() == Some(libc::EINVAL)
}

fn record_agent_sighting(integration: &str, settings_path: Option<&str>) {
    let Some(settings_path) = settings_path else {
        return;
    };
    let (Ok(roster), Some(home)) = (crate::agent_roster::roster_path(), std::env::var_os("HOME"))
    else {
        return;
    };
    if let Err(err) = crate::agent_roster::record_sighting(
        &roster,
        std::path::Path::new(&home),
        integration,
        std::path::Path::new(settings_path),
    ) {
        tracing::warn!("could not record an agent hook sighting: {err}");
    }
}

/// Pre-C11 callers omit the field entirely. Their profile is UNKNOWN, not
/// whatever the daemon worker's long-lived environment happens to name.
fn worker_agent_settings_path(settings_path: Option<&str>) -> Option<&str> {
    Some(settings_path.unwrap_or(""))
}

fn dispatch(request: ClientMessage, worker: &Worker) -> ServerMessage {
    let version = request.protocol_version();
    if !is_supported_protocol_version(version) {
        return ServerMessage::Error {
            protocol_version: PROTOCOL_VERSION,
            message: format!(
                "protocol version mismatch: daemon speaks {MIN_PROTOCOL_VERSION}-{PROTOCOL_VERSION}, client sent {version}"
            ),
        };
    }
    if version < fpai_ipc::envelope::AGENT_SETTINGS_PATH_SINCE
        && !matches!(request, ClientMessage::Ping { .. })
        && let Ok(dir) = crate::paths::cloud_managed_policy_dir()
        && let Some(message) = legacy_scope_refusal(&dir)
    {
        return ServerMessage::Error {
            protocol_version: version,
            message,
        };
    }
    let response = evaluate(request.without_fields_newer_than_its_version(), worker)
        .with_protocol_version(version);
    // Checked again after: a deployment that became targeted while the worker
    // evaluated (Cloud maintenance runs beside it) may have been applied with
    // no agent, so the answer is withheld for the same reason as above.
    if version < fpai_ipc::envelope::AGENT_SETTINGS_PATH_SINCE
        && let Ok(dir) = crate::paths::cloud_managed_policy_dir()
        && let Some(message) = legacy_scope_refusal(&dir)
    {
        return ServerMessage::Error {
            protocol_version: version,
            message,
        };
    }
    response
}

/// Why a request too old to name its agent cannot be answered here, if it
/// cannot.
///
/// A v1 request carries no `agentSettingsPath`, so it is evaluated with its
/// agent unknown, and a Cloud policy targeted at an agent does not apply to an
/// unknown one. Where the deployment has no targeted policy that changes
/// nothing, and the stale gateway keeps working. Where it does (schema 3), an
/// answer could allow what the targeted policy denies, so the request is
/// refused and the old client's own fail-closed path blocks it, as every v1
/// request was before compatibility. A deployment that cannot be read is
/// refused for the same reason.
fn legacy_scope_refusal(cloud_policy_dir: &Path) -> Option<String> {
    // Only a manifest that is NOT THERE means no deployment. `read_active`
    // asks `exists()`, which reads a permission error as absent too.
    match fs::metadata(cloud_policy_dir.join("active.json")) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => return None,
        Err(err) => {
            return Some(format!(
                "this client predates agent-targeted Cloud policies and the deployment could \
                 not be read to rule them out ({err}): restart the agent gateway"
            ));
        }
        Ok(_) => {}
    }
    let store = crate::cloud_policies::PolicyStore::new(cloud_policy_dir.to_path_buf());
    match store.read_active() {
        Ok(None) => None,
        Ok(Some(active))
            if active.schema_version
                < crate::cloud_policies::SCOPED_DESIRED_STATE_SCHEMA_VERSION =>
        {
            None
        }
        Ok(Some(_)) => Some(
            "this client predates agent-targeted Cloud policies, which this machine's \
             deployment uses: restart the agent gateway to load the current plugin"
                .to_string(),
        ),
        Err(err) => Some(format!(
            "this client predates agent-targeted Cloud policies and the deployment could \
             not be read to rule them out ({err}): restart the agent gateway"
        )),
    }
}

fn evaluate(request: ClientMessage, worker: &Worker) -> ServerMessage {
    match request {
        ClientMessage::Ping { .. } => ServerMessage::Pong {
            protocol_version: PROTOCOL_VERSION,
            self_report: fpai_collect::self_report::listening().map(|port| {
                fpai_ipc::SelfReportServer {
                    instance_id: fpai_collect::self_report::instance_id().to_string(),
                    port,
                }
            }),
        },
        ClientMessage::Hook {
            hook_event,
            cli,
            stdin,
            cwd,
            agent_settings_path,
            ..
        } => {
            record_agent_sighting(&cli, agent_settings_path.as_deref());
            match worker.call(
                &hook_event,
                &cli,
                &stdin,
                cwd.as_deref(),
                worker_agent_settings_path(agent_settings_path.as_deref()),
            ) {
                Ok(outcome) => {
                    crate::hook_watch::note_answered(&cli, &stdin);
                    ServerMessage::HookResult {
                        protocol_version: PROTOCOL_VERSION,
                        exit_code: outcome.exit_code,
                        stdout: outcome.stdout,
                        stderr: outcome.stderr,
                    }
                }
                Err(err) => ServerMessage::Error {
                    protocol_version: PROTOCOL_VERSION,
                    message: format!("worker call failed: {err}"),
                },
            }
        }
        ClientMessage::PolicyEvaluation {
            integration,
            event,
            payload,
            cwd,
            agent_settings_path,
            ..
        } => {
            record_agent_sighting(&integration, agent_settings_path.as_deref());
            let stdin = match serde_json::to_string(&payload) {
                Ok(value) => value,
                Err(err) => {
                    return ServerMessage::Error {
                        protocol_version: PROTOCOL_VERSION,
                        message: format!("could not encode policy payload: {err}"),
                    };
                }
            };
            match worker.call(
                &event,
                &integration,
                &stdin,
                cwd.as_deref(),
                worker_agent_settings_path(agent_settings_path.as_deref()),
            ) {
                Ok(outcome) => match outcome.evaluation {
                    Some(evaluation)
                        if matches!(
                            evaluation.decision.as_str(),
                            "allow" | "deny" | "instruct"
                        ) =>
                    {
                        crate::hook_watch::note_answered(&integration, &stdin);
                        let policy_names = if evaluation.policy_names.is_empty() {
                            evaluation.policy_name.into_iter().collect()
                        } else {
                            evaluation.policy_names
                        };
                        ServerMessage::PolicyResult {
                            protocol_version: PROTOCOL_VERSION,
                            decision: evaluation.decision,
                            policy_names,
                            reason: evaluation.reason,
                            matched_policies: evaluation.matched_policies,
                            duration_ms: evaluation.duration_ms,
                            tool_name: evaluation.tool_name,
                        }
                    }
                    Some(evaluation) => ServerMessage::Error {
                        protocol_version: PROTOCOL_VERSION,
                        message: format!(
                            "worker returned an invalid policy decision: {}",
                            evaluation.decision
                        ),
                    },
                    None => ServerMessage::Error {
                        protocol_version: PROTOCOL_VERSION,
                        message: "worker did not return structured policy metadata".to_string(),
                    },
                },
                Err(err) => ServerMessage::Error {
                    protocol_version: PROTOCOL_VERSION,
                    message: format!("worker call failed: {err}"),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::WorkerCommand;
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};

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
        let ready_path = socket_path.clone();
        let handle = std::thread::spawn(move || {
            let worker = Arc::new(crate::worker::Worker::new(worker_socket_path, worker_cmd));
            let server = Server::bind(&socket_path, worker).expect("bind should succeed");
            server
                .run_until(shutdown_clone)
                .expect("run_until should not error");
        });
        // Wait for the listener to exist, rather than sleeping a fixed 50ms and
        // hoping. A fixed sleep is a race: it passes on an idle developer
        // machine and fails on a loaded CI runner, where all eight threads of
        // `multiple_concurrent_pings_all_get_answered` panicked on
        // `UnixStream::connect(...).unwrap()` because the bind had not happened
        // yet. Connecting is the exact property every caller needs, so that is
        // what we poll for; the probe's own connection is accepted and dropped,
        // which the server handles as an EOF like any other closed client.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if UnixStream::connect(&ready_path).is_ok() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "test server did not start listening on {} within 5s",
                ready_path.display()
            );
            std::thread::sleep(Duration::from_millis(2));
        }
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
                protocol_version: PROTOCOL_VERSION,
                self_report: None
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
                agent_settings_path: None,
            },
        )
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).unwrap();
        match response {
            ServerMessage::Error { .. } => {}
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn policy_evaluation_gets_an_error_when_the_worker_cannot_be_reached() {
        let socket_path = temp_socket_path("policy-broken-worker");
        let _guard = start_test_server(socket_path.clone());

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &ClientMessage::PolicyEvaluation {
                protocol_version: PROTOCOL_VERSION,
                integration: "hermes".to_string(),
                event: "pre_tool_call".to_string(),
                payload: serde_json::json!({
                    "tool_name": "terminal",
                    "tool_input": {"command": "echo hi"}
                }),
                cwd: None,
                agent_settings_path: None,
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
    fn relays_hook_and_structured_policy_requests_to_the_real_worker() {
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

        let no_deployment = temp_socket_path("no-deployment-real");
        let _env = CloudPolicyDir::set(&no_deployment);
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
                agent_settings_path: None,
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

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        write_message(
            &mut stream,
            &ClientMessage::PolicyEvaluation {
                protocol_version: PROTOCOL_VERSION,
                integration: "hermes".to_string(),
                event: "pre_tool_call".to_string(),
                payload: serde_json::json!({
                    "cwd": project_dir.to_string_lossy(),
                    "tool_name": "terminal",
                    "tool_input": { "command": "sudo rm -rf /" }
                }),
                cwd: Some(project_dir.to_string_lossy().to_string()),
                agent_settings_path: None,
            },
        )
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).unwrap();
        match response {
            ServerMessage::PolicyResult {
                decision,
                policy_names,
                tool_name,
                ..
            } => {
                assert_eq!(decision, "deny");
                assert!(
                    policy_names
                        .iter()
                        .any(|name| name.ends_with("/block-sudo"))
                );
                assert_eq!(tool_name.as_deref(), Some("Bash"));
            }
            other => panic!("expected PolicyResult, got {other:?}"),
        }

        // The request a Hermes plugin loaded before 1.0.12 sends: v1, no
        // agentSettingsPath. It gets the real verdict, stamped v1 so that
        // plugin's own version check accepts it.
        let mut stream = UnixStream::connect(&socket_path).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        write_message(
            &mut stream,
            &ClientMessage::PolicyEvaluation {
                protocol_version: 1,
                integration: "hermes".to_string(),
                event: "pre_tool_call".to_string(),
                payload: serde_json::json!({
                    "cwd": project_dir.to_string_lossy(),
                    "tool_name": "terminal",
                    "tool_input": { "command": "sudo rm -rf /" }
                }),
                cwd: Some(project_dir.to_string_lossy().to_string()),
                agent_settings_path: None,
            },
        )
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).unwrap();
        match response {
            ServerMessage::PolicyResult {
                protocol_version,
                decision,
                policy_names,
                ..
            } => {
                assert_eq!(protocol_version, 1);
                assert_eq!(decision, "deny");
                assert!(
                    policy_names
                        .iter()
                        .any(|name| name.ends_with("/block-sudo"))
                );
            }
            other => panic!("expected a v1 PolicyResult, got {other:?}"),
        }

        std::fs::remove_dir_all(&project_dir).ok();
    }

    #[test]
    fn an_older_hook_without_agent_identity_must_not_borrow_the_workers_profile() {
        assert_eq!(worker_agent_settings_path(None), Some(""));
        assert_eq!(worker_agent_settings_path(Some("")), Some(""));
        assert_eq!(
            worker_agent_settings_path(Some("/opt/agent/config.yaml")),
            Some("/opt/agent/config.yaml"),
        );
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

    /// Points the daemon's Cloud policy directory at `dir` for one test. v1
    /// requests read it (see `legacy_scope_refusal`), and the developer's real
    /// one must not decide a test.
    struct CloudPolicyDir {
        _lock: std::sync::MutexGuard<'static, ()>,
        previous: Option<std::ffi::OsString>,
    }

    impl CloudPolicyDir {
        fn set(dir: &Path) -> Self {
            let lock = crate::test_env::lock_env();
            let previous = std::env::var_os(crate::paths::CLOUD_POLICY_DIR_ENV);
            // SAFETY: serialised by the env lock held for this value's life.
            unsafe { std::env::set_var(crate::paths::CLOUD_POLICY_DIR_ENV, dir) };
            CloudPolicyDir {
                _lock: lock,
                previous,
            }
        }
    }

    impl Drop for CloudPolicyDir {
        fn drop(&mut self) {
            // SAFETY: as above.
            unsafe {
                match &self.previous {
                    Some(v) => std::env::set_var(crate::paths::CLOUD_POLICY_DIR_ENV, v),
                    None => std::env::remove_var(crate::paths::CLOUD_POLICY_DIR_ENV),
                }
            }
        }
    }

    #[test]
    fn an_old_client_is_refused_when_the_deployment_targets_agents() {
        let dir = temp_socket_path("scoped-deployment");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("active.json"),
            format!(
                r#"{{"schemaVersion":{},"deployment":4,"policies":[]}}"#,
                crate::cloud_policies::SCOPED_DESIRED_STATE_SCHEMA_VERSION
            ),
        )
        .unwrap();
        let _env = CloudPolicyDir::set(&dir);
        let worker = Worker::new(temp_socket_path("scoped-worker"), broken_worker_cmd());
        let request = |protocol_version| ClientMessage::PolicyEvaluation {
            protocol_version,
            integration: "hermes".into(),
            event: "pre_tool_call".into(),
            payload: serde_json::json!({}),
            cwd: None,
            agent_settings_path: None,
        };
        match dispatch(request(1), &worker) {
            ServerMessage::Error {
                protocol_version,
                message,
            } => {
                assert_eq!(protocol_version, 1, "stamped so the old client reads it");
                assert!(message.contains("agent-targeted"), "{message}");
            }
            other => panic!("a v1 request was evaluated: {other:?}"),
        }
        // A current client names its agent: evaluated (here, by a broken worker).
        match dispatch(request(PROTOCOL_VERSION), &worker) {
            ServerMessage::Error { message, .. } => assert!(!message.contains("agent-targeted")),
            other => panic!("unexpected {other:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn previous_protocol_is_answered_in_its_own_version() {
        // A gateway that loaded the previous plugin before an upgrade keeps
        // speaking v1 until it restarts. It must get an answer it accepts,
        // not a mismatch that its fail-closed path turns into a deny.
        let no_deployment = temp_socket_path("no-deployment");
        let _env = CloudPolicyDir::set(&no_deployment);
        let socket_path = temp_socket_path("old-protocol");
        let _guard = start_test_server(socket_path.clone());

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &ClientMessage::Ping {
                protocol_version: 1,
            },
        )
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).unwrap();
        assert_eq!(
            response,
            ServerMessage::Pong {
                protocol_version: 1,
                self_report: None
            }
        );

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &ClientMessage::Hook {
                protocol_version: 1,
                hook_event: "PreToolUse".into(),
                cli: "claude".into(),
                stdin: "{}".into(),
                cwd: None,
                agent_settings_path: None,
            },
        )
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).unwrap();
        // The broken test worker cannot evaluate; what matters is that the
        // request reached it instead of stopping at the version gate.
        match response {
            ServerMessage::Error {
                protocol_version,
                message,
            } => {
                assert_eq!(protocol_version, 1);
                assert!(!message.contains("protocol version mismatch"), "{message}");
            }
            other => panic!("expected the worker's error, got {other:?}"),
        }
    }

    #[test]
    fn old_protocol_never_evaluates_a_scoped_agent() {
        // v1 predates agentSettingsPath. A v1 request carrying one is not a
        // real v1 client, and must be evaluated as profile-unknown, never for
        // the profile it names.
        let scoped = |protocol_version| ClientMessage::PolicyEvaluation {
            protocol_version,
            integration: "hermes".into(),
            event: "pre_tool_call".into(),
            payload: serde_json::json!({}),
            cwd: None,
            agent_settings_path: Some("/home/agent/.hermes/config.yaml".into()),
        };
        match scoped(1).without_fields_newer_than_its_version() {
            ClientMessage::PolicyEvaluation {
                agent_settings_path,
                ..
            } => assert_eq!(agent_settings_path, None),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(
            scoped(PROTOCOL_VERSION).without_fields_newer_than_its_version(),
            scoped(PROTOCOL_VERSION)
        );
    }

    #[test]
    fn an_old_client_is_refused_only_where_agent_targeted_policies_could_apply() {
        let dir = temp_socket_path("legacy-scope");
        std::fs::create_dir_all(&dir).unwrap();
        let write = |schema: u32| {
            std::fs::write(
                dir.join("active.json"),
                format!(r#"{{"schemaVersion":{schema},"deployment":4,"policies":[]}}"#),
            )
            .unwrap()
        };
        // No deployment, or one without targets: the stale gateway keeps working.
        assert_eq!(legacy_scope_refusal(&dir), None);
        write(2);
        assert_eq!(legacy_scope_refusal(&dir), None);
        // Targeted: an unknown agent would skip a policy aimed at it.
        write(crate::cloud_policies::SCOPED_DESIRED_STATE_SCHEMA_VERSION);
        assert!(legacy_scope_refusal(&dir).is_some());
        // Unreadable: cannot rule targets out.
        std::fs::write(dir.join("active.json"), "{").unwrap();
        assert!(legacy_scope_refusal(&dir).is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_client_that_stopped_waiting_is_logged_as_such() {
        let (mut client, server) = UnixStream::pair().unwrap();
        write_message(
            &mut client,
            &ClientMessage::Ping {
                protocol_version: PROTOCOL_VERSION,
            },
        )
        .unwrap();
        drop(client);
        let worker = Worker::new(temp_socket_path("hung-up"), broken_worker_cmd());
        let err = handle_connection(server, &worker).expect_err("the peer is gone");
        assert!(
            err.to_string()
                .contains("had closed the connection when its verdict was written"),
            "got: {err}"
        );
    }

    #[test]
    fn running_out_of_descriptors_does_not_end_the_accept_loop() {
        assert!(is_transient_accept_error(&io::Error::from_raw_os_error(24)));
        assert!(is_transient_accept_error(&io::Error::from_raw_os_error(23)));
        assert!(is_transient_accept_error(&io::Error::from(
            io::ErrorKind::ConnectionAborted
        )));
        // A listener that is genuinely broken still ends it.
        assert!(!is_transient_accept_error(&io::Error::from_raw_os_error(9)));
        assert!(!is_transient_accept_error(&io::Error::from(
            io::ErrorKind::InvalidInput
        )));
    }

    #[test]
    fn versions_outside_the_supported_range_are_refused() {
        assert!(is_supported_protocol_version(MIN_PROTOCOL_VERSION));
        assert!(is_supported_protocol_version(PROTOCOL_VERSION));
        assert!(!is_supported_protocol_version(0));
        assert!(!is_supported_protocol_version(PROTOCOL_VERSION + 1));
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
                            protocol_version: PROTOCOL_VERSION,
                            self_report: None
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
                protocol_version: PROTOCOL_VERSION,
                self_report: None
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

    /// A live daemon's socket must never be unlinked out from under it.
    ///
    /// `bind()` used to remove whatever sat at the path unconditionally, on the
    /// grounds that `lock.rs`'s `flock()` makes a second daemon impossible.
    /// That does not hold across hosts on an NFS-mounted home — pre-NFSv4 locks
    /// are client-local without an active lockd, and nothing checks what
    /// filesystem the home lives on — so a second machine could take the lock,
    /// unlink the first's live socket, and silently orphan its clients. Now the
    /// path is probed instead of assumed.
    #[test]
    fn binding_over_a_live_socket_is_refused_rather_than_stealing_it() {
        let socket_path = temp_socket_path("live");
        let worker = Arc::new(Worker::new(
            temp_socket_path("live-worker"),
            broken_worker_cmd(),
        ));

        let first = Server::bind(&socket_path, worker.clone()).expect("first bind should succeed");

        let Err(err) = Server::bind(&socket_path, worker) else {
            panic!("a second bind must not replace a listening daemon");
        };
        assert_eq!(err.kind(), io::ErrorKind::AddrInUse);
        assert!(
            err.to_string().contains("already accepting"),
            "expected a liveness refusal, got: {err}"
        );

        // And the original is untouched — still the one bound to that path.
        drop(first);
    }

    /// The ordinary restart path still works: a socket file whose process is
    /// gone is debris, and binding must clear it rather than refuse forever.
    #[test]
    fn a_socket_file_with_no_listener_is_replaced() {
        let socket_path = temp_socket_path("debris");
        let worker = Arc::new(Worker::new(
            temp_socket_path("debris-worker"),
            broken_worker_cmd(),
        ));

        // Exactly what a killed daemon leaves: std does not unlink on drop of
        // the listener alone, so create the file and let the listener go.
        {
            let _stale = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
        }
        assert!(fs::symlink_metadata(&socket_path).is_ok());

        Server::bind(&socket_path, worker).expect("debris must not block a restart");
    }

    /// A refused handler thread must give its in-flight slot back.
    ///
    /// When `Builder::spawn` fails it drops the closure it was handed, which is
    /// the only thing that runs `InflightGuard::drop` on that path — nothing in
    /// the accept loop decrements explicitly. If that did not hold, every
    /// refused thread would permanently shrink `MAX_INFLIGHT_CONNECTIONS`, and
    /// 64 of them would wedge the daemon into refusing every connection for the
    /// rest of its life: a fail-closed machine denying every tool call, which is
    /// the outcome the whole `Builder::spawn` change exists to avoid.
    #[test]
    fn a_handler_thread_that_never_starts_releases_its_slot() {
        let inflight = Arc::new(AtomicUsize::new(0));

        inflight.fetch_add(1, Ordering::Relaxed);
        let guard = InflightGuard(inflight.clone());
        assert_eq!(inflight.load(Ordering::Relaxed), 1);

        // Exactly what `Builder::spawn`'s error path does with the closure it
        // could not run: drops it, and with it every captured value.
        let closure = move || {
            let _guard = guard;
        };
        drop(closure);

        assert_eq!(
            inflight.load(Ordering::Relaxed),
            0,
            "the slot must be returned when the thread is never started"
        );
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
