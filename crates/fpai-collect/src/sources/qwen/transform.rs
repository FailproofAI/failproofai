//! Qwen Code transcript → AgentEye events.
//!
//! qwen's bodies are **Gemini-shaped, not Claude-shaped**: `message.parts[]`
//! holds `{text}`, `{functionCall:{id,name,args}}` and
//! `{functionResponse:{id,name,response}}`, and the assistant role is spelled
//! `"model"`. That is the whole reason this is not a clone of the Factory
//! transform despite the near-identical on-disk layout.
//!
//! Timestamps are real (top-level ISO `timestamp` on every line), so unlike the
//! cursor/grok sources nothing here is synthesised.

use serde_json::{Map, Value, json};

use crate::cursor::TailState;
use crate::filetail::Ctx;
// Reused, not re-cloned: `sanitize_id_part` MUST agree with the hook source's
// so a hook event and this transcript's events land under one agent id, and
// `with_index` is a pure timestamp normaliser.
use crate::sources::claude::transform::{sanitize_id_part, with_index};

/// Longest session goal kept — the human's first prompt.
const MAX_GOAL_CHARS: usize = 500;

/// The envelope every emitted event carries.
///
/// `qwen_line_offset` is the dedup discriminator: two identical events from
/// different lines must hash differently. One transcript is one session, so a
/// byte offset is unique within it and stable across a re-read.
fn base(ctx: &Ctx, kind: &str, ts: &str, index: usize, offset: u64) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert("timestamp".into(), json!(with_index(ts, index)?));
    m.insert("session_id".into(), json!(ctx.session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("qwen_line_offset".into(), json!(offset));
    if index > 0 {
        m.insert("qwen_block_index".into(), json!(index));
    }
    Some(m)
}

/// Parse a line, keeping its `type` discriminator.
fn parsed(line: &str) -> Option<(String, Value)> {
    let v: Value = serde_json::from_str(line).ok()?;
    let t = v.get("type")?.as_str()?.to_string();
    Some((t, v))
}

/// Top-level ISO timestamp, only when the server can parse it.
fn ts_of(v: &Value) -> Option<String> {
    let ts = v.get("timestamp")?.as_str()?.to_string();
    with_index(&ts, 0).is_some().then_some(ts)
}

/// Derive `qwen-<project>` from an absolute cwd.
pub fn agent_id_from_cwd(cwd: &str) -> Option<String> {
    let project = sanitize_id_part(
        cwd.trim_end_matches('/')
            .rsplit('/')
            .find(|p| !p.is_empty())?,
    );
    (!project.is_empty()).then(|| format!("qwen-{project}"))
}

/// Concatenate the `text` parts of a `message.parts[]` array.
fn parts_text(message: &Value) -> String {
    message
        .get("parts")
        .and_then(|p| p.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Build the session's `agent_start` from its header: the first user prompt is
/// the goal, and the first parseable timestamp anchors the event.
pub fn agent_start(header: &[String], ctx: &Ctx, offset: u64) -> Option<(Value, Option<String>)> {
    let mut goal: Option<String> = None;
    let mut first_ts: Option<String> = None;

    for line in header {
        let Some((t, v)) = parsed(line) else { continue };
        if first_ts.is_none()
            && let Some(ts) = ts_of(&v)
        {
            first_ts = Some(ts);
        }
        if goal.is_none() && t == "user" {
            let text = v.get("message").map(parts_text).unwrap_or_default();
            if !text.trim().is_empty() {
                goal = Some(text.chars().take(MAX_GOAL_CHARS).collect());
            }
        }
    }

    let ts = first_ts?;
    let mut m = base(ctx, "agent_start", &ts, 0, offset)?;
    if let Some(g) = goal {
        m.insert("goal".into(), json!(g));
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
/// `system` lines are qwen's own bookkeeping and carry no turn, but still
/// return their timestamp so `agent_end` reflects when the file last moved.
pub fn transform_line(
    line: &str,
    ctx: &Ctx,
    offset: u64,
    state: &mut TailState,
) -> (Option<String>, Vec<Value>) {
    let Some((t, v)) = parsed(line) else {
        return (None, Vec::new());
    };
    let ts = ts_of(&v);
    if t == "system" {
        return (ts, Vec::new());
    }
    let (Some(ts), Some(message)) = (ts, v.get("message")) else {
        return (ts_of(&v), Vec::new());
    };
    let model = v.get("model").and_then(|m| m.as_str());
    let role = message
        .get("role")
        .and_then(|r| r.as_str())
        .unwrap_or_default();

    // Gemini spells the assistant "model"; accept both, and treat everything
    // else (user, tool_result) as the inbound side.
    let events = if role == "model" || role == "assistant" {
        assistant_events(message, ctx, &ts, offset, state, model)
    } else {
        user_events(message, ctx, &ts, offset, state)
    };
    (Some(ts), events)
}

/// A user / tool_result message: prompt text and/or function responses.
fn user_events(
    message: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    let Some(parts) = message.get("parts").and_then(|p| p.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        if let Some(fr) = part.get("functionResponse") {
            let Some(mut m) = base(ctx, "tool_result", ts, i, offset) else {
                continue;
            };
            if let Some(id) = fr.get("id").and_then(|x| x.as_str()) {
                m.insert("tool_call_id".into(), json!(id));
                // The name is on the response too, but carry the remembered one
                // when it is not, so no result renders as a blank row.
                if let Some(name) = state.tool_name(id) {
                    m.insert("tool_name".into(), json!(name));
                }
            }
            if let Some(name) = fr.get("name").and_then(|n| n.as_str()) {
                m.insert("tool_name".into(), json!(name));
            }
            if let Some(resp) = fr.get("response") {
                m.insert("output".into(), json!(stringify(resp)));
                // qwen reports a failed call as `response.error`.
                if let Some(err) = resp.get("error") {
                    m.insert("error".into(), json!(stringify(err)));
                    m.insert("error_type".into(), json!("qwen_tool_error"));
                }
            }
            out.push(Value::Object(m));
            continue;
        }
        let Some(text) = part.get("text").and_then(|t| t.as_str()) else {
            continue;
        };
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
    out
}

/// An assistant message: text and/or function calls.
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
    let Some(parts) = message.get("parts").and_then(|p| p.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        if let Some(fc) = part.get("functionCall") {
            let Some(mut m) = base(ctx, "tool_use", ts, i, offset) else {
                continue;
            };
            let name = fc.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
            // Fall back to an offset-derived id so parallel identical calls
            // cannot hash-collapse into one row.
            let id = fc
                .get("id")
                .and_then(|x| x.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("qwen-{offset}-{i}"));
            state.remember_tool(id.clone(), name.to_string());
            m.insert("tool_name".into(), json!(name));
            m.insert("tool_call_id".into(), json!(id));
            if let Some(args) = fc.get("args") {
                m.insert("input".into(), args.clone());
            }
            if let Some(model) = model {
                m.insert("model".into(), json!(model));
            }
            out.push(Value::Object(m));
            continue;
        }
        let Some(text) = part.get("text").and_then(|t| t.as_str()) else {
            continue;
        };
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
    out
}

/// Flatten a `functionResponse.response` payload to display text.
fn stringify(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(map) => {
            for key in ["output", "result", "content", "error"] {
                if let Some(Value::String(s)) = map.get(key)
                    && !s.is_empty()
                {
                    return s.clone();
                }
            }
            v.to_string()
        }
        other => other.to_string(),
    }
}
