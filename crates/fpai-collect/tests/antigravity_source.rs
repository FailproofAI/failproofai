//! Antigravity (agy) source: transform correctness and engine behaviour.
//!
//! Record shapes are taken verbatim from real transcripts under
//! `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/
//! transcript_full.jsonl` (agy v1.1.2): one step per line,
//! `{step_index (STRING), type, status, created_at (second-precision ISO),
//! content?, tool_calls?}`. `USER_INPUT` → user text, `PLANNER_RESPONSE` →
//! assistant text and/or `tool_calls:[{name, args}]`, and a following step whose
//! `type` is the uppercased tool name (`RUN_COMMAND`, or `CODE_ACTION` for a
//! `write_to_file`) is the tool result. `CONVERSATION_HISTORY` / `CHECKPOINT`
//! are metadata. The sibling `<uuid>.trajectory.jsonl` is never read.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::cursor::TailState;
use fpai_collect::filetail::{self, Ctx, Params, Spec};
use fpai_collect::sources::antigravity::{self, transform};
use fpai_collect::supervisor::Shutdown;
use serde_json::{Value, json};

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-agy-{}-{}-{}",
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

const UUID: &str = "15668194-6030-4fa3-a5c4-777cdb2e279d";
const TS0: &str = "2026-07-14T13:32:00Z";
const TS1: &str = "2026-07-14T13:32:05Z";
const TS2: &str = "2026-07-14T13:32:06Z";
const TS3: &str = "2026-07-14T13:32:07Z";

fn ctx() -> Ctx {
    Ctx {
        session_id: UUID.into(),
        agent_id: "antigravity-project".into(),
        environment: "local".into(),

        ..Default::default()
    }
}

// ── real record shapes ───────────────────────────────────────────────────────

fn user_input(step: &str, ts: &str, content: &str) -> String {
    json!({
        "step_index": step, "type": "USER_INPUT", "status": "COMPLETE",
        "created_at": ts, "content": content
    })
    .to_string()
}

fn planner_text(step: &str, ts: &str, text: &str) -> String {
    json!({
        "step_index": step, "type": "PLANNER_RESPONSE", "created_at": ts, "content": text
    })
    .to_string()
}

fn planner_tool(step: &str, ts: &str, name: &str, args: Value) -> String {
    json!({
        "step_index": step, "type": "PLANNER_RESPONSE", "created_at": ts,
        "tool_calls": [{ "name": name, "args": args }]
    })
    .to_string()
}

fn planner_text_and_tool(step: &str, ts: &str, text: &str, name: &str, args: Value) -> String {
    json!({
        "step_index": step, "type": "PLANNER_RESPONSE", "created_at": ts, "content": text,
        "tool_calls": [{ "name": name, "args": args }]
    })
    .to_string()
}

fn result_step(step: &str, ts: &str, step_type: &str, content: &str) -> String {
    json!({
        "step_index": step, "type": step_type, "status": "COMPLETE",
        "created_at": ts, "content": content
    })
    .to_string()
}

fn meta_step(step: &str, ts: &str, step_type: &str) -> String {
    json!({ "step_index": step, "type": step_type, "created_at": ts }).to_string()
}

fn one(line: &str, st: &mut TailState) -> (Option<String>, Vec<Value>) {
    transform::transform_line(line, &ctx(), 0, st)
}

fn types_of(events: &[Value]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|e| e.get("type")?.as_str())
        .collect()
}

// ── transform-direct ─────────────────────────────────────────────────────────

#[test]
fn user_input_becomes_a_model_request() {
    let mut st = TailState::default();
    let (ts, ev) = one(&user_input("0", TS0, "run ls"), &mut st);
    assert_eq!(ts.as_deref(), Some(TS0));
    assert_eq!(types_of(&ev), vec!["model_request"]);
    assert_eq!(ev[0]["messages"][0]["content"], "run ls");
    // Second-precision `created_at` is normalised to six-digit micros.
    assert_eq!(ev[0]["timestamp"], "2026-07-14T13:32:00.000000Z");
}

#[test]
fn planner_text_and_tool_call_are_both_emitted_and_the_call_is_remembered() {
    let mut st = TailState::default();
    let (_, ev) = one(
        &planner_text_and_tool(
            "2",
            TS2,
            "on it",
            "run_command",
            json!({ "CommandLine": "ls" }),
        ),
        &mut st,
    );
    assert_eq!(types_of(&ev), vec!["model_response", "tool_use"]);
    assert_eq!(ev[0]["content"], "on it");
    assert_eq!(ev[0]["role"], "assistant");
    // No id on disk — synthesised as `<name>-<step_index>-<j>`.
    assert_eq!(ev[1]["tool_name"], "run_command");
    assert_eq!(ev[1]["tool_call_id"], "run_command-2-0");
    assert_eq!(ev[1]["input"]["CommandLine"], "ls");
    assert_eq!(st.tool_name("run_command-2-0"), Some("run_command"));
    // The tool_use is offset one micro past the text so they keep their order.
    assert_eq!(ev[0]["timestamp"], "2026-07-14T13:32:06.000000Z");
    assert_eq!(ev[1]["timestamp"], "2026-07-14T13:32:06.000001Z");
}

#[test]
fn a_run_command_result_pairs_by_exact_name_over_an_older_call() {
    let mut st = TailState::default();
    // An older write_to_file is pending first...
    one(
        &planner_tool(
            "1",
            TS1,
            "write_to_file",
            json!({ "TargetFile": "/x/a.txt" }),
        ),
        &mut st,
    );
    // ...then run_command; its RUN_COMMAND result must pick run_command by name,
    // not the older call.
    one(
        &planner_tool("2", TS2, "run_command", json!({ "CommandLine": "ls" })),
        &mut st,
    );
    let (_, ev) = one(
        &result_step("3", TS3, "RUN_COMMAND", "file1\nfile2"),
        &mut st,
    );
    assert_eq!(types_of(&ev), vec!["tool_result"]);
    assert_eq!(ev[0]["tool_name"], "run_command");
    assert_eq!(ev[0]["tool_call_id"], "run_command-2-0");
    assert_eq!(ev[0]["output"], "file1\nfile2");
    // The write_to_file stays pending for a later CODE_ACTION.
    assert_eq!(st.pending_tools.len(), 1);
    assert_eq!(st.tool_name("write_to_file-1-0"), Some("write_to_file"));
}

#[test]
fn a_code_action_result_pairs_with_write_to_file_despite_the_type_mismatch() {
    // Verified caveat: write_to_file's result arrives as CODE_ACTION, not
    // WRITE_TO_FILE — so exact-name pairing misses and the oldest pending call
    // (the write_to_file) is used instead.
    let mut st = TailState::default();
    one(
        &planner_tool(
            "2",
            TS2,
            "write_to_file",
            json!({ "TargetFile": "/x/a.txt" }),
        ),
        &mut st,
    );
    let (_, ev) = one(
        &result_step("3", TS3, "CODE_ACTION", "wrote 1 file"),
        &mut st,
    );
    assert_eq!(types_of(&ev), vec!["tool_result"]);
    assert_eq!(ev[0]["tool_name"], "write_to_file");
    assert_eq!(ev[0]["tool_call_id"], "write_to_file-2-0");
    assert_eq!(ev[0]["output"], "wrote 1 file");
    assert!(st.pending_tools.is_empty(), "the call was consumed");
}

#[test]
fn an_unpaired_result_step_is_emitted_unnamed_rather_than_dropped() {
    let mut st = TailState::default();
    let (ts, ev) = one(
        &result_step("5", TS3, "RUN_COMMAND", "orphan output"),
        &mut st,
    );
    assert_eq!(types_of(&ev), vec!["tool_result"]);
    assert!(ev[0].get("tool_name").is_none());
    assert!(ev[0].get("tool_call_id").is_none());
    assert_eq!(ev[0]["output"], "orphan output");
    assert!(ts.is_some());
}

#[test]
fn checkpoint_and_conversation_history_yield_no_events() {
    let mut st = TailState::default();
    assert!(
        one(&meta_step("9", TS3, "CHECKPOINT"), &mut st)
            .1
            .is_empty()
    );
    assert!(
        one(&meta_step("10", TS3, "CONVERSATION_HISTORY"), &mut st)
            .1
            .is_empty()
    );
}

#[test]
fn agent_start_takes_goal_and_cwd_and_anchors_on_the_first_parseable_ts() {
    let header = vec![
        user_input("0", TS0, "run ls"),
        planner_tool(
            "2",
            TS2,
            "run_command",
            json!({ "CommandLine": "ls", "Cwd": "/home/u/my-repo" }),
        ),
    ];
    let (start, seed) = transform::agent_start(&header, &ctx(), 0).unwrap();
    assert_eq!(start["type"], "agent_start");
    assert_eq!(start["goal"], "run ls");
    // cwd is recovered from the first run_command's Cwd arg.
    assert_eq!(start["antigravity_cwd"], "/home/u/my-repo");
    // Anchored on the first step's timestamp, normalised to micros.
    assert_eq!(start["timestamp"], "2026-07-14T13:32:00.000000Z");
    assert_eq!(seed.as_deref(), Some(TS0));
}

#[test]
fn the_agent_id_scheme_is_antigravity_dash_project() {
    assert_eq!(
        transform::agent_id_from_cwd("/home/u/my-repo").as_deref(),
        Some("antigravity-my-repo")
    );
    assert_eq!(transform::agent_id_from_cwd("/").as_deref(), None);
}

#[test]
fn the_session_id_comes_from_the_brain_ancestor_and_siblings_are_ignored() {
    let root = tmpdir("ids");
    let convo = root.join("brain").join(UUID);
    let logs = convo.join(".system_generated").join("logs");
    fs::create_dir_all(&logs).unwrap();
    let transcript = logs.join("transcript_full.jsonl");
    fs::write(&transcript, "").unwrap();
    // The siblings that must be ignored.
    let trajectory = convo.join(format!("{UUID}.trajectory.jsonl"));
    fs::write(&trajectory, "").unwrap();
    fs::write(convo.join(".trajectory-path.json"), "{}").unwrap();

    // The id names the `brain/<uuid>/` ancestor dir, not the constant filename.
    assert_eq!(
        (antigravity::FORMAT.session_id_from_path)(&transcript).as_deref(),
        Some(UUID)
    );
    assert!((antigravity::FORMAT.is_source_file)(&transcript));
    assert!(!(antigravity::FORMAT.is_source_file)(&trajectory));
    fs::remove_dir_all(&root).ok();
}

// ── engine ───────────────────────────────────────────────────────────────────

fn spec(root: PathBuf, spool: PathBuf, state: PathBuf) -> Spec {
    Spec {
        format: antigravity::FORMAT,
        roots: vec![root],
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(200),
        params: Params {
            redact: fpai_collect::Redact::Minimal,
            agent_id: antigravity::DEFAULT_AGENT_ID.into(),
            environment: "local".into(),
            machine_id: None,
            user: None,
            end_idle_mins: 0,
            max_read_bytes: 8 * 1024 * 1024,
            max_batch_bytes: 8 * 1024 * 1024,
            since_days: None,
        },
    }
}

async fn run_briefly(s: Spec, ms: u64) {
    let sd = Shutdown::for_test(Arc::new(AtomicBool::new(false)));
    let _ = tokio::time::timeout(Duration::from_millis(ms), filetail::run(s, sd)).await;
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

fn write_transcript(root: &Path, lines: &[String]) -> PathBuf {
    let convo = root.join("brain").join(UUID);
    let logs = convo.join(".system_generated").join("logs");
    fs::create_dir_all(&logs).unwrap();
    let path = logs.join("transcript_full.jsonl");
    fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
    // The siblings that must be ignored.
    fs::write(convo.join(format!("{UUID}.trajectory.jsonl")), "{}\n").unwrap();
    fs::write(convo.join(".trajectory-path.json"), "{}").unwrap();
    path
}

#[tokio::test]
async fn a_transcript_ships_start_turns_and_end_with_ids_from_the_right_places() {
    let root = tmpdir("engine-root");
    let spool = tmpdir("engine-spool");
    let state = tmpdir("engine-state");
    write_transcript(
        &root,
        &[
            user_input("0", TS0, "run ls"),
            planner_text("1", TS1, "sure, running it"),
            planner_tool(
                "2",
                TS2,
                "run_command",
                json!({ "CommandLine": "ls", "Cwd": "/home/u/my-repo" }),
            ),
            result_step("3", TS3, "RUN_COMMAND", "file1\nfile2"),
        ],
    );

    run_briefly(spec(root, spool.clone(), state), 1500).await;
    let events = spooled(&spool);

    let types = types_of(&events);
    assert!(types.contains(&"agent_start"), "got {types:?}");
    assert!(types.contains(&"model_request"));
    assert!(types.contains(&"model_response"));
    assert!(types.contains(&"tool_use"));
    assert!(types.contains(&"tool_result"));
    assert!(types.contains(&"agent_end"));

    // session_id from the brain ancestor dir, agent_id from the in-file cwd (the
    // first run_command's Cwd), and the trajectory siblings were ignored.
    for e in &events {
        assert_eq!(e["session_id"], UUID);
        assert_eq!(e["agent_id"], "antigravity-my-repo");
    }
    // The result paired back onto its remembered call.
    let result = events.iter().find(|e| e["type"] == "tool_result").unwrap();
    assert_eq!(result["tool_name"], "run_command");
    assert_eq!(result["tool_call_id"], "run_command-2-0");
    // Exactly one start / one end.
    assert_eq!(types.iter().filter(|t| **t == "agent_start").count(), 1);
    assert_eq!(types.iter().filter(|t| **t == "agent_end").count(), 1);
}
