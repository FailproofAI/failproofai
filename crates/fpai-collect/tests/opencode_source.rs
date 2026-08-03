//! opencode source: transform correctness and poll behaviour, against REAL
//! SQLite databases.
//!
//! Nothing here is a hand-shaped fixture. [`SCHEMA`] is the verbatim DDL of a
//! live `~/.local/share/opencode/opencode.db` (opencode 1.18.11), including
//! `session_message` — the dead legacy table this source must never read — and
//! the `part.data` / `message.data` payloads, ids and epoch-millisecond
//! timestamps are copied from real rows of that capture.
//!
//! The headline is [`a_part_that_mutates_from_running_to_completed_is_re_read`]:
//! opencode fills a tool call's result into the SAME row ~12 seconds after it
//! appears, so that test replays the observed mutation and asserts both that
//! the result ships and that a rowid watermark would have had nothing to hand
//! back.
//!
//! Databases are created in WAL mode and read through
//! [`sqlitepoll::open_readonly`], which is exactly the pairing production uses.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fpai_collect::sources::opencode::{self, transform};
use fpai_collect::sqlitepoll::{self, PollOutcome, PollRequest, Watermark};
use rusqlite::Connection;
use serde_json::{Value, json};

/// Verbatim DDL from the capture, minus the tables this source never reads
/// (`account*`, `credential`, `event*`, `permission`, `todo`, `workspace`, …).
///
/// `session_message` is kept deliberately: it is named exactly like the table
/// this source wants, it is permanently empty, and four shipped migrations
/// `DELETE FROM` it. A poller that reached for it by name would read nothing
/// and report success forever.
const SCHEMA: &str = r#"
CREATE TABLE `project` (
  `id` text PRIMARY KEY,
  `worktree` text NOT NULL,
  `vcs` text,
  `name` text,
  `icon_url` text,
  `icon_url_override` text,
  `icon_color` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_initialized` integer,
  `sandboxes` text NOT NULL,
  `commands` text
);
CREATE TABLE `session` (
  `id` text PRIMARY KEY,
  `project_id` text NOT NULL,
  `workspace_id` text,
  `parent_id` text,
  `slug` text NOT NULL,
  `directory` text NOT NULL,
  `path` text,
  `title` text NOT NULL,
  `version` text NOT NULL,
  `share_url` text,
  `summary_additions` integer,
  `summary_deletions` integer,
  `summary_files` integer,
  `summary_diffs` text,
  `metadata` text,
  `cost` real DEFAULT 0 NOT NULL,
  `tokens_input` integer DEFAULT 0 NOT NULL,
  `tokens_output` integer DEFAULT 0 NOT NULL,
  `tokens_reasoning` integer DEFAULT 0 NOT NULL,
  `tokens_cache_read` integer DEFAULT 0 NOT NULL,
  `tokens_cache_write` integer DEFAULT 0 NOT NULL,
  `revert` text,
  `permission` text,
  `agent` text,
  `model` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_compacting` integer,
  `time_archived` integer,
  CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
CREATE INDEX `session_project_idx` ON `session` (`project_id`);
CREATE TABLE `message` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL,
  CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);
CREATE TABLE `part` (
  `id` text PRIMARY KEY,
  `message_id` text NOT NULL,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL,
  CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);
CREATE INDEX `part_session_idx` ON `part` (`session_id`);
CREATE TABLE `session_message` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `type` text NOT NULL,
  `seq` integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL,
  CONSTRAINT `fk_session_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
"#;

// Real ids and directories from the capture.
const SESSION: &str = "ses_0395f98c4ffe9Axu1kXPL9lnVR";
const DIRECTORY: &str = "/tmp/probe-opencode";
const AGENT: &str = "opencode-probe-opencode";
const USER_MSG: &str = "msg_fc6ab275b001QFpPqoEGCunJ50";
const ASSISTANT_MSG: &str = "msg_fc6ab29a1001XwwrJYstY20PH0";
const TOOL_PART: &str = "prt_fc6ab3d28001jvAlnWvL07p0le";
const CALL_ID: &str = "toolu_bdrk_016VM3PbpoehGTXrHGuRo4jG";
const MODEL: &str = "claude-sonnet-4-6";

// The observed lifetime of the 12-second tool call, to the millisecond.
const PROMPT_MS: i64 = 1_785_744_533_339;
const TOOL_CREATED_MS: i64 = 1_785_744_538_920;
const TOOL_RUNNING_MS: i64 = 1_785_744_539_061;
const TOOL_DONE_MS: i64 = 1_785_744_551_135;

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-oc-{}-{}-{}",
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

/// A writable WAL database carrying the real schema — the shape production
/// reads, not a simplification of it.
fn make_db(dir: &Path) -> (PathBuf, Connection) {
    let path = dir.join("opencode.db");
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute(
        "INSERT INTO project VALUES ('global','/',NULL,NULL,NULL,NULL,NULL,1,1,NULL,'[]',NULL)",
        [],
    )
    .unwrap();
    (path, conn)
}

/// `path` is passed explicitly on purpose: it is the column that must never be
/// used, so every test states what misleading value it holds.
fn insert_session(conn: &Connection, id: &str, directory: &str, path: &str, tc: i64, tu: i64) {
    conn.execute(
        "INSERT INTO session (id, project_id, slug, directory, path, title, version, \
         cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, \
         tokens_cache_write, time_created, time_updated) \
         VALUES (?1,'global','clever-nebula',?2,?3,'Directory files & README review','1.18.11', \
         0, 13, 431, 0, 75048, 30323, ?4, ?5)",
        rusqlite::params![id, directory, path, tc, tu],
    )
    .unwrap();
}

fn touch_session(conn: &Connection, id: &str, tu: i64) {
    conn.execute(
        "UPDATE session SET time_updated = ?2 WHERE id = ?1",
        rusqlite::params![id, tu],
    )
    .unwrap();
}

fn insert_message(conn: &Connection, id: &str, session: &str, tc: i64, tu: i64, data: &Value) {
    conn.execute(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) \
         VALUES (?1,?2,?3,?4,?5)",
        rusqlite::params![id, session, tc, tu, data.to_string()],
    )
    .unwrap();
}

/// Verbatim user-message metadata: note the NESTED `model` object, which is a
/// different shape from an assistant message's flat `modelID`.
fn user_message(conn: &Connection, id: &str, session: &str, tc: i64) {
    insert_message(
        conn,
        id,
        session,
        tc,
        tc,
        &json!({"role":"user","time":{"created":tc},"agent":"build",
                "model":{"providerID":"aikin","modelID":MODEL},"summary":{"diffs":[]}}),
    );
}

fn assistant_message(conn: &Connection, id: &str, session: &str, tc: i64, finish: Option<&str>) {
    let mut data = json!({"parentID":USER_MSG,"role":"assistant","mode":"build","agent":"build",
        "path":{"cwd":DIRECTORY,"root":"/"},"cost":0,
        "tokens":{"total":15334,"input":3,"output":79,"reasoning":0,
                  "cache":{"write":45,"read":15207}},
        "modelID":MODEL,"providerID":"aikin","time":{"created":tc}});
    if let Some(f) = finish {
        data["finish"] = json!(f);
    }
    insert_message(conn, id, session, tc, tc, &data);
}

fn insert_part(
    conn: &Connection,
    id: &str,
    message: &str,
    session: &str,
    tc: i64,
    tu: i64,
    data: &Value,
) {
    conn.execute(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) \
         VALUES (?1,?2,?3,?4,?5,?6)",
        rusqlite::params![id, message, session, tc, tu, data.to_string()],
    )
    .unwrap();
}

/// The UPDATE opencode issues when a tool finishes: same row, new `data`, new
/// `time_updated`.
fn update_part(conn: &Connection, id: &str, tu: i64, data: &Value) {
    let n = conn
        .execute(
            "UPDATE part SET time_updated = ?2, data = ?3 WHERE id = ?1",
            rusqlite::params![id, tu, data.to_string()],
        )
        .unwrap();
    assert_eq!(n, 1, "the mutation must hit exactly the row under test");
}

fn rowid_of(conn: &Connection, id: &str) -> i64 {
    conn.query_row("SELECT rowid FROM part WHERE id = ?1", [id], |r| r.get(0))
        .unwrap()
}

fn text_part(text: &str) -> Value {
    json!({"type":"text","text":text})
}

/// An assistant text part, which unlike a user's carries streaming timings.
fn streamed_text_part(text: &str, start: i64, end: Option<i64>) -> Value {
    let mut time = json!({ "start": start });
    if let Some(e) = end {
        time["end"] = json!(e);
    }
    json!({"type":"text","text":text,"time":time})
}

fn running_tool_part() -> Value {
    json!({"type":"tool","tool":"bash","callID":CALL_ID,
      "state":{"status":"running",
        "input":{"command":"sleep 12 && echo SECOND_MARKER","timeout":20000},
        "time":{"start":TOOL_CREATED_MS}}})
}

fn completed_tool_part() -> Value {
    json!({"type":"tool","tool":"bash","callID":CALL_ID,
      "state":{"status":"completed",
        "input":{"command":"sleep 12 && echo SECOND_MARKER","timeout":20000},
        "output":"SECOND_MARKER\n",
        "metadata":{"output":"SECOND_MARKER\n","exit":0,"truncated":false},
        "title":"sleep 12 && echo SECOND_MARKER",
        "time":{"start":TOOL_CREATED_MS,"end":TOOL_DONE_MS - 1}}})
}

fn poll_at(db: &Path, watermark: i64, max_rows: u64) -> PollOutcome {
    let conn = sqlitepoll::open_readonly(db).unwrap();
    let req = PollRequest {
        watermark,
        max_rows,
        environment: "local".into(),
        agent_id: opencode::DEFAULT_AGENT_ID.into(),
    };
    (opencode::FORMAT.poll)(&conn, &req).unwrap()
}

fn poll_all(db: &Path) -> Vec<Value> {
    poll_at(db, 0, 1000).events
}

fn of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == kind).collect()
}

/// A session with one finished turn: prompt, assistant answer, nothing pending.
fn seed_turn(conn: &Connection) {
    insert_session(
        conn,
        SESSION,
        DIRECTORY,
        "tmp/probe-opencode",
        PROMPT_MS - 1,
        PROMPT_MS + 10,
    );
    user_message(conn, USER_MSG, SESSION, PROMPT_MS);
    insert_part(
        conn,
        "prt_user_text",
        USER_MSG,
        SESSION,
        PROMPT_MS,
        PROMPT_MS,
        &text_part("List the files in this directory"),
    );
    assistant_message(conn, ASSISTANT_MSG, SESSION, PROMPT_MS + 5, Some("stop"));
    insert_part(
        conn,
        "prt_assistant_text",
        ASSISTANT_MSG,
        SESSION,
        PROMPT_MS + 5,
        PROMPT_MS + 10,
        &streamed_text_part(
            "calc.py, opencode.json, README.md",
            PROMPT_MS + 5,
            Some(PROMPT_MS + 9),
        ),
    );
}

// ── the mutation this whole source exists for ────────────────────────────

#[test]
fn a_part_that_mutates_from_running_to_completed_is_re_read() {
    // Replays the observed lifetime of rowid 20: NEW at status=running with an
    // empty output, then UPDATEd in place 12.0s later with the real result.
    let dir = tmpdir("mutate");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    assistant_message(
        &conn,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        Some("tool-calls"),
    );
    insert_part(
        &conn,
        TOOL_PART,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        TOOL_RUNNING_MS,
        &running_tool_part(),
    );
    touch_session(&conn, SESSION, TOOL_RUNNING_MS);

    let first = poll_at(&db, 0, 1000);
    let first_call = of_type(&first.events, "tool_use");
    assert_eq!(
        first_call.len(),
        1,
        "the call is known as soon as it starts"
    );
    assert!(
        of_type(&first.events, "tool_result").is_empty(),
        "the result does not exist yet — state.output is empty while running"
    );
    let call_before = first_call[0].clone();
    let watermark = first.watermark;

    // What a rowid watermark would have to work with.
    let rowid_before = rowid_of(&conn, TOOL_PART);
    let max_rowid: i64 = conn
        .query_row("SELECT max(rowid) FROM part", [], |r| r.get(0))
        .unwrap();

    update_part(&conn, TOOL_PART, TOOL_DONE_MS, &completed_tool_part());

    assert_eq!(
        rowid_of(&conn, TOOL_PART),
        rowid_before,
        "opencode UPDATEs the row in place; its rowid never moves"
    );
    let appended: i64 = conn
        .query_row(
            "SELECT count(*) FROM part WHERE rowid > ?1",
            [max_rowid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        appended, 0,
        "a rowid watermark has nothing new to hand back — every tool call in \
         this product would ship with an empty result, forever, while looking \
         like it works"
    );

    let second = poll_at(&db, watermark, 1000);
    let results = of_type(&second.events, "tool_result");
    assert_eq!(
        results.len(),
        1,
        "the updated-at watermark re-reads the row"
    );
    assert_eq!(results[0]["output"], "SECOND_MARKER\n");
    assert_eq!(results[0]["tool_call_id"], CALL_ID);
    assert_eq!(results[0]["tool_name"], "bash");

    // The re-read also re-emits the call. It must be byte-identical, or the
    // server's content dedup cannot collapse it and every completed tool
    // leaves two calls on the timeline.
    let call_after = of_type(&second.events, "tool_use");
    assert_eq!(call_after.len(), 1);
    assert_eq!(
        serde_json::to_string(call_after[0]).unwrap(),
        serde_json::to_string(&call_before).unwrap(),
        "a re-read call must hash the same as the first read"
    );

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_running_tool_part_yields_only_the_call() {
    // The result is not merely missing from our output — it does not exist.
    let dir = tmpdir("running");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    assistant_message(
        &conn,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        Some("tool-calls"),
    );
    insert_part(
        &conn,
        TOOL_PART,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        TOOL_RUNNING_MS,
        &running_tool_part(),
    );

    let ev = poll_all(&db);
    assert_eq!(of_type(&ev, "tool_use").len(), 1);
    assert!(of_type(&ev, "tool_result").is_empty());
    // The call is complete even so: a running tool's input is already parsed.
    assert_eq!(
        of_type(&ev, "tool_use")[0]["input"]["command"],
        "sleep 12 && echo SECOND_MARKER"
    );

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn one_completed_tool_row_yields_the_call_and_its_result_in_order() {
    // Call and result share ONE row — opencode never writes a second one — so
    // both events come from the same read, and the index offset keeps them in
    // order even when a tool finishes inside the millisecond it started.
    let dir = tmpdir("bothlegs");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    assistant_message(
        &conn,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        Some("tool-calls"),
    );
    let instant = json!({"type":"tool","tool":"bash","callID":CALL_ID,
      "state":{"status":"completed","input":{"command":"echo hi"},"output":"hi\n",
               "time":{"start":TOOL_CREATED_MS,"end":TOOL_CREATED_MS}}});
    insert_part(
        &conn,
        TOOL_PART,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        TOOL_CREATED_MS,
        &instant,
    );

    let ev = poll_all(&db);
    let call = of_type(&ev, "tool_use")[0];
    let result = of_type(&ev, "tool_result")[0];
    assert!(
        call["timestamp"].as_str().unwrap() < result["timestamp"].as_str().unwrap(),
        "a result that sorted before its own call is visibly wrong on a timeline"
    );
    assert_eq!(call["timestamp"], "2026-08-03T08:08:58.920000Z");
    assert_eq!(result["timestamp"], "2026-08-03T08:08:58.920001Z");
    assert_eq!(result["opencode_block_index"], 1);
    assert_eq!(call["opencode_part_id"], TOOL_PART);
    assert_eq!(result["opencode_part_id"], TOOL_PART);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_errored_tool_row_carries_a_non_empty_error() {
    let dir = tmpdir("toolerr");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    assistant_message(
        &conn,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        Some("tool-calls"),
    );
    let failed = json!({"type":"tool","tool":"bash","callID":CALL_ID,
      "state":{"status":"error","input":{"command":"false"},
               "error":"Command failed with exit code 1",
               "time":{"start":TOOL_CREATED_MS,"end":TOOL_DONE_MS}}});
    insert_part(
        &conn,
        TOOL_PART,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        TOOL_DONE_MS,
        &failed,
    );

    let ev = poll_all(&db);
    let result = of_type(&ev, "tool_result")[0];
    assert_eq!(result["error"], "Command failed with exit code 1");
    assert_eq!(result["error_type"], "opencode_tool_error");
    assert_eq!(
        result["output"], "Command failed with exit code 1",
        "an errored tool has no output; the message is the whole result"
    );
    assert_eq!(result["opencode_tool_status"], "error");

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_pending_tool_row_reports_nothing_until_its_input_exists() {
    // `pending` is the call before its arguments have finished streaming.
    // Shipping it would put a blank call in the product, and the row comes
    // back the moment it moves to `running`.
    let dir = tmpdir("pending");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    assistant_message(
        &conn,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        Some("tool-calls"),
    );
    insert_part(
        &conn,
        TOOL_PART,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        TOOL_CREATED_MS,
        &json!({"type":"tool","tool":"bash","callID":CALL_ID,"state":{"status":"pending"}}),
    );

    let ev = poll_all(&db);
    assert!(of_type(&ev, "tool_use").is_empty());

    update_part(&conn, TOOL_PART, TOOL_RUNNING_MS, &running_tool_part());
    let ev = poll_all(&db);
    assert_eq!(
        of_type(&ev, "tool_use").len(),
        1,
        "it ships once it is real"
    );

    fs::remove_dir_all(&dir).ok();
}

// ── text parts ───────────────────────────────────────────────────────────

#[test]
fn a_user_part_becomes_a_request_and_an_assistant_part_a_response() {
    // A part carries no role at all — it comes from the joined message row.
    let dir = tmpdir("roles");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);

    let ev = poll_all(&db);
    let req = of_type(&ev, "model_request");
    let resp = of_type(&ev, "model_response");
    assert_eq!(req.len(), 1);
    assert_eq!(resp.len(), 1);
    assert_eq!(
        req[0]["messages"][0]["content"],
        "List the files in this directory"
    );
    assert_eq!(req[0]["messages"][0]["role"], "user");
    assert_eq!(req[0]["opencode_cwd"], DIRECTORY);
    // The model comes from the user message's NESTED `model` object; the
    // assistant's from its flat `modelID`. Both must resolve or half the rows
    // render as an empty summary.
    assert_eq!(req[0]["model"], MODEL);
    assert_eq!(resp[0]["model"], MODEL);
    assert_eq!(resp[0]["content"], "calc.py, opencode.json, README.md");
    assert_eq!(resp[0]["role"], "assistant");
    assert_eq!(resp[0]["opencode_provider"], "aikin");
    assert_eq!(resp[0]["opencode_message_id"], ASSISTANT_MSG);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_still_streaming_text_part_is_withheld_until_it_settles() {
    // An assistant text part is written empty and grown token by token. Without
    // the `time.end` gate, one poll per few seconds of a long answer leaves a
    // row per poll in the product, each a longer prefix of the same text.
    let dir = tmpdir("streaming");
    let (db, conn) = make_db(&dir);
    insert_session(&conn, SESSION, DIRECTORY, "", PROMPT_MS - 1, PROMPT_MS);
    user_message(&conn, USER_MSG, SESSION, PROMPT_MS);
    insert_part(
        &conn,
        "prt_u",
        USER_MSG,
        SESSION,
        PROMPT_MS,
        PROMPT_MS,
        &text_part("go"),
    );
    assistant_message(&conn, ASSISTANT_MSG, SESSION, PROMPT_MS + 5, None);
    insert_part(
        &conn,
        "prt_stream",
        ASSISTANT_MSG,
        SESSION,
        PROMPT_MS + 5,
        PROMPT_MS + 6,
        &streamed_text_part("The comm", PROMPT_MS + 5, None),
    );

    let first = poll_at(&db, 0, 1000);
    assert!(
        of_type(&first.events, "model_response").is_empty(),
        "a half-written answer must not ship"
    );
    // A user prompt has no `time` object at all and is settled on arrival.
    assert_eq!(of_type(&first.events, "model_request").len(), 1);

    update_part(
        &conn,
        "prt_stream",
        PROMPT_MS + 40,
        &streamed_text_part(
            "The command completed successfully.",
            PROMPT_MS + 5,
            Some(PROMPT_MS + 39),
        ),
    );
    let second = poll_at(&db, first.watermark, 1000);
    assert_eq!(
        of_type(&second.events, "model_response")[0]["content"],
        "The command completed successfully."
    );

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn step_and_unknown_part_types_emit_nothing() {
    // `step-start`/`step-finish` bracket every single turn — they outnumber
    // content parts on the real capture 10:24. An unknown future type must be
    // ignored the same way rather than breaking the poll.
    let dir = tmpdir("steps");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    insert_part(
        &conn,
        "prt_ss",
        ASSISTANT_MSG,
        SESSION,
        PROMPT_MS + 11,
        PROMPT_MS + 11,
        &json!({"type":"step-start"}),
    );
    insert_part(
        &conn,
        "prt_sf",
        ASSISTANT_MSG,
        SESSION,
        PROMPT_MS + 12,
        PROMPT_MS + 12,
        &json!({"type":"step-finish","reason":"stop","tokens":{"total":15373},"cost":0}),
    );
    insert_part(
        &conn,
        "prt_future",
        ASSISTANT_MSG,
        SESSION,
        PROMPT_MS + 13,
        PROMPT_MS + 13,
        &json!({"type":"some-future-type","payload":{}}),
    );

    let out = poll_at(&db, 0, 1000);
    assert_eq!(out.rows_seen, 6, "the rows are read");
    assert_eq!(
        out.events
            .iter()
            .filter(|e| e["type"] == "model_request" || e["type"] == "model_response")
            .count(),
        2,
        "…and only the two content parts become events"
    );

    fs::remove_dir_all(&dir).ok();
}

// ── agent id: directory, never path ──────────────────────────────────────

#[test]
fn the_agent_id_comes_from_the_directory_and_never_from_path() {
    // `session.path` is relative to a git worktree and is the EMPTY STRING at
    // the repository root — the case that matters most. Here it holds a value
    // that would produce a plausible-looking wrong answer.
    let dir = tmpdir("agentid");
    let (db, conn) = make_db(&dir);
    insert_session(
        &conn,
        SESSION,
        "/home/u/failproofai",
        "some/other/worktree/leaf",
        PROMPT_MS - 1,
        PROMPT_MS + 10,
    );
    user_message(&conn, USER_MSG, SESSION, PROMPT_MS);
    insert_part(
        &conn,
        "prt_u",
        USER_MSG,
        SESSION,
        PROMPT_MS,
        PROMPT_MS,
        &text_part("hi"),
    );

    let ev = poll_all(&db);
    assert!(!ev.is_empty());
    for e in &ev {
        assert_eq!(e["agent_id"], "opencode-failproofai");
    }
    let dumped = serde_json::to_string(&ev).unwrap();
    assert!(
        !dumped.contains("worktree"),
        "session.path must not reach the event stream at all"
    );

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_empty_path_at_a_git_root_still_resolves_the_project() {
    // The exact live observation: a session started at a git worktree root has
    // `path = ""`. Anything deriving the project from it produces nothing.
    let dir = tmpdir("gitroot");
    let (db, conn) = make_db(&dir);
    insert_session(
        &conn,
        SESSION,
        "/tmp/probe-opencode-git",
        "",
        PROMPT_MS - 1,
        PROMPT_MS + 10,
    );
    user_message(&conn, USER_MSG, SESSION, PROMPT_MS);
    insert_part(
        &conn,
        "prt_u",
        USER_MSG,
        SESSION,
        PROMPT_MS,
        PROMPT_MS,
        &text_part("GITPROBE"),
    );

    assert_eq!(poll_all(&db)[0]["agent_id"], "opencode-probe-opencode-git");

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_directory_with_no_usable_project_falls_back_to_the_configured_id() {
    let dir = tmpdir("rootdir");
    let (db, conn) = make_db(&dir);
    insert_session(&conn, SESSION, "/", "", PROMPT_MS - 1, PROMPT_MS + 10);
    user_message(&conn, USER_MSG, SESSION, PROMPT_MS);
    insert_part(
        &conn,
        "prt_u",
        USER_MSG,
        SESSION,
        PROMPT_MS,
        PROMPT_MS,
        &text_part("hi"),
    );

    assert_eq!(poll_all(&db)[0]["agent_id"], opencode::DEFAULT_AGENT_ID);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_agent_id_is_sanitized_the_same_way_claudes_is() {
    // The two run over the same project directories on the same machine; a
    // project that sanitized differently under each would appear as two
    // unrelated agents.
    assert_eq!(transform::sanitize_id_part("my project!"), "my-project");
    assert_eq!(transform::sanitize_id_part("--a--b--"), "a-b");
    assert_eq!(
        transform::sanitize_id_part("keep.dots_and_underscores"),
        "keep.dots_and_underscores"
    );
    assert_eq!(transform::sanitize_id_part(&"x".repeat(80)).len(), 48);
    assert_eq!(
        transform::agent_id_from_directory("/home/u/repo/"),
        Some("opencode-repo".to_string())
    );
    assert_eq!(transform::agent_id_from_directory("/"), None);
    assert_eq!(transform::agent_id_from_directory(""), None);
}

// ── session bracketing ───────────────────────────────────────────────────

#[test]
fn a_finished_session_is_bracketed_by_a_start_and_an_end() {
    let dir = tmpdir("bracket");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);

    let ev = poll_all(&db);
    let start = of_type(&ev, "agent_start");
    let end = of_type(&ev, "agent_end");
    assert_eq!(start.len(), 1);
    assert_eq!(end.len(), 1);
    assert_eq!(start[0]["goal"], "List the files in this directory");
    assert_eq!(start[0]["opencode_cwd"], DIRECTORY);
    assert_eq!(start[0]["opencode_version"], "1.18.11");
    assert_eq!(start[0]["opencode_slug"], "clever-nebula");
    assert_eq!(start[0]["opencode_part_id"], SESSION);
    // Session totals, namespaced: a consumer that summed generic
    // `input_tokens` across events would count every turn once per end.
    assert_eq!(end[0]["opencode_tokens"]["input"], 13);
    assert_eq!(end[0]["opencode_tokens"]["cache_read"], 75048);
    assert!(end[0].get("input_tokens").is_none());
    assert!(
        start[0]["timestamp"].as_str().unwrap() < end[0]["timestamp"].as_str().unwrap(),
        "the start must precede the end"
    );
    // Index 999 puts the end after content sharing its millisecond.
    assert!(end[0]["timestamp"].as_str().unwrap().ends_with("999Z"));

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_session_mid_turn_gets_a_start_but_no_end() {
    // `finish:"tool-calls"` means the assistant stopped only to run tools and
    // another message is coming. Ending the session there would show it as
    // over while it is still working.
    let dir = tmpdir("midturn");
    let (db, conn) = make_db(&dir);
    insert_session(
        &conn,
        SESSION,
        DIRECTORY,
        "",
        PROMPT_MS - 1,
        TOOL_RUNNING_MS,
    );
    user_message(&conn, USER_MSG, SESSION, PROMPT_MS);
    insert_part(
        &conn,
        "prt_u",
        USER_MSG,
        SESSION,
        PROMPT_MS,
        PROMPT_MS,
        &text_part("run it"),
    );
    assistant_message(
        &conn,
        ASSISTANT_MSG,
        SESSION,
        TOOL_CREATED_MS,
        Some("tool-calls"),
    );

    let ev = poll_all(&db);
    assert_eq!(of_type(&ev, "agent_start").len(), 1);
    assert!(of_type(&ev, "agent_end").is_empty());

    // A user message as the latest one is mid-turn too — the assistant has not
    // even started.
    let dir2 = tmpdir("midturn2");
    let (db2, conn2) = make_db(&dir2);
    insert_session(&conn2, SESSION, DIRECTORY, "", PROMPT_MS - 1, PROMPT_MS);
    user_message(&conn2, USER_MSG, SESSION, PROMPT_MS);
    insert_part(
        &conn2,
        "prt_u",
        USER_MSG,
        SESSION,
        PROMPT_MS,
        PROMPT_MS,
        &text_part("run it"),
    );
    assert!(of_type(&poll_all(&db2), "agent_end").is_empty());

    fs::remove_dir_all(&dir).ok();
    fs::remove_dir_all(&dir2).ok();
}

#[test]
fn a_session_that_was_opened_and_never_used_emits_nothing() {
    // opencode inserts the session row the moment a session is selected. An
    // `agent_start` there would put an empty session in the product — and
    // would risk a SECOND one later once the first prompt gave it a goal.
    let dir = tmpdir("unused");
    let (db, conn) = make_db(&dir);
    insert_session(&conn, SESSION, DIRECTORY, "", PROMPT_MS - 1, PROMPT_MS - 1);

    let out = poll_at(&db, 0, 1000);
    assert_eq!(out.rows_seen, 1, "the row is read");
    assert!(out.events.is_empty(), "…and produces nothing");
    assert_eq!(out.watermark, PROMPT_MS - 1, "the watermark still advances");

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_start_is_byte_stable_across_the_many_re_reads_of_a_session_row() {
    // A session row moves on every turn, so it is re-read constantly. The
    // start must hash the same each time or one session leaves a trail of
    // starts. `session.title` is the trap: opencode backfills an LLM-generated
    // one seconds in, so it is deliberately not carried.
    let dir = tmpdir("stablestart");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    let first = of_type(&poll_all(&db), "agent_start")[0].clone();

    conn.execute(
        "UPDATE session SET title = 'A newly generated title', time_updated = ?1, \
         tokens_output = 999 WHERE id = ?2",
        rusqlite::params![PROMPT_MS + 5000, SESSION],
    )
    .unwrap();
    let second = of_type(&poll_all(&db), "agent_start")[0].clone();

    assert_eq!(
        serde_json::to_string(&first).unwrap(),
        serde_json::to_string(&second).unwrap(),
        "a re-read start must be byte-identical so the server collapses it"
    );

    fs::remove_dir_all(&dir).ok();
}

// ── ordering, watermark, limits ──────────────────────────────────────────

#[test]
fn rows_come_back_in_time_updated_order_not_insertion_order() {
    // The engine orders on the same column the watermark advances along; a
    // batch ordered any other way could ship a row and then move the watermark
    // past an earlier one.
    let dir = tmpdir("order");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    // Inserted newest-first, and the LATER row also has the LOWER rowid.
    insert_part(
        &conn,
        "prt_z_late",
        ASSISTANT_MSG,
        SESSION,
        PROMPT_MS + 50,
        PROMPT_MS + 90,
        &streamed_text_part("late", PROMPT_MS + 50, Some(PROMPT_MS + 89)),
    );
    insert_part(
        &conn,
        "prt_a_early",
        ASSISTANT_MSG,
        SESSION,
        PROMPT_MS + 20,
        PROMPT_MS + 30,
        &streamed_text_part("early", PROMPT_MS + 20, Some(PROMPT_MS + 29)),
    );

    let ev = poll_all(&db);
    let texts: Vec<&str> = of_type(&ev, "model_response")
        .iter()
        .map(|e| e["content"].as_str().unwrap())
        .collect();
    assert_eq!(
        texts,
        vec!["calc.py, opencode.json, README.md", "early", "late"]
    );

    // The batch is ordered by the column the watermark advances along —
    // `time_updated` — with the session row ahead of parts that share its
    // millisecond. Deliberately NOT by event timestamp: an `agent_start` is
    // backdated to `session.time_created` and a `tool_result` post-dated to
    // `state.time.end`, so the spooled order is not monotonic in time and the
    // server sorts on the timestamp anyway.
    let origins: Vec<&str> = ev
        .iter()
        .map(|e| e["opencode_part_id"].as_str().unwrap())
        .collect();
    assert_eq!(
        origins,
        vec![
            "prt_user_text", // time_updated PROMPT_MS
            SESSION,         // …+10, session before part on a tie
            SESSION,
            "prt_assistant_text", // …+10
            "prt_a_early",        // …+30, despite the higher rowid
            "prt_z_late",         // …+90
        ]
    );

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_watermark_advances_and_a_second_poll_returns_nothing() {
    let dir = tmpdir("watermark");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);

    let first = poll_at(&db, 0, 1000);
    assert!(!first.events.is_empty());
    assert_eq!(first.watermark, PROMPT_MS + 10);

    let second = poll_at(&db, first.watermark, 1000);
    assert!(second.events.is_empty());
    assert_eq!(second.rows_seen, 0);
    assert_eq!(second.watermark, first.watermark, "an idle poll holds it");
    assert!(!second.more);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn hitting_the_row_limit_reports_more_so_a_backlog_drains() {
    let dir = tmpdir("limit");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    for i in 0..10 {
        let ts = PROMPT_MS + 100 + i * 10;
        insert_part(
            &conn,
            &format!("prt_bulk_{i:02}"),
            ASSISTANT_MSG,
            SESSION,
            ts,
            ts,
            &streamed_text_part(&format!("chunk {i}"), ts, Some(ts)),
        );
    }

    let out = poll_at(&db, 0, 3);
    assert!(out.more, "a backlog must drain rather than trickle");
    assert!(out.rows_seen > 3);
    assert!(out.watermark < PROMPT_MS + 190);

    // Drain the rest exactly the way the engine does.
    let mut wm = out.watermark;
    let mut seen = out.events.len();
    for _ in 0..20 {
        let next = poll_at(&db, wm, 3);
        wm = next.watermark;
        seen += next.events.len();
        if !next.more {
            break;
        }
    }
    assert_eq!(poll_at(&db, wm, 3).events.len(), 0, "the drain terminates");
    assert_eq!(
        seen,
        poll_at(&db, 0, 1000).events.len(),
        "draining in pages ships exactly what one big poll would"
    );

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_limit_never_cuts_a_millisecond_in_half() {
    // `time_updated` is milliseconds and rows routinely share one. Cutting
    // between two of them and then asking for `time_updated > :last` skips the
    // rest of that millisecond forever — a silent, permanent hole.
    let dir = tmpdir("msgroup");
    let (db, conn) = make_db(&dir);
    insert_session(&conn, SESSION, DIRECTORY, "", PROMPT_MS - 1, PROMPT_MS - 1);
    user_message(&conn, USER_MSG, SESSION, PROMPT_MS);
    insert_part(
        &conn,
        "prt_u",
        USER_MSG,
        SESSION,
        PROMPT_MS,
        PROMPT_MS,
        &text_part("go"),
    );
    assistant_message(&conn, ASSISTANT_MSG, SESSION, PROMPT_MS + 5, Some("stop"));
    // Three parts sharing ONE millisecond, straddling a limit of 2.
    for i in 0..3 {
        insert_part(
            &conn,
            &format!("prt_same_{i}"),
            ASSISTANT_MSG,
            SESSION,
            PROMPT_MS + 20,
            PROMPT_MS + 20,
            &streamed_text_part(&format!("same {i}"), PROMPT_MS + 20, Some(PROMPT_MS + 20)),
        );
    }

    let first = poll_at(&db, 0, 2);
    assert!(first.more);
    assert!(
        first.watermark < PROMPT_MS + 20,
        "the watermark stops BEFORE the straddled millisecond, not inside it"
    );

    let mut texts: Vec<String> = first
        .events
        .iter()
        .filter(|e| e["type"] == "model_response")
        .map(|e| e["content"].as_str().unwrap().to_string())
        .collect();
    let second = poll_at(&db, first.watermark, 2);
    texts.extend(
        second
            .events
            .iter()
            .filter(|e| e["type"] == "model_response")
            .map(|e| e["content"].as_str().unwrap().to_string()),
    );
    texts.sort();
    assert_eq!(texts, vec!["same 0", "same 1", "same 2"], "no row is lost");

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_millisecond_bigger_than_the_whole_limit_still_advances() {
    // The degenerate case of the rule above: trimming to a millisecond
    // boundary would leave nothing to ship and the watermark could never move
    // past it. That millisecond is taken whole instead.
    let dir = tmpdir("degenerate");
    let (db, conn) = make_db(&dir);
    insert_session(&conn, SESSION, DIRECTORY, "", PROMPT_MS - 1, PROMPT_MS - 1);
    user_message(&conn, USER_MSG, SESSION, PROMPT_MS);
    insert_part(
        &conn,
        "prt_u",
        USER_MSG,
        SESSION,
        PROMPT_MS,
        PROMPT_MS,
        &text_part("go"),
    );
    assistant_message(&conn, ASSISTANT_MSG, SESSION, PROMPT_MS + 5, Some("stop"));
    for i in 0..4 {
        insert_part(
            &conn,
            &format!("prt_burst_{i}"),
            ASSISTANT_MSG,
            SESSION,
            PROMPT_MS + 20,
            PROMPT_MS + 20,
            &streamed_text_part(&format!("burst {i}"), PROMPT_MS + 20, Some(PROMPT_MS + 20)),
        );
    }

    // Walk up to the burst with a limit of one, then hit it.
    let mut wm = 0;
    let mut responses = 0;
    for _ in 0..12 {
        let out = poll_at(&db, wm, 1);
        responses += out
            .events
            .iter()
            .filter(|e| e["type"] == "model_response")
            .count();
        assert!(out.watermark >= wm, "the watermark never goes backwards");
        if out.watermark == wm && !out.more {
            break;
        }
        wm = out.watermark;
    }
    assert_eq!(
        responses, 4,
        "a burst wider than the limit still ships whole"
    );
    assert_eq!(wm, PROMPT_MS + 20);

    fs::remove_dir_all(&dir).ok();
}

// ── dedup discrimination and determinism ─────────────────────────────────

#[test]
fn identical_parts_are_discriminated_by_their_part_id() {
    // Two identical calls in one turn are two real events. Without a
    // discriminator the server's content dedup collapses them into one and the
    // product under-reports what the agent did.
    let dir = tmpdir("dedup");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    assistant_message(
        &conn,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        Some("tool-calls"),
    );
    let twin = json!({"type":"tool","tool":"bash","callID":CALL_ID,
      "state":{"status":"completed","input":{"command":"ls"},"output":"a\n",
               "time":{"start":TOOL_CREATED_MS,"end":TOOL_CREATED_MS}}});
    insert_part(
        &conn,
        "prt_twin_a",
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        TOOL_CREATED_MS,
        &twin,
    );
    insert_part(
        &conn,
        "prt_twin_b",
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        TOOL_CREATED_MS,
        &twin,
    );

    let ev = poll_all(&db);
    let calls = of_type(&ev, "tool_use");
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["opencode_part_id"], "prt_twin_a");
    assert_eq!(calls[1]["opencode_part_id"], "prt_twin_b");
    assert_ne!(
        serde_json::to_string(calls[0]).unwrap(),
        serde_json::to_string(calls[1]).unwrap(),
        "otherwise-identical events must not hash the same"
    );
    // Even the same callID on both must not merge them.
    assert_eq!(calls[0]["tool_call_id"], calls[1]["tool_call_id"]);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_tool_part_with_no_call_id_falls_back_to_the_part_id() {
    let dir = tmpdir("nocallid");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    assistant_message(
        &conn,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        Some("tool-calls"),
    );
    insert_part(
        &conn,
        TOOL_PART,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        TOOL_CREATED_MS,
        &json!({"type":"tool","tool":"bash","state":{"status":"completed","input":{},"output":"x",
                "time":{"start":TOOL_CREATED_MS,"end":TOOL_CREATED_MS}}}),
    );

    let ev = poll_all(&db);
    assert_eq!(of_type(&ev, "tool_use")[0]["tool_call_id"], TOOL_PART);
    assert_eq!(of_type(&ev, "tool_result")[0]["tool_call_id"], TOOL_PART);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn re_reading_the_same_rows_produces_identical_bytes() {
    // The whole re-read design rests on this: the server collapses a re-read
    // only when it hashes the same, and this source re-reads constantly.
    let dir = tmpdir("determinism");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    assistant_message(
        &conn,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        Some("tool-calls"),
    );
    insert_part(
        &conn,
        TOOL_PART,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        TOOL_DONE_MS,
        &completed_tool_part(),
    );
    insert_part(
        &conn,
        "prt_extra",
        ASSISTANT_MSG,
        SESSION,
        PROMPT_MS + 20,
        PROMPT_MS + 20,
        &streamed_text_part("more", PROMPT_MS + 20, Some(PROMPT_MS + 20)),
    );

    let a = serde_json::to_string(&poll_all(&db)).unwrap();
    for _ in 0..5 {
        assert_eq!(a, serde_json::to_string(&poll_all(&db)).unwrap());
    }
    // …and paging through it produces the same events as one big poll.
    let mut paged: Vec<Value> = Vec::new();
    let mut wm = 0;
    loop {
        let out = poll_at(&db, wm, 1);
        paged.extend(out.events);
        if out.watermark == wm {
            break;
        }
        wm = out.watermark;
    }
    assert_eq!(a, serde_json::to_string(&paged).unwrap());

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_malformed_data_blob_costs_that_row_not_the_whole_poll() {
    let dir = tmpdir("malformed");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    conn.execute(
        "INSERT INTO part VALUES ('prt_bad',?1,?2,?3,?3,'{not json')",
        rusqlite::params![ASSISTANT_MSG, SESSION, PROMPT_MS + 20],
    )
    .unwrap();

    let out = poll_at(&db, 0, 1000);
    assert_eq!(out.rows_seen, 4);
    assert_eq!(of_type(&out.events, "model_response").len(), 1);
    assert_eq!(out.watermark, PROMPT_MS + 20, "the poll still advances");

    fs::remove_dir_all(&dir).ok();
}

// ── timestamps, format table, discovery ──────────────────────────────────

#[test]
fn epoch_milliseconds_become_rfc3339_with_six_subsecond_digits() {
    // opencode stores INTEGER milliseconds. The index offset is what keeps
    // several events derived from ONE row in order.
    assert_eq!(
        transform::to_rfc3339_micros(TOOL_DONE_MS, 0).unwrap(),
        "2026-08-03T08:09:11.135000Z"
    );
    assert_eq!(
        transform::to_rfc3339_micros(TOOL_DONE_MS, 1).unwrap(),
        "2026-08-03T08:09:11.135001Z"
    );
    assert_eq!(
        transform::to_rfc3339_micros(TOOL_DONE_MS, 999).unwrap(),
        "2026-08-03T08:09:11.135999Z"
    );
}

#[test]
fn every_event_carries_the_full_envelope() {
    let dir = tmpdir("envelope");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    assistant_message(
        &conn,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        Some("tool-calls"),
    );
    insert_part(
        &conn,
        TOOL_PART,
        "msg_tool_turn",
        SESSION,
        TOOL_CREATED_MS,
        TOOL_DONE_MS,
        &completed_tool_part(),
    );

    let ev = poll_all(&db);
    let kinds: Vec<&str> = ev.iter().map(|e| e["type"].as_str().unwrap()).collect();
    for kind in [
        "agent_start",
        "model_request",
        "model_response",
        "tool_use",
        "tool_result",
    ] {
        assert!(kinds.contains(&kind), "missing {kind}");
    }
    for e in &ev {
        assert_eq!(e["session_id"], SESSION);
        assert_eq!(e["agent_id"], AGENT);
        assert_eq!(e["environment"], "local");
        assert!(e["opencode_part_id"].is_string(), "dedup discriminator");
        let ts = e["timestamp"].as_str().unwrap();
        assert!(ts.ends_with('Z') && ts.len() == 27, "RFC3339 micros: {ts}");
    }

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_dead_session_message_table_is_never_read() {
    // It is named exactly like the table this source wants, it is permanently
    // empty on a live install, and four shipped migrations DELETE FROM it. A
    // poller that reached for it would report success and ship nothing.
    let dir = tmpdir("deadtable");
    let (db, conn) = make_db(&dir);
    seed_turn(&conn);
    conn.execute(
        "INSERT INTO session_message VALUES ('sm_1',?1,'text',0,?2,?2,'{\"text\":\"LEGACY\"}')",
        rusqlite::params![SESSION, PROMPT_MS + 40],
    )
    .unwrap();

    let out = poll_at(&db, 0, 1000);
    assert_eq!(out.rows_seen, 3, "session + two parts, and nothing else");
    assert!(
        !serde_json::to_string(&out.events)
            .unwrap()
            .contains("LEGACY"),
        "the legacy table must not reach the event stream"
    );

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_declares_an_updated_at_watermark() {
    // If this ever flips to RowId, every tool call in the product ships with
    // an empty result and nothing errors. It is the single most
    // consequential line in this source.
    assert_eq!(opencode::FORMAT.watermark, Watermark::UpdatedAt);
    assert_eq!(opencode::FORMAT.kind, "opencode");
}

#[test]
fn the_default_database_is_the_xdg_data_one() {
    let path = opencode::default_db_path();
    assert!(path.ends_with("opencode/opencode.db"), "{}", path.display());
}
