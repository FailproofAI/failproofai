//! Generic poller for agents that keep sessions in SQLite.
//!
//! Everything format-specific lives behind [`SqliteFormat`]; the engine owns
//! the connection, the watermark, and the spooling.
//!
//! # A rowid watermark is NOT sufficient, and that is the whole design
//!
//! The obvious poller reads `WHERE rowid > :last` and calls it done. Probing
//! the real databases showed that is wrong for every one of them, in three
//! different ways:
//!
//! * **opencode mutates rows for ~12 seconds after inserting them.** A tool
//!   part appears with `status:"running"` and an empty output, and the actual
//!   result is written by a later `UPDATE` to the same row. A rowid watermark
//!   ships every tool call with no result, forever, and looks like it is
//!   working.
//! * **hermes deletes rows.** Rewind and compaction issue `DELETE FROM
//!   messages`, so rowids are not merely non-contiguous, the history behind the
//!   watermark changes.
//! * **goose has `UPDATE messages SET content_json` and rewind deletes** in its
//!   binary, even though a happy-path session only appends.
//!
//! So a format declares its [`Watermark`], and the engine asks for rows the way
//! that format actually orders its changes.
//!
//! # Open read-only, and never `immutable`
//!
//! `immutable=1` tells SQLite the file cannot change, which makes it skip the
//! WAL entirely. That is catastrophic rather than merely stale here: goose's
//! `sessions.db` main file contains **zero tables**, with all 1.25 MB of schema
//! and rows sitting in an uncheckpointed `-wal`. Opening it `immutable` reads an
//! empty database and reports success. `SQLITE_OPEN_READ_ONLY` alone reads the
//! main file and its WAL together, which is what we want.
//!
//! Verified live: a reader polling opencode's database at 4 Hz throughout a
//! 12-second tool call, while opencode was actively writing, saw zero
//! `SQLITE_BUSY`.
//!
//! # All DB work happens on `spawn_blocking`
//!
//! `rusqlite` is synchronous. The connection is created and dropped inside the
//! closure and never crosses an `await`, so it needs no `Send` bound and cannot
//! be held across a yield point.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::cursor::{CursorStore, FileCursor};
use crate::spool::SpoolWriter;
use crate::supervisor::{Shutdown, TaskError};

/// How long to wait for a writer's lock before giving up on a query.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// How a format orders the changes the poller must pick up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Watermark {
    /// Monotonic insert id. Only correct where rows are never updated after
    /// insert AND never deleted.
    RowId,
    /// A last-modified column, so an updated row is re-read. Required for
    /// opencode, whose tool rows are filled in ~12s after they appear.
    UpdatedAt,
}

/// What one poll asked for and what it produced.
#[derive(Debug, Default)]
pub struct PollOutcome {
    pub events: Vec<Value>,
    /// The new watermark. Advanced only after the events are durably spooled.
    pub watermark: i64,
    /// True when the format hit its row limit, so the caller polls again
    /// immediately instead of sleeping — a backlog should drain, not trickle.
    pub more: bool,
    /// Rows examined. Reported so a poll that read a lot and emitted nothing is
    /// distinguishable from one that read nothing at all.
    pub rows_seen: u64,
}

/// One poll's inputs.
#[derive(Debug, Clone)]
pub struct PollRequest {
    pub watermark: i64,
    pub max_rows: u64,
    pub environment: String,
    pub agent_id: String,
}

/// The per-format adapter.
#[derive(Clone, Copy)]
pub struct SqliteFormat {
    /// Source kind — the spool filename prefix and log tag.
    pub kind: &'static str,
    pub watermark: Watermark,
    /// Read rows past the watermark and turn them into events.
    ///
    /// Runs on a blocking thread with a read-only connection. Must be pure with
    /// respect to `(connection contents, request)`: the server dedups on a
    /// content hash, so re-reading the same rows must produce the same bytes.
    pub poll: fn(&Connection, &PollRequest) -> rusqlite::Result<PollOutcome>,
}

#[derive(Debug, Clone)]
pub struct Params {
    pub agent_id: String,
    pub environment: String,
    /// Machine this daemon runs on, stamped on every event. See `SpoolWriter`.
    pub machine_id: Option<String>,
    /// OS user this daemon runs as, stamped on every event. See `SpoolWriter`.
    pub user: Option<String>,
    pub max_rows_per_poll: u64,
    pub max_batch_bytes: u64,
    /// Poll passes before yielding to the shutdown check. Bounds how long a
    /// backlog drain can ignore a stop request.
    pub max_drain_passes: u32,
}

pub struct Spec {
    pub format: SqliteFormat,
    pub db_path: PathBuf,
    pub spool_dir: PathBuf,
    pub state_dir: PathBuf,
    pub poll_interval: std::time::Duration,
    pub params: Params,
}

/// Poll until shutdown.
pub async fn run(spec: Spec, sd: Shutdown) -> Result<(), TaskError> {
    let mut cursors = CursorStore::load(spec.state_dir.clone());
    tracing::info!(
        source = spec.format.kind,
        db = %spec.db_path.display(),
        present = spec.db_path.exists(),
        watermark = ?spec.format.watermark,
        "sqlite source started"
    );

    loop {
        for _ in 0..spec.params.max_drain_passes.max(1) {
            if sd.is_set() {
                return Ok(());
            }
            match poll_once(&spec, &mut cursors).await {
                Ok((events, more)) => {
                    crate::health::report_poll(
                        spec.format.kind,
                        spec.db_path.exists(),
                        events,
                        cursors.len() as u64,
                    );
                    if !more {
                        break; // nothing more waiting
                    }
                    // Hit the row limit — drain rather than trickle.
                }
                Err(err) => {
                    tracing::warn!(source = spec.format.kind, %err, "poll failed; retrying next tick");
                    crate::health::report_error(spec.format.kind, &err.to_string());
                    break;
                }
            }
        }
        if !sd.sleep(spec.poll_interval).await {
            return Ok(());
        }
    }
}

/// One pass. Returns `(events spooled, more rows waiting)`.
async fn poll_once(spec: &Spec, cursors: &mut CursorStore) -> Result<(u64, bool), TaskError> {
    if !spec.db_path.exists() {
        // Normal: the agent simply is not installed.
        return Ok((0, false));
    }

    // The cursor store is keyed on (dev, inode) for file tailers. A database is
    // one logical stream, so a fixed synthetic key keeps one entry per source
    // regardless of the file being replaced underneath us (a vacuum or a
    // restore changes the inode without changing the data).
    let key_inode = 0u64;
    let watermark = cursors
        .resume(0, key_inode, &spec.db_path)
        .map(|c| c.offset as i64)
        .unwrap_or(0);

    let request = PollRequest {
        watermark,
        max_rows: spec.params.max_rows_per_poll,
        environment: spec.params.environment.clone(),
        agent_id: spec.params.agent_id.clone(),
    };

    let db_path = spec.db_path.clone();
    let poll = spec.format.poll;
    // The connection is created and dropped INSIDE the closure, so it never
    // crosses an await and needs no Send bound.
    let outcome = tokio::task::spawn_blocking(move || -> rusqlite::Result<PollOutcome> {
        let conn = open_readonly(&db_path)?;
        poll(&conn, &request)
    })
    .await
    .map_err(|e| TaskError::from(format!("sqlite poll task failed: {e}")))?
    .map_err(|e| TaskError::from(e.to_string()))?;

    if outcome.events.is_empty() {
        // Still advance the watermark: a pass that legitimately produced no
        // events (rows filtered out, say) must not re-read them forever.
        if outcome.watermark > watermark {
            store_watermark(cursors, spec, outcome.watermark)?;
        }
        return Ok((0, outcome.more));
    }

    let mut writer = SpoolWriter::new(
        spec.spool_dir.clone(),
        spec.params.max_batch_bytes,
        spec.format.kind,
        spec.format.kind,
    )
    .with_machine_id(spec.params.machine_id.clone())
    .with_user(spec.params.user.clone());
    let emitted = outcome.events.len() as u64;
    for event in outcome.events {
        writer.push(event).await.map_err(io_err)?;
    }
    // Flush BEFORE advancing. A crash between the two costs a re-ship the
    // server dedups; the other order loses the rows outright.
    writer.flush().await.map_err(io_err)?;
    store_watermark(cursors, spec, outcome.watermark)?;

    Ok((emitted, outcome.more))
}

fn store_watermark(
    cursors: &mut CursorStore,
    spec: &Spec,
    watermark: i64,
) -> Result<(), TaskError> {
    cursors.set(FileCursor {
        path: spec.db_path.clone(),
        dev: 0,
        inode: 0,
        offset: watermark.max(0) as u64,
        size_seen: 0,
        ..Default::default()
    });
    cursors.save().map_err(io_err)
}

/// Open read-only, WAL-aware, with a busy timeout.
///
/// `SQLITE_OPEN_READ_ONLY` and deliberately NOT a `?immutable=1` URI — see the
/// module docs for why that would read goose's database as empty.
pub fn open_readonly(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(conn)
}

fn io_err(e: std::io::Error) -> TaskError {
    TaskError::from(e.to_string())
}

/// Coerce a timestamp column to epoch milliseconds.
///
/// The four SQLite agents disagree on units: hermes writes REAL epoch SECONDS,
/// goose an INTEGER epoch seconds, opencode INTEGER milliseconds. Guessing from
/// magnitude is the only thing that works across all of them without a
/// per-source flag that would be wrong the first time a vendor changes.
pub fn epoch_to_millis(v: f64) -> i64 {
    if v > 1e12 {
        v as i64 // already milliseconds
    } else if v > 1e9 {
        (v * 1000.0) as i64 // seconds
    } else {
        0 // implausible; caller decides what to do with it
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_units_are_inferred_from_magnitude() {
        // hermes REAL seconds, goose INTEGER seconds, opencode INTEGER millis.
        assert_eq!(epoch_to_millis(1_785_744_251.686), 1_785_744_251_686);
        assert_eq!(epoch_to_millis(1_785_744_251.0), 1_785_744_251_000);
        assert_eq!(epoch_to_millis(1_785_744_251_686.0), 1_785_744_251_686);
        // Implausible values are reported as zero rather than silently becoming
        // 1970, which would put events at the start of every timeline.
        assert_eq!(epoch_to_millis(0.0), 0);
        assert_eq!(epoch_to_millis(42.0), 0);
    }

    #[test]
    fn a_read_only_connection_cannot_write() {
        // The guarantee that matters: the daemon reads other products'
        // databases and must never be able to corrupt one.
        let dir = std::env::temp_dir().join(format!("fpai-sq-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        {
            let c = Connection::open(&db).unwrap();
            c.execute_batch("CREATE TABLE t(a); INSERT INTO t VALUES (1);")
                .unwrap();
        }
        let ro = open_readonly(&db).unwrap();
        assert_eq!(
            ro.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(
            ro.execute("INSERT INTO t VALUES (2)", []).is_err(),
            "a read-only handle must refuse writes"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_wal_database_is_read_through_its_wal_not_just_the_main_file() {
        // goose's main DB file contains ZERO tables, with everything in an
        // uncheckpointed -wal. A reader that only sees the main file reads an
        // empty database and reports success.
        let dir = std::env::temp_dir().join(format!("fpai-sqwal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("wal.db");
        let writer = Connection::open(&db).unwrap();
        writer.pragma_update(None, "journal_mode", "WAL").unwrap();
        writer
            .execute_batch("CREATE TABLE m(id INTEGER PRIMARY KEY, v TEXT);")
            .unwrap();
        writer
            .execute("INSERT INTO m(v) VALUES ('in-wal')", [])
            .unwrap();
        // Deliberately NOT checkpointed and NOT closed — this is goose's state.

        let ro = open_readonly(&db).unwrap();
        let n: i64 = ro
            .query_row("SELECT count(*) FROM m", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            n, 1,
            "the WAL contents must be visible to a read-only reader"
        );

        drop(writer);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reading_works_while_a_writer_holds_the_database() {
        // Verified live against opencode at 4 Hz through a 12s tool call with
        // zero SQLITE_BUSY; this pins the property in CI.
        let dir = std::env::temp_dir().join(format!("fpai-sqbusy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("busy.db");
        let writer = Connection::open(&db).unwrap();
        writer.pragma_update(None, "journal_mode", "WAL").unwrap();
        writer
            .execute_batch("CREATE TABLE m(id INTEGER PRIMARY KEY, v TEXT);")
            .unwrap();

        let ro = open_readonly(&db).unwrap();
        for i in 0..20 {
            writer
                .execute("INSERT INTO m(v) VALUES (?1)", [format!("row{i}")])
                .unwrap();
            let n: i64 = ro
                .query_row("SELECT count(*) FROM m", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                n,
                i + 1,
                "a concurrent reader must see committed rows immediately"
            );
        }
        drop(writer);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_database_is_an_error_not_a_panic() {
        // The agent simply is not installed. Common, and not a fault.
        assert!(open_readonly(Path::new("/nonexistent/fpai/none.db")).is_err());
    }
}
