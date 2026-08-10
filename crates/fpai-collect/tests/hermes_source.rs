//! Hermes source: transform correctness and engine behaviour, against REAL
//! SQLite databases.
//!
//! Nothing here is a hand-shaped fixture. [`SCHEMA`] is the verbatim DDL of a
//! captured `~/.hermes/state.db` (schema_version 22) — including the FTS5
//! shadow tables and the three triggers that populate them, so every insert in
//! these tests fires the same triggers a live Hermes would — and the
//! `tool_calls` payloads, timestamps and tool outputs are copied from real rows
//! of that capture.
//!
//! Databases are created in WAL mode and read through
//! [`sqlitepoll::open_readonly`], which is exactly the pairing production uses.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::sources::hermes;
use fpai_collect::sqlitepoll::{self, PollOutcome, PollRequest, Watermark};
use fpai_collect::supervisor::Shutdown;
use rusqlite::Connection;
use serde_json::Value;

/// Verbatim from the probe capture's `SCHEMA.sql`, minus the tables this source
/// deliberately never reads (`async_delegations`, `session_model_usage`,
/// `gateway_routing`, `compression_locks`, `state_meta`).
///
/// The FTS5 virtual tables and their triggers are kept because they are the
/// trap: they mirror every message into a rowid-keyed shadow table, so a poller
/// that widened its `FROM` would ship the conversation twice.
const SCHEMA: &str = r#"
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    user_id TEXT,
    session_key TEXT,
    chat_id TEXT,
    chat_type TEXT,
    thread_id TEXT,
    display_name TEXT,
    origin_json TEXT,
    expiry_finalized INTEGER DEFAULT 0,
    model TEXT,
    model_config TEXT,
    system_prompt TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    cwd TEXT,
    git_branch TEXT,
    git_repo_root TEXT,
    title TEXT,
    api_call_count INTEGER DEFAULT 0,
    profile_name TEXT,
    rewind_count INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    effect_disposition TEXT,
    timestamp REAL NOT NULL,
    token_count INTEGER,
    finish_reason TEXT,
    reasoning TEXT,
    reasoning_content TEXT,
    reasoning_details TEXT,
    codex_reasoning_items TEXT,
    codex_message_items TEXT,
    platform_message_id TEXT,
    observed INTEGER DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0,
    api_content TEXT
);
CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX idx_messages_session_active ON messages(session_id, active, timestamp);
CREATE VIRTUAL TABLE messages_fts USING fts5(content);
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (
        new.id,
        COALESCE(new.content, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '')
    );
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
    INSERT INTO messages_fts(rowid, content) VALUES (
        new.id,
        COALESCE(new.content, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '')
    );
END;
"#;

// Real ids and payloads from the capture.
const CLI_SESSION: &str = "20260803_080402_a54231";
const GATEWAY_SESSION: &str = "20260803_081500_b7c3d1";
const MODEL: &str = "claude-sonnet-4-6";

/// A real `tool_calls` value: OpenAI's wire shape, with `arguments` as a
/// JSON-encoded STRING rather than an object.
const TERMINAL_CALL: &str = r#"[{"id": "tooluse_8LfsNiQKh5FW5zW7gFOoVX", "call_id": "tooluse_8LfsNiQKh5FW5zW7gFOoVX", "response_item_id": "fc_tooluse_8LfsNiQKh5FW5zW7gFOoVX", "type": "function", "function": {"name": "terminal", "arguments": "{\"command\": \"ls /work\"}"}}]"#;

/// A real assistant row issuing TWO parallel calls in one row.
const PARALLEL_CALLS: &str = r#"[{"id": "tooluse_GqnMvLFT1UKNu83Un5rSIK", "call_id": "tooluse_GqnMvLFT1UKNu83Un5rSIK", "type": "function", "function": {"name": "session_search", "arguments": "{\"session_id\": \"20260803_080402_a54231\", \"around_message_id\": 1, \"window\": 20}"}}, {"id": "tooluse_NKFH2jNHpQ4ifRdaKNmsCU", "call_id": "tooluse_NKFH2jNHpQ4ifRdaKNmsCU", "type": "function", "function": {"name": "session_search", "arguments": "{\"session_id\": \"20260803_080544_ae362c\", \"around_message_id\": 1, \"window\": 20}"}}]"#;

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-hm-{}-{}-{}",
        name,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&d).unwrap();
    d
}

/// A writable WAL database carrying the real schema.
fn make_db(dir: &Path) -> (PathBuf, Connection) {
    let path = dir.join("state.db");
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    (path, conn)
}

#[allow(clippy::too_many_arguments)]
fn insert_session(
    conn: &Connection,
    id: &str,
    source: &str,
    cwd: Option<&str>,
    started_at: f64,
    ended_at: Option<f64>,
    end_reason: Option<&str>,
    chat_type: Option<&str>,
) {
    conn.execute(
        "INSERT INTO sessions (id, source, chat_type, model, started_at, ended_at, end_reason, \
         input_tokens, output_tokens, cwd, git_branch, git_repo_root) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 37481, 159, ?8, 'main', '/work')",
        rusqlite::params![
            id, source, chat_type, MODEL, started_at, ended_at, end_reason, cwd
        ],
    )
    .unwrap();
}

/// The CLI session every test starts from: real cwd, real timestamps.
fn insert_cli_session(conn: &Connection, ended: bool) {
    insert_session(
        conn,
        CLI_SESSION,
        "cli",
        Some("/work"),
        1_785_744_251.652_289_9,
        ended.then_some(1_785_744_261.719_167_7),
        ended.then_some("agent_close"),
        None,
    );
}

#[allow(clippy::too_many_arguments)]
fn insert_message(
    conn: &Connection,
    session: &str,
    role: &str,
    content: Option<&str>,
    tool_call_id: Option<&str>,
    tool_calls: Option<&str>,
    tool_name: Option<&str>,
    timestamp: f64,
    finish_reason: Option<&str>,
) {
    conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, \
         timestamp, finish_reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            session,
            role,
            content,
            tool_call_id,
            tool_calls,
            tool_name,
            timestamp,
            finish_reason
        ],
    )
    .unwrap();
}

fn user(conn: &Connection, session: &str, text: &str, ts: f64) {
    insert_message(
        conn,
        session,
        "user",
        Some(text),
        None,
        None,
        None,
        ts,
        None,
    );
}

/// An assistant row that is CALLING tools: `content` is the empty string, not
/// NULL — the shape a `content IS NOT NULL` test gets wrong.
fn assistant_calls(conn: &Connection, session: &str, calls: &str, ts: f64) {
    insert_message(
        conn,
        session,
        "assistant",
        Some(""),
        None,
        Some(calls),
        None,
        ts,
        Some("tool_calls"),
    );
}

fn assistant_text(conn: &Connection, session: &str, text: &str, ts: f64) {
    insert_message(
        conn,
        session,
        "assistant",
        Some(text),
        None,
        None,
        None,
        ts,
        Some("stop"),
    );
}

fn tool_result(conn: &Connection, session: &str, call_id: &str, name: &str, out: &str, ts: f64) {
    insert_message(
        conn,
        session,
        "tool",
        Some(out),
        Some(call_id),
        None,
        Some(name),
        ts,
        None,
    );
}

fn poll_at(db: &Path, watermark: i64, max_rows: u64) -> PollOutcome {
    let conn = sqlitepoll::open_readonly(db).unwrap();
    let req = PollRequest {
        watermark,
        max_rows,
        environment: "local".into(),
        agent_id: hermes::DEFAULT_AGENT_ID.into(),
    };
    (hermes::FORMAT.poll)(&conn, &req).unwrap()
}

fn poll_all(db: &Path) -> Vec<Value> {
    poll_at(db, 0, 1000).events
}

fn of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == kind).collect()
}

// ── message shapes ───────────────────────────────────────────────────────

#[test]
fn a_user_row_becomes_a_model_request_carrying_the_sessions_model() {
    // The model lives on `sessions`, never on a message. The server builds this
    // row's summary from the model alone, so without lifting it across every
    // prompt renders as an empty row.
    let dir = tmpdir("user");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    user(&conn, CLI_SESSION, "say OK", 1_785_744_251.686_618);

    let ev = poll_all(&db);
    let reqs = of_type(&ev, "model_request");
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0]["messages"][0]["role"], "user");
    assert_eq!(reqs[0]["messages"][0]["content"], "say OK");
    assert_eq!(reqs[0]["model"], MODEL);
    assert_eq!(reqs[0]["session_id"], CLI_SESSION);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_assistant_text_row_becomes_a_model_response_and_a_calling_row_does_not() {
    // A tool-calling assistant row has `content = ''` — an empty STRING, not
    // NULL. Testing `content IS NOT NULL` emits a blank model_response for
    // every tool turn in every session.
    let dir = tmpdir("assistant");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    assistant_calls(&conn, CLI_SESSION, TERMINAL_CALL, 1_785_744_254.923_234_2);
    assistant_text(&conn, CLI_SESSION, "Demo Project", 1_785_744_261.708_625);

    let ev = poll_all(&db);
    let responses = of_type(&ev, "model_response");
    assert_eq!(
        responses.len(),
        1,
        "the empty-content calling row must not produce a blank response: {ev:#?}"
    );
    assert_eq!(responses[0]["content"], "Demo Project");
    assert_eq!(responses[0]["role"], "assistant");
    assert_eq!(responses[0]["hermes_finish_reason"], "stop");

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_openai_shape_tool_calls_column_yields_one_tool_use_per_entry() {
    // `tool_calls` is an ARRAY and the capture really does carry two parallel
    // calls in one row. A transform reading `[0]` drops half the tool traffic
    // on every parallel turn, and nothing downstream can tell.
    let dir = tmpdir("parallel");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    assistant_calls(&conn, CLI_SESSION, PARALLEL_CALLS, 1_785_744_413.993_990_2);

    let ev = poll_all(&db);
    let calls = of_type(&ev, "tool_use");
    assert_eq!(calls.len(), 2, "both parallel calls must ship: {ev:#?}");
    assert_eq!(calls[0]["tool_call_id"], "tooluse_GqnMvLFT1UKNu83Un5rSIK");
    assert_eq!(calls[1]["tool_call_id"], "tooluse_NKFH2jNHpQ4ifRdaKNmsCU");
    assert_eq!(calls[0]["tool_name"], "session_search");

    // Two events from ONE row need distinct sub-second offsets, or the server's
    // `(ts, random id)` ordering hands them back shuffled.
    assert_ne!(calls[0]["timestamp"], calls[1]["timestamp"]);
    assert_eq!(calls[1]["hermes_block_index"], 2);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_json_string_arguments_field_is_parsed_into_structured_input() {
    // Hermes stores OpenAI's wire shape verbatim: `arguments` is a STRING
    // containing JSON. Shipped unparsed, the product gets one escaped blob per
    // tool call instead of fields a query can reach.
    let dir = tmpdir("args");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    assistant_calls(&conn, CLI_SESSION, TERMINAL_CALL, 1_785_744_254.923_234_2);

    let ev = poll_all(&db);
    let calls = of_type(&ev, "tool_use");
    assert_eq!(calls[0]["input"]["command"], "ls /work");
    assert!(
        calls[0]["input"].get("arguments").is_none(),
        "a parsed payload must not also keep the raw string"
    );

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_unparseable_arguments_string_is_kept_verbatim_rather_than_dropped() {
    // A truncated argument list is still the best evidence of what the agent
    // tried to run; dropping it loses the only record of a call that may have
    // been the interesting one.
    let dir = tmpdir("badargs");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    let truncated = r#"[{"id":"c1","type":"function","function":{"name":"terminal","arguments":"{\"command\": \"rm -r"}}]"#;
    assistant_calls(&conn, CLI_SESSION, truncated, 1_785_744_254.923_234_2);

    let ev = poll_all(&db);
    let calls = of_type(&ev, "tool_use");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["input"]["arguments"], "{\"command\": \"rm -r");

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_malformed_tool_calls_column_costs_that_row_not_the_whole_poll() {
    // One corrupt column must not stop the other sessions in the batch from
    // being collected — a poll that returns Err ships nothing at all.
    let dir = tmpdir("malformed");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    assistant_calls(
        &conn,
        CLI_SESSION,
        "not json at all",
        1_785_744_254.923_234_2,
    );
    assistant_text(&conn, CLI_SESSION, "recovered", 1_785_744_261.708_625);

    let ev = poll_all(&db);
    assert!(of_type(&ev, "tool_use").is_empty());
    assert_eq!(of_type(&ev, "model_response").len(), 1);

    fs::remove_dir_all(&dir).ok();
}

// ── call → result pairing ────────────────────────────────────────────────

#[test]
fn a_tool_result_is_paired_to_its_call_by_tool_call_id() {
    let dir = tmpdir("pair");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    assistant_calls(&conn, CLI_SESSION, TERMINAL_CALL, 1_785_744_254.923_234_2);
    tool_result(
        &conn,
        CLI_SESSION,
        "tooluse_8LfsNiQKh5FW5zW7gFOoVX",
        "terminal",
        r#"{"output": "README.md\na.txt", "exit_code": 0, "error": null}"#,
        1_785_744_254.967_635_4,
    );

    let ev = poll_all(&db);
    let results = of_type(&ev, "tool_result");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["tool_call_id"], "tooluse_8LfsNiQKh5FW5zW7gFOoVX");
    assert_eq!(
        results[0]["tool_name"], "terminal",
        "a result with no name is a blank row in the product"
    );
    assert!(
        results[0]["output"].as_str().unwrap().contains("README.md"),
        "the tool's output must survive"
    );
    // A clean run must not be flagged: `exit_code: 0` with `error: null`.
    assert!(results[0].get("error_type").is_none());

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_result_split_from_its_call_by_the_row_limit_still_names_its_tool() {
    // When a batch is cut between the call and its result, the in-poll pairing
    // map is empty on the next pass. Hermes stores `tool_name` on the result
    // row too, and that fallback is the only thing standing between this and a
    // permanently blank row every time a backlog drains.
    let dir = tmpdir("split");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    assistant_calls(&conn, CLI_SESSION, TERMINAL_CALL, 1_785_744_254.923_234_2);
    tool_result(
        &conn,
        CLI_SESSION,
        "tooluse_8LfsNiQKh5FW5zW7gFOoVX",
        "terminal",
        r#"{"output": "README.md", "exit_code": 0, "error": null}"#,
        1_785_744_254.967_635_4,
    );

    let first = poll_at(&db, 0, 1);
    assert!(first.more, "a cut batch must ask the engine to poll again");
    let second = poll_at(&db, first.watermark, 1);
    let results = of_type(&second.events, "tool_result");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["tool_name"], "terminal");

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_failed_tool_result_carries_a_non_empty_error() {
    // Verbatim from the capture: a `session_search` that could not resolve its
    // argument. Without this the failure is indistinguishable from a success.
    let dir = tmpdir("toolerr");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    tool_result(
        &conn,
        CLI_SESSION,
        "tooluse_GqnMvLFT1UKNu83Un5rSIK",
        "session_search",
        r#"{"error": "around_message_id 1 not in session_id 20260803_080402_a54231", "success": false}"#,
        1_785_744_414.006_979,
    );

    let ev = poll_all(&db);
    let results = of_type(&ev, "tool_result");
    assert_eq!(results[0]["error_type"], "hermes_tool_error");
    assert!(
        results[0]["error"]
            .as_str()
            .unwrap()
            .contains("not in session_id")
    );

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_non_zero_exit_code_is_not_treated_as_a_tool_error() {
    // `grep` finding nothing exits 1. Flagging that would fill the product with
    // false alarms indistinguishable from the real ones above.
    let dir = tmpdir("exitcode");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    tool_result(
        &conn,
        CLI_SESSION,
        "c1",
        "terminal",
        r#"{"output": "", "exit_code": 1, "error": null}"#,
        1_785_744_254.967_635_4,
    );

    let ev = poll_all(&db);
    assert!(of_type(&ev, "tool_result")[0].get("error_type").is_none());

    fs::remove_dir_all(&dir).ok();
}

// ── agent id: both session shapes ────────────────────────────────────────

#[test]
fn a_cli_session_is_grouped_by_its_working_directory() {
    // `cwd` IS populated for CLI sessions (5/5 on the probe), so they group by
    // project exactly like the hook source does — which is what makes hook
    // events and session events for one run land under a single agent.
    let dir = tmpdir("cwd");
    let (db, conn) = make_db(&dir);
    insert_session(
        &conn,
        CLI_SESSION,
        "cli",
        Some("/home/u/src/openclaw-local"),
        1_785_744_251.652_289_9,
        None,
        None,
        None,
    );
    user(&conn, CLI_SESSION, "hi", 1_785_744_251.686_618);

    let ev = poll_all(&db);
    assert!(!ev.is_empty());
    for e in &ev {
        assert_eq!(e["agent_id"], "hermes-openclaw-local");
        assert_eq!(e["hermes_cwd"], "/home/u/src/openclaw-local");
    }

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_gateway_session_with_no_cwd_falls_back_to_its_source() {
    // Slack/Telegram sessions genuinely have NULL cwd. Falling all the way back
    // to a bare `hermes` would merge every transport into one agent nobody can
    // act on, so the transport is the grouping axis instead.
    let dir = tmpdir("gateway");
    let (db, conn) = make_db(&dir);
    insert_session(
        &conn,
        GATEWAY_SESSION,
        "slack",
        None,
        1_785_744_900.0,
        None,
        None,
        Some("channel"),
    );
    user(&conn, GATEWAY_SESSION, "deploy please", 1_785_744_901.5);

    let ev = poll_all(&db);
    assert!(!ev.is_empty());
    for e in &ev {
        assert_eq!(e["agent_id"], "hermes-slack");
        assert_eq!(e["hermes_source"], "slack");
        assert!(
            e.get("hermes_cwd").is_none(),
            "a NULL cwd must not become an empty string"
        );
    }
    assert_eq!(
        of_type(&ev, "agent_start")[0]["hermes_chat_type"],
        "channel"
    );

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_message_whose_session_row_is_gone_falls_back_to_the_configured_agent_id() {
    // A partially-applied rewind or a hand-edited database leaves orphans. One
    // orphan must not error the poll and cost every other session in the batch.
    let dir = tmpdir("orphan");
    let (db, conn) = make_db(&dir);
    conn.execute("PRAGMA foreign_keys = OFF", []).unwrap();
    user(
        &conn,
        "20260803_999999_ffffff",
        "orphan",
        1_785_744_251.686_618,
    );

    let ev = poll_all(&db);
    assert_eq!(ev.len(), 1, "the orphan's own turn still ships");
    assert_eq!(ev[0]["agent_id"], hermes::DEFAULT_AGENT_ID);
    assert!(
        of_type(&ev, "agent_start").is_empty(),
        "no session row means nothing to start from"
    );

    fs::remove_dir_all(&dir).ok();
}

// ── timestamps ───────────────────────────────────────────────────────────

#[test]
fn real_float_epoch_seconds_become_rfc3339_with_six_subsecond_digits() {
    // `timestamp` is a REAL epoch SECONDS float (1785744251.686618), not
    // milliseconds and not ISO. Read as millis it lands in 1970; read as ISO it
    // fails to parse and the row is dropped. Six digits are forced so this
    // stream sorts against the hook stream on a shared timeline.
    let dir = tmpdir("ts");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    user(&conn, CLI_SESSION, "hi", 1_785_744_251.686_618);

    let ev = poll_all(&db);
    let req = of_type(&ev, "model_request")[0];
    assert_eq!(req["timestamp"], "2026-08-03T08:04:11.686000Z");

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_row_with_an_implausible_timestamp_is_dropped_rather_than_dated_to_1970() {
    // A 1970 event parks itself at the head of every timeline it lands on,
    // silently reordering a real session. The watermark still advances past the
    // row, so it costs one dropped message rather than a permanent retry.
    let dir = tmpdir("badts");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    user(&conn, CLI_SESSION, "from a broken clock", 42.0);
    user(&conn, CLI_SESSION, "sane", 1_785_744_251.686_618);

    let out = poll_at(&db, 0, 1000);
    let reqs = of_type(&out.events, "model_request");
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0]["messages"][0]["content"], "sane");
    assert_eq!(out.rows_seen, 2, "the bad row was read, just not shipped");
    assert_eq!(out.watermark, 2, "and the watermark moved past it");

    fs::remove_dir_all(&dir).ok();
}

// ── session boundaries ───────────────────────────────────────────────────

#[test]
fn a_finished_session_is_bracketed_by_a_start_and_an_end() {
    let dir = tmpdir("bracket");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, true);
    user(
        &conn,
        CLI_SESSION,
        "List the files in /work using the terminal tool.",
        1_785_744_251.686_618,
    );
    assistant_calls(&conn, CLI_SESSION, TERMINAL_CALL, 1_785_744_254.923_234_2);
    tool_result(
        &conn,
        CLI_SESSION,
        "tooluse_8LfsNiQKh5FW5zW7gFOoVX",
        "terminal",
        r#"{"output": "README.md", "exit_code": 0, "error": null}"#,
        1_785_744_254.967_635_4,
    );
    assistant_text(&conn, CLI_SESSION, "Demo Project", 1_785_744_261.708_625);

    let ev = poll_all(&db);
    let types: Vec<&str> = ev.iter().filter_map(|e| e["type"].as_str()).collect();
    assert_eq!(
        types,
        vec![
            "agent_start",
            "model_request",
            "tool_use",
            "tool_result",
            "model_response",
            "agent_end",
        ],
        "got {types:?}"
    );

    let start = of_type(&ev, "agent_start")[0];
    // `started_at` is 34 ms before the first prompt; using the message time
    // would report every session as starting late.
    assert_eq!(start["timestamp"], "2026-08-03T08:04:11.652000Z");
    assert!(
        start["goal"]
            .as_str()
            .unwrap()
            .starts_with("List the files"),
        "the opening prompt is the session's goal"
    );
    assert_eq!(start["model"], MODEL);

    let end = of_type(&ev, "agent_end")[0];
    assert_eq!(end["hermes_end_reason"], "agent_close");
    assert_eq!(end["input_tokens"], 37481);
    // 999 µs past `ended_at`, so it cannot sort before a turn sharing its
    // millisecond — the server's tie-break is a random id.
    assert_eq!(end["timestamp"], "2026-08-03T08:04:21.719999Z");

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_live_session_gets_a_start_but_no_end() {
    // `ended_at` is NULL until Hermes closes the session. Ending it anyway
    // would emit an `agent_end` on every poll that touched the newest row.
    let dir = tmpdir("live");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    user(&conn, CLI_SESSION, "still going", 1_785_744_251.686_618);

    let ev = poll_all(&db);
    assert_eq!(of_type(&ev, "agent_start").len(), 1);
    assert!(of_type(&ev, "agent_end").is_empty());

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_start_fires_once_even_when_the_session_is_re_read_from_zero() {
    // The trigger is "this row is the session's lowest surviving id", a pure
    // function of the database — not "the first time this poller saw the
    // session", which would ship a fresh start after every daemon restart.
    let dir = tmpdir("startonce");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, true);
    user(&conn, CLI_SESSION, "one", 1_785_744_251.686_618);
    assistant_text(&conn, CLI_SESSION, "two", 1_785_744_261.708_625);

    let a = poll_all(&db);
    let b = poll_all(&db);
    assert_eq!(of_type(&a, "agent_start").len(), 1);
    assert_eq!(a, b, "a re-read must produce byte-identical events");

    fs::remove_dir_all(&dir).ok();
}

// ── watermark, limits, dedup ─────────────────────────────────────────────

#[test]
fn the_watermark_advances_and_a_second_poll_returns_nothing() {
    let dir = tmpdir("watermark");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, true);
    user(&conn, CLI_SESSION, "hi", 1_785_744_251.686_618);
    assistant_text(&conn, CLI_SESSION, "hello", 1_785_744_261.708_625);

    let first = poll_at(&db, 0, 1000);
    assert!(!first.events.is_empty());
    assert_eq!(first.watermark, 2);
    assert!(!first.more);

    let second = poll_at(&db, first.watermark, 1000);
    assert!(second.events.is_empty(), "got {:#?}", second.events);
    assert_eq!(second.rows_seen, 0);
    assert_eq!(second.watermark, first.watermark);
    assert!(!second.more);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn hitting_the_row_limit_reports_more_so_a_backlog_drains() {
    // The engine polls again immediately when `more` is set. Without it a
    // restart after downtime trickles one batch per poll interval.
    let dir = tmpdir("limit");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, true);
    for i in 0..5 {
        user(&conn, CLI_SESSION, "x", 1_785_744_251.686_618 + i as f64);
    }

    let out = poll_at(&db, 0, 2);
    assert!(out.more);
    assert_eq!(out.rows_seen, 2);
    assert_eq!(out.watermark, 2);

    let rest = poll_at(&db, out.watermark, 100);
    assert!(!rest.more);
    assert_eq!(rest.rows_seen, 3);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn two_identical_messages_are_discriminated_by_their_row_id() {
    // The same prompt asked twice in one session produces byte-identical
    // events but for `hermes_row_id`. Without that discriminator the server's
    // content hash collapses a genuinely repeated turn into one row.
    let dir = tmpdir("dedup");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    user(&conn, CLI_SESSION, "same", 1_785_744_251.686_618);
    user(&conn, CLI_SESSION, "same", 1_785_744_251.686_618);

    let ev = poll_all(&db);
    let reqs = of_type(&ev, "model_request");
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0]["hermes_row_id"], 1);
    assert_eq!(reqs[1]["hermes_row_id"], 2);
    assert_ne!(reqs[0], reqs[1]);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_rewound_row_is_still_shipped_and_marked_inactive() {
    // Hermes flips `active` to 0 on rewind and compaction rather than deleting.
    // Filtering on `active = 1` would mean a row inserted while inactive never
    // ships at all, and the marker is what explains why a message the user can
    // see was not in the prompt that followed it.
    let dir = tmpdir("inactive");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    user(&conn, CLI_SESSION, "rewound", 1_785_744_251.686_618);
    conn.execute("UPDATE messages SET active = 0 WHERE id = 1", [])
        .unwrap();

    let ev = poll_all(&db);
    assert_eq!(of_type(&ev, "model_request").len(), 1);
    assert_eq!(ev[0]["hermes_active"], false);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_fts_shadow_tables_are_populated_but_never_read() {
    // `messages_fts*` mirrors every message under a rowid that means nothing
    // here. A poller that widened its FROM would ship the whole conversation
    // twice; this pins that the triggers fire and we still read `messages` only.
    let dir = tmpdir("fts");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    user(&conn, CLI_SESSION, "indexed by fts", 1_785_744_251.686_618);
    assistant_text(&conn, CLI_SESSION, "so is this", 1_785_744_261.708_625);

    let mirrored: i64 = conn
        .query_row("SELECT count(*) FROM messages_fts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mirrored, 2, "the real triggers must have fired");

    let out = poll_at(&db, 0, 1000);
    assert_eq!(out.rows_seen, 2, "only the `messages` rows are read");
    assert_eq!(of_type(&out.events, "model_request").len(), 1);
    assert_eq!(of_type(&out.events, "model_response").len(), 1);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn several_sessions_in_one_batch_keep_their_own_agent_ids() {
    // One database holds every session on the machine, CLI and gateway alike.
    // A poll that resolved the session once and reused it would file a Slack
    // turn under the last CLI project it happened to see.
    let dir = tmpdir("mixed");
    let (db, conn) = make_db(&dir);
    insert_session(
        &conn,
        CLI_SESSION,
        "cli",
        Some("/work"),
        1_785_744_251.6,
        None,
        None,
        None,
    );
    insert_session(
        &conn,
        GATEWAY_SESSION,
        "telegram",
        None,
        1_785_744_900.0,
        None,
        None,
        Some("dm"),
    );
    user(&conn, CLI_SESSION, "cli turn", 1_785_744_251.686_618);
    user(&conn, GATEWAY_SESSION, "gateway turn", 1_785_744_901.5);

    let ev = poll_all(&db);
    let reqs = of_type(&ev, "model_request");
    assert_eq!(reqs[0]["agent_id"], "hermes-work");
    assert_eq!(reqs[1]["agent_id"], "hermes-telegram");

    fs::remove_dir_all(&dir).ok();
}

// ── format table and discovery ───────────────────────────────────────────

#[test]
fn hermes_declares_a_rowid_watermark() {
    // `messages` has no last-modified column, so `UpdatedAt` is not available
    // as an alternative — the module docs record what that costs.
    assert_eq!(hermes::FORMAT.watermark, Watermark::RowId);
    assert_eq!(hermes::FORMAT.kind, "hermes");
}

#[test]
fn every_profile_is_a_separate_database_and_all_of_them_are_found() {
    // A Hermes profile is a whole separate home with its own state.db. Reading
    // only `~/.hermes/state.db` makes every non-default profile invisible —
    // the exact bug the audit pillar shipped with before profile support.
    let root = tmpdir("profiles");
    fs::create_dir_all(root.join("profiles/work")).unwrap();
    fs::create_dir_all(root.join("profiles/alpha")).unwrap();
    fs::create_dir_all(root.join("profiles/.hidden")).unwrap();
    fs::write(root.join("profiles/notadir"), b"x").unwrap();

    let paths = hermes::db_paths_under(&root);
    assert_eq!(
        paths,
        vec![
            root.join("state.db"),
            // Sorted, so the set of sources a daemon starts is stable across
            // restarts; directory order is not.
            root.join("profiles/alpha/state.db"),
            root.join("profiles/work/state.db"),
        ]
    );

    fs::remove_dir_all(&root).ok();
}

#[test]
fn a_missing_profiles_directory_still_yields_the_default_database() {
    // The single-profile install everyone starts with.
    let root = tmpdir("noprofiles");
    assert_eq!(
        hermes::db_paths_under(&root),
        vec![root.join("state.db")],
        "discovery must fail open"
    );
    fs::remove_dir_all(&root).ok();
}

#[test]
fn a_hermes_home_pointing_at_a_profile_climbs_back_to_the_root() {
    // The generated per-profile alias wrapper exports
    // HERMES_HOME=<root>/profiles/<name>. Taking that literally would collect
    // from one profile and silently ignore every sibling.
    assert_eq!(
        hermes::root_from_home(Path::new("/home/u/.hermes/profiles/work")),
        PathBuf::from("/home/u/.hermes")
    );
    assert_eq!(
        hermes::root_from_home(Path::new("/home/u/.hermes")),
        PathBuf::from("/home/u/.hermes")
    );
}

// ── engine ───────────────────────────────────────────────────────────────

fn spec(db: PathBuf, spool: PathBuf, state: PathBuf) -> sqlitepoll::Spec {
    sqlitepoll::Spec {
        health_key: None,
        format: hermes::FORMAT,
        db_path: db,
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(150),
        params: sqlitepoll::Params {
            redact: fpai_collect::Redact::Minimal,
            agent_id: hermes::DEFAULT_AGENT_ID.into(),
            environment: "local".into(),
            machine_id: None,
            user: None,
            max_rows_per_poll: 500,
            max_batch_bytes: 8 * 1024 * 1024,
            max_drain_passes: 8,
            label: None,
        },
    }
}

fn spooled(dir: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else {
        return out;
    };
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        for l in fs::read_to_string(&p).unwrap().lines() {
            if !l.trim().is_empty() {
                out.push(serde_json::from_str(l).unwrap());
            }
        }
    }
    out
}

async fn run_briefly(s: sqlitepoll::Spec, ms: u64) {
    let sd = Shutdown::for_test(Arc::new(AtomicBool::new(false)));
    let _ = tokio::time::timeout(Duration::from_millis(ms), sqlitepoll::run(s, sd)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_is_spooled_once_and_a_resumed_run_ships_nothing() {
    // The end-to-end property: the cursor survives the process, so a daemon
    // restart does not re-ship every session in the database.
    let dir = tmpdir("engine-db");
    let spool = tmpdir("engine-spool");
    let state = tmpdir("engine-state");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, true);
    user(&conn, CLI_SESSION, "list the files", 1_785_744_251.686_618);
    assistant_calls(&conn, CLI_SESSION, TERMINAL_CALL, 1_785_744_254.923_234_2);
    tool_result(
        &conn,
        CLI_SESSION,
        "tooluse_8LfsNiQKh5FW5zW7gFOoVX",
        "terminal",
        r#"{"output": "README.md", "exit_code": 0, "error": null}"#,
        1_785_744_254.967_635_4,
    );
    assistant_text(&conn, CLI_SESSION, "Demo Project", 1_785_744_261.708_625);
    drop(conn);

    run_briefly(spec(db.clone(), spool.clone(), state.clone()), 900).await;
    let ev = spooled(&spool);
    let types: Vec<&str> = ev.iter().filter_map(|e| e["type"].as_str()).collect();
    for want in [
        "agent_start",
        "model_request",
        "tool_use",
        "tool_result",
        "model_response",
        "agent_end",
    ] {
        assert!(types.contains(&want), "missing {want}: {types:?}");
    }
    for e in &ev {
        assert_eq!(e["session_id"], CLI_SESSION);
        assert_eq!(e["agent_id"], "hermes-work");
        assert_eq!(e["environment"], "local");
    }

    for e in fs::read_dir(&spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }
    run_briefly(spec(db.clone(), spool.clone(), state.clone()), 600).await;
    assert!(
        spooled(&spool).is_empty(),
        "a resumed run must ship nothing"
    );

    fs::remove_dir_all(&dir).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn new_turns_appended_after_a_pass_are_picked_up_without_re_shipping() {
    let dir = tmpdir("append-db");
    let spool = tmpdir("append-spool");
    let state = tmpdir("append-state");
    let (db, conn) = make_db(&dir);
    insert_cli_session(&conn, false);
    user(&conn, CLI_SESSION, "first", 1_785_744_251.686_618);

    run_briefly(spec(db.clone(), spool.clone(), state.clone()), 900).await;
    assert!(!spooled(&spool).is_empty());
    for e in fs::read_dir(&spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }

    user(&conn, CLI_SESSION, "second", 1_785_744_300.0);
    run_briefly(spec(db.clone(), spool.clone(), state.clone()), 900).await;

    let ev = spooled(&spool);
    assert_eq!(ev.len(), 1, "only the appended turn must ship, got {ev:#?}");
    assert_eq!(ev[0]["messages"][0]["content"], "second");

    drop(conn);
    fs::remove_dir_all(&dir).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_absent_hermes_install_is_not_an_error() {
    // The overwhelmingly common case: Hermes simply is not installed. The
    // source must idle quietly rather than logging a failure every poll.
    let spool = tmpdir("absent-spool");
    let state = tmpdir("absent-state");
    run_briefly(
        spec(
            PathBuf::from("/nonexistent/fpai/hermes/state.db"),
            spool.clone(),
            state.clone(),
        ),
        500,
    )
    .await;
    assert!(spooled(&spool).is_empty());

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}
