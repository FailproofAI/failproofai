//! Devin (Cognition) session capture — a [`sqlitepoll`](crate::sqlitepoll) adapter.
//!
//! Devin's CLI keeps every session in ONE SQLite database,
//! `~/.local/share/devin/cli/sessions.db`. There are no per-session files, so
//! there is nothing for [`filetail`](crate::filetail) to tail. Verified live
//! against devin v3000.1.27:
//!
//! ```text
//! sessions(id TEXT PK, working_directory TEXT NOT NULL, backend_type, model TEXT NOT NULL,
//!          agent_mode, created_at INT, last_activity_at INT, title, main_chain_id,
//!          shell_last_seen_index, cogs_json, workspace_dirs, hidden INT NOT NULL DEFAULT 0,
//!          metadata)
//! message_nodes(row_id INTEGER PK AUTOINCREMENT, session_id TEXT NOT NULL,
//!               node_id INT NOT NULL, parent_node_id INT, chat_message TEXT NOT NULL,
//!               created_at INT NOT NULL, metadata, UNIQUE(session_id, node_id))
//! ```
//!
//! # A rowid watermark on the append-only `message_nodes.row_id`
//!
//! [`Watermark::RowId`] is declared because `row_id` is
//! `INTEGER PRIMARY KEY AUTOINCREMENT` and Devin only ever appends nodes — a new
//! turn adds rows, it does not rewrite old ones. As with goose this is
//! append-accurate and edit-blind: a row edited or deleted behind the watermark
//! is invisible, which has not been observed in a normal session.
//!
//! # `message_nodes` is a FOREST — the forest gotcha
//!
//! A session's messages are not a flat list. Each turn is a `node_id` linked to
//! its `parent_node_id`, and Devin **replays the earlier conversation under a
//! fresh root on every turn**, so the table holds many branches repeating the
//! same messages (verified live: 34 rows / 14 distinct messages for one session,
//! each message on 2-4 rows). Reading every row therefore ships each message
//! several times.
//!
//! This source does NOT reconstruct the active path (the audit half,
//! `lib/devin-sessions.ts`, does, by walking the newest leaf to its root). It
//! ships row by row like goose and lets the server collapse the replays, which
//! works because the emitted events are keyed on a REPLAY-STABLE identity:
//!
//! * the dedup discriminator is `devin_message_id` (the message's own UUID),
//!   identical across every replay — see [`transform`];
//! * the timestamp is the message's `metadata.created_at` (a nanosecond ISO
//!   string carried inside `chat_message`), also identical across replays.
//!
//! So every replay of a message renders byte-identical and collapses to one,
//! while two genuinely distinct messages stay distinct. The `row_id` never
//! appears in an event — including it would defeat the collapse. The cost is that
//! the spool carries the replays until the server dedups them; the alternative
//! (in-process active-path reconstruction) is the audit half's job, not a
//! streaming poller's.
//!
//! # Where `agent_start` comes from, and why there is no `agent_end`
//!
//! Devin writes no session-start marker, and a [`SqliteFormat`] is one pure
//! `poll` with the wall clock off limits (consulting it would make two reads of
//! the same rows differ). `agent_start` therefore rides a session's first row
//! (`MIN(row_id)`, emitted once) but is stamped at the SESSION's immutable
//! `created_at` — not the row's time, because under the forest the first row by
//! `row_id` is not the earliest message by time.
//!
//! There is deliberately **no** `agent_end`. goose derives one from the row after
//! a session's last row, stamped at that row's time — but neither of Devin's
//! two candidate anchors survives the forest: `sessions.last_activity_at` MUTATES
//! (so a later poll would re-emit a different end and never collapse), and the
//! `MAX(row_id)` row is a replay whose `metadata.created_at` can be an OLD
//! message's time (so the end would sort before live content). With no
//! re-read-stable, correctly-timed, row-local anchor, the honest choice is to
//! emit none and leave session completion to be inferred downstream — the same
//! class of gap goose documents for its newest open session, forced here by the
//! replay forest.
//!
//! # `hidden` sessions are filtered
//!
//! `sessions.hidden != 0` rows are Devin's scratch/hidden sessions, the analog of
//! goose's `session_type='hidden'`. They are filtered from the product but still
//! advance the watermark, so they are never re-read for the life of the machine.

pub mod transform;

use std::collections::BTreeMap;
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::sqlitepoll::{PollOutcome, PollRequest, SqliteFormat, Watermark};
use transform::{MessageRow, RowCtx};

/// The format table the sqlite engine drives.
pub const FORMAT: SqliteFormat = SqliteFormat {
    kind: "devin",
    watermark: Watermark::RowId,
    poll,
};

/// The agent id used when a session has no usable `working_directory`.
pub const DEFAULT_AGENT_ID: &str = "devin";

// ── database location ────────────────────────────────────────────────────

/// Where Devin keeps its sessions database.
///
/// `DEVIN_DB_PATH` and `DEVIN_HOME` are the same overrides `lib/devin-sessions.ts`
/// honours, so a relocated Devin home stays covered by both halves of the product
/// rather than by whichever half was tested. `DEVIN_HOME` names the Devin *data*
/// directory (the one that contains `cli/`), matching the audit half's meaning of
/// the variable — pointing it at a database file is a mistake `DEVIN_DB_PATH`
/// exists to serve.
pub fn db_path() -> PathBuf {
    db_path_from(var("DEVIN_DB_PATH"), var("DEVIN_HOME"), var("HOME"))
}

fn var(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// The resolution order, split out so it is testable without mutating the
/// process environment (which is `unsafe` in edition 2024 and races every other
/// test in the binary).
pub fn db_path_from(
    db: Option<PathBuf>,
    devin_home: Option<PathBuf>,
    home: Option<PathBuf>,
) -> PathBuf {
    if let Some(p) = db {
        return p;
    }
    let data = devin_home.unwrap_or_else(|| {
        home.unwrap_or_default()
            .join(".local")
            .join("share")
            .join("devin")
    });
    data.join("cli").join("sessions.db")
}

// ── queries ──────────────────────────────────────────────────────────────

/// The batch. A LEFT JOIN rather than an inner one: the `session_id` foreign key
/// is declared but SQLite does not enforce it unless `PRAGMA foreign_keys` is on,
/// so an inner join would make a message with a missing session row vanish
/// silently instead of shipping with a fallback agent id.
const SELECT_ROWS: &str = "\
SELECT m.row_id, m.session_id, m.chat_message, m.created_at, \
       s.working_directory, s.model, s.created_at, s.hidden \
  FROM message_nodes m \
  LEFT JOIN sessions s ON s.id = m.session_id \
 WHERE m.row_id > ?1 \
 ORDER BY m.row_id \
 LIMIT ?2";

/// A session's first row, for the `agent_start` rule. Cached per poll so a batch
/// touching one session runs it once.
const SELECT_MIN_ROW: &str = "SELECT MIN(row_id) FROM message_nodes WHERE session_id = ?1";

/// The assistant `tool_calls` message for a result whose call landed in an
/// earlier batch.
///
/// `LIKE` rather than a join because the id lives inside the JSON blob. The
/// pattern is quoted (`"<id>"`) to avoid partial matches, and the block it finds
/// is parsed and its id compared exactly. Scoped to the session and to rows
/// before the result, so the scan is bounded by one session's history and only
/// runs when a call and its result straddle a poll boundary.
const SELECT_TOOL_CALL: &str = "\
SELECT chat_message FROM message_nodes \
 WHERE session_id = ?1 AND row_id < ?2 AND chat_message LIKE ?3 \
 ORDER BY row_id DESC LIMIT 1";

// ── row types ────────────────────────────────────────────────────────────

/// The `sessions` columns joined onto every message row.
#[derive(Debug, Clone, Default)]
struct SessionCols {
    working_directory: Option<String>,
    model: Option<String>,
    /// The session's immutable start, epoch seconds. `agent_start` is stamped
    /// here rather than at the row's time.
    created_at: Option<i64>,
    hidden: Option<i64>,
}

impl SessionCols {
    fn is_hidden(&self) -> bool {
        self.hidden.unwrap_or(0) != 0
    }
}

/// One row of the batch.
struct BatchRow {
    msg: MessageRow,
    cols: SessionCols,
}

// ── the poll ─────────────────────────────────────────────────────────────

/// Read rows past the watermark and turn them into events.
///
/// Pure with respect to `(connection contents, request)`: no clock, no counter,
/// no state carried between calls. Everything is derived from the rows, so
/// re-reading the same rows produces byte-identical events and the server's
/// content-hash dedup collapses them — including the forest's replays.
fn poll(conn: &Connection, req: &PollRequest) -> rusqlite::Result<PollOutcome> {
    let rows = read_rows(conn, req)?;

    let mut out = PollOutcome {
        watermark: req.watermark,
        rows_seen: rows.len() as u64,
        // A backlog should drain rather than trickle. Guarded on a non-zero limit
        // so a `max_rows: 0` misconfiguration cannot spin the drain loop.
        more: req.max_rows > 0 && rows.len() as u64 >= req.max_rows,
        events: Vec::new(),
    };
    let Some(last) = rows.last() else {
        return Ok(out);
    };
    // Advanced past every row EXAMINED, not every row emitted, so filtered
    // (hidden) rows and replays are not re-read on every poll for the life of
    // the machine.
    out.watermark = last.msg.row_id.max(req.watermark);

    let tool_names = resolve_tool_names(conn, &rows)?;
    let mut mins: BTreeMap<String, i64> = BTreeMap::new();
    let mut ctxs: BTreeMap<String, RowCtx> = BTreeMap::new();

    for row in &rows {
        if row.cols.is_hidden() {
            continue;
        }
        // is_first before ctx so the two mutable borrows never overlap.
        let is_first = session_min_row(conn, &mut mins, &row.msg.session_id)? == row.msg.row_id;
        let ctx = context(&mut ctxs, &row.msg.session_id, &row.cols, req);
        if is_first
            && let Some(ev) = transform::agent_start(
                &row.msg,
                row.cols.working_directory.as_deref(),
                row.cols.created_at,
                ctx,
            )
        {
            out.events.push(ev);
        }
        out.events
            .extend(transform::content_events(&row.msg, ctx, &tool_names));
    }

    Ok(out)
}

fn read_rows(conn: &Connection, req: &PollRequest) -> rusqlite::Result<Vec<BatchRow>> {
    // Saturating rather than `as`: a wrapped negative LIMIT means "no limit" in
    // SQLite, which would quietly turn a huge max_rows into an unbounded read.
    let limit = i64::try_from(req.max_rows).unwrap_or(i64::MAX);
    let mut stmt = conn.prepare(SELECT_ROWS)?;
    let rows = stmt.query_map(params![req.watermark, limit], |r| {
        let content: Option<String> = r.get(2)?;
        Ok(BatchRow {
            msg: MessageRow {
                row_id: r.get(0)?,
                session_id: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                created_at: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                message: transform::parse_message(content.as_deref()),
            },
            cols: SessionCols {
                working_directory: r.get(4)?,
                model: r.get(5)?,
                created_at: r.get(6)?,
                hidden: r.get(7)?,
            },
        })
    })?;
    rows.collect()
}

fn session_min_row(
    conn: &Connection,
    cache: &mut BTreeMap<String, i64>,
    session_id: &str,
) -> rusqlite::Result<i64> {
    if let Some(v) = cache.get(session_id) {
        return Ok(*v);
    }
    let min = conn.query_row(SELECT_MIN_ROW, params![session_id], |r| {
        Ok(r.get::<_, Option<i64>>(0)?.unwrap_or(0))
    })?;
    cache.insert(session_id.to_string(), min);
    Ok(min)
}

/// The per-session envelope pieces, built once per poll.
fn context<'a>(
    cache: &'a mut BTreeMap<String, RowCtx>,
    session_id: &str,
    cols: &SessionCols,
    req: &PollRequest,
) -> &'a RowCtx {
    cache.entry(session_id.to_string()).or_insert_with(|| {
        RowCtx::new(
            cols.working_directory.as_deref(),
            cols.model.as_deref(),
            &req.environment,
            &req.agent_id,
        )
    })
}

/// Map every tool-call id in the batch to its tool name.
///
/// The name is on the assistant `tool_calls` entry and on NO `role:"tool"`
/// result, so without this every result is a row in the product with a blank
/// tool. The forest usually replays a call and its result together, so the batch
/// map covers the common case; the second pass goes back to the database for the
/// rare call whose result straddles a poll boundary.
fn resolve_tool_names(
    conn: &Connection,
    rows: &[BatchRow],
) -> rusqlite::Result<BTreeMap<String, String>> {
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for row in rows {
        for (id, name) in transform::tool_call_names(&row.msg.message) {
            names.insert(id, name);
        }
    }

    let mut stmt = conn.prepare(SELECT_TOOL_CALL)?;
    for row in rows {
        if row.msg.role() != "tool" {
            continue;
        }
        let Some(id) = row.msg.message.get("tool_call_id").and_then(Value::as_str) else {
            continue;
        };
        if names.contains_key(id) {
            continue;
        }
        let found: Option<String> = stmt
            .query_row(
                params![row.msg.session_id, row.msg.row_id, format!("%\"{id}\"%")],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(content) = found
            && let Some(name) =
                transform::tool_call_names(&transform::parse_message(Some(&content)))
                    .into_iter()
                    .find(|(i, _)| i == id)
                    .map(|(_, n)| n)
        {
            names.insert(id.to_string(), name);
        }
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_database_path_prefers_the_explicit_override() {
        // DEVIN_DB_PATH names the file; DEVIN_HOME names the data DIRECTORY.
        // Conflating them puts the poller on `<db>/cli/sessions.db`, which does
        // not exist, and the source then reports "not installed" forever.
        let explicit = db_path_from(
            Some(PathBuf::from("/srv/devin.db")),
            Some(PathBuf::from("/data/devin")),
            Some(PathBuf::from("/home/u")),
        );
        assert_eq!(explicit, PathBuf::from("/srv/devin.db"));

        let homed = db_path_from(
            None,
            Some(PathBuf::from("/data/devin")),
            Some(PathBuf::from("/home/u")),
        );
        assert_eq!(homed, PathBuf::from("/data/devin/cli/sessions.db"));
    }

    #[test]
    fn the_default_path_is_under_dot_local_share() {
        assert_eq!(
            db_path_from(None, None, Some(PathBuf::from("/home/u"))),
            PathBuf::from("/home/u/.local/share/devin/cli/sessions.db")
        );
    }

    #[test]
    fn the_format_declares_a_rowid_watermark() {
        assert_eq!(FORMAT.watermark, Watermark::RowId);
        assert_eq!(FORMAT.kind, "devin");
    }
}
