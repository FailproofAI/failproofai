//! goose session capture — a [`sqlitepoll`](crate::sqlitepoll) adapter.
//!
//! goose (Block's local dev agent) keeps every session in ONE SQLite database,
//! `~/.local/share/goose/sessions/sessions.db`. There are no per-session files,
//! so there is nothing for [`filetail`](crate::filetail) to tail. Verified live
//! against goose v1.43.0, `schema_version` 15:
//!
//! ```text
//! sessions(id TEXT PK `YYYYMMDD_N`, name, description, user_set_name,
//!          session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL,
//!          created_at, updated_at, extension_data, …16 token/cost columns…,
//!          schedule_id, recipe_json, provider_name, model_config_json,
//!          goose_mode, archived_at, project_id, parent_session_id)
//! messages(id INTEGER PK AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL,
//!          role TEXT NOT NULL, content_json TEXT NOT NULL,
//!          created_timestamp INTEGER NOT NULL, timestamp TIMESTAMP,
//!          tokens INTEGER, metadata_json TEXT)
//! ```
//!
//! # `content_json` is a Claude-style typed-block ARRAY
//!
//! Not OpenAI-style like Devin. Shapes seen in the live corpus:
//!
//! ```text
//! {"type":"text","text":…}
//! {"type":"toolRequest","id":"tooluse_…",
//!  "toolCall":{"status":"success","value":{"name":…,"arguments":{…}}},
//!  "_meta":{"goose_extension":"developer"}}
//! {"type":"toolResponse","id":"tooluse_…",
//!  "toolResult":{"status":"success","value":{"content":[{"type":"text","text":…}],
//!                "structuredContent":{…},"isError":false}}}
//! ```
//!
//! Two properties of that layout drive most of the code below:
//!
//! * **A `toolResponse` arrives in a `role:'user'` row.** Branching on `role`
//!   alone therefore renders every tool result as a user prompt — a session's
//!   timeline turns into the model asking itself questions. Every branch here
//!   is on the *block* type, with `role` used only to split plain text into a
//!   request vs. a response.
//! * **Rows are NOT turn-aligned.** One assistant turn that emitted four
//!   parallel `shell` calls produced *five* rows (a preamble text row plus one
//!   row per call), and its four results came back as four more rows, all
//!   sharing a single `created_timestamp`. Nothing here may assume one row is
//!   one turn, and the sub-second ordering scheme exists because of the shared
//!   timestamp — see [`transform::slot_micros`].
//!
//! # A rowid watermark is right for the happy path, and is NOT airtight
//!
//! [`Watermark::RowId`] is declared because `messages.id` is
//! `INTEGER PRIMARY KEY AUTOINCREMENT` and a normal session only ever appends:
//! a tool call's result is a *new* row, not an update to the call's row, which
//! is exactly the failure mode that forces opencode onto `UpdatedAt`.
//!
//! It is not a guarantee. The goose binary contains
//! `UPDATE messages SET content_json`, `UPDATE messages SET metadata_json` and
//! rewind's `DELETE FROM messages`. So:
//!
//! * a row **edited after** we shipped it keeps the shipped copy — the edit is
//!   invisible to us, because `id` did not move;
//! * a row **deleted** behind the watermark leaves an event on the server with
//!   no counterpart in goose's own history.
//!
//! There is no cheap fix: `messages` carries no `updated_at`, so `UpdatedAt`
//! has no column to order by, and re-reading the whole table every poll would
//! re-ship an entire history to be deduped on every pass. The honest position
//! is that this source is append-accurate and edit-blind, and that the two
//! writes above have not been observed firing in a normal session.
//!
//! # `session_type='hidden'` is filtered
//!
//! Those are `goose run --no-session` scratch runs, which the product should
//! not show as sessions at all. The other values (`user`, `subagent`,
//! `scheduled`, `terminal`, `acp`) are kept — filtering by an allowlist would
//! silently drop a session type the next goose release adds.
//!
//! Hidden rows still advance the watermark and still act as the *predecessor*
//! of the row after them, so filtering them can never strand a visible session
//! (see the `agent_end` rule below).
//!
//! # Where `agent_start` and `agent_end` come from
//!
//! goose writes no session-start or session-end marker, and the sqlite engine
//! exposes no idle callback the way [`filetail`](crate::filetail) does — a
//! [`SqliteFormat`] is one pure `poll`, so the wall clock is off limits
//! (consulting it would make two reads of the same rows produce different
//! bytes, which is precisely what the server's content-hash dedup relies on).
//! Both events are therefore derived from the row stream itself:
//!
//! * `agent_start` rides the session's **first** message row (`MIN(id)`), so it
//!   is emitted exactly once and never depends on when we polled.
//! * `agent_end` rides the row **after** a session's last row: when row *R*
//!   belongs to a different session than its immediate predecessor *P*, and *P*
//!   is `MAX(id)` for its session, *P*'s session is finished and its end is
//!   emitted at *P*'s timestamp. Each row is processed once, so this fires once.
//!
//! The known gap: the newest session in the database has no successor row, so
//! it stays open until goose is used again. That is deliberate. The
//! alternatives are worse — a wall-clock idle rule breaks purity, and
//! recomputing ends from the `sessions` table each poll re-ships an `agent_end`
//! per session forever, for the entire history, on an idle machine.
//!
//! A session that is *resumed* after another session wrote gets a second
//! `agent_end` (its `MAX(id)` moved). That reads correctly on a timeline: it
//! genuinely was two runs.

pub mod transform;

use std::collections::BTreeMap;
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::sqlitepoll::{PollOutcome, PollRequest, SqliteFormat, Watermark};
use transform::{MessageRow, RowCtx};

/// The format table the sqlite engine drives.
pub const FORMAT: SqliteFormat = SqliteFormat {
    kind: "goose",
    watermark: Watermark::RowId,
    poll,
};

/// The agent id used when a session has no usable `working_dir`.
pub const DEFAULT_AGENT_ID: &str = "goose";

/// `goose run --no-session` scratch runs.
const HIDDEN_SESSION_TYPE: &str = "hidden";

// ── database location ────────────────────────────────────────────────────

/// Where goose keeps its sessions database.
///
/// `GOOSE_DB_PATH` and `GOOSE_HOME` are the same overrides goose itself and
/// `lib/goose-sessions.ts` honour, so a relocated goose home stays covered by
/// both halves of the product rather than by whichever half was tested.
pub fn db_path() -> PathBuf {
    db_path_from(
        var("GOOSE_DB_PATH"),
        var("GOOSE_HOME"),
        var("XDG_DATA_HOME"),
        var("HOME"),
    )
}

fn var(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// The resolution order, split out so it is testable without mutating the
/// process environment (which is `unsafe` in edition 2024 and races every other
/// test in the binary).
///
/// `GOOSE_HOME` names the *data* directory that contains `sessions/`, matching
/// goose's own meaning of the variable — pointing it at a database file is a
/// mistake `GOOSE_DB_PATH` exists to serve.
pub fn db_path_from(
    db: Option<PathBuf>,
    goose_home: Option<PathBuf>,
    xdg_data_home: Option<PathBuf>,
    home: Option<PathBuf>,
) -> PathBuf {
    if let Some(p) = db {
        return p;
    }
    let data = goose_home.unwrap_or_else(|| {
        xdg_data_home
            .unwrap_or_else(|| home.unwrap_or_default().join(".local").join("share"))
            .join("goose")
    });
    data.join("sessions").join("sessions.db")
}

// ── queries ──────────────────────────────────────────────────────────────

/// The batch. A LEFT JOIN rather than an inner one: the `session_id` foreign
/// key is declared but SQLite does not enforce it unless `PRAGMA foreign_keys`
/// is on, so an inner join would make a message with a missing session row
/// vanish silently instead of shipping with a fallback agent id.
const SELECT_ROWS: &str = "\
SELECT m.id, m.session_id, m.role, m.content_json, m.created_timestamp, m.metadata_json, \
       s.session_type, s.working_dir, s.model_config_json, s.provider_name \
  FROM messages m \
  LEFT JOIN sessions s ON s.id = m.session_id \
 WHERE m.id > ?1 \
 ORDER BY m.id \
 LIMIT ?2";

/// The row immediately before the batch, so the `agent_end` rule works across a
/// poll boundary too — otherwise a session whose last row ended the previous
/// batch would never be closed.
const SELECT_TAIL: &str = "\
SELECT m.id, m.session_id, m.created_timestamp, \
       s.session_type, s.working_dir, s.model_config_json, s.provider_name \
  FROM messages m \
  LEFT JOIN sessions s ON s.id = m.session_id \
 WHERE m.id <= ?1 \
 ORDER BY m.id DESC \
 LIMIT 1";

/// First and last message of a session, for the start/end rules. Served by
/// `idx_messages_session`, and cached per poll so a batch touching one session
/// runs it once.
const SELECT_BOUNDS: &str = "SELECT MIN(id), MAX(id) FROM messages WHERE session_id = ?1";

/// The `toolRequest` row for a result whose call landed in an earlier batch.
///
/// `LIKE` rather than a join because the id lives inside the JSON blob. The
/// pattern's `_` characters (every goose id starts `tooluse_`) are LIKE
/// wildcards, so this can over-match; that is harmless because the block it
/// finds is then parsed and its `id` compared exactly. Scoped to the session
/// and to rows before the result, so the scan is bounded by one session's
/// history and only runs when a call and its result straddle a poll boundary.
const SELECT_TOOL_REQUEST: &str = "\
SELECT content_json FROM messages \
 WHERE session_id = ?1 AND id < ?2 AND content_json LIKE ?3 \
 ORDER BY id DESC LIMIT 1";

// ── row types ────────────────────────────────────────────────────────────

/// The `sessions` columns joined onto every message row.
#[derive(Debug, Clone, Default)]
struct SessionCols {
    session_type: Option<String>,
    working_dir: Option<String>,
    model_config_json: Option<String>,
    provider_name: Option<String>,
}

impl SessionCols {
    fn is_hidden(&self) -> bool {
        self.session_type.as_deref() == Some(HIDDEN_SESSION_TYPE)
    }
}

/// One row of the batch.
struct BatchRow {
    msg: MessageRow,
    cols: SessionCols,
}

/// The predecessor row. Deliberately does not carry `content_json`: it exists
/// only to answer "did the previous row end its session", and that blob reached
/// 52 KB in the live corpus.
struct Tail {
    id: i64,
    session_id: String,
    created_timestamp: i64,
    cols: SessionCols,
}

// ── the poll ─────────────────────────────────────────────────────────────

/// Read rows past the watermark and turn them into events.
///
/// Pure with respect to `(connection contents, request)`: no clock, no counter,
/// no state carried between calls. Everything order-dependent is derived from
/// `messages.id`, so re-reading the same rows produces byte-identical events
/// and the server's content-hash dedup collapses them.
fn poll(conn: &Connection, req: &PollRequest) -> rusqlite::Result<PollOutcome> {
    let rows = read_rows(conn, req)?;

    let mut out = PollOutcome {
        watermark: req.watermark,
        rows_seen: rows.len() as u64,
        // A backlog should drain rather than trickle. Guarded on a non-zero
        // limit so a `max_rows: 0` misconfiguration cannot spin the drain loop.
        more: req.max_rows > 0 && rows.len() as u64 >= req.max_rows,
        events: Vec::new(),
    };
    let Some(last) = rows.last() else {
        return Ok(out);
    };
    // Advanced past every row EXAMINED, not every row emitted, so filtered
    // (hidden) rows are not re-read on every poll for the life of the machine.
    out.watermark = last.msg.id.max(req.watermark);

    let tool_names = resolve_tool_names(conn, &rows)?;
    let mut bounds: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut ctxs: BTreeMap<String, RowCtx> = BTreeMap::new();
    let mut prev = read_tail(conn, req.watermark)?;

    for row in &rows {
        if let Some(p) = prev.as_ref()
            && p.session_id != row.msg.session_id
            && !p.cols.is_hidden()
            && session_bounds(conn, &mut bounds, &p.session_id)?.1 == p.id
        {
            let ctx = context(&mut ctxs, &p.session_id, &p.cols, req);
            if let Some(ev) = transform::agent_end(&p.session_id, p.id, p.created_timestamp, ctx) {
                out.events.push(ev);
            }
        }

        if !row.cols.is_hidden() {
            let is_first = session_bounds(conn, &mut bounds, &row.msg.session_id)?.0 == row.msg.id;
            let ctx = context(&mut ctxs, &row.msg.session_id, &row.cols, req);
            if is_first
                && let Some(ev) =
                    transform::agent_start(&row.msg, row.cols.working_dir.as_deref(), ctx)
            {
                out.events.push(ev);
            }
            out.events
                .extend(transform::content_events(&row.msg, ctx, &tool_names));
        }

        prev = Some(Tail {
            id: row.msg.id,
            session_id: row.msg.session_id.clone(),
            created_timestamp: row.msg.created_timestamp,
            cols: row.cols.clone(),
        });
    }

    Ok(out)
}

fn read_rows(conn: &Connection, req: &PollRequest) -> rusqlite::Result<Vec<BatchRow>> {
    // Saturating rather than `as`: a wrapped negative LIMIT means "no limit" in
    // SQLite, which would quietly turn a huge max_rows into an unbounded read.
    let limit = i64::try_from(req.max_rows).unwrap_or(i64::MAX);
    let mut stmt = conn.prepare(SELECT_ROWS)?;
    let rows = stmt.query_map(params![req.watermark, limit], |r| {
        let content: Option<String> = r.get(3)?;
        Ok(BatchRow {
            msg: MessageRow {
                id: r.get(0)?,
                session_id: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                role: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                created_timestamp: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                metadata_json: r.get(5)?,
                blocks: transform::parse_blocks(content.as_deref()),
            },
            cols: SessionCols {
                session_type: r.get(6)?,
                working_dir: r.get(7)?,
                model_config_json: r.get(8)?,
                provider_name: r.get(9)?,
            },
        })
    })?;
    rows.collect()
}

fn read_tail(conn: &Connection, watermark: i64) -> rusqlite::Result<Option<Tail>> {
    conn.query_row(SELECT_TAIL, params![watermark], |r| {
        Ok(Tail {
            id: r.get(0)?,
            session_id: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            created_timestamp: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            cols: SessionCols {
                session_type: r.get(3)?,
                working_dir: r.get(4)?,
                model_config_json: r.get(5)?,
                provider_name: r.get(6)?,
            },
        })
    })
    .optional()
}

fn session_bounds(
    conn: &Connection,
    cache: &mut BTreeMap<String, (i64, i64)>,
    session_id: &str,
) -> rusqlite::Result<(i64, i64)> {
    if let Some(b) = cache.get(session_id) {
        return Ok(*b);
    }
    let bounds = conn.query_row(SELECT_BOUNDS, params![session_id], |r| {
        Ok((
            r.get::<_, Option<i64>>(0)?.unwrap_or(0),
            r.get::<_, Option<i64>>(1)?.unwrap_or(0),
        ))
    })?;
    cache.insert(session_id.to_string(), bounds);
    Ok(bounds)
}

/// The per-session envelope pieces, built once per poll.
///
/// Cached because `model_config_json` has to be parsed to find the model and
/// every row of a session repeats it — a 21-row session would otherwise parse
/// the same blob 21 times.
fn context<'a>(
    cache: &'a mut BTreeMap<String, RowCtx>,
    session_id: &str,
    cols: &SessionCols,
    req: &PollRequest,
) -> &'a RowCtx {
    cache.entry(session_id.to_string()).or_insert_with(|| {
        RowCtx::new(
            cols.working_dir.as_deref(),
            cols.model_config_json.as_deref(),
            cols.provider_name.as_deref(),
            &req.environment,
            &req.agent_id,
        )
    })
}

/// Map every tool-call id in the batch to its tool name.
///
/// The name appears on the `toolRequest` block and on NO `toolResponse` block,
/// so without this every result is a row in the product with a blank tool —
/// the same defect the Claude source's pending-tool state prevents. The
/// difference here is that the call and the result are separate *rows*, so a
/// poll boundary can land between them; the second pass goes back to the
/// database for exactly those.
fn resolve_tool_names(
    conn: &Connection,
    rows: &[BatchRow],
) -> rusqlite::Result<BTreeMap<String, String>> {
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for row in rows {
        for block in &row.msg.blocks {
            if let Some((id, name)) = transform::tool_request_name(block) {
                names.insert(id, name);
            }
        }
    }

    let mut stmt = conn.prepare(SELECT_TOOL_REQUEST)?;
    for row in rows {
        for block in &row.msg.blocks {
            if block.get("type").and_then(Value::as_str) != Some("toolResponse") {
                continue;
            }
            let Some(id) = block.get("id").and_then(Value::as_str) else {
                continue;
            };
            if names.contains_key(id) {
                continue;
            }
            let found: Option<String> = stmt
                .query_row(
                    params![row.msg.session_id, row.msg.id, format!("%\"{id}\"%")],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(content) = found
                && let Some(name) = transform::parse_blocks(Some(&content))
                    .iter()
                    .find_map(|b| transform::tool_request_name(b).filter(|(i, _)| i == id))
                    .map(|(_, n)| n)
            {
                names.insert(id.to_string(), name);
            }
        }
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_database_path_prefers_the_explicit_override() {
        // GOOSE_DB_PATH names the file; GOOSE_HOME names the data DIRECTORY.
        // Conflating them puts the poller on `<db>/sessions/sessions.db`, which
        // does not exist, and the source then reports "not installed" forever.
        let explicit = db_path_from(
            Some(PathBuf::from("/srv/goose.db")),
            Some(PathBuf::from("/data/goose")),
            None,
            Some(PathBuf::from("/home/u")),
        );
        assert_eq!(explicit, PathBuf::from("/srv/goose.db"));

        let homed = db_path_from(
            None,
            Some(PathBuf::from("/data/goose")),
            None,
            Some(PathBuf::from("/home/u")),
        );
        assert_eq!(homed, PathBuf::from("/data/goose/sessions/sessions.db"));
    }

    #[test]
    fn xdg_data_home_is_honoured_before_the_dot_local_default() {
        // goose builds its data dir from XDG_DATA_HOME, so a machine that moves
        // it would otherwise be polled at a path goose never writes.
        assert_eq!(
            db_path_from(
                None,
                None,
                Some(PathBuf::from("/xdg")),
                Some("/home/u".into())
            ),
            PathBuf::from("/xdg/goose/sessions/sessions.db")
        );
        assert_eq!(
            db_path_from(None, None, None, Some("/home/u".into())),
            PathBuf::from("/home/u/.local/share/goose/sessions/sessions.db")
        );
    }

    #[test]
    fn the_format_declares_a_rowid_watermark() {
        // Documented as append-accurate and edit-blind. If goose ever gains an
        // `updated_at` on `messages`, this is the switch — the engine already
        // supports the other policy.
        assert_eq!(FORMAT.watermark, Watermark::RowId);
        assert_eq!(FORMAT.kind, "goose");
    }
}
