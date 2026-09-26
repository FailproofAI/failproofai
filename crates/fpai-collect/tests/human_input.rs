//! `human_input`: which `user` turns a person wrote, per harness.
//!
//! Every source keeps emitting every `user` turn as a `model_request` exactly as
//! before; these tests pin only the extra event. Each case is a record shape
//! measured on a real machine or a production install — the machine-written
//! ones are why "role: user" alone cannot answer "did a person say this".

use std::collections::HashMap;

use fpai_collect::cursor::TailState;
use fpai_collect::filetail::Ctx;
use fpai_collect::sources::{claude, codex, hermes, openclaw, opencode, pi};
use serde_json::{Value, json};

const TS: &str = "2026-09-25T09:00:01.000Z";

fn ctx() -> Ctx {
    Ctx {
        session_id: "s".into(),
        agent_id: "a".into(),
        environment: "local".into(),
        ..Default::default()
    }
}

/// The `response` of every `human_input` the events carry.
fn said(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|e| e["type"] == "human_input")
        .map(|e| e["response"].as_str().unwrap().to_string())
        .collect()
}

fn claude_user(extra: Value, content: Value) -> Vec<Value> {
    let mut line = json!({"type":"user","timestamp":TS,"uuid":"u-1","message":{"role":"user","content":content}});
    line.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    claude::transform::transform_line(&line.to_string(), &ctx(), 7, &mut TailState::default()).1
}

#[test]
fn claude_a_typed_prompt_is_a_human_input_keyed_on_the_line_uuid() {
    let ev = claude_user(
        json!({"origin":{"kind":"human"},"promptSource":"typed"}),
        json!("fix the login bug"),
    );
    assert_eq!(said(&ev), ["fix the login bug"]);
    assert_eq!(ev[1]["input_id"], "u-1");
    assert_eq!(ev[1]["claude_line_offset"], 7);
}

#[test]
fn claude_a_prompt_with_a_pasted_image_is_no_longer_dropped() {
    let ev = claude_user(
        json!({"origin":{"kind":"human"},"promptSource":"typed"}),
        json!([{"type":"text","text":"[Image #1] still broken"},
               {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]),
    );
    let types: Vec<&str> = ev.iter().filter_map(|e| e["type"].as_str()).collect();
    assert_eq!(types, ["model_request", "human_input"]);
    assert_eq!(said(&ev), ["[Image #1] still broken"]);
}

#[test]
fn claude_machine_written_user_lines_are_not_human_input() {
    for (extra, content) in [
        // Claude Code's own report of a background task.
        (
            json!({"origin":{"kind":"task-notification"},"promptSource":"system"}),
            json!("<task-notification>done</task-notification>"),
        ),
        // Injected skill text / caveats.
        (
            json!({"isMeta":true}),
            json!("<local-command-caveat>Caveat: …</local-command-caveat>"),
        ),
        (
            json!({"isMeta":true}),
            json!([{"type":"text","text":"Base directory for this skill: /x"}]),
        ),
        // Pre-`origin` transcripts: recognised by shape.
        (json!({}), json!("<command-name>/effort</command-name>")),
        (
            json!({}),
            json!("<local-command-stdout>ok</local-command-stdout>"),
        ),
        (
            json!({"isCompactSummary":true}),
            json!("This session is being continued from a previous conversation…"),
        ),
        (
            json!({}),
            json!([{"type":"text","text":"[Request interrupted by user]"}]),
        ),
        // The parent agent briefing a subagent.
        (json!({"isSidechain":true}), json!("Search the repo for X")),
    ] {
        let ev = claude_user(extra.clone(), content.clone());
        assert!(said(&ev).is_empty(), "{extra} {content} → {ev:?}");
    }
}

#[test]
fn claude_a_pre_origin_prompt_still_counts_as_human() {
    assert_eq!(said(&claude_user(json!({}), json!("hello"))), ["hello"]);
}

fn codex_session(source: Value) -> Vec<Value> {
    let mut st = TailState::default();
    let lines = [
        json!({"timestamp":TS,"type":"session_meta","payload":{"id":"x","cwd":"/w","source":source}}),
        json!({"timestamp":TS,"type":"response_item","payload":{"type":"message","role":"user",
            "content":[{"type":"input_text","text":"# AGENTS.md instructions for /w"}]}}),
        json!({"timestamp":TS,"type":"event_msg","payload":{"type":"user_message","message":"add pagination"}}),
        json!({"timestamp":TS,"type":"response_item","payload":{"type":"message","role":"user",
            "content":[{"type":"input_text","text":"add pagination"}]}}),
    ];
    lines
        .iter()
        .enumerate()
        .flat_map(|(i, l)| {
            codex::transform::transform_line(&l.to_string(), &ctx(), i as u64, &mut st).1
        })
        .collect()
}

#[test]
fn codex_the_user_message_record_is_the_human_input_and_agents_md_is_not() {
    let ev = codex_session(json!("cli"));
    assert_eq!(said(&ev), ["add pagination"]);
    // The requests are untouched: AGENTS.md and the prompt, each once.
    assert_eq!(
        ev.iter().filter(|e| e["type"] == "model_request").count(),
        2
    );
}

#[test]
fn codex_sub_agent_and_exec_sessions_have_no_human_input() {
    assert!(said(&codex_session(json!({"subagent":{"thread_spawn":{}}}))).is_empty());
    assert!(said(&codex_session(json!("exec"))).is_empty());
}

#[test]
fn pi_every_user_message_is_the_persons() {
    let line = json!({"type":"message","id":"e1","parentId":null,"timestamp":TS,
        "message":{"role":"user","content":[{"type":"text","text":"rename utils"}],"timestamp":1}});
    let ev =
        pi::transform::transform_line(&line.to_string(), &ctx(), 0, &mut TailState::default()).1;
    assert_eq!(said(&ev), ["rename utils"]);
}

fn openclaw_user(text: &str) -> Vec<Value> {
    let line = json!({"type":"message","id":"m","parentId":null,"timestamp":TS,
        "message":{"role":"user","content":[{"type":"text","text":text}],"timestamp":1}});
    openclaw::transform::transform_line(&line.to_string(), &ctx(), 0, &mut TailState::default()).1
}

#[test]
fn openclaw_runtime_written_turns_are_not_human_input() {
    for text in [
        "[cron:670c0bc5 Bobby status mentions] Run the scheduled heartbeat",
        "[OpenClaw heartbeat poll]",
        "[Subagent Context] Every subagent spawned from this session has now settled",
        "[Inter-session message] sourceSession=agent:forge:dashboard:101a",
        "[System] Your previous turn was interrupted by a gateway restart",
        "Continue the OpenClaw runtime event.",
    ] {
        let ev = openclaw_user(text);
        assert_eq!(ev.len(), 1, "{text}: the request still ships");
        assert!(said(&ev).is_empty(), "{text}");
    }
    assert_eq!(
        said(&openclaw_user("<@U0B> pick this up")),
        ["<@U0B> pick this up"]
    );
}

fn hermes_user(source: Option<&str>) -> Vec<Value> {
    let row = hermes::transform::MessageRow {
        id: 42,
        session_id: "h".into(),
        role: "user".into(),
        content: Some("yes correct".into()),
        tool_call_id: None,
        tool_calls: None,
        tool_name: None,
        timestamp: 1_790_000_000.0,
        finish_reason: None,
        active: 1,
    };
    let meta = hermes::transform::SessionMeta {
        source: source.map(str::to_string),
        ..Default::default()
    };
    hermes::transform::message_events(&row, Some(&meta), "hermes", "local", &mut HashMap::new())
}

#[test]
fn hermes_only_gateway_and_cli_sessions_carry_human_input() {
    for human in ["cli", "slack", "telegram"] {
        let ev = hermes_user(Some(human));
        assert_eq!(said(&ev), ["yes correct"], "{human}");
        assert_eq!(ev[1]["input_id"], "42");
        assert_eq!(ev[1]["hermes_source"], human);
    }
    // No recorded source — an orphan row or a NULL column — is no evidence a
    // person wrote it.
    let unknown = hermes_user(None);
    assert_eq!(unknown.len(), 1, "the request still ships");
    assert!(said(&unknown).is_empty());
    for automated in ["cron", "subagent", "webhook", "oneshot"] {
        let ev = hermes_user(Some(automated));
        assert_eq!(ev.len(), 1, "{automated}: the request still ships");
        assert!(said(&ev).is_empty(), "{automated}");
    }
}

fn opencode_part(data: Value, parent: Option<&str>) -> Vec<Value> {
    let row = opencode::transform::PartRow {
        id: "prt_1".into(),
        session_id: "ses_1".into(),
        message_id: "msg_1".into(),
        directory: "/w".into(),
        time_created: 1_790_000_000_000,
        time_updated: 1_790_000_000_000,
        data,
        message: json!({"role":"user"}),
        parent_id: parent.map(str::to_string),
    };
    opencode::transform::part_events(&row, "local", "opencode")
}

#[test]
fn opencode_synthetic_parts_and_sub_agent_sessions_are_not_human_input() {
    let typed = json!({"type":"text","text":"list the files"});
    assert_eq!(
        said(&opencode_part(typed.clone(), None)),
        ["list the files"]
    );
    assert!(said(&opencode_part(typed, Some("ses_parent"))).is_empty());
    let injected = json!({"type":"text","text":"The following tool was executed by the user","synthetic":true});
    assert!(said(&opencode_part(injected, None)).is_empty());
}

// ── edge cases found by driving the real harnesses in a sandbox ─────────────

#[test]
fn claude_headless_prompts_are_not_human() {
    // `claude -p` and the Agent SDK: no `origin`, `promptSource: "sdk"` (2.1.282).
    let ev = claude_user(json!({"promptSource":"sdk"}), json!("summarise the diff"));
    assert!(said(&ev).is_empty(), "{ev:?}");
    assert_eq!(ev.len(), 1, "the request itself still ships");
    let system = claude_user(
        json!({"promptSource":"system"}),
        json!("a background report"),
    );
    assert!(said(&system).is_empty());
    let image = claude_user(
        json!({"promptSource":"sdk"}),
        json!([{"type":"text","text":"what colour is this"},
               {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]),
    );
    assert!(said(&image).is_empty());
    assert_eq!(image.len(), 1, "a headless image prompt is still a request");
    let queued = claude_user(
        json!({"promptSource":"queued"}),
        json!("then run the tests"),
    );
    assert_eq!(said(&queued), ["then run the tests"]);
}

#[test]
fn claude_a_bare_slash_command_is_not_a_message() {
    // `/compact` lands as a plain user line with no origin and no wrapper.
    assert!(said(&claude_user(json!({}), json!("/compact"))).is_empty());
    let path = claude_user(json!({}), json!("/etc/hosts looks wrong"));
    assert_eq!(
        said(&path),
        ["/etc/hosts looks wrong"],
        "only a lone command, not a path"
    );
}

fn codex_lines(source: Value, body: &[Value]) -> Vec<Value> {
    let mut st = TailState::default();
    let meta = json!({"timestamp":TS,"type":"session_meta","payload":{"id":"x","cwd":"/w","source":source}});
    std::iter::once(&meta)
        .chain(body)
        .enumerate()
        .flat_map(|(i, l)| {
            codex::transform::transform_line(&l.to_string(), &ctx(), i as u64, &mut st).1
        })
        .collect()
}

/// Codex 0.157's record of a typed prompt.
fn codex_item(text: &str, id: &str) -> Value {
    json!({"timestamp":TS,"type":"event_msg","payload":{"type":"item_completed","item":{
        "type":"UserMessage","id":id,"content":[{"type":"text","text":text,"text_elements":[]}]}}})
}

#[test]
fn codex_0_157_records_typed_prompts_as_user_message_items() {
    let agents_md = json!({"timestamp":TS,"type":"response_item","payload":{"type":"message","role":"user",
        "content":[{"type":"input_text","text":"# AGENTS.md instructions for /w"}]}});
    let reply = json!({"timestamp":TS,"type":"event_msg","payload":{"type":"item_completed","item":{
        "type":"AgentMessage","id":"a1","content":[{"type":"Text","text":"done"}]}}});
    let ev = codex_lines(
        json!("cli"),
        &[agents_md, codex_item("fix the flaky test", "item-1"), reply],
    );
    assert_eq!(said(&ev), ["fix the flaky test"]);
    let human = ev.iter().find(|e| e["type"] == "human_input").unwrap();
    assert_eq!(human["input_id"], "item-1");
    assert!(said(&codex_lines(json!("exec"), &[codex_item("scripted", "i")])).is_empty());
}

#[test]
fn codex_a_prompt_in_both_records_is_one_human_input_but_a_repeat_is_two() {
    let um = |t: &str| json!({"timestamp":TS,"type":"event_msg","payload":{"type":"user_message","message":t}});
    assert_eq!(
        said(&codex_lines(
            json!("cli"),
            &[um("hi"), codex_item("hi", "i1")]
        )),
        ["hi"]
    );
    assert_eq!(
        said(&codex_lines(
            json!("cli"),
            &[codex_item("hi", "i1"), um("hi")]
        )),
        ["hi"]
    );
    let twice = codex_lines(
        json!("cli"),
        &[codex_item("continue", "a"), codex_item("continue", "b")],
    );
    assert_eq!(
        said(&twice),
        ["continue", "continue"],
        "the same words sent twice are two messages"
    );
}

fn openclaw_message(extra: Value, text: &str) -> Vec<Value> {
    let mut message = json!({"role":"user","content":[{"type":"text","text":text}],"timestamp":1});
    message
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let line = json!({"type":"message","id":"m","parentId":null,"timestamp":TS,"message":message});
    openclaw::transform::transform_line(&line.to_string(), &ctx(), 0, &mut TailState::default()).1
}

#[test]
fn openclaw_provenance_names_runtime_messages_whatever_their_text() {
    // OpenClaw 2026.9.6 stamps what its runtime wrote into the user role.
    for kind in ["inter_session", "internal_system"] {
        let ev = openclaw_message(
            json!({"provenance":{"kind":kind},"__openclaw":{"senderIsOwner":false}}),
            "hello there",
        );
        assert_eq!(ev.len(), 1, "{kind}: the request still ships");
        assert!(said(&ev).is_empty(), "{kind}");
    }
    let announce = openclaw_user("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context");
    assert!(
        said(&announce).is_empty(),
        "a sub-agent's announce back to its parent"
    );
    let owner = openclaw_message(json!({"__openclaw":{"senderIsOwner":true}}), "fix it");
    assert_eq!(said(&owner), ["fix it"]);
    let unseen = openclaw_message(json!({"provenance":{"kind":"some_new_kind"}}), "fix it");
    assert_eq!(
        said(&unseen),
        ["fix it"],
        "an unknown kind falls through to the text check"
    );
}

#[test]
fn codex_a_cursor_that_never_read_the_header_emits_no_human_input() {
    // A cursor saved before `automated` existed resumes mid-file, past the
    // session header it will never re-read: it cannot know a `codex exec` run
    // from a person, so it emits nothing rather than guess.
    let mut st = TailState::default();
    let line = json!({"timestamp":TS,"type":"event_msg","payload":{"type":"user_message","message":"scripted prompt"}});
    let (_, ev) = codex::transform::transform_line(&line.to_string(), &ctx(), 7, &mut st);
    assert!(said(&ev).is_empty(), "{ev:?}");
}
