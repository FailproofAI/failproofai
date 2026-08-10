//! goose source: transform correctness and engine behaviour.
//!
//! Every test builds a REAL SQLite database in WAL mode using the DDL goose
//! itself ships (verified against goose v1.43.0, `schema_version` 15) and reads
//! it back through the same read-only connection the daemon uses. Record shapes
//! are verbatim from a live `~/.local/share/goose/sessions/sessions.db`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::sources::goose;
use fpai_collect::sqlitepoll::{self, Params, PollOutcome, PollRequest, Spec, Watermark};
use fpai_collect::supervisor::Shutdown;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

/// goose's own DDL, copied from a live database. Kept verbatim — a paraphrased
/// schema is exactly how a source stops matching the product it reads.
const SCHEMA: &str = r#"
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    user_set_name BOOLEAN DEFAULT FALSE,
    session_type TEXT NOT NULL DEFAULT 'user',
    working_dir TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    extension_data TEXT DEFAULT '{}',
    total_tokens INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    accumulated_total_tokens INTEGER,
    accumulated_input_tokens INTEGER,
    accumulated_output_tokens INTEGER,
    accumulated_cache_read_tokens INTEGER,
    accumulated_cache_write_tokens INTEGER,
    accumulated_cost REAL,
    schedule_id TEXT,
    recipe_json TEXT,
    user_recipe_values_json TEXT,
    provider_name TEXT,
    model_config_json TEXT,
    goose_mode TEXT NOT NULL DEFAULT 'auto',
    archived_at TIMESTAMP,
    project_id TEXT,
    parent_session_id TEXT
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    tokens INTEGER,
    metadata_json TEXT
);
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_sessions_type ON sessions(session_type);
"#;

const MODEL_CONFIG: &str = r#"{"model_name":"claude-sonnet-4-6","context_limit":1000000}"#;

/// A second inside the live corpus, so the rendered timestamps in these tests
/// are the ones a real session produced.
const T0: i64 = 1_785_743_817;

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-gs-{}-{}-{}",
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

/// A writable goose database, in WAL mode like the real one.
struct Db {
    dir: PathBuf,
    path: PathBuf,
    conn: Connection,
}

impl Db {
    fn new(name: &str) -> Self {
        let dir = tmpdir(name);
        let path = dir.join("sessions.db");
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        Self { dir, path, conn }
    }

    fn session(&self, id: &str, working_dir: &str, session_type: &str) -> &Self {
        self.conn
            .execute(
                "INSERT INTO sessions(id, name, session_type, working_dir, provider_name, model_config_json)
                 VALUES (?1, ?2, ?3, ?4, 'openai', ?5)",
                params![id, "probe", session_type, working_dir, MODEL_CONFIG],
            )
            .unwrap();
        self
    }

    /// Insert one `messages` row and return its rowid.
    fn message(&self, session_id: &str, role: &str, content: &Value, created: i64) -> i64 {
        self.message_with_meta(session_id, role, content, created, None)
    }

    fn message_with_meta(
        &self,
        session_id: &str,
        role: &str,
        content: &Value,
        created: i64,
        metadata: Option<&str>,
    ) -> i64 {
        self.conn
            .execute(
                "INSERT INTO messages(message_id, session_id, role, content_json,
                                      created_timestamp, tokens, metadata_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
                params![
                    format!("msg_{created}"),
                    session_id,
                    role,
                    content.to_string(),
                    created,
                    metadata
                ],
            )
            .unwrap();
        self.conn.last_insert_rowid()
    }

    fn poll(&self, watermark: i64) -> PollOutcome {
        self.poll_limited(watermark, 1000)
    }

    fn poll_limited(&self, watermark: i64, max_rows: u64) -> PollOutcome {
        let conn = sqlitepoll::open_readonly(&self.path).unwrap();
        (goose::FORMAT.poll)(
            &conn,
            &PollRequest {
                watermark,
                max_rows,
                environment: "local".into(),
                agent_id: goose::DEFAULT_AGENT_ID.into(),
            },
        )
        .unwrap()
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.dir).ok();
    }
}

// ── the block shapes, verbatim from a live database ──────────────────────

fn text(t: &str) -> Value {
    json!([{ "type": "text", "text": t }])
}

fn thinking(t: &str) -> Value {
    json!([{ "type": "thinking", "thinking": t, "signature": "sig" }])
}

fn tool_request(id: &str, name: &str, command: &str) -> Value {
    json!([{
        "type": "toolRequest",
        "id": id,
        "toolCall": {"status": "success", "value": {"name": name, "arguments": {"command": command}}},
        "_meta": {"goose_extension": "developer"}
    }])
}

fn tool_response(id: &str, out: &str) -> Value {
    json!([{
        "type": "toolResponse",
        "id": id,
        "toolResult": {"status": "success", "value": {
            "content": [{"type": "text", "text": out, "annotations": {"priority": 0.0}}],
            "structuredContent": {"stdout": out, "stderr": "", "exit_code": 0},
            "isError": false
        }}
    }])
}

fn failed_tool_response(id: &str, out: &str) -> Value {
    json!([{
        "type": "toolResponse",
        "id": id,
        "toolResult": {"status": "success", "value": {
            "content": [{"type": "text", "text": out}],
            "isError": true
        }}
    }])
}

// ── assertions helpers ───────────────────────────────────────────────────

fn types(events: &[Value]) -> Vec<&str> {
    events.iter().filter_map(|e| e["type"].as_str()).collect()
}

fn of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == kind).collect()
}

fn one<'a>(events: &'a [Value], kind: &str) -> &'a Value {
    let found = of_type(events, kind);
    assert_eq!(found.len(), 1, "expected one {kind} in {:?}", types(events));
    found[0]
}

// ── content-block shapes ─────────────────────────────────────────────────

#[test]
fn a_user_text_row_becomes_a_model_request_and_an_assistant_text_row_a_model_response() {
    // The two halves of a plain conversational turn. A `model_request` with no
    // `messages` array renders as an empty row, which is the row a session is
    // most likely to be judged by.
    let db = Db::new("text");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message("20260803_1", "user", &text("list the files"), T0);
    db.message("20260803_1", "assistant", &text("Here they are."), T0 + 1);

    let ev = db.poll(0).events;
    let req = one(&ev, "model_request");
    assert_eq!(req["messages"][0]["role"], "user");
    assert_eq!(req["messages"][0]["content"], "list the files");
    // Read off the session row: `messages` carries no per-message model, and
    // the server builds this row's summary from the model alone.
    assert_eq!(req["model"], "claude-sonnet-4-6");

    let resp = one(&ev, "model_response");
    assert_eq!(resp["role"], "assistant");
    assert_eq!(resp["content"], "Here they are.");
    assert_eq!(resp["model"], "claude-sonnet-4-6");
}

#[test]
fn a_tool_request_becomes_a_tool_use_carrying_its_arguments() {
    let db = Db::new("toolreq");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message(
        "20260803_1",
        "assistant",
        &tool_request("tooluse_zEEEAN7v7StUeLHzdGykp6", "shell", "ls -la"),
        T0,
    );

    let ev = db.poll(0).events;
    let use_ = one(&ev, "tool_use");
    assert_eq!(use_["tool_name"], "shell");
    assert_eq!(use_["tool_call_id"], "tooluse_zEEEAN7v7StUeLHzdGykp6");
    // `arguments` is nested two levels deep inside a serialized Result; reading
    // `toolCall` directly would ship an empty command for every call.
    assert_eq!(use_["input"]["command"], "ls -la");
}

#[test]
fn a_tool_response_arrives_in_a_user_role_row_and_is_not_read_as_a_prompt() {
    // The single most important branch in this source. goose files tool results
    // under `role:'user'`, so a role-first branch turns every result into a
    // user prompt and the timeline reads as the model interviewing itself.
    let db = Db::new("respinuser");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message(
        "20260803_1",
        "assistant",
        &tool_request("t1", "shell", "ls"),
        T0,
    );
    db.message(
        "20260803_1",
        "user",
        &tool_response("t1", "total 4"),
        T0 + 1,
    );

    let ev = db.poll(0).events;
    assert!(
        of_type(&ev, "model_request").is_empty(),
        "a tool result must not become a prompt: {:?}",
        types(&ev)
    );
    let result = one(&ev, "tool_result");
    assert_eq!(result["output"], "total 4");
    assert_eq!(result["tool_call_id"], "t1");
}

#[test]
fn a_tool_result_is_named_from_the_request_it_answers() {
    // The name appears on NO response block. Without carrying it, every result
    // renders as a blank row in the product.
    let db = Db::new("named");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message(
        "20260803_1",
        "assistant",
        &tool_request("t1", "shell", "ls"),
        T0,
    );
    db.message(
        "20260803_1",
        "user",
        &tool_response("t1", "total 4"),
        T0 + 1,
    );

    let ev = db.poll(0).events;
    assert_eq!(one(&ev, "tool_result")["tool_name"], "shell");
}

#[test]
fn a_result_whose_call_landed_in_an_earlier_poll_is_still_named() {
    // The call and its result are separate ROWS, so a poll boundary can fall
    // between them — unlike Claude, where in-memory state always has the name.
    let db = Db::new("crossbatch");
    db.session("20260803_1", "/home/u/repo", "user");
    let call = db.message(
        "20260803_1",
        "assistant",
        &tool_request("t1", "shell", "ls"),
        T0,
    );
    db.message(
        "20260803_1",
        "user",
        &tool_response("t1", "total 4"),
        T0 + 1,
    );

    // Resume as if the previous poll had stopped right after the call row.
    let ev = db.poll(call).events;
    assert_eq!(
        one(&ev, "tool_result")["tool_name"],
        "shell",
        "the name must be recovered from the database"
    );
}

#[test]
fn a_thinking_block_becomes_a_marked_model_response() {
    // Not seen in the live corpus but present in goose's block enum; an
    // unhandled variant drops the turn silently rather than loudly.
    let db = Db::new("thinking");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message("20260803_1", "assistant", &thinking("weighing options"), T0);

    let ev = db.poll(0).events;
    let resp = one(&ev, "model_response");
    assert_eq!(resp["content"], "weighing options");
    assert_eq!(resp["goose_thinking"], true);
}

#[test]
fn a_failed_tool_result_carries_a_non_empty_error() {
    let db = Db::new("toolerr");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message(
        "20260803_1",
        "assistant",
        &tool_request("t1", "shell", "false"),
        T0,
    );
    db.message(
        "20260803_1",
        "user",
        &failed_tool_response("t1", "exit code 1"),
        T0 + 1,
    );

    let ev = db.poll(0).events;
    let result = one(&ev, "tool_result");
    assert_eq!(result["error_type"], "goose_tool_error");
    assert!(!result["error"].as_str().unwrap().is_empty());
}

#[test]
fn a_tool_call_that_never_reached_its_tool_is_reported_as_an_error() {
    // `toolCall` is a serialized Result: on the error arm there is no `value`,
    // so a blind read of `/toolCall/value/name` would ship a nameless call with
    // no indication anything went wrong.
    let db = Db::new("callerr");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message(
        "20260803_1",
        "assistant",
        &json!([{"type":"toolRequest","id":"t1",
                 "toolCall":{"status":"error","error":"extension not available"}}]),
        T0,
    );

    let ev = db.poll(0).events;
    let use_ = one(&ev, "tool_use");
    assert_eq!(use_["goose_tool_call_status"], "error");
    assert_eq!(use_["error"], "extension not available");
    assert_eq!(use_["error_type"], "goose_tool_error");
}

// ── rows are not turn-aligned ────────────────────────────────────────────

#[test]
fn parallel_tool_calls_spread_over_separate_rows_keep_their_own_names_and_order() {
    // A live turn emitting four parallel `shell` calls produced FIVE rows — a
    // preamble text row plus one row per call — with the results interleaved as
    // four more rows, every one of them stamped with the SAME second. Anything
    // that assumes one row is one turn, or that a shared second is a tie,
    // renders this turn wrong.
    let db = Db::new("parallel");
    db.session("20260803_2", "/home/u/repo", "user");
    db.message("20260803_2", "assistant", &text("Running all four."), T0);
    for (id, cmd) in [("a", "head"), ("b", "sed1"), ("c", "sed2"), ("d", "cat")] {
        db.message(
            "20260803_2",
            "assistant",
            &tool_request(id, "shell", cmd),
            T0,
        );
        db.message("20260803_2", "user", &tool_response(id, cmd), T0);
    }

    let ev = db.poll(0).events;
    assert_eq!(of_type(&ev, "tool_use").len(), 4);
    assert_eq!(of_type(&ev, "tool_result").len(), 4);
    assert_eq!(of_type(&ev, "model_response").len(), 1, "the preamble row");

    // Each result must pair with its own call, not with whichever call the
    // server happens to sort next to it.
    for (id, cmd) in [("a", "head"), ("b", "sed1"), ("c", "sed2"), ("d", "cat")] {
        let result = ev
            .iter()
            .find(|e| e["type"] == "tool_result" && e["tool_call_id"] == id)
            .unwrap_or_else(|| panic!("no result for {id}"));
        assert_eq!(result["tool_name"], "shell");
        assert_eq!(result["output"], cmd);
    }

    // Every event shares one second, so ordering rests entirely on the
    // sub-second slots: each call must sort before its own result.
    for (id, _) in [("a", ""), ("b", ""), ("c", ""), ("d", "")] {
        let call = ev
            .iter()
            .find(|e| e["type"] == "tool_use" && e["tool_call_id"] == id)
            .unwrap();
        let result = ev
            .iter()
            .find(|e| e["type"] == "tool_result" && e["tool_call_id"] == id)
            .unwrap();
        assert!(
            call["timestamp"].as_str() < result["timestamp"].as_str(),
            "{id}: call {} must sort before result {}",
            call["timestamp"],
            result["timestamp"]
        );
    }
}

#[test]
fn several_blocks_in_one_row_are_distinguishable_and_ordered() {
    // Every live row held exactly one block, but the column is an array and
    // goose's own writer can emit more; two identical blocks in one row must
    // not hash to the same event.
    let db = Db::new("multiblock");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message(
        "20260803_1",
        "assistant",
        &json!([{"type":"text","text":"same"},{"type":"text","text":"same"}]),
        T0,
    );

    let ev = db.poll(0).events;
    let responses = of_type(&ev, "model_response");
    assert_eq!(responses.len(), 2);
    assert_ne!(responses[0]["timestamp"], responses[1]["timestamp"]);
    assert_eq!(responses[1]["goose_block_index"], 1);
}

// ── session filtering and identity ───────────────────────────────────────

#[test]
fn a_hidden_session_is_filtered_out_but_still_advances_the_watermark() {
    // `session_type='hidden'` rows are `goose run --no-session` scratch runs.
    // Filtering them without advancing past them would re-read them on every
    // poll for the life of the machine.
    let db = Db::new("hidden");
    db.session("20260803_1", "/home/u/repo", "hidden");
    db.session("20260803_2", "/home/u/repo", "user");
    let scratch = db.message("20260803_1", "user", &text("scratch run"), T0);
    db.message("20260803_2", "user", &text("real run"), T0 + 1);

    let out = db.poll(0);
    assert!(
        !out.events.iter().any(|e| e["session_id"] == "20260803_1"),
        "a hidden session must not reach the product"
    );
    assert!(out.events.iter().any(|e| e["session_id"] == "20260803_2"));
    assert!(out.watermark > scratch, "the scratch row must be passed");
    assert_eq!(out.rows_seen, 2, "both rows were examined");
}

#[test]
fn a_session_type_the_next_goose_release_adds_is_kept_rather_than_dropped() {
    // goose already ships `subagent`, `scheduled`, `terminal` and `acp`. Only
    // `hidden` is a scratch run; an allowlist would silently drop the rest.
    let db = Db::new("subagent");
    db.session("20260803_1", "/home/u/repo", "subagent");
    db.message("20260803_1", "user", &text("delegated work"), T0);

    let ev = db.poll(0).events;
    assert!(types(&ev).contains(&"model_request"), "{:?}", types(&ev));
}

#[test]
fn the_agent_id_comes_from_the_sessions_working_dir() {
    // `working_dir` is NOT NULL and populated for every live session, so goose
    // sessions group by project like Claude's. The spelling has to match what
    // the hook source derives for the same run, or one run's hook events and
    // session events file under two agents that look unrelated.
    let db = Db::new("agentid");
    db.session("20260803_1", "/home/u/src/openclaw-local", "user");
    db.message("20260803_1", "user", &text("hi"), T0);

    let ev = db.poll(0).events;
    assert!(!ev.is_empty());
    for e in &ev {
        assert_eq!(e["agent_id"], "goose-openclaw-local");
        assert_eq!(e["environment"], "local");
        assert_eq!(e["session_id"], "20260803_1");
    }
}

#[test]
fn a_message_whose_session_row_is_missing_still_ships() {
    // The foreign key is declared but SQLite does not enforce it unless
    // `PRAGMA foreign_keys` is on. An inner join would make such a row vanish
    // silently instead of shipping under the configured fallback agent.
    let db = Db::new("orphan");
    // rusqlite turns the pragma ON for its own connections, which is exactly
    // why this state is reachable in the wild: goose's writer decides, not us.
    db.conn.pragma_update(None, "foreign_keys", false).unwrap();
    db.conn
        .execute(
            "INSERT INTO messages(session_id, role, content_json, created_timestamp)
             VALUES ('ghost', 'user', ?1, ?2)",
            params![text("orphaned").to_string(), T0],
        )
        .unwrap();

    let ev = db.poll(0).events;
    assert_eq!(one(&ev, "model_request")["agent_id"], "goose");
}

// ── session boundaries ───────────────────────────────────────────────────

#[test]
fn a_session_starts_on_its_first_row_and_ends_when_another_session_writes() {
    // goose writes no start or end marker, so both are derived from the row
    // stream: the start rides `MIN(id)`, and the end rides the row after the
    // session's last one.
    let db = Db::new("bounds");
    db.session("20260803_1", "/home/u/repo", "user");
    db.session("20260803_2", "/home/u/repo", "user");
    db.message("20260803_1", "user", &text("first session goal"), T0);
    db.message("20260803_1", "assistant", &text("done"), T0 + 1);
    db.message("20260803_2", "user", &text("second session"), T0 + 60);

    let ev = db.poll(0).events;
    let starts = of_type(&ev, "agent_start");
    assert_eq!(starts.len(), 2, "one start per session");
    assert_eq!(starts[0]["goal"], "first session goal");
    assert_eq!(starts[0]["goose_working_dir"], "/home/u/repo");

    let ends = of_type(&ev, "agent_end");
    assert_eq!(ends.len(), 1, "only the finished session ends");
    assert_eq!(ends[0]["session_id"], "20260803_1");
    // The end is stamped at the session's own last row, not at the row that
    // revealed it had finished — otherwise a session appears to run until the
    // next one starts, however long the gap.
    assert!(
        ends[0]["timestamp"]
            .as_str()
            .unwrap()
            .starts_with("2026-08-03T07:56:58.")
    );

    // And it sorts after that row's own content.
    let last_content = ev
        .iter()
        .rfind(|e| e["session_id"] == "20260803_1" && e["type"] == "model_response")
        .unwrap();
    assert!(last_content["timestamp"].as_str() < ends[0]["timestamp"].as_str());
}

#[test]
fn the_newest_session_stays_open_until_something_writes_after_it() {
    // The documented gap. Closing it would need either a wall clock (which
    // makes the poll impure and un-dedupable) or an `agent_end` recomputed for
    // every session on every poll, forever, on an idle machine.
    let db = Db::new("openend");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message("20260803_1", "user", &text("still going"), T0);

    assert!(of_type(&db.poll(0).events, "agent_end").is_empty());
}

#[test]
fn a_session_is_closed_even_when_its_last_row_ended_the_previous_poll() {
    // The predecessor of a batch's first row lives in the database, not in the
    // batch. Without reading it back, a session whose last row happened to end
    // a poll would never be closed at all.
    let db = Db::new("acrosspoll");
    db.session("20260803_1", "/home/u/repo", "user");
    db.session("20260803_2", "/home/u/repo", "user");
    let last_of_first = db.message("20260803_1", "user", &text("one"), T0);
    db.message("20260803_2", "user", &text("two"), T0 + 60);

    let ev = db.poll(last_of_first).events;
    let ends = of_type(&ev, "agent_end");
    assert_eq!(ends.len(), 1, "got {:?}", types(&ev));
    assert_eq!(ends[0]["session_id"], "20260803_1");
}

#[test]
fn a_hidden_session_never_produces_a_start_or_an_end() {
    let db = Db::new("hiddenbounds");
    db.session("20260803_1", "/home/u/repo", "hidden");
    db.session("20260803_2", "/home/u/repo", "user");
    db.message("20260803_1", "user", &text("scratch"), T0);
    db.message("20260803_2", "user", &text("real"), T0 + 1);

    let ev = db.poll(0).events;
    assert!(
        !ev.iter().any(|e| e["session_id"] == "20260803_1"),
        "{:?}",
        ev
    );
    assert_eq!(of_type(&ev, "agent_start").len(), 1);
}

// ── watermark, limits, determinism ───────────────────────────────────────

#[test]
fn the_watermark_advances_and_a_second_poll_ships_nothing() {
    let db = Db::new("watermark");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message("20260803_1", "user", &text("hi"), T0);
    let last = db.message("20260803_1", "assistant", &text("hello"), T0 + 1);

    let first = db.poll(0);
    assert!(!first.events.is_empty());
    assert_eq!(first.watermark, last);

    let second = db.poll(first.watermark);
    assert!(
        second.events.is_empty(),
        "a resumed poll must ship nothing: {:?}",
        types(&second.events)
    );
    assert_eq!(second.rows_seen, 0);
    assert!(!second.more);
    assert_eq!(second.watermark, first.watermark);
}

#[test]
fn hitting_the_row_limit_asks_the_engine_to_poll_again_immediately() {
    // A backlog should drain rather than trickle out one batch per interval.
    let db = Db::new("limit");
    db.session("20260803_1", "/home/u/repo", "user");
    for i in 0..5 {
        db.message("20260803_1", "user", &text(&format!("m{i}")), T0 + i);
    }

    let first = db.poll_limited(0, 2);
    assert_eq!(first.rows_seen, 2);
    assert!(first.more, "the limit was hit, so more rows are waiting");

    let mut watermark = first.watermark;
    let mut seen = first.rows_seen;
    let mut more = first.more;
    while more {
        let out = db.poll_limited(watermark, 2);
        watermark = out.watermark;
        seen += out.rows_seen;
        more = out.more;
    }
    assert_eq!(seen, 5, "the drain must reach the end exactly once");
}

#[test]
fn a_poll_that_reads_rows_and_emits_nothing_is_distinguishable_from_an_idle_one() {
    // `rows_seen` is what tells "goose is not running" apart from "goose is
    // running and we are dropping everything it writes".
    let db = Db::new("rowsseen");
    db.session("20260803_1", "/home/u/repo", "hidden");
    db.message("20260803_1", "user", &text("scratch"), T0);

    let out = db.poll(0);
    assert!(out.events.is_empty());
    assert_eq!(out.rows_seen, 1);
}

#[test]
fn re_reading_the_same_rows_produces_byte_identical_events() {
    // The engine's contract, and the whole basis of the server's content-hash
    // dedup: a crash between spooling and advancing the cursor must cost a
    // re-ship that collapses, not a duplicated session.
    let db = Db::new("determinism");
    db.session("20260803_1", "/home/u/repo", "user");
    db.session("20260803_2", "/home/u/repo", "user");
    db.message("20260803_1", "user", &text("hi"), T0);
    db.message(
        "20260803_1",
        "assistant",
        &tool_request("t1", "shell", "ls"),
        T0,
    );
    db.message("20260803_1", "user", &tool_response("t1", "total 4"), T0);
    db.message("20260803_2", "user", &text("next"), T0 + 60);

    let a = serde_json::to_string(&db.poll(0).events).unwrap();
    let b = serde_json::to_string(&db.poll(0).events).unwrap();
    assert_eq!(a, b);
}

#[test]
fn two_identical_rows_produce_different_events() {
    // The row id is the dedup discriminator. Without it the server collapses a
    // genuinely repeated turn — the same command run twice — into one row.
    let db = Db::new("dedup");
    db.session("20260803_1", "/home/u/repo", "user");
    let first = db.message("20260803_1", "user", &text("again"), T0);
    let second = db.message("20260803_1", "user", &text("again"), T0);

    let ev = db.poll(0).events;
    let requests = of_type(&ev, "model_request");
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["goose_row_id"], first);
    assert_eq!(requests[1]["goose_row_id"], second);
    assert_ne!(requests[0]["timestamp"], requests[1]["timestamp"]);
    assert_ne!(
        serde_json::to_string(requests[0]).unwrap(),
        serde_json::to_string(requests[1]).unwrap()
    );
}

// ── timestamps and usage ─────────────────────────────────────────────────

#[test]
fn whole_second_timestamps_render_with_six_sub_second_digits() {
    // Ingest parses one shape. goose stores seconds, the hook source emits
    // microseconds, and the two share a session timeline — a variable-precision
    // string sorts wrongly against the other stream.
    let db = Db::new("tsformat");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message("20260803_1", "user", &text("hi"), T0);

    let ev = db.poll(0).events;
    let ts = one(&ev, "model_request")["timestamp"].as_str().unwrap();
    assert!(ts.starts_with("2026-08-03T07:56:57."), "got {ts}");
    assert_eq!(ts.len(), "2026-08-03T07:56:57.000000Z".len(), "got {ts}");
    assert!(ts.ends_with('Z'));
}

#[test]
fn a_millisecond_timestamp_lands_on_the_same_wall_clock_as_a_second_one() {
    // The four SQLite agents disagree on units, so the engine infers them from
    // magnitude. A goose release that switched `created_timestamp` to
    // milliseconds would otherwise date every session to 1970.
    let db = Db::new("tsunits");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message("20260803_1", "user", &text("seconds"), T0);
    db.message("20260803_1", "user", &text("millis"), T0 * 1000);

    let ev = db.poll(0).events;
    let requests = of_type(&ev, "model_request");
    assert_eq!(requests.len(), 2);
    let day_and_second = |v: &Value| v["timestamp"].as_str().unwrap()[..19].to_string();
    assert_eq!(day_and_second(requests[0]), day_and_second(requests[1]));
    assert_eq!(day_and_second(requests[0]), "2026-08-03T07:56:57");
}

#[test]
fn an_unusable_timestamp_drops_the_row_rather_than_dating_it_to_1970() {
    // A 1970 event parks at the head of every timeline it appears on, which is
    // far more visible than one missing row — and the row still advances the
    // watermark, so the poller does not stall on it.
    let db = Db::new("badts");
    db.session("20260803_1", "/home/u/repo", "user");
    let bad = db.message("20260803_1", "user", &text("no time"), 0);

    let out = db.poll(0);
    assert!(out.events.is_empty(), "{:?}", types(&out.events));
    assert_eq!(out.watermark, bad);
}

#[test]
fn token_usage_comes_from_metadata_json_not_the_null_tokens_column() {
    // `messages.tokens` was NULL for every row of the live corpus; reading it
    // would report zero tokens for every session in the product.
    let db = Db::new("usage");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message_with_meta(
        "20260803_1",
        "assistant",
        &text("done"),
        T0,
        Some(
            r#"{"userVisible":true,"agentVisible":true,"usage":{"inputTokens":10165,
                "outputTokens":61,"totalTokens":10226,"cost":0.03141}}"#,
        ),
    );

    let ev = db.poll(0).events;
    let resp = one(&ev, "model_response");
    assert_eq!(resp["input_tokens"], 10165);
    assert_eq!(resp["output_tokens"], 61);
    assert_eq!(resp["goose_usage"]["totalTokens"], 10226);
}

#[test]
fn usage_is_billed_once_per_row_rather_than_once_per_block() {
    // The usage object belongs to the row, not to each block in it. Attaching
    // it per block multiplies a session's token total by its block count.
    let db = Db::new("usageonce");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message_with_meta(
        "20260803_1",
        "assistant",
        &json!([{"type":"text","text":"one"},{"type":"text","text":"two"}]),
        T0,
        Some(r#"{"usage":{"inputTokens":10,"outputTokens":2}}"#),
    );

    let ev = db.poll(0).events;
    let billed = ev
        .iter()
        .filter(|e| e.get("input_tokens").is_some())
        .count();
    assert_eq!(billed, 1, "usage must be billed to exactly one event");
}

// ── engine ───────────────────────────────────────────────────────────────

fn spec(db: &Path, spool: PathBuf, state: PathBuf) -> Spec {
    Spec {
        health_key: None,
        format: goose::FORMAT,
        db_path: db.to_path_buf(),
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(200),
        params: Params {
            redact: fpai_collect::Redact::Minimal,
            agent_id: goose::DEFAULT_AGENT_ID.into(),
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

async fn run_briefly(s: Spec, ms: u64) {
    let sd = Shutdown::for_test(Arc::new(AtomicBool::new(false)));
    let _ = tokio::time::timeout(Duration::from_millis(ms), sqlitepoll::run(s, sd)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_engine_spools_a_session_and_a_resumed_run_ships_nothing() {
    let db = Db::new("engine");
    db.session("20260803_1", "/home/u/repo", "user");
    db.session("20260803_2", "/home/u/repo", "user");
    db.message("20260803_1", "user", &text("list the files"), T0);
    db.message(
        "20260803_1",
        "assistant",
        &tool_request("t1", "shell", "ls"),
        T0 + 1,
    );
    db.message(
        "20260803_1",
        "user",
        &tool_response("t1", "total 4"),
        T0 + 2,
    );
    db.message("20260803_2", "user", &text("next session"), T0 + 60);

    let spool = tmpdir("engine-spool");
    let state = tmpdir("engine-state");

    run_briefly(spec(&db.path, spool.clone(), state.clone()), 1200).await;
    let ev = spooled(&spool);
    let kinds = types(&ev);
    for expected in [
        "agent_start",
        "model_request",
        "tool_use",
        "tool_result",
        "agent_end",
    ] {
        assert!(kinds.contains(&expected), "missing {expected} in {kinds:?}");
    }

    for e in fs::read_dir(&spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }
    // The cursor is durable, so a second run must not re-ship the history.
    run_briefly(spec(&db.path, spool.clone(), state.clone()), 800).await;
    assert!(
        spooled(&spool).is_empty(),
        "a resumed run must ship nothing: {:?}",
        types(&spooled(&spool))
    );

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn rows_appended_after_a_run_are_picked_up_without_re_shipping_the_history() {
    let db = Db::new("engine-append");
    db.session("20260803_1", "/home/u/repo", "user");
    db.message("20260803_1", "user", &text("first"), T0);

    let spool = tmpdir("append-spool");
    let state = tmpdir("append-state");
    run_briefly(spec(&db.path, spool.clone(), state.clone()), 1200).await;
    assert!(!spooled(&spool).is_empty());
    for e in fs::read_dir(&spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }

    db.message("20260803_1", "user", &text("second"), T0 + 30);
    run_briefly(spec(&db.path, spool.clone(), state.clone()), 1200).await;

    let ev = spooled(&spool);
    assert!(
        ev.iter().any(|e| e["messages"][0]["content"] == "second"),
        "the appended row must ship"
    );
    assert!(
        !ev.iter().any(|e| e["messages"][0]["content"] == "first"),
        "the earlier row must not be re-shipped"
    );

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_database_is_treated_as_goose_not_being_installed() {
    // The overwhelmingly common case on any given machine. It must not log an
    // error, retry storms, or take the supervisor's task down.
    let dir = tmpdir("absent");
    let spool = tmpdir("absent-spool");
    let state = tmpdir("absent-state");
    let missing = dir.join("sessions").join("sessions.db");

    run_briefly(spec(&missing, spool.clone(), state.clone()), 700).await;
    assert!(spooled(&spool).is_empty());

    fs::remove_dir_all(&dir).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[test]
fn the_format_reads_rows_by_id_and_is_registered_as_goose() {
    assert_eq!(goose::FORMAT.kind, "goose");
    assert_eq!(goose::FORMAT.watermark, Watermark::RowId);
}
