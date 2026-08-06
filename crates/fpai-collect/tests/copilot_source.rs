//! Copilot source: transform correctness and engine behaviour.
//!
//! Record shapes are verbatim from real transcripts under
//! `~/.copilot/session-state/<sessionId>/events.jsonl` (Copilot CLI 1.0.77),
//! including a captured resumed session. Values are trimmed for readability
//! but every key, nesting level and type is as it appears on disk.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::cursor::TailState;
use fpai_collect::filetail::{self, Ctx, Params, RereadPolicy, Spec};
use fpai_collect::sources::copilot::{self, transform};
use fpai_collect::supervisor::Shutdown;
use serde_json::{Value, json};

const SESSION: &str = "1666969e-2c67-4534-957d-914b83d83834";

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-cp-{}-{}-{}",
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
        session_id: SESSION.into(),
        agent_id: "copilot-probe-copilot".into(),
        environment: "local".into(),

        ..Default::default()
    }
}

// ── real record shapes ───────────────────────────────────────────────────

fn session_start(ts: &str) -> String {
    json!({"type":"session.start","id":"9312c4d4","timestamp":ts,"parentId":null,
      "data":{"sessionId":SESSION,"version":1,"producer":"copilot-agent",
        "copilotVersion":"1.0.77","startTime":"2026-08-03T07:56:17.439Z",
        "contextTier":null,"context":{"cwd":"/tmp/probe-copilot"},
        "alreadyInUse":false,"remoteSteerable":false}})
    .to_string()
}

fn model_change(ts: &str, model: &str) -> String {
    json!({"type":"session.model_change","id":"34013127","timestamp":ts,"parentId":"9312c4d4",
      "data":{"contextTier":null,"newModel":model,"reasoningEffort":null}})
    .to_string()
}

/// The ~31 KB system prompt. Size is the point of this fixture.
fn system_message(ts: &str) -> String {
    let body = "You are the GitHub Copilot CLI, a terminal assistant built by GitHub. ".repeat(450);
    json!({"type":"system.message","id":"cb87ade7","timestamp":ts,"parentId":"34013127",
      "data":{"role":"system","content":body,"interactionId":"ba093147"}})
    .to_string()
}

fn user_message(ts: &str, text: &str) -> String {
    json!({"type":"user.message","id":"0bd38b01","timestamp":ts,"parentId":"cb87ade7",
      "data":{"content":text,
        "transformedContent":format!("<current_datetime>2026-08-03T13:26:20.850+05:30</current_datetime>\n\n{text}\n\n<system_reminder>\n<sql_tables>Available tables: todos</sql_tables>\n</system_reminder>"),
        "attachments":[],"supportedNativeDocumentMimeTypes":[],"delivery":"idle",
        "interactionId":"ba093147","parentAgentTaskId":"765268e2"}})
    .to_string()
}

/// An assistant turn that only calls tools: `content` is empty, `outputTokens`
/// is not.
fn assistant_tool_turn(ts: &str, calls: &[(&str, &str)], output_tokens: u64) -> String {
    let requests: Vec<Value> = calls
        .iter()
        .map(|(id, name)| {
            json!({"toolCallId":id,"name":name,"arguments":{"pattern":"*"},
                   "type":"function","intentionSummary":"*"})
        })
        .collect();
    json!({"type":"assistant.message","id":"2d856b49","timestamp":ts,"parentId":"7e94eb05",
      "data":{"messageId":"e5946eb0","model":"claude-sonnet-4-6","content":"",
        "toolRequests":requests,"interactionId":"ba093147","turnId":"0",
        "reasoningOpaque":"EvsBCmcIEBABGAIqQArMmtpV6zYayCjF7Cr",
        "reasoningText":"Let me list files and read README.md in parallel.",
        "outputTokens":output_tokens,"rte":false,"apiCallId":"msg_bdrk_018Wa"}})
    .to_string()
}

fn assistant_text(ts: &str, text: &str, output_tokens: u64) -> String {
    json!({"type":"assistant.message","id":"d528e4c5","timestamp":ts,"parentId":"686d1d03",
      "data":{"messageId":"4cab63e4","model":"claude-sonnet-4-6","content":text,
        "toolRequests":[],"interactionId":"ba093147","turnId":"1",
        "reasoningOpaque":"EvsBCmcIEBABGAIqQArMmtpV6zYayCjF7Cr",
        "reasoningText":"Let me list files and read README.md in parallel.",
        "outputTokens":output_tokens,"rte":false,"apiCallId":"msg_bdrk_01Qfsh"}})
    .to_string()
}

fn execution_start(ts: &str, call_id: &str, tool: &str) -> String {
    json!({"type":"tool.execution_start","id":"b484dc13","timestamp":ts,"parentId":"2d856b49",
      "data":{"toolCallId":call_id,"toolName":tool,"arguments":{"pattern":"*"},
        "turnId":"0","model":"claude-sonnet-4","rte":false}})
    .to_string()
}

fn execution_complete(ts: &str, call_id: &str, content: &str, success: bool) -> String {
    json!({"type":"tool.execution_complete","id":"0ac03a9e","timestamp":ts,"parentId":"3fec806b",
      "data":{"toolCallId":call_id,"model":"claude-sonnet-4","interactionId":"ba093147",
        "turnId":"0","rte":false,"success":success,
        "result":{"content":content,"detailedContent":format!("\ndiff --git a/x b/x\n{content}")},
        "toolTelemetry":{"properties":{"command":"view"},
          "metrics":{"resultLength":195,"responseTokenLimit":32000},
          "restrictedProperties":{}}}})
    .to_string()
}

fn turn_start(ts: &str, turn: &str) -> String {
    json!({"type":"assistant.turn_start","id":"7e94eb05","timestamp":ts,"parentId":"0bd38b01",
      "data":{"turnId":turn,"interactionId":"ba093147"}})
    .to_string()
}

fn turn_end(ts: &str, turn: &str) -> String {
    json!({"type":"assistant.turn_end","id":"62dedc37","timestamp":ts,"parentId":"4d5681d4",
      "data":{"turnId":turn}})
    .to_string()
}

fn shutdown(ts: &str) -> String {
    json!({"type":"session.shutdown","id":"4a8e25b2","timestamp":ts,"parentId":"ab6f3d0f",
      "data":{"shutdownType":"routine","totalPremiumRequests":0,"totalApiDurationMs":7099,
        "sessionStartTime":1785743777439i64,"eventsFileSizeBytes":39068,
        "codeChanges":{"linesAdded":0,"linesRemoved":0,"filesModified":[]},
        "currentModel":"claude-sonnet-4-6","currentTokens":15534}})
    .to_string()
}

fn session_resume(ts: &str) -> String {
    json!({"type":"session.resume","id":"c9a841c2","timestamp":ts,"parentId":"4a8e25b2",
      "data":{"resumeTime":ts,"eventCount":15,"eventsFileSizeBytes":39797,
        "selectedModel":"claude-sonnet-4","contextTier":null,"sessionLimits":null,
        "context":{"cwd":"/tmp/probe-copilot"},"alreadyInUse":false,"remoteSteerable":false}})
    .to_string()
}

/// One complete session, in the exact record order captured on disk.
fn full_session() -> Vec<String> {
    vec![
        session_start("2026-08-03T07:56:17.824Z"),
        model_change("2026-08-03T07:56:19.516Z", "claude-sonnet-4"),
        system_message("2026-08-03T07:56:20.842Z"),
        user_message(
            "2026-08-03T07:56:20.851Z",
            "List the files in this directory, then read README.md.",
        ),
        turn_start("2026-08-03T07:56:20.929Z", "0"),
        assistant_tool_turn(
            "2026-08-03T07:56:25.285Z",
            &[("toolu_glob", "glob"), ("toolu_view", "view")],
            123,
        ),
        execution_start("2026-08-03T07:56:25.287Z", "toolu_glob", "glob"),
        execution_start("2026-08-03T07:56:25.288Z", "toolu_view", "view"),
        // Completions land in the OPPOSITE order — captured verbatim.
        execution_complete("2026-08-03T07:56:25.301Z", "toolu_view", "1. # probe", true),
        execution_complete(
            "2026-08-03T07:56:25.348Z",
            "toolu_glob",
            "./README.md\n./src/fib.py",
            true,
        ),
        turn_end("2026-08-03T07:56:25.385Z", "0"),
        turn_start("2026-08-03T07:56:25.386Z", "1"),
        assistant_text("2026-08-03T07:56:28.171Z", "**Files:** README.md", 80),
        turn_end("2026-08-03T07:56:28.173Z", "1"),
        shutdown("2026-08-03T07:56:28.241Z"),
    ]
}

fn run_lines(lines: &[String], state: &mut TailState) -> Vec<Value> {
    let c = ctx();
    let mut out = Vec::new();
    let mut offset = 0u64;
    for line in lines {
        let (_, events) = transform::transform_line(line, &c, offset, state);
        offset += line.len() as u64 + 1;
        out.extend(events);
    }
    out
}

// ── transform ────────────────────────────────────────────────────────────

#[test]
fn a_millisecond_timestamp_is_padded_to_microseconds() {
    // Copilot writes milliseconds on every record; the hook source emits
    // microseconds. Both share one session timeline, and the two string forms
    // do not compare correctly against each other.
    assert_eq!(
        transform::with_index("2026-08-03T07:56:17.824Z", 0).unwrap(),
        "2026-08-03T07:56:17.824000Z"
    );
    // The index offset orders several events derived from ONE line.
    assert_eq!(
        transform::with_index("2026-08-03T07:56:17.824Z", 2).unwrap(),
        "2026-08-03T07:56:17.824002Z"
    );
}

#[test]
fn the_index_offset_saturates_inside_its_second() {
    // Carrying into the next second could reorder an event past a genuinely
    // later line, which is worse than the tie it is fixing.
    let s = transform::with_index("2026-08-03T07:56:17.999999Z", 999).unwrap();
    assert_eq!(s, "2026-08-03T07:56:17.999999Z");
}

#[test]
fn a_prompt_becomes_a_model_request_carrying_the_model_from_the_model_change_record() {
    // A `user.message` names no model, and the server builds this row's
    // summary from the model alone. Copilot writes `session.model_change`
    // ahead of the first prompt, which is why this source needs no seed_state.
    let mut st = TailState::default();
    let events = run_lines(
        &[
            model_change("2026-08-03T07:56:19.516Z", "claude-sonnet-4"),
            user_message("2026-08-03T07:56:20.851Z", "list the files"),
        ],
        &mut st,
    );
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "model_request");
    assert_eq!(events[0]["model"], "claude-sonnet-4");
    assert_eq!(events[0]["messages"][0]["content"], "list the files");
    assert_eq!(events[0]["messages"][0]["role"], "user");
}

#[test]
fn a_prompt_carries_what_the_human_typed_not_the_transformed_form() {
    // `transformedContent` prepends an injected <current_datetime> and a
    // <system_reminder>. Shipping it would put machinery in the product where
    // the user's words belong.
    let mut st = TailState::default();
    let events = run_lines(
        &[user_message("2026-08-03T07:56:20.851Z", "read README.md")],
        &mut st,
    );
    let content = events[0]["messages"][0]["content"].as_str().unwrap();
    assert_eq!(content, "read README.md");
    assert!(!content.contains("current_datetime"));
    assert!(!content.contains("system_reminder"));
}

#[test]
fn a_tool_call_is_remembered_so_its_result_is_not_a_blank_row() {
    // The tool's name appears on NO `tool.execution_complete` record. This is
    // the whole reason TailState carries pending tools.
    let mut st = TailState::default();
    let c = ctx();
    let (_, calls) = transform::transform_line(
        &execution_start("2026-08-03T07:56:25.287Z", "toolu_glob", "glob"),
        &c,
        100,
        &mut st,
    );
    assert_eq!(calls[0]["type"], "tool_use");
    assert_eq!(calls[0]["tool_name"], "glob");
    assert_eq!(calls[0]["tool_call_id"], "toolu_glob");
    assert_eq!(calls[0]["input"]["pattern"], "*");

    let (_, results) = transform::transform_line(
        &execution_complete(
            "2026-08-03T07:56:25.348Z",
            "toolu_glob",
            "./README.md",
            true,
        ),
        &c,
        200,
        &mut st,
    );
    assert_eq!(results[0]["type"], "tool_result");
    assert_eq!(
        results[0]["tool_name"], "glob",
        "the name must survive from the call"
    );
    assert_eq!(results[0]["output"], "./README.md");
}

#[test]
fn parallel_tool_completions_that_arrive_out_of_order_still_name_the_right_tool() {
    // Captured verbatim: a turn starts (glob, view) and completes (view, glob),
    // 47 ms apart. Pairing by position rather than by toolCallId would label
    // every row in the turn with the wrong tool — which is worse than labelling
    // none of them, because a wrong name is indistinguishable from a right one.
    let mut st = TailState::default();
    let events = run_lines(
        &[
            execution_start("2026-08-03T07:56:25.287Z", "toolu_glob", "glob"),
            execution_start("2026-08-03T07:56:25.288Z", "toolu_view", "view"),
            execution_complete("2026-08-03T07:56:25.301Z", "toolu_view", "1. # probe", true),
            execution_complete(
                "2026-08-03T07:56:25.348Z",
                "toolu_glob",
                "./README.md",
                true,
            ),
        ],
        &mut st,
    );
    let results: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "tool_result")
        .collect();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["tool_call_id"], "toolu_view");
    assert_eq!(results[0]["tool_name"], "view");
    assert_eq!(results[1]["tool_call_id"], "toolu_glob");
    assert_eq!(results[1]["tool_name"], "glob");
}

#[test]
fn a_failed_tool_result_carries_a_non_empty_error() {
    // The server's is_error is a truthiness check, so a failure with no output
    // must not render as a success.
    let mut st = TailState::default();
    let c = ctx();
    transform::transform_line(
        &execution_start("2026-08-03T07:56:25.287Z", "t1", "bash"),
        &c,
        0,
        &mut st,
    );
    let (_, ev) = transform::transform_line(
        &execution_complete("2026-08-03T07:56:25.301Z", "t1", "", false),
        &c,
        10,
        &mut st,
    );
    assert_eq!(ev[0]["error_type"], "copilot_tool_error");
    assert!(!ev[0]["error"].as_str().unwrap().is_empty());

    // A failure that DOES have output reports that output as the error.
    let (_, ev) = transform::transform_line(
        &execution_complete("2026-08-03T07:56:25.400Z", "t1", "exit code 127", false),
        &c,
        20,
        &mut st,
    );
    assert_eq!(ev[0]["error"], "exit code 127");
}

#[test]
fn a_contentless_tool_calling_turn_still_reports_its_output_tokens() {
    // outputTokens appears ONLY on assistant.message — tool.execution_start
    // carries none — so skipping empty-content turns the way the Claude source
    // skips empty text blocks would drop most of a session's output tokens
    // (measured: 209 of 320 in one captured session, 188 of 304 in another).
    let mut st = TailState::default();
    let events = run_lines(
        &[assistant_tool_turn(
            "2026-08-03T07:56:25.285Z",
            &[("toolu_glob", "glob"), ("toolu_view", "view")],
            123,
        )],
        &mut st,
    );
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "model_response");
    assert_eq!(events[0]["output_tokens"], 123);
    assert_eq!(events[0]["copilot_tool_request_count"], 2);
    // Omitted rather than "", so "said nothing, called tools" stays
    // distinguishable from "said the empty string".
    assert!(events[0].get("content").is_none());
}

#[test]
fn tool_requests_on_an_assistant_message_do_not_become_a_second_tool_use() {
    // Every call is announced twice: in assistant.message.toolRequests[] and
    // in its own tool.execution_start. Across all 7 captured transcripts the
    // two sets matched exactly, so emitting both would double every tool call.
    let mut st = TailState::default();
    let events = run_lines(&full_session(), &mut st);
    let uses: Vec<&Value> = events.iter().filter(|e| e["type"] == "tool_use").collect();
    assert_eq!(uses.len(), 2, "one tool_use per execution_start, no more");
    let ids: Vec<&str> = uses
        .iter()
        .map(|e| e["tool_call_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["toolu_glob", "toolu_view"]);
}

#[test]
fn the_thirty_kilobyte_system_prompt_never_becomes_an_event() {
    // A resume re-emits it verbatim, so this is not a one-off cost. It is
    // skipped rather than truncated: it is not conversation, and a truncated
    // copy would still render as a message the user never sent.
    let mut st = TailState::default();
    let line = system_message("2026-08-03T07:56:20.842Z");
    assert!(line.len() > 30_000, "fixture must be the real size");

    let (ts, events) = transform::transform_line(&line, &ctx(), 0, &mut st);
    assert!(events.is_empty());
    // The timestamp is still returned, so a session that ends on a system
    // message still gets an agent_end at the right time.
    assert_eq!(ts.as_deref(), Some("2026-08-03T07:56:20.842Z"));

    // And nothing anywhere in a full session's events approaches that size.
    let events = run_lines(&full_session(), &mut st);
    for e in &events {
        assert!(
            e.to_string().len() < 4096,
            "an event grew to {} bytes: {}",
            e.to_string().len(),
            e["type"]
        );
    }
}

#[test]
fn reasoning_text_is_dropped_because_copilot_repeats_it_on_later_turns() {
    // Captured: turn 1 of an interaction carries turn 0's reasoningText and
    // reasoningOpaque byte-identically. Emitting it would attribute thinking
    // to a turn that did not produce it.
    let mut st = TailState::default();
    let events = run_lines(&full_session(), &mut st);
    for e in &events {
        let text = e.to_string();
        assert!(!text.contains("reasoning"), "leaked reasoning: {text}");
        assert!(!text.contains("in parallel"), "leaked reasoning: {text}");
    }
}

#[test]
fn a_tool_result_ships_the_content_but_not_its_duplicated_diff_rendering() {
    // result.detailedContent equals result.content exactly for bash, and is a
    // synthetic `git diff` of the same bytes for view. Either way it doubles
    // the payload for no information.
    let mut st = TailState::default();
    let events = run_lines(
        &[
            execution_start("2026-08-03T07:56:25.287Z", "t1", "view"),
            execution_complete("2026-08-03T07:56:25.301Z", "t1", "1. # probe", true),
        ],
        &mut st,
    );
    let result = events.iter().find(|e| e["type"] == "tool_result").unwrap();
    assert_eq!(result["output"], "1. # probe");
    assert!(!result.to_string().contains("diff --git"));
}

#[test]
fn hook_records_produce_nothing_because_the_hook_source_already_ships_them() {
    // Re-deriving them here would double-count every hook on the /hooks page,
    // and their `input` embeds whole tool results.
    let mut st = TailState::default();
    let line = json!({"type":"hook.start","id":"h1","timestamp":"2026-08-03T08:13:31.333Z",
      "parentId":"p1","data":{"hookInvocationId":"c3dbb71f","hookType":"preToolUse",
        "input":{"sessionId":SESSION,"cwd":"/tmp/probe-copilot",
          "toolCalls":[{"id":"t1","name":"view","args":"{\"path\":\"/x\"}"}]}}})
    .to_string();
    let (ts, events) = transform::transform_line(&line, &ctx(), 0, &mut st);
    assert!(events.is_empty());
    assert_eq!(ts.as_deref(), Some("2026-08-03T08:13:31.333Z"));
}

#[test]
fn an_unknown_record_type_costs_nothing_and_still_advances_the_session_clock() {
    // Every Copilot record has a timestamp, so unlike the Claude source there
    // is no "missing timestamp means metadata" signal to lean on — the type
    // dispatch is an allowlist, and anything new must fall through cleanly.
    let mut st = TailState::default();
    let line =
        json!({"type":"session.future_thing","id":"x","timestamp":"2026-08-03T07:56:30.000Z",
      "parentId":"p","data":{"whatever":true}})
        .to_string();
    let (ts, events) = transform::transform_line(&line, &ctx(), 0, &mut st);
    assert!(events.is_empty());
    assert_eq!(
        ts.as_deref(),
        Some("2026-08-03T07:56:30.000Z"),
        "a new record type must still move agent_end forward"
    );
}

#[test]
fn a_truncated_line_yields_neither_a_timestamp_nor_an_event() {
    // Half a JSON object is what a live tail sees mid-append. Returning a
    // timestamp for it would advance agent_end past a record we never read.
    let mut st = TailState::default();
    let (ts, events) =
        transform::transform_line(r#"{"type":"user.message","timest"#, &ctx(), 0, &mut st);
    assert!(ts.is_none());
    assert!(events.is_empty());
}

#[test]
fn two_identical_lines_at_different_offsets_produce_different_events() {
    // The offset is the dedup discriminator. Without it the server's content
    // hash would collapse a genuinely repeated prompt into one row.
    let mut st = TailState::default();
    let c = ctx();
    let line = user_message("2026-08-03T07:56:20.851Z", "same");
    let (_, a) = transform::transform_line(&line, &c, 10, &mut st);
    let (_, b) = transform::transform_line(&line, &c, 999, &mut st);
    assert_ne!(a[0]["copilot_line_offset"], b[0]["copilot_line_offset"]);
    assert_ne!(a[0], b[0]);
}

#[test]
fn the_same_bytes_read_at_the_same_offsets_produce_identical_events() {
    // The invariant the whole engine rests on: a live tail split across polls
    // and a single full re-read must be byte-identical, or the server stores
    // the re-read twice instead of collapsing it.
    let lines = full_session();

    let mut one_pass = TailState::default();
    let whole = run_lines(&lines, &mut one_pass);

    // Split: transform the head, carry the state, transform the tail at the
    // offsets it really occupies.
    let head_len: u64 = lines[..6].iter().map(|l| l.len() as u64 + 1).sum();
    let mut split = TailState::default();
    let c = ctx();
    let mut pieces = run_lines(&lines[..6], &mut split);
    let mut offset = head_len;
    for line in &lines[6..] {
        let (_, events) = transform::transform_line(line, &c, offset, &mut split);
        offset += line.len() as u64 + 1;
        pieces.extend(events);
    }

    assert_eq!(whole, pieces);
    assert_eq!(one_pass, split, "carried state must also converge");
}

// ── resume ───────────────────────────────────────────────────────────────

#[test]
fn a_resumed_session_continues_on_one_timeline_without_a_second_start() {
    // A resume appends `session.resume` to the SAME file under the SAME
    // session id. The engine emits one agent_start per file, so a resume that
    // produced another would create a second session row for one session.
    let mut lines = full_session();
    lines.extend([
        session_resume("2026-08-03T07:57:34.498Z"),
        model_change("2026-08-03T07:57:35.963Z", "claude-sonnet-4"),
        system_message("2026-08-03T07:57:36.059Z"), // re-emitted verbatim
        user_message("2026-08-03T07:57:36.142Z", "now read src/fib.py"),
        assistant_text("2026-08-03T07:57:46.996Z", "The function is fib.", 31),
        shutdown("2026-08-03T07:57:47.068Z"),
    ]);

    let mut st = TailState::default();
    let events = run_lines(&lines, &mut st);
    let starts = events.iter().filter(|e| e["type"] == "agent_start").count();
    assert_eq!(starts, 0, "agent_start comes from the header, never a line");

    let prompts: Vec<&str> = events
        .iter()
        .filter(|e| e["type"] == "model_request")
        .map(|e| e["messages"][0]["content"].as_str().unwrap())
        .collect();
    assert_eq!(
        prompts,
        vec![
            "List the files in this directory, then read README.md.",
            "now read src/fib.py"
        ],
        "both halves of a resumed session must land on one timeline"
    );
}

#[test]
fn a_resume_record_refreshes_the_model_so_the_next_prompt_is_not_modelless() {
    // `session.resume` carries `selectedModel`. Without reading it, a resumed
    // read that started mid-file would file the next prompt with no model.
    let mut st = TailState::default();
    let events = run_lines(
        &[
            session_resume("2026-08-03T07:57:34.498Z"),
            user_message("2026-08-03T07:57:36.142Z", "carry on"),
        ],
        &mut st,
    );
    assert_eq!(events[0]["model"], "claude-sonnet-4");
}

// ── format table ─────────────────────────────────────────────────────────

#[test]
fn discovery_claims_transcripts_and_none_of_their_siblings() {
    let is = copilot::FORMAT.is_source_file;
    assert!(is(Path::new(&format!(
        "/h/.copilot/session-state/{SESSION}/events.jsonl"
    ))));

    // Rewritten in place on every resume, and YAML.
    assert!(!is(Path::new(&format!(
        "/h/.copilot/session-state/{SESSION}/workspace.yaml"
    ))));
    // Rewritten in place as checkpoints are added, and Markdown.
    assert!(!is(Path::new(&format!(
        "/h/.copilot/session-state/{SESSION}/checkpoints/index.md"
    ))));
    // SQLite: a byte cursor over a page-rewriting binary file emits garbage
    // indefinitely.
    assert!(!is(Path::new(&format!(
        "/h/.copilot/session-state/{SESSION}/session.db"
    ))));
    assert!(!is(Path::new("/h/.copilot/session-store.db")));
    assert!(!is(Path::new("/h/.copilot/session-store.db-wal")));
    assert!(!is(Path::new("/h/.copilot/session-store.db-shm")));
    // Process-scoped, not session-scoped: one file spans every session a
    // `copilot` process ran, so its lines have no single session id.
    assert!(!is(Path::new(
        "/h/.copilot/logs/process-1785743776226-130839.log"
    )));
}

#[test]
fn the_session_id_is_the_directory_name_not_the_filename() {
    // Every transcript is called events.jsonl, so the filename carries
    // nothing. Verified on disk: the directory name equals session.start's
    // data.sessionId in all 4 live sessions, including one started with an
    // explicitly chosen --session-id.
    assert_eq!(
        (copilot::FORMAT.session_id_from_path)(Path::new(&format!(
            "/h/.copilot/session-state/{SESSION}/events.jsonl"
        )))
        .as_deref(),
        Some(SESSION)
    );
    // A transcript loose in the root has no session directory; filing it under
    // the root's name would merge every such file into one session.
    assert!(
        (copilot::FORMAT.session_id_from_path)(Path::new("/h/.copilot/session-state/events.jsonl"))
            .is_none()
    );
}

#[test]
fn the_agent_id_comes_from_the_real_cwd_in_the_transcript() {
    // The directory name is a bare session UUID and encodes no path at all,
    // so the cwd has to come from session.start's data.context.cwd.
    let header = vec![session_start("2026-08-03T07:56:17.824Z")];
    let derived = (copilot::FORMAT.agent_id_from_path)(
        Path::new(&format!("/h/.copilot/session-state/{SESSION}/events.jsonl")),
        &header,
    );
    assert_eq!(derived.as_deref(), Some("copilot-probe-copilot"));

    // A resume-only header (a cursor rebuilt mid-session) still finds it.
    let header = vec![session_resume("2026-08-03T07:57:34.498Z")];
    let derived = (copilot::FORMAT.agent_id_from_path)(Path::new("/h/x/events.jsonl"), &header);
    assert_eq!(derived.as_deref(), Some("copilot-probe-copilot"));
}

#[test]
fn the_agent_id_scheme_matches_the_claude_sources_for_the_same_directory() {
    // The two sources hold separate copies of sanitize_id_part on purpose, so
    // this is the tripwire that keeps them in agreement. If they diverge, a
    // hook event and a transcript event for one run land under two agent ids
    // that look unrelated. `openclaw-local` is the cwd that broke the naive
    // decoder in the Claude source, so it is the right shape to pin.
    let cwd = "/home/u/src/openclaw-local";
    let copilot_header = vec![
        json!({"type":"session.start","id":"a","timestamp":"2026-08-03T07:56:17.824Z",
               "parentId":null,"data":{"context":{"cwd":cwd}}})
        .to_string(),
    ];
    let claude_header =
        vec![json!({"type":"user","timestamp":"2026-08-03T07:56:17.824Z","cwd":cwd}).to_string()];

    let from_copilot =
        (copilot::FORMAT.agent_id_from_path)(Path::new("/x/events.jsonl"), &copilot_header)
            .unwrap();
    let from_claude = (fpai_collect::sources::claude::FORMAT.agent_id_from_path)(
        Path::new("/x/a.jsonl"),
        &claude_header,
    )
    .unwrap();

    assert_eq!(from_copilot, "copilot-openclaw-local");
    assert_eq!(
        from_copilot.trim_start_matches("copilot-"),
        from_claude.trim_start_matches("claude-"),
        "the project half of the id must be identical across sources"
    );
}

#[test]
fn an_agent_start_is_built_from_the_header_including_the_goal_behind_the_system_prompt() {
    // The first prompt is the 4th record, sitting behind ~31 KB of system
    // prompt — still inside the engine's header budget, which is the only
    // reason `goal` is reachable at all.
    let header = full_session();
    let (event, ts) = transform::agent_start(&header, &ctx(), 0).unwrap();
    assert_eq!(event["type"], "agent_start");
    assert_eq!(event["timestamp"], "2026-08-03T07:56:17.824000Z");
    assert_eq!(ts.as_deref(), Some("2026-08-03T07:56:17.824Z"));
    assert_eq!(
        event["goal"],
        "List the files in this directory, then read README.md."
    );
    assert_eq!(event["copilot_cwd"], "/tmp/probe-copilot");
    assert_eq!(event["copilot_version"], "1.0.77");
}

#[test]
fn an_agent_end_sorts_after_every_event_that_shares_its_timestamp() {
    // A crashed session has no session.shutdown record, so agent_end lands on
    // the exact timestamp of the last real event. The server's tie-break is a
    // random id, so without the index the session appears to end before its
    // own last turn.
    let end = transform::agent_end(&ctx(), "2026-08-03T07:56:28.241Z", 39068);
    assert_eq!(end["timestamp"], "2026-08-03T07:56:28.241999Z");
    assert_eq!(end["type"], "agent_end");
    assert_eq!(end["copilot_line_offset"], 39068);
}

#[test]
fn copilot_declares_itself_byte_tailable() {
    // Proven, not assumed: a session was captured, resumed, and captured
    // again — same inode, and the first 39,797 bytes of the resumed file are
    // md5-identical to the whole pre-resume file. Two of the CLIs probed for
    // this engine rewrite their transcripts silently, so this is the switch if
    // Copilot ever joins them.
    assert_eq!(copilot::FORMAT.reread, RereadPolicy::ByteCursor);
}

#[test]
fn the_session_state_root_honours_copilot_home() {
    // Same override the CLI and lib/copilot-sessions.ts honour, so a relocated
    // Copilot home stays covered by both halves of the product.
    //
    // Serialised into one test because env vars are process-global.
    let root = copilot::session_state_root();
    assert!(root.ends_with("session-state"), "got {}", root.display());

    // SAFETY: single-threaded within this test, and restored before it ends.
    let previous = std::env::var_os("COPILOT_HOME");
    unsafe { std::env::set_var("COPILOT_HOME", "/custom/copilot") };
    assert_eq!(
        copilot::session_state_root(),
        PathBuf::from("/custom/copilot/session-state")
    );
    match previous {
        Some(v) => unsafe { std::env::set_var("COPILOT_HOME", v) },
        None => unsafe { std::env::remove_var("COPILOT_HOME") },
    }
}

// ── engine ───────────────────────────────────────────────────────────────

fn spec(root: PathBuf, spool: PathBuf, state: PathBuf) -> Spec {
    Spec {
        format: copilot::FORMAT,
        roots: vec![root],
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(200),
        params: Params {
            redact: fpai_collect::Redact::Minimal,
            agent_id: copilot::DEFAULT_AGENT_ID.into(),
            environment: "local".into(),
            machine_id: None,
            user: None,
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

/// Lay out a session exactly as Copilot does, siblings and all.
fn write_session(root: &Path, lines: &[String]) -> PathBuf {
    let dir = root.join(SESSION);
    fs::create_dir_all(dir.join("checkpoints")).unwrap();
    fs::create_dir_all(dir.join("files")).unwrap();
    fs::write(
        dir.join("workspace.yaml"),
        format!("id: {SESSION}\ncwd: /tmp/probe-copilot\n"),
    )
    .unwrap();
    fs::write(dir.join("checkpoints/index.md"), "# Checkpoint History\n").unwrap();
    fs::write(dir.join("session.db"), b"SQLite format 3\0garbage").unwrap();
    let p = dir.join("events.jsonl");
    fs::write(&p, lines.join("\n") + "\n").unwrap();
    p
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
        assert!(types.contains(&want), "missing {want}, got {types:?}");
    }

    // Every event carries the session id from the directory name, so hook
    // events for the same run land on this timeline.
    for e in &ev {
        assert_eq!(e["session_id"], SESSION);
        assert_eq!(
            e["agent_id"], "copilot-probe-copilot",
            "agent id must come from the transcript's cwd"
        );
        // Ingest parses one timestamp shape.
        let ts = e["timestamp"].as_str().unwrap();
        assert!(ts.ends_with('Z') && ts.len() == 27, "bad timestamp {ts}");
    }

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_siblings_in_a_session_directory_are_never_tailed() {
    // workspace.yaml and checkpoints/index.md are rewritten in place and
    // session.db is SQLite; tailing any of them emits garbage forever.
    let root = tmpdir("siblings-root");
    let spool = tmpdir("siblings-spool");
    let state = tmpdir("siblings-state");
    write_session(&root, &full_session());
    fs::create_dir_all(root.join("logs")).unwrap();
    fs::write(
        root.join("logs/process-1785743776226-130839.log"),
        "[INFO] x\n",
    )
    .unwrap();
    fs::write(root.join("session-store.db-wal"), b"\0\0binary").unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;

    let ev = spooled(&spool);
    assert!(!ev.is_empty(), "the transcript itself must still ship");
    for e in &ev {
        let text = e.to_string();
        assert!(!text.contains("Checkpoint History"), "checkpoint leaked");
        assert!(!text.contains("[INFO]"), "process log leaked");
        assert!(!text.contains("SQLite"), "session.db leaked");
        assert!(!text.contains("cwd: /tmp"), "workspace.yaml leaked");
    }

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
async fn a_resume_appends_and_only_the_appended_records_ship() {
    // The real resume sequence, byte-for-byte: the pre-resume prefix is
    // untouched (verified on disk by md5), and the second half is appended.
    // Re-shipping the prefix — including its second 31 KB system prompt —
    // is exactly what a byte cursor is here to avoid.
    let root = tmpdir("append-root");
    let spool = tmpdir("append-spool");
    let state = tmpdir("append-state");
    let path = write_session(&root, &full_session());

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let first = spooled(&spool);
    assert!(first.iter().any(|e| e["type"] == "agent_start"));
    clear(&spool);

    let mut body = fs::read_to_string(&path).unwrap();
    for line in [
        session_resume("2026-08-03T07:57:34.498Z"),
        model_change("2026-08-03T07:57:35.963Z", "claude-sonnet-4"),
        system_message("2026-08-03T07:57:36.059Z"),
        user_message("2026-08-03T07:57:36.142Z", "now read src/fib.py"),
        assistant_text("2026-08-03T07:57:46.996Z", "The function is fib.", 31),
        shutdown("2026-08-03T07:57:47.068Z"),
    ] {
        body.push_str(&line);
        body.push('\n');
    }
    fs::write(&path, body).unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let ev = spooled(&spool);
    assert!(
        ev.iter()
            .any(|e| e["messages"][0]["content"] == "now read src/fib.py"),
        "the post-resume prompt must ship"
    );
    assert!(
        !ev.iter().any(|e| e["messages"][0]["content"]
            == "List the files in this directory, then read README.md."),
        "the pre-resume prompt must NOT be re-shipped"
    );
    assert!(
        !ev.iter().any(|e| e["type"] == "agent_start"),
        "a resume must not open a second session"
    );

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_partially_written_final_line_is_held_back_then_picked_up() {
    // Half a JSON object parses as nothing, and consuming it would skip the
    // record when it completes — which for Copilot means losing a whole turn.
    let root = tmpdir("partial-root");
    let spool = tmpdir("partial-spool");
    let state = tmpdir("partial-state");

    let mut head = full_session();
    head.truncate(4); // through the first user.message
    let path = write_session(&root, &head);
    let complete = fs::read_to_string(&path).unwrap();
    fs::write(
        &path,
        format!("{complete}{{\"type\":\"assistant.message\",\"timest"),
    )
    .unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let n1 = spooled(&spool)
        .iter()
        .filter(|e| e["type"] == "model_response")
        .count();
    assert_eq!(n1, 0, "the half-written assistant turn must not ship");
    clear(&spool);

    fs::write(
        &path,
        format!(
            "{complete}{}\n",
            assistant_text("2026-08-03T07:56:28.171Z", "finished", 80)
        ),
    )
    .unwrap();
    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    assert!(
        spooled(&spool).iter().any(|e| e["content"] == "finished"),
        "the completed line must ship on a later pass"
    );

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}
