//! grok + qwen sources: path predicates and transform correctness.
//!
//! Record shapes are taken verbatim from real transcripts captured on
//! grok 1.0.3 (`~/.grok/sessions/<pct-cwd>/<uuid>/chat_history.jsonl`) and
//! qwen-code 0.21.12 (`~/.qwen/projects/<enc-cwd>/chats/<uuid>.jsonl`).
//!
//! These two are near-mirror-images and the tests below lean on that: grok has
//! no timestamps and an OpenAI-shaped body, qwen has real timestamps and a
//! Gemini-shaped one.

use std::path::PathBuf;

use fpai_collect::cursor::TailState;
use fpai_collect::filetail::Ctx;
use fpai_collect::sources::{grok, qwen};
use serde_json::{Value, json};

const UUID: &str = "01a01432-6b6c-7593-9de8-54cd7ddd6fe6";

fn grok_ctx() -> Ctx {
    Ctx {
        session_id: UUID.into(),
        agent_id: "grok-VTU".into(),
        environment: "local".into(),
        // grok transcripts carry no timestamps; the engine hands the file mtime.
        file_epoch_ms: Some(1_760_000_000_000),
    }
}

fn qwen_ctx() -> Ctx {
    Ctx {
        session_id: UUID.into(),
        agent_id: "qwen-VTU".into(),
        environment: "local".into(),
        ..Default::default()
    }
}

fn kinds(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| e.get("type")?.as_str().map(str::to_string))
        .collect()
}

// ── grok ─────────────────────────────────────────────────────────────────────

#[test]
fn grok_identifies_only_chat_history_under_a_uuid_dir() {
    let base = PathBuf::from("/home/u/.grok/sessions/%2Fhome%2Fu%2Frepo");
    let ok = base.join(UUID).join("chat_history.jsonl");
    assert!((grok::FORMAT.is_source_file)(&ok));
    // The session id is the PARENT dir, since every transcript shares a name.
    assert_eq!(
        (grok::FORMAT.session_id_from_path)(&ok).as_deref(),
        Some(UUID)
    );
    // Siblings in the very same directory must never be tailed.
    for sibling in ["events.jsonl", "rewind_points.jsonl", "summary.json"] {
        let p = base.join(UUID).join(sibling);
        assert!(
            !(grok::FORMAT.is_source_file)(&p),
            "{sibling} must not be treated as a transcript"
        );
    }
    // A chat_history.jsonl not under a uuid directory is not a session.
    assert!(!(grok::FORMAT.is_source_file)(
        &base.join("chat_history.jsonl")
    ));
}

#[test]
fn grok_agent_id_percent_decodes_the_cwd_folder() {
    let p = PathBuf::from("/home/u/.grok/sessions/%2Fhome%2Fchetan%2FDesktop%2FVTU")
        .join(UUID)
        .join("chat_history.jsonl");
    // Percent-encoding is reversible, so unlike Factory/Qwen the id needs no
    // lookup inside the file.
    assert_eq!(
        (grok::FORMAT.agent_id_from_path)(&p, &[]).as_deref(),
        Some("grok-VTU")
    );
}

#[test]
fn grok_skips_system_and_reasoning_but_keeps_a_timestamp() {
    let ctx = grok_ctx();
    let mut state = TailState::default();
    for line in [
        json!({"type": "system", "content": "You are Grok…"}).to_string(),
        json!({"type": "reasoning", "id": "rs_1", "summary": []}).to_string(),
    ] {
        let (ts, events) = (grok::FORMAT.transform_line)(&line, &ctx, 10, &mut state);
        assert!(events.is_empty(), "system/reasoning are not turns");
        // Still timestamped, so agent_end tracks the file.
        assert!(ts.is_some());
    }
}

#[test]
fn grok_counts_only_operator_prompts_as_user_turns() {
    let ctx = grok_ctx();
    let mut state = TailState::default();

    // The environment preamble: a `user` line with no prompt_index.
    let preamble =
        json!({"type": "user", "content": [{"type": "text", "text": "<user_info>…"}]}).to_string();
    let (_, events) = (grok::FORMAT.transform_line)(&preamble, &ctx, 1, &mut state);
    assert!(
        events.is_empty(),
        "preamble must not read as a human prompt"
    );

    // An injected reminder is also a `user` line.
    let synthetic = json!({"type": "user", "synthetic_reason": "skills",
        "content": [{"type": "text", "text": "<system-reminder>…"}]})
    .to_string();
    let (_, events) = (grok::FORMAT.transform_line)(&synthetic, &ctx, 2, &mut state);
    assert!(events.is_empty(), "synthetic injections are not prompts");

    // The real thing carries prompt_index.
    let real = json!({"type": "user", "prompt_index": 0,
        "content": [{"type": "text", "text": "run echo hi"}]})
    .to_string();
    let (_, events) = (grok::FORMAT.transform_line)(&real, &ctx, 3, &mut state);
    assert_eq!(kinds(&events), vec!["model_request"]);
}

#[test]
fn grok_parses_tool_arguments_from_their_json_string() {
    let ctx = grok_ctx();
    let mut state = TailState::default();
    let line = json!({
        "type": "assistant", "content": "I'll run it.", "model_id": "grok-4.6",
        "tool_calls": [{
            "id": "call-1", "name": "run_terminal_command",
            // grok serializes arguments as a JSON STRING, not an object.
            "arguments": "{\"command\":\"echo hi\",\"description\":\"Echo\"}"
        }]
    })
    .to_string();
    let (_, events) = (grok::FORMAT.transform_line)(&line, &ctx, 100, &mut state);
    assert_eq!(kinds(&events), vec!["model_response", "tool_use"]);

    let call = &events[1];
    assert_eq!(call["tool_name"], json!("run_terminal_command"));
    assert_eq!(call["input"]["command"], json!("echo hi"));
    assert_eq!(call["model"], json!("grok-4.6"));

    // Two events off one line must not share a synthetic timestamp, or the
    // content-hash dedup collapses them into one row.
    assert_ne!(events[0]["timestamp"], events[1]["timestamp"]);

    // The result line carries no tool name; it must be carried from the call.
    let result =
        json!({"type": "tool_result", "tool_call_id": "call-1", "content": "exit: 0\nhi\n"})
            .to_string();
    let (_, events) = (grok::FORMAT.transform_line)(&result, &ctx, 200, &mut state);
    assert_eq!(kinds(&events), vec!["tool_result"]);
    assert_eq!(events[0]["tool_name"], json!("run_terminal_command"));
    assert_eq!(events[0]["output"], json!("exit: 0\nhi\n"));
}

#[test]
fn grok_keeps_unparseable_tool_arguments_rather_than_dropping_them() {
    let ctx = grok_ctx();
    let mut state = TailState::default();
    let line = json!({"type": "assistant", "content": "",
        "tool_calls": [{"id": "c", "name": "x", "arguments": "{not json"}]})
    .to_string();
    let (_, events) = (grok::FORMAT.transform_line)(&line, &ctx, 5, &mut state);
    assert_eq!(events[0]["input"], json!("{not json"));
}

#[test]
fn grok_stamps_events_from_the_file_mtime() {
    let ctx = grok_ctx();
    let mut state = TailState::default();
    let line = json!({"type": "user", "prompt_index": 0,
        "content": [{"type": "text", "text": "hi"}]})
    .to_string();
    let (_, a) = (grok::FORMAT.transform_line)(&line, &ctx, 0, &mut state);
    let (_, b) = (grok::FORMAT.transform_line)(&line, &ctx, 5_000, &mut state);
    // Offset advances synthetic time, so ordering within a session is right and
    // a re-read at the same offset reproduces the same value.
    assert!(a[0]["timestamp"].as_str().unwrap() < b[0]["timestamp"].as_str().unwrap());
}

// ── qwen ─────────────────────────────────────────────────────────────────────

#[test]
fn qwen_identifies_only_uuid_jsonl_inside_a_chats_dir() {
    let base = PathBuf::from("/home/u/.qwen/projects/-home-u-repo");
    let ok = base.join("chats").join(format!("{UUID}.jsonl"));
    assert!((qwen::FORMAT.is_source_file)(&ok));
    assert_eq!(
        (qwen::FORMAT.session_id_from_path)(&ok).as_deref(),
        Some(UUID)
    );
    // Same filename one level up is not a transcript — the `chats/` parent is
    // what separates qwen's layout from Factory's.
    assert!(!(qwen::FORMAT.is_source_file)(
        &base.join(format!("{UUID}.jsonl"))
    ));
}

#[test]
fn qwen_agent_id_comes_from_the_cwd_on_any_line() {
    let header = vec![json!({"type": "user", "cwd": "/home/chetan/Desktop/VTU"}).to_string()];
    let p = PathBuf::from("/home/u/.qwen/projects/-x/chats").join(format!("{UUID}.jsonl"));
    assert_eq!(
        (qwen::FORMAT.agent_id_from_path)(&p, &header).as_deref(),
        Some("qwen-VTU")
    );
}

#[test]
fn qwen_reads_gemini_shaped_parts() {
    let ctx = qwen_ctx();
    let mut state = TailState::default();

    // The assistant role is spelled "model" (Gemini lineage), and a tool call is
    // a `functionCall` part rather than a Claude `tool_use` block.
    let line = json!({
        "type": "assistant", "uuid": "a1", "model": "gpt-5.6-luna",
        "timestamp": "2026-08-16T18:30:02.000Z",
        "message": {"role": "model", "parts": [
            {"text": "Creating it now."},
            {"functionCall": {"id": "call_1", "name": "write_file",
                "args": {"file_path": "/tmp/a.txt", "content": "alpha"}}}
        ]}
    })
    .to_string();
    let (ts, events) = (qwen::FORMAT.transform_line)(&line, &ctx, 100, &mut state);
    // Real timestamps, unlike grok — nothing synthesised.
    assert_eq!(ts.as_deref(), Some("2026-08-16T18:30:02.000Z"));
    assert_eq!(kinds(&events), vec!["model_response", "tool_use"]);
    assert_eq!(events[1]["tool_name"], json!("write_file"));
    // qwen's args are already canonical — no input map anywhere in the stack.
    assert_eq!(events[1]["input"]["file_path"], json!("/tmp/a.txt"));

    // A functionResponse pairs back by id and inherits the remembered name.
    let result = json!({
        "type": "tool_result", "uuid": "t1", "timestamp": "2026-08-16T18:30:03.000Z",
        "message": {"role": "user", "parts": [
            {"functionResponse": {"id": "call_1", "name": "write_file",
                "response": {"output": "written"}}}
        ]}
    })
    .to_string();
    let (_, events) = (qwen::FORMAT.transform_line)(&result, &ctx, 200, &mut state);
    assert_eq!(kinds(&events), vec!["tool_result"]);
    assert_eq!(events[0]["tool_name"], json!("write_file"));
    assert_eq!(events[0]["output"], json!("written"));
}

#[test]
fn qwen_marks_a_failed_call_as_an_error() {
    let ctx = qwen_ctx();
    let mut state = TailState::default();
    let line = json!({
        "type": "tool_result", "timestamp": "2026-08-16T18:30:03.000Z",
        "message": {"role": "user", "parts": [
            {"functionResponse": {"id": "c1", "name": "read_file",
                "response": {"error": "File not found: /tmp/x"}}}
        ]}
    })
    .to_string();
    let (_, events) = (qwen::FORMAT.transform_line)(&line, &ctx, 1, &mut state);
    assert_eq!(events[0]["error_type"], json!("qwen_tool_error"));
    assert_eq!(events[0]["error"], json!("File not found: /tmp/x"));
}

#[test]
fn qwen_skips_system_bookkeeping_lines() {
    let ctx = qwen_ctx();
    let mut state = TailState::default();
    let line = json!({"type": "system", "subtype": "info", "systemPayload": {},
        "timestamp": "2026-08-16T18:30:01.000Z"})
    .to_string();
    let (ts, events) = (qwen::FORMAT.transform_line)(&line, &ctx, 1, &mut state);
    assert!(events.is_empty());
    assert_eq!(ts.as_deref(), Some("2026-08-16T18:30:01.000Z"));
}

#[test]
fn qwen_agent_start_takes_the_first_prompt_as_the_goal() {
    let ctx = qwen_ctx();
    let header = vec![
        json!({"type": "user", "cwd": "/x", "timestamp": "2026-08-16T18:30:00.000Z",
            "message": {"role": "user", "parts": [{"text": "create report.txt"}]}})
        .to_string(),
    ];
    let (start, seed) = (qwen::FORMAT.agent_start)(&header, &ctx, 0).expect("agent_start");
    assert_eq!(start["type"], json!("agent_start"));
    assert_eq!(start["goal"], json!("create report.txt"));
    assert_eq!(seed.as_deref(), Some("2026-08-16T18:30:00.000Z"));
}
