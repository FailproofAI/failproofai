//! OpenClaw transcript line → AgentEye events.
//!
//! Every function here is pure in `(line, ctx, offset, state)`, which is what
//! makes a live tail and a full re-read byte-identical and therefore
//! dedup-collapsible. Nothing may consult the clock, a counter, or anything
//! outside its arguments.
//!
//! Record shapes verified against a live containerised probe capture. Each
//! record chains to the previous one through `id`/`parentId` (8 hex chars), and
//! carries a record-level ISO-8601 `timestamp`:
//!
//! ```text
//! session                {type:"session", version, id, timestamp, cwd}
//! model_change           {type:"model_change", provider, modelId, …}
//! thinking_level_change  {type:"thinking_level_change", thinkingLevel, …}
//! custom                 {type:"custom", customType, data:{…}, …}
//! message                {type:"message", timestamp, message:{role, …}}
//! ```
//!
//! `message` has THREE roles, not two — `toolResult` is its own role on its own
//! record rather than a block inside a user turn the way Claude writes it:
//!
//! ```text
//! user        {role:"user", content:[{type:"text",text}], timestamp}
//! assistant   {role:"assistant", content:[{type:"text"|"toolCall", …}],
//!              api, provider, model, usage, stopReason, responseId, timestamp}
//! toolResult  {role:"toolResult", toolCallId, toolName,
//!              content:[{type:"text",text}], details?, isError, timestamp}
//! ```
//!
//! # The two clocks
//!
//! Every record carries a record-level ISO-8601 `timestamp` AND an inner
//! `message.timestamp` in epoch **milliseconds**, and they are not the same
//! instant. On an assistant record the inner one is when the model request was
//! issued, the outer one is when the response was written: measured on the
//! capture, `2026-08-03T08:01:44.024Z` against an inner `1785744100111` =
//! `08:01:40.111`, a 3.9-second gap. Only the outer clock is present on all
//! five record types and only the outer clock advances with the file, so it is
//! the single source of event time here. Mixing the two — outer for a tool
//! result, inner for the assistant turn that requested it — would silently
//! reorder a session's timeline by seconds.

use serde_json::{Map, Value, json};

use crate::cursor::TailState;
use crate::filetail::Ctx;

/// Longest derived id component.
const MAX_ID_PART: usize = 48;
/// Longest session goal kept from the opening prompt.
const MAX_GOAL_CHARS: usize = 1024;

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
/// The offset is what keeps several events derived from ONE line in order: the
/// server sorts by `(ts, random id)`, so the two `toolCall` blocks OpenClaw
/// packs into a single assistant record — both of which really do share the
/// record's millisecond — would otherwise come back shuffled, showing a session
/// reading a file before it listed the directory. Index 0 is untouched, so the
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
    // OpenClaw writes milliseconds; pad to microseconds so every event has one
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

/// The record-level timestamp — never `message.timestamp`. See the module docs.
fn ts_of(v: &Value) -> Option<&str> {
    v.get("timestamp")?.as_str()
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str()
}

/// The envelope every emitted event carries.
///
/// `openclaw_line_offset` is the dedup discriminator: two identical events from
/// different lines must hash differently, or the server collapses them — and a
/// session that asks the same question twice is completely ordinary.
fn base(ctx: &Ctx, kind: &str, ts: &str, index: usize, offset: u64) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert("timestamp".into(), json!(with_index(ts, index)?));
    m.insert("session_id".into(), json!(ctx.session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("openclaw_line_offset".into(), json!(offset));
    if index > 0 {
        m.insert("openclaw_block_index".into(), json!(index));
    }
    Some(m)
}

/// Flatten a content array to its text.
///
/// OpenClaw's content is always an array of typed blocks, for all three roles —
/// a user prompt is `[{type:"text",text}]`, not the bare string Claude writes.
/// The string arm is tolerance for a shape change, not an observed shape:
/// without it a future bare string would be rendered through `to_string()` and
/// arrive quoted and backslash-escaped.
fn joined_text(content: &Value) -> String {
    match content {
        Value::Array(items) => items
            .iter()
            .filter(|b| str_at(b, "type") == Some("text"))
            .filter_map(|b| str_at(b, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Build the session's `agent_start` from its header lines.
///
/// Scans for the first line carrying a timestamp rather than trusting line 1,
/// because a session with no start event is not merely incomplete — the server
/// selects sessions on this event, so it is absent from the product entirely.
pub fn agent_start(header: &[String], ctx: &Ctx, offset: u64) -> Option<(Value, Option<String>)> {
    let mut first_ts: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut version: Option<u64> = None;
    let mut provider: Option<String> = None;
    let mut model: Option<String> = None;
    let mut goal: Option<String> = None;

    for line in header {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if first_ts.is_none()
            && let Some(t) = ts_of(&v)
        {
            first_ts = Some(t.to_string());
        }
        match str_at(&v, "type") {
            Some("session") => {
                if cwd.is_none() {
                    cwd = str_at(&v, "cwd").map(str::to_string);
                }
                if version.is_none() {
                    version = v.get("version").and_then(|x| x.as_u64());
                }
            }
            // The model reaches the start event from the same record that
            // seeds `TailState`, so the session header and its first prompt
            // agree on it instead of the header saying nothing.
            Some("model_change") => {
                if provider.is_none() {
                    provider = str_at(&v, "provider").map(str::to_string);
                }
                if model.is_none() {
                    model = str_at(&v, "modelId").map(str::to_string);
                }
            }
            // The session's goal is its first real human prompt.
            Some("message") if goal.is_none() => {
                let Some(message) = v.get("message") else {
                    continue;
                };
                if str_at(message, "role") != Some("user") {
                    continue;
                }
                let text = joined_text(message.get("content").unwrap_or(&Value::Null));
                if !text.is_empty() {
                    goal = Some(text.chars().take(MAX_GOAL_CHARS).collect());
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
    // The agent workspace, not a project directory — recorded for provenance,
    // never used to group sessions. See the module docs on `mod.rs`.
    if let Some(c) = cwd {
        m.insert("openclaw_cwd".into(), json!(c));
    }
    if let Some(v) = version {
        m.insert("openclaw_session_version".into(), json!(v));
    }
    if let Some(p) = provider {
        m.insert("openclaw_provider".into(), json!(p));
    }
    if let Some(x) = model {
        m.insert("model".into(), json!(x));
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
    let Some(ts) = ts_of(&v).map(str::to_string) else {
        return (None, Vec::new());
    };

    let events = match str_at(&v, "type") {
        Some("message") => message_events(&v, ctx, &ts, offset, state),
        // Not an event, but the record that makes the session's FIRST prompt
        // render with a model. A user record names no model, and the server
        // builds a `model_request` row's summary from the model alone — so
        // without this the opening row of every session is blank, which is the
        // row most likely to be looked at.
        Some("model_change") => {
            if let Some(m) = str_at(&v, "modelId") {
                state.last_model = Some(m.to_string());
            }
            Vec::new()
        }
        // `session`, `thinking_level_change` and `custom` describe the harness,
        // not the conversation. They still return their timestamp above, so a
        // trailing `custom` record — which is exactly what the capture ends
        // with — carries `agent_end` to the true end of the session rather than
        // leaving it stuck at the last message.
        _ => Vec::new(),
    };
    (Some(ts), events)
}

fn message_events(
    v: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    let Some(message) = v.get("message") else {
        return Vec::new();
    };
    match str_at(message, "role") {
        Some("user") => user_events(message, ctx, ts, offset, state),
        Some("assistant") => assistant_events(message, ctx, ts, offset, state),
        Some("toolResult") => tool_result_events(message, ctx, ts, offset, state),
        _ => Vec::new(),
    }
}

/// A `user` record is a human prompt. Tool results are their own role in
/// OpenClaw, so unlike Claude this branch never has to disambiguate.
fn user_events(message: &Value, ctx: &Ctx, ts: &str, offset: u64, state: &TailState) -> Vec<Value> {
    let text = joined_text(message.get("content").unwrap_or(&Value::Null));
    if text.is_empty() {
        return Vec::new();
    }
    let Some(mut m) = base(ctx, "model_request", ts, 0, offset) else {
        return Vec::new();
    };
    // Inherited from the last `model_change` or assistant turn: a user record
    // names no model.
    if let Some(model) = &state.last_model {
        m.insert("model".into(), json!(model));
    }
    m.insert(
        "messages".into(),
        json!([{ "role": "user", "content": text }]),
    );
    vec![Value::Object(m)]
}

/// An `assistant` record is text and/or tool calls, plus token usage.
fn assistant_events(
    message: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    let model = str_at(message, "model");
    if let Some(m) = model {
        state.last_model = Some(m.to_string());
    }
    let provider = str_at(message, "provider");
    let response_id = str_at(message, "responseId");
    let stop_reason = str_at(message, "stopReason");

    let Some(blocks) = message.get("content").and_then(|c| c.as_array()) else {
        return Vec::new();
    };

    let mut out: Vec<Value> = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        match str_at(block, "type") {
            Some("text") => {
                let Some(text) = str_at(block, "text").filter(|t| !t.is_empty()) else {
                    continue;
                };
                let Some(mut m) = base(ctx, "model_response", ts, i, offset) else {
                    continue;
                };
                m.insert("role".into(), json!("assistant"));
                m.insert("content".into(), json!(text));
                if let Some(x) = model {
                    m.insert("model".into(), json!(x));
                }
                if let Some(x) = provider {
                    m.insert("openclaw_provider".into(), json!(x));
                }
                if let Some(x) = response_id {
                    m.insert("openclaw_response_id".into(), json!(x));
                }
                if let Some(x) = stop_reason {
                    m.insert("openclaw_stop_reason".into(), json!(x));
                }
                out.push(Value::Object(m));
            }
            Some("toolCall") => {
                let Some(mut m) = base(ctx, "tool_use", ts, i, offset) else {
                    continue;
                };
                let name = str_at(block, "name").unwrap_or("tool");
                // Fall back to an offset-derived id so two identical calls in
                // one record cannot hash-collapse into a single row.
                let id = str_at(block, "id")
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("openclaw-{offset}-{i}"));
                state.remember_tool(id.clone(), name.to_string());
                m.insert("tool_name".into(), json!(name));
                m.insert("tool_call_id".into(), json!(id));
                // `arguments` only. The sibling `partialArgs` is the same
                // object re-encoded as a JSON string — shipping both doubles
                // every tool call's payload to say the same thing twice.
                if let Some(args) = block.get("arguments") {
                    m.insert("input".into(), args.clone());
                }
                if let Some(x) = model {
                    m.insert("model".into(), json!(x));
                }
                if let Some(x) = response_id {
                    m.insert("openclaw_response_id".into(), json!(x));
                }
                out.push(Value::Object(m));
            }
            // Anything else (a future thinking/reasoning block) is skipped
            // rather than guessed at, but still consumes its index, so the
            // blocks around it keep their relative order.
            _ => {}
        }
    }

    // Attach usage to the FIRST event of the record, so a record yielding
    // several events reports its tokens once.
    //
    // No message-id guard here, unlike the Claude source: OpenClaw writes one
    // record per API response — every block of a response shares that record's
    // `content` array, and each record carries its own `responseId` — so usage
    // is never repeated across lines and gating on an id could only drop a
    // legitimate second response.
    if let Some(usage) = message.get("usage")
        && let Some(first) = out.first_mut()
        && let Some(obj) = first.as_object_mut()
    {
        if let Some(n) = usage.get("input").and_then(|x| x.as_u64()) {
            obj.insert("input_tokens".into(), json!(n));
        }
        if let Some(n) = usage.get("output").and_then(|x| x.as_u64()) {
            obj.insert("output_tokens".into(), json!(n));
        }
        obj.insert("openclaw_usage".into(), usage.clone());
    }

    out
}

/// A `toolResult` record — its own role on its own record, paired back to the
/// call by `toolCallId` == the call's `id`.
fn tool_result_events(
    message: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &TailState,
) -> Vec<Value> {
    let Some(mut m) = base(ctx, "tool_result", ts, 0, offset) else {
        return Vec::new();
    };
    let call_id = str_at(message, "toolCallId");
    if let Some(id) = call_id {
        m.insert("tool_call_id".into(), json!(id));
    }
    // OpenClaw usually names the tool on the result too. When it does not, the
    // name carried from the call is the only thing standing between this and a
    // blank row, because the server builds a result row's summary from the tool
    // name alone.
    let name = str_at(message, "toolName")
        .filter(|n| !n.is_empty())
        .or_else(|| call_id.and_then(|id| state.tool_name(id)));
    if let Some(n) = name {
        m.insert("tool_name".into(), json!(n));
    }

    let output = joined_text(message.get("content").unwrap_or(&Value::Null));
    m.insert("output".into(), json!(output));

    // `details` is absent on some results — the capture's `read` result has
    // none while its `exec` results do — so every field under it is optional
    // and its absence must not cost the whole event.
    if let Some(details) = message.get("details") {
        if let Some(d) = details.get("durationMs").and_then(|x| x.as_f64()) {
            m.insert("duration_ms".into(), json!(d));
        }
        if let Some(s) = str_at(details, "status") {
            m.insert("openclaw_tool_status".into(), json!(s));
        }
        if let Some(c) = details.get("exitCode").and_then(|x| x.as_i64()) {
            m.insert("openclaw_exit_code".into(), json!(c));
        }
        // `details.aggregated` and `details.cwd` are deliberately dropped:
        // `aggregated` is a byte-for-byte copy of the text content above, and
        // `cwd` is the same fixed agent workspace on every result in the
        // session.
    }

    if message.get("isError").and_then(|e| e.as_bool()) == Some(true) {
        // The server's `is_error` is a truthiness check, so an empty string
        // would render a failed tool call as a success.
        let reason = if output.trim().is_empty() {
            "openclaw reported a tool failure with no message".to_string()
        } else {
            output
        };
        m.insert("error".into(), json!(reason));
        m.insert("error_type".into(), json!("openclaw_tool_error"));
    }

    vec![Value::Object(m)]
}
