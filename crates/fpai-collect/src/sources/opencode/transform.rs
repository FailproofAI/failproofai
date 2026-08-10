//! opencode `session` and `part` rows → AgentEye events.
//!
//! Every function here is pure in its arguments. That is load-bearing rather
//! than stylistic: this source re-reads mutated rows *by design* (see the
//! module docs on [`super`]), and the server collapses a re-read only when the
//! bytes are identical. Nothing here may consult the clock, a counter, or
//! anything outside its arguments.
//!
//! Row shapes verified against a live `~/.local/share/opencode/opencode.db`
//! (opencode 1.18.11):
//!
//! ```text
//! session  columns  id, directory (absolute cwd), path (NOT usable — see
//!                   `super`), slug, version, parent_id, time_created,
//!                   time_updated, tokens_input/output/reasoning/cache_*
//! message  data     {role:"user", model:{providerID, modelID}, time:{created}}
//!                   {role:"assistant", modelID, providerID, tokens:{…},
//!                    time:{created, completed}, finish:"stop"|"tool-calls"|…}
//! part     data     {type:"text", text, time?:{start, end}}
//!                   {type:"tool", tool, callID,
//!                    state:{status, input, output, metadata, time:{start,end}}}
//!                   {type:"step-start"|"step-finish", …}      (emit nothing)
//! ```

use serde_json::{Map, Value, json};

/// Longest derived id component.
const MAX_ID_PART: usize = 48;
/// Longest goal string carried on `agent_start`.
const MAX_GOAL: usize = 1024;
/// Index offset for `agent_end`.
///
/// The server sorts by `(timestamp, random id)`, so an `agent_end` sharing a
/// millisecond with the turn that produced it can come back *before* it. 999
/// puts it after every content event in that millisecond — the same trick and
/// the same constant the Claude source uses.
const END_INDEX: u32 = 999;

/// Make a derived id component safe and bounded.
///
/// Byte-for-byte the Claude source's rule, deliberately: the two run on the
/// same machine over the same project directories, and a project that
/// sanitized differently under each would show up as two unrelated agents.
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

/// `opencode-<project>`, from `session.directory`.
///
/// `directory` is the absolute working directory and is the ONLY reliable
/// source of the project — see the module docs on [`super`] for why
/// `session.path` and `session.project_id` are not.
///
/// Returns `None` for a directory with no usable final component (`/`, or an
/// empty string), so the caller can fall back to the configured agent id
/// rather than emitting `opencode-`.
pub fn agent_id_from_directory(directory: &str) -> Option<String> {
    let project = sanitize_id_part(
        directory
            .trim_end_matches('/')
            .rsplit('/')
            .find(|p| !p.is_empty())?,
    );
    (!project.is_empty()).then(|| format!("opencode-{project}"))
}

/// Format epoch milliseconds as the RFC3339-with-microseconds string ingest
/// expects, offset by `index` microseconds.
///
/// opencode stores `time_created`/`time_updated` and every JSON `time` field
/// as epoch MILLISECONDS (verified: 1785744553213). Microseconds are forced
/// rather than left to RFC3339's variable precision so every source emits one
/// shape and the streams sort against each other on a shared timeline.
pub fn to_rfc3339_micros(epoch_ms: i64, index: u32) -> Option<String> {
    let nanos = (epoch_ms as i128) * 1_000_000 + (index as i128) * 1_000;
    let dt = time::OffsetDateTime::from_unix_timestamp_nanos(nanos).ok()?;
    const FMT: &[time::format_description::BorrowedFormatItem<'_>] = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:6]Z"
    );
    dt.format(FMT).ok()
}

/// What every emitted event is filed under.
#[derive(Debug, Clone)]
pub struct Ctx {
    pub session_id: String,
    pub agent_id: String,
    pub environment: String,
}

impl Ctx {
    fn new(session_id: &str, directory: &str, environment: &str, fallback_agent_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            agent_id: agent_id_from_directory(directory)
                .unwrap_or_else(|| fallback_agent_id.to_string()),
            environment: environment.to_string(),
        }
    }
}

/// One `session` row, plus the two facts about it that need a subquery.
#[derive(Debug, Clone, Default)]
pub struct SessionRow {
    pub id: String,
    /// Absolute cwd. The agent id derives from this and nothing else.
    pub directory: String,
    pub version: Option<String>,
    pub slug: Option<String>,
    pub parent_id: Option<String>,
    pub time_created: i64,
    pub time_updated: i64,
    pub tokens_input: i64,
    pub tokens_output: i64,
    pub tokens_reasoning: i64,
    pub tokens_cache_read: i64,
    pub tokens_cache_write: i64,
    /// `part.data` of the session's earliest part. Its presence is the "this
    /// session produced something" test, and its text is the session goal.
    pub first_part: Option<Value>,
    /// `message.data` of the session's latest message. Decides whether the
    /// session is between turns or in the middle of one.
    pub last_message: Option<Value>,
}

/// One `part` row, joined to its message (for the role and model) and its
/// session (for the directory the agent id comes from).
#[derive(Debug, Clone, Default)]
pub struct PartRow {
    pub id: String,
    pub session_id: String,
    pub message_id: String,
    pub directory: String,
    pub time_created: i64,
    pub time_updated: i64,
    pub data: Value,
    pub message: Value,
}

/// The envelope every emitted event carries.
///
/// `opencode_part_id` is the dedup discriminator: two events that are
/// otherwise identical — the same tool invoked twice with the same input, say
/// — must hash differently or the server collapses them into one. opencode
/// prefixes ids per table (`prt_…`, `ses_…`), so this one field can carry the
/// originating row of a part-derived event and a session-derived event alike
/// with no chance of collision.
fn base(ctx: &Ctx, kind: &str, ts_ms: i64, index: u32, row_id: &str) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert("timestamp".into(), json!(to_rfc3339_micros(ts_ms, index)?));
    m.insert("session_id".into(), json!(ctx.session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("opencode_part_id".into(), json!(row_id));
    if index > 0 {
        m.insert("opencode_block_index".into(), json!(index));
    }
    Some(m)
}

/// A `session` row's `agent_start` and — when the session is between turns —
/// its `agent_end`.
///
/// # Why a session row can produce these many times over
///
/// The poller re-reads a row whenever its `time_updated` moves, and a session
/// row's moves on every turn. `agent_start` is therefore built ONLY from
/// columns opencode never rewrites (`id`, `directory`, `version`, `slug`,
/// `parent_id`, `time_created`) plus the first prompt, which is fixed once
/// written — so every re-read produces the same bytes and the server collapses
/// them into the single event it should have been. `session.title` is
/// pointedly absent: opencode backfills it with an LLM-generated summary a few
/// seconds into the session, which would make the second read differ from the
/// first and leave two `agent_start`s on the timeline.
///
/// # `agent_end` without an end marker
///
/// opencode never records that a session finished — there is no end row, no
/// terminal status, and `time_archived` stays null. An idle timeout is not
/// available either: the poll must be a pure function of the database and the
/// request, so it cannot ask what time it is now.
///
/// So the end is inferred from the conversation instead: a session whose
/// latest message is an assistant turn that has *finished* and is not waiting
/// on tool calls is, right now, over. Every later turn moves the session row
/// again and emits another `agent_end` at the new `time_updated`; the newest
/// one is always the session's true last activity.
pub fn session_events(row: &SessionRow, environment: &str, fallback_agent_id: &str) -> Vec<Value> {
    // A session row with no parts is one the user opened and never used —
    // opencode creates it the moment a session is selected. Emitting an
    // `agent_start` for it would put an empty session in the product, and
    // would also risk a second `agent_start` later once the goal exists.
    if row.first_part.is_none() {
        return Vec::new();
    }
    let ctx = Ctx::new(&row.id, &row.directory, environment, fallback_agent_id);
    let mut out = Vec::new();

    if let Some(mut m) = base(&ctx, "agent_start", row.time_created, 0, &row.id) {
        if let Some(goal) = first_prompt(row) {
            m.insert("goal".into(), json!(goal));
        }
        m.insert("opencode_cwd".into(), json!(row.directory));
        if let Some(v) = &row.version {
            m.insert("opencode_version".into(), json!(v));
        }
        if let Some(s) = &row.slug {
            m.insert("opencode_slug".into(), json!(s));
        }
        if let Some(p) = &row.parent_id {
            m.insert("opencode_parent_session_id".into(), json!(p));
        }
        out.push(Value::Object(m));
    }

    if between_turns(row)
        && let Some(mut m) = base(&ctx, "agent_end", row.time_updated, END_INDEX, &row.id)
    {
        // Namespaced, and deliberately NOT `input_tokens`/`output_tokens`:
        // these are the session's running TOTALS, not this event's usage, and
        // a consumer that sums the generic fields across events would count
        // every turn again for every `agent_end` the session emits.
        m.insert(
            "opencode_tokens".into(),
            json!({
                "input": row.tokens_input,
                "output": row.tokens_output,
                "reasoning": row.tokens_reasoning,
                "cache_read": row.tokens_cache_read,
                "cache_write": row.tokens_cache_write,
            }),
        );
        out.push(Value::Object(m));
    }
    out
}

/// The session goal: the text of its first part, which is the user's opening
/// prompt (opencode writes the prompt's text part before anything else).
fn first_prompt(row: &SessionRow) -> Option<String> {
    let data = row.first_part.as_ref()?;
    if data.get("type").and_then(|t| t.as_str()) != Some("text") {
        return None;
    }
    let text = data.get("text").and_then(|t| t.as_str())?;
    (!text.is_empty()).then(|| text.chars().take(MAX_GOAL).collect())
}

/// True when the session's latest message is a completed assistant turn.
///
/// `finish:"tool-calls"` means the assistant stopped only to run tools and
/// another assistant message is coming, so it is explicitly NOT an end. A user
/// message as the latest one means the turn has not finished either.
fn between_turns(row: &SessionRow) -> bool {
    let Some(message) = row.last_message.as_ref() else {
        return false;
    };
    if message.get("role").and_then(|r| r.as_str()) != Some("assistant") {
        return false;
    }
    matches!(
        message.get("finish").and_then(|f| f.as_str()),
        Some(finish) if finish != "tool-calls"
    )
}

/// One `part` row to the events it yields.
///
/// Returns an empty vector for a part opencode is still writing — see
/// `is_settled` and `tool_events` below. That is not a dropped event: the row's
/// `time_updated` moves again when the write completes, which brings it back
/// past the watermark and through here a second time.
pub fn part_events(row: &PartRow, environment: &str, fallback_agent_id: &str) -> Vec<Value> {
    let ctx = Ctx::new(
        &row.session_id,
        &row.directory,
        environment,
        fallback_agent_id,
    );
    match row.data.get("type").and_then(|t| t.as_str()) {
        Some("text") => text_events(row, &ctx),
        Some("tool") => tool_events(row, &ctx),
        // `step-start` / `step-finish` are turn structure, and `snapshot` /
        // `patch` / `file` / `reasoning` need their own event types rather
        // than a lossy squeeze into these. Ignoring an unknown type is also
        // what keeps a new opencode release from breaking this source.
        _ => Vec::new(),
    }
}

/// A `text` part is a user prompt or an assistant answer, decided by the role
/// on its message — the part itself carries no role.
fn text_events(row: &PartRow, ctx: &Ctx) -> Vec<Value> {
    // An assistant text part is written empty and grown token by token as the
    // model streams. Shipping it before it settles would put one row in the
    // product per poll that happened to land mid-stream, each a longer prefix
    // of the same answer.
    if !is_settled(&row.data) {
        return Vec::new();
    }
    let Some(text) = row.data.get("text").and_then(|t| t.as_str()) else {
        return Vec::new();
    };
    if text.is_empty() {
        return Vec::new();
    }
    let role = row
        .message
        .get("role")
        .and_then(|r| r.as_str())
        .unwrap_or("assistant");

    let kind = if role == "user" {
        "model_request"
    } else {
        "model_response"
    };
    // `part.time_created` rather than `data.time.start`: it is the one
    // timestamp on the row opencode never rewrites, so a re-read of a row that
    // changed for some other reason still produces the same bytes.
    let Some(mut m) = base(ctx, kind, row.time_created, 0, &row.id) else {
        return Vec::new();
    };
    if let Some(model) = model_id(&row.message) {
        m.insert("model".into(), json!(model));
    }
    if role == "user" {
        m.insert(
            "messages".into(),
            json!([{ "role": "user", "content": text }]),
        );
        m.insert("opencode_cwd".into(), json!(row.directory));
    } else {
        m.insert("role".into(), json!("assistant"));
        m.insert("content".into(), json!(text));
        if let Some(p) = provider_id(&row.message) {
            m.insert("opencode_provider".into(), json!(p));
        }
    }
    m.insert("opencode_message_id".into(), json!(row.message_id));
    vec![Value::Object(m)]
}

/// A `tool` part is BOTH the call and its result — opencode never writes a
/// second row for the result, it fills this one in.
///
/// So a completed part yields two events. They are offset by index so they
/// sort in order even when a tool finishes inside the millisecond it started:
/// the server's tie-break is a random id, and a result that sorted before its
/// own call is visibly wrong on a timeline.
///
/// A part that is still running yields the call alone. The result is not
/// merely absent from our output, it does not exist yet — `state.output` is
/// empty and `state.time.end` is unset until opencode writes them, ~12 seconds
/// later on the observed capture.
fn tool_events(row: &PartRow, ctx: &Ctx) -> Vec<Value> {
    let state = row.data.get("state");
    let status = state
        .and_then(|s| s.get("status"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    // `pending` is the call before its arguments have finished streaming:
    // there is no input to report yet. Every other status — including one this
    // code has never heard of — reports the call, so a new opencode state name
    // degrades to an extra event rather than a silently missing one.
    if status == "pending" {
        return Vec::new();
    }

    let name = row
        .data
        .get("tool")
        .and_then(|t| t.as_str())
        .unwrap_or("tool");
    // Falls back to the part id so two identical parallel calls cannot
    // hash-collapse into one row.
    let call_id = row
        .data
        .get("callID")
        .and_then(|c| c.as_str())
        .unwrap_or(&row.id);

    let mut out = Vec::new();
    if let Some(mut m) = base(ctx, "tool_use", row.time_created, 0, &row.id) {
        m.insert("tool_name".into(), json!(name));
        m.insert("tool_call_id".into(), json!(call_id));
        if let Some(input) = state.and_then(|s| s.get("input")) {
            m.insert("input".into(), input.clone());
        }
        if let Some(model) = model_id(&row.message) {
            m.insert("model".into(), json!(model));
        }
        // Deliberately carries no status: a running part and the completed
        // part it becomes then produce a byte-identical `tool_use`, which the
        // server collapses. Putting the status here would leave one visible
        // row per state the call passed through.
        out.push(Value::Object(m));
    }

    if !matches!(status, "completed" | "error") {
        return out;
    }
    let end = state
        .and_then(|s| s.get("time"))
        .and_then(|t| t.get("end"))
        .and_then(serde_json::Value::as_i64)
        // Only reachable on a shape without timing; the row's own last-write
        // time is the closest true statement about when the result existed.
        .unwrap_or(row.time_updated);
    if let Some(mut m) = base(ctx, "tool_result", end, 1, &row.id) {
        m.insert("tool_name".into(), json!(name));
        m.insert("tool_call_id".into(), json!(call_id));
        m.insert("opencode_tool_status".into(), json!(status));
        let output = state.and_then(|s| s.get("output")).map(stringify);
        let error = state.and_then(|s| s.get("error")).map(stringify);
        if let Some(o) = output.clone().filter(|o| !o.is_empty()) {
            m.insert("output".into(), json!(o));
        } else if let Some(e) = error.clone().filter(|e| !e.is_empty()) {
            // An errored tool has no output; the message is the whole result.
            m.insert("output".into(), json!(e));
        }
        if status == "error" {
            let detail = error.or(output).unwrap_or_default();
            m.insert("error".into(), json!(detail));
            m.insert("error_type".into(), json!("opencode_tool_error"));
        }
        out.push(Value::Object(m));
    }
    out
}

/// True when opencode has finished writing this part's content.
///
/// A part that carries a `time` object is settled once that object has an
/// `end`; one with no `time` at all (a user prompt) was written in a single
/// shot and is settled on arrival.
fn is_settled(data: &Value) -> bool {
    match data.get("time") {
        Some(t) => t.get("end").is_some_and(|e| !e.is_null()),
        None => true,
    }
}

/// The model id, from either message shape: an assistant message carries a
/// flat `modelID`, a user message a nested `model:{providerID, modelID}`.
fn model_id(message: &Value) -> Option<&str> {
    message.get("modelID").and_then(|m| m.as_str()).or_else(|| {
        message
            .get("model")
            .and_then(|m| m.get("modelID"))
            .and_then(|m| m.as_str())
    })
}

fn provider_id(message: &Value) -> Option<&str> {
    message
        .get("providerID")
        .and_then(|p| p.as_str())
        .or_else(|| {
            message
                .get("model")
                .and_then(|m| m.get("providerID"))
                .and_then(|p| p.as_str())
        })
}

/// Render a tool payload as text. opencode writes a plain string; anything
/// else is rendered rather than dropped.
fn stringify(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
