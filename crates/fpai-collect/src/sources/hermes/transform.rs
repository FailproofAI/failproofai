//! Hermes `messages` rows → AgentEye events.
//!
//! Every function here is pure in its arguments. The contract on
//! [`crate::sqlitepoll::SqliteFormat::poll`] is that re-reading the same rows
//! produces identical bytes, because the server dedups on a content hash —
//! anything that consulted the clock, a counter, or which poll pass we happen
//! to be on would turn one turn into a fresh row on every pass.
//!
//! Row shapes verified against a real `~/.hermes/state.db` (schema_version 22,
//! captured from a containerised probe):
//!
//! ```text
//! user       role='user',      content=<prompt>,   finish_reason=NULL
//! assistant  role='assistant', content=<text>,     finish_reason='stop'
//!         OR role='assistant', content='',         finish_reason='tool_calls',
//!            tool_calls='[{id, call_id, response_item_id, type:"function",
//!                          function:{name, arguments:"<JSON *STRING*>"}}, …]'
//! tool       role='tool',      content='<JSON string>', tool_call_id, tool_name
//! ```
//!
//! Three details of that shape are load-bearing and each has its own trap:
//!
//! * `tool_calls` is an ARRAY that really does carry several entries — the
//!   probe capture has one assistant row issuing two parallel `session_search`
//!   calls, so a transform reading `[0]` would silently drop half the tool
//!   traffic on any parallel turn.
//! * `function.arguments` is a JSON-encoded **string**, not an object. Passed
//!   through unparsed it reaches the product as one escaped blob per call
//!   instead of queryable fields.
//! * an assistant row that is calling tools has `content=''` — an empty string,
//!   not NULL. A `content IS NOT NULL` test emits a blank `model_response` for
//!   every tool turn.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::sqlitepoll::epoch_to_millis;

/// Longest derived id component. Matches the other sources so one project's
/// agent id is the same string whichever agent produced the session.
const MAX_ID_PART: usize = 48;

/// Longest goal string lifted from a session's opening prompt.
const MAX_GOAL_CHARS: usize = 1024;

/// Sub-second offset given to `agent_end`, so it sorts after every content
/// event that shares its millisecond. The server's tie-break is a random id,
/// so without this a session can appear to end before its own last turn.
const END_INDEX: u32 = 999;

/// One `messages` row, as far as this source cares.
///
/// The reasoning columns (`reasoning`, `reasoning_content`, `reasoning_details`,
/// `codex_reasoning_items`, `codex_message_items`) and `api_content` are
/// deliberately absent: they are provider-shaped scratch space Hermes rewrites
/// in place, and shipping them would multiply the payload for content already
/// present in `content`/`tool_calls`.
#[derive(Debug, Clone, Default)]
pub struct MessageRow {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_calls: Option<String>,
    pub tool_name: Option<String>,
    /// REAL epoch **seconds** with sub-second precision, e.g. `1785744251.65`.
    pub timestamp: f64,
    pub finish_reason: Option<String>,
    /// 0 once a rewind or a compaction has taken the row out of the model's
    /// context. The row itself survives, which is why we still ship it.
    pub active: i64,
}

/// The `sessions` row a message belongs to.
///
/// `user_id`, `chat_id` and `session_key` are deliberately not carried: on a
/// gateway session they are the Slack/Telegram account and channel identifiers,
/// i.e. personal data with no analytic use here. `system_prompt` is skipped too
/// — it is kilobytes, identical across every session of an install, and can
/// carry operator secrets pasted into `SOUL.md`.
#[derive(Debug, Clone, Default)]
pub struct SessionMeta {
    pub source: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub git_repo_root: Option<String>,
    pub chat_type: Option<String>,
    pub title: Option<String>,
    pub started_at: Option<f64>,
    pub ended_at: Option<f64>,
    pub end_reason: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    /// Lowest and highest surviving `messages.id` for this session. What makes
    /// `agent_start` / `agent_end` fire exactly once without the poller having
    /// to remember anything between passes — see [`agent_start`].
    pub first_message_id: Option<i64>,
    pub last_message_id: Option<i64>,
}

/// Format epoch milliseconds as the RFC3339-with-microseconds string ingest
/// requires, offsetting by `index` microseconds.
///
/// Microseconds are forced rather than left to RFC3339's variable precision so
/// every source emits one shape and the hook stream and the session stream sort
/// against each other on a shared timeline.
///
/// The offset is what keeps several events derived from ONE row in order: the
/// server sorts by `(ts, random id)`, so an assistant row's two parallel tool
/// calls would otherwise come back shuffled. It is capped at 999 µs so it can
/// never carry into the next millisecond and reorder an event past a genuinely
/// later row.
pub fn to_rfc3339_micros(epoch_ms: i64, index: u32) -> Option<String> {
    let nanos = (epoch_ms as i128) * 1_000_000 + (index.min(999) as i128) * 1_000;
    let dt = time::OffsetDateTime::from_unix_timestamp_nanos(nanos).ok()?;
    const FMT: &[time::format_description::BorrowedFormatItem<'_>] = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:6]Z"
    );
    dt.format(FMT).ok()
}

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

/// Last path component of a working directory, sanitized.
fn project_name(cwd: &str) -> Option<String> {
    let last = cwd
        .trim_end_matches('/')
        .rsplit('/')
        .find(|p| !p.is_empty())?;
    let cleaned = sanitize_id_part(last);
    (!cleaned.is_empty()).then_some(cleaned)
}

/// The agent id a session's events are filed under.
///
/// Hermes has BOTH shapes and each needs its own answer:
///
/// * A **CLI** session has a real `cwd` (5/5 in the probe capture, alongside
///   `git_branch` and `git_repo_root`), so it groups by project exactly like
///   Claude and the hook source do — which is the whole point: hook events and
///   session events for one run must land under a single agent rather than two
///   that look unrelated.
/// * A **gateway** session (Slack, Telegram, cron) genuinely has NULL `cwd`.
///   There is no project to group by, so it falls back to the transport in
///   `source`. Grouping every gateway session under one bare `hermes` would
///   merge Slack and Telegram traffic into an agent nobody can act on.
///
/// `fallback` — the collector's configured default — is used only when the
/// session row itself is missing, which means a message referencing a deleted
/// session.
pub fn agent_id(meta: Option<&SessionMeta>, fallback: &str) -> String {
    let Some(meta) = meta else {
        return fallback.to_string();
    };
    if let Some(project) = meta.cwd.as_deref().and_then(project_name) {
        return format!("hermes-{project}");
    }
    if let Some(source) = meta
        .source
        .as_deref()
        .map(sanitize_id_part)
        .filter(|s| !s.is_empty())
    {
        return format!("hermes-{source}");
    }
    fallback.to_string()
}

/// The row's timestamp as epoch milliseconds, or `None` when it is implausible.
///
/// [`epoch_to_millis`] reports anything below ~2001 as 0, which would render as
/// 1970-01-01 and park the event at the head of every timeline it lands on.
/// That is worse than not shipping it: one corrupt row would silently reorder
/// a whole session. The watermark advances past such a row regardless, so it is
/// dropped once rather than retried forever.
fn row_millis(row: &MessageRow) -> Option<i64> {
    let ms = epoch_to_millis(row.timestamp);
    (ms > 0).then_some(ms)
}

/// The envelope every emitted event carries.
///
/// `hermes_row_id` is the dedup discriminator. Two identical turns — the same
/// prompt asked twice in one session — must hash differently or the server
/// collapses them into one row; `messages.id` is an `INTEGER PRIMARY KEY
/// AUTOINCREMENT`, so it is unique and never reused even after a rewind
/// deletes the rows around it.
fn base(
    kind: &str,
    epoch_ms: i64,
    index: u32,
    row: &MessageRow,
    agent_id: &str,
    environment: &str,
) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert(
        "timestamp".into(),
        json!(to_rfc3339_micros(epoch_ms, index)?),
    );
    m.insert("session_id".into(), json!(row.session_id));
    m.insert("agent_id".into(), json!(agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(environment));
    m.insert("hermes_row_id".into(), json!(row.id));
    if index > 0 {
        m.insert("hermes_block_index".into(), json!(index));
    }
    // Only ever present on a row a rewind or compaction has taken out of the
    // model's context. Emitted as the exception rather than on every row so the
    // common case costs no bytes, and so the product can explain why a message
    // the user can see was not in the prompt that followed it.
    if row.active == 0 {
        m.insert("hermes_active".into(), json!(false));
    }
    Some(m)
}

/// Attach the session-level context every event of a session should carry.
fn with_session_context(m: &mut Map<String, Value>, meta: Option<&SessionMeta>) {
    let Some(meta) = meta else { return };
    if let Some(s) = meta.source.as_deref().filter(|s| !s.is_empty()) {
        m.insert("hermes_source".into(), json!(s));
    }
    if let Some(c) = meta.cwd.as_deref().filter(|s| !s.is_empty()) {
        m.insert("hermes_cwd".into(), json!(c));
    }
}

/// The session's `agent_start`, emitted from its FIRST surviving message row.
///
/// Firing it off `first_message_id` rather than "the first time we see this
/// session" is what makes it survive the poller having no memory between
/// passes: the answer is a pure function of what is in the database, so a
/// re-read produces the identical event and the server dedups it, whereas an
/// "emit on first sight" rule would ship a new start every time the daemon
/// restarted.
///
/// The timestamp comes from the session's own `started_at`, not the message's:
/// Hermes stamps `started_at` when the session opens, which on the capture is
/// 12–34 ms before the user's first prompt lands. Using the message time would
/// report every session as starting late and hide the gateway's own latency.
pub fn agent_start(
    row: &MessageRow,
    meta: &SessionMeta,
    agent_id: &str,
    environment: &str,
) -> Option<Value> {
    let ms = meta
        .started_at
        .map(epoch_to_millis)
        .filter(|ms| *ms > 0)
        .or_else(|| row_millis(row))?;
    let mut m = base("agent_start", ms, 0, row, agent_id, environment)?;

    // The session's goal is its opening human prompt. Only read off the first
    // row so this stays a pure function of the rows in hand — searching forward
    // for a user row would give a different answer depending on where the batch
    // happened to be cut.
    if row.role == "user"
        && let Some(text) = row.content.as_deref().filter(|t| !t.is_empty())
    {
        m.insert(
            "goal".into(),
            json!(text.chars().take(MAX_GOAL_CHARS).collect::<String>()),
        );
    }
    if let Some(model) = meta.model.as_deref().filter(|s| !s.is_empty()) {
        m.insert("model".into(), json!(model));
    }
    if let Some(b) = meta.git_branch.as_deref().filter(|s| !s.is_empty()) {
        m.insert("hermes_git_branch".into(), json!(b));
    }
    if let Some(r) = meta.git_repo_root.as_deref().filter(|s| !s.is_empty()) {
        m.insert("hermes_git_repo_root".into(), json!(r));
    }
    if let Some(t) = meta.chat_type.as_deref().filter(|s| !s.is_empty()) {
        m.insert("hermes_chat_type".into(), json!(t));
    }
    if let Some(t) = meta.title.as_deref().filter(|s| !s.is_empty()) {
        m.insert("hermes_title".into(), json!(t));
    }
    with_session_context(&mut m, Some(meta));
    Some(Value::Object(m))
}

/// The session's `agent_end`, emitted from its LAST surviving message row.
///
/// Gated on `ended_at` being set, so a session still in flight does not get an
/// end event on every poll that touches its newest row. The cost is a narrow
/// race: Hermes writes the final assistant message and only then `UPDATE`s
/// `sessions.ended_at` — 11 ms later on the capture. A poll landing inside that
/// window consumes the last row while the session still looks open, and no
/// later row will ever arrive to re-trigger it, so that session ends up with no
/// `agent_end`. Accepted over the alternative, which is ending every live
/// session on every pass.
pub fn agent_end(
    row: &MessageRow,
    meta: &SessionMeta,
    agent_id: &str,
    environment: &str,
) -> Option<Value> {
    let ms = meta
        .ended_at
        .map(epoch_to_millis)
        .filter(|ms| *ms > 0)
        .or_else(|| row_millis(row))?;
    let mut m = base("agent_end", ms, END_INDEX, row, agent_id, environment)?;
    if let Some(reason) = meta.end_reason.as_deref().filter(|s| !s.is_empty()) {
        m.insert("hermes_end_reason".into(), json!(reason));
    }
    if let Some(n) = meta.input_tokens.filter(|n| *n > 0) {
        m.insert("input_tokens".into(), json!(n));
    }
    if let Some(n) = meta.output_tokens.filter(|n| *n > 0) {
        m.insert("output_tokens".into(), json!(n));
    }
    with_session_context(&mut m, Some(meta));
    Some(Value::Object(m))
}

/// One `messages` row to the events it yields.
///
/// `pending` carries tool-call ids to names within a poll so a result is not a
/// blank row; see [`tool_events`] for why it is not the only source of the name.
pub fn message_events(
    row: &MessageRow,
    meta: Option<&SessionMeta>,
    agent_id: &str,
    environment: &str,
    pending: &mut HashMap<String, String>,
) -> Vec<Value> {
    let Some(ms) = row_millis(row) else {
        return Vec::new();
    };
    match row.role.as_str() {
        "user" => user_events(row, meta, agent_id, environment, ms),
        "assistant" => assistant_events(row, meta, agent_id, environment, ms, pending),
        "tool" => tool_events(row, meta, agent_id, environment, ms, pending),
        // Hermes only writes user/assistant/tool today. An unknown role is
        // skipped rather than guessed at: a wrong event type is harder to
        // notice than a missing one, and a new role would need its own mapping
        // anyway.
        _ => Vec::new(),
    }
}

/// A `user` row is a prompt.
fn user_events(
    row: &MessageRow,
    meta: Option<&SessionMeta>,
    agent_id: &str,
    environment: &str,
    ms: i64,
) -> Vec<Value> {
    let Some(text) = row.content.as_deref().filter(|t| !t.is_empty()) else {
        return Vec::new();
    };
    let Some(mut m) = base("model_request", ms, 0, row, agent_id, environment) else {
        return Vec::new();
    };
    // The model is on the SESSION, never on the message. The server builds this
    // row's summary from the model alone, so without lifting it here every
    // prompt renders as an empty row.
    if let Some(model) = meta
        .and_then(|s| s.model.as_deref())
        .filter(|s| !s.is_empty())
    {
        m.insert("model".into(), json!(model));
    }
    m.insert(
        "messages".into(),
        json!([{ "role": "user", "content": text }]),
    );
    with_session_context(&mut m, meta);
    vec![Value::Object(m)]
}

/// An `assistant` row is text, or tool calls, or (defensively) both.
///
/// The probe capture never has both — `finish_reason` is either `stop` with
/// text or `tool_calls` with an empty `content` — but handling the pair costs
/// nothing and a provider that starts emitting a preamble alongside its calls
/// would otherwise lose the preamble silently.
fn assistant_events(
    row: &MessageRow,
    meta: Option<&SessionMeta>,
    agent_id: &str,
    environment: &str,
    ms: i64,
    pending: &mut HashMap<String, String>,
) -> Vec<Value> {
    let model = meta
        .and_then(|s| s.model.as_deref())
        .filter(|s| !s.is_empty());
    let mut out = Vec::new();

    if let Some(text) = row.content.as_deref().filter(|t| !t.is_empty())
        && let Some(mut m) = base("model_response", ms, 0, row, agent_id, environment)
    {
        m.insert("role".into(), json!("assistant"));
        m.insert("content".into(), json!(text));
        if let Some(model) = model {
            m.insert("model".into(), json!(model));
        }
        if let Some(fr) = row.finish_reason.as_deref().filter(|s| !s.is_empty()) {
            m.insert("hermes_finish_reason".into(), json!(fr));
        }
        with_session_context(&mut m, meta);
        out.push(Value::Object(m));
    }

    for (i, call) in parse_tool_calls(row.tool_calls.as_deref())
        .iter()
        .enumerate()
    {
        // Index 0 belongs to the text event whether or not it exists, so a call's
        // sub-second offset does not shift depending on whether the model also
        // spoke — the same row must always produce the same bytes.
        let index = (i + 1) as u32;
        let Some(mut m) = base("tool_use", ms, index, row, agent_id, environment) else {
            continue;
        };
        let function = call.get("function");
        let name = function
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("tool");
        // `id` and `call_id` are the same value on every row of the capture;
        // `id` wins and `call_id` is the fallback in case a provider adapter
        // fills only one. Failing both, an id derived from (row, index) keeps
        // two parallel identical calls from hash-collapsing into one row.
        let id = call
            .get("id")
            .and_then(|x| x.as_str())
            .or_else(|| call.get("call_id").and_then(|x| x.as_str()))
            .map(str::to_string)
            .unwrap_or_else(|| format!("hermes-{}-{i}", row.id));
        pending.insert(id.clone(), name.to_string());
        m.insert("tool_name".into(), json!(name));
        m.insert("tool_call_id".into(), json!(id));
        m.insert("input".into(), call_input(function));
        if let Some(model) = model {
            m.insert("model".into(), json!(model));
        }
        with_session_context(&mut m, meta);
        out.push(Value::Object(m));
    }

    out
}

/// A `tool` row is one call's result.
fn tool_events(
    row: &MessageRow,
    meta: Option<&SessionMeta>,
    agent_id: &str,
    environment: &str,
    ms: i64,
    pending: &mut HashMap<String, String>,
) -> Vec<Value> {
    let Some(mut m) = base("tool_result", ms, 0, row, agent_id, environment) else {
        return Vec::new();
    };
    if let Some(id) = row.tool_call_id.as_deref().filter(|s| !s.is_empty()) {
        m.insert("tool_call_id".into(), json!(id));
        // The call's name wins because it is what the model actually invoked;
        // Hermes also stores `tool_name` on the result row, which is the only
        // thing that saves the pairing when the batch was cut between the call
        // and its result — then `pending` is empty and the result would
        // otherwise be a blank row in the product.
        if let Some(name) = pending
            .get(id)
            .map(String::as_str)
            .or(row.tool_name.as_deref())
            .filter(|s| !s.is_empty())
        {
            m.insert("tool_name".into(), json!(name));
        }
    } else if let Some(name) = row.tool_name.as_deref().filter(|s| !s.is_empty()) {
        m.insert("tool_name".into(), json!(name));
    }

    if let Some(output) = row.content.as_deref() {
        m.insert("output".into(), json!(output));
        if let Some(err) = tool_error(output) {
            m.insert("error".into(), json!(err));
            m.insert("error_type".into(), json!("hermes_tool_error"));
        }
    }
    with_session_context(&mut m, meta);
    vec![Value::Object(m)]
}

/// Parse the `tool_calls` column into its entries.
///
/// Returns empty for NULL, for the empty string, and for anything that is not
/// a JSON array — a malformed column must cost this row's tool calls, not the
/// whole poll.
fn parse_tool_calls(raw: Option<&str>) -> Vec<Value> {
    let Some(raw) = raw.filter(|s| !s.trim().is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

/// A call's `input`, unwrapping the JSON-encoded `arguments` string.
///
/// Hermes stores OpenAI's wire shape verbatim, where `arguments` is a STRING
/// containing JSON: `{"function":{"arguments":"{\"command\": \"ls /work\"}"}}`.
/// Shipping that string straight through gives the product one escaped blob per
/// tool call instead of the fields a policy or a query can reach.
///
/// A string that does not parse is kept verbatim under `arguments` rather than
/// dropped: a truncated argument list is still the best evidence available of
/// what the agent tried to run.
fn call_input(function: Option<&Value>) -> Value {
    match function.and_then(|f| f.get("arguments")) {
        Some(Value::String(s)) => {
            serde_json::from_str::<Value>(s).unwrap_or_else(|_| json!({ "arguments": s }))
        }
        Some(other) => other.clone(),
        None => json!({}),
    }
}

/// The error a tool result reports, if it reports one.
///
/// Hermes tool results are JSON strings whose shape is the tool's own. Two
/// signals are unambiguous across the capture: a non-null `error`
/// (`{"error": "around_message_id 1 not in session_id …", "success": false}`)
/// and an explicit `success: false`.
///
/// A non-zero `exit_code` is deliberately NOT treated as an error even though
/// `terminal` reports one: `grep` finding nothing exits 1, and flagging that as
/// a failed tool call would fill the product with false alarms that are
/// indistinguishable from real ones.
fn tool_error(content: &str) -> Option<String> {
    let obj = serde_json::from_str::<Value>(content).ok()?;
    let obj = obj.as_object()?;
    if let Some(err) = obj.get("error") {
        match err {
            Value::Null => {}
            Value::String(s) if s.is_empty() => {}
            Value::String(s) => return Some(s.clone()),
            other => return Some(other.to_string()),
        }
    }
    if obj.get("success").and_then(Value::as_bool) == Some(false) {
        return Some(content.to_string());
    }
    None
}
