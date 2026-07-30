//! The Unix-socket listener and the single enforcement lane.
//!
//! ## Shape, and why it is threads rather than an async runtime
//!
//! A QuickJS context is tied to the thread that created it — it is not `Send`.
//! That is not an obstacle to work around; it maps exactly onto what the
//! architecture already calls for. There is **one warm sealed worker** on
//! **one enforcement lane**, so the daemon runs one worker thread that owns the
//! context, and every connection hands it work over a channel and waits.
//!
//! An async executor would buy nothing here and cost something real. The
//! enforcement lane is deliberately synchronous and deadline-bounded: the
//! worker pumps QuickJS's microtask queue by hand precisely so the deadline can
//! be checked *between* jobs, and handing that loop to an executor would take
//! that away. Collection and delivery — the lanes that are genuinely I/O-bound
//! — land in later stages and can bring their own runtime without disturbing
//! this one.
//!
//! ## What the socket boundary is for
//!
//! `home` is derived here, from `getpwuid_r(peer_uid)`, where `peer_uid` comes
//! from the kernel via `SO_PEERCRED`. Nothing a client sends can influence it,
//! and a client that tries is rejected rather than corrected.
//!
//! In user scope this is no longer a privilege boundary — the daemon, the hook
//! client, and the agent being governed are all the same user — and it is not
//! claimed as one. It is narrower and still worth having.
//! `isAgentInternalPath` and `block-read-outside-cwd` both *widen* the allow
//! set, so a `home` that is wrong in either direction relaxes a verdict
//! silently; deriving it from the kernel's view of the peer means a buggy
//! client, a stale environment, or a second implementation that guessed cannot
//! produce that. And "it is not accepted" stays the contract rather than "we
//! overwrite it anyway", because the second one leaves the field looking
//! supported to the next client author.

use std::io;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;
use std::time::{Duration, Instant};

use fpai_ipc::envelope::{SUPPORTED_PROTOCOL_VERSIONS, is_supported_protocol_version};
use fpai_ipc::{
    Attestation, ClientHandshake, Decision, ErrorCode, EvaluateHook, Evaluated, FrameError,
    HelloAck, Op, OpResult, Ping, Pong, Request, Response, ServerHandshake, VersionMismatch,
    home_for_uid, peer_credentials, read_frame, write_frame,
};

use crate::worker::{SealedWorker, WorkerError};

const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Ceiling on the deadline a client may request.
///
/// A client asking for a 10-minute budget would pin the single enforcement lane
/// for ten minutes and stall every other user on the machine. The cap is a
/// property of the lane being shared, not of any one request.
const MAX_DEADLINE: Duration = Duration::from_secs(5);

/// How long past its own deadline a request will wait for the shared lane.
///
/// The lane is single-threaded, so a request's wall-clock wait is its own
/// evaluation *plus* everything queued ahead of it. This is the allowance for
/// that queue. Past it, the connection thread stops waiting and reports lane
/// pressure — the client gave up long ago and fell back to legacy, so
/// continuing to wait accomplishes nothing and costs a parked thread.
const LANE_QUEUE_GRACE: Duration = Duration::from_secs(5);

/// What the worker thread accepts.
struct Job {
    request_json: String,
    deadline: Duration,
    reply: Sender<Result<String, WorkerError>>,
}

/// A handle to the enforcement lane. Cheap to clone; sends are queued.
#[derive(Clone)]
pub struct Lane {
    tx: Sender<Job>,
    generation_id: Arc<String>,
}

impl Lane {
    /// Start the worker thread and load the sealed bundle.
    ///
    /// Returns only once the bundle has loaded, so a caller can treat a
    /// successful return as readiness. `Type=notify` on the systemd unit
    /// depends on that: `systemctl start` must block until the socket is bound
    /// *and* the evaluator is live, so setup's readiness check is a second
    /// independent verification rather than the only one.
    pub fn start() -> Result<(Self, thread::JoinHandle<()>), WorkerError> {
        let (ready_tx, ready_rx) = channel::<Result<String, String>>();
        let (tx, rx) = channel::<Job>();

        let handle = thread::Builder::new()
            .name("fpai-sealed".into())
            .spawn(move || worker_loop(rx, ready_tx))
            .map_err(|e| WorkerError::BundleLoad(format!("could not spawn worker thread: {e}")))?;

        match ready_rx.recv() {
            Ok(Ok(generation_id)) => Ok((
                Self {
                    tx,
                    generation_id: Arc::new(generation_id),
                },
                handle,
            )),
            Ok(Err(message)) => Err(WorkerError::BundleLoad(message)),
            Err(_) => Err(WorkerError::BundleLoad(
                "worker thread exited before reporting readiness".into(),
            )),
        }
    }

    /// The active generation's identity, reported in every response.
    #[must_use]
    pub fn generation_id(&self) -> &str {
        &self.generation_id
    }

    fn submit(&self, request_json: String, deadline: Duration) -> Result<String, WorkerError> {
        let (reply_tx, reply_rx) = channel();
        self.tx
            .send(Job {
                request_json,
                deadline,
                reply: reply_tx,
            })
            .map_err(|_| WorkerError::Evaluation("enforcement lane is not running".into()))?;

        // `recv_timeout`, never a bare `recv`. The lane is shared and requests
        // queue, so this call waits for however long everything ahead of it
        // takes — not just for this request's own deadline. A bare `recv` parks
        // the connection thread with no upper bound, and since the client has
        // already given up at its own (shorter) budget and fallen back to
        // legacy, that thread is waiting for an answer nobody will read.
        //
        // Measured before this: one runaway request left one permanently
        // blocked thread per subsequent hook event, growing without limit.
        // `serve()` propagates a failed `accept` or `spawn`, so the first
        // EMFILE/EAGAIN returned `Err` out of the listener and the daemon
        // exited — escalating "no daemon answers" into "the daemon is gone".
        //
        // The bound is the queue budget, not the deadline: `LANE_QUEUE_GRACE`
        // past this request's own deadline covers a reasonable amount of work
        // ahead of it, and anything beyond that is reported as lane pressure
        // rather than waited on.
        match reply_rx.recv_timeout(deadline + LANE_QUEUE_GRACE) {
            Ok(outcome) => outcome,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(WorkerError::DeadlineExceeded {
                elapsed: deadline + LANE_QUEUE_GRACE,
            }),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(WorkerError::Evaluation(
                "worker thread died mid-evaluation".into(),
            )),
        }
    }
}

fn worker_loop(rx: Receiver<Job>, ready: Sender<Result<String, String>>) {
    let worker = match SealedWorker::new() {
        Ok(w) => w,
        Err(e) => {
            let _ = ready.send(Err(e.to_string()));
            return;
        }
    };

    // The generation identity. Stage 1 has exactly one generation — the
    // builtins compiled into the bundle — so it is derived from the bundle's
    // own content rather than invented. Later stages resolve configuration and
    // user policy sources into it; the shape of the identifier does not change.
    let generation_id = match worker.policy_names() {
        Ok(names) => format!("gen-{:016x}", fnv1a(&names.join(","))),
        Err(e) => {
            let _ = ready.send(Err(e.to_string()));
            return;
        }
    };

    if ready.send(Ok(generation_id)).is_err() {
        return; // nobody is listening; the daemon is shutting down
    }

    while let Ok(job) = rx.recv() {
        let outcome = worker.evaluate(&job.request_json, job.deadline);
        // A dropped receiver means the connection went away mid-evaluation.
        // Not an error: the client already fell back to legacy.
        let _ = job.reply.send(outcome);
    }
}

/// FNV-1a, for a short stable content identifier.
///
/// Not a security primitive and not used as one — the generation ID exists for
/// cache invalidation and decision evidence, and the design doc is explicit
/// that a content digest "is not treated as publisher authentication".
fn fnv1a(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

/// The daemon: a bound listener plus the enforcement lane behind it.
pub struct Daemon {
    listener: UnixListener,
    socket_path: PathBuf,
    lane: Lane,
    started: Instant,
    decisions: Arc<AtomicU64>,
}

impl Daemon {
    /// Bind `socket_path` and start the enforcement lane.
    ///
    /// The parent directory is created if it is missing. That is not
    /// convenience: in user scope nothing else creates it. The managed design
    /// had a privileged installer lay down `/run/failproofai` before the
    /// service ever started, and dropping that installer left
    /// `~/.failproofai/run/` — and `$XDG_RUNTIME_DIR/failproofai/`, which the
    /// runtime directory does not contain either — with no owner. A daemon that
    /// only bound would fail `ENOENT` on every first start on every machine.
    ///
    /// A stale socket file from a previous run is removed first. In user scope
    /// that is not the guarded operation it would have been under a service
    /// account: the directory belongs to this user, so this user can already
    /// unlink the socket and bind an impostor, and no mode on the file changes
    /// that. It is unlinked because a crashed predecessor otherwise makes every
    /// subsequent start fail `EADDRINUSE`, and for no stronger reason than
    /// that.
    pub fn bind(socket_path: impl AsRef<Path>) -> io::Result<Self> {
        let socket_path = socket_path.as_ref().to_path_buf();
        if let Some(parent) = socket_path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
            // 0o700 on the directory, set after the fact so it applies whether
            // or not `create_dir_all` had anything to do — an existing
            // group-readable directory from an older build is tightened rather
            // than trusted. Only this user should be able to reach the socket.
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
        if socket_path.exists() {
            std::fs::remove_file(&socket_path)?;
        }
        let listener = UnixListener::bind(&socket_path)?;

        // 0o600, not 0o660. The group bit existed for a managed install where
        // enrolled users reached a service account's socket through a shared
        // group; in user scope the daemon serves exactly one user, and the
        // group here is that user's primary group, which on several
        // distributions contains other people.
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;

        let (lane, _handle) = Lane::start().map_err(|e| io::Error::other(e.to_string()))?;

        Ok(Self {
            listener,
            socket_path,
            lane,
            started: Instant::now(),
            decisions: Arc::new(AtomicU64::new(0)),
        })
    }

    /// The bound socket path.
    #[must_use]
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// The active generation identity.
    #[must_use]
    pub fn generation_id(&self) -> &str {
        self.lane.generation_id()
    }

    /// Accept and serve connections until the listener errors.
    ///
    /// One thread per connection. Stage 1 has a single client per hook event
    /// with a request/response lifetime measured in milliseconds, so a thread
    /// is cheaper than the machinery to avoid one; the shared resource that
    /// actually needs bounding is the enforcement lane, and it is a channel.
    pub fn serve(&self) -> io::Result<()> {
        for stream in self.listener.incoming() {
            let stream = stream?;
            let lane = self.lane.clone();
            let started = self.started;
            let decisions = Arc::clone(&self.decisions);
            thread::Builder::new()
                .name("fpai-conn".into())
                .spawn(move || {
                    // A failed connection is logged and dropped. It must never
                    // take down the listener — one malformed client cannot be
                    // allowed to stop enforcement for the whole machine.
                    if let Err(e) = serve_connection(&stream, &lane, started, &decisions) {
                        eprintln!("[failproofaid] connection error: {e}");
                    }
                })?;
        }
        Ok(())
    }

    /// Serve exactly one connection, in this thread. For tests and `--oneshot`.
    pub fn serve_one(&self) -> io::Result<()> {
        let (stream, _) = self.listener.accept()?;
        serve_connection(&stream, &self.lane, self.started, &self.decisions)
    }

    /// Decisions returned since start, for the health snapshot.
    #[must_use]
    pub fn decision_count(&self) -> u64 {
        self.decisions.load(Ordering::Relaxed)
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        // Best-effort: a leftover socket file would make the next bind remove
        // it anyway, but leaving one behind makes `status` ambiguous.
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

fn serve_connection(
    stream: &UnixStream,
    lane: &Lane,
    started: Instant,
    decisions: &AtomicU64,
) -> io::Result<()> {
    // Peer credentials FIRST, from the kernel, before a single byte of the
    // client's own claims is trusted for anything.
    let peer = peer_credentials(stream)?;

    // And then actually *use* them to refuse a stranger.
    //
    // This check was documented before it existed. An earlier revision read the
    // peer UID and used it only to derive `home`, while `PROTOCOL.md` and the
    // commit that introduced it both described peer credentials as a "this
    // connection is mine" check that keeps other users out. It did not: a peer
    // of any UID was served, with *their* home derived, and the only thing
    // actually keeping them out was the socket's file mode.
    //
    // Defence in depth is the point. `0600` on the socket and `0700` on its
    // directory are the first line and are enough on a correctly-created
    // install — but they are filesystem state, and filesystem state drifts: a
    // permissive umask at creation, a directory restored from a backup, a
    // `chmod` by a well-meaning script, a future code path that creates the
    // socket somewhere else. This check does not drift, because it compares two
    // numbers the kernel supplies.
    //
    // v1.0.0 is user scope, so the daemon serves exactly one UID: its own. This
    // is not a privilege boundary — the owning user can stop the daemon, edit
    // its config, or `ptrace` it — it is an isolation rule between *different*
    // users on a shared machine.
    let daemon_uid = fpai_ipc::current_uid();
    if peer.uid != daemon_uid {
        eprintln!(
            "[failproofaid] refusing connection from uid {} (this daemon serves uid {} only)",
            peer.uid, daemon_uid
        );
        return Ok(());
    }

    let mut reader = stream;
    let mut writer = stream;

    // -- handshake --
    let hello_bytes = match read_frame(&mut reader) {
        Ok(b) => b,
        Err(FrameError::Closed) => return Ok(()), // clean disconnect before saying anything
        Err(e) => return Err(io::Error::other(e.to_string())),
    };
    let hello: ClientHandshake = match serde_json::from_slice(&hello_bytes) {
        Ok(h) => h,
        Err(e) => return Err(io::Error::other(format!("malformed handshake: {e}"))),
    };
    let ClientHandshake::Hello(hello) = hello;

    if !is_supported_protocol_version(hello.protocol_version) {
        let reply = ServerHandshake::VersionMismatch(VersionMismatch {
            supported: SUPPORTED_PROTOCOL_VERSIONS.to_vec(),
            received: hello.protocol_version,
        });
        write_frame(&mut writer, &serde_json::to_vec(&reply)?)
            .map_err(|e| io::Error::other(e.to_string()))?;
        // Then close. The client falls back to legacy; it must not guess a
        // version or retry.
        return Ok(());
    }

    let ack = ServerHandshake::HelloAck(HelloAck {
        protocol_version: fpai_ipc::PROTOCOL_VERSION,
        daemon_version: DAEMON_VERSION.to_string(),
        generation_id: lane.generation_id().to_string(),
    });
    write_frame(&mut writer, &serde_json::to_vec(&ack)?)
        .map_err(|e| io::Error::other(e.to_string()))?;

    // -- request/response --
    loop {
        let body = match read_frame(&mut reader) {
            Ok(b) => b,
            Err(FrameError::Closed) => return Ok(()),
            Err(FrameError::TooLarge { declared, .. }) => {
                // Answering at all is best-effort: there is no request_id to
                // echo, because the frame carrying it is the one we refused.
                let reply = Response::error(
                    "",
                    ErrorCode::FrameTooLarge,
                    format!("declared body of {declared} bytes exceeds the 1 MiB maximum"),
                );
                let _ = write_frame(&mut writer, &serde_json::to_vec(&reply)?);
                return Ok(());
            }
            Err(e) => {
                let reply = Response::error("", ErrorCode::MalformedFrame, e.to_string());
                let _ = write_frame(&mut writer, &serde_json::to_vec(&reply)?);
                return Ok(());
            }
        };

        let request: Request = match serde_json::from_slice(&body) {
            Ok(r) => r,
            Err(e) => {
                let reply = Response::error("", ErrorCode::MalformedFrame, e.to_string());
                write_frame(&mut writer, &serde_json::to_vec(&reply)?)
                    .map_err(|err| io::Error::other(err.to_string()))?;
                return Ok(());
            }
        };

        let response = match request.op {
            Op::Ping(Ping {}) => Response {
                request_id: request.request_id,
                result: OpResult::Pong(Pong {
                    daemon_version: DAEMON_VERSION.to_string(),
                    uptime_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                }),
            },
            Op::EvaluateHook(hook) => {
                let r = handle_evaluate(*hook, &request.request_id, peer.uid, lane);
                if matches!(r.result, OpResult::Evaluated(_)) {
                    decisions.fetch_add(1, Ordering::Relaxed);
                }
                r
            }
        };

        write_frame(&mut writer, &serde_json::to_vec(&response)?)
            .map_err(|e| io::Error::other(e.to_string()))?;
    }
}

fn handle_evaluate(hook: EvaluateHook, request_id: &str, uid: u32, lane: &Lane) -> Response {
    // Envelope validation before anything else: a client-asserted `home` or an
    // unknown env fact is refused outright rather than sanitised.
    if let Err(e) = hook.host.validate() {
        return Response::error(request_id, e.code(), e.to_string());
    }

    // `home` is derived here, never received. A `getpwuid_r` miss is an error,
    // not a fallback to some default — a wrong home widens the allow set.
    let home = match home_for_uid(uid) {
        Ok(h) => h.to_string_lossy().into_owned(),
        Err(e) => {
            return Response::error(
                request_id,
                ErrorCode::Internal,
                format!("could not resolve the home directory for uid {uid}: {e}"),
            );
        }
    };

    // An empty enabled set is refused rather than treated as "enforce
    // nothing" or quietly backfilled with the builtin defaults. Both of those
    // answer a question the client did not ask, and one of them enforces a
    // policy set the user never configured.
    if hook.enabled_policies.is_empty() {
        return Response::error(
            request_id,
            ErrorCode::MalformedFrame,
            "evaluate_hook carried no enabled_policies; the client must send its resolved set",
        );
    }

    let deadline = Duration::from_millis(hook.deadline_ms).min(MAX_DEADLINE);

    // The sealed worker speaks the shape in `src/policy-runtime/sealed-entry.ts`.
    let sealed_request = serde_json::json!({
        "eventType": hook.event_type,
        "payload": hook.payload,
        "session": {
            "cli": hook.cli,
            "sessionId": hook.session.session_id,
            "transcriptPath": hook.session.transcript_path,
            "permissionMode": hook.session.permission_mode,
            "hookEventName": hook.session.hook_event_name,
            "cwd": hook.host.cwd,
            "projectDir": hook.host.project_dir,
            "home": home,
        },
        // The client's resolved enabled set, not a set of the daemon's own.
        // See `EvaluateHook::enabled_policies` for why that distinction is the
        // difference between the daemon enforcing what the user configured and
        // it silently enforcing eleven builtins. The worker partitions this and
        // reports anything it cannot run as `needs_user_context`; the client
        // treats a non-empty list as "fall back to legacy".
        //
        // An empty list means the client sent nothing to evaluate, which is a
        // client bug rather than "enforce nothing" — falling back to the
        // builtin defaults would enforce a set the user never chose, so it is
        // refused above instead.
        "config": { "enabledPolicies": hook.enabled_policies },
    });

    let raw = match lane.submit(sealed_request.to_string(), deadline) {
        Ok(raw) => raw,
        Err(WorkerError::DeadlineExceeded { elapsed }) => {
            return Response::error(
                request_id,
                ErrorCode::DeadlineExceeded,
                format!("sealed evaluation exceeded its budget after {elapsed:?}"),
            );
        }
        Err(e) => return Response::error(request_id, ErrorCode::Internal, e.to_string()),
    };

    let parsed: SealedResponse = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(e) => {
            return Response::error(
                request_id,
                ErrorCode::Internal,
                format!("sealed worker returned an unreadable response: {e}"),
            );
        }
    };

    let SealedResponse::Ok {
        ok: _,
        result,
        needs_user_context,
        read_client_asserted_host,
    } = parsed
    else {
        let SealedResponse::Err { error, .. } = parsed else {
            unreachable!()
        };
        // An evaluation failure is reported as one. It is never converted into
        // an allow — that is what makes a tripped circuit breaker visible
        // instead of silently permissive.
        return Response::error(request_id, ErrorCode::Internal, error);
    };

    let decision = match result.decision.as_str() {
        "deny" => Decision::Deny,
        "instruct" => Decision::Instruct,
        _ => Decision::Allow,
    };

    // Honest attestation: a decision that read a client-asserted field is
    // `sealed_unattested`, not `sealed`.
    let attestation = if read_client_asserted_host {
        Attestation::SealedUnattested
    } else {
        Attestation::Sealed
    };

    let decision_id = format!(
        "dec-{:016x}",
        fnv1a(&format!(
            "{request_id}{}{}",
            result.exit_code, result.stdout
        ))
    );

    Response {
        request_id: request_id.to_string(),
        result: OpResult::Evaluated(Box::new(Evaluated {
            decision_id,
            generation_id: lane.generation_id().to_string(),
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            decision,
            policy_name: result.policy_name,
            policy_names: result.policy_names,
            reason: result.reason,
            attestation,
            matched_policies: Vec::new(),
            // Stage 1 evaluates sealed-only. A client seeing this non-empty
            // falls back to legacy rather than silently dropping a user's
            // mutable policies.
            needs_user_context,
        })),
    }
}

/// The sealed worker's reply shape. Mirrors `SealedResponse` / `SealedError` in
/// `src/policy-runtime/sealed-entry.ts`.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum SealedResponse {
    Ok {
        #[allow(dead_code)]
        ok: OkTrue,
        result: SealedResult,
        #[serde(rename = "needsUserContext")]
        needs_user_context: Vec<String>,
        #[serde(rename = "readClientAssertedHost")]
        read_client_asserted_host: bool,
    },
    Err {
        #[allow(dead_code)]
        ok: OkFalse,
        error: String,
    },
}

/// Literal `true` / `false` discriminants, so `untagged` cannot pick the wrong
/// arm on a response that happens to have overlapping fields.
#[derive(serde::Deserialize)]
#[serde(try_from = "bool")]
struct OkTrue;
impl TryFrom<bool> for OkTrue {
    type Error = &'static str;
    fn try_from(v: bool) -> Result<Self, &'static str> {
        if v {
            Ok(Self)
        } else {
            Err("expected ok: true")
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(try_from = "bool")]
struct OkFalse;
impl TryFrom<bool> for OkFalse {
    type Error = &'static str;
    fn try_from(v: bool) -> Result<Self, &'static str> {
        if v {
            Err("expected ok: false")
        } else {
            Ok(Self)
        }
    }
}

#[derive(serde::Deserialize)]
struct SealedResult {
    #[serde(rename = "exitCode")]
    exit_code: i32,
    stdout: String,
    stderr: String,
    decision: String,
    #[serde(rename = "policyName")]
    policy_name: Option<String>,
    #[serde(rename = "policyNames")]
    #[serde(default)]
    policy_names: Option<Vec<String>>,
    reason: Option<String>,
}
