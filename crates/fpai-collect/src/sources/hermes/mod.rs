//! Hermes session capture — a [`sqlitepoll`](crate::sqlitepoll) adapter.
//!
//! Hermes (Nous Research's Slack/Telegram/CLI gateway) keeps everything in one
//! SQLite database at `~/.hermes/state.db`. We open it read-only through
//! [`crate::sqlitepoll::open_readonly`] and read two tables — `sessions` and
//! `messages`. Hermes's own files are never written, moved or deleted.
//!
//! # `~/.hermes/sessions/` must never be read, despite its name
//!
//! That directory holds no transcripts. It holds
//! `request_dump_<sessionId>_<ts>.json` error dumps — ~60 KB each on the probe
//! capture — and every one of them **embeds a partially-redacted Authorization
//! bearer token** for the model provider, because a request dump is the whole
//! outbound HTTP request. Uploading one would exfiltrate a credential to the
//! ingest endpoint. The directory name actively invites the wrong glob, which
//! is why this warning is here and not only in a commit message: nothing in
//! this module walks a directory at all, and nothing should start.
//!
//! Four more things in the Hermes home are out of scope for their own reasons:
//!
//! * `messages_fts*` / `messages_fts_trigram*` — FTS5 shadow tables. They carry
//!   a rowid-keyed copy of every message's text, so reading them would ship the
//!   conversation twice under ids that mean nothing.
//! * `logs/agent.log` — unstructured, and the same content already arrives
//!   through `messages`.
//! * `cache/` — provider model metadata (254 KB of OpenRouter's catalogue on
//!   the capture). Nothing about any session.
//! * `sandboxes/` — the agent's own scratch working trees.
//!
//! Within the database, `async_delegations`, `session_model_usage`,
//! `gateway_routing`, `compression_locks` and `state_meta` are also not read:
//! they are gateway bookkeeping, and the parts worth reporting (token totals,
//! end reason) are already denormalised onto `sessions`.
//!
//! # Rows are mutated AND deleted, so the watermark is not fully safe
//!
//! [`Watermark::RowId`] is right for the happy path — `messages.id` is an
//! `INTEGER PRIMARY KEY AUTOINCREMENT`, Hermes appends in order, and a session
//! that just runs to completion is captured exactly once. It is not the whole
//! story, and pretending otherwise would hide two real gaps:
//!
//! * **Updates behind the watermark are missed.** `hermes_state.py` has five
//!   `UPDATE messages SET active = …` statements plus `UPDATE messages SET
//!   api_content = ?`, and ~20 `UPDATE sessions SET …`. A row's `active` flag
//!   flipping to 0 after we shipped it is never re-read, so a message we
//!   reported as in-context can silently leave the model's context. The
//!   `sessions` updates matter less because session columns are read fresh on
//!   every poll that touches one of that session's rows.
//! * **Deletions rewrite history.** Rewind and compaction issue `DELETE FROM
//!   messages` in eight-plus places. Deleted rows are already shipped and stay
//!   shipped; the product shows a turn Hermes no longer has.
//!
//! [`Watermark::UpdatedAt`] cannot fix either one, because `messages` has no
//! last-modified column to order by — `timestamp` is the message's own time and
//! is never touched by those updates. Closing the gap needs a real change-feed
//! (a content hash per session, or Hermes emitting one), which is follow-on
//! work rather than something to half-implement here.
//!
//! # Both session shapes are real
//!
//! `cwd` **is** populated for `source='cli'` sessions (5/5 on the probe, with
//! `git_branch` and `git_repo_root` beside it), correcting a long-standing
//! assumption that Hermes is cwd-less. Gateway sessions (Slack, Telegram) have
//! NULL `cwd`. Both are handled explicitly — see
//! [`transform::agent_id`].
//!
//! Session ids are `YYYYMMDD_HHMMSS_<6hex>`, not UUIDs. They are therefore
//! lexicographically time-sortable, which nothing here relies on but which is
//! worth knowing before someone writes a UUID-shaped validator.

pub mod transform;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::sqlitepoll::{PollOutcome, PollRequest, SqliteFormat, Watermark};
use transform::{MessageRow, SessionMeta};

/// The format table the poller drives.
pub const FORMAT: SqliteFormat = SqliteFormat {
    kind: "hermes",
    // See the module docs: correct on the happy path, honestly incomplete under
    // rewind and compaction, and `UpdatedAt` is not available as an alternative
    // because `messages` has no last-modified column.
    watermark: Watermark::RowId,
    poll,
};

/// The agent id used when a message's session row cannot be found at all.
pub const DEFAULT_AGENT_ID: &str = "hermes";

/// Directory under the Hermes root that holds non-default profiles.
const PROFILES_DIR: &str = "profiles";

/// The database file inside every Hermes home.
const STATE_DB: &str = "state.db";

/// Columns read from `messages`. Listed explicitly rather than `SELECT *` so a
/// new Hermes column cannot shift a positional index underneath us.
const SELECT_MESSAGES: &str = "SELECT id, session_id, role, content, tool_call_id, tool_calls, \
     tool_name, timestamp, finish_reason, active \
     FROM messages WHERE id > ?1 ORDER BY id LIMIT ?2";

/// Columns read from `sessions`. See [`SessionMeta`] for what is left out and
/// why.
const SELECT_SESSION: &str = "SELECT source, model, cwd, git_branch, git_repo_root, chat_type, \
     title, started_at, ended_at, end_reason, input_tokens, output_tokens \
     FROM sessions WHERE id = ?1";

/// The surviving id range of one session's messages.
const SELECT_BOUNDS: &str = "SELECT MIN(id), MAX(id) FROM messages WHERE session_id = ?1";

/// Read messages past the watermark and turn them into events.
///
/// Two queries per distinct session in the batch, not per row: the session
/// lookup and its id bounds are what let `agent_start` / `agent_end` fire
/// exactly once without the poller remembering anything between passes, and a
/// correlated subquery per row would pay for that on every message of a long
/// session instead of once.
fn poll(conn: &Connection, req: &PollRequest) -> rusqlite::Result<PollOutcome> {
    // A zero limit would otherwise ask SQLite for nothing and then report
    // `more`, spinning the drain loop.
    let limit = req.max_rows.clamp(1, i64::MAX as u64) as i64;

    let mut stmt = conn.prepare_cached(SELECT_MESSAGES)?;
    let rows = stmt
        .query_map((req.watermark, limit), |r| {
            Ok(MessageRow {
                id: r.get(0)?,
                session_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                tool_call_id: r.get(4)?,
                tool_calls: r.get(5)?,
                tool_name: r.get(6)?,
                timestamp: r.get(7)?,
                finish_reason: r.get(8)?,
                // NOT NULL DEFAULT 1 in the schema, but `idx_messages_active_null`
                // exists specifically for `active IS NULL`, so Hermes has clearly
                // shipped rows without one. Treated as active, which is what the
                // column default means.
                active: r.get::<_, Option<i64>>(9)?.unwrap_or(1),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut outcome = PollOutcome {
        watermark: req.watermark,
        rows_seen: rows.len() as u64,
        // Hitting the limit means a backlog is waiting; the engine polls again
        // immediately rather than sleeping, so a restart after downtime drains
        // instead of trickling.
        more: rows.len() as i64 >= limit,
        ..Default::default()
    };
    if let Some(last) = rows.last() {
        outcome.watermark = last.id;
    }

    let mut sessions: HashMap<String, Option<SessionMeta>> = HashMap::new();
    for row in &rows {
        if !sessions.contains_key(&row.session_id) {
            let meta = load_session(conn, &row.session_id)?;
            sessions.insert(row.session_id.clone(), meta);
        }
    }

    // Tool-call id → name, so a result row is not a blank row. Scoped to this
    // poll on purpose: carrying it across polls would make the output depend on
    // what earlier passes happened to see, and the result row's own `tool_name`
    // already covers a batch cut between a call and its result.
    let mut pending: HashMap<String, String> = HashMap::new();

    for row in &rows {
        let meta = sessions.get(&row.session_id).and_then(Option::as_ref);
        let agent_id = transform::agent_id(meta, &req.agent_id);

        if let Some(meta) = meta
            && meta.first_message_id == Some(row.id)
            && let Some(ev) = transform::agent_start(row, meta, &agent_id, &req.environment)
        {
            outcome.events.push(ev);
        }

        outcome.events.extend(transform::message_events(
            row,
            meta,
            &agent_id,
            &req.environment,
            &mut pending,
        ));

        // Gated on `ended_at` so a live session is not ended on every pass; see
        // `transform::agent_end` for the race that gate costs.
        if let Some(meta) = meta
            && meta.last_message_id == Some(row.id)
            && meta.ended_at.is_some()
            && let Some(ev) = transform::agent_end(row, meta, &agent_id, &req.environment)
        {
            outcome.events.push(ev);
        }
    }

    Ok(outcome)
}

/// One session's metadata and the id range of its surviving messages.
///
/// A missing session row is `Ok(None)`, not an error: `messages.session_id` is
/// a foreign key, but a partially-applied rewind or a hand-edited database
/// would leave orphans, and one orphan must not stop the poll for every other
/// session in the batch.
fn load_session(conn: &Connection, session_id: &str) -> rusqlite::Result<Option<SessionMeta>> {
    let mut stmt = conn.prepare_cached(SELECT_SESSION)?;
    let meta = stmt.query_row([session_id], |r| {
        Ok(SessionMeta {
            source: r.get(0)?,
            model: r.get(1)?,
            cwd: r.get(2)?,
            git_branch: r.get(3)?,
            git_repo_root: r.get(4)?,
            chat_type: r.get(5)?,
            title: r.get(6)?,
            started_at: r.get(7)?,
            ended_at: r.get(8)?,
            end_reason: r.get(9)?,
            input_tokens: r.get(10)?,
            output_tokens: r.get(11)?,
            ..Default::default()
        })
    });
    let mut meta = match meta {
        Ok(meta) => meta,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(err) => return Err(err),
    };

    let mut bounds = conn.prepare_cached(SELECT_BOUNDS)?;
    let (first, last) = bounds.query_row([session_id], |r| {
        Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?))
    })?;
    meta.first_message_id = first;
    meta.last_message_id = last;
    Ok(Some(meta))
}

/// The Hermes ROOT home — the directory that owns `profiles/`.
///
/// `HERMES_HOME` is Hermes's own override and is honoured so a profile-scoped
/// shell and the collector agree on what "all profiles" means. It may point AT
/// a profile (`<root>/profiles/<name>`), because that is what the generated
/// per-profile alias wrapper exports; we climb back to `<root>` in that case so
/// discovery still sees every sibling profile rather than collecting from one
/// and silently ignoring the rest.
pub fn hermes_root() -> PathBuf {
    let home = std::env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".hermes")))
        .unwrap_or_else(|| PathBuf::from(".hermes"));
    root_from_home(&home)
}

/// Climb from a possibly-profile-scoped Hermes home to the root that owns it.
pub fn root_from_home(home: &Path) -> PathBuf {
    if let Some(parent) = home.parent()
        && parent.file_name().is_some_and(|n| n == PROFILES_DIR)
        && let Some(root) = parent.parent()
    {
        return root.to_path_buf();
    }
    home.to_path_buf()
}

/// Every Hermes database on disk: the root home's, then each profile's.
///
/// A Hermes "profile" is not a column or a flag — it is a whole separate home
/// directory with its own `config.yaml`, `SOUL.md` and **its own `state.db`**.
/// Reading only `~/.hermes/state.db` makes every non-default profile's sessions
/// invisible, which is exactly the bug the audit pillar shipped with before
/// profile support landed.
///
/// Each path is a separate logical stream and needs its own `state_dir`: the
/// sqlite poller keys its cursor on a fixed synthetic `(0, 0)`, so two profiles
/// sharing a state directory would overwrite each other's watermark.
///
/// Fail-open — an unreadable `profiles/` just means "default only", which is
/// the single-profile install everyone starts with.
pub fn default_db_paths() -> Vec<PathBuf> {
    db_paths_under(&hermes_root())
}

/// [`default_db_paths`] against an explicit root. Split out so it is testable
/// without mutating the process environment.
pub fn db_paths_under(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![root.join(STATE_DB)];
    let Ok(entries) = std::fs::read_dir(root.join(PROFILES_DIR)) else {
        return out;
    };
    let mut names: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            // A symlinked profile directory is legitimate and `is_dir()` on the
            // DirEntry's file type is false for one, so the metadata (which
            // follows the link) decides.
            e.metadata().map(|m| m.is_dir()).unwrap_or(false)
                && !e.file_name().to_string_lossy().starts_with('.')
        })
        .map(|e| e.path())
        .collect();
    // Sorted so the set of sources a daemon starts is stable across restarts
    // and across machines; directory order is not.
    names.sort();
    out.extend(names.into_iter().map(|p| p.join(STATE_DB)));
    out
}
