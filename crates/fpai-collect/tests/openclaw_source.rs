//! OpenClaw source: transform correctness and engine behaviour.
//!
//! Record shapes are verbatim from a live containerised probe capture of
//! `<state>/agents/main/sessions/<uuid>.jsonl`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::cursor::TailState;
use fpai_collect::filetail::{self, Ctx, Params, RereadPolicy, Spec};
use fpai_collect::sources::openclaw::{self, transform};
use fpai_collect::supervisor::Shutdown;
use serde_json::{Value, json};

const UUID: &str = "0c751d66-8f74-429d-a604-b29855d36c41";

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

fn ctx() -> Ctx {
    Ctx {
        session_id: UUID.into(),
        agent_id: "openclaw-main".into(),
        environment: "local".into(),

        ..Default::default()
    }
}

// ── record builders, mirroring the capture field for field ───────────────

fn session_header(ts: &str) -> String {
    json!({"type":"session","version":3,"id":UUID,"timestamp":ts,
           "cwd":"/root/.openclaw/workspace"})
    .to_string()
}

fn model_change(ts: &str, model: &str) -> String {
    json!({"type":"model_change","id":"aeabf817","parentId":null,"timestamp":ts,
           "provider":"aikin","modelId":model})
    .to_string()
}

fn user_prompt(ts: &str, text: &str) -> String {
    json!({"type":"message","id":"95bd1c5a","parentId":"cafc9e4c","timestamp":ts,
      "message":{"role":"user","content":[{"type":"text","text":text}],
                 "timestamp":1785744100097u64}})
    .to_string()
}

fn assistant_text(ts: &str, text: &str) -> String {
    json!({"type":"message","id":"c1770cd4","parentId":"22dfa2b0","timestamp":ts,
      "message":{"role":"assistant","content":[{"type":"text","text":text}],
        "api":"openai-completions","provider":"aikin","model":"claude-sonnet-4-6",
        "usage":{"input":11,"output":22,"cacheRead":0,"cacheWrite":0,"totalTokens":33,
                 "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},
        "stopReason":"stop","timestamp":1785744339885u64,
        "responseId":"chatcmpl-f0ca3642-a5c8-42ad-bda4-8df7dd16ce3e"}})
    .to_string()
}

fn assistant_tool_call(ts: &str, call_id: &str, name: &str) -> String {
    json!({"type":"message","id":"58002e1a","parentId":"b180b92b","timestamp":ts,
      "message":{"role":"assistant","content":[
        {"type":"toolCall","id":call_id,"name":name,
         "arguments":{"command":"wc -l /work/README.md"},
         "partialArgs":"{\"command\": \"wc -l /work/README.md\"}"}],
        "api":"openai-completions","provider":"aikin","model":"claude-sonnet-4-6",
        "usage":{"input":7,"output":13,"cacheRead":0,"cacheWrite":0,"totalTokens":20,
                 "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},
        "stopReason":"toolUse","timestamp":1785744336347u64,
        "responseId":"chatcmpl-3536f98e-9ba4-40f5-9819-3ca070850abf"}})
    .to_string()
}

fn tool_result(ts: &str, call_id: &str, name: &str, out: &str, is_error: bool) -> String {
    json!({"type":"message","id":"22dfa2b0","parentId":"58002e1a","timestamp":ts,
      "message":{"role":"toolResult","toolCallId":call_id,"toolName":name,
        "content":[{"type":"text","text":out}],
        "details":{"status":"completed","exitCode":0,"durationMs":10,
                   "aggregated":out,"cwd":"/root/.openclaw/workspace"},
        "isError":is_error,"timestamp":1785744339880u64}})
    .to_string()
}

// Copied byte for byte out of the capture. The builders above are only useful
// if they describe the same records the real agent writes, and a hand-written
// json! literal can drift from the format without anything noticing.
const REAL_ASSISTANT_TWO_CALLS: &str = r#"{"type":"message","id":"9dcb612e","parentId":"95bd1c5a","timestamp":"2026-08-03T08:01:44.024Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"tooluse_7pfybztVIIqiHrh9doZ0aY","name":"exec","arguments":{"command":"ls /work"},"partialArgs":"{\"command\": \"ls /work\"}"},{"type":"toolCall","id":"tooluse_qjN8Jtj5TN3aJsCncAGmN7","name":"read","arguments":{"path":"/work/README.md","limit":20},"partialArgs":"{\"path\": \"/work/README.md\", \"limit\": 20}"}],"api":"openai-completions","provider":"aikin","model":"claude-sonnet-4-6","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1785744100111,"responseId":"chatcmpl-fb143f6c-794d-4514-8e98-6a7407be9be2"}}"#;

const REAL_RESULT_WITH_DETAILS: &str = r#"{"type":"message","id":"7b87bad5","parentId":"9dcb612e","timestamp":"2026-08-03T08:01:44.179Z","message":{"role":"toolResult","toolCallId":"tooluse_7pfybztVIIqiHrh9doZ0aY","toolName":"exec","content":[{"type":"text","text":"README.md\na.txt"}],"details":{"status":"completed","exitCode":0,"durationMs":9,"aggregated":"README.md\na.txt","cwd":"/root/.openclaw/workspace"},"isError":false,"timestamp":1785744104177}}"#;

// The `read` result in the capture carries NO `details` block at all.
const REAL_RESULT_WITHOUT_DETAILS: &str = r##"{"type":"message","id":"fe9653e8","parentId":"7b87bad5","timestamp":"2026-08-03T08:01:44.181Z","message":{"role":"toolResult","toolCallId":"tooluse_qjN8Jtj5TN3aJsCncAGmN7","toolName":"read","content":[{"type":"text","text":"# Demo Project\nThis is the README for the probe test.\n"}],"isError":false,"timestamp":1785744104180}}"##;

const REAL_CUSTOM_TRAILER: &str = r#"{"type":"custom","customType":"openclaw:bootstrap-context:full","data":{"timestamp":1785744342907,"runId":"875db66f-36d8-4270-8b71-14955caadf00","sessionId":"0c751d66-8f74-429d-a604-b29855d36c41"},"id":"f11d1d2e","parentId":"c1770cd4","timestamp":"2026-08-03T08:05:42.907Z"}"#;

// ── transform ────────────────────────────────────────────────────────────

#[test]
fn a_millisecond_timestamp_is_padded_to_microseconds() {
    // OpenClaw writes milliseconds; the hook source emits microseconds. Both
    // streams share a session timeline, so they must sort against each other.
    assert_eq!(
        transform::with_index("2026-08-03T08:01:44.024Z", 0).unwrap(),
        "2026-08-03T08:01:44.024000Z"
    );
    // The index offset orders several events derived from ONE record.
    assert_eq!(
        transform::with_index("2026-08-03T08:01:44.024Z", 1).unwrap(),
        "2026-08-03T08:01:44.024001Z"
    );
}

#[test]
fn the_index_offset_saturates_inside_its_second() {
    // Carrying into the next second could reorder an event past a genuinely
    // later record, which is worse than the tie it is fixing.
    let s = transform::with_index("2026-08-03T08:01:44.999999Z", 999).unwrap();
    assert_eq!(s, "2026-08-03T08:01:44.999999Z");
}

#[test]
fn the_record_level_clock_wins_over_the_inner_epoch_millis() {
    // Every record carries two clocks. On this REAL assistant record the outer
    // one reads 08:01:44.024 and the inner `message.timestamp` (1785744100111)
    // reads 08:01:40.111 — the moment the request was issued, 3.9s earlier.
    // Taking the inner one here and the outer one on the tool results would
    // reorder the session by seconds.
    let mut st = TailState::default();
    let (ts, ev) = transform::transform_line(REAL_ASSISTANT_TWO_CALLS, &ctx(), 0, &mut st);
    assert_eq!(ts.as_deref(), Some("2026-08-03T08:01:44.024Z"));
    assert_eq!(ev[0]["timestamp"], "2026-08-03T08:01:44.024000Z");
    assert!(
        !ev[0]["timestamp"].as_str().unwrap().contains("08:01:40"),
        "the inner request clock must never become the event time"
    );
}

#[test]
fn a_model_change_record_supplies_the_model_for_the_very_first_prompt() {
    // OpenClaw announces its model in a record of its own, written before the
    // first prompt. That is why this source needs no `seed_state` — and it is
    // the only thing keeping the opening `model_request` row, the row most
    // likely to be looked at, from rendering with no model at all.
    let mut st = TailState::default();
    let c = ctx();
    let (_, none) = transform::transform_line(
        &model_change("2026-08-03T08:01:39.826Z", "claude-sonnet-4-6"),
        &c,
        0,
        &mut st,
    );
    assert!(none.is_empty(), "a model_change record emits no event");

    let (_, ev) = transform::transform_line(
        &user_prompt("2026-08-03T08:01:40.102Z", "List the files in /work"),
        &c,
        200,
        &mut st,
    );
    assert_eq!(ev[0]["type"], "model_request");
    assert_eq!(ev[0]["model"], "claude-sonnet-4-6");
    assert_eq!(ev[0]["messages"][0]["content"], "List the files in /work");
}

#[test]
fn the_three_message_roles_each_produce_their_own_event_type() {
    // OpenClaw has a THIRD role: `toolResult` is its own record rather than a
    // block inside a user turn. A two-role reader silently drops every tool
    // result in every session.
    let mut st = TailState::default();
    let c = ctx();
    let roles = [
        (
            user_prompt("2026-08-03T08:01:40.102Z", "hi"),
            "model_request",
        ),
        (
            assistant_text("2026-08-03T08:05:42.900Z", "done"),
            "model_response",
        ),
        (
            tool_result("2026-08-03T08:05:39.882Z", "tooluse_z", "exec", "2", false),
            "tool_result",
        ),
    ];
    for (line, want) in roles {
        let (_, ev) = transform::transform_line(&line, &c, 0, &mut st);
        assert_eq!(ev.len(), 1, "{want}");
        assert_eq!(ev[0]["type"], want);
    }
}

#[test]
fn a_tool_call_is_remembered_so_a_result_that_names_no_tool_is_not_a_blank_row() {
    // The server builds a result row's summary from the tool name alone. A
    // result missing `toolName` and with nothing carried from the call is a
    // blank row in the product.
    let mut st = TailState::default();
    let c = ctx();
    let (_, calls) = transform::transform_line(
        &assistant_tool_call("2026-08-03T08:05:39.743Z", "tooluse_zo9X", "exec"),
        &c,
        100,
        &mut st,
    );
    assert_eq!(calls[0]["type"], "tool_use");
    assert_eq!(calls[0]["tool_name"], "exec");
    assert_eq!(calls[0]["tool_call_id"], "tooluse_zo9X");
    assert_eq!(calls[0]["input"]["command"], "wc -l /work/README.md");

    let nameless = json!({"type":"message","id":"x","timestamp":"2026-08-03T08:05:39.882Z",
      "message":{"role":"toolResult","toolCallId":"tooluse_zo9X",
        "content":[{"type":"text","text":"2 /work/README.md"}],"isError":false}})
    .to_string();
    let (_, results) = transform::transform_line(&nameless, &c, 200, &mut st);
    assert_eq!(
        results[0]["tool_name"], "exec",
        "the name must survive from the call"
    );
    assert_eq!(results[0]["output"], "2 /work/README.md");
}

#[test]
fn a_result_that_names_its_own_tool_is_trusted_over_the_carried_name() {
    // Ids pair exactly, so a carried name is normally the same answer. Where
    // they disagree the record on disk is the fact and the carried value is an
    // inference, so the record wins.
    let mut st = TailState::default();
    let c = ctx();
    transform::transform_line(
        &assistant_tool_call("2026-08-03T08:05:39.743Z", "tooluse_zo9X", "stale"),
        &c,
        0,
        &mut st,
    );
    let (_, ev) = transform::transform_line(
        &tool_result(
            "2026-08-03T08:05:39.882Z",
            "tooluse_zo9X",
            "exec",
            "2",
            false,
        ),
        &c,
        50,
        &mut st,
    );
    assert_eq!(ev[0]["tool_name"], "exec");
}

#[test]
fn tool_calls_and_results_pair_on_the_id_openclaw_writes() {
    // `toolCall.id` == `toolResult.toolCallId`, verbatim from the capture. The
    // whole call/result pairing in the product hangs off this equality.
    let mut st = TailState::default();
    let c = ctx();
    let (_, calls) = transform::transform_line(REAL_ASSISTANT_TWO_CALLS, &c, 0, &mut st);
    let (_, r1) = transform::transform_line(REAL_RESULT_WITH_DETAILS, &c, 900, &mut st);
    let (_, r2) = transform::transform_line(REAL_RESULT_WITHOUT_DETAILS, &c, 1200, &mut st);

    assert_eq!(calls[0]["tool_call_id"], r1[0]["tool_call_id"]);
    assert_eq!(calls[1]["tool_call_id"], r2[0]["tool_call_id"]);
    assert_eq!(calls[0]["tool_name"], "exec");
    assert_eq!(calls[1]["tool_name"], "read");
    assert_eq!(r1[0]["tool_name"], "exec");
    assert_eq!(r2[0]["tool_name"], "read");
}

#[test]
fn one_assistant_record_carrying_two_tool_calls_keeps_them_in_order() {
    // Both calls share the record's millisecond, and the server sorts by
    // `(ts, random id)`. Without the index offset the session appears to read
    // the file before it listed the directory.
    let mut st = TailState::default();
    let (_, ev) = transform::transform_line(REAL_ASSISTANT_TWO_CALLS, &ctx(), 0, &mut st);
    assert_eq!(ev.len(), 2);
    assert_eq!(ev[0]["timestamp"], "2026-08-03T08:01:44.024000Z");
    assert_eq!(ev[1]["timestamp"], "2026-08-03T08:01:44.024001Z");
    assert_eq!(ev[1]["openclaw_block_index"], 1);
    assert!(
        ev[0].get("openclaw_block_index").is_none(),
        "the first block keeps the record's exact time and needs no marker"
    );
}

#[test]
fn a_tool_result_without_a_details_block_still_ships() {
    // The capture's `read` result has no `details` at all while its `exec`
    // results do. Requiring it would silently drop every non-shell result.
    let mut st = TailState::default();
    let c = ctx();
    let (_, with) = transform::transform_line(REAL_RESULT_WITH_DETAILS, &c, 0, &mut st);
    let (_, without) = transform::transform_line(REAL_RESULT_WITHOUT_DETAILS, &c, 300, &mut st);

    assert_eq!(with[0]["type"], "tool_result");
    assert_eq!(with[0]["duration_ms"], 9.0);
    assert_eq!(with[0]["openclaw_exit_code"], 0);
    assert_eq!(with[0]["openclaw_tool_status"], "completed");

    assert_eq!(without[0]["type"], "tool_result");
    assert!(without[0].get("duration_ms").is_none());
    assert!(
        without[0]["output"]
            .as_str()
            .unwrap()
            .contains("Demo Project"),
        "the output must survive the missing details block"
    );
}

#[test]
fn an_errored_tool_result_carries_a_non_empty_error() {
    // The server's `is_error` is a truthiness check, so an empty string would
    // render a failed tool call as a success.
    let mut st = TailState::default();
    let c = ctx();
    let (_, ev) = transform::transform_line(
        &tool_result(
            "2026-08-03T08:05:39.882Z",
            "tooluse_z",
            "exec",
            "wc: /work/nope: No such file",
            true,
        ),
        &c,
        0,
        &mut st,
    );
    assert_eq!(ev[0]["error_type"], "openclaw_tool_error");
    assert!(!ev[0]["error"].as_str().unwrap().is_empty());

    // …and an error with no message at all still reads as a failure.
    let silent = json!({"type":"message","id":"x","timestamp":"2026-08-03T08:05:39.882Z",
      "message":{"role":"toolResult","toolCallId":"t","toolName":"exec",
        "content":[],"isError":true}})
    .to_string();
    let (_, ev) = transform::transform_line(&silent, &c, 10, &mut st);
    assert_eq!(ev[0]["error_type"], "openclaw_tool_error");
    assert!(!ev[0]["error"].as_str().unwrap().trim().is_empty());
}

#[test]
fn token_usage_is_attributed_once_per_assistant_record() {
    // A record yielding two events must report its tokens once, or every
    // multi-call turn doubles the session's totals.
    let mut st = TailState::default();
    let (_, ev) = transform::transform_line(
        &assistant_tool_call("2026-08-03T08:05:39.743Z", "t1", "exec"),
        &ctx(),
        0,
        &mut st,
    );
    assert_eq!(ev[0]["input_tokens"], 7);
    assert_eq!(ev[0]["output_tokens"], 13);
    assert_eq!(ev[0]["openclaw_usage"]["totalTokens"], 20);

    let mut st = TailState::default();
    let (_, two) = transform::transform_line(REAL_ASSISTANT_TWO_CALLS, &ctx(), 0, &mut st);
    assert!(two[0].get("openclaw_usage").is_some());
    assert!(
        two[1].get("openclaw_usage").is_none(),
        "usage belongs to the record, not to each block of it"
    );
}

#[test]
fn harness_records_advance_the_clock_without_emitting_events() {
    // `session`, `thinking_level_change` and `custom` describe the harness. The
    // capture ENDS on a `custom` record, so a reader that skipped them outright
    // would leave `agent_end` stuck 4 seconds before the session really ended.
    let mut st = TailState::default();
    let c = ctx();
    for line in [
        session_header("2026-08-03T08:01:39.794Z"),
        r#"{"type":"thinking_level_change","id":"4f980063","parentId":"aeabf817","timestamp":"2026-08-03T08:01:39.826Z","thinkingLevel":"off"}"#.to_string(),
        REAL_CUSTOM_TRAILER.to_string(),
    ] {
        let (ts, ev) = transform::transform_line(&line, &c, 0, &mut st);
        assert!(ts.is_some(), "the record must still advance the clock");
        assert!(ev.is_empty(), "but emit nothing: {line}");
    }
}

#[test]
fn an_unparseable_line_is_skipped_without_advancing_the_clock() {
    let mut st = TailState::default();
    let (ts, ev) = transform::transform_line("{not json", &ctx(), 0, &mut st);
    assert!(ts.is_none());
    assert!(ev.is_empty());
}

#[test]
fn two_identical_records_at_different_offsets_produce_different_events() {
    // The offset is the dedup discriminator. Without it the server collapses a
    // genuinely repeated prompt into one row.
    let mut st = TailState::default();
    let c = ctx();
    let line = user_prompt("2026-08-03T08:01:40.102Z", "same question");
    let (_, a) = transform::transform_line(&line, &c, 10, &mut st);
    let (_, b) = transform::transform_line(&line, &c, 999, &mut st);
    assert_ne!(a[0]["openclaw_line_offset"], b[0]["openclaw_line_offset"]);
    assert_eq!(
        a[0]["timestamp"], b[0]["timestamp"],
        "same record, same time"
    );
}

#[test]
fn the_redundant_mirrors_of_the_payload_are_not_shipped() {
    // `partialArgs` re-encodes `arguments` as a JSON string and
    // `details.aggregated` copies the result text. Shipping either doubles the
    // payload to say the same thing twice, and this source's whole cost
    // argument is bytes per session.
    let mut st = TailState::default();
    let c = ctx();
    let (_, calls) = transform::transform_line(REAL_ASSISTANT_TWO_CALLS, &c, 0, &mut st);
    let rendered = serde_json::to_string(&calls).unwrap();
    assert!(!rendered.contains("partialArgs"), "{rendered}");

    let (_, res) = transform::transform_line(REAL_RESULT_WITH_DETAILS, &c, 500, &mut st);
    let rendered = serde_json::to_string(&res[0]).unwrap();
    assert!(!rendered.contains("aggregated"), "{rendered}");
}

#[test]
fn the_session_header_becomes_a_start_event_naming_its_goal_and_model() {
    let header = vec![
        session_header("2026-08-03T08:01:39.794Z"),
        model_change("2026-08-03T08:01:39.826Z", "claude-sonnet-4-6"),
        user_prompt("2026-08-03T08:01:40.102Z", "List the files in /work"),
    ];
    let (event, ts) = transform::agent_start(&header, &ctx(), 0).unwrap();
    assert_eq!(ts.as_deref(), Some("2026-08-03T08:01:39.794Z"));
    assert_eq!(event["type"], "agent_start");
    assert_eq!(event["goal"], "List the files in /work");
    assert_eq!(event["model"], "claude-sonnet-4-6");
    assert_eq!(event["openclaw_provider"], "aikin");
    assert_eq!(event["openclaw_session_version"], 3);
    // Recorded for provenance only — never used to group sessions.
    assert_eq!(event["openclaw_cwd"], "/root/.openclaw/workspace");
}

// ── format table ─────────────────────────────────────────────────────────

#[test]
fn discovery_never_claims_the_trajectory_sibling() {
    // THE expensive mistake. The trajectory shares the transcript's stem and
    // its `.jsonl` extension, sits in the same directory, and is 334,468 bytes
    // against the transcript's 5,640 — 59x, for information already in the
    // transcript. Claiming it is the difference between ~6 KB and ~340 KB per
    // session shipped.
    let is = openclaw::FORMAT.is_source_file;
    let dir = format!("/root/.openclaw/agents/main/sessions/{UUID}");
    assert!(
        !is(Path::new(&format!("{dir}.trajectory.jsonl"))),
        "the trajectory trace must never be tailed"
    );
    // And its pointer file.
    assert!(!is(Path::new(&format!("{dir}.trajectory-path.json"))));
    // The transcript itself, for contrast.
    assert!(is(Path::new(&format!("{dir}.jsonl"))));
}

#[test]
fn discovery_claims_transcripts_and_nothing_else() {
    let is = openclaw::FORMAT.is_source_file;
    assert!(is(Path::new(&format!(
        "/root/.openclaw/agents/main/sessions/{UUID}.jsonl"
    ))));

    // Rewritten in place on every interaction — a byte cursor would re-ship it
    // forever.
    assert!(!is(Path::new(
        "/root/.openclaw/agents/main/sessions/sessions.json"
    )));
    // Content-addressed prompt blobs nested BELOW the sessions directory.
    assert!(!is(Path::new(
        "/root/.openclaw/agents/main/sessions/skills-prompts/sha256/ba/baee2cb204a2aeac788b61f02baa616efe3dc589240732fb38057ebec73a2a68.txt"
    )));
    // …and would still be rejected if such a blob were ever named `.jsonl`,
    // because it does not sit directly in `sessions/`.
    assert!(!is(Path::new(&format!(
        "/root/.openclaw/agents/main/sessions/skills-prompts/sha256/ba/{UUID}.jsonl"
    ))));
    // The state database.
    assert!(!is(Path::new("/root/.openclaw/state/openclaw.sqlite")));
}

#[test]
fn the_agent_id_comes_from_the_agents_path_component_not_the_workspace_cwd() {
    // OpenClaw's `cwd` is the agent workspace — `/root/.openclaw/workspace`,
    // identical for every session that agent ever runs — so grouping on it
    // would file the whole install under one meaningless project. The header
    // is passed in and deliberately ignored.
    let header = vec![session_header("2026-08-03T08:01:39.794Z")];
    let derived = (openclaw::FORMAT.agent_id_from_path)(
        Path::new(&format!(
            "/root/.openclaw/agents/main/sessions/{UUID}.jsonl"
        )),
        &header,
    );
    assert_eq!(derived.as_deref(), Some("openclaw-main"));

    // A second agent on the same install is a different agent id, even though
    // both report the same workspace cwd.
    let other = (openclaw::FORMAT.agent_id_from_path)(
        Path::new(&format!(
            "/root/.openclaw/agents/research-bot/sessions/{UUID}.jsonl"
        )),
        &header,
    );
    assert_eq!(other.as_deref(), Some("openclaw-research-bot"));

    // A layout without the `agents/<id>/sessions/` shape yields nothing, so the
    // engine falls back to a plainly-generic id rather than a confidently wrong
    // one.
    assert!(
        (openclaw::FORMAT.agent_id_from_path)(
            Path::new(&format!("/somewhere/sessions/{UUID}.jsonl")),
            &header
        )
        .is_none()
    );
}

#[test]
fn the_session_id_is_the_filename_stem() {
    assert_eq!(
        (openclaw::FORMAT.session_id_from_path)(Path::new(&format!(
            "/root/.openclaw/agents/main/sessions/{UUID}.jsonl"
        )))
        .as_deref(),
        Some(UUID)
    );
}

#[test]
fn openclaw_declares_itself_byte_tailable() {
    // Proven append-only against the capture: `cmp` showed a byte-exact prefix
    // across turns. If OpenClaw ever starts rewriting mid-file the way droid
    // does, this is the switch — the engine already supports the other policy.
    assert_eq!(openclaw::FORMAT.reread, RereadPolicy::ByteCursor);
}

// ── engine ───────────────────────────────────────────────────────────────

/// `base` stands in for the OpenClaw state directory, so the configured root is
/// `base/agents` — exactly what `default_roots()` resolves to. The layout is
/// load-bearing rather than cosmetic: the agent id is read off the
/// `agents/<agentId>/sessions/` path shape, so a flattened test tree would
/// silently exercise the fallback id instead of the real one.
fn spec(base: PathBuf, spool: PathBuf, state: PathBuf) -> Spec {
    Spec {
        format: openclaw::FORMAT,
        roots: vec![base.join("agents")],
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(200),
        health_key: None,
        params: Params {
            redact: fpai_collect::Redact::Minimal,
            agent_id: openclaw::DEFAULT_AGENT_ID.into(),
            environment: "local".into(),
            machine_id: None,
            user: None,
            end_idle_mins: 0, // end immediately, so the test need not wait
            max_read_bytes: 8 * 1024 * 1024,
            max_batch_bytes: 8 * 1024 * 1024,
            since_days: None,
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

fn clear(dir: &Path) {
    for e in fs::read_dir(dir).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }
}

async fn run_briefly(s: Spec, ms: u64) {
    let sd = Shutdown::for_test(Arc::new(AtomicBool::new(false)));
    let _ = tokio::time::timeout(Duration::from_millis(ms), filetail::run(s, sd)).await;
}

/// A tree laid out exactly like OpenClaw's: `<state>/agents/<agentId>/sessions/`.
fn sessions_dir(base: &Path) -> PathBuf {
    let d = base.join("agents").join("main").join("sessions");
    fs::create_dir_all(&d).unwrap();
    d
}

fn write_session(root: &Path, lines: &[String]) -> PathBuf {
    let p = sessions_dir(root).join(format!("{UUID}.jsonl"));
    fs::write(&p, lines.join("\n") + "\n").unwrap();
    p
}

/// The capture's own opening turn, verbatim where it matters.
fn full_session() -> Vec<String> {
    vec![
        session_header("2026-08-03T08:01:39.794Z"),
        model_change("2026-08-03T08:01:39.826Z", "claude-sonnet-4-6"),
        user_prompt("2026-08-03T08:01:40.102Z", "List the files in /work"),
        REAL_ASSISTANT_TWO_CALLS.to_string(),
        REAL_RESULT_WITH_DETAILS.to_string(),
        REAL_RESULT_WITHOUT_DETAILS.to_string(),
        assistant_text("2026-08-03T08:01:48.937Z", "The title is Demo Project."),
        REAL_CUSTOM_TRAILER.to_string(),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_produces_a_start_its_turns_and_an_end() {
    let root = tmpdir("full-root");
    let spool = tmpdir("full-spool");
    let state = tmpdir("full-state");
    write_session(&root, &full_session());

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;

    let ev = spooled(&spool);
    let types: Vec<&str> = ev.iter().filter_map(|e| e["type"].as_str()).collect();
    for want in [
        "agent_start",
        "model_request",
        "model_response",
        "tool_use",
        "tool_result",
        "agent_end",
    ] {
        assert!(types.contains(&want), "missing {want}: got {types:?}");
    }
    // The capture's opening turn packs BOTH tool calls into a SINGLE assistant
    // record, and each is answered by a `toolResult` record of its own. A
    // reader that emitted one event per record rather than one per content
    // block would lose half the tool calls in the session.
    assert_eq!(
        types.iter().filter(|t| **t == "tool_use").count(),
        2,
        "both calls in the one assistant record must ship: {types:?}"
    );
    assert_eq!(types.iter().filter(|t| **t == "tool_result").count(), 2);

    for e in &ev {
        assert_eq!(e["session_id"], UUID, "the stem is the session id");
        assert_eq!(
            e["agent_id"], "openclaw-main",
            "grouped by agent, not by the workspace cwd"
        );
    }

    // The trailing `custom` record is the last thing in the file, so the
    // session ends when it really ended rather than at the last message.
    let end = ev.iter().find(|e| e["type"] == "agent_end").unwrap();
    assert!(
        end["timestamp"]
            .as_str()
            .unwrap()
            .starts_with("2026-08-03T08:05:42."),
        "got {}",
        end["timestamp"]
    );

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_trajectory_sibling_is_never_read_end_to_end() {
    // The predicate is unit-tested above; this proves the engine's recursive
    // walk agrees, because that walk is where the 59x actually gets paid.
    let root = tmpdir("traj-root");
    let spool = tmpdir("traj-spool");
    let state = tmpdir("traj-state");

    write_session(&root, &full_session());
    let dir = sessions_dir(&root);
    fs::write(
        dir.join(format!("{UUID}.trajectory.jsonl")),
        format!(
            "{}\n",
            json!({"traceSchema":"openclaw-trajectory","schemaVersion":1,
                   "traceId":UUID,"type":"session.started",
                   "ts":"2026-08-03T08:01:39.830Z","seq":1,
                   "data":{"marker":"TRAJECTORY-ONLY-STRING"}})
        ),
    )
    .unwrap();
    fs::write(
        dir.join(format!("{UUID}.trajectory-path.json")),
        r#"{"traceSchema":"openclaw-trajectory-pointer","schemaVersion":1}"#,
    )
    .unwrap();
    fs::write(dir.join("sessions.json"), r#"{"agent:main:main":{}}"#).unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;

    let ev = spooled(&spool);
    assert!(
        !ev.is_empty(),
        "the transcript itself must still be shipped"
    );
    let all = serde_json::to_string(&ev).unwrap();
    assert!(
        !all.contains("TRAJECTORY-ONLY-STRING"),
        "the trajectory trace leaked into the spool"
    );
    assert!(!all.contains("openclaw-trajectory"), "{all}");

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_pass_ships_nothing_new() {
    let root = tmpdir("resume-root");
    let spool = tmpdir("resume-spool");
    let state = tmpdir("resume-state");
    write_session(&root, &full_session());

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    assert!(!spooled(&spool).is_empty());
    clear(&spool);

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 800).await;
    assert!(
        spooled(&spool).is_empty(),
        "a resumed pass must ship nothing"
    );

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn appended_turns_are_picked_up_without_re_shipping_earlier_ones() {
    // OpenClaw appends: a byte-exact prefix survives every turn, which is the
    // whole basis for `RereadPolicy::ByteCursor`.
    let root = tmpdir("append-root");
    let spool = tmpdir("append-spool");
    let state = tmpdir("append-state");
    let path = write_session(&root, &full_session());

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let first = spooled(&spool).len();
    assert!(first > 0);
    clear(&spool);

    let mut body = fs::read_to_string(&path).unwrap();
    body.push_str(&(user_prompt("2026-08-03T08:09:00.000Z", "second turn") + "\n"));
    fs::write(&path, body).unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let ev = spooled(&spool);
    assert!(
        ev.iter()
            .any(|e| e["messages"][0]["content"] == "second turn"),
        "the appended turn must ship"
    );
    assert!(
        ev.len() < first,
        "earlier turns must not be re-shipped: {} vs {first}",
        ev.len()
    );
    // The model still comes from the `model_change` record read on the FIRST
    // pass, which is only true because it is carried in the persisted cursor.
    let prompt = ev
        .iter()
        .find(|e| e["messages"][0]["content"] == "second turn")
        .unwrap();
    assert_eq!(prompt["model"], "claude-sonnet-4-6");

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_partially_written_final_line_is_held_back_then_picked_up() {
    // Half a JSON object parses as nothing, and consuming it would skip the
    // record for good once it completes.
    let root = tmpdir("partial-root");
    let spool = tmpdir("partial-spool");
    let state = tmpdir("partial-state");
    let path = sessions_dir(&root).join(format!("{UUID}.jsonl"));

    let head = [
        session_header("2026-08-03T08:01:39.794Z"),
        model_change("2026-08-03T08:01:39.826Z", "claude-sonnet-4-6"),
        user_prompt("2026-08-03T08:01:40.102Z", "complete"),
    ]
    .join("\n");
    fs::write(&path, format!("{head}\n{{\"type\":\"message\",\"time")).unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let n = spooled(&spool)
        .iter()
        .filter(|e| e["type"] == "model_request")
        .count();
    assert_eq!(n, 1, "only the complete records should ship");
    clear(&spool);

    fs::write(
        &path,
        format!(
            "{head}\n{}\n",
            user_prompt("2026-08-03T08:03:00.000Z", "finished")
        ),
    )
    .unwrap();
    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    assert!(
        spooled(&spool)
            .iter()
            .any(|e| e["messages"][0]["content"] == "finished"),
        "the completed record must ship on a later pass"
    );

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}
