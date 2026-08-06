//! Devin source: transform correctness and engine behaviour.
//!
//! Every test builds a REAL SQLite database in WAL mode using the DDL Devin
//! itself ships (verified against devin v3000.1.27) and reads it back through the
//! same read-only connection the daemon uses. Record shapes are verbatim from a
//! live `~/.local/share/devin/cli/sessions.db`, whose `chat_message` is
//! OpenAI-style JSON and whose `message_nodes` table is a replay FOREST.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::sources::devin;
use fpai_collect::sqlitepoll::{self, Params, PollOutcome, PollRequest, Spec, Watermark};
use fpai_collect::supervisor::Shutdown;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

/// Devin's own DDL, copied from a live database. Kept verbatim — a paraphrased
/// schema is exactly how a source stops matching the product it reads.
const SCHEMA: &str = r#"
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    working_directory TEXT NOT NULL,
    backend_type TEXT NOT NULL,
    model TEXT NOT NULL,
    agent_mode TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    title TEXT,
    main_chain_id INTEGER,
    shell_last_seen_index INTEGER DEFAULT 0,
    cogs_json TEXT,
    workspace_dirs TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    metadata TEXT
);
CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL,
    parent_node_id INTEGER,
    chat_message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    metadata TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    UNIQUE(session_id, node_id)
);
"#;

/// A model on the session row — Devin carries it there, not per message.
const MODEL: &str = "claude-sonnet-4-6";

/// A second inside the live corpus, in epoch seconds (the `sessions.created_at`
/// and `message_nodes.created_at` column form).
const T0: i64 = 1_785_396_633;

/// The matching high-precision `metadata.created_at` (the replay-stable ISO time
/// carried inside `chat_message`).
const ISO0: &str = "2026-07-30T07:30:33.500577515Z";
const ISO1: &str = "2026-07-30T07:30:52.032008081Z";

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-dv-{}-{}-{}",
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

/// A writable Devin database, in WAL mode like the real one.
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

    fn session(&self, id: &str, working_directory: &str, hidden: i64, created_at: i64) -> &Self {
        self.conn
            .execute(
                "INSERT INTO sessions(id, working_directory, backend_type, model, agent_mode,
                                      created_at, last_activity_at, hidden)
                 VALUES (?1, ?2, 'anthropic', ?3, 'auto', ?4, ?4, ?5)",
                params![id, working_directory, MODEL, created_at, hidden],
            )
            .unwrap();
        self
    }

    /// Insert one `message_nodes` row and return its `row_id`.
    fn message(
        &self,
        session_id: &str,
        node_id: i64,
        parent: Option<i64>,
        chat_message: &Value,
        created_at: i64,
    ) -> i64 {
        self.conn
            .execute(
                "INSERT INTO message_nodes(session_id, node_id, parent_node_id, chat_message, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![session_id, node_id, parent, chat_message.to_string(), created_at],
            )
            .unwrap();
        self.conn.last_insert_rowid()
    }

    fn poll(&self, watermark: i64) -> PollOutcome {
        self.poll_limited(watermark, 1000)
    }

    fn poll_limited(&self, watermark: i64, max_rows: u64) -> PollOutcome {
        let conn = sqlitepoll::open_readonly(&self.path).unwrap();
        (devin::FORMAT.poll)(
            &conn,
            &PollRequest {
                watermark,
                max_rows,
                environment: "local".into(),
                agent_id: devin::DEFAULT_AGENT_ID.into(),
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

// ── the chat_message shapes, verbatim from a live database ────────────────

fn user_msg(mid: &str, iso: &str, text: &str) -> Value {
    json!({ "role": "user", "content": text, "message_id": mid,
            "metadata": { "created_at": iso, "is_user_input": true } })
}

fn assistant_text(mid: &str, iso: &str, text: &str) -> Value {
    json!({ "role": "assistant", "content": text, "thinking": "", "tool_calls": [],
            "message_id": mid, "model": MODEL, "metadata": { "created_at": iso } })
}

fn assistant_thinking(mid: &str, iso: &str, thinking: &str) -> Value {
    json!({ "role": "assistant", "content": "", "thinking": thinking, "tool_calls": [],
            "message_id": mid, "model": MODEL, "metadata": { "created_at": iso } })
}

fn assistant_call(mid: &str, iso: &str, call_id: &str, name: &str, args: Value) -> Value {
    json!({ "role": "assistant", "content": "", "thinking": "",
            "tool_calls": [{ "id": call_id, "name": name, "arguments": args, "index": 0 }],
            "message_id": mid, "model": MODEL, "metadata": { "created_at": iso } })
}

fn tool_result(mid: &str, iso: &str, call_id: &str, output: &str) -> Value {
    json!({ "role": "tool", "content": output, "tool_call_id": call_id,
            "message_id": mid, "metadata": { "created_at": iso } })
}

fn system_msg(mid: &str, iso: &str, text: &str) -> Value {
    json!({ "role": "system", "content": text, "message_id": mid,
            "metadata": { "created_at": iso } })
}

// ── assertion helpers ─────────────────────────────────────────────────────

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

// ── content-shape transforms ──────────────────────────────────────────────

#[test]
fn a_user_row_becomes_a_model_request_and_an_assistant_row_a_model_response() {
    let db = Db::new("text");
    db.session("estimated-seeker", "/home/u/repo", 0, T0);
    db.message(
        "estimated-seeker",
        0,
        None,
        &user_msg("m1", ISO0, "list the files"),
        T0,
    );
    db.message(
        "estimated-seeker",
        1,
        Some(0),
        &assistant_text("m2", ISO1, "Here they are."),
        T0,
    );

    let ev = db.poll(0).events;
    let req = one(&ev, "model_request");
    assert_eq!(req["messages"][0]["role"], "user");
    assert_eq!(req["messages"][0]["content"], "list the files");
    // Read off the session row: `chat_message` carries no per-message model, and
    // the server builds this row's summary from the model alone.
    assert_eq!(req["model"], MODEL);

    let resp = one(&ev, "model_response");
    assert_eq!(resp["role"], "assistant");
    assert_eq!(resp["content"], "Here they are.");
    assert_eq!(resp["model"], MODEL);
}

#[test]
fn an_assistant_tool_call_becomes_a_tool_use_carrying_its_arguments_object() {
    let db = Db::new("toolcall");
    db.session("s1", "/home/u/repo", 0, T0);
    db.message(
        "s1",
        0,
        None,
        &assistant_call(
            "m1",
            ISO0,
            "call_abc",
            "exec",
            json!({ "command": "ls -la" }),
        ),
        T0,
    );

    let ev = db.poll(0).events;
    let use_ = one(&ev, "tool_use");
    assert_eq!(use_["tool_name"], "exec");
    assert_eq!(use_["tool_call_id"], "call_abc");
    // `arguments` is already an OBJECT — shipped verbatim, not re-parsed.
    assert_eq!(use_["input"]["command"], "ls -la");
}

#[test]
fn a_tool_role_row_becomes_a_tool_result_named_from_the_call_it_answers() {
    // The name is on the assistant `tool_calls` entry and on NO result row.
    // Without carrying it, every result renders as a blank row in the product.
    let db = Db::new("toolresult");
    db.session("s1", "/home/u/repo", 0, T0);
    db.message(
        "s1",
        0,
        None,
        &assistant_call("m1", ISO0, "call_1", "exec", json!({ "command": "ls" })),
        T0,
    );
    db.message(
        "s1",
        1,
        Some(0),
        &tool_result("m2", ISO1, "call_1", "total 4"),
        T0,
    );

    let ev = db.poll(0).events;
    assert!(
        of_type(&ev, "model_request").is_empty(),
        "a tool result must not become a prompt: {:?}",
        types(&ev)
    );
    let result = one(&ev, "tool_result");
    assert_eq!(result["output"], "total 4");
    assert_eq!(result["tool_call_id"], "call_1");
    assert_eq!(result["tool_name"], "exec");
}

#[test]
fn a_result_whose_call_landed_in_an_earlier_poll_is_still_named() {
    // The call and its result are separate ROWS, so a poll boundary can fall
    // between them; the name is then recovered from the database.
    let db = Db::new("crossbatch");
    db.session("s1", "/home/u/repo", 0, T0);
    let call = db.message(
        "s1",
        0,
        None,
        &assistant_call("m1", ISO0, "call_1", "exec", json!({ "command": "ls" })),
        T0,
    );
    db.message(
        "s1",
        1,
        Some(0),
        &tool_result("m2", ISO1, "call_1", "total 4"),
        T0,
    );

    // Resume as if the previous poll had stopped right after the call row.
    let ev = db.poll(call).events;
    assert_eq!(
        one(&ev, "tool_result")["tool_name"],
        "exec",
        "the name must be recovered from the database"
    );
}

#[test]
fn an_assistant_thinking_field_becomes_a_marked_model_response() {
    let db = Db::new("thinking");
    db.session("s1", "/home/u/repo", 0, T0);
    db.message(
        "s1",
        0,
        None,
        &assistant_thinking("m1", ISO0, "weighing options"),
        T0,
    );

    let ev = db.poll(0).events;
    let resp = one(&ev, "model_response");
    assert_eq!(resp["content"], "weighing options");
    assert_eq!(resp["devin_thinking"], true);
}

#[test]
fn a_system_row_is_skipped_but_still_advances_the_watermark() {
    // `system` rows are the majority of the live corpus (context prompts); they
    // carry no timeline row, but must not stall the poller.
    let db = Db::new("system");
    db.session("s1", "/home/u/repo", 0, T0);
    let sys = db.message("s1", 0, None, &system_msg("m1", ISO0, "you are Devin"), T0);
    db.message("s1", 1, Some(0), &user_msg("m2", ISO1, "hi"), T0);

    let out = db.poll(0);
    // The user prompt is the only content the two rows produce.
    assert_eq!(of_type(&out.events, "model_request").len(), 1);
    assert_eq!(
        one(&out.events, "model_request")["messages"][0]["content"],
        "hi"
    );
    // The system row's content becomes no model/tool event. (Its row is `MIN`,
    // so it still rides an `agent_start` — a bare envelope, not its content.)
    let content = ["model_request", "model_response", "tool_use", "tool_result"];
    assert!(
        !out.events
            .iter()
            .any(|e| content.contains(&e["type"].as_str().unwrap_or(""))
                && e["devin_message_id"] == "m1"),
        "the system row's content must not reach the product"
    );
    assert!(out.watermark > sys, "the system row must be passed");
}

// ── the forest: replays collapse, distinct messages do not ────────────────

#[test]
fn replayed_rows_of_one_message_render_byte_identical_so_the_server_collapses_them() {
    // The forest gotcha. Devin replays each message under a fresh root, so ONE
    // message lands on several rows — with DIFFERENT row `created_at` values.
    // The events must still be byte-identical (keyed on the message id and the
    // message's own ISO time, never the row id or row column) or the server
    // keeps every copy.
    let db = Db::new("forest");
    db.session("s1", "/home/u/repo", 0, T0);
    db.message("s1", 0, None, &user_msg("mid-A", ISO0, "hello"), T0);
    // A replay under a fresh root, with a DIFFERENT row created_at (T0 + 9).
    db.message("s1", 1, None, &user_msg("mid-A", ISO0, "hello"), T0 + 9);

    let ev = db.poll(0).events;
    let reqs = of_type(&ev, "model_request");
    assert_eq!(reqs.len(), 2, "both rows are read and emitted");
    assert_eq!(
        serde_json::to_string(reqs[0]).unwrap(),
        serde_json::to_string(reqs[1]).unwrap(),
        "a replayed message must render identically so the server collapses it"
    );
    assert_eq!(reqs[0]["devin_message_id"], "mid-A");
}

#[test]
fn two_distinct_messages_that_share_text_and_time_stay_distinct() {
    // The inverse of the collapse: the message id is the discriminator, so two
    // genuinely different messages with identical text and time are preserved —
    // where goose's identical rows are also two real events.
    let db = Db::new("distinct");
    db.session("s1", "/home/u/repo", 0, T0);
    db.message("s1", 0, None, &user_msg("mid-A", ISO0, "again"), T0);
    db.message("s1", 1, Some(0), &user_msg("mid-B", ISO0, "again"), T0);

    let ev = db.poll(0).events;
    let reqs = of_type(&ev, "model_request");
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0]["timestamp"], reqs[1]["timestamp"], "same time");
    assert_ne!(
        reqs[0]["devin_message_id"], reqs[1]["devin_message_id"],
        "distinct messages keep distinct ids"
    );
    assert_ne!(
        serde_json::to_string(reqs[0]).unwrap(),
        serde_json::to_string(reqs[1]).unwrap()
    );
}

#[test]
fn several_blocks_of_one_message_are_distinguishable_and_ordered() {
    // An assistant turn with text AND a tool call is two events sharing one
    // message; the block index must distinguish and order them.
    let db = Db::new("multiblock");
    db.session("s1", "/home/u/repo", 0, T0);
    db.message(
        "s1",
        0,
        None,
        &json!({ "role": "assistant", "content": "Running it.", "thinking": "",
                 "tool_calls": [{ "id": "c1", "name": "exec", "arguments": { "command": "ls" } }],
                 "message_id": "m1", "model": MODEL, "metadata": { "created_at": ISO0 } }),
        T0,
    );

    let ev = db.poll(0).events;
    let resp = one(&ev, "model_response");
    let use_ = one(&ev, "tool_use");
    assert!(
        resp["timestamp"].as_str() < use_["timestamp"].as_str(),
        "the text must sort before the tool call it precedes"
    );
    assert_eq!(use_["devin_block_index"], 1);
}

// ── session identity and filtering ─────────────────────────────────────────

#[test]
fn the_agent_id_comes_from_the_sessions_working_directory() {
    let db = Db::new("agentid");
    db.session("s1", "/home/u/src/failproofai", 0, T0);
    db.message("s1", 0, None, &user_msg("m1", ISO0, "hi"), T0);

    let ev = db.poll(0).events;
    assert!(!ev.is_empty());
    for e in &ev {
        assert_eq!(e["agent_id"], "devin-failproofai");
        assert_eq!(e["environment"], "local");
        assert_eq!(e["session_id"], "s1");
    }
}

#[test]
fn a_message_whose_session_row_is_missing_still_ships() {
    // The foreign key is declared but SQLite does not enforce it unless
    // `PRAGMA foreign_keys` is on. A LEFT JOIN ships such a row under the
    // configured fallback agent instead of dropping it silently.
    let db = Db::new("orphan");
    db.conn.pragma_update(None, "foreign_keys", false).unwrap();
    db.conn
        .execute(
            "INSERT INTO message_nodes(session_id, node_id, chat_message, created_at)
             VALUES ('ghost', 0, ?1, ?2)",
            params![user_msg("m1", ISO0, "orphaned").to_string(), T0],
        )
        .unwrap();

    let ev = db.poll(0).events;
    assert_eq!(one(&ev, "model_request")["agent_id"], "devin");
}

#[test]
fn a_hidden_session_is_filtered_out_but_still_advances_the_watermark() {
    // `sessions.hidden != 0` is Devin's analog of goose's scratch sessions.
    // Filtering them without advancing past them would re-read them on every
    // poll for the life of the machine.
    let db = Db::new("hidden");
    db.session("s-hidden", "/home/u/repo", 1, T0);
    db.session("s-real", "/home/u/repo", 0, T0);
    let scratch = db.message("s-hidden", 0, None, &user_msg("m1", ISO0, "scratch"), T0);
    db.message("s-real", 0, None, &user_msg("m2", ISO1, "real run"), T0);

    let out = db.poll(0);
    assert!(
        !out.events.iter().any(|e| e["session_id"] == "s-hidden"),
        "a hidden session must not reach the product"
    );
    assert!(out.events.iter().any(|e| e["session_id"] == "s-real"));
    assert!(out.watermark > scratch, "the scratch row must be passed");
    assert_eq!(out.rows_seen, 2, "both rows were examined");
}

// ── session start ──────────────────────────────────────────────────────────

#[test]
fn a_session_starts_on_its_first_row_stamped_at_the_immutable_session_created_at() {
    let db = Db::new("start");
    db.session("s1", "/home/u/repo", 0, T0);
    db.message("s1", 0, None, &user_msg("m1", ISO0, "first goal"), T0);
    db.message("s1", 1, Some(0), &assistant_text("m2", ISO1, "done"), T0);

    let ev = db.poll(0).events;
    let start = one(&ev, "agent_start");
    assert_eq!(start["goal"], "first goal");
    assert_eq!(start["devin_working_dir"], "/home/u/repo");
    assert_eq!(start["model"], MODEL);
    // Stamped at `sessions.created_at` (epoch seconds → whole-second micros), not
    // the message's ISO time.
    assert!(
        start["timestamp"].as_str().unwrap().ends_with(".000000Z"),
        "got {}",
        start["timestamp"]
    );
    // Exactly one start, even though the session has several rows.
    assert_eq!(of_type(&ev, "agent_start").len(), 1);
}

#[test]
fn there_is_no_agent_end() {
    // Deliberate: neither `last_activity_at` (mutates) nor `MAX(row_id)` (a
    // replay under the forest) is a re-read-stable, correctly-timed anchor.
    let db = Db::new("noend");
    db.session("s1", "/home/u/repo", 0, T0);
    db.session("s2", "/home/u/repo", 0, T0);
    db.message("s1", 0, None, &user_msg("m1", ISO0, "one"), T0);
    db.message("s2", 0, None, &user_msg("m2", ISO1, "two"), T0);

    let ev = db.poll(0).events;
    assert!(of_type(&ev, "agent_end").is_empty(), "{:?}", types(&ev));
}

// ── timestamps ─────────────────────────────────────────────────────────────

#[test]
fn the_timestamp_is_the_messages_own_iso_rendered_with_six_micro_digits() {
    // Ingest parses one shape; the ISO's nanoseconds are truncated to micros so
    // this stream sorts against the hook stream on a shared timeline.
    let db = Db::new("tsiso");
    db.session("s1", "/home/u/repo", 0, T0);
    // A row created_at far from the ISO time, to prove the ISO wins.
    db.message("s1", 0, None, &user_msg("m1", ISO0, "hi"), T0 + 500);

    let ev = db.poll(0).events;
    let ts = one(&ev, "model_request")["timestamp"].as_str().unwrap();
    assert_eq!(ts, "2026-07-30T07:30:33.500577Z");
}

#[test]
fn a_message_without_a_metadata_time_falls_back_to_the_row_column() {
    let db = Db::new("tsfallback");
    db.session("s1", "/home/u/repo", 0, T0);
    db.message(
        "s1",
        0,
        None,
        &json!({ "role": "user", "content": "hi", "message_id": "m1", "metadata": {} }),
        T0,
    );

    let ev = db.poll(0).events;
    let ts = one(&ev, "model_request")["timestamp"].as_str().unwrap();
    assert!(
        ts.ends_with(".000000Z"),
        "row seconds → zero micros, got {ts}"
    );
    assert!(ts.starts_with("2026-07-30T"), "got {ts}");
}

// ── watermark, limits, determinism ─────────────────────────────────────────

#[test]
fn the_watermark_advances_and_a_second_poll_ships_nothing() {
    let db = Db::new("watermark");
    db.session("s1", "/home/u/repo", 0, T0);
    db.message("s1", 0, None, &user_msg("m1", ISO0, "hi"), T0);
    let last = db.message("s1", 1, Some(0), &assistant_text("m2", ISO1, "hello"), T0);

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
    let db = Db::new("limit");
    db.session("s1", "/home/u/repo", 0, T0);
    for i in 0..5 {
        db.message(
            "s1",
            i,
            Some(0),
            &user_msg(&format!("m{i}"), ISO0, &format!("m{i}")),
            T0,
        );
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
fn re_reading_the_same_rows_produces_byte_identical_events() {
    // The engine's contract: a crash between spooling and advancing the cursor
    // must cost a re-ship that collapses, not a duplicated session.
    let db = Db::new("determinism");
    db.session("s1", "/home/u/repo", 0, T0);
    db.message("s1", 0, None, &user_msg("m1", ISO0, "hi"), T0);
    db.message(
        "s1",
        1,
        Some(0),
        &assistant_call("m2", ISO1, "c1", "exec", json!({ "command": "ls" })),
        T0,
    );
    db.message(
        "s1",
        2,
        Some(1),
        &tool_result("m3", ISO1, "c1", "total 4"),
        T0,
    );

    let a = serde_json::to_string(&db.poll(0).events).unwrap();
    let b = serde_json::to_string(&db.poll(0).events).unwrap();
    assert_eq!(a, b);
}

// ── engine ─────────────────────────────────────────────────────────────────

fn spec(db: &Path, spool: PathBuf, state: PathBuf) -> Spec {
    Spec {
        health_key: None,
        format: devin::FORMAT,
        db_path: db.to_path_buf(),
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(200),
        params: Params {
            redact: fpai_collect::Redact::Minimal,
            agent_id: devin::DEFAULT_AGENT_ID.into(),
            environment: "local".into(),
            machine_id: None,
            user: None,
            max_rows_per_poll: 500,
            max_batch_bytes: 8 * 1024 * 1024,
            max_drain_passes: 8,
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
    db.session("s1", "/home/u/repo", 0, T0);
    db.message("s1", 0, None, &user_msg("m1", ISO0, "list the files"), T0);
    db.message(
        "s1",
        1,
        Some(0),
        &assistant_call("m2", ISO1, "c1", "exec", json!({ "command": "ls" })),
        T0,
    );
    db.message(
        "s1",
        2,
        Some(1),
        &tool_result("m3", ISO1, "c1", "total 4"),
        T0,
    );

    let spool = tmpdir("engine-spool");
    let state = tmpdir("engine-state");

    run_briefly(spec(&db.path, spool.clone(), state.clone()), 1200).await;
    let ev = spooled(&spool);
    let kinds = types(&ev);
    for expected in ["agent_start", "model_request", "tool_use", "tool_result"] {
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
    db.session("s1", "/home/u/repo", 0, T0);
    db.message("s1", 0, None, &user_msg("m1", ISO0, "first"), T0);

    let spool = tmpdir("append-spool");
    let state = tmpdir("append-state");
    run_briefly(spec(&db.path, spool.clone(), state.clone()), 1200).await;
    assert!(!spooled(&spool).is_empty());
    for e in fs::read_dir(&spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }

    db.message("s1", 1, Some(0), &user_msg("m2", ISO1, "second"), T0);
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
async fn a_missing_database_is_treated_as_devin_not_being_installed() {
    // The overwhelmingly common case on any given machine. It must not log an
    // error, retry storm, or take the supervisor's task down.
    let dir = tmpdir("absent");
    let spool = tmpdir("absent-spool");
    let state = tmpdir("absent-state");
    let missing = dir.join("cli").join("sessions.db");

    run_briefly(spec(&missing, spool.clone(), state.clone()), 700).await;
    assert!(spooled(&spool).is_empty());

    fs::remove_dir_all(&dir).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[test]
fn the_format_reads_rows_by_id_and_is_registered_as_devin() {
    assert_eq!(devin::FORMAT.kind, "devin");
    assert_eq!(devin::FORMAT.watermark, Watermark::RowId);
}
