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
use crate::uploader::{ParkedName, Uploader};

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
        }
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

        match self.uploader.upload_file(&path).await {
            Ok(()) => tracing::debug!(file = %path.display(), "uploaded"),
            Err(err) => tracing::warn!(file = %path.display(), %err, "upload failed"),
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

    loop {
        tokio::select! {
            biased;
            _ = poll_shutdown(&sd) => {
                drop(watcher);
                return Ok(());
            }
            Some(path) = rx.recv() => {
                delivery.deliver(path).await;
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

    loop {
        for dir in &dirs {
            for path in stale_batches(dir, SWEEP_MIN_AGE, SWEEP_MAX_FILES).await {
                if sd.is_set() {
                    return Ok(());
                }
                delivery.deliver(path).await;
            }
        }

        if SystemTime::now() >= next_failed_pass {
            retry_parked(&delivery, &failed_dir, &sd).await;
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
                            return Ok(());
                        }
                        delivery.deliver(path).await;
                    }
                }
                break;
            }
            if SystemTime::now() >= deadline {
                break;
            }
            if !sd.sleep(FLUSH_POLL_INTERVAL).await {
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
async fn retry_parked(delivery: &Delivery, failed_dir: &Path, sd: &Shutdown) {
    let Ok(mut rd) = tokio::fs::read_dir(failed_dir).await else {
        return;
    };
    let now = SystemTime::now();
    let mut found: Vec<(SystemTime, PathBuf)> = Vec::new();

    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !ParkedName::parse(name).is_auto_retryable() {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if now.duration_since(modified).unwrap_or_default() < FAILED_RETRY_MIN_AGE {
            continue;
        }
        found.push((modified, path));
    }

    if found.is_empty() {
        return;
    }
    found.sort_by_key(|(t, _)| *t);
    tracing::info!(
        count = found.len().min(FAILED_RETRY_MAX_FILES),
        "retrying parked batches"
    );

    for (_, path) in found.into_iter().take(FAILED_RETRY_MAX_FILES) {
        if sd.is_set() {
            return;
        }
        delivery.deliver(path).await;
    }
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
