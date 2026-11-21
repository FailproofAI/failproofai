//! Getting spooled batches to the uploader: a watcher for latency and a
//! sweeper for guarantees.
//!
//! # Why both
//!
//! The **watcher** exists for latency. It registers inotify/FSEvents on each
//! spool directory so a batch is delivered within milliseconds of the rename
//! that publishes it.
//!
//! The **sweeper** exists for correctness, and it is the one that actually
//! guarantees delivery. Filesystem events are lost in every way that matters:
//! the daemon was not running when the file appeared, the watch failed to
//! register, the event queue overflowed, the file was written on a filesystem
//! that does not report events at all. A periodic scan has none of those
//! failure modes. If the watcher were deleted tomorrow nothing would be lost —
//! it would just arrive up to a sweep interval later.
//!
//! That asymmetry is why a watcher registration failure is logged and shrugged
//! off rather than being fatal.
//!
//! # Shared state, and why it is shared
//!
//! Both paths hand work to the same [`Delivery`], which owns one semaphore and
//! one in-flight set. They must be shared rather than per-task: with separate
//! sets, a file the watcher is uploading right now is invisible to a
//! concurrent sweep, and both would POST it. With separate semaphores the
//! process could issue twice the intended concurrency at exactly the moment a
//! backlog is being worked through.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tokio::sync::Semaphore;

use crate::spool::is_batch_file;
use crate::supervisor::{Shutdown, TaskError};
use crate::uploader::{ParkedName, Uploader, batch_id, is_credential_status};

/// Concurrent uploads across the watcher and sweeper combined.
///
/// Deliberately far below the standalone collector's 64: this runs inside the
/// process that answers the enforcement socket, and 64 simultaneous TLS
/// handshakes is a lot of CPU to put behind a hook call that must return in
/// milliseconds. A backlog drains slightly slower; tool calls stay fast.
const MAX_CONCURRENT_UPLOADS: usize = 8;

/// How often the sweeper scans the spool directories.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// How often the sweeper looks for a `failproofai flush` request while it is
/// otherwise idle. Short enough that a flush feels immediate, long enough that
/// an idle daemon is not spinning.
const FLUSH_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// How old a batch must be before the sweeper claims it.
///
/// Not politeness — it is what keeps the two paths from racing on a file the
/// watcher has already been handed but has not yet locked in its in-flight
/// set.
const SWEEP_MIN_AGE: Duration = Duration::from_secs(120);
/// Batches per sweep. Bounds the work a single pass can queue so a large
/// backlog is drained steadily instead of all at once.
const SWEEP_MAX_FILES: usize = 64;

/// How often parked batches are retried. Deliberately far slower than the
/// spool sweep: a backlog in `failed/` must never starve fresh events of
/// upload permits.
const FAILED_RETRY_INTERVAL: Duration = Duration::from_secs(3600);
/// How old a parked batch must be before an automatic retry.
const FAILED_RETRY_MIN_AGE: Duration = Duration::from_secs(300);
/// Parked batches per retry pass.
const FAILED_RETRY_MAX_FILES: usize = 16;
/// Minimum gap between two "the server is back" retries of parked batches, so
/// a flapping connection cannot turn every accepted upload into a pass.
const RECOVERY_RETRY_GAP: Duration = Duration::from_secs(300);
/// Between two recovery passes while a backlog remains: each pass is capped at
/// FAILED_RETRY_MAX_FILES, and a larger backlog drains in steps rather than
/// waiting for the hourly pass, without one long burst starving fresh events.
const RECOVERY_BACKLOG_GAP: Duration = Duration::from_secs(10);
/// At most one refused batch after a fresh delivery, so the serial watcher
/// and sweeper return to fresh work instead of draining a credential backlog.
const REFUSED_REDRIVE_MAX_FILES: usize = 1;
const REFUSED_REDRIVE_TIMEOUT: Duration = Duration::from_secs(30);

/// Bound on the filesystem-event channel. Overflow is survivable precisely
/// because the sweeper is the guarantee — a dropped event costs latency, not
/// data.
const EVENT_CHANNEL_CAP: usize = 256;

/// Shared upload gate: one semaphore and one in-flight set for every path that
/// delivers a batch.
pub struct Delivery {
    uploader: Arc<Uploader>,
    permits: Arc<Semaphore>,
    in_flight: Arc<Mutex<HashSet<PathBuf>>>,
    replay_gate: Arc<Semaphore>,
    replay_ready: std::sync::atomic::AtomicBool,
    /// A delivery failed since the last one the server accepted. Starts true,
    /// so the first accepted delivery after a start also looks at `failed/`.
    failing: std::sync::atomic::AtomicBool,
    /// An accepted delivery followed a failure: the server is reachable again,
    /// so what an outage parked can go now rather than at the hourly pass.
    recovered: std::sync::atomic::AtomicBool,
}

/// Cancellation must leave another pass scheduled and release the global gate.
struct ReplayGuard {
    uploader: Arc<Uploader>,
    _permit: tokio::sync::OwnedSemaphorePermit,
    completed: bool,
}

impl Drop for ReplayGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.uploader.note_credential_refusals();
        }
    }
}

/// Removes a path from the in-flight set on scope exit, including during an
/// unwind. A leaked entry would make that batch permanently invisible to both
/// the watcher and the sweeper — undelivered, on disk, and never retried.
struct InFlightGuard {
    set: Arc<Mutex<HashSet<PathBuf>>>,
    path: PathBuf,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = self.set.lock() {
            set.remove(&self.path);
        }
    }
}

impl Delivery {
    pub fn new(uploader: Arc<Uploader>) -> Self {
        Delivery {
            uploader,
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_UPLOADS)),
            in_flight: Arc::new(Mutex::new(HashSet::new())),
            replay_gate: Arc::new(Semaphore::new(1)),
            replay_ready: std::sync::atomic::AtomicBool::new(false),
            failing: std::sync::atomic::AtomicBool::new(true),
            recovered: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Whether the server came back since the last call (see `recovered`).
    fn take_recovered(&self) -> bool {
        self.recovered.swap(false, Ordering::SeqCst)
    }

    /// Claim `path` for delivery, or `None` if another task already has it.
    ///
    /// Claiming and releasing are a guard rather than a pair of calls so an
    /// early return or a panic cannot leave the claim behind.
    fn claim(&self, path: &Path) -> Option<InFlightGuard> {
        let mut set = self.in_flight.lock().ok()?;
        if !set.insert(path.to_path_buf()) {
            return None;
        }
        Some(InFlightGuard {
            set: self.in_flight.clone(),
            path: path.to_path_buf(),
        })
    }

    /// Background work yields to every claimed fresh upload, including those
    /// waiting for a permit. Check and claim together; never wait for our own
    /// in-flight entry (or another redrive) to disappear.
    fn claim_refused(&self, path: &Path) -> Option<InFlightGuard> {
        let mut set = self.in_flight.lock().ok()?;
        if !set.is_empty() {
            return None;
        }
        set.insert(path.to_path_buf());
        Some(InFlightGuard {
            set: self.in_flight.clone(),
            path: path.to_path_buf(),
        })
    }

    /// Upload one batch, if nothing else is already doing so.
    ///
    /// Errors are logged, never propagated: the uploader has already parked
    /// anything undeliverable, so there is nothing for a caller to do about it
    /// and returning an error would restart the whole task over one bad batch.
    pub async fn deliver(&self, path: PathBuf) {
        let Some(_guard) = self.claim(&path) else {
            return;
        };
        let Ok(_permit) = self.permits.clone().acquire_owned().await else {
            return; // semaphore closed — shutting down
        };

        let delivered = self.uploader.upload_file(&path).await;
        drop(_permit);
        drop(_guard);
        match delivered {
            Ok(()) => {
                tracing::debug!(file = %path.display(), "uploaded");
                // The owning watcher/sweeper schedules replay separately.
                // Never await background retries on the fresh-delivery path.
                self.replay_ready.store(true, Ordering::SeqCst);
                if self.failing.swap(false, Ordering::SeqCst) {
                    self.recovered.store(true, Ordering::SeqCst);
                }
            }
            // The batch id ties this to the attempt and park lines, which
            // carry the request ids.
            Err(err) => {
                self.failing.store(true, Ordering::SeqCst);
                tracing::warn!(
                    file = %path.display(),
                    batch_id = %batch_id(&path),
                    %err,
                    "upload failed"
                )
            }
        }
    }

    /// One globally gated task, tracked by its supervisor-owned caller's
    /// JoinSet. Dropping that owner aborts replay; shutdown is also observed
    /// inside it. No detached task or polling/wait-for-self loop.
    fn schedule_refused(self: &Arc<Self>, tasks: &mut tokio::task::JoinSet<()>, sd: &Shutdown) {
        while tasks.try_join_next().is_some() {}
        if sd.is_set() || !self.replay_ready.load(Ordering::SeqCst) {
            return;
        }
        let Ok(permit) = self.replay_gate.clone().try_acquire_owned() else {
            return;
        };
        if !self.uploader.take_credential_refusals() {
            return;
        }
        self.replay_ready.store(false, Ordering::SeqCst);
        let mut guard = ReplayGuard {
            uploader: self.uploader.clone(),
            _permit: permit,
            completed: false,
        };
        let delivery = self.clone();
        let sd = sd.clone();
        tasks.spawn(async move {
            tokio::select! {
                biased;
                _ = poll_shutdown(&sd) => {}
                result = tokio::time::timeout(REFUSED_REDRIVE_TIMEOUT, delivery.redrive_refused()) => {
                    guard.completed = result.is_ok();
                }
            }
            drop(guard);
        });
    }
}

impl Delivery {
    /// Re-send a bounded number of credential refusals (`.c401` / `.c403`),
    /// oldest first, with the key in use now. Called only after a delivery the
    /// server accepted with that key.
    ///
    /// Why: a key regenerated on the dashboard (or a reconnect with a new one)
    /// leaves the RUNNING collector on the old secret until the daemon's next
    /// config tick cycles it, and whatever it sends in between is refused and
    /// parked as definitive — never retried, and counted by `config --status`
    /// as "the cloud is refusing this machine's key" for ever after, while
    /// events reach the dashboard fine. The CLI's own redrive at `--connect`
    /// (`credential-recovery.ts`) runs before that window closes, so it cannot
    /// catch the last of them.
    ///
    /// A repeated refusal reparks the entire original batch, including any
    /// unsent chunks. Remainders and busy gates schedule another pass after
    /// the next accepted delivery, without blocking fresh uploads.
    pub async fn redrive_refused(&self) {
        let failed_dir = self.uploader.failed_dir().to_path_buf();
        let Ok(mut rd) = tokio::fs::read_dir(&failed_dir).await else {
            return;
        };
        let mut found: Vec<(SystemTime, PathBuf)> = Vec::new();
        while let Ok(Some(entry)) = rd.next_entry().await {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let parked = ParkedName::parse(name);
            if parked.poison || !parked.client_status.is_some_and(is_credential_status) {
                continue;
            }
            let modified = entry
                .metadata()
                .await
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            found.push((modified, path));
        }
        if found.is_empty() {
            return;
        }
        found.sort_by_key(|(t, _)| *t);
        if found.len() > REFUSED_REDRIVE_MAX_FILES {
            self.uploader.note_credential_refusals();
        }
        tracing::info!(
            count = found.len().min(REFUSED_REDRIVE_MAX_FILES),
            "re-sending batches an earlier key had refused"
        );
        for (_, path) in found.into_iter().take(REFUSED_REDRIVE_MAX_FILES) {
            let Some(_guard) = self.claim_refused(&path) else {
                self.uploader.note_credential_refusals();
                return;
            };
            let Ok(_permit) = self.permits.clone().try_acquire_owned() else {
                self.uploader.note_credential_refusals();
                return;
            };
            match self.uploader.upload_file(&path).await {
                Ok(()) => {
                    tracing::info!(file = %path.display(), "re-sent a batch an earlier key had refused")
                }
                Err(err) => {
                    // Still parked as a credential refusal (no verdict on it):
                    // try again after the next accepted delivery.
                    self.uploader.note_credential_refusals();
                    tracing::warn!(
                        file = %path.display(),
                        batch_id = %batch_id(&path),
                        %err,
                        "could not re-send a batch an earlier key had refused"
                    );
                }
            }
        }
    }
}

/// Watch every spool directory and deliver batches as they are published.
///
/// Registration failures are logged and skipped rather than returned: losing
/// the watch costs latency, and returning an error would restart the task in a
/// loop on a filesystem that will never support events.
pub async fn watch(
    delivery: Arc<Delivery>,
    dirs: Vec<PathBuf>,
    sd: Shutdown,
) -> Result<(), TaskError> {
    use notify::{
        EventKind, RecursiveMode, Watcher, event::CreateKind, event::ModifyKind, event::RenameMode,
    };

    let (tx, mut rx) = tokio::sync::mpsc::channel::<PathBuf>(EVENT_CHANNEL_CAP);

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // The atomic publish is a rename INTO the directory, which Linux
        // reports as IN_MOVED_TO and macOS as a create. Watching only
        // `Create(File)` would therefore miss every batch on Linux — the exact
        // shape the spool writer produces.
        let interesting = matches!(
            event.kind,
            EventKind::Create(CreateKind::File)
                | EventKind::Create(CreateKind::Any)
                | EventKind::Modify(ModifyKind::Name(RenameMode::To))
        );
        if !interesting {
            return;
        }
        for path in event.paths {
            if is_batch_file(&path) {
                // Sync callback; a full channel means we are behind, and the
                // sweeper will collect what we drop.
                let _ = tx.try_send(path);
            }
        }
    })
    .map_err(|e| TaskError::from(format!("could not create a filesystem watcher: {e}")))?;

    let mut watched = 0usize;
    for dir in &dirs {
        if let Err(err) = tokio::fs::create_dir_all(dir).await {
            tracing::warn!(dir = %dir.display(), %err, "could not create a spool directory");
            continue;
        }
        match watcher.watch(dir, RecursiveMode::NonRecursive) {
            Ok(()) => watched += 1,
            Err(err) => tracing::warn!(
                dir = %dir.display(),
                %err,
                "could not watch this spool directory; the sweeper still delivers from it, just later"
            ),
        }
    }
    tracing::info!(watched, of = dirs.len(), "spool watcher started");

    let mut replays = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = poll_shutdown(&sd) => {
                drop(watcher);
                replays.shutdown().await;
                return Ok(());
            }
            Some(path) = rx.recv() => {
                delivery.deliver(path).await;
                delivery.schedule_refused(&mut replays, &sd);
            }
        }
    }
}

/// Periodically scan every spool directory, and retry parked batches on a much
/// slower cadence.
pub async fn sweep(
    delivery: Arc<Delivery>,
    dirs: Vec<PathBuf>,
    failed_dir: PathBuf,
    sd: Shutdown,
    flush_now: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), TaskError> {
    // Run one pass immediately. A cold start must not wait a full interval to
    // deliver what accumulated while the daemon was stopped, and a filesystem
    // event for those files is never coming — they were published while
    // nothing was listening.
    let mut next_failed_pass = SystemTime::now();
    let mut next_recovery_pass = SystemTime::now();
    let mut next_probe = SystemTime::now();
    let mut backlog = false;
    let mut replays = tokio::task::JoinSet::new();

    loop {
        for dir in &dirs {
            for path in stale_batches(dir, SWEEP_MIN_AGE, SWEEP_MAX_FILES).await {
                if sd.is_set() {
                    replays.shutdown().await;
                    return Ok(());
                }
                delivery.deliver(path).await;
                delivery.schedule_refused(&mut replays, &sd);
            }
        }

        if SystemTime::now() >= next_failed_pass {
            retry_parked(&delivery, &failed_dir, &sd, FAILED_RETRY_MIN_AGE).await;
            delivery.schedule_refused(&mut replays, &sd);
            next_failed_pass = SystemTime::now() + FAILED_RETRY_INTERVAL;
        }

        // Poll for a flush request rather than sleeping the whole interval in
        // one go. `failproofai flush` exists because the guarantees that make
        // the sweeper safe in steady state — only touch batches older than
        // SWEEP_MIN_AGE, at most SWEEP_MAX_FILES per pass — are exactly wrong
        // for someone standing at a dashboard waiting for their own events.
        let deadline = SystemTime::now() + SWEEP_INTERVAL;
        loop {
            if flush_now.swap(false, Ordering::SeqCst) {
                // A flush pass: no minimum age, no per-pass cap. This is the
                // one caller that has explicitly asked to trade the backlog
                // pacing for latency.
                for dir in &dirs {
                    for path in stale_batches(dir, Duration::ZERO, usize::MAX).await {
                        if sd.is_set() {
                            replays.shutdown().await;
                            return Ok(());
                        }
                        delivery.deliver(path).await;
                        delivery.schedule_refused(&mut replays, &sd);
                    }
                }
                retry_parked(&delivery, &failed_dir, &sd, Duration::ZERO).await;
                delivery.schedule_refused(&mut replays, &sd);
                break;
            }
            // The server accepted a batch after an outage: retry what the
            // outage parked now, not at the next hourly pass, with no minimum
            // age (the failure that parked them is over).
            //
            // A backlog larger than one pass keeps draining, one capped pass
            // every RECOVERY_BACKLOG_GAP, for as long as deliveries succeed.
            if SystemTime::now() >= next_recovery_pass && (backlog || delivery.take_recovered()) {
                let left = retry_parked_up_to(
                    &delivery,
                    &failed_dir,
                    &sd,
                    Duration::ZERO,
                    FAILED_RETRY_MAX_FILES,
                )
                .await;
                delivery.schedule_refused(&mut replays, &sd);
                backlog = left > 0 && !delivery.failing.load(Ordering::SeqCst);
                next_recovery_pass = SystemTime::now()
                    + if backlog {
                        RECOVERY_BACKLOG_GAP
                    } else {
                        RECOVERY_RETRY_GAP
                    };
            }
            // An idle machine sends nothing fresh to notice the server is back:
            // while the last delivery failed, one parked batch goes as a probe
            // each gap, and its success is the recovery above.
            if SystemTime::now() >= next_probe && delivery.failing.load(Ordering::SeqCst) {
                retry_parked_up_to(&delivery, &failed_dir, &sd, Duration::ZERO, 1).await;
                next_probe = SystemTime::now() + RECOVERY_RETRY_GAP;
            }
            if SystemTime::now() >= deadline {
                break;
            }
            if !sd.sleep(FLUSH_POLL_INTERVAL).await {
                replays.shutdown().await;
                return Ok(());
            }
        }
    }
}

/// Batches in `dir` older than `min_age`, newest first, capped at `max`.
///
/// Newest-first is deliberate: when a backlog cannot be cleared in one pass,
/// the events a user is most likely to be looking at right now should arrive
/// first. (`failed/` is drained oldest-first instead — see [`retry_parked`].)
async fn stale_batches(dir: &Path, min_age: Duration, max: usize) -> Vec<PathBuf> {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return Vec::new();
    };
    let now = SystemTime::now();
    let mut found: Vec<(SystemTime, PathBuf)> = Vec::new();

    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        if !is_batch_file(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        // A file younger than min_age may still be the watcher's to deliver.
        if now.duration_since(modified).unwrap_or_default() < min_age {
            continue;
        }
        found.push((modified, path));
    }

    // Newest first: `sort_by_key` cannot express a reverse key without
    // cloning, and Reverse on a SystemTime tuple reads worse than this.
    found.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    found.into_iter().take(max).map(|(_, p)| p).collect()
}

/// Retry batches parked in `failed/`, oldest first.
///
/// Oldest-first is the opposite of the spool sweep, and deliberately so: a
/// parked batch is data the server does not have and this is the last copy, so
/// the one that has been waiting longest is the one most at risk.
///
/// Skips anything poison or carrying a definitive client status — those fail
/// identically until a human fixes the key or the URL, and retrying them burns
/// permits that batches which could succeed are waiting for.
/// Whether the parked-batch sweep may retry the file with this name.
fn sweepable(name: &str) -> bool {
    // A dotfile is a park still being copied across filesystems.
    !name.starts_with('.') && ParkedName::parse(name).is_auto_retryable()
}

async fn retry_parked(delivery: &Delivery, failed_dir: &Path, sd: &Shutdown, min_age: Duration) {
    retry_parked_up_to(delivery, failed_dir, sd, min_age, FAILED_RETRY_MAX_FILES).await;
}

/// Retry up to `max` parked batches, oldest first. Returns how many eligible
/// batches were left untried.
async fn retry_parked_up_to(
    delivery: &Delivery,
    failed_dir: &Path,
    sd: &Shutdown,
    min_age: Duration,
    max: usize,
) -> usize {
    let Ok(mut rd) = tokio::fs::read_dir(failed_dir).await else {
        return 0;
    };
    let now = SystemTime::now();
    let mut found: Vec<(SystemTime, PathBuf)> = Vec::new();

    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !sweepable(name) {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if now.duration_since(modified).unwrap_or_default() < min_age {
            continue;
        }
        found.push((modified, path));
    }

    if found.is_empty() {
        return 0;
    }
    found.sort_by_key(|(t, _)| *t);
    tracing::info!(count = found.len().min(max), "retrying parked batches");

    let left = found.len().saturating_sub(max);
    for (_, path) in found.into_iter().take(max) {
        if sd.is_set() {
            return left;
        }
        delivery.deliver(path).await;
    }
    left
}

/// Resolves once shutdown is requested. A `select!` arm needs a future, and
/// `Shutdown` exposes a flag rather than a notification.
async fn poll_shutdown(sd: &Shutdown) {
    while !sd.is_set() {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    #[tokio::test]
    async fn a_flush_redrives_retryable_batches_and_an_accepted_key_resends_refusals() {
        use wiremock::matchers::{header, method};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(header("Authorization", "Bearer replacement"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"accepted": 1, "skipped": 0})),
            )
            .expect(2)
            .mount(&server)
            .await;
        let dir = tmpdir("flush-recovery");
        let retryable = dir.join("session.a1.jsonl");
        let refused = dir.join("refused.a1.c401.jsonl");
        std::fs::write(&retryable, "{}\n").unwrap();
        std::fs::write(&refused, "{}\n").unwrap();
        let delivery = Delivery::new(Arc::new(
            Uploader::new(server.uri(), "replacement".into(), dir.clone()).unwrap(),
        ));
        let sd = Shutdown::for_test(Arc::new(std::sync::atomic::AtomicBool::new(false)));
        retry_parked(&delivery, &dir, &sd, FAILED_RETRY_MIN_AGE).await;
        assert!(
            retryable.exists(),
            "ordinary retries must retain the age gate"
        );
        retry_parked(&delivery, &dir, &sd, Duration::ZERO).await;
        assert!(!retryable.exists());
        assert!(delivery.uploader.take_credential_refusals());
        delivery.redrive_refused().await;
        // The key just delivered, so the batch a key had refused goes with it.
        assert!(
            !refused.exists(),
            "an accepted delivery re-sends what a refused key had parked"
        );
        server.verify().await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// What an outage parked goes as soon as the server accepts a batch again,
    /// not at the hourly pass and not only once it is five minutes old — even
    /// on an idle machine, through a one-batch probe.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_accepted_delivery_after_an_outage_retries_parked_batches_now() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"accepted": 1, "skipped": 0})),
            )
            .mount(&server)
            .await;
        let failed = tmpdir("recovery-failed");
        let spool = tmpdir("recovery-spool");
        // Parked by the outage a moment ago: younger than FAILED_RETRY_MIN_AGE.
        let probe_first = failed.join("hooks-activity-0-0.a1.jsonl");
        std::fs::write(&probe_first, "{}\n").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        let parked = failed.join("hooks-activity-1-0.a1.jsonl");
        std::fs::write(&parked, "{}\n").unwrap();
        // A refusal is not an outage: it stays for the credential redrive.
        let refused = failed.join("other-1-0.a1.c422.jsonl");
        std::fs::write(&refused, "{}\n").unwrap();

        let delivery = Arc::new(Delivery::new(Arc::new(
            Uploader::new(server.uri(), "k".into(), failed.clone()).unwrap(),
        )));
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sd = Shutdown::for_test(flag.clone());
        let sweeper = tokio::spawn(sweep(
            delivery.clone(),
            vec![spool.clone()],
            failed.clone(),
            sd,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        ));
        // Nothing fresh to send: the first parked batch goes as a probe, and
        // its success lets the rest follow (an idle machine recovers too).
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while (probe_first.exists() || parked.exists()) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            !probe_first.exists(),
            "the oldest parked batch is the probe"
        );
        assert!(
            !parked.exists(),
            "an accepted probe lets the rest of the outage's batches go"
        );

        assert!(
            refused.exists(),
            "a 422 refusal is not retried as an outage"
        );

        flag.store(true, Ordering::SeqCst);
        let _ = tokio::time::timeout(Duration::from_secs(5), sweeper).await;
        std::fs::remove_dir_all(failed).ok();
        std::fs::remove_dir_all(spool).ok();
    }

    /// More parked than one capped pass: the rest keep draining while
    /// deliveries succeed, instead of waiting for the hourly pass.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_backlog_larger_than_one_pass_drains_after_recovery() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"accepted": 1, "skipped": 0})),
            )
            .mount(&server)
            .await;
        let failed = tmpdir("backlog-failed");
        let spool = tmpdir("backlog-spool");
        let total = FAILED_RETRY_MAX_FILES + 9;
        for i in 0..total {
            std::fs::write(
                failed.join(format!("hooks-activity-{i}-0.a1.jsonl")),
                "{}\n",
            )
            .unwrap();
        }
        let delivery = Arc::new(Delivery::new(Arc::new(
            Uploader::new(server.uri(), "k".into(), failed.clone()).unwrap(),
        )));
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sweeper = tokio::spawn(sweep(
            delivery.clone(),
            vec![spool.clone()],
            failed.clone(),
            Shutdown::for_test(flag.clone()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        ));
        let left = || std::fs::read_dir(&failed).map(|d| d.count()).unwrap_or(0);
        let deadline = std::time::Instant::now() + RECOVERY_BACKLOG_GAP * 3;
        while left() > 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert_eq!(
            left(),
            0,
            "the whole backlog drains once the server is back"
        );
        flag.store(true, Ordering::SeqCst);
        let _ = tokio::time::timeout(Duration::from_secs(5), sweeper).await;
        std::fs::remove_dir_all(failed).ok();
        std::fs::remove_dir_all(spool).ok();
    }

    #[tokio::test]
    async fn a_refusal_the_current_key_repeats_is_reparked_and_others_are_kept() {
        use wiremock::matchers::{body_string, method};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string("{\"refused\":1}\n"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"accepted": 1, "skipped": 0})),
            )
            .mount(&server)
            .await;
        let failed = tmpdir("redrive-failed");
        let spool = tmpdir("redrive-spool");
        let refused_again = failed.join("a-0.a1.r1.c401.jsonl");
        let resendable = failed.join("b-0.a1.c403.jsonl");
        let not_credential = failed.join("c-0.a1.c404.jsonl");
        std::fs::write(&refused_again, "{\"refused\":1}\n").unwrap();
        std::fs::write(&resendable, "{\"ok\":1}\n").unwrap();
        std::fs::write(&not_credential, "{\"ok\":2}\n").unwrap();
        std::fs::File::open(&refused_again)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(UNIX_EPOCH))
            .unwrap();
        let fresh = spool.join("hooks-a-1-0.jsonl");
        std::fs::write(&fresh, "{\"ok\":3}\n").unwrap();
        let delivery = Delivery::new(Arc::new(
            Uploader::new(server.uri(), "current".into(), failed.clone()).unwrap(),
        ));
        delivery.deliver(fresh.clone()).await;
        assert!(!fresh.exists());
        assert!(delivery.uploader.take_credential_refusals());
        delivery.redrive_refused().await;
        assert!(
            delivery.uploader.take_credential_refusals(),
            "the bounded pass must schedule its remainder"
        );
        assert!(
            !refused_again.exists(),
            "refused again by that key: renamed into another park"
        );
        assert_eq!(
            std::fs::read(failed.join("a-0.a2.r2.c401.jsonl")).unwrap(),
            b"{\"refused\":1}\n"
        );
        delivery.redrive_refused().await;
        assert_eq!(
            std::fs::read(failed.join("a-0.a3.r3.c401.jsonl.poison")).unwrap(),
            b"{\"refused\":1}\n",
            "exhausting retries must preserve the last local copy too"
        );
        delivery.redrive_refused().await;
        assert!(!resendable.exists(), "re-sent with the key that works");
        assert!(
            not_credential.exists(),
            "a non-credential refusal is not this pass's"
        );
        assert_eq!(
            std::fs::read_dir(&failed).unwrap().count(),
            2,
            "the repeated refusal must keep its last local copy"
        );
        std::fs::remove_dir_all(failed).unwrap();
        std::fs::remove_dir_all(spool).unwrap();
    }

    #[tokio::test]
    async fn aborting_an_owned_replay_releases_the_gate_and_schedules_remainder() {
        let failed = tmpdir("replay-abort");
        let delivery = Arc::new(Delivery::new(Arc::new(
            Uploader::new("http://127.0.0.1:1".into(), "k".into(), failed.clone()).unwrap(),
        )));
        delivery.replay_ready.store(true, Ordering::SeqCst);
        let sd = Shutdown::for_test(Arc::new(std::sync::atomic::AtomicBool::new(false)));
        let mut tasks = tokio::task::JoinSet::new();
        delivery.schedule_refused(&mut tasks, &sd);
        assert_eq!(tasks.len(), 1);
        assert_eq!(delivery.replay_gate.available_permits(), 0);
        delivery.schedule_refused(&mut tasks, &sd);
        assert_eq!(tasks.len(), 1, "replay must be globally gated");
        tasks.shutdown().await;
        assert_eq!(delivery.replay_gate.available_permits(), 1);
        assert!(delivery.uploader.take_credential_refusals());
        assert!(delivery.in_flight.lock().unwrap().is_empty());
        std::fs::remove_dir_all(failed).unwrap();
    }

    #[tokio::test]
    async fn refused_redrive_yields_to_fresh_claims_and_busy_permits_without_waiting() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"accepted": 1})),
            )
            .mount(&server)
            .await;
        let failed = tmpdir("redrive-priority");
        let refused = failed.join("old.a1.c403.jsonl");
        std::fs::write(&refused, "{}\n").unwrap();
        let delivery = Delivery::new(Arc::new(
            Uploader::new(server.uri(), "current".into(), failed.clone()).unwrap(),
        ));
        delivery.uploader.take_credential_refusals();
        let fresh = delivery.claim(Path::new("fresh.jsonl")).unwrap();
        tokio::time::timeout(Duration::from_secs(1), delivery.redrive_refused())
            .await
            .expect("background work must not wait on fresh claims");
        assert!(delivery.uploader.take_credential_refusals());
        assert!(refused.exists());
        assert!(server.received_requests().await.unwrap().is_empty());
        drop(fresh);

        let permits = delivery
            .permits
            .clone()
            .acquire_many_owned(MAX_CONCURRENT_UPLOADS as u32)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), delivery.redrive_refused())
            .await
            .expect("background work must not queue for a permit");
        assert!(delivery.uploader.take_credential_refusals());
        assert!(delivery.in_flight.lock().unwrap().is_empty());
        assert!(server.received_requests().await.unwrap().is_empty());
        drop(permits);

        tokio::time::timeout(Duration::from_secs(1), delivery.redrive_refused())
            .await
            .expect("a redrive must not wait on its own claim");
        assert!(!refused.exists());
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
        std::fs::remove_dir_all(failed).unwrap();
    }

    #[tokio::test]
    async fn refusals_wait_for_an_accepted_delivery() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let failed = tmpdir("redrive-wait-failed");
        let spool = tmpdir("redrive-wait-spool");
        let old = failed.join("a-0.a1.c401.jsonl");
        std::fs::write(&old, "{}\n").unwrap();
        let fresh = spool.join("hooks-a-1-0.jsonl");
        std::fs::write(&fresh, "{}\n").unwrap();
        let delivery = Delivery::new(Arc::new(
            Uploader::new(server.uri(), "revoked".into(), failed.clone()).unwrap(),
        ));
        delivery.deliver(fresh).await;
        assert!(old.exists(), "a key that is refused re-sends nothing");
        assert!(failed.join("hooks-a-1-0.a1.r1.c401.jsonl").exists());
        std::fs::remove_dir_all(failed).unwrap();
        std::fs::remove_dir_all(spool).unwrap();
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "fpai-deliv-{}-{}-{}",
            name,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn the_sweeper_ignores_batches_younger_than_the_min_age() {
        // A fresh file is very likely already on its way via the watcher.
        // Claiming it here is how the same batch gets POSTed twice.
        let dir = tmpdir("young");
        std::fs::write(dir.join("hooks-a-1-0.jsonl"), "{}\n").unwrap();

        let found = stale_batches(&dir, Duration::from_secs(120), 64).await;
        assert!(
            found.is_empty(),
            "a just-written batch must be left to the watcher"
        );

        // With no age requirement the same file is picked up.
        let found = stale_batches(&dir, Duration::ZERO, 64).await;
        assert_eq!(found.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_parked_sweep_skips_rejected_batches_and_half_copied_parks() {
        assert!(sweepable("hooks-a-1-0.a1.jsonl"));
        assert!(!sweepable("hooks-a-1-0.a1.c401.jsonl"));
        assert!(!sweepable("hooks-a-1-0.a3.jsonl.poison"));
        assert!(!sweepable(".hooks-a-1-0.a1.jsonl.partial"));
    }

    #[tokio::test]
    async fn the_sweeper_only_claims_batch_files() {
        let dir = tmpdir("filter");
        std::fs::write(dir.join("hooks-a-1-0.jsonl"), "{}\n").unwrap();
        // A partially-written batch. Delivering this would ship a truncated
        // body, which is the whole reason the spool writes tmp-then-renames.
        std::fs::write(dir.join("hooks-a-1-1.tmp"), "{}\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        std::fs::write(dir.join("hooks-a-1-2.jsonl.poison"), "{}\n").unwrap();

        let found = stale_batches(&dir, Duration::ZERO, 64).await;
        let names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["hooks-a-1-0.jsonl"], "got {names:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn the_sweeper_caps_how_much_one_pass_queues() {
        let dir = tmpdir("cap");
        for i in 0..20 {
            std::fs::write(dir.join(format!("hooks-a-1-{i}.jsonl")), "{}\n").unwrap();
        }
        let found = stale_batches(&dir, Duration::ZERO, 5).await;
        assert_eq!(found.len(), 5);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_missing_spool_directory_is_not_an_error() {
        // Normal on a fresh install, and on a machine where the SDK has never
        // run so ~/.agenteye/events does not exist.
        let found = stale_batches(Path::new("/nonexistent/fpai/spool"), Duration::ZERO, 8).await;
        assert!(found.is_empty());
    }

    #[test]
    fn an_in_flight_claim_is_exclusive_and_released_on_drop() {
        let up = Arc::new(
            Uploader::new(
                "http://127.0.0.1:1/events".into(),
                "k".into(),
                tmpdir("claim"),
            )
            .unwrap(),
        );
        let d = Delivery::new(up);
        let p = Path::new("/s/hooks-a-1-0.jsonl");

        let first = d.claim(p).expect("first claim should succeed");
        assert!(d.claim(p).is_none(), "a second claim must be refused");
        drop(first);
        assert!(
            d.claim(p).is_some(),
            "the claim must be released on drop, or the batch is never retried"
        );
    }

    #[test]
    fn a_claim_is_released_even_when_the_holder_panics() {
        // A leaked claim makes that batch permanently invisible to both the
        // watcher and the sweeper: undelivered, on disk, never retried.
        let up = Arc::new(
            Uploader::new(
                "http://127.0.0.1:1/events".into(),
                "k".into(),
                tmpdir("panic"),
            )
            .unwrap(),
        );
        let d = Arc::new(Delivery::new(up));
        let p = PathBuf::from("/s/hooks-a-1-0.jsonl");

        let d2 = d.clone();
        let p2 = p.clone();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _guard = d2.claim(&p2).unwrap();
            panic!("boom");
        }));

        assert!(
            d.claim(&p).is_some(),
            "the guard must release during an unwind"
        );
    }
}
