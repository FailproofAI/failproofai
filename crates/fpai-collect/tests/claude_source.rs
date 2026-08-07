//! Claude source: transform correctness and engine behaviour.
//!
//! Record shapes are verbatim from real transcripts under `~/.claude/projects/`
//! (Claude Code 2.1.x).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::cursor::TailState;
use fpai_collect::filetail::{self, Ctx, Params, RereadPolicy, Spec};
use fpai_collect::sources::claude::{self, transform};
use fpai_collect::supervisor::Shutdown;
use serde_json::{Value, json};

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-cl-{}-{}-{}",
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
        session_id: "fb9f0d4f-f739-4069-ac16-9add45fd2506".into(),
        agent_id: "claude-repo".into(),
        environment: "local".into(),

        ..Default::default()
    }
}

const UUID: &str = "fb9f0d4f-f739-4069-ac16-9add45fd2506";

fn user_prompt(ts: &str, text: &str) -> String {
    json!({"type":"user","uuid":"u1","timestamp":ts,"cwd":"/home/u/repo",
           "message":{"role":"user","content":text}})
    .to_string()
}

fn assistant_tool_use(ts: &str, call_id: &str, name: &str) -> String {
    json!({"type":"assistant","timestamp":ts,
      "message":{"model":"claude-opus-4-8","id":"msg_01","type":"message","role":"assistant",
        "content":[{"type":"tool_use","id":call_id,"name":name,"input":{"command":"ls -la"}}],
        "stop_reason":"tool_use",
        "usage":{"input_tokens":2,"output_tokens":91,"cache_read_input_tokens":100}}})
    .to_string()
}

fn tool_result(ts: &str, call_id: &str, out: &str, is_error: bool) -> String {
    json!({"type":"user","timestamp":ts,
      "message":{"role":"user","content":[
        {"type":"tool_result","tool_use_id":call_id,"content":out,"is_error":is_error}]}})
    .to_string()
}

// ── transform ────────────────────────────────────────────────────────────

#[test]
fn a_millisecond_timestamp_is_padded_to_microseconds() {
    // Claude writes milliseconds; the hook source emits microseconds. Both
    // streams share a session timeline, so they must sort against each other.
    assert_eq!(
        transform::with_index("2026-07-18T09:42:04.058Z", 0).unwrap(),
        "2026-07-18T09:42:04.058000Z"
    );
    // The index offset orders several events derived from ONE line.
    assert_eq!(
        transform::with_index("2026-07-18T09:42:04.058Z", 2).unwrap(),
        "2026-07-18T09:42:04.058002Z"
    );
}

#[test]
fn the_index_offset_saturates_inside_its_second() {
    // Carrying into the next second could reorder an event past a genuinely
    // later line, which is worse than the tie it is fixing.
    let s = transform::with_index("2026-07-18T09:42:04.999999Z", 999).unwrap();
    assert_eq!(s, "2026-07-18T09:42:04.999999Z");
    assert!(s.starts_with("2026-07-18T09:42:04."));
}

#[test]
fn a_user_prompt_becomes_a_model_request_carrying_the_inherited_model() {
    let mut st = TailState {
        last_model: Some("claude-opus-4-8".into()),
        ..Default::default()
    };
    let (ts, ev) = transform::transform_line(
        &user_prompt("2026-07-18T09:42:04.058Z", "hello"),
        &ctx(),
        0,
        &mut st,
    );
    assert_eq!(ts.as_deref(), Some("2026-07-18T09:42:04.058Z"));
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["type"], "model_request");
    // A user line names no model; without inheritance this row renders blank.
    assert_eq!(ev[0]["model"], "claude-opus-4-8");
    assert_eq!(ev[0]["messages"][0]["content"], "hello");
}

#[test]
fn a_tool_call_is_remembered_so_its_result_is_not_a_blank_row() {
    // The tool's name appears on NO result line. This is the whole reason
    // TailState carries pending tools.
    let mut st = TailState::default();
    let c = ctx();
    let (_, calls) = transform::transform_line(
        &assistant_tool_use("2026-07-18T09:42:05.000Z", "toolu_01", "Bash"),
        &c,
        100,
        &mut st,
    );
    assert_eq!(calls[0]["type"], "tool_use");
    assert_eq!(calls[0]["tool_name"], "Bash");
    assert_eq!(calls[0]["tool_call_id"], "toolu_01");

    let (_, results) = transform::transform_line(
        &tool_result("2026-07-18T09:42:06.000Z", "toolu_01", "total 4", false),
        &c,
        200,
        &mut st,
    );
    assert_eq!(results[0]["type"], "tool_result");
    assert_eq!(
        results[0]["tool_name"], "Bash",
        "the name must survive from the call"
    );
    assert_eq!(results[0]["output"], "total 4");
}

#[test]
fn an_errored_tool_result_carries_a_non_empty_error() {
    let mut st = TailState::default();
    let c = ctx();
    transform::transform_line(
        &assistant_tool_use("2026-07-18T09:42:05.000Z", "t1", "Bash"),
        &c,
        0,
        &mut st,
    );
    let (_, ev) = transform::transform_line(
        &tool_result("2026-07-18T09:42:06.000Z", "t1", "Exit code 255", true),
        &c,
        10,
        &mut st,
    );
    assert_eq!(ev[0]["error_type"], "claude_tool_error");
    assert!(!ev[0]["error"].as_str().unwrap().is_empty());
}

#[test]
fn token_usage_is_counted_once_per_message_id() {
    // One API response spans several lines that each repeat the SAME usage
    // object. Counting per line inflates token totals several-fold.
    let mut st = TailState::default();
    let c = ctx();
    let line = assistant_tool_use("2026-07-18T09:42:05.000Z", "t1", "Bash");

    let (_, first) = transform::transform_line(&line, &c, 0, &mut st);
    assert!(
        first[0].get("input_tokens").is_some(),
        "first line bills usage"
    );

    // Same message id again, at a different offset.
    let (_, second) = transform::transform_line(&line, &c, 500, &mut st);
    assert!(
        second[0].get("input_tokens").is_none(),
        "a repeated message id must not be billed twice"
    );
}

#[test]
fn a_metadata_line_is_skipped_without_needing_a_type_allowlist() {
    // Real transcripts carry mode / file-history-snapshot / ai-title records.
    // They have no timestamp, which is what excludes them — so a new record
    // type in a future Claude release costs nothing.
    let mut st = TailState::default();
    let (ts, ev) = transform::transform_line(
        r#"{"type":"file-history-snapshot","messageId":"x","snapshot":{}}"#,
        &ctx(),
        0,
        &mut st,
    );
    assert!(ts.is_none());
    assert!(ev.is_empty());
}

// ── thinking blocks ──────────────────────────────────────────────────────

/// The shape every thinking block on this machine has: empty text, opaque
/// signature. 7,687 of 7,687.
fn thinking_line(ts: &str, msg_id: &str, thinking: &str) -> String {
    json!({"type":"assistant","timestamp":ts,
      "message":{"model":"claude-opus-4-8","id":msg_id,"role":"assistant",
        "content":[{"type":"thinking","thinking":thinking,"signature":"CAIS0pen4queblob"}],
        "usage":{"input_tokens":2,"output_tokens":3223}}})
    .to_string()
}

#[test]
fn an_empty_thinking_block_produces_no_event_at_all() {
    // Measured: 7,687 of 7,687 blocks on this machine carry `"thinking": ""`
    // and nothing but a signature. One event each would be 7,687 blank rows.
    let mut st = TailState::default();
    let (ts, ev) = transform::transform_line(
        &thinking_line("2026-07-18T09:42:05.000Z", "msg_T", ""),
        &ctx(),
        0,
        &mut st,
    );
    assert_eq!(ts.as_deref(), Some("2026-07-18T09:42:05.000Z"));
    assert!(ev.is_empty(), "an empty thinking block must ship nothing");
}

#[test]
fn a_thinking_block_that_does_carry_text_is_shipped() {
    // The arm exists so a future Claude that populates the field arrives as
    // data rather than as a silent gap. Costs nothing while they are all empty.
    let mut st = TailState::default();
    let (_, ev) = transform::transform_line(
        &thinking_line("2026-07-18T09:42:05.000Z", "msg_T", "let me reconsider"),
        &ctx(),
        0,
        &mut st,
    );
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["type"], "model_response");
    assert_eq!(ev[0]["claude_kind"], "thinking");
    assert_eq!(ev[0]["content"], "let me reconsider");
}

#[test]
fn a_thinking_only_line_does_not_swallow_its_message_groups_tokens() {
    // Claude writes the thinking block as its own line at the HEAD of a
    // message-id group. Claiming the group on sight of the id would bill a line
    // that emits nothing, and the group's tokens would vanish — 7,699 of 11,213
    // groups on this machine begin with such a line, worth 8.4M of 10.3M output
    // tokens. The claim belongs to the first line that actually emits.
    let mut st = TailState::default();
    let c = ctx();

    // `msg_01` is also the id `assistant_tool_use` writes — the same group.
    let (_, none) = transform::transform_line(
        &thinking_line("2026-07-18T09:42:05.000Z", "msg_01", ""),
        &c,
        0,
        &mut st,
    );
    assert!(none.is_empty());

    // Same message id, the line that carries the visible turn.
    let (_, ev) = transform::transform_line(
        &assistant_tool_use("2026-07-18T09:42:05.100Z", "toolu_9", "Bash"),
        &c,
        200,
        &mut st,
    );
    assert_eq!(
        ev[0]["output_tokens"], 91,
        "the group's tokens must land on the line that emits"
    );
}

// ── compact boundaries ───────────────────────────────────────────────────

fn compact_boundary(ts: &str) -> String {
    json!({"type":"system","subtype":"compact_boundary","content":"Conversation compacted",
      "level":"info","timestamp":ts,"cwd":"/home/u/repo",
      "compactMetadata":{"trigger":"auto","preTokens":1000616,"postTokens":15316,
        "cumulativeDroppedTokens":985300,"durationMs":128718,
        "preservedMessages":{"uuids":["a","b","c"]}}})
    .to_string()
}

#[test]
fn a_compact_boundary_records_the_context_reset_with_its_metadata() {
    // The only on-disk record that the context was thrown away. Without it a
    // session shows a prompt answered from a summary that is nowhere visible.
    let mut st = TailState {
        last_model: Some("claude-opus-4-8".into()),
        ..Default::default()
    };
    let (ts, ev) = transform::transform_line(&compact_boundary(COMPACT_TS), &ctx(), 42, &mut st);
    assert_eq!(ts.as_deref(), Some(COMPACT_TS));
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["type"], "model_request");
    assert_eq!(ev[0]["claude_kind"], "compact_boundary");
    assert_eq!(ev[0]["claude_compact_trigger"], "auto");
    assert_eq!(ev[0]["claude_compact_pre_tokens"], 1_000_616u64);
    assert_eq!(ev[0]["claude_compact_post_tokens"], 15_316u64);
    assert_eq!(ev[0]["claude_compact_dropped_tokens"], 985_300u64);
    assert_eq!(ev[0]["duration_ms"], 128_718u64);
    // The server builds a model_request's summary from the model alone, so this
    // row would otherwise render blank.
    assert_eq!(ev[0]["model"], "claude-opus-4-8");
    assert_eq!(ev[0]["claude_line_offset"], 42);
    // A uuid index that grows with the preserved window: volume, no signal.
    assert!(ev[0].get("preservedMessages").is_none());
}

const COMPACT_TS: &str = "2026-07-18T09:50:00.000Z";

#[test]
fn other_system_subtypes_ship_nothing() {
    // Six other subtypes occur on this machine. Modelling them all would turn
    // turn_duration alone (659 lines) into pure volume.
    let mut st = TailState::default();
    let line = json!({"type":"system","subtype":"turn_duration","durationMs":135759,
                      "messageCount":71,"timestamp":COMPACT_TS})
    .to_string();
    let (ts, ev) = transform::transform_line(&line, &ctx(), 0, &mut st);
    assert_eq!(
        ts.as_deref(),
        Some(COMPACT_TS),
        "the line is still consumed"
    );
    assert!(ev.is_empty());
}

// ── synthetic / failed assistant turns ───────────────────────────────────

#[test]
fn an_aborted_turn_becomes_an_error_with_a_non_empty_message() {
    // The server's is_error is a truthiness check on the message, so an empty
    // one would render a failed turn as a success.
    let mut st = TailState::default();
    let line = json!({"type":"assistant","timestamp":"2026-07-18T09:42:05.000Z",
      "isAbortedMidStream":true,
      "message":{"model":"claude-opus-4-8","id":"msg_A","role":"assistant",
        "content":[{"type":"text","text":"Let me read the exact redaction sec"}],
        "usage":{"input_tokens":2,"output_tokens":5}}})
    .to_string();
    let (_, ev) = transform::transform_line(&line, &ctx(), 0, &mut st);
    assert_eq!(ev.len(), 1, "the failure replaces the turn, got {ev:?}");
    assert_eq!(ev[0]["type"], "error");
    assert_eq!(ev[0]["error_type"], "claude_aborted");
    assert!(!ev[0]["message"].as_str().unwrap().is_empty());
    // Deliberately unbilled: a failed turn's usage is not a served response.
    assert!(ev[0].get("input_tokens").is_none());
    assert!(ev[0].get("output_tokens").is_none());
}

#[test]
fn an_api_error_turn_with_no_content_still_says_something() {
    // A failed turn is precisely the one with no content, so a
    // "only if non-empty" guard would drop exactly the rows that matter.
    let mut st = TailState::default();
    let line = json!({"type":"assistant","timestamp":"2026-07-18T09:42:05.000Z",
      "isApiErrorMessage":true,
      "message":{"model":"claude-opus-4-8","id":"msg_E","role":"assistant","content":[]}})
    .to_string();
    let (_, ev) = transform::transform_line(&line, &ctx(), 0, &mut st);
    assert_eq!(ev[0]["type"], "error");
    assert_eq!(ev[0]["error_type"], "claude_api_error");
    assert!(!ev[0]["message"].as_str().unwrap().is_empty());
}

#[test]
fn claude_codes_own_error_label_wins_over_the_derived_one() {
    // `"server_error"` is the string an operator can group on; the marker names
    // are only what is left when Claude Code wrote no label.
    let mut st = TailState::default();
    let line = json!({"type":"assistant","timestamp":"2026-07-18T09:42:05.000Z",
      "isApiErrorMessage":true,"error":"server_error",
      "message":{"model":"<synthetic>","id":"m","role":"assistant",
        "content":[{"type":"text","text":"API Error: Connection closed."}]}})
    .to_string();
    let (_, ev) = transform::transform_line(&line, &ctx(), 0, &mut st);
    assert_eq!(ev[0]["error_type"], "server_error");
    assert_eq!(ev[0]["message"], "API Error: Connection closed.");
}

#[test]
fn a_synthetic_model_never_leaks_into_the_next_user_turn() {
    // `<synthetic>` is a placeholder, not a model anyone served. Letting it into
    // carried state would stamp it as the model on every later prompt and send
    // the context-window lookup after an id that can never resolve.
    let mut st = TailState::default();
    let c = ctx();
    transform::transform_line(
        &assistant_tool_use("2026-07-18T09:42:05.000Z", "t1", "Bash"),
        &c,
        0,
        &mut st,
    );
    let synthetic = json!({"type":"assistant","timestamp":"2026-07-18T09:42:06.000Z",
      "message":{"model":"<synthetic>","id":"m2","role":"assistant","stop_reason":"stop_sequence",
        "content":[{"type":"text","text":"No response requested."}],
        "usage":{"input_tokens":0,"output_tokens":0}}})
    .to_string();
    let (_, ev) = transform::transform_line(&synthetic, &c, 100, &mut st);
    assert_eq!(ev[0]["type"], "error");
    assert_eq!(ev[0]["error_type"], "claude_synthetic");

    let (_, prompt) = transform::transform_line(
        &user_prompt("2026-07-18T09:42:07.000Z", "next"),
        &c,
        200,
        &mut st,
    );
    assert_eq!(
        prompt[0]["model"], "claude-opus-4-8",
        "the real model must survive the synthetic turn"
    );
}

#[test]
fn a_synthetic_turn_does_not_claim_the_real_responses_token_group() {
    // A synthetic line is interleaved INSIDE a real message-id group and its
    // usage object is all zeros. Letting it claim the group would zero out the
    // real response's tokens.
    let mut st = TailState::default();
    let c = ctx();
    let synthetic = json!({"type":"assistant","timestamp":"2026-07-18T09:42:06.000Z",
      "message":{"model":"<synthetic>","id":"msg_01","role":"assistant",
        "content":[{"type":"text","text":"No response requested."}],
        "usage":{"input_tokens":0,"output_tokens":0}}})
    .to_string();
    transform::transform_line(&synthetic, &c, 0, &mut st);
    let (_, ev) = transform::transform_line(
        &assistant_tool_use("2026-07-18T09:42:07.000Z", "t1", "Bash"),
        &c,
        100,
        &mut st,
    );
    assert_eq!(ev[0]["output_tokens"], 91, "the real turn must still bill");
}

#[test]
fn two_identical_lines_at_different_offsets_produce_different_events() {
    // The offset is the dedup discriminator. Without it the server would
    // collapse a genuinely repeated turn into one row.
    let mut st = TailState::default();
    let c = ctx();
    let line = user_prompt("2026-07-18T09:42:04.058Z", "same");
    let (_, a) = transform::transform_line(&line, &c, 10, &mut st);
    let (_, b) = transform::transform_line(&line, &c, 999, &mut st);
    assert_ne!(a[0]["claude_line_offset"], b[0]["claude_line_offset"]);
}

// ── format table ─────────────────────────────────────────────────────────

#[test]
fn discovery_claims_transcripts_and_nothing_else() {
    let is = claude::FORMAT.is_source_file;
    assert!(is(Path::new(&format!("/p/proj/{UUID}.jsonl"))));

    // Rewritten in place — a byte cursor would re-ship it forever.
    assert!(!is(Path::new(&format!(
        "/p/proj/{UUID}.jsonl.tool-calls.json"
    ))));
    // A different two-field schema.
    assert!(!is(Path::new("/p/proj/journal.jsonl")));
    // Owned by a future subagent format; claiming it here would ship every
    // subagent line twice under two session ids.
    assert!(!is(Path::new(&format!(
        "/p/proj/{UUID}/subagents/agent-x.jsonl"
    ))));
    assert!(!is(Path::new("/p/proj/notes.txt")));
}

#[test]
fn the_agent_id_comes_from_the_real_cwd_not_the_lossy_folder_name() {
    // Claude encodes cwd by replacing every `/` with `-`, and folder names
    // contain `-` too, so the encoding is not invertible. On this machine 3 of
    // 16 project dirs decode wrongly by splitting on the last `-`.
    let header = vec![
        r#"{"type":"user","timestamp":"2026-07-18T09:42:04.058Z","cwd":"/home/u/src/openclaw-local"}"#.to_string(),
    ];
    let derived = (claude::FORMAT.agent_id_from_path)(
        Path::new("/p/-home-u-src-openclaw-local/x.jsonl"),
        &header,
    );
    assert_eq!(derived.as_deref(), Some("claude-openclaw-local"));
}

#[test]
fn the_session_id_is_the_filename_stem() {
    assert_eq!(
        (claude::FORMAT.session_id_from_path)(Path::new(&format!("/p/proj/{UUID}.jsonl")))
            .as_deref(),
        Some(UUID)
    );
}

// ── engine ───────────────────────────────────────────────────────────────

fn spec(root: PathBuf, spool: PathBuf, state: PathBuf) -> Spec {
    Spec {
        format: claude::FORMAT,
        roots: vec![root],
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(200),
        params: Params {
            redact: fpai_collect::Redact::Minimal,
            agent_id: claude::DEFAULT_AGENT_ID.into(),
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

async fn run_briefly(s: Spec, ms: u64) {
    let sd = Shutdown::for_test(Arc::new(AtomicBool::new(false)));
    let _ = tokio::time::timeout(Duration::from_millis(ms), filetail::run(s, sd)).await;
}

fn write_session(root: &Path, lines: &[String]) -> PathBuf {
    let proj = root.join("-home-u-repo");
    fs::create_dir_all(&proj).unwrap();
    let p = proj.join(format!("{UUID}.jsonl"));
    fs::write(&p, lines.join("\n") + "\n").unwrap();
    p
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_produces_a_start_its_turns_and_an_end() {
    let root = tmpdir("full-root");
    let spool = tmpdir("full-spool");
    let state = tmpdir("full-state");

    write_session(
        &root,
        &[
            user_prompt("2026-07-18T09:42:04.058Z", "list the files"),
            assistant_tool_use("2026-07-18T09:42:05.000Z", "toolu_01", "Bash"),
            tool_result("2026-07-18T09:42:06.000Z", "toolu_01", "total 4", false),
        ],
    );

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;

    let ev = spooled(&spool);
    let types: Vec<&str> = ev.iter().filter_map(|e| e["type"].as_str()).collect();
    assert!(types.contains(&"agent_start"), "got {types:?}");
    assert!(types.contains(&"model_request"), "got {types:?}");
    assert!(types.contains(&"tool_use"), "got {types:?}");
    assert!(types.contains(&"tool_result"), "got {types:?}");
    assert!(types.contains(&"agent_end"), "got {types:?}");

    // Every event carries the session id from the filename, so hook events
    // for the same run land on this timeline.
    for e in &ev {
        assert_eq!(e["session_id"], UUID);
        assert_eq!(e["agent_id"], "claude-repo", "agent id must come from cwd");
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
    write_session(&root, &[user_prompt("2026-07-18T09:42:04.058Z", "hi")]);

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    assert!(!spooled(&spool).is_empty());
    for e in fs::read_dir(&spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }

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
    let path = write_session(&root, &[user_prompt("2026-07-18T09:42:04.058Z", "first")]);

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let first = spooled(&spool).len();
    for e in fs::read_dir(&spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }

    let mut body = fs::read_to_string(&path).unwrap();
    body.push_str(&(user_prompt("2026-07-18T09:43:00.000Z", "second") + "\n"));
    fs::write(&path, body).unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let ev = spooled(&spool);
    assert!(!ev.is_empty(), "the appended turn must ship");
    assert!(
        ev.len() < first + 5,
        "earlier turns must not be re-shipped: {}",
        ev.len()
    );
    assert!(
        ev.iter().any(|e| e["messages"][0]["content"] == "second"),
        "the new prompt must be present"
    );

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_compacted_transcript_is_re_read_rather_than_seeking_past_its_end() {
    // `/compact` rewrites the file and can shrink it. Left alone the cursor
    // would sit past EOF and the session would silently stop updating.
    let root = tmpdir("compact-root");
    let spool = tmpdir("compact-spool");
    let state = tmpdir("compact-state");
    let path = write_session(
        &root,
        &[
            user_prompt(
                "2026-07-18T09:42:04.058Z",
                "a long first prompt to make the file big",
            ),
            user_prompt(
                "2026-07-18T09:42:10.000Z",
                "another long prompt so the file shrinks later",
            ),
        ],
    );

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    for e in fs::read_dir(&spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }

    // Compaction: a much smaller file.
    fs::write(
        &path,
        user_prompt("2026-07-18T09:44:00.000Z", "post") + "\n",
    )
    .unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let ev = spooled(&spool);
    assert!(
        ev.iter().any(|e| e["messages"][0]["content"] == "post"),
        "a shrunk transcript must be re-read, got {} events",
        ev.len()
    );

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_partially_written_final_line_is_held_back_then_picked_up() {
    let root = tmpdir("partial-root");
    let spool = tmpdir("partial-spool");
    let state = tmpdir("partial-state");
    let proj = root.join("-home-u-repo");
    fs::create_dir_all(&proj).unwrap();
    let path = proj.join(format!("{UUID}.jsonl"));

    let complete = user_prompt("2026-07-18T09:42:04.058Z", "complete");
    fs::write(&path, format!("{complete}\n{{\"type\":\"user\",\"timest")).unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let n1 = spooled(&spool)
        .iter()
        .filter(|e| e["type"] == "model_request")
        .count();
    assert_eq!(n1, 1, "only the complete line should ship");
    for e in fs::read_dir(&spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }

    fs::write(
        &path,
        format!(
            "{complete}\n{}\n",
            user_prompt("2026-07-18T09:43:00.000Z", "finished")
        ),
    )
    .unwrap();
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

#[test]
fn claude_declares_itself_byte_tailable() {
    // If Claude ever starts rewriting mid-file the way droid does, this is the
    // switch — and the engine already supports the other policy.
    assert_eq!(claude::FORMAT.reread, RereadPolicy::ByteCursor);
}

/// `[collector] redact` has to reach a real source, not just parse.
///
/// It parsed correctly and reached nothing: no source carried the field, so
/// `SpoolWriter::with_redact` had exactly two references — its own definition
/// and its own unit test — and every real writer kept the hardcoded
/// `Redact::Minimal`. Setting `redact = "off"` in `config.toml` had no
/// observable effect anywhere, which is worse than not offering the setting.
///
/// Asserted through a real filetail run rather than against `SpoolWriter`
/// directly, because the gap was the wiring between them.
#[tokio::test(flavor = "multi_thread")]
async fn the_configured_redaction_mode_reaches_the_spool() {
    const SECRET: &str = "ghp_abcdefghijklmnopqrstuvwxyz0123";

    async fn spool_with(mode: fpai_collect::Redact, tag: &str) -> String {
        let root = tmpdir(&format!("redact-root-{tag}"));
        let spool = tmpdir(&format!("redact-spool-{tag}"));
        let state = tmpdir(&format!("redact-state-{tag}"));
        write_session(
            &root,
            &[user_prompt(
                "2026-07-18T09:42:04.058Z",
                &format!("export TOKEN={SECRET}"),
            )],
        );
        let mut s = spec(root, spool.clone(), state);
        s.params.redact = mode;
        run_briefly(s, 1200).await;
        spooled(&spool)
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    // The default, and what every source was pinned to regardless of config.
    let minimal = spool_with(fpai_collect::Redact::Minimal, "min").await;
    assert!(
        !minimal.is_empty(),
        "the source must have spooled something"
    );
    assert!(
        !minimal.contains(SECRET),
        "minimal mode must redact: {minimal}"
    );

    // The knob the operator actually set. Before this was wired, the two
    // outputs were byte-identical.
    let off = spool_with(fpai_collect::Redact::Off, "off").await;
    assert!(!off.is_empty(), "the source must have spooled something");
    assert!(
        off.contains(SECRET),
        "redact = off must leave the value alone: {off}"
    );
}
