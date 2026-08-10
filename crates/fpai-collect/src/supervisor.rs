//! Fault-isolated host for every collector task.
//!
//! # Why this exists at all
//!
//! `failproofai` fails CLOSED. Once a machine is daemon-configured, the CLI
//! turns an unreachable daemon into a *deny* rather than a fallback — see
//! `bin/failproofai.mjs`. So anything that can take the daemon process down,
//! or wedge it, blocks every tool call across every supported agent CLI on
//! that machine.
//!
//! Collection is strictly lower-value than enforcement: shipping a session log
//! late, or not at all, is a gap in a dashboard. Denying every tool call is a
//! developer who cannot work. This module exists to make that asymmetry
//! structural rather than aspirational, so a bug in a transform for some
//! agent's log format can never become an outage.
//!
//! # The three guarantees
//!
//! 1. **Own thread, own runtime.** The collector never runs on the socket
//!    server's threads. `failproofaid`'s accept loop stays blocking `std`,
//!    unchanged — converting it would mean rewriting the connection handling
//!    whose non-blocking/BSD-`accept` subtleties are the reason macOS worked
//!    at all, and re-earning trust in the exact code path that gates tool
//!    calls. Not worth it to host a background uploader.
//! 2. **A panic is contained and logged, never propagated.** Every task body
//!    runs inside `catch_unwind`. A panicking task is restarted with backoff;
//!    it does not unwind into the runtime, does not abort the process, and
//!    does not mark the daemon unhealthy.
//! 3. **Shutdown is bounded.** The supervisor observes the same shutdown flag
//!    the socket server does, and `join_with_flush` waits only a fixed budget
//!    for tasks to drain before giving up on them. A collector task that hangs
//!    delays process exit by that budget and no more.
//!
//! # What this deliberately does NOT do
//!
//! It does not restart forever at full speed, and it does not treat a task
//! that exits cleanly as a failure. A task returning `Ok(())` has finished its
//! work; only an `Err` or a panic is a restart, and each consecutive one backs
//! off further so a task that is broken rather than merely unlucky cannot spin
//! the CPU behind a user's back.

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

/// How long `join_with_flush` waits for the collector thread after asking it
/// to stop. Long enough for an in-flight spool write to finish; short enough
/// that a wedged task cannot hold up a `systemctl stop` past its own timeout.
pub const DEFAULT_FLUSH_BUDGET: Duration = Duration::from_secs(5);

/// First restart delay after a task fails. Doubles per consecutive failure.
const BACKOFF_START: Duration = Duration::from_secs(1);
/// Ceiling for the restart delay. A permanently broken task settles here
/// rather than retrying tightly forever.
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// How often the supervisor re-checks the shutdown flag while idle or backing
/// off. Shutdown latency is bounded by this, so it stays well under the flush
/// budget.
const SHUTDOWN_POLL: Duration = Duration::from_millis(100);

/// Worker threads for the collector runtime. Two is deliberate: the workload
/// is IO-bound (file reads, HTTP), and every thread here is one the OS
/// schedules against the socket server's handler threads.
const RUNTIME_WORKER_THREADS: usize = 2;

type TaskFuture = Pin<Box<dyn Future<Output = Result<(), TaskError>> + Send>>;
type TaskFactory = Box<dyn Fn(Shutdown) -> TaskFuture + Send + Sync>;

/// A task's view of "should I stop?".
///
/// Every collector task is a poll loop, so the supervisor checking between
/// attempts is not enough on its own — a loop that never returns would only be
/// noticed once its flush budget expired, and it would be killed mid-iteration
/// rather than stopping at a safe point. Handing this to the task body lets it
/// exit at the top of a loop, after its cursor has been persisted.
///
/// Cheap to clone; both flags are shared. `daemon` is the socket server's own
/// flag, so a SIGTERM is observed here without a second signal path.
#[derive(Clone)]
pub struct Shutdown {
    daemon: Arc<AtomicBool>,
    collector: Arc<AtomicBool>,
}

impl Shutdown {
    /// Build one directly from a daemon flag, for tests and for callers that
    /// drive a task outside the supervisor. Production code receives this from
    /// the supervisor instead, which is why the fields stay private.
    #[doc(hidden)]
    pub fn for_test(daemon: Arc<AtomicBool>) -> Self {
        Shutdown {
            daemon,
            collector: Arc::new(AtomicBool::new(false)),
        }
    }

    /// True once either the daemon or the collector has been asked to stop.
    pub fn is_set(&self) -> bool {
        self.daemon.load(Ordering::Relaxed) || self.collector.load(Ordering::Relaxed)
    }

    /// Sleep for `dur`, returning early if shutdown is requested.
    ///
    /// Returns `true` if the full duration elapsed, `false` if it was cut
    /// short. Poll loops should use this rather than `tokio::time::sleep` so a
    /// 60-second poll interval does not become 60 seconds of shutdown latency.
    pub async fn sleep(&self, dur: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + dur;
        loop {
            if self.is_set() {
                return false;
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return true;
            }
            tokio::time::sleep(SHUTDOWN_POLL.min(deadline - now)).await;
        }
    }
}

/// Why a task stopped. Only used for logging and the restart decision — the
/// supervisor treats every failure the same way.
#[derive(Debug)]
pub struct TaskError(pub String);

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for TaskError {}

impl From<String> for TaskError {
    fn from(s: String) -> Self {
        TaskError(s)
    }
}

impl From<&str> for TaskError {
    fn from(s: &str) -> Self {
        TaskError(s.to_string())
    }
}

/// One supervised unit of collector work.
///
/// `factory` is called afresh for every attempt rather than the future being
/// built once, because a restarted task must start from a clean state — a
/// future that already failed cannot be polled again, and reusing one would
/// silently make "restart" mean "give up".
pub struct TaskSpec {
    pub name: &'static str,
    factory: TaskFactory,
}

impl TaskSpec {
    pub fn new<F, Fut>(name: &'static str, factory: F) -> Self
    where
        F: Fn(Shutdown) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), TaskError>> + Send + 'static,
    {
        TaskSpec {
            name,
            factory: Box::new(move |sd| Box::pin(factory(sd))),
        }
    }
}

/// Counters a caller (or a test) can read without stopping the supervisor.
/// Public because the daemon's health record reports them: a task that is
/// quietly restarting in a loop must be visible, not merely absent.
#[derive(Debug, Default)]
pub struct SupervisorMetrics {
    /// Times a task returned `Err`.
    pub failures: AtomicUsize,
    /// Times a task panicked. Tracked separately from `failures` because a
    /// panic is a bug in the collector, while an `Err` is usually the
    /// environment (a vanished directory, a refused connection).
    pub panics: AtomicUsize,
    /// Times a task was started, including the first.
    pub starts: AtomicUsize,
}

/// Handle to a running collector. Dropping it does NOT stop the collector —
/// call [`CollectorHandle::join_with_flush`], so shutdown stays explicit and
/// ordered relative to the socket server's own teardown.
pub struct CollectorHandle {
    thread: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    metrics: Arc<SupervisorMetrics>,
}

impl CollectorHandle {
    pub fn metrics(&self) -> Arc<SupervisorMetrics> {
        self.metrics.clone()
    }

    /// Ask every task to stop, then wait up to `budget` for the collector
    /// thread to finish.
    ///
    /// Returns `true` if it drained in time. On `false` the thread is
    /// abandoned deliberately rather than blocked on: the process is already
    /// exiting, and the alternative — waiting indefinitely on a task that has
    /// wedged — is the hang this whole module exists to prevent.
    pub fn join_with_flush(mut self, budget: Duration) -> bool {
        self.stop.store(true, Ordering::Relaxed);
        let Some(thread) = self.thread.take() else {
            return true;
        };

        // `JoinHandle` has no timed join in std, so poll `is_finished` and
        // only then join (which is guaranteed not to block once finished).
        let deadline = std::time::Instant::now() + budget;
        while std::time::Instant::now() < deadline {
            if thread.is_finished() {
                let _ = thread.join();
                return true;
            }
            std::thread::sleep(SHUTDOWN_POLL);
        }
        tracing::warn!(
            budget_ms = budget.as_millis() as u64,
            "collector did not drain within its flush budget; abandoning it so process exit is not blocked"
        );
        false
    }
}

/// Start the collector on its own thread with its own Tokio runtime.
///
/// `shutdown` is the daemon's existing flag, observed rather than owned, so a
/// SIGTERM stops the collector and the socket server through one signal path.
///
/// Returns `None` when there is nothing to run. That is the normal state on a
/// machine that has not opted in to collection: no thread is spawned, no
/// runtime is created, and the daemon behaves exactly as it does today.
pub fn spawn_supervised(
    tasks: Vec<TaskSpec>,
    shutdown: Arc<AtomicBool>,
) -> Option<CollectorHandle> {
    if tasks.is_empty() {
        tracing::debug!("collector has no enabled tasks; not starting a runtime");
        return None;
    }

    let stop = Arc::new(AtomicBool::new(false));
    let metrics = Arc::new(SupervisorMetrics::default());

    let thread_stop = stop.clone();
    let thread_metrics = metrics.clone();
    let thread = std::thread::Builder::new()
        .name("fpai-collect".to_string())
        .spawn(move || {
            // Building the runtime can fail (thread/fd exhaustion). That must
            // degrade to "no collection" and never to a panic on a thread the
            // daemon does not join.
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(RUNTIME_WORKER_THREADS)
                .enable_all()
                .thread_name("fpai-collect-rt")
                .build()
            {
                Ok(rt) => rt,
                Err(err) => {
                    tracing::error!(%err, "collector runtime failed to start; collection is off for this process");
                    return;
                }
            };

            runtime.block_on(run_all(tasks, shutdown, thread_stop, thread_metrics));

            // Do not let a task that ignored shutdown hold the thread here:
            // the caller's flush budget is the only bound we promise, and
            // `Runtime::drop` would otherwise wait for every blocking task.
            runtime.shutdown_timeout(Duration::from_secs(1));
        });

    match thread {
        Ok(thread) => Some(CollectorHandle {
            thread: Some(thread),
            stop,
            metrics,
        }),
        Err(err) => {
            tracing::error!(%err, "could not spawn the collector thread; collection is off for this process");
            None
        }
    }
}

/// Supervise every task concurrently until either shutdown flag is set.
async fn run_all(
    tasks: Vec<TaskSpec>,
    shutdown: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    metrics: Arc<SupervisorMetrics>,
) {
    let mut set = tokio::task::JoinSet::new();
    let task_count = tasks.len();
    for spec in tasks {
        let shutdown = shutdown.clone();
        let stop = stop.clone();
        let metrics = metrics.clone();
        set.spawn(async move { supervise_one(spec, shutdown, stop, metrics).await });
    }
    tracing::info!(tasks = task_count, "collector started");

    // Every arm returns only on shutdown, so this drains rather than races.
    while set.join_next().await.is_some() {}
    tracing::info!("collector stopped");
}

/// Run one task, restarting it with backoff on failure, until shutdown.
async fn supervise_one(
    spec: TaskSpec,
    shutdown: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    metrics: Arc<SupervisorMetrics>,
) {
    let mut backoff = BACKOFF_START;

    loop {
        if is_stopping(&shutdown, &stop) {
            return;
        }

        metrics.starts.fetch_add(1, Ordering::Relaxed);

        // `AssertUnwindSafe` is the honest choice rather than a papered-over
        // one: a panic mid-task can leave whatever it was mutating in an
        // arbitrary state. The factory builds a fresh future per attempt, so
        // nothing observable survives the panic into the retry — anything
        // durable lives on disk behind an atomic rename, and a torn in-memory
        // buffer is discarded with the future that owned it.
        let sd = Shutdown {
            daemon: shutdown.clone(),
            collector: stop.clone(),
        };
        let outcome = futures_catch_unwind(AssertUnwindSafe((spec.factory)(sd))).await;

        match outcome {
            Ok(Ok(())) => {
                // Finished its work. Not a failure, so no backoff — but also
                // nothing to restart, so stop supervising it.
                tracing::debug!(task = spec.name, "collector task completed");
                return;
            }
            Ok(Err(err)) => {
                metrics.failures.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(
                    task = spec.name,
                    %err,
                    retry_in_ms = backoff.as_millis() as u64,
                    "collector task failed; restarting"
                );
            }
            Err(panic_msg) => {
                metrics.panics.fetch_add(1, Ordering::Relaxed);
                // Logged at error, not warn: an Err is usually the
                // environment, a panic is always a bug worth chasing.
                tracing::error!(
                    task = spec.name,
                    panic = %panic_msg,
                    retry_in_ms = backoff.as_millis() as u64,
                    "collector task PANICKED; contained and restarting. Enforcement is unaffected"
                );
            }
        }

        let sd = Shutdown {
            daemon: shutdown.clone(),
            collector: stop.clone(),
        };
        if !sd.sleep(backoff).await {
            return;
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

fn is_stopping(shutdown: &AtomicBool, stop: &AtomicBool) -> bool {
    shutdown.load(Ordering::Relaxed) || stop.load(Ordering::Relaxed)
}

/// Await `fut`, converting a panic into an `Err` carrying its message.
///
/// Hand-rolled rather than pulling in `futures` for one combinator: the
/// dependency budget for a binary that ships on four cross-compiled targets is
/// worth spending deliberately, and this is the only place the daemon needs it.
async fn futures_catch_unwind<F, T>(fut: AssertUnwindSafe<F>) -> Result<T, String>
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    // A panic inside `poll` unwinds through `await`, so the guard has to wrap
    // each poll rather than the whole future — which is exactly what awaiting
    // inside a plain `catch_unwind` cannot do. Spawning gives us that
    // per-poll boundary for free: Tokio already catches a panicking task and
    // surfaces it as a `JoinError`. (`AssertUnwindSafe` implements `Future`
    // itself, forwarding to the inner one, so it can be spawned directly.)
    match tokio::task::spawn(fut).await {
        Ok(v) => Ok(v),
        Err(join_err) if join_err.is_panic() => {
            let panic = join_err.into_panic();
            let msg = if let Some(s) = panic.downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = panic.downcast_ref::<String>() {
                s.clone()
            } else {
                "non-string panic payload".to_string()
            };
            Err(msg)
        }
        // Cancellation: the runtime is going away. Treat as a clean stop.
        Err(_) => Err("task cancelled".to_string()),
    }
}
