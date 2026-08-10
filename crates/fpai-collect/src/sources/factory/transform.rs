//! Factory (droid) transcript → AgentEye events.
//!
//! Factory's lines are Claude-shaped — `message.content` is an array of
//! `text` / `tool_use` / `tool_result` blocks — so this mirrors the Claude
//! source's block handling, differing only in the envelope (`type` is a
//! top-level `session_start` / `message` / `compaction_state`, and the
//! timestamp is a top-level field on `message` lines) and in taking the
//! session's cwd + goal from the `session_start` line rather than a `cwd` field
//! on the first user message.

use serde_json::{Map, Value, json};

use crate::cursor::TailState;
use crate::filetail::Ctx;
// Reused, not re-cloned: `sanitize_id_part` MUST agree with the hook source's
// so a hook event and this transcript's events land under one agent id (the
// Claude/codex sources take the same import), and `with_index` is a pure
// timestamp normaliser that behaves identically on Factory's ISO-millisecond
// stamps.
use crate::sources::claude::transform::{sanitize_id_part, with_index};

/// Longest session goal kept — the human's first prompt / the session title.
const MAX_GOAL_CHARS: usize = 500;

/// The envelope every emitted event carries.
///
/// `factory_line_offset` is the dedup discriminator: two identical events from
/// different lines must hash differently. One transcript is one session, so a
/// byte offset is unique within it and stable across a re-read.
fn base(ctx: &Ctx, kind: &str, ts: &str, index: usize, offset: u64) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert("timestamp".into(), json!(with_index(ts, index)?));
    m.insert("session_id".into(), json!(ctx.session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("factory_line_offset".into(), json!(offset));
    if index > 0 {
        m.insert("factory_block_index".into(), json!(index));
    }
    Some(m)
}

/// `(type, value)` for a line, or `None` when it is not JSON.
fn parsed(line: &str) -> Option<(String, Value)> {
    let v: Value = serde_json::from_str(line).ok()?;
    let t = v.get("type")?.as_str()?.to_string();
    Some((t, v))
}

/// Top-level ISO-millisecond timestamp on a `message` line.
fn ts_of(v: &Value) -> Option<String> {
    v.get("timestamp")?.as_str().map(str::to_string)
}

/// Derive `factory-<project>` from an absolute cwd.
pub fn agent_id_from_cwd(cwd: &str) -> Option<String> {
    let project = sanitize_id_part(
        cwd.trim_end_matches('/')
            .rsplit('/')
            .find(|p| !p.is_empty())?,
    );
    (!project.is_empty()).then(|| format!("factory-{project}"))
}

/// Build the session's `agent_start` from its header.
///
/// The `session_start` line carries the provenance (cwd, title) but NO
/// timestamp, so the event is anchored on the first `message` line's timestamp
/// — a transcript with a `session_start` and no message yet simply has no start
/// event, exactly like an empty live session. Returns the seed timestamp
/// (second tuple element) that primes `agent_end`.
pub fn agent_start(header: &[String], ctx: &Ctx, offset: u64) -> Option<(Value, Option<String>)> {
    let mut cwd: Option<String> = None;
    let mut goal: Option<String> = None;
    let mut first_ts: Option<String> = None;

    for line in header {
        let Some((t, v)) = parsed(line) else {
            continue;
        };
        match t.as_str() {
            "session_start" => {
                if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                    cwd = Some(c.to_string());
                }
                if let Some(g) = v
                    .get("title")
                    .and_then(|g| g.as_str())
                    .filter(|s| !s.is_empty())
                {
                    goal = Some(g.chars().take(MAX_GOAL_CHARS).collect());
                }
            }
            "message" if first_ts.is_none() => {
                if let Some(ts) = ts_of(&v) {
                    // A timestamp the server cannot parse would seed `agent_end`
                    // with an unusable value; skip such a line for anchoring.
                    if with_index(&ts, 0).is_some() {
                        first_ts = Some(ts);
                    }
                }
            }
            _ => {}
        }
    }

    let ts = first_ts?;
    let mut m = base(ctx, "agent_start", &ts, 0, offset)?;
    if let Some(g) = goal {
        m.insert("goal".into(), json!(g));
    }
    if let Some(c) = cwd {
        m.insert("factory_cwd".into(), json!(c));
    }
    Some((Value::Object(m), Some(ts)))
}

/// The single `agent_end`, at index 999 so it sorts after every content event
/// sharing its timestamp.
pub fn agent_end(ctx: &Ctx, last_ts: &str, size: u64) -> Value {
    match base(ctx, "agent_end", last_ts, 999, size) {
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

/// One content line to its timestamp and the events it yields.
///
/// Only `message` lines carry events. `session_start` is the engine's
/// `agent_start` and `compaction_state` is skipped, but both still return their
/// timestamp where present so `agent_end` reflects when the file last moved.
pub fn transform_line(
    line: &str,
    ctx: &Ctx,
    offset: u64,
    state: &mut TailState,
) -> (Option<String>, Vec<Value>) {
    let Some((t, v)) = parsed(line) else {
        return (None, Vec::new());
    };
    if t != "message" {
        return (
            ts_of(&v).filter(|ts| with_index(ts, 0).is_some()),
            Vec::new(),
        );
    }
    let Some(ts) = ts_of(&v).filter(|ts| with_index(ts, 0).is_some()) else {
        return (None, Vec::new());
    };
    let Some(message) = v.get("message") else {
        return (Some(ts), Vec::new());
    };
    let role = message
        .get("role")
        .and_then(|r| r.as_str())
        .unwrap_or_default();
    let model = message.get("model").and_then(|m| m.as_str());
    let events = match role {
        "user" => user_events(message, ctx, &ts, offset, state),
        "assistant" => assistant_events(message, ctx, &ts, offset, state, model),
        _ => Vec::new(),
    };
    (Some(ts), events)
}

/// A user message: prompt text and/or tool results.
fn user_events(
    message: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    let content = message.get("content");

    // Defensive: a plain-string content is a bare prompt.
    if let Some(text) = content.and_then(|c| c.as_str()) {
        if text.is_empty() {
            return Vec::new();
        }
        let Some(mut m) = base(ctx, "model_request", ts, 0, offset) else {
            return Vec::new();
        };
        if let Some(model) = &state.last_model {
            m.insert("model".into(), json!(model));
        }
        m.insert(
            "messages".into(),
            json!([{ "role": "user", "content": text }]),
        );
        return vec![Value::Object(m)];
    }

    let Some(blocks) = content.and_then(|c| c.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let text = block
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default();
                if text.trim().is_empty() {
                    continue;
                }
                let Some(mut m) = base(ctx, "model_request", ts, i, offset) else {
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
                let Some(mut m) = base(ctx, "tool_result", ts, i, offset) else {
                    continue;
                };
                if let Some(id) = block.get("tool_use_id").and_then(|x| x.as_str()) {
                    m.insert("tool_call_id".into(), json!(id));
                    // The tool's name is on NO result line — carry it from the
                    // call, or every result is a blank row in the product.
                    if let Some(name) = state.tool_name(id) {
                        m.insert("tool_name".into(), json!(name));
                    }
                }
                if let Some(output) = block.get("content") {
                    m.insert("output".into(), json!(stringify(output)));
                }
                if block.get("is_error").and_then(|e| e.as_bool()) == Some(true) {
                    m.insert(
                        "error".into(),
                        json!(stringify(block.get("content").unwrap_or(&Value::Null))),
                    );
                    m.insert("error_type".into(), json!("factory_tool_error"));
                }
                out.push(Value::Object(m));
            }
            _ => {}
        }
    }
    out
}

/// An assistant message: text and/or tool calls.
fn assistant_events(
    message: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
    model: Option<&str>,
) -> Vec<Value> {
    if let Some(model) = model {
        state.last_model = Some(model.to_string());
    }
    let Some(blocks) = message.get("content").and_then(|c| c.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let text = block
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default();
                if text.trim().is_empty() {
                    continue;
                }
                let Some(mut m) = base(ctx, "model_response", ts, i, offset) else {
                    continue;
                };
                m.insert("role".into(), json!("assistant"));
                m.insert("content".into(), json!(text));
                if let Some(model) = model {
                    m.insert("model".into(), json!(model));
                }
                out.push(Value::Object(m));
            }
            Some("tool_use") => {
                let Some(mut m) = base(ctx, "tool_use", ts, i, offset) else {
                    continue;
                };
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                // Fall back to an offset-derived id so parallel identical calls
                // cannot hash-collapse into one row.
                let id = block
                    .get("id")
                    .and_then(|x| x.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("factory-{offset}-{i}"));
                state.remember_tool(id.clone(), name.to_string());
                m.insert("tool_name".into(), json!(name));
                m.insert("tool_call_id".into(), json!(id));
                if let Some(input) = block.get("input") {
                    m.insert("input".into(), input.clone());
                }
                if let Some(model) = model {
                    m.insert("model".into(), json!(model));
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
