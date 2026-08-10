//! Spawns and supervises the warm Node/Bun worker process, and relays
//! `Hook` requests to it.
//!
//! The worker speaks a SEPARATE, simpler internal protocol on its own
//! socket (no `protocolVersion` — this process always spawns a
//! version-matched worker, so there's nothing to negotiate) — this module
//! is the only thing that talks to it, and it's the one place that
//! translates between that internal protocol and the client-facing
//! [`fpai_ipc::ServerMessage`] envelope (which DOES carry `protocolVersion`,
//! since that one crosses a real compatibility boundary against whatever
//! `failproofai` CLI version happens to be installed).

use fpai_ipc::framing::{read_message, write_message};
use serde_json::json;
use std::io;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub enum WorkerError {
    Io(io::Error),
    /// The worker never created its socket within the startup deadline.
    StartupTimedOut,
    /// A response arrived but wasn't a well-formed hookResult/error.
    BadResponse(String),
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkerError::Io(e) => write!(f, "worker io error: {e}"),
            WorkerError::StartupTimedOut => write!(f, "worker did not start in time"),
            WorkerError::BadResponse(s) => write!(f, "unexpected worker response: {s}"),
        }
    }
}

impl std::error::Error for WorkerError {}

#[derive(Debug)]
pub struct HookOutcome {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// How to launch the worker process. `FAILPROOFAI_WORKER_CMD` (dev/test
/// override — a full shell command string, run via `sh -c`) always takes
/// precedence; otherwise falls back to `node <script>` for a production
/// install where `dist/worker.mjs` sits next to this binary.
///
/// Resolved explicitly by the caller (`from_env`, called once from
/// `main.rs`) rather than read from the environment inside `Worker` itself
/// — `std::env::var` is process-global, and Rust's test harness runs tests
/// in parallel by default, so multiple tests setting
/// `FAILPROOFAI_WORKER_CMD` to different values would race. Tests instead
/// construct a `WorkerCommand` directly via `shell`/`node`.
pub enum WorkerCommand {
    Shell(String),
    Node { script: PathBuf },
}

impl WorkerCommand {
    pub fn from_env() -> Self {
        if let Ok(cmd) = std::env::var("FAILPROOFAI_WORKER_CMD") {
            return WorkerCommand::shell(cmd);
        }
        // Published packages place dist/worker.mjs at this relative path; the
        // installed service normally supplies an absolute command via env.
        WorkerCommand::Node {
            script: PathBuf::from("dist/worker.mjs"),
        }
    }

    pub fn shell(cmd: impl Into<String>) -> Self {
        WorkerCommand::Shell(cmd.into())
    }

    fn spawn(&self, worker_socket: &Path) -> io::Result<Child> {
        let mut command = match self {
            WorkerCommand::Shell(shell_cmd) => {
                let mut c = Command::new("sh");
                c.arg("-c").arg(shell_cmd);
                c
            }
            WorkerCommand::Node { script } => {
                let mut c = Command::new("node");
                c.arg(script);
                c
            }
        };
        command
            .env("FAILPROOFAI_WORKER_SOCKET", worker_socket)
            .stdin(Stdio::null())
            // Piped, not inherited: an inherited stdout/stderr hands the
            // worker its own copy of this process's fds, and if this
            // process's own stdout is itself part of a pipeline (a test
            // harness, `cargo test | tail`, a shell capturing output), that
            // pipe never sees EOF as long as the worker — however it exits
            // — still holds a copy open. Piped fds belong to this process
            // alone and close cleanly when the worker does. Both pipes are
            // drained below: the worker outlives the daemon's whole
            // lifetime running real policy code, so any `console.log` from
            // a user's custom policy accumulates, and an undrained pipe
            // would eventually fill its OS buffer and block the worker
            // mid-write — every later hook call would then fail closed
            // until the daemon restarted.
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // New session + process group leader: `sh -c "<cmd>"` is not
            // guaranteed to exec(2) into `<cmd>` in place (some shells fork
            // instead), so killing only the tracked PID can leave a real
            // grandchild worker process running, reparented and orphaned.
            // Killing the whole group (see `kill_process_group`) reaches it
            // either way.
            .process_group(0);
        let mut child = command.spawn()?;
        // Both drainers must start, or the worker does not run at all.
        //
        // `Builder::spawn` rather than `std::thread::spawn` because the plain
        // function panics when the OS refuses a thread — and this runs while
        // `ensure_started` holds the `child` mutex, so that panic POISONED the
        // lock. The daemon itself survived (the unwind is confined to a
        // per-connection handler thread), which is what made it so bad: it kept
        // answering `Ping` and looking healthy while every `Hook` request
        // panicked on the poisoned lock forever after, and `shutdown()` — which
        // takes the same lock — silently stopped killing the worker.
        //
        // The failure is deliberately fatal to the SPAWN rather than logged and
        // ignored. An undrained pipe fills its OS buffer and blocks the worker
        // mid-write (see the `Stdio::piped()` note above), so continuing without
        // a drainer trades a rare refused thread for a worker that wedges later,
        // at a time and for a reason nothing connects back to this moment.
        // Returning the error costs one denied hook call, is logged, and
        // self-heals: `ensure_started` retries the spawn on the very next
        // request, by which time a transient EAGAIN has usually passed.
        let drainers = spawn_forwarder("stdout", child.stdout.take())
            .and_then(|()| spawn_forwarder("stderr", child.stderr.take()));
        if let Err(err) = drainers {
            kill_process_group(&mut child);
            return Err(io::Error::other(format!(
                "could not start the worker output drainers: {err}"
            )));
        }
        Ok(child)
    }
}

/// Starts the drainer thread for one of the worker's output pipes, or reports
/// why it could not. `None` means the pipe was already taken, which is not a
/// failure. See the call site for why a refusal here is fatal to the spawn.
fn spawn_forwarder(
    label: &'static str,
    pipe: Option<impl io::Read + Send + 'static>,
) -> io::Result<()> {
    let Some(pipe) = pipe else { return Ok(()) };
    std::thread::Builder::new()
        .name(format!("fpai-worker-{label}"))
        .spawn(move || forward_worker_output(label, pipe))
        .map(|_| ())
}

/// Drains one of the worker's output pipes for its whole life, relaying it
/// to the daemon's own stderr (which systemd/launchd already capture into
/// the service log). Ends on EOF when the worker exits.
fn forward_worker_output(label: &'static str, pipe: impl io::Read) {
    use std::io::BufRead;
    for line in io::BufReader::new(pipe).lines().map_while(Result::ok) {
        eprintln!("[failproofaid] worker {label}: {line}");
    }
}

/// Buffer one worker-lifecycle event.
///
/// Called from `ensure_started`, which is ON the hook path — so this must stay
/// a bounded in-memory push and nothing else. `telemetry::record` is exactly
/// that (no I/O, no allocation the caller waits on, no panic), and it is a
/// no-op when the machine has opted out or before the lane exists.
///
/// `startup_ms` is the number worth having: the client's fail-closed budget
/// assumes a WARM worker, so a cold start creeping upward is what turns a
/// healthy daemon into intermittent denials, and nothing else measures it.
fn report_spawn(reason: &'static str, outcome: &'static str, began: Instant) {
    crate::telemetry::record(
        "daemon_worker_spawned",
        serde_json::json!({
            "reason": reason,
            "outcome": outcome,
            "startup_ms": began.elapsed().as_millis() as u64,
        }),
    );
}

/// Kills the entire process group `child` leads (see `.process_group(0)` in
/// `WorkerCommand::spawn`), not just the single tracked PID — reaches a
/// `sh -c "<cmd>"` grandchild even when `sh` forked rather than exec'd.
fn kill_process_group(child: &mut Child) {
    let pgid = child.id() as libc::pid_t;
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
    let _ = child.wait();
}

pub struct Worker {
    socket_path: PathBuf,
    cmd: WorkerCommand,
    child: Mutex<Option<Child>>,
    /// Set once shutdown begins, so no thread can spawn a worker after the
    /// process has decided to stop. See [`Worker::shutdown`].
    stopping: AtomicBool,
}

impl Worker {
    pub fn new(socket_path: PathBuf, cmd: WorkerCommand) -> Self {
        Worker {
            socket_path,
            cmd,
            child: Mutex::new(None),
            stopping: AtomicBool::new(false),
        }
    }

    /// Stop the worker, and make sure nothing starts another one.
    ///
    /// Exists because `Drop` was not enough. `main.rs` pre-warms the worker on
    /// a detached thread that holds its own `Arc<Worker>`, so a SIGTERM landing
    /// while that thread is still inside `ensure_started()` — a cold start is
    /// hundreds of milliseconds, and the accept loop returns in tens — left the
    /// refcount above zero when `run()` dropped its own reference. `Worker::drop`
    /// never ran, the worker's process group was never killed, and the daemon
    /// exited leaving it orphaned. Reproduced by this crate's own
    /// `daemon_e2e.rs` (spawn, then terminate immediately) and by every fast
    /// `systemctl restart`.
    ///
    /// The flag is what makes the ordering safe: killing the child first and
    /// then joining the warm-up thread would let a warm-up that was mid-spawn
    /// install a NEW child afterwards. `ensure_started` checks this under the
    /// same lock, so once shutdown has it, no spawn can follow.
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        // Poison-tolerant, deliberately. `if let Ok(guard)` silently skipped the
        // kill on a poisoned lock, so the one situation where a worker most
        // needs reaping — a thread panicked while holding this lock — was
        // exactly the one where the daemon exited and left it orphaned. The
        // guarded state is a `Option<Child>` handle, not an invariant a panic
        // can leave half-built, so there is nothing here to protect by refusing.
        let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = guard.take() {
            kill_process_group(&mut child);
            let _ = std::fs::remove_file(&self.socket_path);
        }
    }

    /// Spawns the worker if it isn't already running (or has died since the
    /// last check), then waits for it to actually accept connections —
    /// failing fast (rather than waiting out the full startup deadline) if
    /// the process exits before ever getting there, e.g. a broken
    /// FAILPROOFAI_WORKER_CMD.
    ///
    /// Readiness is a real `connect()`, not `socket_path.exists()`: a Unix
    /// socket file outlives the process that bound it, so a dead worker
    /// always leaves one behind. `exists()` would see the *previous*
    /// worker's leftover file the instant this one is spawned, break out of
    /// the wait immediately, and hand `call()` a socket nothing is
    /// listening on — `ECONNREFUSED` on every request until the daemon
    /// restarted, which is exactly the crash-recovery path this loop is
    /// here to provide. The stale file is removed first for the same
    /// reason.
    fn ensure_started(&self) -> Result<(), WorkerError> {
        // Poison-tolerant for the same reason as `shutdown()`: an `unwrap()` here
        // turned one panic under this lock into a daemon that answered `Ping`
        // normally and denied every `Hook` request for the rest of its life,
        // because the panic reached only a per-connection handler thread and so
        // never restarted the process that would have cleared it.
        let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        // Checked under the lock, so a warm-up racing shutdown cannot spawn a
        // worker the shutdown has already finished killing.
        if self.stopping.load(Ordering::SeqCst) {
            return Err(WorkerError::Io(io::Error::other("daemon is shutting down")));
        }
        // "Was there a child, and is it gone?" is the whole crash signal. A
        // `Some` that no longer runs is a worker that died between requests —
        // the case that matters, because from the outside it is indistinguishable
        // from a healthy daemon right up until it stops coming back.
        let previous_child = guard.is_some();
        let needs_spawn = match guard.as_mut() {
            Some(child) => !matches!(child.try_wait(), Ok(None)), // Ok(None) == still running
            None => true,
        };
        if needs_spawn {
            let reason = if previous_child { "restart" } else { "initial" };
            let began = Instant::now();
            let _ = std::fs::remove_file(&self.socket_path);
            let mut child = match self.cmd.spawn(&self.socket_path) {
                Ok(child) => child,
                Err(err) => {
                    // The error itself is deliberately NOT reported: an
                    // `io::Error` from a spawn renders the command, which is a
                    // path (and under `FAILPROOFAI_WORKER_CMD` an arbitrary
                    // shell string). It stays in the service log; the outcome
                    // enum is what travels.
                    report_spawn(reason, "spawn_failed", began);
                    return Err(WorkerError::Io(err));
                }
            };
            let deadline = began + Duration::from_secs(5);
            loop {
                if UnixStream::connect(&self.socket_path).is_ok() {
                    break;
                }
                if let Ok(Some(status)) = child.try_wait() {
                    report_spawn(reason, "exited_early", began);
                    return Err(WorkerError::Io(io::Error::other(format!(
                        "worker process exited before creating its socket (status: {status})"
                    ))));
                }
                if Instant::now() >= deadline {
                    kill_process_group(&mut child);
                    let _ = std::fs::remove_file(&self.socket_path);
                    report_spawn(reason, "startup_timeout", began);
                    return Err(WorkerError::StartupTimedOut);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            report_spawn(reason, "ready", began);
            *guard = Some(child);
        }
        Ok(())
    }

    /// Spawns the worker eagerly and blocks until it's ready, without
    /// running a hook through it. Called once from `main.rs` right after
    /// startup so the worker's ~hundreds-of-ms cold start (process spawn +
    /// module load) happens before any real request arrives, not on the
    /// critical path of the first one. The client's fail-closed budget
    /// (`DAEMON_ATTEMPT_TIMEOUT_MS` in `daemon-client.ts`) is deliberately
    /// tight for a *healthy warm* daemon and is not meant to also cover a
    /// cold worker spawn — without this, the very first hook call after
    /// every daemon (re)start would fail closed even though the daemon
    /// itself is up, which defeats the point of keeping evaluation warm.
    /// Errors are logged, not propagated: a failed warm-up isn't fatal to
    /// the daemon itself, since `call()` retries `ensure_started` on the
    /// next real request anyway.
    pub fn warm(&self) {
        if let Err(err) = self.ensure_started() {
            eprintln!("[failproofaid] worker warm-up failed (will retry on first request): {err}");
        }
    }

    /// Relays one hook evaluation to the worker and returns its verdict.
    /// `ensure_started` is called first so a worker that crashed since the
    /// last request gets one restart attempt before this request fails —
    /// but a request already in flight is never retried mid-call; a
    /// failure here surfaces as `WorkerError` and the caller (server.rs)
    /// turns that into a client-facing `Error` response.
    pub fn call(
        &self,
        hook_event: &str,
        cli: &str,
        stdin: &str,
        cwd: Option<&str>,
    ) -> Result<HookOutcome, WorkerError> {
        self.ensure_started()?;

        let mut stream = UnixStream::connect(&self.socket_path).map_err(WorkerError::Io)?;
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .map_err(WorkerError::Io)?;
        // Symmetric with the read timeout, and not optional. `write_message`
        // does a blocking `write_all`: if the worker's single-threaded event
        // loop stalls — a custom policy running synchronous CPU-bound code — it
        // stops draining this socket, and once the kernel send buffer fills, a
        // large enough request blocks the writer with nothing to interrupt it.
        // Nothing reclaims a connection thread in that state, so
        // `MAX_INFLIGHT_CONNECTIONS` fills within 64 requests and the daemon
        // stops answering entirely — the opposite of the fail-fast behaviour
        // the rest of this file is built around.
        stream
            .set_write_timeout(Some(Duration::from_secs(30)))
            .map_err(WorkerError::Io)?;

        let request = json!({
            "type": "hook",
            "hookEvent": hook_event,
            "cli": cli,
            "stdin": stdin,
            "cwd": cwd,
        });
        write_message(&mut stream, &request).map_err(|e| WorkerError::Io(io::Error::other(e)))?;

        let response: serde_json::Value =
            read_message(&mut stream).map_err(|e| WorkerError::Io(io::Error::other(e)))?;

        match response.get("type").and_then(|t| t.as_str()) {
            Some("hookResult") => {
                let exit_code = response
                    .get("exitCode")
                    .and_then(|v| v.as_i64())
                    .ok_or_else(|| WorkerError::BadResponse("missing exitCode".to_string()))?
                    as i32;
                let stdout = response
                    .get("stdout")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let stderr = response
                    .get("stderr")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                Ok(HookOutcome {
                    exit_code,
                    stdout,
                    stderr,
                })
            }
            Some("error") => {
                let message = response
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("worker reported an error")
                    .to_string();
                Err(WorkerError::BadResponse(message))
            }
            _ => Err(WorkerError::BadResponse(response.to_string())),
        }
    }
}

impl Drop for Worker {
    /// Backstop for the paths that do not call [`Worker::shutdown`] explicitly
    /// (tests, and any early return). Idempotent: `take()` yields `None` once
    /// shutdown has already run.
    fn drop(&mut self) {
        // Poison-tolerant, like `shutdown()`. This is the LAST backstop against
        // an orphaned worker process, so declining to run on a poisoned lock
        // gave up precisely when the guarantee mattered most.
        let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = guard.take() {
            kill_process_group(&mut child);
            // The worker's socket file survives the process that bound it,
            // so a clean shutdown has to clear it too — otherwise the next
            // daemon inherits debris that looks, to anything checking the
            // filesystem, like a live worker.
            let _ = std::fs::remove_file(&self.socket_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::Arc;

    fn temp_socket_path(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "failproofaid-worker-test-{}-{}-{}",
            std::process::id(),
            name,
            nanos
        ))
    }

    /// The restart-on-crash path: a worker that died left its socket file
    /// behind, and the supervisor must not read that file's mere existence
    /// as "a worker is listening". Before the readiness probe became a real
    /// `connect()`, this returned `Ok(())` immediately and every later
    /// request hit `ECONNREFUSED` on a dead socket.
    #[test]
    fn a_stale_socket_file_is_not_mistaken_for_a_live_worker() {
        let socket_path = temp_socket_path("stale");
        // Exactly the debris a dead worker leaves: std does not unlink the
        // path when the listener is dropped.
        let listener = UnixListener::bind(&socket_path).unwrap();
        drop(listener);
        assert!(
            socket_path.exists(),
            "premise: a bound-then-dropped socket file outlives its listener"
        );

        // A "worker" that exits without ever binding. The stale file is the
        // only thing on disk that could be mistaken for readiness.
        let worker = Worker::new(socket_path.clone(), WorkerCommand::shell("exit 0"));
        let err = worker
            .call("PreToolUse", "claude", "{}", None)
            .expect_err("a worker that never bound must not report ready");
        assert!(
            err.to_string()
                .contains("exited before creating its socket"),
            "got: {err}"
        );

        std::fs::remove_file(&socket_path).ok();
    }

    /// Readiness against the real worker, over a socket path that already
    /// holds a stale file — the exact shape of a restart after an unclean
    /// exit. `ensure_started` must clear the debris, wait for the new
    /// worker to genuinely accept connections, and `Drop` must leave the
    /// path clean again so the next daemon starts from a blank slate.
    #[test]
    fn restarts_over_a_stale_socket_file_and_cleans_up_on_drop() {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("crates/failproofaid should be two levels under the repo root")
            .to_path_buf();
        let worker_script = repo_root.join("bin").join("failproofai-worker.mjs");

        let socket_path = temp_socket_path("restart-over-stale");
        let listener = UnixListener::bind(&socket_path).unwrap();
        drop(listener);

        let worker = Worker::new(
            socket_path.clone(),
            WorkerCommand::shell(format!("bun {}", worker_script.display())),
        );
        worker
            .ensure_started()
            .expect("the worker should start over the stale file");
        // Ready means *connectable*, not merely "a file is there".
        UnixStream::connect(&socket_path).expect("a ready worker accepts connections");

        drop(worker);
        assert!(
            !socket_path.exists(),
            "Drop should remove the worker socket file"
        );
    }

    /// A worker started by the warm-up path must not survive the daemon.
    ///
    /// The regression: `main.rs` pre-warms on a detached thread holding its own
    /// `Arc<Worker>`, and a SIGTERM landing mid-`ensure_started()` left that
    /// reference alive when `run()` dropped its own — so the refcount never hit
    /// zero, `Drop` never ran, and the process exited with the worker orphaned.
    /// Exercised by `daemon_e2e.rs`'s spawn-then-terminate, and by every fast
    /// `systemctl restart`.
    #[test]
    fn shutdown_kills_the_worker_and_refuses_to_start_another() {
        let socket_path = temp_socket_path("shutdown-race");
        // Long-lived, so a surviving process would be plainly visible.
        let worker = Worker::new(
            socket_path.clone(),
            WorkerCommand::shell(format!(
                "sleep 60 & nc -lU {} >/dev/null 2>&1 || sleep 60",
                socket_path.display()
            )),
        );

        worker.shutdown();

        // The whole point of the flag: after shutdown nothing may spawn,
        // however late it arrives. Without it, a warm-up still inside
        // `ensure_started` would install a fresh child AFTER the kill.
        let err = worker
            .ensure_started()
            .expect_err("no worker may start once shutdown has begun");
        assert!(
            err.to_string().contains("shutting down"),
            "expected a shutdown refusal, got {err}"
        );
        assert!(worker.child.lock().unwrap().is_none());

        // Idempotent — `Drop` runs it again as a backstop.
        worker.shutdown();
    }

    /// A panic under the `child` lock must not permanently disable the worker.
    ///
    /// `WorkerCommand::spawn` used bare `std::thread::spawn` for the two output
    /// drainers, and `ensure_started` calls it while holding this lock — so an
    /// OS refusal to create a thread panicked mid-guard and POISONED it. The
    /// daemon did not crash (the unwind stops at the per-connection handler
    /// thread), so it kept answering `Ping` and looking healthy while every
    /// `Hook` request panicked on `lock().unwrap()` for the rest of the
    /// process's life, and `shutdown()`/`Drop` silently stopped reaping the
    /// worker. Both halves are fixed: the spawn cannot panic, and the lock is
    /// no longer treated as unusable when it is merely poisoned.
    #[test]
    fn a_poisoned_child_lock_does_not_wedge_the_worker() {
        let socket_path = temp_socket_path("poisoned");
        let worker = Arc::new(Worker::new(socket_path, WorkerCommand::shell("true")));

        // Poison it exactly as a panic under the guard would.
        let poisoner = Arc::clone(&worker);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.child.lock().unwrap();
            panic!("poisoning the child lock");
        })
        .join();
        assert!(
            worker.child.lock().is_err(),
            "test precondition: the lock should now be poisoned"
        );

        // The real assertion: still reachable. `ensure_started` must return a
        // normal error (this command exits immediately and never binds a
        // socket) rather than panicking on the poison.
        let err = worker
            .ensure_started()
            .expect_err("`true` exits without ever creating a worker socket");
        assert!(
            !err.to_string().is_empty(),
            "expected a reported failure, not a panic"
        );

        // And the reaping paths still run rather than silently skipping.
        worker.shutdown();
        assert!(
            worker
                .child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_none()
        );
    }
}
