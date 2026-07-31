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
        // Packaging (Stage 5) lands dist/worker.mjs; until then this is only
        // reachable via the explicit override above in dev/test.
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
            // alone and close cleanly when the worker does. The worker's
            // own startup line is a single short write, well within a
            // pipe's OS buffer, so leaving these unread never blocks it.
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // New session + process group leader: `sh -c "<cmd>"` is not
            // guaranteed to exec(2) into `<cmd>` in place (some shells fork
            // instead), so killing only the tracked PID can leave a real
            // grandchild worker process running, reparented and orphaned.
            // Killing the whole group (see `kill_process_group`) reaches it
            // either way.
            .process_group(0);
        command.spawn()
    }
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
}

impl Worker {
    pub fn new(socket_path: PathBuf, cmd: WorkerCommand) -> Self {
        Worker {
            socket_path,
            cmd,
            child: Mutex::new(None),
        }
    }

    /// Spawns the worker if it isn't already running (or has died since the
    /// last check), then waits for its socket file to appear — failing fast
    /// (rather than waiting out the full startup deadline) if the process
    /// exits before ever creating one, e.g. a broken FAILPROOFAI_WORKER_CMD.
    fn ensure_started(&self) -> Result<(), WorkerError> {
        let mut guard = self.child.lock().unwrap();
        let needs_spawn = match guard.as_mut() {
            Some(child) => !matches!(child.try_wait(), Ok(None)), // Ok(None) == still running
            None => true,
        };
        if needs_spawn {
            let mut child = self.cmd.spawn(&self.socket_path).map_err(WorkerError::Io)?;
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if self.socket_path.exists() {
                    break;
                }
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(WorkerError::Io(io::Error::other(format!(
                        "worker process exited before creating its socket (status: {status})"
                    ))));
                }
                if Instant::now() >= deadline {
                    kill_process_group(&mut child);
                    return Err(WorkerError::StartupTimedOut);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            *guard = Some(child);
        }
        Ok(())
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
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock()
            && let Some(mut child) = guard.take()
        {
            kill_process_group(&mut child);
        }
    }
}
