//! grok transcript → AgentEye events.
//!
//! grok's lines are OpenAI-shaped, not Claude-shaped: an assistant turn is a
//! flat `content` string plus `tool_calls[]` whose `arguments` is a JSON
//! **string**, and a result is its own `{type:"tool_result", tool_call_id,
//! content}` line. `system` and `reasoning` lines are not turns.
//!
//! TIME: a grok transcript carries no timestamps on any line, so events are
//! stamped from the file's mtime (`ctx.file_epoch_ms`, captured once at
//! discovery and immutable) plus the byte offset in microseconds — the same
//! scheme the cursor source uses, and for the same reason: it keeps time about
//! right while staying a pure function of the inputs, so a re-read hashes
//! identically and the server collapses it.

use serde_json::{Map, Value, json};

use crate::cursor::TailState;
use crate::filetail::Ctx;
// Reused, not re-cloned: `sanitize_id_part` MUST agree with the hook source's
// agent-id scheme so a hook event and this transcript's events share an id, and
// `to_rfc3339_micros` is a pure epoch→RFC3339 formatter.
use crate::sources::claude::transform::sanitize_id_part;
use crate::sources::goose::transform::to_rfc3339_micros;

/// Longest session goal kept — the operator's first real prompt.
const MAX_GOAL_CHARS: usize = 500;

/// A synthetic event timestamp: the file's mtime plus `offset` microseconds,
/// nudged by the block `index` so several events from one line keep their order.
fn synth_ts(ctx: &Ctx, offset: u64, index: usize) -> Option<String> {
    let base = ctx.file_epoch_ms.unwrap_or(0);
    let micros = offset.saturating_add(index as u64);
    to_rfc3339_micros(
        base.saturating_add((micros / 1000) as i64),
        (micros % 1000) as u32,
    )
}

/// The envelope every emitted event carries. `grok_line_offset` is the dedup
/// discriminator: two identical events from different lines must hash
/// differently.
fn base(ctx: &Ctx, kind: &str, offset: u64, index: usize) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert("timestamp".into(), json!(synth_ts(ctx, offset, index)?));
    m.insert("session_id".into(), json!(ctx.session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("grok_line_offset".into(), json!(offset));
    if index > 0 {
        m.insert("grok_block_index".into(), json!(index));
    }
    Some(m)
}

/// Percent-decode grok's cwd folder, then derive `grok-<project>`.
///
/// Only `%XX` escapes appear in these names; anything malformed falls through
/// as a literal so a strange folder degrades to a visible id rather than none.
pub fn agent_id_from_folder(folder: &str) -> Option<String> {
    let decoded = percent_decode(folder);
    let project = sanitize_id_part(
        decoded
            .trim_end_matches('/')
            .rsplit('/')
            .find(|p| !p.is_empty())?,
    );
    (!project.is_empty()).then(|| format!("grok-{project}"))
}

/// Minimal `%XX` decoder — no dependency, and the input alphabet is grok's own.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `(type, value)` for a line, or `None` when it is not JSON.
fn parsed(line: &str) -> Option<(String, Value)> {
    let v: Value = serde_json::from_str(line).ok()?;
    let t = v.get("type")?.as_str()?.to_string();
    Some((t, v))
}

/// Text from a `content` that is either a string or an array of `{type:"text"}`.
fn content_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A real operator prompt: a `user` line carrying `prompt_index` and no
/// `synthetic_reason`. grok writes its environment preamble and its own
/// reminder injections as `user` lines too, and surfacing those as prompts
/// would make a session read as if the human pasted grok's boilerplate.
fn is_operator_prompt(v: &Value) -> bool {
    v.get("prompt_index").is_some() && v.get("synthetic_reason").is_none()
}

/// Build the session's `agent_start`; the goal is the first operator prompt.
pub fn agent_start(header: &[String], ctx: &Ctx, offset: u64) -> Option<(Value, Option<String>)> {
    let mut m = base(ctx, "agent_start", offset, 0)?;
    let goal = header.iter().find_map(|line| {
        let (t, v) = parsed(line)?;
        if t != "user" || !is_operator_prompt(&v) {
            return None;
        }
        Some(content_text(v.get("content")?))
    });
    if let Some(goal) = goal.filter(|g| !g.trim().is_empty()) {
        m.insert(
            "goal".into(),
            json!(goal.chars().take(MAX_GOAL_CHARS).collect::<String>()),
        );
    }
    Some((Value::Object(m), synth_ts(ctx, offset, 0)))
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

/// One line to its timestamp and the events it yields.
///
/// Every line gets a synthetic timestamp so `agent_end` tracks the file, even
/// for the `system` / `reasoning` lines that produce no events.
pub fn transform_line(
    line: &str,
    ctx: &Ctx,
    offset: u64,
    state: &mut TailState,
) -> (Option<String>, Vec<Value>) {
    let ts = synth_ts(ctx, offset, 0);
    let Some((t, v)) = parsed(line) else {
        return (ts, Vec::new());
    };
    let events = match t.as_str() {
        // The system prompt and the model's private reasoning are not turns.
        "system" | "reasoning" => Vec::new(),
        "user" => user_events(&v, ctx, offset, state),
        "assistant" => assistant_events(&v, ctx, offset, state),
        "tool_result" => tool_result_events(&v, ctx, offset, state),
        _ => Vec::new(),
    };
    (ts, events)
}

/// An operator prompt becomes one `model_request`; anything else is context.
fn user_events(v: &Value, ctx: &Ctx, offset: u64, state: &mut TailState) -> Vec<Value> {
    if !is_operator_prompt(v) {
        return Vec::new();
    }
    let Some(content) = v.get("content") else {
        return Vec::new();
    };
    let text = content_text(content);
    if text.trim().is_empty() {
        return Vec::new();
    }
    let Some(mut m) = base(ctx, "model_request", offset, 0) else {
        return Vec::new();
    };
    if let Some(model) = &state.last_model {
        m.insert("model".into(), json!(model));
    }
    m.insert(
        "messages".into(),
        json!([{ "role": "user", "content": text }]),
    );
    vec![Value::Object(m)]
}

/// An assistant line: its text, then each of its tool calls.
fn assistant_events(v: &Value, ctx: &Ctx, offset: u64, state: &mut TailState) -> Vec<Value> {
    let model = v.get("model_id").and_then(|m| m.as_str());
    if let Some(model) = model {
        state.last_model = Some(model.to_string());
    }
    let mut out = Vec::new();

    let text = v.get("content").map(content_text).unwrap_or_default();
    if !text.trim().is_empty()
        && let Some(mut m) = base(ctx, "model_response", offset, 0)
    {
        m.insert("role".into(), json!("assistant"));
        m.insert("content".into(), json!(text));
        if let Some(model) = model {
            m.insert("model".into(), json!(model));
        }
        out.push(Value::Object(m));
    }

    let calls = v.get("tool_calls").and_then(|c| c.as_array());
    for (i, call) in calls.into_iter().flatten().enumerate() {
        // Index from 1: index 0 belongs to the text event above, and two events
        // from one line must not share a synthetic timestamp.
        let Some(mut m) = base(ctx, "tool_use", offset, i + 1) else {
            continue;
        };
        let name = call.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
        let id = call
            .get("id")
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("grok-{offset}-{i}"));
        state.remember_tool(id.clone(), name.to_string());
        m.insert("tool_name".into(), json!(name));
        m.insert("tool_call_id".into(), json!(id));
        // grok serializes arguments as a JSON STRING; parse it so tool inputs
        // are queryable like every other source's, and keep the raw text when
        // it will not parse rather than dropping the call's arguments.
        if let Some(args) = call.get("arguments") {
            let parsed_args = args
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or_else(|| args.clone());
            m.insert("input".into(), parsed_args);
        }
        if let Some(model) = model {
            m.insert("model".into(), json!(model));
        }
        out.push(Value::Object(m));
    }
    out
}

/// A `tool_result` line, paired back to its call by `tool_call_id`.
fn tool_result_events(v: &Value, ctx: &Ctx, offset: u64, state: &mut TailState) -> Vec<Value> {
    let Some(mut m) = base(ctx, "tool_result", offset, 0) else {
        return Vec::new();
    };
    if let Some(id) = v.get("tool_call_id").and_then(|x| x.as_str()) {
        m.insert("tool_call_id".into(), json!(id));
        // The tool's name is on NO result line — carry it from the call, or
        // every result is a blank row in the product.
        if let Some(name) = state.tool_name(id) {
            m.insert("tool_name".into(), json!(name));
        }
    }
    if let Some(content) = v.get("content") {
        m.insert("output".into(), json!(content_text(content)));
    }
    vec![Value::Object(m)]
}
