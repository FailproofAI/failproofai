//! Cursor source: transform correctness and engine behaviour.
//!
//! Record shapes are taken from real transcripts under
//! `~/.cursor/projects/<flattened-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl`:
//! Claude-shaped `{role, message:{content:[{type:"text",text}|{type:"tool_use",…}]}}`
//! lines with NO timestamps. Event times are synthesised from the file's mtime
//! (carried on `Ctx.file_epoch_ms`) plus the byte offset.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::cursor::TailState;
use fpai_collect::filetail::{self, Ctx, Params, Spec};
use fpai_collect::sources::cursor::{self, transform};
use fpai_collect::supervisor::Shutdown;
use serde_json::{Value, json};

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-cur-{}-{}-{}",
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

const UUID: &str = "a40a79cb-f88e-4969-bc6c-8a4e70d022b4";
// A fixed, immutable file-mtime base (2026-07-14T13:59:21.477Z ≈ this many ms).
const BASE_MS: i64 = 1_784_037_561_477;

fn ctx() -> Ctx {
    Ctx {
        session_id: UUID.into(),
        agent_id: "cursor-repo".into(),
        environment: "local".into(),
        file_epoch_ms: Some(BASE_MS),
    }
}

fn user(text: &str) -> String {
    json!({ "role": "user", "message": { "content": [{ "type": "text", "text": text }] } })
        .to_string()
}

fn assistant_text_and_tool(text: &str, id: &str, name: &str) -> String {
    json!({ "role": "assistant", "message": { "content": [
        { "type": "text", "text": text },
        { "type": "tool_use", "id": id, "name": name, "input": { "path": "a.rs" } }
    ]}})
    .to_string()
}

fn user_tool_result(id: &str, out: &str) -> String {
    json!({ "role": "user", "message": { "content": [
        { "type": "tool_result", "tool_use_id": id, "content": out }
    ]}})
    .to_string()
}

fn one(line: &str, off: u64, st: &mut TailState) -> (Option<String>, Vec<Value>) {
    transform::transform_line(line, &ctx(), off, st)
}

fn types_of(events: &[Value]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|e| e.get("type")?.as_str())
        .collect()
}

// ── transform-direct ─────────────────────────────────────────────────────────

#[test]
fn a_user_prompt_unwraps_the_user_query_and_becomes_a_model_request() {
    let mut st = TailState::default();
    let (ts, ev) = one(
        &user("<user_query>\nfix the bug\n</user_query>"),
        0,
        &mut st,
    );
    assert_eq!(types_of(&ev), vec!["model_request"]);
    // Unwrapped.
    assert_eq!(ev[0]["messages"][0]["content"], "fix the bug");
    // Stamped at the file mtime base (offset 0 → 0µs past it).
    assert_eq!(ts.as_deref(), Some("2026-07-14T13:59:21.477000Z"));
}

#[test]
fn assistant_text_and_tool_use_are_both_emitted_and_the_call_is_remembered() {
    let mut st = TailState::default();
    let (_, ev) = one(
        &assistant_text_and_tool("done", "toolu_1", "edit_file"),
        0,
        &mut st,
    );
    assert_eq!(types_of(&ev), vec!["model_response", "tool_use"]);
    assert_eq!(ev[1]["tool_name"], "edit_file");
    assert_eq!(ev[1]["tool_call_id"], "toolu_1");
    assert_eq!(st.tool_name("toolu_1"), Some("edit_file"));
}

#[test]
fn a_tool_result_is_named_from_its_remembered_call() {
    let mut st = TailState::default();
    one(
        &assistant_text_and_tool("", "toolu_1", "edit_file"),
        0,
        &mut st,
    );
    let (_, ev) = one(&user_tool_result("toolu_1", "applied"), 100, &mut st);
    assert_eq!(types_of(&ev), vec!["tool_result"]);
    assert_eq!(ev[0]["tool_name"], "edit_file");
    assert_eq!(ev[0]["output"], "applied");
}

#[test]
fn event_times_are_anchored_on_the_mtime_and_ordered_by_offset() {
    let mut st = TailState::default();
    let (ts0, _) = one(&user("first"), 0, &mut st);
    // 2000 bytes further in → 2000µs = 2ms later, still real and ordered.
    let (ts1, _) = one(&user("second"), 2000, &mut st);
    assert_eq!(ts0.as_deref(), Some("2026-07-14T13:59:21.477000Z"));
    assert_eq!(ts1.as_deref(), Some("2026-07-14T13:59:21.479000Z"));
    assert!(ts1 > ts0);
}

#[test]
fn a_missing_mtime_falls_back_to_the_epoch_rather_than_dropping_events() {
    let mut st = TailState::default();
    let c = Ctx {
        file_epoch_ms: None,
        ..ctx()
    };
    let (ts, ev) = transform::transform_line(&user("hi"), &c, 0, &mut st);
    assert_eq!(types_of(&ev), vec!["model_request"]);
    assert_eq!(ts.as_deref(), Some("1970-01-01T00:00:00.000000Z"));
}

#[test]
fn agent_start_takes_the_first_user_prompt_as_its_goal() {
    let header = vec![
        user("<user_query>build a parser</user_query>"),
        assistant_text_and_tool("ok", "t", "edit_file"),
    ];
    let (start, seed) = transform::agent_start(&header, &ctx(), 0).unwrap();
    assert_eq!(start["type"], "agent_start");
    assert_eq!(start["goal"], "build a parser");
    assert_eq!(seed.as_deref(), Some("2026-07-14T13:59:21.477000Z"));
}

#[test]
fn the_agent_id_scheme_is_cursor_dash_project() {
    assert_eq!(
        transform::agent_id_from_folder("home-u-Desktop-repo").as_deref(),
        Some("cursor-repo")
    );
}

// ── engine ───────────────────────────────────────────────────────────────────

fn spec(root: PathBuf, spool: PathBuf, state: PathBuf) -> Spec {
    Spec {
        format: cursor::FORMAT,
        roots: vec![root],
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(200),
        params: Params {
            agent_id: cursor::DEFAULT_AGENT_ID.into(),
            environment: "local".into(),
            machine_id: None,
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

#[tokio::test]
async fn a_transcript_ships_start_turns_and_end_with_real_ordered_synthetic_times() {
    let root = tmpdir("engine-root");
    let spool = tmpdir("engine-spool");
    let state = tmpdir("engine-state");
    // …/projects/<folder>/agent-transcripts/<uuid>/<uuid>.jsonl
    let dir = root
        .join("home-u-Desktop-repo")
        .join("agent-transcripts")
        .join(UUID);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join(format!("{UUID}.jsonl")),
        format!(
            "{}\n{}\n{}\n",
            user("<user_query>fix it</user_query>"),
            assistant_text_and_tool("on it", "toolu_1", "edit_file"),
            user_tool_result("toolu_1", "done"),
        ),
    )
    .unwrap();

    run_briefly(spec(root, spool.clone(), state), 1500).await;
    let events = spooled(&spool);
    let types = types_of(&events);

    assert!(types.contains(&"agent_start"), "got {types:?}");
    assert!(types.contains(&"model_request"));
    assert!(types.contains(&"tool_use"));
    assert!(types.contains(&"tool_result"));
    assert!(types.contains(&"agent_end"));

    // session_id from the filename, agent_id from the projects folder, and every
    // event carries a real (non-epoch) timestamp anchored on the file's mtime.
    for e in &events {
        assert_eq!(e["session_id"], UUID);
        assert_eq!(e["agent_id"], "cursor-repo");
        let ts = e["timestamp"].as_str().unwrap();
        assert!(
            ts.starts_with("202"),
            "synthetic ts should be near real time: {ts}"
        );
    }
    assert_eq!(types.iter().filter(|t| **t == "agent_start").count(), 1);
    assert_eq!(types.iter().filter(|t| **t == "agent_end").count(), 1);
}
