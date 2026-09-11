//! OpenClaw 2026.9.2+ transcript capture from per-agent SQLite databases.
//!
//! Live transcripts moved from `sessions/<uuid>.jsonl` to
//! `agent/openclaw-agent.sqlite`. The `event_json` rows are the exact logical
//! JSONL records, so this adapter feeds them through the existing OpenClaw
//! transform and assigns the byte offsets they would have had in the archived
//! JSONL file. That keeps legacy-file and SQLite delivery dedup-compatible.
//!
//! A global rowid watermark is deliberately not used. `seq` is scoped to one
//! session, and OpenClaw can replace or rewrite prior rows. The
//! `transcript_rewrite_watermarks.generation` token is the authority for that
//! case: when it changes, all derived state for that session is reset and the
//! current generation is read again from sequence zero.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use crate::config::Redact;
use crate::cursor::{CursorStore, FileCursor};
use crate::filetail::Ctx;
use crate::spool::SpoolWriter;
use crate::supervisor::{Shutdown, TaskError};

use super::{DEFAULT_AGENT_ID, transform};

const DB_NAME: &str = "openclaw-agent.sqlite";
const AGENT_DIR: &str = "agent";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const HEADER_ROWS: i64 = 64;

#[derive(Debug, Clone)]
pub struct Params {
    pub environment: String,
    pub redact: Redact,
    pub machine_id: Option<String>,
    pub user: Option<String>,
    pub label: Option<String>,
    pub max_rows_per_session: u64,
    pub max_batch_bytes: u64,
    /// Skip sessions with no activity inside this window on first discovery.
    pub since_days: Option<u64>,
}

pub struct Spec {
    /// Each root is OpenClaw's `agents/` directory.
    pub roots: Vec<PathBuf>,
    pub spool_dir: PathBuf,
    pub state_dir: PathBuf,
    pub poll_interval: Duration,
    pub params: Params,
    pub health_key: Option<String>,
}

#[derive(Debug)]
struct SessionRow {
    session_id: String,
    generation: Option<String>,
    activity_ms: i64,
    ended_at: Option<i64>,
    max_seq: i64,
}

#[derive(Debug)]
struct TranscriptRow {
    seq: i64,
    event_json: String,
}

#[derive(Debug)]
struct TranscriptPoll {
    generation: Option<String>,
    max_seq: i64,
    header: Vec<String>,
    rows: Vec<TranscriptRow>,
}

#[derive(Debug)]
struct DbPoll {
    sessions: Vec<SessionRow>,
}

/// Poll every discovered per-agent database until shutdown.
pub async fn run(spec: Spec, sd: Shutdown) -> Result<(), TaskError> {
    let health_key = spec
        .health_key
        .clone()
        .unwrap_or_else(|| "openclaw-sqlite".to_string());
    let mut cursors = CursorStore::load(spec.state_dir.clone());

    loop {
        let databases = discover_databases(&spec.roots);
        let present = !databases.is_empty();
        let mut events = 0u64;
        let mut first_error = None;

        for db_path in databases {
            match process_database(&spec, &mut cursors, &db_path).await {
                Ok(n) => events += n,
                Err(err) => {
                    tracing::warn!(db = %db_path.display(), %err, "could not process OpenClaw database");
                    if first_error.is_none() {
                        first_error = Some(format!("{}: {err}", db_path.display()));
                    }
                }
            }
        }

        cursors.retain_existing();
        cursors.save().map_err(io_err)?;
        crate::health::report_poll(&health_key, present, events, cursors.len() as u64);
        if let Some(err) = first_error {
            crate::health::report_error(&health_key, &err);
        }

        if !sd.sleep(spec.poll_interval).await {
            return Ok(());
        }
    }
}

/// Discover `<agents>/<agentId>/agent/openclaw-agent.sqlite` dynamically.
pub fn discover_databases(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in roots {
        if root.file_name().is_some_and(|name| name == DB_NAME) && root.is_file() {
            out.push(root.clone());
            continue;
        }
        discover_under_agents(root, &mut out);
        // Extra paths have historically accepted either the `agents/` folder
        // or the OpenClaw state directory containing it.
        discover_under_agents(&root.join("agents"), &mut out);
    }
    out.sort();
    out.dedup();
    out
}

fn discover_under_agents(root: &Path, out: &mut Vec<PathBuf>) {
    let direct = root.join(AGENT_DIR).join(DB_NAME);
    if direct.is_file() {
        out.push(direct);
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let candidate = entry.path().join(AGENT_DIR).join(DB_NAME);
        if candidate.is_file() {
            out.push(candidate);
        }
    }
}

async fn process_database(
    spec: &Spec,
    cursors: &mut CursorStore,
    db_path: &Path,
) -> Result<u64, TaskError> {
    let path = db_path.to_path_buf();
    let db_poll = tokio::task::spawn_blocking(move || read_sessions(&path))
        .await
        .map_err(|e| TaskError::from(format!("OpenClaw SQLite task failed: {e}")))?
        .map_err(sql_err)?;

    let agent_id = agent_id_from_database(db_path).unwrap_or_else(|| DEFAULT_AGENT_ID.to_string());
    let db_key = stable_hash(db_path.to_string_lossy().as_bytes());
    let mut emitted = 0u64;

    for session in db_poll.sessions {
        let session_key = stable_hash(session.session_id.as_bytes());
        let existing = cursors.resume(db_key, session_key, db_path).cloned();
        if existing.is_none() && !within_window(session.activity_ms, spec.params.since_days) {
            continue;
        }

        let mut cursor = existing.unwrap_or_else(|| FileCursor {
            path: db_path.to_path_buf(),
            dev: db_key,
            inode: session_key,
            session_id: Some(session.session_id.clone()),
            agent_id: Some(agent_id.clone()),
            sqlite_seq: None,
            sqlite_generation: session.generation.clone(),
            ..Default::default()
        });

        if cursor.sqlite_generation != session.generation {
            cursor = FileCursor {
                path: db_path.to_path_buf(),
                dev: db_key,
                inode: session_key,
                session_id: Some(session.session_id.clone()),
                agent_id: Some(agent_id.clone()),
                sqlite_seq: None,
                sqlite_generation: session.generation.clone(),
                ..Default::default()
            };
        }

        let has_new_rows = cursor.sqlite_seq.is_none_or(|seq| seq < session.max_seq);
        let needs_end = !cursor.ended
            && cursor.agent_start_emitted
            && session.ended_at.is_some()
            && !has_new_rows;
        if !has_new_rows && cursor.agent_start_emitted && !needs_end {
            continue;
        }

        let path = db_path.to_path_buf();
        let session_id = session.session_id.clone();
        let after_seq = cursor.sqlite_seq.unwrap_or(-1);
        let limit = spec.params.max_rows_per_session.max(1) as i64;
        let transcript = tokio::task::spawn_blocking(move || {
            read_transcript(&path, &session_id, after_seq, limit)
        })
        .await
        .map_err(|e| TaskError::from(format!("OpenClaw SQLite task failed: {e}")))?
        .map_err(sql_err)?;
        // A rewrite between the session-list query and this transcript
        // snapshot would mix two generations. Leave the durable cursor alone;
        // the next poll will see the new token and restart cleanly.
        if transcript.generation != session.generation {
            continue;
        }

        let ctx = Ctx {
            session_id: session.session_id.clone(),
            agent_id: cursor.agent_id.clone().unwrap_or_else(|| agent_id.clone()),
            environment: spec.params.environment.clone(),
            file_epoch_ms: None,
        };
        let mut writer = SpoolWriter::new(
            spec.spool_dir.clone(),
            spec.params.max_batch_bytes,
            "openclaw",
            &ctx.session_id,
        )
        .with_label(spec.params.label.clone())
        .with_machine_id(spec.params.machine_id.clone())
        .with_user(spec.params.user.clone())
        .with_redact(spec.params.redact);

        if !cursor.agent_start_emitted
            && let Some((event, ts)) = transform::agent_start(&transcript.header, &ctx, 0)
        {
            writer.push(event).await.map_err(io_err)?;
            emitted += 1;
            cursor.agent_start_emitted = true;
            if cursor.last_ts.is_none() {
                cursor.last_ts = ts;
            }
        }

        if cursor.ended
            && transcript
                .rows
                .last()
                .is_some_and(|r| Some(r.seq) > cursor.sqlite_seq)
        {
            cursor.ended = false;
        }

        for row in transcript.rows {
            let offset = cursor.offset;
            let (ts, events) =
                transform::transform_line(&row.event_json, &ctx, offset, &mut cursor.state);
            if let Some(ts) = ts {
                cursor.last_ts = Some(ts);
            }
            for event in events {
                writer.push(event).await.map_err(io_err)?;
                emitted += 1;
            }
            cursor.offset += row.event_json.len() as u64 + 1;
            cursor.size_seen = cursor.offset;
            cursor.sqlite_seq = Some(row.seq);
        }

        if !cursor.ended
            && cursor.agent_start_emitted
            && session.ended_at.is_some()
            && cursor
                .sqlite_seq
                .is_some_and(|seq| seq >= transcript.max_seq)
            && let Some(last_ts) = cursor.last_ts.clone()
        {
            writer
                .push(transform::agent_end(&ctx, &last_ts, cursor.offset))
                .await
                .map_err(io_err)?;
            emitted += 1;
            cursor.ended = true;
        }

        // Flush before advancing the durable cursor. A crash in between only
        // re-ships deterministic events, which server-side dedup collapses.
        writer.flush().await.map_err(io_err)?;
        cursors.set(cursor);
    }

    Ok(emitted)
}

fn read_sessions(path: &Path) -> rusqlite::Result<DbPoll> {
    let conn = open_readonly(path)?;
    let mut stmt = conn.prepare(
        "SELECT w.session_id, r.generation,
                MAX(COALESCE(w.transcript_updated_at, 0),
                    COALESCE(w.updated_at, 0),
                    COALESCE((SELECT MAX(e.created_at) FROM transcript_events e
                              WHERE e.session_id = w.session_id), 0)) AS activity_ms,
                w.ended_at,
                (SELECT MAX(e.seq) FROM transcript_events e
                  WHERE e.session_id = w.session_id) AS max_seq
           FROM session_windows w
           LEFT JOIN transcript_rewrite_watermarks r ON r.session_id = w.session_id
          WHERE EXISTS (SELECT 1 FROM transcript_events e WHERE e.session_id = w.session_id)
          ORDER BY activity_ms ASC, w.session_id ASC",
    )?;
    let sessions = stmt
        .query_map([], |row| {
            Ok(SessionRow {
                session_id: row.get(0)?,
                generation: row.get(1)?,
                activity_ms: row.get(2)?,
                ended_at: row.get(3)?,
                max_seq: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(DbPoll { sessions })
}

fn read_transcript(
    path: &Path,
    session_id: &str,
    after_seq: i64,
    limit: i64,
) -> rusqlite::Result<TranscriptPoll> {
    let mut conn = open_readonly(path)?;
    let tx = conn.transaction()?;
    let generation = tx
        .query_row(
            "SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()?;
    let max_seq = tx.query_row(
        "SELECT COALESCE(MAX(seq), -1) FROM transcript_events WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    )?;
    let mut header_stmt = tx.prepare(
        "SELECT event_json FROM transcript_events
          WHERE session_id = ?1 ORDER BY seq ASC LIMIT ?2",
    )?;
    let header = header_stmt
        .query_map((session_id, HEADER_ROWS), |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut rows_stmt = tx.prepare(
        "SELECT seq, event_json FROM transcript_events
          WHERE session_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
    )?;
    let rows = rows_stmt
        .query_map((session_id, after_seq, limit), |row| {
            Ok(TranscriptRow {
                seq: row.get(0)?,
                event_json: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(rows_stmt);
    drop(header_stmt);
    tx.commit()?;
    Ok(TranscriptPoll {
        generation,
        max_seq,
        header,
        rows,
    })
}

fn open_readonly(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(conn)
}

fn agent_id_from_database(path: &Path) -> Option<String> {
    let agent_dir = path.parent()?.parent()?;
    if agent_dir.parent()?.file_name()? != "agents" {
        return None;
    }
    let id = transform::sanitize_id_part(agent_dir.file_name()?.to_str()?);
    (!id.is_empty()).then(|| format!("openclaw-{id}"))
}

fn within_window(activity_ms: i64, days: Option<u64>) -> bool {
    let Some(days) = days else {
        return true;
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i128)
        .unwrap_or(0);
    let window_ms = i128::from(days) * 24 * 60 * 60 * 1000;
    i128::from(activity_ms) >= now_ms.saturating_sub(window_ms)
}

fn stable_hash(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn sql_err(err: rusqlite::Error) -> TaskError {
    TaskError::from(err.to_string())
}

fn io_err(err: std::io::Error) -> TaskError {
    TaskError::from(err.to_string())
}
