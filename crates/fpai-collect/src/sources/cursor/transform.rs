//! Cursor CLI transcript → AgentEye events.
//!
//! Cursor's lines are Claude-shaped — `{role, message:{content:[blocks]}}` with
//! `text` / `tool_use` / `tool_result` blocks — so this mirrors the Claude
//! source's block handling. The one real difference is TIME: a cursor
//! transcript carries **no timestamps** on any line, so events are stamped from
//! the file's mtime (captured once at discovery and carried immutably on `Ctx`
//! as `file_epoch_ms`) plus the byte offset in microseconds. That keeps the
//! time real (about when the session ran) AND a pure function of the inputs,
//! which the content-hash dedup requires — the same line at the same offset
//! always hashes the same across re-reads and restarts.

use serde_json::{Map, Value, json};

use crate::cursor::TailState;
use crate::filetail::Ctx;
// Reused, not re-cloned: `sanitize_id_part` MUST agree with the hook source's
// agent-id scheme, and `to_rfc3339_micros` is a pure epoch→RFC3339 formatter.
use crate::sources::claude::transform::sanitize_id_part;
use crate::sources::goose::transform::to_rfc3339_micros;

/// Longest session goal (the first user prompt) kept.
const MAX_GOAL_CHARS: usize = 500;

/// A synthetic event timestamp: the file's mtime (`ctx.file_epoch_ms`, captured
/// once and immutable) plus `offset` microseconds, nudged by the block `index`
/// so several events from one line keep their order. One byte of offset is one
/// microsecond, so a whole transcript spans on the order of a second of
/// synthetic time and every event orders correctly within the session.
///
/// `file_epoch_ms` is `None` only for a cursor already being tailed before this
/// field existed (an upgrade edge); such a session falls back to the epoch until
/// it is rediscovered, rather than losing its events.
fn synth_ts(ctx: &Ctx, offset: u64, index: usize) -> Option<String> {
    let base = ctx.file_epoch_ms.unwrap_or(0);
    let micros = offset.saturating_add(index as u64);
    to_rfc3339_micros(
        base.saturating_add((micros / 1000) as i64),
        (micros % 1000) as u32,
    )
}

/// The envelope every emitted event carries. `cursor_line_offset` is the dedup
/// discriminator: one transcript is one session, so a byte offset is unique
/// within it and stable across a re-read.
fn base(ctx: &Ctx, kind: &str, offset: u64, index: usize) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert("timestamp".into(), json!(synth_ts(ctx, offset, index)?));
    m.insert("session_id".into(), json!(ctx.session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("cursor_line_offset".into(), json!(offset));
    if index > 0 {
        m.insert("cursor_block_index".into(), json!(index));
    }
    Some(m)
}

/// Cursor wraps a real user prompt in `<user_query>…</user_query>`; strip it so
/// the prompt reads as itself. Text without the wrapper is returned unchanged.
fn unwrap_user_query(text: &str) -> &str {
    text.trim()
        .strip_prefix("<user_query>")
        .and_then(|t| t.strip_suffix("</user_query>"))
        .map(str::trim)
        .unwrap_or(text)
}

/// The message-content blocks of a cursor line, if it is one.
fn blocks(line: &str) -> Option<(String, Vec<Value>)> {
    let v: Value = serde_json::from_str(line).ok()?;
    let role = v.get("role")?.as_str()?.to_string();
    let content = v.get("message")?.get("content")?.as_array()?.clone();
    Some((role, content))
}

/// The first non-empty user prompt in the header, for the session goal.
fn first_user_text(line: &str) -> Option<String> {
    let (role, content) = blocks(line)?;
    if role != "user" {
        return None;
    }
    content.iter().find_map(|b| {
        if b.get("type")?.as_str()? != "text" {
            return None;
        }
        let text = unwrap_user_query(b.get("text")?.as_str()?);
        (!text.trim().is_empty()).then(|| text.to_string())
    })
}

/// `cursor-<project>` from the flattened cwd folder name (`home-u-repo`), which
/// is the only cwd signal — the transcript itself carries none. Lossy: the last
/// dash-segment is the project.
pub fn agent_id_from_folder(folder: &str) -> Option<String> {
    let project = sanitize_id_part(folder.rsplit('-').find(|p| !p.is_empty())?);
    (!project.is_empty()).then(|| format!("cursor-{project}"))
}

/// Build the session's `agent_start`. Cursor has no `session_start` line, so the
/// goal is the first user prompt and the event is stamped at the file base.
pub fn agent_start(header: &[String], ctx: &Ctx, offset: u64) -> Option<(Value, Option<String>)> {
    let mut m = base(ctx, "agent_start", offset, 0)?;
    if let Some(goal) = header.iter().find_map(|l| first_user_text(l)) {
        m.insert(
            "goal".into(),
            json!(goal.chars().take(MAX_GOAL_CHARS).collect::<String>()),
        );
    }
    let seed = synth_ts(ctx, offset, 0);
    Some((Value::Object(m), seed))
}

/// The single `agent_end`, at index 999 so it sorts after every content event,
/// stamped from the file size so it is the latest synthetic time in the session.
pub fn agent_end(ctx: &Ctx, last_ts: &str, size: u64) -> Value {
    match base(ctx, "agent_end", size, 999) {
        Some(m) => Value::Object(m),
        None => json!({
            "timestamp": last_ts,
            "session_id": ctx.session_id,
            "agent_id": ctx.agent_id,
            "type": "agent_end",
            "environment": ctx.environment,
        }),
    }
}

/// One content line to its (synthetic) timestamp and the events it yields.
pub fn transform_line(
    line: &str,
    ctx: &Ctx,
    offset: u64,
    state: &mut TailState,
) -> (Option<String>, Vec<Value>) {
    let Some((role, content)) = blocks(line) else {
        return (None, Vec::new());
    };
    let ts = synth_ts(ctx, offset, 0);
    let events = match role.as_str() {
        "user" => user_events(&content, ctx, offset, state),
        "assistant" => assistant_events(&content, ctx, offset, state),
        _ => Vec::new(),
    };
    (ts, events)
}

fn user_events(content: &[Value], ctx: &Ctx, offset: u64, state: &mut TailState) -> Vec<Value> {
    let mut out = Vec::new();
    for (i, block) in content.iter().enumerate() {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let text = unwrap_user_query(
                    block
                        .get("text")
                        .and_then(|t| t.as_str())
                        .unwrap_or_default(),
                );
                if text.trim().is_empty() {
                    continue;
                }
                let Some(mut m) = base(ctx, "model_request", offset, i) else {
                    continue;
                };
                if let Some(model) = &state.last_model {
                    m.insert("model".into(), json!(model));
                }
                m.insert(
                    "messages".into(),
                    json!([{ "role": "user", "content": text }]),
                );
                out.push(Value::Object(m));
            }
            Some("tool_result") => {
                let Some(mut m) = base(ctx, "tool_result", offset, i) else {
                    continue;
                };
                if let Some(id) = block.get("tool_use_id").and_then(|x| x.as_str()) {
                    m.insert("tool_call_id".into(), json!(id));
                    if let Some(name) = state.tool_name(id) {
                        m.insert("tool_name".into(), json!(name));
                    }
                }
                if let Some(output) = block.get("content") {
                    m.insert("output".into(), json!(stringify(output)));
                }
                out.push(Value::Object(m));
            }
            _ => {}
        }
    }
    out
}

fn assistant_events(
    content: &[Value],
    ctx: &Ctx,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    let mut out = Vec::new();
    for (i, block) in content.iter().enumerate() {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let text = block
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default();
                if text.trim().is_empty() {
                    continue;
                }
                let Some(mut m) = base(ctx, "model_response", offset, i) else {
                    continue;
                };
                m.insert("role".into(), json!("assistant"));
                m.insert("content".into(), json!(text));
                out.push(Value::Object(m));
            }
            Some("tool_use") => {
                let Some(mut m) = base(ctx, "tool_use", offset, i) else {
                    continue;
                };
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                let id = block
                    .get("id")
                    .and_then(|x| x.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("cursor-{offset}-{i}"));
                state.remember_tool(id.clone(), name.to_string());
                m.insert("tool_name".into(), json!(name));
                m.insert("tool_call_id".into(), json!(id));
                if let Some(input) = block.get("input") {
                    m.insert("input".into(), input.clone());
                }
                out.push(Value::Object(m));
            }
            _ => {}
        }
    }
    out
}

/// Flatten a tool-result `content` (string, or an array of text blocks) to text.
fn stringify(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}
