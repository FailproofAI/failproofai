//! Pi transcript line → AgentEye events.
//!
//! Every function here is pure in `(line, ctx, offset, state)`, which is what
//! makes a live tail and a full re-read byte-identical and therefore
//! dedup-collapsible. Nothing may consult the clock, a counter, or anything
//! outside its arguments.
//!
//! Record shapes verified against real transcripts on disk, captured from
//! pi-coding-agent **0.73.1 and 0.83.0** — the grammar is identical across the
//! two, which is why one `Format` covers both:
//!
//! ```text
//! session      {type:"session", version:3, id:<uuid-v7>, timestamp, cwd}
//! model_change {type:"model_change", id, parentId, timestamp, provider, modelId}
//! message      {type:"message", id, parentId, timestamp, message:{…}}
//!   role:"user"       content:[{type:"text", text}], timestamp:<epoch-ms>
//!   role:"assistant"  content:[{type:"text"|"toolCall", …}], model, provider,
//!                     usage:{input,output,cacheRead,cacheWrite,totalTokens},
//!                     stopReason:"stop"|"toolUse"|"error", responseId?,
//!                     errorMessage?
//!   role:"toolResult" toolCallId, toolName, content:[{type:"text", text}],
//!                     isError, timestamp:<epoch-ms>
//! ```
//!
//! Two things about that grammar are easy to get wrong and are load-bearing
//! here:
//!
//! * **`toolResult` is a THIRD role, on its own record.** It is not folded into
//!   the next user turn the way Claude Code folds `tool_result` blocks, so the
//!   pairing is record-to-record and must be done by `toolCallId` — never by
//!   arrival order. Real transcripts issue two calls in ONE assistant record
//!   and then write two separate result records.
//! * **Assistant content is not homogeneous.** 0.73.1 emitted `["toolCall",
//!   "toolCall"]` where 0.83.0 emitted `["text","toolCall","toolCall"]` for the
//!   same prompt. Anything that peeks at `content[0]` to decide what a turn is
//!   silently drops the prose on one version and the calls on the other.

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
/// server sorts by `(ts, random id)`, and a single pi assistant record routinely
/// yields three events (prose plus two tool calls) that all share one
/// millisecond — so without it a turn comes back shuffled, with the calls
/// appearing to precede the sentence that introduced them. Index 0 is
/// untouched, so the primary event of a line keeps the line's exact time.
///
/// Saturates within the second rather than carrying, so an offset can never
/// reorder an event past a genuinely later line.
pub fn with_index(ts: &str, index: usize) -> Option<String> {
    let body = ts.strip_suffix('Z')?;
    let (main, frac) = match body.rsplit_once('.') {
        Some((m, f)) => (m, f),
        None => (body, ""),
    };
    // pi writes `new Date().toISOString()`, i.e. milliseconds; pad to
    // microseconds so every event has one shape and sorts against the hook
    // source's events correctly.
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
/// `pi_line_offset` is the dedup discriminator: two identical events from
/// different lines must hash differently, or the server collapses them. pi makes
/// this easy to need — a retried prompt is literally the same JSON body — so the
/// byte offset is the only thing distinguishing them.
fn base(ctx: &Ctx, kind: &str, ts: &str, index: usize, offset: u64) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert("timestamp".into(), json!(with_index(ts, index)?));
    m.insert("session_id".into(), json!(ctx.session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("pi_line_offset".into(), json!(offset));
    if index > 0 {
        m.insert("pi_block_index".into(), json!(index));
    }
    Some(m)
}

/// Build the session's `agent_start` from its header lines.
///
/// pi's line 1 is always the `session` record and always carries both the
/// timestamp and the real `cwd`, but this still scans rather than trusting line
/// 1: a session with no start event is not merely incomplete, it is absent from
/// the product entirely, so the one place that must never be brittle is this.
pub fn agent_start(header: &[String], ctx: &Ctx, offset: u64) -> Option<(Value, Option<String>)> {
    let mut first_ts: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut version: Option<u64> = None;
    let mut parent_session: Option<String> = None;
    let mut model: Option<String> = None;
    let mut provider: Option<String> = None;
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
        if cwd.is_none()
            && let Some(c) = v.get("cwd").and_then(|c| c.as_str())
        {
            cwd = Some(c.to_string());
        }
        if version.is_none() {
            // A NUMBER, not a string — the header reads `"version": 3`.
            version = v.get("version").and_then(|x| x.as_u64());
        }
        // Present only on a forked or branched session, and the only on-disk
        // link back to the transcript it was cut from.
        if parent_session.is_none()
            && let Some(p) = v.get("parentSession").and_then(|p| p.as_str())
        {
            parent_session = Some(p.to_string());
        }
        if model.is_none() {
            model = model_of(&v);
        }
        if provider.is_none() {
            provider = provider_of(&v);
        }
        // The session's goal is its first human prompt.
        if goal.is_none()
            && v.get("type").and_then(|t| t.as_str()) == Some("message")
            && let Some(message) = v.get("message")
            && message.get("role").and_then(|r| r.as_str()) == Some("user")
            && let Some(text) = user_text(message)
        {
            goal = Some(text.chars().take(MAX_GOAL_CHARS).collect());
        }
    }

    let ts = first_ts?;
    let mut m = base(ctx, "agent_start", &ts, 0, offset)?;
    if let Some(g) = goal {
        m.insert("goal".into(), json!(g));
    }
    if let Some(c) = cwd {
        m.insert("pi_cwd".into(), json!(c));
    }
    if let Some(x) = version {
        m.insert("pi_session_version".into(), json!(x));
    }
    if let Some(p) = parent_session {
        m.insert("pi_parent_session".into(), json!(p));
    }
    if let Some(x) = model {
        m.insert("pi_model".into(), json!(x));
    }
    if let Some(p) = provider {
        m.insert("pi_provider".into(), json!(p));
    }
    Some((Value::Object(m), Some(ts)))
}

/// The single `agent_end`, derived deterministically from the last timestamp and
/// the file size (used as its offset, so it is unique per session).
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
///
/// Unlike Claude Code, EVERY pi record carries a top-level `timestamp` — so the
/// "no timestamp means metadata" shortcut that source relies on does not exist
/// here and the dispatch has to be explicit. Records pi models but we do not
/// (`compaction`, `branch_summary`, `label`, `session_info`, `custom`,
/// `thinking_level_change`) still return their timestamp, so `agent_end` lands
/// on the session's real last activity rather than on its last *message*.
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

    let events = match v.get("type").and_then(|t| t.as_str()) {
        Some("message") => message_events(&v, ctx, &ts, offset, state),
        // Emits nothing, but is the reason this format needs no `seed_state`:
        // pi writes `model_change` BEFORE the session's first user message, so
        // the opening prompt already has a model to inherit. Claude Code has to
        // seed one out of band, which is not dedup-safe between a live tail and
        // a later re-read; pi gets the same result from the file's own order.
        Some("model_change") => {
            if let Some(id) = v.get("modelId").and_then(|m| m.as_str()) {
                state.last_model = Some(id.to_string());
            }
            Vec::new()
        }
        _ => Vec::new(),
    };
    (Some(ts), events)
}

/// A `message` record is a user prompt, an assistant turn, or ONE tool result.
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
    match message.get("role").and_then(|r| r.as_str()) {
        Some("user") => user_events(message, ctx, ts, offset, state),
        Some("assistant") => assistant_events(message, ctx, ts, offset, state),
        Some("toolResult") => tool_result_events(message, ctx, ts, offset, state),
        // `custom` (and pre-v3 `hookMessage`, which the v2→v3 migration renames
        // to it) carries extension output, not conversation. Skipped rather
        // than mapped, so it cannot masquerade as a real turn.
        _ => Vec::new(),
    }
}

/// A `user` message is one prompt, whatever number of text blocks it is spread
/// across.
fn user_events(
    message: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    let Some(text) = user_text(message) else {
        return Vec::new();
    };
    let Some(mut m) = base(ctx, "model_request", ts, 0, offset) else {
        return Vec::new();
    };
    // A user record names no model. Inherited from the preceding `model_change`
    // or assistant turn, because the server builds this row's summary from the
    // model alone and would otherwise render the row blank.
    if let Some(model) = &state.last_model {
        m.insert("model".into(), json!(model));
    }
    m.insert(
        "messages".into(),
        json!([{ "role": "user", "content": text }]),
    );
    vec![Value::Object(m)]
}

/// An `assistant` message is prose and/or tool calls, plus token usage.
fn assistant_events(
    message: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    let model = message.get("model").and_then(|m| m.as_str());
    if let Some(m) = model {
        state.last_model = Some(m.to_string());
    }
    let response_id = message.get("responseId").and_then(|i| i.as_str());
    let stop_reason = message.get("stopReason").and_then(|s| s.as_str());

    let empty: Vec<Value> = Vec::new();
    let blocks = message
        .get("content")
        .and_then(|c| c.as_array())
        .unwrap_or(&empty);

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
                if let Some(id) = response_id {
                    m.insert("pi_response_id".into(), json!(id));
                }
                if let Some(sr) = stop_reason {
                    m.insert("pi_stop_reason".into(), json!(sr));
                }
                out.push(Value::Object(m));
            }
            Some("toolCall") => {
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
                    .unwrap_or_else(|| format!("pi-{offset}-{i}"));
                state.remember_tool(id.clone(), name.to_string());
                m.insert("tool_name".into(), json!(name));
                m.insert("tool_call_id".into(), json!(id));
                // pi names the payload `arguments`; ingest reads `input`.
                if let Some(args) = block.get("arguments") {
                    m.insert("input".into(), args.clone());
                }
                if let Some(model) = model {
                    m.insert("model".into(), json!(model));
                }
                out.push(Value::Object(m));
            }
            // `thinking` blocks are deliberately not shipped: they are reasoning
            // traces, not conversation, and carry the same disclosure weight as
            // a prompt without adding a row anyone acts on.
            _ => {}
        }
    }

    // A failed turn writes an EMPTY content array plus `errorMessage` — a real
    // 404 looks exactly like that on disk. Without this the prompt that
    // triggered it is the last thing in the session and the failure is
    // invisible. Indexed past the last block so it can never collide with one.
    if let Some(err) = message.get("errorMessage").and_then(|e| e.as_str())
        && !err.is_empty()
        && let Some(mut m) = base(ctx, "model_response", ts, blocks.len(), offset)
    {
        m.insert("role".into(), json!("assistant"));
        m.insert("content".into(), json!(err));
        m.insert("error".into(), json!(err));
        m.insert("error_type".into(), json!("pi_model_error"));
        if let Some(model) = model {
            m.insert("model".into(), json!(model));
        }
        if let Some(sr) = stop_reason {
            m.insert("pi_stop_reason".into(), json!(sr));
        }
        out.push(Value::Object(m));
    }

    // Attach usage to the FIRST event of the record, so a record yielding
    // several events reports its tokens once.
    //
    // Billed unconditionally, unlike the Claude source, which has to gate on a
    // message id: Claude Code splits ONE API response across several lines that
    // each repeat the same usage object, whereas pi writes exactly one record
    // per response with its own `usage`. Gating here would instead DROP the
    // usage of every errored turn, which carries no `responseId` to gate on.
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
        obj.insert("pi_usage".into(), usage.clone());
    }

    out
}

/// A `toolResult` message is exactly one result for exactly one call.
fn tool_result_events(
    message: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    let Some(mut m) = base(ctx, "tool_result", ts, 0, offset) else {
        return Vec::new();
    };
    let call_id = message.get("toolCallId").and_then(|x| x.as_str());
    if let Some(id) = call_id {
        m.insert("tool_call_id".into(), json!(id));
    }

    // pi does name the tool on the result record — but the carried name is
    // still consulted as the fallback, because it is the only source that
    // cannot go missing: a result whose `toolName` is absent (an older writer,
    // a truncated record) would otherwise be a blank row, which is exactly the
    // failure `TailState::pending_tools` exists to prevent. Pairing is BY ID,
    // never by arrival order — one assistant record can issue several calls.
    let name = message
        .get("toolName")
        .and_then(|n| n.as_str())
        .map(str::to_string)
        .or_else(|| {
            call_id
                .and_then(|id| state.tool_name(id))
                .map(str::to_string)
        });
    if let Some(n) = name {
        m.insert("tool_name".into(), json!(n));
    }

    if let Some(content) = message.get("content") {
        let text = stringify(content);
        m.insert("output".into(), json!(text));
        if message.get("isError").and_then(|e| e.as_bool()) == Some(true) {
            m.insert("error".into(), json!(text));
            m.insert("error_type".into(), json!("pi_tool_error"));
        }
    }
    vec![Value::Object(m)]
}

/// The concatenated text of a message's content blocks.
///
/// Tolerates a bare string as well as the v3 typed-block array: the v1→v3
/// migrations rewrite roles rather than shapes, so an older transcript that is
/// still on disk and never reopened by pi keeps whatever it was written with.
fn user_text(message: &Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(s) = content.as_str() {
        return (!s.is_empty()).then(|| s.to_string());
    }
    let joined = content
        .as_array()?
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    (!joined.is_empty()).then_some(joined)
}

/// Render a tool result payload as text. pi uses an array of typed blocks; a
/// bare string and an arbitrary value are both tolerated rather than dropped,
/// since an unrenderable result is still evidence of what the agent did.
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

/// The model named by a record, wherever that version puts it.
fn model_of(v: &Value) -> Option<String> {
    v.get("modelId")
        .and_then(|m| m.as_str())
        .or_else(|| v.get("message")?.get("model")?.as_str())
        .map(str::to_string)
}

/// The provider named by a record, wherever that version puts it.
fn provider_of(v: &Value) -> Option<String> {
    v.get("provider")
        .and_then(|p| p.as_str())
        .or_else(|| v.get("message")?.get("provider")?.as_str())
        .map(str::to_string)
}
