//! Per-source liveness, written to `~/.failproofai/collector-health.json`.
//!
//! # Why per-source, and not one flag
//!
//! With a dozen sources, a single "collector ok" bit is worse than useless: a
//! source whose root vanished, whose cursor desynced, or whose vendor changed
//! its format goes quiet, and quiet is exactly what a healthy idle source looks
//! like. The failure that motivates this is not hypothetical — a collector that
//! captures nothing reads identically to one capturing everything, and the only
//! way anyone notices is that a dashboard is emptier than expected weeks later.
//!
//! So every source reports three things it cannot fake: whether its root exists,
//! when it last produced an event, and what went wrong most recently. A reader
//! comparing "root present, zero events, no errors" against "root absent" can
//! tell a broken source from an unused one.
//!
//! # Deliberately not a health CHECK
//!
//! This records facts and does not decide whether they are good. "No events for
//! six hours" is an outage on a busy machine and completely normal on a laptop
//! that was shut. Whoever consumes this has the context to judge; the daemon
//! does not, and a threshold guessed here would produce alerts nobody trusts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

/// Longest error message kept. An error is a diagnostic, not a log — a
/// multi-megabyte parse failure would make this file unreadable and could push
/// a credential-bearing string into a file the daemon writes.
const MAX_ERROR_LEN: usize = 500;

/// What one source reports about itself.
#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct SourceHealth {
    /// Whether the directory or database this source reads exists at all.
    /// Distinguishes "this agent is not installed" from "this agent is broken".
    pub root_present: bool,
    /// Unix seconds of the last event this source produced. Zero means none
    /// since the daemon started.
    pub last_event_ts: u64,
    /// Events produced since the daemon started.
    pub events: u64,
    /// How far through its input the source is, in whatever unit it uses
    /// (bytes for a file tailer, rows for a database poller).
    pub cursor: u64,
    /// Most recent error, truncated. `None` once a poll succeeds again, so a
    /// transient failure does not look permanent.
    pub last_error: Option<String>,
    /// Total failed polls. Kept even after `last_error` clears, so a source
    /// that fails intermittently is distinguishable from one that never has.
    pub errors: u64,
}

/// The whole record, as written.
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct HealthFile {
    /// When this snapshot was written, so a reader can tell a stale file from a
    /// current one — a daemon that died leaves its last record behind.
    pub ts: u64,
    pub sources: BTreeMap<String, SourceHealth>,
}

/// Shared, cheap-to-update health state.
///
/// A `Mutex` rather than per-source atomics because the map is written whole:
/// contention is a handful of updates a second across a dozen sources, and the
/// alternative is a lock-free structure nobody needs.
#[derive(Debug, Default)]
pub struct Health {
    sources: Mutex<BTreeMap<String, SourceHealth>>,
    writes: AtomicU64,
}

impl Health {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that a source polled successfully.
    ///
    /// Clears `last_error` on purpose: a source that recovered should not keep
    /// showing a fault from an hour ago, and the `errors` counter preserves the
    /// fact that it happened.
    pub fn record_poll(&self, source: &str, root_present: bool, events: u64, cursor: u64) {
        let Ok(mut map) = self.sources.lock() else {
            return; // poisoned: health is never worth propagating a panic
        };
        let entry = map.entry(source.to_string()).or_default();
        entry.root_present = root_present;
        entry.cursor = cursor;
        entry.last_error = None;
        if events > 0 {
            entry.events += events;
            entry.last_event_ts = now_secs();
        }
    }

    /// Record that a source's poll failed.
    pub fn record_error(&self, source: &str, error: &str) {
        let Ok(mut map) = self.sources.lock() else {
            return;
        };
        let entry = map.entry(source.to_string()).or_default();
        entry.errors += 1;
        entry.last_error = Some(truncate(error, MAX_ERROR_LEN));
    }

    /// Snapshot for writing.
    pub fn snapshot(&self) -> HealthFile {
        let sources = self.sources.lock().map(|m| m.clone()).unwrap_or_default();
        HealthFile {
            ts: now_secs(),
            sources,
        }
    }

    /// Write the record atomically (tmp → rename).
    ///
    /// No fsync: this is a heartbeat, not data. Losing the last few seconds of
    /// it on a power cut costs nothing, and paying an fsync every interval for
    /// a file nobody reconstructs state from would be the wrong trade.
    pub fn write(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let body = serde_json::to_string_pretty(&self.snapshot()).map_err(std::io::Error::other)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, path)?;
        self.writes.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    pub fn writes(&self) -> u64 {
        self.writes.load(Ordering::Relaxed)
    }
}

/// The process-wide health registry.
///
/// A global rather than a field on every `Spec`, for the same reason `tracing`
/// is: health is process-scoped telemetry that every engine touches, and
/// threading it through each source's configuration would add a parameter to
/// nine call sites and every test that builds one, to carry a value none of
/// them vary. Unset until the daemon installs one, and every method on the
/// returned handle is a no-op in that state — so a source reports health
/// unconditionally and a test that never installs one pays nothing.
/// REPLACEABLE, not set-once — the same correction made to `telemetry.rs`'s
/// `COLLECTOR_METRICS`, for the same reason and with the same consequence.
///
/// This was a `OnceLock`, so only the FIRST `install()` in a process took
/// effect. That was true for exactly one deployment of the collector: it is now
/// cycled whenever its configuration changes (a rotated credential, a stream
/// switched off) and rebuilt by `failproofai backfill`, and `collector_tasks()`
/// installs a fresh `Health` each time. Every later install was silently
/// dropped, so sources reported into the ORPHANED first-deployment registry
/// while the live `writer_task` published the one nobody was writing to.
/// `collector-health.json` kept being rewritten every 30s with frozen numbers,
/// and a source that had gone completely dark read exactly like a healthy one —
/// which defeats the only purpose this module has.
static GLOBAL: std::sync::RwLock<Option<std::sync::Arc<Health>>> = std::sync::RwLock::new(None);

/// Install the process health registry, replacing any previous one.
///
/// The caller installs before starting any source, so no poll ever reports into
/// a registry that does not exist yet, and the deployment being replaced is one
/// whose tasks have already been joined.
pub fn install(health: std::sync::Arc<Health>) {
    // A poisoned lock is not a reason to stop recording health: recover the
    // guard and carry on. The only operation is replacing one `Arc`, so there
    // is no torn value a panic could have left behind.
    let mut slot = GLOBAL.write().unwrap_or_else(|e| e.into_inner());
    *slot = Some(health);
}

/// The currently installed registry, if any. Cloned out rather than held, so a
/// source's own `record_*` call never runs with the registry lock held.
fn current() -> Option<std::sync::Arc<Health>> {
    GLOBAL
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .cloned()
}

/// Report a successful poll to the process registry, if one is installed.
pub fn report_poll(source: &str, root_present: bool, events: u64, cursor: u64) {
    if let Some(h) = current() {
        h.record_poll(source, root_present, events, cursor);
    }
}

/// Report a failed poll to the process registry, if one is installed.
pub fn report_error(source: &str, error: &str) {
    if let Some(h) = current() {
        h.record_error(source, error);
    }
}

/// Where the record lives.
pub fn health_path(home: &Path) -> PathBuf {
    home.join("state").join("collector-health.json")
}

/// Remove the record on a clean shutdown.
///
/// Absence means "no daemon running", which is unambiguous. Leaving a stale
/// file behind makes a stopped daemon look like a running one whose sources all
/// went quiet — the exact confusion this module exists to prevent.
pub fn remove(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Rewrite the record on an interval until shutdown, then delete it.
///
/// A task rather than a write-on-every-change: sources update health many times
/// a second, and rewriting the file each time would turn a diagnostic into a
/// disk-IO cost on the hot path.
pub async fn writer_task(
    health: std::sync::Arc<Health>,
    path: PathBuf,
    interval: std::time::Duration,
    sd: crate::supervisor::Shutdown,
) -> Result<(), crate::supervisor::TaskError> {
    loop {
        if let Err(err) = health.write(&path) {
            // Logged, never fatal: failing to write a heartbeat must not stop
            // the collection it is describing.
            tracing::warn!(path = %path.display(), %err, "could not write the collector health record");
        }
        if !sd.sleep(interval).await {
            // Clean shutdown: absence of the file means "no daemon running",
            // which is unambiguous in a way a stale record is not.
            remove(&path);
            return Ok(());
        }
    }
}

/// How often the record is rewritten.
pub const WRITE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn truncate(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.to_string();
    }
    let mut end = cap;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "fpai-health-{}-{}-{}",
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

    #[test]
    fn a_broken_source_is_distinguishable_from_an_unused_one() {
        // The whole point. Both produce zero events; only one is a problem.
        let h = Health::new();
        h.record_poll("claude", true, 0, 0); // installed, quiet
        h.record_poll("goose", false, 0, 0); // not installed at all

        let snap = h.snapshot();
        assert!(snap.sources["claude"].root_present);
        assert!(!snap.sources["goose"].root_present);
        assert_eq!(snap.sources["claude"].events, 0);
    }

    #[test]
    fn a_recovered_source_stops_showing_a_stale_error_but_keeps_the_count() {
        // A source that failed an hour ago and works now must not read as
        // broken — while still being distinguishable from one that never failed.
        let h = Health::new();
        h.record_error("codex", "permission denied");
        assert_eq!(h.snapshot().sources["codex"].errors, 1);
        assert!(h.snapshot().sources["codex"].last_error.is_some());

        h.record_poll("codex", true, 3, 900);
        let s = &h.snapshot().sources["codex"];
        assert!(
            s.last_error.is_none(),
            "a recovered source must clear its error"
        );
        assert_eq!(s.errors, 1, "but the fact it happened must survive");
    }

    #[test]
    fn events_accumulate_and_stamp_a_time_only_when_there_were_some() {
        // A poll that found nothing must not advance last_event_ts, or an idle
        // source would look permanently busy.
        let h = Health::new();
        h.record_poll("claude", true, 0, 10);
        assert_eq!(h.snapshot().sources["claude"].last_event_ts, 0);

        h.record_poll("claude", true, 5, 20);
        let s = &h.snapshot().sources["claude"];
        assert_eq!(s.events, 5);
        assert!(s.last_event_ts > 0);
        assert_eq!(s.cursor, 20);

        h.record_poll("claude", true, 2, 30);
        assert_eq!(
            h.snapshot().sources["claude"].events,
            7,
            "events accumulate"
        );
    }

    #[test]
    fn an_enormous_error_cannot_bloat_the_record() {
        // An error is a diagnostic, not a log. A multi-megabyte parse failure
        // would make the file unreadable.
        let h = Health::new();
        h.record_error("pi", &"x".repeat(100_000));
        let msg = h.snapshot().sources["pi"].last_error.clone().unwrap();
        assert!(msg.len() <= MAX_ERROR_LEN + 4, "got {} bytes", msg.len());
    }

    #[test]
    fn a_multibyte_error_is_truncated_on_a_char_boundary() {
        // Slicing mid-codepoint would panic inside the health writer, which is
        // the last place a panic is acceptable.
        let h = Health::new();
        h.record_error("pi", &"é".repeat(1000));
        assert!(h.snapshot().sources["pi"].last_error.is_some());
    }

    #[test]
    fn the_record_round_trips_through_disk() {
        let dir = tmpdir("write");
        let path = health_path(&dir);
        let h = Health::new();
        h.record_poll("claude", true, 4, 100);
        h.record_error("codex", "boom");
        h.write(&path).unwrap();

        let parsed: HealthFile =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(parsed.ts > 0, "a reader must be able to spot a stale file");
        assert_eq!(parsed.sources["claude"].events, 4);
        assert_eq!(parsed.sources["codex"].last_error.as_deref(), Some("boom"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writing_leaves_no_tmp_file_behind() {
        let dir = tmpdir("tmp");
        let path = health_path(&dir);
        Health::new().write(&path).unwrap();
        let stray = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(!stray, "the atomic write left its tmp behind");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The registry must follow the collector across a cycle.
    ///
    /// `GLOBAL` was a `OnceLock`, so the second `install()` — which happens on
    /// every credential rotation, every `[collector]` config change and every
    /// `failproofai backfill` — was silently dropped. Sources then reported
    /// through the free functions into the first deployment, which had already
    /// been joined, while the live `writer_task` published the second one.
    /// `collector-health.json` froze, and a dead source became
    /// indistinguishable from an idle one.
    ///
    /// Source names are unique to this test because `GLOBAL` is process-wide
    /// and the crate's tests run in parallel.
    #[test]
    fn a_reinstalled_registry_is_the_one_that_receives_reports() {
        let first = std::sync::Arc::new(Health::new());
        install(first.clone());
        report_poll("cycle-test-gen1", true, 3, 30);

        // Exactly what `collector_tasks()` does when the collector is cycled.
        let second = std::sync::Arc::new(Health::new());
        install(second.clone());
        report_poll("cycle-test-gen2", true, 7, 70);
        report_error("cycle-test-gen2", "boom");

        let gen2 = second.snapshot();
        let entry = gen2
            .sources
            .get("cycle-test-gen2")
            .expect("the live registry must receive reports made after it was installed");
        assert_eq!(entry.events, 7);
        assert_eq!(entry.errors, 1);

        // And the replaced deployment must go quiet rather than keep absorbing
        // them — that silent absorption is what made the file freeze.
        let gen1 = first.snapshot();
        assert!(
            !gen1.sources.contains_key("cycle-test-gen2"),
            "reports leaked into the orphaned deployment: {:?}",
            gen1.sources.keys().collect::<Vec<_>>()
        );
        assert!(
            gen1.sources.contains_key("cycle-test-gen1"),
            "the first deployment should still hold what it recorded while it was live"
        );
    }

    #[test]
    fn a_clean_shutdown_removes_the_record() {
        // Absence means "no daemon". A stale file makes a stopped daemon look
        // like a running one whose sources all went quiet.
        let dir = tmpdir("remove");
        let path = health_path(&dir);
        Health::new().write(&path).unwrap();
        assert!(path.exists());
        remove(&path);
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
