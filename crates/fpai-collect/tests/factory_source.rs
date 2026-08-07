//! Factory (droid) source: transform correctness and engine behaviour.
//!
//! Record shapes are taken verbatim from real transcripts under
//! `~/.factory/sessions/<encoded-cwd>/<sessionId>.jsonl` (droid v0.171.0):
//! a `session_start` line carrying cwd + title, then Claude-shaped `message`
//! lines whose `content` is an array of `text` / `tool_use` / `tool_result`
//! blocks, alongside a `<sessionId>.settings.json` sibling we never read.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::cursor::TailState;
use fpai_collect::filetail::{self, Ctx, Params, Spec};
use fpai_collect::sources::factory::{self, transform};
use fpai_collect::supervisor::Shutdown;
use serde_json::{Value, json};

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-fac-{}-{}-{}",
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

fn ctx() -> Ctx {
    Ctx {
        session_id: UUID.into(),
        agent_id: "factory-droid".into(),
        environment: "local".into(),

        ..Default::default()
    }
}

// ── real record shapes ───────────────────────────────────────────────────────

fn session_start(cwd: &str, title: &str) -> String {
    json!({
        "type": "session_start", "id": UUID, "title": title, "owner": "chetan",
        "version": "0.171.0", "cwd": cwd, "hostId": "h1",
        "isSessionTitleManuallySet": false
    })
    .to_string()
}

fn user_text(ts: &str, text: &str) -> String {
    json!({
        "type": "message", "id": "m1", "timestamp": ts,
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    })
    .to_string()
}

fn assistant(ts: &str, model: &str, text: &str, tool_id: &str, tool_name: &str) -> String {
    json!({
        "type": "message", "id": "m2", "timestamp": ts,
        "message": { "role": "assistant", "model": model, "content": [
            { "type": "text", "text": text },
            { "type": "tool_use", "id": tool_id, "name": tool_name, "input": { "file_path": "/x/.env" } }
        ]}
    })
    .to_string()
}

fn tool_result(ts: &str, tool_id: &str, is_error: bool, content: &str) -> String {
    json!({
        "type": "message", "id": "m3", "timestamp": ts,
        "message": { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": tool_id, "is_error": is_error, "content": content }
        ]}
    })
    .to_string()
}

fn compaction_state(ts: &str) -> String {
    json!({ "type": "compaction_state", "timestamp": ts, "tokensBefore": 100 }).to_string()
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
fn user_text_becomes_a_model_request() {
    let mut st = TailState::default();
    let (ts, ev) = one(
        &user_text("2026-07-14T13:59:21.477Z", "make a .env"),
        &mut st,
    );
    assert_eq!(ts.as_deref(), Some("2026-07-14T13:59:21.477Z"));
    assert_eq!(types_of(&ev), vec!["model_request"]);
    assert_eq!(ev[0]["messages"][0]["content"], "make a .env");
}

#[test]
fn assistant_text_and_tool_use_are_both_emitted_and_the_call_is_remembered() {
    let mut st = TailState::default();
    let (_, ev) = one(
        &assistant(
            "2026-07-14T13:59:25.000Z",
            "claude-x",
            "on it",
            "call_abc",
            "Create",
        ),
        &mut st,
    );
    assert_eq!(types_of(&ev), vec!["model_response", "tool_use"]);
    assert_eq!(ev[1]["tool_name"], "Create");
    assert_eq!(ev[1]["tool_call_id"], "call_abc");
    assert_eq!(ev[0]["model"], "claude-x");
    assert_eq!(st.tool_name("call_abc"), Some("Create"));
}

#[test]
fn a_tool_result_is_named_from_its_remembered_call() {
    let mut st = TailState::default();
    // The call lands first...
    one(
        &assistant("2026-07-14T13:59:25.000Z", "m", "", "call_abc", "Create"),
        &mut st,
    );
    // ...then its result, on a later user line, carries no name of its own.
    let (_, ev) = one(
        &tool_result(
            "2026-07-14T13:59:26.000Z",
            "call_abc",
            true,
            "Error: Blocked Write",
        ),
        &mut st,
    );
    assert_eq!(types_of(&ev), vec!["tool_result"]);
    assert_eq!(ev[0]["tool_name"], "Create");
    assert_eq!(ev[0]["error_type"], "factory_tool_error");
    assert_eq!(ev[0]["output"], "Error: Blocked Write");
}

#[test]
fn compaction_state_and_session_start_yield_no_events() {
    let mut st = TailState::default();
    assert!(
        one(&compaction_state("2026-07-14T14:00:00.000Z"), &mut st)
            .1
            .is_empty()
    );
    assert!(one(&session_start("/x", "t"), &mut st).1.is_empty());
}

#[test]
fn agent_start_takes_cwd_and_title_from_session_start_anchored_on_first_message_ts() {
    let header = vec![
        session_start("/home/u/my-repo", "Create .env file"),
        user_text("2026-07-14T13:59:21.477Z", "hi"),
    ];
    let (start, seed) = transform::agent_start(&header, &ctx(), 0).unwrap();
    assert_eq!(start["type"], "agent_start");
    assert_eq!(start["goal"], "Create .env file");
    assert_eq!(start["factory_cwd"], "/home/u/my-repo");
    // Anchored on the first message's timestamp (session_start carries none).
    assert_eq!(start["timestamp"], "2026-07-14T13:59:21.477000Z");
    assert_eq!(seed.as_deref(), Some("2026-07-14T13:59:21.477Z"));
}

#[test]
fn the_agent_id_scheme_is_factory_dash_project() {
    assert_eq!(
        factory::transform::agent_id_from_cwd("/home/u/my-repo").as_deref(),
        Some("factory-my-repo")
    );
    assert_eq!(factory::transform::agent_id_from_cwd("/").as_deref(), None);
}

// ── engine ───────────────────────────────────────────────────────────────────

fn spec(root: PathBuf, spool: PathBuf, state: PathBuf) -> Spec {
    Spec {
        format: factory::FORMAT,
        roots: vec![root],
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(200),
        health_key: None,
        params: Params {
            redact: fpai_collect::Redact::Minimal,
            agent_id: factory::DEFAULT_AGENT_ID.into(),
            environment: "local".into(),
            machine_id: None,
            user: None,
            end_idle_mins: 0,
            max_read_bytes: 8 * 1024 * 1024,
            max_batch_bytes: 8 * 1024 * 1024,
            since_days: None,
            label: None,
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
    // The encoded-cwd folder is lossy, so the real cwd must come from inside.
    let dir = root.join("-home-u-my-repo");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{UUID}.jsonl"));
    fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
    // The sibling that must be ignored.
    fs::write(dir.join(format!("{UUID}.settings.json")), "{}").unwrap();
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
            session_start("/home/u/my-repo", "Create .env file"),
            user_text("2026-07-14T13:59:21.477Z", "make a .env"),
            assistant(
                "2026-07-14T13:59:25.000Z",
                "claude-x",
                "on it",
                "call_abc",
                "Create",
            ),
            tool_result("2026-07-14T13:59:26.000Z", "call_abc", true, "Blocked"),
        ],
    );

    run_briefly(spec(root, spool.clone(), state), 1500).await;
    let events = spooled(&spool);

    let types = types_of(&events);
    assert!(types.contains(&"agent_start"), "got {types:?}");
    assert!(types.contains(&"model_request"));
    assert!(types.contains(&"tool_use"));
    assert!(types.contains(&"tool_result"));
    assert!(types.contains(&"agent_end"));

    // session_id from the filename, agent_id from the in-file cwd (not the
    // lossy folder name), and the settings.json sibling was ignored.
    for e in &events {
        assert_eq!(e["session_id"], UUID);
        assert_eq!(e["agent_id"], "factory-my-repo");
    }
    // Exactly one start / one end.
    assert_eq!(types.iter().filter(|t| **t == "agent_start").count(), 1);
    assert_eq!(types.iter().filter(|t| **t == "agent_end").count(), 1);
}

#[tokio::test]
async fn rewriting_the_first_line_in_place_does_not_re_ship_later_events() {
    // Factory rewrites `session_start` when it names the session, growing line 1
    // and moving every later byte offset. ValidatePrefix must rebase rather than
    // re-emit the turns that follow.
    let root = tmpdir("prefix-root");
    let spool = tmpdir("prefix-spool");
    let state = tmpdir("prefix-state");
    let path = write_transcript(
        &root,
        &[
            session_start("/home/u/my-repo", ""),
            user_text("2026-07-14T13:59:21.477Z", "make a .env"),
            assistant("2026-07-14T13:59:25.000Z", "m", "ok", "call_abc", "Create"),
        ],
    );
    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;
    let first = spooled(&spool);
    let first_tool_uses = types_of(&first)
        .iter()
        .filter(|t| **t == "tool_use")
        .count();
    assert_eq!(first_tool_uses, 1, "first pass: {:?}", types_of(&first));

    // Now the session gets a title: line 1 grows in place, nothing else changes.
    let mut lines: Vec<String> = fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    lines[0] = session_start("/home/u/my-repo", "A much longer session title than before");
    fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();

    run_briefly(spec(root, spool.clone(), state), 1200).await;
    let after = spooled(&spool);
    let after_tool_uses = types_of(&after)
        .iter()
        .filter(|t| **t == "tool_use")
        .count();
    // The turn is not re-shipped: still exactly one tool_use across both runs.
    assert_eq!(
        after_tool_uses,
        1,
        "line-1 rewrite re-shipped turns: {:?}",
        types_of(&after)
    );
}
