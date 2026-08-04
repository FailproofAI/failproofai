//! Pi source: transform correctness and engine behaviour.
//!
//! Record shapes are verbatim from real transcripts captured under
//! `~/.pi/agent/sessions/`, from BOTH pi-coding-agent 0.73.1 and 0.83.0. The
//! two releases write the same grammar with one visible difference — 0.83.0
//! emits leading prose alongside its tool calls where 0.73.1 emitted calls
//! alone — so both are exercised here rather than one standing in for the
//! other.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::cursor::TailState;
use fpai_collect::filetail::{self, Ctx, Params, RereadPolicy, Spec};
use fpai_collect::sources::pi::{self, transform};
use fpai_collect::supervisor::Shutdown;
use serde_json::{Value, json};

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-pi-{}-{}-{}",
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

/// The session uuid of the real 0.73.1 tool-using transcript.
const UUID: &str = "019fc6a6-9eb6-744b-a700-58ea5b3e8ff9";
/// pi's encoding of `/tmp/probe-pi`. Decoding it naively yields `/tmp/probe/pi`
/// and therefore the project name `pi` — which is exactly the mistake the
/// header `cwd` exists to prevent.
const ENCODED_CWD: &str = "--tmp-probe-pi--";

fn ctx() -> Ctx {
    Ctx {
        session_id: UUID.into(),
        agent_id: "pi-probe-pi".into(),
        environment: "local".into(),

        ..Default::default()
    }
}

// ── real record shapes ───────────────────────────────────────────────────

fn session_header(ts: &str) -> String {
    json!({"type":"session","version":3,"id":UUID,"timestamp":ts,"cwd":"/tmp/probe-pi"}).to_string()
}

fn model_change(ts: &str) -> String {
    json!({"type":"model_change","id":"3c651a37","parentId":null,"timestamp":ts,
           "provider":"aikin","modelId":"claude-sonnet-4-6"})
    .to_string()
}

fn thinking_level_change(ts: &str) -> String {
    json!({"type":"thinking_level_change","id":"b42de093","parentId":"3c651a37",
           "timestamp":ts,"thinkingLevel":"off"})
    .to_string()
}

fn user_prompt(ts: &str, text: &str) -> String {
    json!({"type":"message","id":"0ecb7564","parentId":"b42de093","timestamp":ts,
      "message":{"role":"user","content":[{"type":"text","text":text}],
                 "timestamp":1785744236236u64}})
    .to_string()
}

/// A 0.73.1 assistant turn: tool calls only, no prose.
fn assistant_tool_calls(ts: &str, calls: &[(&str, &str)]) -> String {
    let content: Vec<Value> = calls
        .iter()
        .map(|(id, name)| {
            json!({"type":"toolCall","id":id,"name":name,
                                 "arguments":{"command":"ls -la /tmp/probe-pi"}})
        })
        .collect();
    json!({"type":"message","id":"81470a2e","parentId":"0ecb7564","timestamp":ts,
      "message":{"role":"assistant","content":content,"api":"anthropic-messages",
        "provider":"aikin","model":"claude-sonnet-4-6",
        "usage":{"input":3,"output":103,"cacheRead":2547,"cacheWrite":339,
                 "totalTokens":2992,"cost":{"input":0,"output":0,"cacheRead":0,
                 "cacheWrite":0,"total":0}},
        "stopReason":"toolUse","timestamp":1785744236260u64,
        "responseId":"msg_bdrk_01Y324EoS5bmSs86938K3grV"}})
    .to_string()
}

/// A 0.83.0 assistant turn: prose FIRST, then the calls, plus the fields that
/// release added (`cacheWrite1h`, `rawStopReason`).
fn assistant_prose_then_calls(ts: &str, prose: &str, calls: &[(&str, &str)]) -> String {
    let mut content = vec![json!({"type":"text","text":prose})];
    content.extend(calls.iter().map(|(id, name)| {
        json!({"type":"toolCall","id":id,"name":name,
               "arguments":{"path":"/tmp/probe-pi83/README.md"}})
    }));
    json!({"type":"message","id":"d3794c08","parentId":"f0536fe0","timestamp":ts,
      "message":{"role":"assistant","content":content,"api":"anthropic-messages",
        "provider":"aikin","model":"claude-sonnet-4-6",
        "usage":{"input":3,"output":114,"cacheRead":0,"cacheWrite":2930,
                 "totalTokens":3047,"cost":{"input":0,"output":0,"cacheRead":0,
                 "cacheWrite":0,"total":0},"cacheWrite1h":0},
        "stopReason":"toolUse","timestamp":1785744818713u64,
        "responseId":"msg_bdrk_01MkBvo6F9ViUeCuGGvnsTcj","rawStopReason":"tool_use"}})
    .to_string()
}

fn assistant_text(ts: &str, text: &str) -> String {
    json!({"type":"message","id":"0436eda2","parentId":"f6ce1248","timestamp":ts,
      "message":{"role":"assistant","content":[{"type":"text","text":text}],
        "api":"anthropic-messages","provider":"aikin","model":"claude-sonnet-4-6",
        "usage":{"input":1,"output":14,"cacheRead":3392,"cacheWrite":78,
                 "totalTokens":3485,"cost":{"input":0,"output":0,"cacheRead":0,
                 "cacheWrite":0,"total":0}},
        "stopReason":"stop","timestamp":1785744268202u64,
        "responseId":"msg_bdrk_01VdNUJ8bNnNiJvvfDVTD8J6"}})
    .to_string()
}

/// The real failed turn: EMPTY content, `stopReason:"error"`, no `responseId`.
fn assistant_error(ts: &str, message: &str) -> String {
    json!({"type":"message","id":"95487fe5","parentId":"c1e2d2d2","timestamp":ts,
      "message":{"role":"assistant","content":[],"api":"anthropic-messages",
        "provider":"aikin","model":"claude-sonnet-4-6",
        "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,
                 "totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,
                 "cacheWrite":0,"total":0}},
        "stopReason":"error","timestamp":1785743864654u64,
        "errorMessage":message}})
    .to_string()
}

fn tool_result(ts: &str, call_id: &str, name: &str, out: &str, is_error: bool) -> String {
    json!({"type":"message","id":"fe29ac29","parentId":"81470a2e","timestamp":ts,
      "message":{"role":"toolResult","toolCallId":call_id,"toolName":name,
        "content":[{"type":"text","text":out}],"isError":is_error,
        "timestamp":1785744238967u64}})
    .to_string()
}

/// Same record with `toolName` stripped — the shape the carried name has to
/// cover.
fn tool_result_unnamed(ts: &str, call_id: &str, out: &str) -> String {
    json!({"type":"message","id":"fe29ac29","parentId":"81470a2e","timestamp":ts,
      "message":{"role":"toolResult","toolCallId":call_id,
        "content":[{"type":"text","text":out}],"isError":false,
        "timestamp":1785744238967u64}})
    .to_string()
}

fn of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == kind).collect()
}

// ── transform ────────────────────────────────────────────────────────────

#[test]
fn a_millisecond_timestamp_is_padded_to_microseconds() {
    // pi writes `new Date().toISOString()`, i.e. milliseconds; the hook source
    // emits microseconds. Both streams share a session timeline, so they must
    // sort against each other.
    assert_eq!(
        transform::with_index("2026-08-03T08:03:56.214Z", 0).unwrap(),
        "2026-08-03T08:03:56.214000Z"
    );
    // The index offset orders several events derived from ONE record.
    assert_eq!(
        transform::with_index("2026-08-03T08:03:56.214Z", 2).unwrap(),
        "2026-08-03T08:03:56.214002Z"
    );
}

#[test]
fn the_index_offset_saturates_inside_its_second() {
    // Carrying into the next second could reorder an event past a genuinely
    // later record, which is worse than the tie it is fixing.
    let s = transform::with_index("2026-08-03T08:03:56.999999Z", 999).unwrap();
    assert_eq!(s, "2026-08-03T08:03:56.999999Z");
    assert!(s.starts_with("2026-08-03T08:03:56."));
}

#[test]
fn a_model_change_record_primes_the_model_for_the_first_prompt() {
    // This is why this format needs no `seed_state`. pi writes `model_change`
    // BEFORE the session's first user message, so the opening row already has
    // a model — and the server builds a model_request row's summary from the
    // model alone, so without one the very first row of every session renders
    // blank. Seeding out of band (what the Claude source has to do) is the one
    // part of the format table that is not dedup-safe across a re-read.
    let mut st = TailState::default();
    let c = ctx();

    let (ts, ev) =
        transform::transform_line(&model_change("2026-08-03T08:03:56.232Z"), &c, 140, &mut st);
    assert_eq!(ts.as_deref(), Some("2026-08-03T08:03:56.232Z"));
    assert!(ev.is_empty(), "a model change is not itself a turn");
    assert_eq!(st.last_model.as_deref(), Some("claude-sonnet-4-6"));

    let (_, ev) = transform::transform_line(
        &user_prompt("2026-08-03T08:03:56.238Z", "hello"),
        &c,
        300,
        &mut st,
    );
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["type"], "model_request");
    assert_eq!(ev[0]["model"], "claude-sonnet-4-6");
    assert_eq!(ev[0]["messages"][0]["content"], "hello");
    assert_eq!(ev[0]["messages"][0]["role"], "user");
}

#[test]
fn a_user_prompt_spread_over_several_text_blocks_is_one_request() {
    // pi's user content is an ARRAY, unlike Claude Code's bare string. Emitting
    // one row per block would split a single prompt into several turns.
    let mut st = TailState::default();
    let line = json!({"type":"message","id":"a","parentId":null,
        "timestamp":"2026-08-03T08:03:56.238Z",
        "message":{"role":"user","content":[
            {"type":"text","text":"first"},{"type":"text","text":"second"}]}})
    .to_string();
    let (_, ev) = transform::transform_line(&line, &ctx(), 0, &mut st);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["messages"][0]["content"], "first\nsecond");
}

#[test]
fn a_tool_call_and_its_result_are_paired_by_id_not_by_arrival_order() {
    // One assistant record issues SEVERAL calls, and each result is its own
    // later record. Pairing positionally happens to work on the transcripts we
    // captured and breaks the moment two results are written out of order —
    // silently, by attributing one tool's output to another tool's name.
    let mut st = TailState::default();
    let c = ctx();

    let (_, calls) = transform::transform_line(
        &assistant_tool_calls(
            "2026-08-03T08:03:58.953Z",
            &[
                ("toolu_bdrk_01AWG5F1T6gf9BGKRb2h21bP", "bash"),
                ("toolu_bdrk_01QoT5TiSRRs8mfJzcMSMPAe", "read"),
            ],
        ),
        &c,
        420,
        &mut st,
    );
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["tool_name"], "bash");
    assert_eq!(calls[1]["tool_name"], "read");

    // Results delivered in the REVERSE of the call order.
    let (_, second) = transform::transform_line(
        &tool_result_unnamed(
            "2026-08-03T08:03:58.967Z",
            "toolu_bdrk_01QoT5TiSRRs8mfJzcMSMPAe",
            "# Probe Pi\n",
        ),
        &c,
        900,
        &mut st,
    );
    let (_, first) = transform::transform_line(
        &tool_result_unnamed(
            "2026-08-03T08:03:58.967Z",
            "toolu_bdrk_01AWG5F1T6gf9BGKRb2h21bP",
            "total 144\n",
        ),
        &c,
        1200,
        &mut st,
    );
    assert_eq!(second[0]["tool_name"], "read", "paired by id, not position");
    assert_eq!(first[0]["tool_name"], "bash", "paired by id, not position");
    assert_eq!(second[0]["output"], "# Probe Pi\n");
    assert_eq!(first[0]["output"], "total 144\n");
}

#[test]
fn a_tool_result_missing_its_tool_name_is_still_not_a_blank_row() {
    // pi does name the tool on the result record, so the carried name is pure
    // defence — but the server builds a result row's summary from the tool name
    // alone, so the day a writer omits it every result becomes an unreadable
    // row. This is what `TailState::pending_tools` is for.
    let mut st = TailState::default();
    let c = ctx();
    transform::transform_line(
        &assistant_tool_calls("2026-08-03T08:19:37.583Z", &[("toolu_01", "bash")]),
        &c,
        0,
        &mut st,
    );
    let (_, ev) = transform::transform_line(
        &tool_result_unnamed("2026-08-03T08:19:37.592Z", "toolu_01", "TIMING_MARKER\n"),
        &c,
        500,
        &mut st,
    );
    assert_eq!(ev[0]["type"], "tool_result");
    assert_eq!(ev[0]["tool_name"], "bash", "the name must survive the call");
    assert_eq!(ev[0]["tool_call_id"], "toolu_01");
}

#[test]
fn a_carried_tool_name_survives_the_cursor_round_trip() {
    // The call and its result can land in different polls, and between them the
    // carried state is serialized into the cursor file. If it did not round
    // trip, a live tail and a full re-read would disagree at the same offset
    // and the server could no longer collapse the re-read.
    let mut st = TailState::default();
    transform::transform_line(
        &assistant_tool_calls("2026-08-03T08:19:37.583Z", &[("toolu_01", "bash")]),
        &ctx(),
        0,
        &mut st,
    );
    let encoded = serde_json::to_string(&st).unwrap();
    let mut restored: TailState = serde_json::from_str(&encoded).unwrap();
    assert_eq!(restored.tool_name("toolu_01"), Some("bash"));

    let (_, ev) = transform::transform_line(
        &tool_result_unnamed("2026-08-03T08:19:37.592Z", "toolu_01", "ok"),
        &ctx(),
        500,
        &mut restored,
    );
    assert_eq!(ev[0]["tool_name"], "bash");
}

#[test]
fn an_assistant_turn_that_mixes_prose_with_tool_calls_ships_all_of_it() {
    // The 0.83.0 case: `["text","toolCall","toolCall"]` where 0.73.1 wrote
    // `["toolCall","toolCall"]` for the same prompt. Anything that inspects
    // content[0] to classify the turn drops the prose on one release and the
    // calls on the other.
    let mut st = TailState::default();
    let (_, ev) = transform::transform_line(
        &assistant_prose_then_calls(
            "2026-08-03T08:13:41.674Z",
            "I'll do both at the same time!",
            &[
                ("toolu_bdrk_01BLAbzzkxkrZS6nPF6nNQQy", "bash"),
                ("toolu_bdrk_01BBuVKvhJ7McsBpy9txBJLC", "read"),
            ],
        ),
        &ctx(),
        700,
        &mut st,
    );
    assert_eq!(ev.len(), 3, "got {ev:#?}");
    assert_eq!(ev[0]["type"], "model_response");
    assert_eq!(ev[0]["content"], "I'll do both at the same time!");
    assert_eq!(ev[0]["pi_stop_reason"], "toolUse");
    assert_eq!(ev[1]["type"], "tool_use");
    assert_eq!(ev[1]["tool_name"], "bash");
    assert_eq!(ev[2]["type"], "tool_use");
    assert_eq!(ev[2]["tool_name"], "read");
    // pi names the payload `arguments`; ingest reads `input`.
    assert_eq!(ev[2]["input"]["path"], "/tmp/probe-pi83/README.md");
}

#[test]
fn several_events_from_one_record_stay_in_order_on_the_timeline() {
    // They all share one millisecond, and the server's tie-break is a random
    // id — so without the index offset a turn comes back with its tool calls
    // ahead of the sentence that introduced them.
    let mut st = TailState::default();
    let (_, ev) = transform::transform_line(
        &assistant_prose_then_calls(
            "2026-08-03T08:13:41.674Z",
            "doing both",
            &[("a", "bash"), ("b", "read")],
        ),
        &ctx(),
        700,
        &mut st,
    );
    let stamps: Vec<&str> = ev
        .iter()
        .map(|e| e["timestamp"].as_str().unwrap())
        .collect();
    assert_eq!(
        stamps,
        vec![
            "2026-08-03T08:13:41.674000Z",
            "2026-08-03T08:13:41.674001Z",
            "2026-08-03T08:13:41.674002Z"
        ]
    );
    assert!(ev[0].get("pi_block_index").is_none(), "index 0 is implicit");
    assert_eq!(ev[1]["pi_block_index"], 1);
}

#[test]
fn parallel_calls_that_carry_no_id_do_not_collapse_into_one_row() {
    // Two identical calls in one record with no id would hash to the same
    // content and the server would keep only one, hiding half the work.
    let mut st = TailState::default();
    let line = json!({"type":"message","id":"a","parentId":null,
        "timestamp":"2026-08-03T08:13:41.674Z",
        "message":{"role":"assistant","model":"claude-sonnet-4-6","content":[
            {"type":"toolCall","name":"bash","arguments":{"command":"ls"}},
            {"type":"toolCall","name":"bash","arguments":{"command":"ls"}}]}})
    .to_string();
    let (_, ev) = transform::transform_line(&line, &ctx(), 700, &mut st);
    assert_eq!(ev.len(), 2);
    assert_ne!(ev[0]["tool_call_id"], ev[1]["tool_call_id"]);
    assert_eq!(ev[0]["tool_call_id"], "pi-700-0");
}

#[test]
fn an_errored_tool_result_carries_a_non_empty_error() {
    let mut st = TailState::default();
    let (_, ev) = transform::transform_line(
        &tool_result(
            "2026-08-03T08:03:58.967Z",
            "toolu_01",
            "bash",
            "exit code 127: command not found",
            true,
        ),
        &ctx(),
        0,
        &mut st,
    );
    assert_eq!(ev[0]["error_type"], "pi_tool_error");
    assert!(!ev[0]["error"].as_str().unwrap().is_empty());
    assert_eq!(ev[0]["tool_name"], "bash");
}

#[test]
fn a_failed_turn_with_no_content_still_produces_a_visible_row() {
    // Verbatim from a real 404: `content:[]`, `stopReason:"error"`, an
    // `errorMessage`, and no `responseId`. Emitting only from content blocks
    // leaves the prompt that triggered it as the last thing in the session and
    // the failure entirely invisible.
    let mut st = TailState::default();
    let (_, ev) = transform::transform_line(
        &assistant_error("2026-08-03T07:58:00.520Z", "404 {\"detail\":\"Not Found\"}"),
        &ctx(),
        0,
        &mut st,
    );
    assert_eq!(ev.len(), 1, "got {ev:#?}");
    assert_eq!(ev[0]["type"], "model_response");
    assert_eq!(ev[0]["error_type"], "pi_model_error");
    assert_eq!(ev[0]["content"], "404 {\"detail\":\"Not Found\"}");
    assert_eq!(ev[0]["pi_stop_reason"], "error");
    // Index 0 because there were no blocks to sort behind.
    assert_eq!(ev[0]["timestamp"], "2026-08-03T07:58:00.520000Z");
}

#[test]
fn token_usage_is_billed_once_per_record_including_on_a_failed_turn() {
    // pi writes exactly ONE record per API response, so usage is billed
    // unconditionally — unlike the Claude source, which must gate on a message
    // id because Claude Code repeats one usage object across several lines.
    // Gating here would silently drop the usage of every errored turn, since
    // those carry no `responseId` to gate on.
    let mut st = TailState::default();
    let c = ctx();

    let (_, a) = transform::transform_line(
        &assistant_text("2026-08-03T08:04:29.565Z", "six lines"),
        &c,
        0,
        &mut st,
    );
    assert_eq!(a[0]["input_tokens"], 1);
    assert_eq!(a[0]["output_tokens"], 14);
    assert_eq!(a[0]["pi_usage"]["totalTokens"], 3485);

    // A different record at a different offset bills again — two responses are
    // two bills.
    let (_, b) = transform::transform_line(
        &assistant_text("2026-08-03T08:04:31.000Z", "again"),
        &c,
        900,
        &mut st,
    );
    assert_eq!(b[0]["input_tokens"], 1);

    let (_, err) = transform::transform_line(
        &assistant_error("2026-08-03T07:58:00.520Z", "404"),
        &c,
        1800,
        &mut st,
    );
    assert!(
        err[0].get("pi_usage").is_some(),
        "an errored turn still reports what it cost"
    );
}

#[test]
fn usage_lands_on_only_the_first_event_of_a_multi_event_record() {
    // Three events from one response, each carrying the same usage, would
    // triple that response's token total.
    let mut st = TailState::default();
    let (_, ev) = transform::transform_line(
        &assistant_prose_then_calls(
            "2026-08-03T08:13:41.674Z",
            "doing both",
            &[("a", "bash"), ("b", "read")],
        ),
        &ctx(),
        0,
        &mut st,
    );
    assert_eq!(ev.len(), 3);
    assert!(ev[0].get("pi_usage").is_some());
    assert!(ev[1].get("pi_usage").is_none());
    assert!(ev[2].get("pi_usage").is_none());
}

#[test]
fn the_session_header_yields_no_events_but_still_starts_the_clock() {
    // `agent_start` is built from the header lines by the engine, not from this
    // dispatch — emitting here too would give every session two start events.
    // The timestamp is still returned so an otherwise-empty file can end.
    let mut st = TailState::default();
    let (ts, ev) = transform::transform_line(
        &session_header("2026-08-03T08:03:56.214Z"),
        &ctx(),
        0,
        &mut st,
    );
    assert_eq!(ts.as_deref(), Some("2026-08-03T08:03:56.214Z"));
    assert!(ev.is_empty());
}

#[test]
fn records_this_source_does_not_model_still_advance_the_session_clock() {
    // EVERY pi record carries a timestamp, so the Claude source's "no timestamp
    // means metadata" shortcut does not exist here. Returning None for these
    // would freeze `agent_end` at the last *message*, dating a session that
    // ended with a compaction or a label minutes before it really did.
    let mut st = TailState::default();
    let c = ctx();
    for line in [
        thinking_level_change("2026-08-03T08:03:56.232Z"),
        json!({"type":"label","id":"a","parentId":"b","timestamp":"2026-08-03T08:05:00.000Z",
               "targetId":"c","label":"checkpoint"})
        .to_string(),
        json!({"type":"compaction","id":"d","parentId":"c",
               "timestamp":"2026-08-03T08:06:00.000Z","message":{"role":"user","content":[]}})
        .to_string(),
        json!({"type":"session_info","id":"e","parentId":"d",
               "timestamp":"2026-08-03T08:07:00.000Z","title":"probe"})
        .to_string(),
    ] {
        let (ts, ev) = transform::transform_line(&line, &c, 0, &mut st);
        assert!(ts.is_some(), "{line} must report its timestamp");
        assert!(ev.is_empty(), "{line} must not become a turn");
    }
}

#[test]
fn a_custom_message_is_not_mistaken_for_a_conversation_turn() {
    // `custom` (and the pre-v3 `hookMessage` the v2→v3 migration renames to it)
    // is extension output. Falling through to the user branch would file an
    // extension's chatter as something the human typed.
    let mut st = TailState::default();
    let line = json!({"type":"message","id":"a","parentId":"b",
        "timestamp":"2026-08-03T08:05:00.000Z",
        "message":{"role":"custom","content":[{"type":"text","text":"hook says hi"}]}})
    .to_string();
    let (ts, ev) = transform::transform_line(&line, &ctx(), 0, &mut st);
    assert!(ts.is_some());
    assert!(ev.is_empty());
}

#[test]
fn two_identical_records_at_different_offsets_produce_different_events() {
    // The offset is the dedup discriminator, and pi makes it easy to need: a
    // retried prompt is byte-for-byte the same JSON. Without it the server
    // collapses a genuinely repeated turn into one row.
    let mut st = TailState::default();
    let c = ctx();
    let line = user_prompt("2026-08-03T08:03:56.238Z", "same");
    let (_, a) = transform::transform_line(&line, &c, 10, &mut st);
    let (_, b) = transform::transform_line(&line, &c, 999, &mut st);
    assert_eq!(a[0]["pi_line_offset"], 10);
    assert_eq!(b[0]["pi_line_offset"], 999);
    assert_ne!(a[0]["pi_line_offset"], b[0]["pi_line_offset"]);
}

#[test]
fn a_malformed_line_is_skipped_without_taking_the_file_with_it() {
    let mut st = TailState::default();
    let (ts, ev) = transform::transform_line("{not json", &ctx(), 0, &mut st);
    assert!(ts.is_none());
    assert!(ev.is_empty());
}

#[test]
fn the_start_event_carries_the_goal_the_cwd_and_the_session_version() {
    let header = vec![
        session_header("2026-08-03T08:03:56.214Z"),
        model_change("2026-08-03T08:03:56.232Z"),
        thinking_level_change("2026-08-03T08:03:56.232Z"),
        user_prompt(
            "2026-08-03T08:03:56.238Z",
            "List the files in this directory",
        ),
        assistant_text("2026-08-03T08:03:58.953Z", "done"),
    ];
    let (event, ts) = transform::agent_start(&header, &ctx(), 0).unwrap();
    assert_eq!(ts.as_deref(), Some("2026-08-03T08:03:56.214Z"));
    assert_eq!(event["type"], "agent_start");
    assert_eq!(event["timestamp"], "2026-08-03T08:03:56.214000Z");
    assert_eq!(event["goal"], "List the files in this directory");
    assert_eq!(event["pi_cwd"], "/tmp/probe-pi");
    // A NUMBER on disk, not a string — reading it as a string yields nothing.
    assert_eq!(event["pi_session_version"], 3);
    assert_eq!(event["pi_model"], "claude-sonnet-4-6");
    assert_eq!(event["pi_provider"], "aikin");
}

#[test]
fn a_forked_session_records_the_transcript_it_was_cut_from() {
    // Fork and branch write a NEW file and leave the source untouched, so the
    // only on-disk link back is this header field. Dropping it makes a forked
    // session look like it appeared from nowhere.
    let header = vec![
        json!({"type":"session","version":3,"id":UUID,
               "timestamp":"2026-08-03T08:03:56.214Z","cwd":"/tmp/probe-pi",
               "parentSession":"/home/u/.pi/agent/sessions/--tmp-probe-pi--/older.jsonl"})
        .to_string(),
    ];
    let (event, _) = transform::agent_start(&header, &ctx(), 0).unwrap();
    assert_eq!(
        event["pi_parent_session"],
        "/home/u/.pi/agent/sessions/--tmp-probe-pi--/older.jsonl"
    );
}

#[test]
fn the_end_event_sorts_after_every_turn_that_shares_its_timestamp() {
    // The server's tie-break is a random id, so without the index a session can
    // appear to end before its own last turn.
    let end = transform::agent_end(&ctx(), "2026-08-03T08:04:29.565Z", 5017);
    assert_eq!(end["type"], "agent_end");
    // 565 ms + 999 µs, and still inside the same second.
    assert_eq!(end["timestamp"], "2026-08-03T08:04:29.565999Z");
    // The file size, so the one end event of a session is unique to it.
    assert_eq!(end["pi_line_offset"], 5017);
}

// ── format table ─────────────────────────────────────────────────────────

#[test]
fn discovery_claims_session_transcripts_and_nothing_else() {
    let is = pi::FORMAT.is_source_file;
    let dir = format!("/s/{ENCODED_CWD}");
    assert!(is(Path::new(&format!(
        "{dir}/2026-08-03T08-03-56-214Z_{UUID}.jsonl"
    ))));

    // No underscore-separated uuid: an export, a note, an editor backup.
    assert!(!is(Path::new(&format!("{dir}/{UUID}.jsonl"))));
    assert!(!is(Path::new(&format!("{dir}/notes.jsonl"))));
    assert!(!is(Path::new(&format!(
        "{dir}/2026-08-03T08-03-56-214Z_{UUID}.jsonl~"
    ))));
    assert!(!is(Path::new(&format!(
        "{dir}/2026-08-03T08-03-56-214Z_{UUID}.json"
    ))));
    // A bare uuid with nothing before the underscore is not pi's naming.
    assert!(!is(Path::new(&format!("{dir}/_{UUID}.jsonl"))));
}

#[test]
fn the_session_id_is_the_uuid_after_the_underscore() {
    // Split from the right: the timestamp half is `2026-08-03T08-03-56-214Z`,
    // full of the same `-` the uuid uses, so only the underscore separates them.
    assert_eq!(
        (pi::FORMAT.session_id_from_path)(Path::new(&format!(
            "/s/{ENCODED_CWD}/2026-08-03T08-03-56-214Z_{UUID}.jsonl"
        )))
        .as_deref(),
        Some(UUID)
    );
    assert!((pi::FORMAT.session_id_from_path)(Path::new("/s/x/notes.jsonl")).is_none());
}

#[test]
fn the_agent_id_comes_from_the_header_cwd_not_the_lossy_directory_name() {
    // pi encodes cwd by mapping every separator to `-` and leaving literal `-`
    // alone, so the encoding is not invertible — and the loss is not a corner
    // case. `/tmp/probe-pi` becomes `--tmp-probe-pi--`, which decodes back to
    // `/tmp/probe/pi` and would file the session under `pi-pi`.
    let header = vec![session_header("2026-08-03T08:03:56.214Z")];
    let derived = (pi::FORMAT.agent_id_from_path)(
        Path::new(&format!(
            "/s/{ENCODED_CWD}/2026-08-03T08-03-56-214Z_{UUID}.jsonl"
        )),
        &header,
    );
    assert_eq!(derived.as_deref(), Some("pi-probe-pi"));
}

#[test]
fn a_header_with_no_cwd_falls_back_rather_than_inventing_an_agent() {
    // The configured default is better than a wrong guess decoded from the
    // directory name.
    let derived = (pi::FORMAT.agent_id_from_path)(
        Path::new(&format!(
            "/s/{ENCODED_CWD}/2026-08-03T08-03-56-214Z_{UUID}.jsonl"
        )),
        &[r#"{"type":"model_change","timestamp":"2026-08-03T08:03:56.232Z"}"#.to_string()],
    );
    assert!(derived.is_none());
}

#[test]
fn pi_seeds_no_carried_state_from_its_header() {
    // Seeding is the one part of the format table that is NOT dedup-safe
    // between a live tail and a later full re-read, and pi does not need it:
    // its own record order puts `model_change` ahead of the first prompt. If
    // this ever becomes non-empty, that tradeoff is being taken on knowingly.
    let header = vec![
        session_header("2026-08-03T08:03:56.214Z"),
        model_change("2026-08-03T08:03:56.232Z"),
        assistant_text("2026-08-03T08:03:58.953Z", "hi"),
    ];
    let mut st = TailState::default();
    (pi::FORMAT.seed_state)(&header, &mut st);
    assert_eq!(st, TailState::default());
}

#[test]
fn pi_declares_itself_byte_tailable() {
    // Steady-state turns are appendFileSync, so a byte cursor is correct. The
    // whole-file `_rewriteFile()` paths shrink the file, which the engine
    // detects on its own — see the shrink test below.
    assert_eq!(pi::FORMAT.reread, RereadPolicy::ByteCursor);
    assert_eq!(pi::FORMAT.kind, "pi");
}

#[test]
fn the_sessions_root_follows_pis_own_agent_directory_override() {
    // A relocated agent dir that we did not follow means capturing nothing,
    // silently — the same failure mode as an absent root.
    //
    // Serialized against the other env-var assertions in this test by being the
    // only one that touches PI_CODING_AGENT_DIR.
    let saved = std::env::var_os("PI_CODING_AGENT_DIR");
    unsafe { std::env::set_var("PI_CODING_AGENT_DIR", "/opt/pi-agent") };
    assert_eq!(pi::sessions_root(), PathBuf::from("/opt/pi-agent/sessions"));

    // pi expands the tilde itself; taking it literally would have us watching a
    // directory named `~` under the process cwd.
    unsafe { std::env::set_var("PI_CODING_AGENT_DIR", "~/elsewhere") };
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    assert_eq!(pi::sessions_root(), home.join("elsewhere").join("sessions"));

    match saved {
        Some(v) => unsafe { std::env::set_var("PI_CODING_AGENT_DIR", v) },
        None => unsafe { std::env::remove_var("PI_CODING_AGENT_DIR") },
    }
}

// ── engine ───────────────────────────────────────────────────────────────

fn spec(root: PathBuf, spool: PathBuf, state: PathBuf) -> Spec {
    Spec {
        format: pi::FORMAT,
        roots: vec![root],
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(200),
        params: Params {
            agent_id: pi::DEFAULT_AGENT_ID.into(),
            environment: "local".into(),
            machine_id: None,
            end_idle_mins: 0, // end immediately, so the test need not wait
            max_read_bytes: 8 * 1024 * 1024,
            max_batch_bytes: 8 * 1024 * 1024,
            since_days: None,
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

fn write_session(root: &Path, lines: &[String]) -> PathBuf {
    let proj = root.join(ENCODED_CWD);
    fs::create_dir_all(&proj).unwrap();
    let p = proj.join(format!("2026-08-03T08-03-56-214Z_{UUID}.jsonl"));
    fs::write(&p, lines.join("\n") + "\n").unwrap();
    p
}

fn cleanup(dirs: [&Path; 3]) {
    for d in dirs {
        fs::remove_dir_all(d).ok();
    }
}

/// The real 0.73.1 tool-using session, in file order.
fn session_0_73_1() -> Vec<String> {
    vec![
        session_header("2026-08-03T08:03:56.214Z"),
        model_change("2026-08-03T08:03:56.232Z"),
        thinking_level_change("2026-08-03T08:03:56.232Z"),
        user_prompt(
            "2026-08-03T08:03:56.238Z",
            "List the files in this directory, then read README.md and tell me what it says.",
        ),
        assistant_tool_calls(
            "2026-08-03T08:03:58.953Z",
            &[
                ("toolu_bdrk_01AWG5F1T6gf9BGKRb2h21bP", "bash"),
                ("toolu_bdrk_01QoT5TiSRRs8mfJzcMSMPAe", "read"),
            ],
        ),
        tool_result(
            "2026-08-03T08:03:58.967Z",
            "toolu_bdrk_01AWG5F1T6gf9BGKRb2h21bP",
            "bash",
            "total 144\n",
            false,
        ),
        tool_result(
            "2026-08-03T08:03:58.967Z",
            "toolu_bdrk_01QoT5TiSRRs8mfJzcMSMPAe",
            "read",
            "# Probe Pi\n",
            false,
        ),
        assistant_text("2026-08-03T08:04:02.076Z", "Here's what I found: …"),
    ]
}

/// The real 0.83.0 session — same grammar, prose alongside the calls.
fn session_0_83_0() -> Vec<String> {
    vec![
        session_header("2026-08-03T08:13:38.646Z"),
        model_change("2026-08-03T08:13:38.678Z"),
        thinking_level_change("2026-08-03T08:13:38.678Z"),
        user_prompt(
            "2026-08-03T08:13:38.690Z",
            "List the files in this directory, then read README.md and tell me what it says.",
        ),
        assistant_prose_then_calls(
            "2026-08-03T08:13:41.674Z",
            "I'll do both at the same time!",
            &[
                ("toolu_bdrk_01BLAbzzkxkrZS6nPF6nNQQy", "bash"),
                ("toolu_bdrk_01BBuVKvhJ7McsBpy9txBJLC", "read"),
            ],
        ),
        tool_result(
            "2026-08-03T08:13:41.683Z",
            "toolu_bdrk_01BLAbzzkxkrZS6nPF6nNQQy",
            "bash",
            "total 144\n",
            false,
        ),
        tool_result(
            "2026-08-03T08:13:41.683Z",
            "toolu_bdrk_01BBuVKvhJ7McsBpy9txBJLC",
            "read",
            "# Probe Pi83\n",
            false,
        ),
        assistant_text("2026-08-03T08:13:45.502Z", "Here's what I found: …"),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_real_0_73_1_session_produces_a_start_its_turns_and_an_end() {
    let root = tmpdir("full-root");
    let spool = tmpdir("full-spool");
    let state = tmpdir("full-state");

    write_session(&root, &session_0_73_1());
    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;

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
    assert_eq!(of_type(&ev, "tool_use").len(), 2);
    assert_eq!(of_type(&ev, "tool_result").len(), 2);

    // Every event carries the session id from the filename, so hook events for
    // the same run land on this timeline — and the agent id from the header
    // cwd, not the lossy directory name.
    for e in &ev {
        assert_eq!(e["session_id"], UUID);
        assert_eq!(e["agent_id"], "pi-probe-pi");
        assert_eq!(e["environment"], "local");
        assert!(e["timestamp"].as_str().unwrap().ends_with('Z'));
    }

    cleanup([&root, &spool, &state]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_0_83_0_session_needs_no_second_format() {
    // The two releases write the same grammar; only the shape of an assistant
    // turn's content differs. A source that needed a second `Format` would be
    // a source that had assumed content was homogeneous.
    let root = tmpdir("v83-root");
    let spool = tmpdir("v83-spool");
    let state = tmpdir("v83-state");

    write_session(&root, &session_0_83_0());
    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;

    let ev = spooled(&spool);
    assert_eq!(of_type(&ev, "agent_start").len(), 1);
    assert_eq!(of_type(&ev, "model_request").len(), 1);
    assert_eq!(of_type(&ev, "tool_use").len(), 2);
    assert_eq!(of_type(&ev, "tool_result").len(), 2);
    // The prose that shipped alongside the calls, plus the closing turn.
    assert_eq!(of_type(&ev, "model_response").len(), 2);
    assert!(
        of_type(&ev, "model_response")
            .iter()
            .any(|e| e["content"] == "I'll do both at the same time!"),
        "the leading prose of a 0.83.0 tool turn must ship"
    );

    cleanup([&root, &spool, &state]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_pass_ships_nothing_new() {
    let root = tmpdir("resume-root");
    let spool = tmpdir("resume-spool");
    let state = tmpdir("resume-state");
    write_session(&root, &session_0_73_1());

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    assert!(!spooled(&spool).is_empty());
    clear(&spool);

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 800).await;
    assert!(
        spooled(&spool).is_empty(),
        "a resumed pass must ship nothing"
    );

    cleanup([&root, &spool, &state]);
}

#[tokio::test(flavor = "multi_thread")]
async fn appended_turns_are_picked_up_without_re_shipping_earlier_ones() {
    let root = tmpdir("append-root");
    let spool = tmpdir("append-spool");
    let state = tmpdir("append-state");
    let path = write_session(&root, &session_0_73_1());

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let first = spooled(&spool).len();
    clear(&spool);

    // Steady-state pi: one appendFileSync per entry.
    let mut body = fs::read_to_string(&path).unwrap();
    body.push_str(&(user_prompt("2026-08-03T08:04:26.109Z", "Now run: wc -l calc.py") + "\n"));
    body.push_str(&(assistant_text("2026-08-03T08:04:29.565Z", "`calc.py` has 6 lines.") + "\n"));
    fs::write(&path, body).unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let ev = spooled(&spool);
    assert!(!ev.is_empty(), "the appended turns must ship");
    assert!(
        ev.len() < first,
        "earlier turns must not be re-shipped: {} vs {first}",
        ev.len()
    );
    assert!(
        ev.iter()
            .any(|e| e["messages"][0]["content"] == "Now run: wc -l calc.py"),
        "the new prompt must be present"
    );

    cleanup([&root, &spool, &state]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rewritten_transcript_that_shrank_is_re_read_rather_than_seeked_past() {
    // `_rewriteFile()` does a full writeFileSync over the existing file when a
    // resumed session's entries all failed to parse — the transcript is
    // replaced by a lone fresh header, far shorter than what was there. Left
    // alone the cursor would sit past EOF and the session would silently stop
    // updating for the rest of its life.
    let root = tmpdir("rewrite-root");
    let spool = tmpdir("rewrite-spool");
    let state = tmpdir("rewrite-state");
    let path = write_session(&root, &session_0_73_1());
    let big = fs::metadata(&path).unwrap().len();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    clear(&spool);

    let rewritten = [
        session_header("2026-08-03T08:20:00.000Z"),
        model_change("2026-08-03T08:20:00.010Z"),
        user_prompt("2026-08-03T08:20:00.020Z", "after the rewrite"),
        assistant_text("2026-08-03T08:20:02.000Z", "fresh"),
    ];
    fs::write(&path, rewritten.join("\n") + "\n").unwrap();
    assert!(
        fs::metadata(&path).unwrap().len() < big,
        "the rewrite must actually shrink the file for this test to mean anything"
    );

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let ev = spooled(&spool);
    assert!(
        ev.iter()
            .any(|e| e["messages"][0]["content"] == "after the rewrite"),
        "a shrunk transcript must be re-read, got {} events",
        ev.len()
    );

    cleanup([&root, &spool, &state]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_partially_written_final_line_is_held_back_then_picked_up() {
    let root = tmpdir("partial-root");
    let spool = tmpdir("partial-spool");
    let state = tmpdir("partial-state");
    let proj = root.join(ENCODED_CWD);
    fs::create_dir_all(&proj).unwrap();
    let path = proj.join(format!("2026-08-03T08-03-56-214Z_{UUID}.jsonl"));

    let head = [
        session_header("2026-08-03T08:03:56.214Z"),
        model_change("2026-08-03T08:03:56.232Z"),
        user_prompt("2026-08-03T08:03:56.238Z", "complete"),
    ]
    .join("\n");
    fs::write(&path, format!("{head}\n{{\"type\":\"message\",\"timest")).unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let n1 = of_type(&spooled(&spool), "model_request").len();
    assert_eq!(n1, 1, "only the complete records should ship");
    clear(&spool);

    fs::write(
        &path,
        format!(
            "{head}\n{}\n",
            user_prompt("2026-08-03T08:04:26.109Z", "finished")
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

    cleanup([&root, &spool, &state]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_directory_with_no_file_in_it_yet_is_not_an_error() {
    // pi's `_persist()` short-circuits until the first assistant message
    // completes, then flushes everything at once — so a run killed before that
    // leaves ZERO trace on disk, and a live run leaves an EMPTY directory for
    // as long as its first turn takes. Discovery finding nothing here is
    // normal, and must not be logged, retried or failed as if it were not.
    let root = tmpdir("empty-root");
    let spool = tmpdir("empty-spool");
    let state = tmpdir("empty-state");
    fs::create_dir_all(root.join(ENCODED_CWD)).unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 800).await;
    assert!(spooled(&spool).is_empty());

    // And once the flush lands, the whole prefix is picked up in one pass —
    // including the `agent_start` built from a header that appeared complete.
    write_session(&root, &session_0_73_1());
    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let ev = spooled(&spool);
    assert_eq!(of_type(&ev, "agent_start").len(), 1, "got {ev:#?}");
    assert_eq!(of_type(&ev, "model_request").len(), 1);

    cleanup([&root, &spool, &state]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_live_tail_and_a_full_re_read_agree_event_for_event() {
    // The invariant the whole engine rests on: every event is a pure function
    // of one record plus its byte offset, so a tail that happens to split a
    // turn across two polls must produce byte-identical events to a single
    // full read. Only that lets the server's content hash collapse a re-read
    // instead of storing the session twice. The tool-name carry is the part
    // that could break it, which is why it is persisted in the cursor.
    let lines = session_0_73_1();

    let tail_root = tmpdir("tail-root");
    let tail_spool = tmpdir("tail-spool");
    let tail_state = tmpdir("tail-state");
    // Half the session, then the rest — the call lands in one pass and its
    // results in the next.
    let path = write_session(&tail_root, &lines[..5]);
    run_briefly(
        spec(tail_root.clone(), tail_spool.clone(), tail_state.clone()),
        1000,
    )
    .await;
    fs::write(&path, lines.join("\n") + "\n").unwrap();
    run_briefly(
        spec(tail_root.clone(), tail_spool.clone(), tail_state.clone()),
        1200,
    )
    .await;

    let once_root = tmpdir("once-root");
    let once_spool = tmpdir("once-spool");
    let once_state = tmpdir("once-state");
    write_session(&once_root, &lines);
    run_briefly(
        spec(once_root.clone(), once_spool.clone(), once_state.clone()),
        1200,
    )
    .await;

    let mut tailed = spooled(&tail_spool);
    let mut at_once = spooled(&once_spool);
    // `agent_end` is emitted per pass and carries the file size, so the split
    // run legitimately has an extra one for the shorter file.
    tailed.retain(|e| e["type"] != "agent_end");
    at_once.retain(|e| e["type"] != "agent_end");
    let key = |e: &Value| format!("{}|{}", e["type"], e["pi_line_offset"]);
    tailed.sort_by_key(key);
    at_once.sort_by_key(key);
    assert!(
        !at_once.is_empty(),
        "two empty runs would make this comparison vacuous"
    );
    assert_eq!(
        tailed, at_once,
        "a split tail must produce the same events as one full read"
    );

    cleanup([&tail_root, &tail_spool, &tail_state]);
    cleanup([&once_root, &once_spool, &once_state]);
}
