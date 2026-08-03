//! Claude Code transcript line → AgentEye events.
//!
//! Every function here is pure in `(line, ctx, offset, state)`, which is what
//! makes a live tail and a full re-read byte-identical and therefore
//! dedup-collapsible. Nothing may consult the clock, a counter, or anything
//! outside its arguments.
//!
//! Record shapes verified against real transcripts on disk (Claude Code 2.1.x):
//!
//! ```text
//! user       {type:"user", timestamp, uuid, message:{role, content}}
//!            content is a STRING for a prompt, or an ARRAY containing
//!            {type:"tool_result", tool_use_id, content, is_error}
//! assistant  {type:"assistant", timestamp, message:{model, id, content:[
//!              {type:"text"|"tool_use", ...}], usage}}
//! ```

use serde_json::{Map, Value, json};

use crate::cursor::TailState;
use crate::filetail::Ctx;

/// Longest derived id component.
const MAX_ID_PART: usize = 48;

/// Make a derived id component safe and bounded.
pub fn sanitize_id_part(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    cleaned
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(MAX_ID_PART)
        .collect()
}

/// Normalize a transcript timestamp to the microsecond form ingest expects,
/// offset by `index` microseconds.
///
/// The offset is what keeps several events derived from ONE line in order:
/// the server sorts by `(ts, random id)`, so an assistant turn's text and its
/// tool calls would otherwise come back shuffled. Index 0 is untouched, so the
/// primary event of a line keeps the line's exact time.
///
/// Saturates within the second rather than carrying, so an offset can never
/// reorder an event past a genuinely later line.
pub fn with_index(ts: &str, index: usize) -> Option<String> {
    let body = ts.strip_suffix('Z')?;
    let (main, frac) = match body.rsplit_once('.') {
        Some((m, f)) => (m, f),
        None => (body, ""),
    };
    // Claude writes milliseconds; pad to microseconds so every event has one
    // shape and sorts against the hook source's events correctly.
    let mut micros: u32 = if frac.is_empty() {
        0
    } else {
        let padded = format!("{frac:0<6}");
        padded.get(..6)?.parse().ok()?
    };
    micros = (micros + index.min(999) as u32).min(999_999);
    Some(format!("{main}.{micros:06}Z"))
}

fn ts_of(v: &Value) -> Option<&str> {
    v.get("timestamp")?.as_str()
}

/// The envelope every emitted event carries.
///
/// `claude_line_offset` is the dedup discriminator: two identical events from
/// different lines must hash differently, or the server collapses them.
fn base(ctx: &Ctx, kind: &str, ts: &str, index: usize, offset: u64) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert("timestamp".into(), json!(with_index(ts, index)?));
    m.insert("session_id".into(), json!(ctx.session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("claude_line_offset".into(), json!(offset));
    if index > 0 {
        m.insert("claude_block_index".into(), json!(index));
    }
    Some(m)
}

/// Build the session's `agent_start` from its header lines.
///
/// Scans for the first line carrying a usable timestamp rather than trusting
/// line 1: a transcript can open with metadata records that have none, and a
/// session with no start event is absent from the product entirely.
pub fn agent_start(header: &[String], ctx: &Ctx, offset: u64) -> Option<(Value, Option<String>)> {
    let mut cwd: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut version: Option<String> = None;
    let mut goal: Option<String> = None;
    let mut first_ts: Option<String> = None;

    for line in header {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if first_ts.is_none()
            && let Some(t) = ts_of(&v)
        {
            first_ts = Some(t.to_string());
        }
        if cwd.is_none()
            && let Some(c) = v.get("cwd").and_then(|c| c.as_str())
        {
            cwd = Some(c.to_string());
        }
        if git_branch.is_none()
            && let Some(b) = v.get("gitBranch").and_then(|b| b.as_str())
        {
            git_branch = Some(b.to_string());
        }
        if version.is_none()
            && let Some(x) = v.get("version").and_then(|x| x.as_str())
        {
            version = Some(x.to_string());
        }
        // The session's goal is its first real human prompt.
        if goal.is_none()
            && v.get("type").and_then(|t| t.as_str()) == Some("user")
            && let Some(text) = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
            && !text.is_empty()
        {
            goal = Some(text.chars().take(1024).collect());
        }
    }

    let ts = first_ts?;
    let mut m = base(ctx, "agent_start", &ts, 0, offset)?;
    if let Some(g) = goal {
        m.insert("goal".into(), json!(g));
    }
    if let Some(c) = cwd {
        m.insert("claude_cwd".into(), json!(c));
    }
    if let Some(b) = git_branch {
        m.insert("claude_git_branch".into(), json!(b));
    }
    if let Some(v) = version {
        m.insert("claude_version".into(), json!(v));
    }
    Some((Value::Object(m), Some(ts)))
}

/// The single `agent_end`, derived deterministically from the last timestamp
/// and the file size (used as its offset, so it is unique per session).
///
/// Index 999 puts it after every content event sharing that timestamp — the
/// server's tie-break is a random id, so without this a session can appear to
/// end before its last turn.
pub fn agent_end(ctx: &Ctx, last_ts: &str, size: u64) -> Value {
    match base(ctx, "agent_end", last_ts, 999, size) {
        Some(m) => Value::Object(m),
        // `base` only fails on an unparseable timestamp, which cannot happen
        // here: `last_ts` came from a line this transform already accepted.
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
pub fn transform_line(
    line: &str,
    ctx: &Ctx,
    offset: u64,
    state: &mut TailState,
) -> (Option<String>, Vec<Value>) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return (None, Vec::new());
    };
    // No timestamp means a metadata record (mode, file-history-snapshot,
    // ai-title, …). Skipped for free rather than needing a type allowlist that
    // would have to grow with every Claude release.
    let Some(ts) = ts_of(&v).map(str::to_string) else {
        return (None, Vec::new());
    };

    let events = match v.get("type").and_then(|t| t.as_str()) {
        Some("user") => user_events(&v, ctx, &ts, offset, state),
        Some("assistant") => assistant_events(&v, ctx, &ts, offset, state),
        _ => Vec::new(),
    };
    (Some(ts), events)
}

/// A `user` line is either a human prompt or the results of tool calls.
fn user_events(v: &Value, ctx: &Ctx, ts: &str, offset: u64, state: &mut TailState) -> Vec<Value> {
    let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
        return Vec::new();
    };

    // A string is a real prompt.
    if let Some(text) = content.as_str() {
        if text.is_empty() {
            return Vec::new();
        }
        let Some(mut m) = base(ctx, "model_request", ts, 0, offset) else {
            return Vec::new();
        };
        // Inherited from the last assistant turn: a user line names no model,
        // and the server builds this row's summary from the model alone.
        if let Some(model) = &state.last_model {
            m.insert("model".into(), json!(model));
        }
        m.insert(
            "messages".into(),
            json!([{ "role": "user", "content": text }]),
        );
        if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
            m.insert("claude_cwd".into(), json!(c));
        }
        return vec![Value::Object(m)];
    }

    // An array carries tool results.
    let Some(blocks) = content.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            continue;
        }
        let call_id = block.get("tool_use_id").and_then(|x| x.as_str());
        let Some(mut m) = base(ctx, "tool_result", ts, i, offset) else {
            continue;
        };
        if let Some(id) = call_id {
            m.insert("tool_call_id".into(), json!(id));
            // The tool's name appears on NO result line. Without carrying it
            // from the call, every result is a blank row in the product.
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
            m.insert("error_type".into(), json!("claude_tool_error"));
        }
        out.push(Value::Object(m));
    }
    out
}

/// An `assistant` line is text and/or tool calls, plus token usage.
fn assistant_events(
    v: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    let Some(message) = v.get("message") else {
        return Vec::new();
    };
    let model = message.get("model").and_then(|m| m.as_str());
    if let Some(m) = model {
        state.last_model = Some(m.to_string());
    }
    let message_id = message.get("id").and_then(|i| i.as_str());

    // One API response is written across several lines that each repeat the
    // SAME usage object. Attributing it per line multiplies token totals, so it
    // is counted once per message id.
    let usage_is_new = match (message_id, state.last_usage_message_id.as_deref()) {
        (Some(id), Some(seen)) => id != seen,
        (Some(_), None) => true,
        _ => false,
    };
    if usage_is_new && let Some(id) = message_id {
        state.last_usage_message_id = Some(id.to_string());
    }

    let Some(blocks) = message.get("content").and_then(|c| c.as_array()) else {
        return Vec::new();
    };

    let mut out: Vec<Value> = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let Some(text) = block.get("text").and_then(|t| t.as_str()) else {
                    continue;
                };
                if text.is_empty() {
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
                if let Some(id) = message_id {
                    m.insert("claude_message_id".into(), json!(id));
                }
                if let Some(sr) = message.get("stop_reason").and_then(|s| s.as_str()) {
                    m.insert("claude_stop_reason".into(), json!(sr));
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
                    .unwrap_or_else(|| format!("claude-{offset}-{i}"));
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

    // Attach usage to the FIRST event of the line, so a line yielding several
    // events reports its tokens once.
    if usage_is_new
        && let Some(usage) = message.get("usage")
        && let Some(first) = out.first_mut()
        && let Some(obj) = first.as_object_mut()
    {
        if let Some(n) = usage.get("input_tokens").and_then(|x| x.as_u64()) {
            obj.insert("input_tokens".into(), json!(n));
        }
        if let Some(n) = usage.get("output_tokens").and_then(|x| x.as_u64()) {
            obj.insert("output_tokens".into(), json!(n));
        }
        obj.insert("claude_usage".into(), usage.clone());
    }

    out
}

/// Render a tool result payload as text. Claude uses a bare string, or an array
/// of typed blocks.
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
