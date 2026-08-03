//! opencode session capture — a [`sqlitepoll`](crate::sqlitepoll) adapter.
//!
//! opencode keeps every session on the machine in ONE SQLite database at
//! `$XDG_DATA_HOME/opencode/opencode.db` (`~/.local/share/opencode/opencode.db`
//! on a default install). We open it read-only, through its WAL, and never
//! write, checkpoint or vacuum it — see [`crate::sqlitepoll::open_readonly`].
//!
//! # Rows mutate for ~12 seconds after they are inserted, and that is the design
//!
//! This is the source the [`Watermark::UpdatedAt`] machinery exists for. A tool
//! call and its result are the SAME `part` row: the row appears with
//! `state.status:"running"` and an EMPTY `state.output`, and the real result
//! arrives as a later `UPDATE` to that row. Directly observed on the probe
//! capture — one row changed three times, and `state.output` was populated only
//! on the third, 12.0 seconds after the row first appeared:
//!
//! ```text
//! t+0.0s  NEW rowid=20 type=tool tool=bash status=running   out=''               tu=…539061
//! t+0.3s  MUT rowid=20 type=tool tool=bash status=running   out=''               tu=…539110
//! t+12.0s MUT rowid=20 type=tool tool=bash status=completed out='SECOND_MARKER'  tu=…551135
//! ```
//!
//! **A rowid watermark ships every tool call in this product with an empty
//! result, forever, while looking like it works.** Nothing errors, nothing is
//! missing from the event stream, and every `tool_result` is blank. So this
//! format declares [`Watermark::UpdatedAt`] and queries
//! `time_updated > :watermark ORDER BY time_updated, id`, which brings a
//! mutated row back through the transform.
//!
//! Re-emitting a re-read row is safe: a completed row is stable (verified
//! byte-identical across two later turns), so the server's content dedup
//! collapses an unchanged re-read, and a row that genuinely changed is stored
//! as the new fact it is. The transforms are written to make that hold — see
//! the notes on `tool_use` and `agent_start` in [`transform`], both of which
//! avoid fields that opencode rewrites so their re-reads hash the same.
//!
//! The second half of the story is that a row is only shipped once opencode
//! has finished writing it, which the row itself says: a text part carries
//! `time.end` when the stream is done, a tool part a terminal `state.status`.
//! Without that, a 30-second streamed answer polled every few seconds becomes
//! a dozen `model_response` rows, each a longer prefix of the same text.
//!
//! # `session.directory`, never `session.path` or `project_id`
//!
//! The agent id is `opencode-<project>` derived from `session.directory`, which
//! is the absolute working directory and is reliable. The two neighbouring
//! columns are traps, both verified on the capture:
//!
//! * `session.path` is relative to a git worktree, so it is **the empty string
//!   at the repository root** — exactly the case that matters most. (Non-git
//!   directories get a relative-looking `tmp/probe-opencode`, which is worse:
//!   it looks usable.)
//! * `session.project_id` is a synthetic `"global"` for every session started
//!   outside a git repository, so it groups unrelated projects together.
//!
//! # The `event` table is a better tail target that we deliberately do not use
//!
//! opencode also keeps an append-only, event-sourced `event(id, aggregate_id,
//! seq, type, data)` table with `UNIQUE(aggregate_id, seq)` — a monotonic
//! per-session sequence, which is a far nicer thing to tail than a mutating
//! row. It is not the durable copy: **three of the shipped schema migrations
//! contain `DELETE FROM event`** (counted in the 1.18.11 binary), so
//! history behind a watermark can vanish on upgrade. `message` and `part` have
//! no such migration and are the durable source; `event` is a cache in front of
//! them. Worth revisiting if opencode ever commits to retaining it.
//!
//! # `session_message` is dead
//!
//! `session_message` looks like exactly the table this source wants and is
//! permanently empty — it is legacy, and four migrations `DELETE FROM` it.
//! All content lives in `part.data`; `message.data` is metadata only (`role`,
//! tokens, timing, `finish`), which is why every part is read joined to its
//! message rather than instead of it.
//!
//! # Scope
//!
//! `text` and `tool` parts, plus the session's start and end. `step-start`,
//! `step-finish`, `reasoning`, `snapshot`, `patch` and `file` parts emit
//! nothing: they are turn structure or need event types of their own, and
//! ignoring an unrecognised part type is also what keeps a new opencode
//! release from breaking this source rather than merely widening it.

pub mod transform;

use std::path::PathBuf;

use rusqlite::{Connection, ToSql};
use serde_json::Value;

use crate::sqlitepoll::{PollOutcome, PollRequest, SqliteFormat, Watermark};
use transform::{PartRow, SessionRow};

/// The format the poller drives.
pub const FORMAT: SqliteFormat = SqliteFormat {
    kind: "opencode",
    watermark: Watermark::UpdatedAt,
    poll,
};

/// The agent id used when a session's directory yields no usable project.
pub const DEFAULT_AGENT_ID: &str = "opencode";

/// `$XDG_DATA_HOME/opencode/opencode.db`, else `~/.local/share/opencode/…`.
///
/// opencode resolves its data directory with the `xdg-basedir` package, which
/// returns `~/.local/share` on macOS as well as Linux — so this one rule
/// covers both platforms rather than needing a `cfg`.
pub fn default_db_path() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from(".local/share"))
        .join("opencode")
        .join("opencode.db")
}

/// Everything a `session` row contributes, including the two facts that need a
/// correlated subquery: its earliest part (the goal, and proof the session was
/// actually used) and its latest message (whether a turn is in flight).
const SESSION_SELECT: &str = "\
SELECT s.id, s.directory, s.version, s.slug, s.parent_id, s.time_created, s.time_updated, \
       s.tokens_input, s.tokens_output, s.tokens_reasoning, \
       s.tokens_cache_read, s.tokens_cache_write, \
       (SELECT p.data FROM part p WHERE p.session_id = s.id \
         ORDER BY p.time_created, p.id LIMIT 1), \
       (SELECT m.data FROM message m WHERE m.session_id = s.id \
         ORDER BY m.time_created DESC, m.id DESC LIMIT 1) \
  FROM session s";
const SESSION_ORDER: &str = " ORDER BY s.time_updated, s.id";

/// A part joined to its message (for the role and model — a part carries
/// neither) and to its session (for the directory the agent id derives from).
const PART_SELECT: &str = "\
SELECT p.id, p.session_id, p.message_id, p.time_created, p.time_updated, p.data, \
       m.data, s.directory \
  FROM part p \
  JOIN message m ON m.id = p.message_id \
  JOIN session s ON s.id = p.session_id";
const PART_ORDER: &str = " ORDER BY p.time_updated, p.id";

/// One poll: read both streams past the watermark, merge them into one
/// time-ordered batch, and transform.
///
/// Pure with respect to `(database contents, request)`, which the module docs
/// explain is what makes re-reading a mutated row safe.
fn poll(conn: &Connection, req: &PollRequest) -> rusqlite::Result<PollOutcome> {
    let limit = req.max_rows.max(1);
    // One row past the limit, because the extra row is the only thing that
    // reveals a batch ending in the MIDDLE of a millisecond. `time_updated` is
    // milliseconds, so several rows routinely share one value; cutting between
    // two of them and then asking for `time_updated > :last` skips the rest of
    // that millisecond forever.
    let fetch = limit.saturating_add(1) as i64;

    let mut rows = read_after(conn, req.watermark, fetch)?;
    let mut rows_seen = rows.len() as u64;
    let more = rows_seen > limit;

    if more {
        let cut = rows[limit as usize].time_updated();
        rows.truncate(limit as usize);
        while rows.last().is_some_and(|r| r.time_updated() == cut) {
            rows.pop();
        }
        if rows.is_empty() {
            // Degenerate: a single millisecond holds more rows than the whole
            // limit, so trimming to a millisecond boundary leaves nothing and
            // the watermark can never advance past it. Take that millisecond
            // whole instead — it is one instant of one product's writes, so it
            // is bounded however small the configured limit is.
            rows = read_at(conn, cut)?;
            rows_seen += rows.len() as u64;
        }
    }

    // Only ever the last SHIPPED row: a watermark past a row whose events were
    // trimmed away would drop it.
    let watermark = rows.last().map_or(req.watermark, Row::time_updated);
    let events = rows
        .iter()
        .flat_map(|r| r.events(&req.environment, &req.agent_id))
        .collect();

    Ok(PollOutcome {
        events,
        watermark,
        more,
        rows_seen,
    })
}

/// Both streams strictly past the watermark, merged and ordered.
fn read_after(conn: &Connection, watermark: i64, limit: i64) -> rusqlite::Result<Vec<Row>> {
    let sessions = format!("{SESSION_SELECT} WHERE s.time_updated > ?1{SESSION_ORDER} LIMIT ?2");
    let parts = format!("{PART_SELECT} WHERE p.time_updated > ?1{PART_ORDER} LIMIT ?2");
    merge(
        query(conn, &sessions, &[&watermark, &limit], map_session)?,
        query(conn, &parts, &[&watermark, &limit], map_part)?,
    )
}

/// Both streams for exactly one millisecond, unlimited. The safety valve for
/// the degenerate case in [`poll`].
fn read_at(conn: &Connection, at: i64) -> rusqlite::Result<Vec<Row>> {
    let sessions = format!("{SESSION_SELECT} WHERE s.time_updated = ?1{SESSION_ORDER}");
    let parts = format!("{PART_SELECT} WHERE p.time_updated = ?1{PART_ORDER}");
    merge(
        query(conn, &sessions, &[&at], map_session)?,
        query(conn, &parts, &[&at], map_part)?,
    )
}

fn merge(sessions: Vec<SessionRow>, parts: Vec<PartRow>) -> rusqlite::Result<Vec<Row>> {
    let mut rows: Vec<Row> = sessions
        .into_iter()
        .map(Row::Session)
        .chain(parts.into_iter().map(Row::Part))
        .collect();
    // `(time_updated, table, id)` and never the insertion order of the two
    // queries: the batch has to come out the same way every time or a re-read
    // would not reproduce the same bytes.
    rows.sort_by(|a, b| {
        (a.time_updated(), a.table_rank(), a.id()).cmp(&(b.time_updated(), b.table_rank(), b.id()))
    });
    Ok(rows)
}

fn query<T>(
    conn: &Connection,
    sql: &str,
    args: &[&dyn ToSql],
    map: fn(&rusqlite::Row) -> rusqlite::Result<T>,
) -> rusqlite::Result<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(args, map)?;
    rows.collect()
}

/// One row from either stream.
enum Row {
    Session(SessionRow),
    Part(PartRow),
}

impl Row {
    fn time_updated(&self) -> i64 {
        match self {
            Row::Session(s) => s.time_updated,
            Row::Part(p) => p.time_updated,
        }
    }

    /// Sessions before parts within one millisecond, so a session's
    /// `agent_start` is spooled ahead of the content of the turn that created
    /// it on a first full read.
    fn table_rank(&self) -> u8 {
        match self {
            Row::Session(_) => 0,
            Row::Part(_) => 1,
        }
    }

    fn id(&self) -> &str {
        match self {
            Row::Session(s) => &s.id,
            Row::Part(p) => &p.id,
        }
    }

    fn events(&self, environment: &str, fallback_agent_id: &str) -> Vec<Value> {
        match self {
            Row::Session(s) => transform::session_events(s, environment, fallback_agent_id),
            Row::Part(p) => transform::part_events(p, environment, fallback_agent_id),
        }
    }
}

fn map_session(r: &rusqlite::Row) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: r.get(0)?,
        directory: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
        version: r.get(2)?,
        slug: r.get(3)?,
        parent_id: r.get(4)?,
        time_created: r.get::<_, Option<i64>>(5)?.unwrap_or_default(),
        time_updated: r.get::<_, Option<i64>>(6)?.unwrap_or_default(),
        tokens_input: r.get::<_, Option<i64>>(7)?.unwrap_or_default(),
        tokens_output: r.get::<_, Option<i64>>(8)?.unwrap_or_default(),
        tokens_reasoning: r.get::<_, Option<i64>>(9)?.unwrap_or_default(),
        tokens_cache_read: r.get::<_, Option<i64>>(10)?.unwrap_or_default(),
        tokens_cache_write: r.get::<_, Option<i64>>(11)?.unwrap_or_default(),
        first_part: parse_json(r.get::<_, Option<String>>(12)?),
        last_message: parse_json(r.get::<_, Option<String>>(13)?),
    })
}

fn map_part(r: &rusqlite::Row) -> rusqlite::Result<PartRow> {
    Ok(PartRow {
        id: r.get(0)?,
        session_id: r.get(1)?,
        message_id: r.get(2)?,
        time_created: r.get::<_, Option<i64>>(3)?.unwrap_or_default(),
        time_updated: r.get::<_, Option<i64>>(4)?.unwrap_or_default(),
        data: parse_json(r.get::<_, Option<String>>(5)?).unwrap_or(Value::Null),
        message: parse_json(r.get::<_, Option<String>>(6)?).unwrap_or(Value::Null),
        directory: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
    })
}

/// Unparseable JSON is a row we cannot describe, not a poll we should fail:
/// one malformed `data` blob must not stop the other product's whole history
/// from shipping.
fn parse_json(raw: Option<String>) -> Option<Value> {
    serde_json::from_str(raw.as_deref()?).ok()
}
