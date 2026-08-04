//! Codex source: transform correctness and engine behaviour.
//!
//! Record shapes are verbatim from the 13 real rollouts under
//! `~/.codex/sessions/` (Codex CLI 0.145.0 / 0.146.0) — 6,520 lines, from which
//! every claim about the format in these tests was measured.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::cursor::TailState;
use fpai_collect::filetail::{self, Ctx, Params, RereadPolicy, Spec};
use fpai_collect::sources::codex::{self, transform};
use fpai_collect::sources::hooks::transform::{HookRow, agent_id as hook_agent_id};
use fpai_collect::supervisor::Shutdown;
use serde_json::{Value, json};

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-cx-{}-{}-{}",
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

const UUID: &str = "019fb217-14a2-7193-8ceb-504b318e00ad";
const ROLLOUT: &str = "rollout-2026-07-30T13-44-44-019fb217-14a2-7193-8ceb-504b318e00ad.jsonl";

fn ctx() -> Ctx {
    Ctx {
        session_id: UUID.into(),
        agent_id: "codex-cli".into(),
        environment: "local".into(),

        ..Default::default()
    }
}

// ── real record shapes, trimmed only of bulk (base_instructions etc.) ────────

fn session_meta(ts: &str, cwd: &str) -> String {
    json!({"timestamp":ts,"type":"session_meta","payload":{
        "session_id":UUID,"id":UUID,"timestamp":"2026-07-30T08:14:44.900Z","cwd":cwd,
        "originator":"codex-tui","cli_version":"0.146.0","source":"cli","thread_source":"user",
        "model_provider":"aikin","history_mode":"legacy",
        "git":{"commit_hash":"1a1f9622357464eb465b9be03b0f415591866ff2","branch":"luv-479",
               "repository_url":"git@github.com:FailproofAI/agenteye.git"}}})
    .to_string()
}

fn turn_context(ts: &str, model: &str, cwd: &str) -> String {
    json!({"timestamp":ts,"type":"turn_context","payload":{
        "model":model,"cwd":cwd,"approval_policy":"on-request","sandbox_policy":"workspace-write",
        "turn_id":"019fb1ce-11f7-7411-9a81-8064d135df51","timezone":"Asia/Kolkata"}})
    .to_string()
}

fn user_message_item(ts: &str, texts: &[&str]) -> String {
    let content: Vec<Value> = texts
        .iter()
        .map(|t| json!({"type":"input_text","text":t}))
        .collect();
    json!({"timestamp":ts,"type":"response_item","payload":{
        "type":"message","role":"user","id":null,"content":content}})
    .to_string()
}

fn user_message_event(ts: &str, text: &str) -> String {
    json!({"timestamp":ts,"type":"event_msg","payload":{
        "type":"user_message","message":text,"images":null,"audio":null,
        "local_images":null,"local_audio":null,"text_elements":[]}})
    .to_string()
}

fn assistant_message(ts: &str, text: &str) -> String {
    json!({"timestamp":ts,"type":"response_item","payload":{
        "type":"message","role":"assistant","phase":"final",
        "content":[{"type":"output_text","text":text}]}})
    .to_string()
}

fn custom_tool_call(ts: &str, call_id: &str, name: &str, input: &str) -> String {
    json!({"timestamp":ts,"type":"response_item","payload":{
        "type":"custom_tool_call","name":name,"call_id":call_id,"input":input,
        "id":"ctc_0963a002d749d7f6016a6b080729608195b2a2bcf644068c66","status":"completed"}})
    .to_string()
}

fn custom_tool_call_output(ts: &str, call_id: &str, out: &str) -> String {
    json!({"timestamp":ts,"type":"response_item","payload":{
        "type":"custom_tool_call_output","call_id":call_id,
        "output":[{"type":"input_text","text":"Script completed\nWall time 0.1 seconds\nOutput:\n"},
                  {"type":"input_text","text":out}]}})
    .to_string()
}

fn token_count(ts: &str, input_tokens: u64, output_tokens: u64) -> String {
    json!({"timestamp":ts,"type":"event_msg","payload":{"type":"token_count","info":{
        "last_token_usage":{"input_tokens":input_tokens,"cached_input_tokens":0,
            "cache_write_input_tokens":17116,"output_tokens":output_tokens,
            "reasoning_output_tokens":29,"total_tokens":input_tokens+output_tokens},
        "model_context_window":272000}}})
    .to_string()
}

fn one(line: &str, st: &mut TailState) -> (Option<String>, Vec<Value>) {
    transform::transform_line(line, &ctx(), 0, st)
}

// ── timestamps ──────────────────────────────────────────────────────────────

#[test]
fn a_millisecond_timestamp_is_padded_to_six_digits() {
    // Codex writes milliseconds on every one of the 6,520 lines measured; the
    // hook source emits microseconds. Both streams share a session timeline, so
    // they must sort against each other.
    assert_eq!(
        transform::with_index("2026-07-30T08:14:54.521Z", 0).unwrap(),
        "2026-07-30T08:14:54.521000Z"
    );
    // The index offset orders several events sharing one timestamp.
    assert_eq!(
        transform::with_index("2026-07-30T08:14:54.521Z", 2).unwrap(),
        "2026-07-30T08:14:54.521002Z"
    );
    // A timestamp with no fraction at all still gets the six digits, so the
    // server never sees two shapes.
    assert_eq!(
        transform::with_index("2026-07-30T08:14:54Z", 0).unwrap(),
        "2026-07-30T08:14:54.000000Z"
    );
}

#[test]
fn the_index_offset_saturates_inside_its_second() {
    // Carrying into the next second could reorder an event past a genuinely
    // later line, which is worse than the tie it is fixing.
    let s = transform::with_index("2026-07-30T08:14:54.999999Z", 999).unwrap();
    assert_eq!(s, "2026-07-30T08:14:54.999999Z");
    assert!(s.starts_with("2026-07-30T08:14:54."));
}

#[test]
fn every_emitted_event_carries_a_six_digit_microsecond_timestamp() {
    // The server parses one timestamp shape. A line that slipped through with
    // millisecond precision would sort against hook events incorrectly.
    let mut st = TailState::default();
    let c = ctx();
    let lines = [
        turn_context("2026-07-30T08:14:54.526Z", "gpt-5.6-sol", "/w/repo"),
        user_message_item("2026-07-30T08:14:54.535Z", &["hi codex"]),
        assistant_message("2026-07-30T08:14:58.715Z", "sure"),
        custom_tool_call("2026-07-30T08:14:59.392Z", "call_1", "exec", "{}"),
        custom_tool_call_output("2026-07-30T08:14:59.462Z", "call_1", "ok"),
        token_count("2026-07-30T08:14:59.463Z", 17119, 149),
    ];
    let mut seen = 0;
    for l in &lines {
        let (_, evs) = transform::transform_line(l, &c, 0, &mut st);
        for e in evs {
            let ts = e["timestamp"].as_str().unwrap();
            let frac = ts.rsplit_once('.').unwrap().1.trim_end_matches('Z');
            assert_eq!(frac.len(), 6, "{ts} in {e}");
            seen += 1;
        }
    }
    assert!(seen >= 5, "expected content events, got {seen}");
    // The end event shares that shape, and lands after content in the same ms.
    let end = transform::agent_end(&c, "2026-07-30T08:14:59.463Z", 4096);
    assert_eq!(end["timestamp"], "2026-07-30T08:14:59.463999Z");
    assert_eq!(end["codex_block_index"], 999);
}

// ── conversation ────────────────────────────────────────────────────────────

#[test]
fn a_user_message_becomes_a_model_request_carrying_the_turn_context_model() {
    // A message item names no model — Codex records it once per turn on a
    // `turn_context` line. Without carrying it forward the row renders with no
    // model at all, which is the whole summary the product shows for a request.
    let mut st = TailState::default();
    let (ts, ev) = one(
        &turn_context("2026-07-30T08:14:54.526Z", "gpt-5.6-sol", "/w/repo"),
        &mut st,
    );
    assert_eq!(ts.as_deref(), Some("2026-07-30T08:14:54.526Z"));
    assert!(ev.is_empty(), "turn_context is state, not an event");

    let (_, ev) = one(
        &user_message_item("2026-07-30T08:14:54.535Z", &["hi codex can you login!"]),
        &mut st,
    );
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["type"], "model_request");
    assert_eq!(ev[0]["model"], "gpt-5.6-sol");
    assert_eq!(ev[0]["messages"][0]["role"], "user");
    assert_eq!(ev[0]["messages"][0]["content"], "hi codex can you login!");
}

#[test]
fn a_multi_part_message_stays_one_request_with_one_entry_per_part() {
    // Content is an array of parts of ONE message, not several messages — the
    // largest on disk has 52 parts. Splitting them into 52 events would bury
    // the turn they belong to; dropping all but the first would lose the
    // prompt, since the AGENTS.md injection is part 1 and the ask is part 2.
    let mut st = TailState::default();
    let (_, ev) = one(
        &user_message_item(
            "2026-07-30T08:14:54.526Z",
            &["# AGENTS.md instructions", "please review the diff"],
        ),
        &mut st,
    );
    assert_eq!(ev.len(), 1, "one message must stay one event");
    let msgs = ev[0]["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[1]["content"], "please review the diff");
}

#[test]
fn an_assistant_message_becomes_a_model_response() {
    let mut st = TailState::default();
    let (_, ev) = one(
        &assistant_message("2026-07-30T08:14:58.715Z", "I’ll use the skill."),
        &mut st,
    );
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["type"], "model_response");
    assert_eq!(ev[0]["role"], "assistant");
    assert_eq!(ev[0]["content"], "I’ll use the skill.");
}

#[test]
fn the_duplicate_event_msg_conversation_records_are_not_emitted_a_second_time() {
    // Codex writes every prompt and reply TWICE: once as a `response_item` and
    // once as the UI-facing `event_msg`. Measured 127 `user_message` events
    // against 145 user response items and 284 `agent_message` against 292
    // assistant ones — the response-item stream is the superset, so this side
    // is the one to drop. Emitting both doubles the whole conversation.
    let mut st = TailState::default();
    let (ts, ev) = one(
        &user_message_event("2026-07-30T08:14:54.535Z", "hi codex can you login!"),
        &mut st,
    );
    assert!(ev.is_empty(), "got {ev:?}");
    assert!(ts.is_some(), "the line is still real activity");

    let agent_msg = json!({"timestamp":"2026-07-30T08:14:58.715Z","type":"event_msg",
        "payload":{"type":"agent_message","message":"I’ll use the skill.","phase":"final"}})
    .to_string();
    assert!(one(&agent_msg, &mut st).1.is_empty());
}

// ── tools ───────────────────────────────────────────────────────────────────

#[test]
fn a_custom_tool_call_is_remembered_so_its_result_is_not_a_blank_row() {
    // `custom_tool_call_output` has NO `name` key at all, and it is the
    // dominant result shape on this machine (1,130 of 1,263 tool calls). This
    // is the whole reason TailState carries pending tools.
    let mut st = TailState::default();
    let c = ctx();
    let (_, calls) = transform::transform_line(
        &custom_tool_call(
            "2026-07-30T08:14:59.392Z",
            "call_zUMrvZYyXV042pXRdtNBt0Au",
            "exec",
            r#"const r = await tools.exec_command({"cmd":"agenteye login","workdir":"/w"})"#,
        ),
        &c,
        100,
        &mut st,
    );
    assert_eq!(calls[0]["type"], "tool_use");
    assert_eq!(calls[0]["tool_name"], "exec");
    assert_eq!(calls[0]["tool_call_id"], "call_zUMrvZYyXV042pXRdtNBt0Au");

    let (_, results) = transform::transform_line(
        &custom_tool_call_output(
            "2026-07-30T08:14:59.462Z",
            "call_zUMrvZYyXV042pXRdtNBt0Au",
            "signed in",
        ),
        &c,
        200,
        &mut st,
    );
    assert_eq!(results[0]["type"], "tool_result");
    assert_eq!(
        results[0]["tool_name"], "exec",
        "the name must survive from the call"
    );
    // The array output is flattened to text: Codex splits it into a wall-time
    // preamble block and the real output block.
    let out = results[0]["output"].as_str().unwrap();
    assert!(out.contains("Wall time"), "{out}");
    assert!(out.ends_with("signed in"), "{out}");
}

#[test]
fn a_function_call_result_also_carries_the_name_from_its_call() {
    // `function_call_output.name` is literally `null` on disk, so the payload
    // cannot supply it either.
    let mut st = TailState::default();
    let c = ctx();
    let call = json!({"timestamp":"2026-07-30T06:55:38.017Z","type":"response_item","payload":{
        "type":"function_call","id":"fc_0f953c1fbd9acac4016a6af56e396481959973ed2ef18bce95",
        "name":"wait","arguments":"{\"cell_id\":\"2\",\"yield_time_ms\":30000,\"max_tokens\":30000}",
        "call_id":"call_uJ7ajxc9wWEJMSflYvLev9Y5"}})
    .to_string();
    let (_, calls) = transform::transform_line(&call, &c, 10, &mut st);
    assert_eq!(calls[0]["tool_name"], "wait");
    // `arguments` is a JSON-encoded STRING; it must land as structured input.
    assert_eq!(calls[0]["input"]["cell_id"], "2");
    assert_eq!(calls[0]["input"]["yield_time_ms"], 30000);

    let out = json!({"timestamp":"2026-07-30T06:55:38.059Z","type":"response_item","payload":{
        "type":"function_call_output","call_id":"call_uJ7ajxc9wWEJMSflYvLev9Y5","name":null,
        "output":[{"type":"input_text","text":"Script completed"}]}})
    .to_string();
    let (_, results) = transform::transform_line(&out, &c, 20, &mut st);
    assert_eq!(results[0]["tool_name"], "wait");
    assert_eq!(results[0]["tool_call_id"], "call_uJ7ajxc9wWEJMSflYvLev9Y5");
}

#[test]
fn a_result_whose_call_was_never_seen_still_ships_rather_than_being_dropped() {
    // A tail that starts mid-session, or a session compacted past its own
    // calls, has results with nothing to name them. A named-only rule would
    // silently drop the output; shipping it unnamed keeps the transcript whole.
    let mut st = TailState::default();
    let (_, ev) = one(
        &custom_tool_call_output("2026-07-30T08:14:59.462Z", "call_orphan", "output"),
        &mut st,
    );
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["type"], "tool_result");
    assert_eq!(ev[0]["tool_call_id"], "call_orphan");
    assert!(ev[0].get("tool_name").is_none());
}

#[test]
fn a_javascript_tool_input_still_yields_structured_arguments() {
    // `custom_tool_call.input` is a JS snippet, not JSON — and the model quotes
    // keys inconsistently inside one object. Measured over the 1,130 custom
    // calls on this machine: 0 parse whole, and only 58 lift without repairing
    // bare keys. Without this the other 931 render as an opaque blob.
    let mut st = TailState::default();
    let (_, ev) = one(
        &custom_tool_call(
            "2026-07-30T08:14:59.392Z",
            "c1",
            "exec",
            r#"const r = await tools.exec_command({cmd:"sed -n '1,260p' SKILL.md","workdir":"/w/cli"});text(r.output);"#,
        ),
        &mut st,
    );
    assert_eq!(ev[0]["input"]["cmd"], "sed -n '1,260p' SKILL.md");
    assert_eq!(ev[0]["input"]["workdir"], "/w/cli");
}

#[test]
fn a_destructuring_wrapper_does_not_hide_the_real_arguments() {
    // `let{output,...rest}=await tools.exec_command({...})` puts the arguments
    // in the SECOND brace group. Taking the first would report the
    // destructuring pattern as the tool's input.
    let mut st = TailState::default();
    let (_, ev) = one(
        &custom_tool_call(
            "2026-07-30T08:14:59.392Z",
            "c2",
            "exec",
            r#"let{output,...rest}=await tools.exec_command({"cmd":"pwd","workdir":"/tmp"});text(rest)"#,
        ),
        &mut st,
    );
    assert_eq!(ev[0]["input"]["cmd"], "pwd");
    assert_eq!(ev[0]["input"]["workdir"], "/tmp");
}

#[test]
fn braces_and_colons_inside_a_quoted_value_are_not_mistaken_for_structure() {
    // A shell command routinely contains `{`, `}` and `:`. Repairing keys
    // inside a string literal would corrupt the command actually run.
    let mut st = TailState::default();
    let (_, ev) = one(
        &custom_tool_call(
            "2026-07-30T08:14:59.392Z",
            "c3",
            "exec",
            r#"const r = await tools.exec_command({cmd:"awk '{print $1: \"x\"}' f","workdir":"/w"})"#,
        ),
        &mut st,
    );
    assert_eq!(ev[0]["input"]["cmd"], r#"awk '{print $1: "x"}' f"#);
    assert_eq!(ev[0]["input"]["workdir"], "/w");
}

#[test]
fn an_unparseable_tool_input_is_kept_verbatim_rather_than_dropped() {
    // 141 of the custom calls on disk are apply_patch scripts whose arguments
    // never parse. Losing the text would leave the row with no input at all.
    let mut st = TailState::default();
    let script = "const patch = \"*** Begin Patch\\n*** Update File: a.rs\";";
    let (_, ev) = one(
        &custom_tool_call("2026-07-30T08:14:59.392Z", "c4", "exec", script),
        &mut st,
    );
    assert_eq!(ev[0]["input"]["raw"], script);
}

#[test]
fn a_token_count_line_becomes_a_model_response_carrying_usage() {
    // Codex bills a turn on its own line, in the same millisecond as the item
    // it bills. Attaching it to that item would need cross-line buffering,
    // which is exactly what a re-read cannot reproduce.
    let mut st = TailState::default();
    let (_, ev) = one(
        &turn_context("2026-07-30T08:14:54.526Z", "gpt-5.6-sol", "/w"),
        &mut st,
    );
    assert!(ev.is_empty());
    let (_, ev) = one(
        &token_count("2026-07-30T08:14:59.463Z", 17119, 149),
        &mut st,
    );
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["type"], "model_response");
    assert_eq!(ev[0]["input_tokens"], 17119);
    assert_eq!(ev[0]["output_tokens"], 149);
    assert_eq!(ev[0]["model"], "gpt-5.6-sol");
    assert_eq!(ev[0]["codex_usage"]["total_tokens"], 17268);
}

// ── skipping, purity, dedup ─────────────────────────────────────────────────

#[test]
fn an_unrecognised_record_is_skipped_without_needing_a_type_allowlist() {
    // Real rollouts carry world_state, compacted, task_started,
    // thread_settings_applied and reasoning records, and each Codex release
    // adds more. Every branch falls through to "no events", so a new record
    // type costs nothing — but the line still reports its timestamp, because
    // it IS activity and `agent_end` should reflect when the file last moved.
    let mut st = TailState::default();
    for line in [
        r#"{"timestamp":"2026-07-30T08:14:54.526Z","type":"world_state","payload":{"full":true,"state":{}}}"#,
        r#"{"timestamp":"2026-07-30T08:14:58.219Z","type":"response_item","payload":{"type":"reasoning","encrypted_content":"gAAAA","summary":[]}}"#,
        r#"{"timestamp":"2026-07-30T08:14:54.521Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}"#,
        r#"{"timestamp":"2026-07-30T08:14:54.521Z","type":"a_type_from_a_future_release","payload":{"x":1}}"#,
    ] {
        let (ts, ev) = one(line, &mut st);
        assert!(ev.is_empty(), "{line} produced {ev:?}");
        assert!(ts.is_some(), "{line} must still advance the clock");
    }
}

#[test]
fn session_meta_yields_no_event_here_because_the_engine_owns_agent_start() {
    // Emitting it from both places would give the session two start events at
    // the same offset, which the server cannot dedup because they differ.
    let mut st = TailState::default();
    let (ts, ev) = one(
        &session_meta("2026-07-30T08:14:54.521Z", "/home/u/repo"),
        &mut st,
    );
    assert!(ev.is_empty());
    assert_eq!(ts.as_deref(), Some("2026-07-30T08:14:54.521Z"));
}

#[test]
fn a_malformed_or_untimestamped_line_yields_nothing_at_all() {
    // A truncated final line parses as nothing and must not advance the clock:
    // recording its timestamp would seed `agent_end` from a record that does
    // not exist yet.
    let mut st = TailState::default();
    for line in [
        r#"{"timestamp":"2026-07-30T08:14:54.5"#,
        r#"{"type":"response_item","payload":{"type":"message"}}"#,
        r#"{"timestamp":"2026-07-30 08:14:54","type":"event_msg","payload":{}}"#,
        "not json at all",
    ] {
        let (ts, ev) = one(line, &mut st);
        assert!(ts.is_none(), "{line}");
        assert!(ev.is_empty(), "{line}");
    }
}

#[test]
fn two_identical_lines_at_different_offsets_produce_different_events() {
    // The offset is the dedup discriminator. Without it the server would
    // collapse a genuinely repeated turn into one row — and Codex repeats
    // turns verbatim when a command is retried.
    let mut st = TailState::default();
    let c = ctx();
    let line = user_message_item("2026-07-30T08:14:54.535Z", &["same"]);
    let (_, a) = transform::transform_line(&line, &c, 10, &mut st);
    let (_, b) = transform::transform_line(&line, &c, 999, &mut st);
    assert_ne!(a[0]["codex_line_offset"], b[0]["codex_line_offset"]);
    assert_eq!(a[0]["codex_line_offset"], 10);
    assert_eq!(b[0]["codex_line_offset"], 999);
}

#[test]
fn the_transform_is_pure_so_a_re_read_reproduces_byte_identical_events() {
    // The server dedups on a content hash. A live tail and a later full
    // re-read must therefore agree exactly, or the same turn is stored twice.
    let c = ctx();
    let lines = [
        session_meta("2026-07-30T08:14:54.521Z", "/w/repo"),
        turn_context("2026-07-30T08:14:54.526Z", "gpt-5.6-sol", "/w/repo"),
        user_message_item("2026-07-30T08:14:54.535Z", &["hello"]),
        custom_tool_call("2026-07-30T08:14:59.392Z", "c1", "exec", "{cmd:\"ls\"}"),
        custom_tool_call_output("2026-07-30T08:14:59.462Z", "c1", "a b c"),
        token_count("2026-07-30T08:14:59.463Z", 10, 2),
    ];
    let render = || {
        let mut st = TailState::default();
        let mut out = Vec::new();
        for (i, l) in lines.iter().enumerate() {
            let (_, ev) = transform::transform_line(l, &c, (i * 400) as u64, &mut st);
            out.extend(ev);
        }
        serde_json::to_string(&out).unwrap()
    };
    assert_eq!(render(), render());
    // …and the carried state is reproduced too, not just the events.
    let mut st = TailState::default();
    for (i, l) in lines.iter().enumerate() {
        transform::transform_line(l, &c, (i * 400) as u64, &mut st);
    }
    assert_eq!(st.last_model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(st.tool_name("c1"), Some("exec"));
}

// ── format table ────────────────────────────────────────────────────────────

#[test]
fn discovery_claims_rollout_files_and_rejects_everything_else() {
    let is = codex::FORMAT.is_source_file;
    assert!(is(Path::new(&format!("/s/2026/07/30/{ROLLOUT}"))));

    // Archived rollouts are compressed and in-progress writes land on `.tmp`;
    // a byte cursor over either would ship garbage or re-ship forever.
    assert!(!is(Path::new(&format!("/s/2026/07/30/{ROLLOUT}.zst"))));
    assert!(!is(Path::new(&format!("/s/2026/07/30/{ROLLOUT}.tmp"))));
    // Codex's other JSONL files. They live outside `sessions/`, but a widened
    // root must not turn them into sessions under a synthetic id.
    assert!(!is(Path::new("/home/u/.codex/history.jsonl")));
    assert!(!is(Path::new("/home/u/.codex/session_index.jsonl")));
    // Right prefix, no uuid — a future sibling in the same tree.
    assert!(!is(Path::new("/s/2026/07/30/rollout-index.jsonl")));
    // The date half of the name is also digits and dashes; a loose uuid check
    // would slice a session id out of the middle of it.
    assert!(!is(Path::new(
        "/s/2026/07/30/rollout-2026-07-30T13-44-44.jsonl"
    )));
}

#[test]
fn the_session_id_is_the_uuid_embedded_in_the_filename() {
    assert_eq!(
        (codex::FORMAT.session_id_from_path)(Path::new(&format!("/s/2026/07/30/{ROLLOUT}")))
            .as_deref(),
        Some(UUID)
    );
}

#[test]
fn the_session_id_comes_from_the_filename_not_from_session_meta() {
    // On a subagent rollout `session_meta.session_id` is the PARENT thread's
    // id while `payload.id` is this file's — measured on the one such rollout
    // on this machine. Keying on `session_id` would merge a subagent's whole
    // transcript into its parent's timeline.
    let child = "019f99a1-e351-7c51-847e-afa614efe23e";
    let parent = "019f999d-3d83-7ff2-a783-846cc1cbecd1";
    let path = format!("/s/2026/07/25/rollout-2026-07-25T19-45-51-{child}.jsonl");
    assert_eq!(
        (codex::FORMAT.session_id_from_path)(Path::new(&path)).as_deref(),
        Some(child)
    );

    let header = vec![
        json!({"timestamp":"2026-07-25T14:15:51.414Z","type":"session_meta","payload":{
            "id":child,"session_id":parent,"parent_thread_id":parent,
            "cwd":"/home/u/src/agenteye","cli_version":"0.145.0"}})
        .to_string(),
    ];
    let c = Ctx {
        session_id: child.into(),
        ..ctx()
    };
    let (ev, _) = (codex::FORMAT.agent_start)(&header, &c, 0).unwrap();
    assert_eq!(ev["session_id"], child);
    assert_eq!(ev["parent_id"], parent, "the parent is carried, not merged");
}

#[test]
fn the_agent_id_comes_from_the_real_cwd_because_the_path_is_only_a_date() {
    // `sessions/2026/07/30/` records the day and nothing about the work, so
    // without reading the header every project on the machine files under one
    // agent id and the product cannot tell them apart.
    let header = vec![session_meta(
        "2026-07-30T08:14:54.521Z",
        "/home/u/Desktop/work/agenteye/cli",
    )];
    let derived =
        (codex::FORMAT.agent_id_from_path)(Path::new(&format!("/s/2026/07/30/{ROLLOUT}")), &header);
    assert_eq!(derived.as_deref(), Some("codex-cli"));
}

#[test]
fn the_agent_id_falls_back_to_turn_context_when_session_meta_is_unreadable() {
    // A rollout discovered while its first line is still being written has no
    // parseable `session_meta`, but `turn_context` repeats the same cwd.
    let header = vec![
        "{\"timestamp\":\"2026-07-30T08:14:54.5".to_string(),
        turn_context("2026-07-30T08:14:54.526Z", "gpt-5.6-sol", "/home/u/repo/"),
    ];
    assert_eq!(
        (codex::FORMAT.agent_id_from_path)(Path::new(&format!("/s/{ROLLOUT}")), &header).as_deref(),
        Some("codex-repo")
    );
}

#[test]
fn the_derived_agent_id_matches_the_scheme_the_hook_source_uses() {
    // A hook event and the rollout events for the same run must land under one
    // agent. The two sources derive the id independently, so this is the only
    // thing keeping them from drifting into two agents that look unrelated.
    let cwd = "/home/u/src/openclaw-local";
    let header = vec![session_meta("2026-07-30T08:14:54.521Z", cwd)];
    let from_rollout =
        (codex::FORMAT.agent_id_from_path)(Path::new(&format!("/s/{ROLLOUT}")), &header).unwrap();
    let from_hooks = hook_agent_id(&HookRow {
        timestamp: 1_754_000_000_000,
        event_type: Some("PreToolUse".into()),
        integration: Some("codex".into()),
        tool_name: Some("Bash".into()),
        decision: Some("allow".into()),
        session_id: Some(UUID.into()),
        cwd: Some(cwd.into()),
        // The agent id is derived from cwd and integration alone; the rest is
        // irrelevant to it, and spelling it out invites this to break on every
        // field the store gains.
        ..Default::default()
    });
    assert_eq!(from_rollout, from_hooks);
    assert_eq!(from_rollout, "codex-openclaw-local");
}

#[test]
fn the_agent_start_carries_the_first_human_prompt_as_the_goal() {
    // Taken from `event_msg.user_message`, not the user response items around
    // it: those also carry the injected AGENTS.md and permission preamble, so
    // the response-item stream would make a config file the session's goal.
    let header = vec![
        session_meta("2026-07-30T08:14:54.521Z", "/home/u/repo"),
        user_message_item("2026-07-30T08:14:54.526Z", &["<permissions instructions>"]),
        user_message_item("2026-07-30T08:14:54.526Z", &["# AGENTS.md instructions"]),
        turn_context("2026-07-30T08:14:54.526Z", "gpt-5.6-sol", "/home/u/repo"),
        user_message_item("2026-07-30T08:14:54.535Z", &["log into agenteye-cli"]),
        user_message_event("2026-07-30T08:14:54.535Z", "log into agenteye-cli"),
    ];
    let (ev, ts) = (codex::FORMAT.agent_start)(&header, &ctx(), 0).unwrap();
    assert_eq!(ev["type"], "agent_start");
    assert_eq!(ev["goal"], "log into agenteye-cli");
    assert_eq!(ev["codex_cwd"], "/home/u/repo");
    assert_eq!(ev["codex_cli_version"], "0.146.0");
    assert_eq!(ev["codex_git_branch"], "luv-479");
    assert_eq!(ev["timestamp"], "2026-07-30T08:14:54.521000Z");
    assert_eq!(ts.as_deref(), Some("2026-07-30T08:14:54.521Z"));
}

#[test]
fn a_rollout_with_no_session_meta_still_gets_an_agent_start_not_an_end() {
    // The upstream collector emitted an `agent_end` from this fallback while
    // still latching the "started" flag. The server selects sessions on
    // `agent_start`, so the session never appeared in `GET /sessions` — and
    // because the flag was latched it could never start, and so could never
    // end either. One wrong constant made the session permanently invisible.
    let header = vec![
        "{\"timestamp\":\"2026-07-30T08:14:5".to_string(), // truncated line 1
        turn_context("2026-07-30T08:14:54.526Z", "gpt-5.6-sol", "/home/u/repo"),
        user_message_event("2026-07-30T08:14:54.535Z", "carry on"),
    ];
    let (ev, ts) = (codex::FORMAT.agent_start)(&header, &ctx(), 0).unwrap();
    assert_eq!(ev["type"], "agent_start", "NEVER agent_end: {ev}");
    assert_eq!(ev["codex_cwd"], "/home/u/repo");
    assert_eq!(ev["goal"], "carry on");
    assert_eq!(ts.as_deref(), Some("2026-07-30T08:14:54.526Z"));
}

#[test]
fn a_header_with_no_usable_line_produces_no_start_so_it_can_be_retried() {
    // The engine retries `agent_start` every poll until it succeeds. Inventing
    // one from an empty header would latch the flag against a timestamp that
    // does not exist.
    assert!((codex::FORMAT.agent_start)(&[], &ctx(), 0).is_none());
    assert!((codex::FORMAT.agent_start)(&["{ broken".to_string()], &ctx(), 0).is_none());
}

#[test]
fn codex_declares_itself_byte_tailable() {
    // Rollouts are strictly appended — unlike factory/droid, Codex never
    // rewrites line 1 to name the session, because the name is in the path.
    assert_eq!(codex::FORMAT.reread, RereadPolicy::ByteCursor);
    assert_eq!(codex::FORMAT.kind, "codex");
}

// ── engine ──────────────────────────────────────────────────────────────────

fn spec(root: PathBuf, spool: PathBuf, state: PathBuf) -> Spec {
    Spec {
        format: codex::FORMAT,
        roots: vec![root],
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(200),
        params: Params {
            agent_id: codex::DEFAULT_AGENT_ID.into(),
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

async fn run_briefly(s: Spec, ms: u64) {
    let sd = Shutdown::for_test(Arc::new(AtomicBool::new(false)));
    let _ = tokio::time::timeout(Duration::from_millis(ms), filetail::run(s, sd)).await;
}

fn clear(spool: &Path) {
    for e in fs::read_dir(spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }
}

/// A rollout in the real `sessions/<YYYY>/<MM>/<DD>/` tree.
fn write_rollout(root: &Path, lines: &[String]) -> PathBuf {
    let day = root.join("2026").join("07").join("30");
    fs::create_dir_all(&day).unwrap();
    let p = day.join(ROLLOUT);
    fs::write(&p, lines.join("\n") + "\n").unwrap();
    p
}

fn full_session() -> Vec<String> {
    vec![
        session_meta("2026-07-30T08:14:54.521Z", "/home/u/repo/cli"),
        turn_context(
            "2026-07-30T08:14:54.526Z",
            "gpt-5.6-sol",
            "/home/u/repo/cli",
        ),
        user_message_item("2026-07-30T08:14:54.535Z", &["list the files"]),
        user_message_event("2026-07-30T08:14:54.535Z", "list the files"),
        assistant_message("2026-07-30T08:14:58.715Z", "running it now"),
        custom_tool_call(
            "2026-07-30T08:14:59.392Z",
            "call_1",
            "exec",
            r#"const r = await tools.exec_command({cmd:"ls -la","workdir":"/home/u/repo/cli"})"#,
        ),
        custom_tool_call_output("2026-07-30T08:14:59.462Z", "call_1", "total 4"),
        token_count("2026-07-30T08:14:59.463Z", 17119, 149),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_produces_a_start_its_turns_and_an_end() {
    let root = tmpdir("full-root");
    let spool = tmpdir("full-spool");
    let state = tmpdir("full-state");
    write_rollout(&root, &full_session());

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

    // Every event carries the session id from the FILENAME, so hook events for
    // the same run land on this timeline, and the agent id from the real cwd.
    for e in &ev {
        assert_eq!(e["session_id"], UUID);
        assert_eq!(e["agent_id"], "codex-cli", "agent id must come from cwd");
        assert!(e.get("codex_line_offset").is_some(), "{e}");
    }
    // The tool result is named, which is the point of carrying the name.
    let result = ev.iter().find(|e| e["type"] == "tool_result").unwrap();
    assert_eq!(result["tool_name"], "exec");
    // The prompt is emitted once, not twice, despite Codex writing it twice.
    let prompts = ev
        .iter()
        .filter(|e| e["messages"][0]["content"] == "list the files")
        .count();
    assert_eq!(prompts, 1, "the event_msg duplicate must not ship");

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_pass_ships_nothing_new() {
    let root = tmpdir("resume-root");
    let spool = tmpdir("resume-spool");
    let state = tmpdir("resume-state");
    write_rollout(&root, &full_session());

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
    let root = tmpdir("append-root");
    let spool = tmpdir("append-spool");
    let state = tmpdir("append-state");
    let path = write_rollout(&root, &full_session());

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let first = spooled(&spool).len();
    clear(&spool);

    let mut body = fs::read_to_string(&path).unwrap();
    body.push_str(&(user_message_item("2026-07-30T08:20:00.000Z", &["second"]) + "\n"));
    fs::write(&path, body).unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let ev = spooled(&spool);
    assert!(!ev.is_empty(), "the appended turn must ship");
    assert!(
        ev.len() < first,
        "earlier turns must not be re-shipped: {} of {first}",
        ev.len()
    );
    assert!(
        ev.iter().any(|e| e["messages"][0]["content"] == "second"),
        "the new prompt must be present"
    );
    assert!(
        !ev.iter()
            .any(|e| e["messages"][0]["content"] == "list the files"),
        "the earlier prompt must not repeat"
    );

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_partially_written_final_line_is_held_back_then_picked_up() {
    // Codex appends a line at a time; a poll landing mid-write sees half a JSON
    // object. Consuming it would skip the record when it completes.
    let root = tmpdir("partial-root");
    let spool = tmpdir("partial-spool");
    let state = tmpdir("partial-state");
    let day = root.join("2026").join("07").join("30");
    fs::create_dir_all(&day).unwrap();
    let path = day.join(ROLLOUT);

    let mut complete = full_session();
    let tail = user_message_item("2026-07-30T08:20:00.000Z", &["finished"]);
    fs::write(
        &path,
        format!(
            "{}\n{}",
            complete.join("\n"),
            &tail[..tail.len() / 2] // torn mid-object
        ),
    )
    .unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    assert!(
        !spooled(&spool)
            .iter()
            .any(|e| e["messages"][0]["content"] == "finished"),
        "a torn line must not ship"
    );
    clear(&spool);

    complete.push(tail);
    fs::write(&path, complete.join("\n") + "\n").unwrap();
    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    assert!(
        spooled(&spool)
            .iter()
            .any(|e| e["messages"][0]["content"] == "finished"),
        "the completed line must ship on a later pass"
    );

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rollout_whose_header_is_still_being_written_is_not_lost() {
    // `agent_start` is retried every poll. A file discovered before its
    // `session_meta` is flushed must still register once it lands, or the
    // session is absent from the product for good.
    let root = tmpdir("late-root");
    let spool = tmpdir("late-spool");
    let state = tmpdir("late-state");
    let day = root.join("2026").join("07").join("30");
    fs::create_dir_all(&day).unwrap();
    let path = day.join(ROLLOUT);
    fs::write(&path, "").unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 800).await;
    assert!(spooled(&spool).is_empty(), "nothing to start from yet");
    clear(&spool);

    fs::write(&path, full_session().join("\n") + "\n").unwrap();
    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let ev = spooled(&spool);
    let start = ev.iter().find(|e| e["type"] == "agent_start");
    assert!(start.is_some(), "got {:?}", ev.len());
    assert_eq!(start.unwrap()["goal"], "list the files");

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}
