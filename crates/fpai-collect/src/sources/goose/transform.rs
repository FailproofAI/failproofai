//! goose `messages` row → AgentEye events.
//!
//! Every function here is pure in its arguments. Nothing consults the clock, a
//! counter, or anything outside what it is handed, which is what makes two
//! reads of the same rows byte-identical and therefore collapsible by the
//! server's content-hash dedup.
//!
//! Block shapes are verbatim from a live `sessions.db` (goose v1.43.0); see the
//! module docs of the parent for the full records.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::sources::claude::transform::sanitize_id_part;
use crate::sqlitepoll::epoch_to_millis;

/// Longest session goal carried on `agent_start`.
const MAX_GOAL_CHARS: usize = 1024;

/// Sub-second slots reserved inside one row. See [`slot_micros`].
const SLOT_START: u32 = 0;
const SLOT_FIRST_BLOCK: u32 = 1;
const SLOT_LAST_BLOCK: u32 = 8;
const SLOT_END: u32 = 9;
const SLOTS_PER_ROW: i64 = 10;
/// Rows per second-worth of microseconds. `1_000_000 / SLOTS_PER_ROW`.
const ROW_SLOT_WRAP: i64 = 100_000;

/// One `messages` row with its `content_json` already parsed.
#[derive(Debug, Clone, Default)]
pub struct MessageRow {
    pub id: i64,
    pub session_id: String,
    /// `user` or `assistant`. NOT sufficient to tell a prompt from a tool
    /// result — goose files `toolResponse` blocks under `role:'user'`.
    pub role: String,
    /// Epoch SECONDS, verified live (`created_timestamp` 1785743817 for a row
    /// whose sibling `timestamp` column read `2026-08-03 07:56:57`).
    pub created_timestamp: i64,
    pub metadata_json: Option<String>,
    pub blocks: Vec<Value>,
}

/// The per-session pieces of the envelope.
#[derive(Debug, Clone, Default)]
pub struct RowCtx {
    pub environment: String,
    pub agent_id: String,
    pub model: Option<String>,
    pub provider: Option<String>,
}

impl RowCtx {
    /// Build the envelope pieces for one session.
    ///
    /// The model is read off the SESSION row because `messages` carries none —
    /// there is no per-message model anywhere in the schema. The consequence is
    /// worth naming: a user who switches model mid-session has the *current*
    /// model attributed to that session's older rows, and a re-read after a
    /// cursor loss would attribute a different one. Accepted because the server
    /// builds a `model_request` row's whole summary from the model, so the
    /// alternative is a session of blank rows.
    pub fn new(
        working_dir: Option<&str>,
        model_config_json: Option<&str>,
        provider: Option<&str>,
        environment: &str,
        fallback_agent_id: &str,
    ) -> Self {
        let model = model_config_json
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|v| {
                v.get("model_name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|m| !m.is_empty());
        Self {
            environment: environment.to_string(),
            agent_id: agent_id(working_dir, fallback_agent_id),
            model,
            provider: provider.filter(|p| !p.is_empty()).map(str::to_string),
        }
    }
}

/// `goose-<project>` from the session's `working_dir`.
///
/// `working_dir` is `NOT NULL` and was populated for every live session, so
/// goose sessions group by project the way Claude's do rather than collapsing
/// into one bucket the way a cwd-less gateway has to.
///
/// Sanitised with the Claude source's own function rather than a copy of it:
/// the hook source derives `goose-<project>` for the same run from the hook
/// row's `cwd`, and if the two spellings ever drifted apart, one run's hook
/// events and session events would file under two agents that look unrelated.
pub fn agent_id(working_dir: Option<&str>, fallback: &str) -> String {
    let project = working_dir
        .and_then(|w| w.trim_end_matches('/').rsplit('/').find(|p| !p.is_empty()))
        .map(sanitize_id_part)
        .filter(|p| !p.is_empty());
    match project {
        Some(p) => format!("goose-{p}"),
        None => fallback.to_string(),
    }
}

/// Parse a `content_json` blob into its block array.
///
/// Anything that is not an array yields no blocks rather than an error: a row
/// we cannot read must still advance the watermark, or the poller stalls on it
/// forever.
pub fn parse_blocks(content: Option<&str>) -> Vec<Value> {
    match content.map(serde_json::from_str::<Value>) {
        Some(Ok(Value::Array(blocks))) => blocks,
        _ => Vec::new(),
    }
}

/// The microsecond offset for one event of one row.
///
/// The server orders events by `(timestamp, random id)`, and goose stores
/// `created_timestamp` in whole SECONDS — a live capture had EIGHT rows (four
/// parallel `shell` calls and their four results) sharing one value. Without a
/// per-row offset those eight events come back shuffled, so a result renders
/// above the call that produced it.
///
/// The offset is `row_id`-derived rather than batch-position-derived so it does
/// not depend on where a poll boundary fell: the same row yields the same
/// microsecond whatever the watermark was, which is what keeps a re-read
/// byte-identical. Two rows collide only if their ids differ by a multiple of
/// 100,000 *and* they share a second — 100,000 messages written inside one
/// second, which a chat log cannot reach.
///
/// Slot 0 is the session start, 1..=8 are content blocks, 9 is the session end,
/// so a row's own events never tie with its start or end.
pub fn slot_micros(row_id: i64, slot: u32) -> u32 {
    let base = (row_id.rem_euclid(ROW_SLOT_WRAP) * SLOTS_PER_ROW) as u32;
    base + slot.min(SLOT_END)
}

/// Format epoch milliseconds as the RFC3339-with-microseconds string ingest
/// requires.
///
/// Microseconds are forced rather than left to RFC3339's variable precision, so
/// every source emits one shape and the hook stream and this one sort against
/// each other on a shared session timeline.
pub fn to_rfc3339_micros(epoch_ms: i64, micros: u32) -> Option<String> {
    let nanos = (epoch_ms as i128) * 1_000_000 + (micros as i128) * 1_000;
    let dt = time::OffsetDateTime::from_unix_timestamp_nanos(nanos).ok()?;
    const FMT: &[time::format_description::BorrowedFormatItem<'_>] = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:6]Z"
    );
    dt.format(FMT).ok()
}

/// A row's timestamp for one slot, or `None` when the row's time is unusable.
///
/// [`epoch_to_millis`] reports an implausible value as zero, and emitting it
/// anyway would date the event 1970-01-01 — which does not merely look wrong,
/// it parks the event at the very start of every timeline it appears on.
pub fn timestamp_for(created_timestamp: i64, row_id: i64, slot: u32) -> Option<String> {
    let ms = epoch_to_millis(created_timestamp as f64);
    if ms == 0 {
        return None;
    }
    to_rfc3339_micros(ms, slot_micros(row_id, slot))
}

/// The envelope every emitted event carries.
///
/// `goose_row_id` is the dedup discriminator: two identical turns from
/// different rows must hash differently, or the server collapses them into one.
fn base(
    kind: &str,
    session_id: &str,
    row_id: i64,
    created_timestamp: i64,
    slot: u32,
    ctx: &RowCtx,
) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert(
        "timestamp".into(),
        json!(timestamp_for(created_timestamp, row_id, slot)?),
    );
    m.insert("session_id".into(), json!(session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("goose_row_id".into(), json!(row_id));
    Some(m)
}

/// The session's `agent_start`, ridden on its first message row.
pub fn agent_start(row: &MessageRow, working_dir: Option<&str>, ctx: &RowCtx) -> Option<Value> {
    let mut m = base(
        "agent_start",
        &row.session_id,
        row.id,
        row.created_timestamp,
        SLOT_START,
        ctx,
    )?;
    // The goal is the session's opening human prompt. Taken only from a `user`
    // row's text block: a session that opens with something else gets no goal
    // rather than a guessed one, and a tool result's 52 KB of stdout is exactly
    // the sort of thing a guess would put in the session title.
    if row.role == "user"
        && let Some(text) = first_text(&row.blocks)
    {
        m.insert(
            "goal".into(),
            json!(text.chars().take(MAX_GOAL_CHARS).collect::<String>()),
        );
    }
    if let Some(wd) = working_dir.filter(|w| !w.is_empty()) {
        m.insert("goose_working_dir".into(), json!(wd));
    }
    if let Some(model) = &ctx.model {
        m.insert("model".into(), json!(model));
    }
    if let Some(provider) = &ctx.provider {
        m.insert("goose_provider".into(), json!(provider));
    }
    Some(Value::Object(m))
}

/// The session's `agent_end`, ridden on the session's LAST message row.
///
/// Carries nothing beyond the envelope on purpose. The obvious additions —
/// `sessions.total_tokens`, `updated_at`, the session name — are all mutated
/// after the fact by goose, so including one would make a re-read of the same
/// row produce different bytes and leave a second end event on the timeline.
pub fn agent_end(
    session_id: &str,
    row_id: i64,
    created_timestamp: i64,
    ctx: &RowCtx,
) -> Option<Value> {
    base(
        "agent_end",
        session_id,
        row_id,
        created_timestamp,
        SLOT_END,
        ctx,
    )
    .map(Value::Object)
}

/// One row's content blocks to events.
///
/// `tool_names` maps a tool-call id to the name from its `toolRequest`, because
/// a `toolResponse` block names no tool and a result naming no tool renders as
/// a blank row.
pub fn content_events(
    row: &MessageRow,
    ctx: &RowCtx,
    tool_names: &BTreeMap<String, String>,
) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (i, block) in row.blocks.iter().enumerate() {
        let index = u32::try_from(i).unwrap_or(u32::MAX);
        let slot = SLOT_FIRST_BLOCK.saturating_add(index).min(SLOT_LAST_BLOCK);
        let Some(mut m) = block_event(row, block, slot, ctx, tool_names) else {
            continue;
        };
        // The block index distinguishes two identical blocks in ONE row, which
        // the row id alone cannot: they would otherwise hash to the same event.
        if i > 0 {
            m.insert("goose_block_index".into(), json!(i));
        }
        out.push(Value::Object(m));
    }
    attach_usage(row, &mut out);
    out
}

fn block_event(
    row: &MessageRow,
    block: &Value,
    slot: u32,
    ctx: &RowCtx,
    tool_names: &BTreeMap<String, String>,
) -> Option<Map<String, Value>> {
    // Branch on the BLOCK type, never on `role` alone: goose files tool results
    // in `role:'user'` rows, so a role-first branch renders every tool result
    // as a user prompt.
    match block.get("type").and_then(Value::as_str) {
        Some("text") => text_event(row, block.get("text")?.as_str()?, slot, ctx, false),
        // Not seen in the live corpus, but `thinking` is a variant of goose's
        // MessageContent enum, and an unhandled variant drops the turn silently.
        Some("thinking") => text_event(row, block.get("thinking")?.as_str()?, slot, ctx, true),
        Some("toolRequest") => tool_use_event(row, block, slot, ctx),
        Some("toolResponse") => tool_result_event(row, block, slot, ctx, tool_names),
        // `image`, `redactedThinking`, `toolConfirmationRequest`,
        // `contextLengthExceeded`, … carry no text worth a timeline row.
        _ => None,
    }
}

/// A text block: the user's prompt, or the model's reply.
fn text_event(
    row: &MessageRow,
    text: &str,
    slot: u32,
    ctx: &RowCtx,
    thinking: bool,
) -> Option<Map<String, Value>> {
    if text.is_empty() {
        return None;
    }
    let assistant = row.role == "assistant";
    let kind = if assistant {
        "model_response"
    } else {
        "model_request"
    };
    let mut m = base(
        kind,
        &row.session_id,
        row.id,
        row.created_timestamp,
        slot,
        ctx,
    )?;
    if assistant {
        m.insert("role".into(), json!("assistant"));
        m.insert("content".into(), json!(text));
    } else {
        m.insert(
            "messages".into(),
            json!([{ "role": "user", "content": text }]),
        );
    }
    if thinking {
        m.insert("goose_thinking".into(), json!(true));
    }
    if let Some(model) = &ctx.model {
        m.insert("model".into(), json!(model));
    }
    Some(m)
}

fn tool_use_event(
    row: &MessageRow,
    block: &Value,
    slot: u32,
    ctx: &RowCtx,
) -> Option<Map<String, Value>> {
    let mut m = base(
        "tool_use",
        &row.session_id,
        row.id,
        row.created_timestamp,
        slot,
        ctx,
    )?;
    let call = block.get("toolCall");
    let value = call.and_then(|c| c.get("value"));
    let name = value
        .and_then(|v| v.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    // Fall back to a row-derived id so two identical calls in one row cannot
    // hash-collapse into a single event.
    let id = block
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("goose-{}-{slot}", row.id));
    m.insert("tool_name".into(), json!(name));
    m.insert("tool_call_id".into(), json!(id));
    if let Some(args) = value.and_then(|v| v.get("arguments")) {
        m.insert("input".into(), args.clone());
    }
    if let Some(model) = &ctx.model {
        m.insert("model".into(), json!(model));
    }
    // `toolCall` is a serialized Result: a non-success status means the call
    // never reached the tool, and its `value` is absent.
    if let Some(status) = call
        .and_then(|c| c.get("status"))
        .and_then(Value::as_str)
        .filter(|s| *s != "success")
    {
        m.insert("goose_tool_call_status".into(), json!(status));
        m.insert(
            "error".into(),
            json!(stringify(
                call.and_then(|c| c.get("error")).unwrap_or(&Value::Null)
            )),
        );
        m.insert("error_type".into(), json!("goose_tool_error"));
    }
    Some(m)
}

fn tool_result_event(
    row: &MessageRow,
    block: &Value,
    slot: u32,
    ctx: &RowCtx,
    tool_names: &BTreeMap<String, String>,
) -> Option<Map<String, Value>> {
    let mut m = base(
        "tool_result",
        &row.session_id,
        row.id,
        row.created_timestamp,
        slot,
        ctx,
    )?;
    let result = block.get("toolResult");
    let value = result.and_then(|r| r.get("value"));
    if let Some(id) = block.get("id").and_then(Value::as_str) {
        m.insert("tool_call_id".into(), json!(id));
        if let Some(name) = tool_names.get(id) {
            m.insert("tool_name".into(), json!(name));
        }
    }
    let output = result_text(value);
    m.insert("output".into(), json!(output));

    let failed_status = result
        .and_then(|r| r.get("status"))
        .and_then(Value::as_str)
        .is_some_and(|s| s != "success");
    let flagged = value
        .and_then(|v| v.get("isError"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if failed_status || flagged {
        // A failed Result carries its message in `error`, not in `value` — a
        // blind read of `value` would report an empty error and the product
        // would show a failure with no reason.
        let detail = result
            .and_then(|r| r.get("error"))
            .map(stringify)
            .filter(|s| !s.is_empty())
            .unwrap_or(output);
        m.insert("error".into(), json!(detail));
        m.insert("error_type".into(), json!("goose_tool_error"));
    }
    Some(m)
}

/// Bill a row's token usage to its FIRST event.
///
/// Usage lives in `metadata_json.usage` with camelCase keys; the `tokens`
/// column exists but was NULL for every row of the live corpus, so reading it
/// would report zero tokens for every session.
fn attach_usage(row: &MessageRow, events: &mut [Value]) {
    let Some(raw) = row.metadata_json.as_deref() else {
        return;
    };
    let Ok(meta) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let Some(usage) = meta.get("usage") else {
        return;
    };
    let Some(first) = events.first_mut().and_then(Value::as_object_mut) else {
        return;
    };
    if let Some(n) = usage.get("inputTokens").and_then(Value::as_u64) {
        first.insert("input_tokens".into(), json!(n));
    }
    if let Some(n) = usage.get("outputTokens").and_then(Value::as_u64) {
        first.insert("output_tokens".into(), json!(n));
    }
    first.insert("goose_usage".into(), usage.clone());
}

/// `(id, name)` when `block` is a `toolRequest` that names its tool.
pub fn tool_request_name(block: &Value) -> Option<(String, String)> {
    if block.get("type").and_then(Value::as_str) != Some("toolRequest") {
        return None;
    }
    let id = block.get("id").and_then(Value::as_str)?;
    let name = block
        .pointer("/toolCall/value/name")
        .and_then(Value::as_str)?;
    Some((id.to_string(), name.to_string()))
}

/// The first non-empty text block of a row.
fn first_text(blocks: &[Value]) -> Option<&str> {
    blocks.iter().find_map(|b| {
        (b.get("type").and_then(Value::as_str) == Some("text"))
            .then(|| b.get("text").and_then(Value::as_str))
            .flatten()
            .filter(|t| !t.is_empty())
    })
}

/// Render a `toolResult.value` as text.
///
/// The live shape is `{content:[{type:"text",text}], structuredContent, isError}`.
/// `structuredContent` duplicates the same bytes under `stdout`, so only
/// `content` is read — taking both would double every tool output.
fn result_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => join_text(items),
        Some(Value::Object(obj)) => match obj.get("content") {
            Some(Value::Array(items)) => join_text(items),
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

fn join_text(items: &[Value]) -> String {
    items
        .iter()
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn stringify(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_whole_second_timestamp_still_orders_the_rows_inside_it() {
        // goose stores whole SECONDS: eight live rows (four parallel calls and
        // their results) shared one value. Without a per-row offset the server
        // sorts them by a random id and a result renders above its own call.
        let a = timestamp_for(1_785_744_659, 13, SLOT_FIRST_BLOCK).unwrap();
        let b = timestamp_for(1_785_744_659, 14, SLOT_FIRST_BLOCK).unwrap();
        assert!(a < b, "{a} must sort before {b}");
        assert!(a.starts_with("2026-08-03T08:10:59."));
        assert_eq!(a.len(), "2026-08-03T08:10:59.000000Z".len());
    }

    #[test]
    fn a_rows_start_sorts_before_its_blocks_and_its_end_sorts_after() {
        let start = slot_micros(7, SLOT_START);
        let block = slot_micros(7, SLOT_FIRST_BLOCK);
        let end = slot_micros(7, SLOT_END);
        assert!(start < block && block < end);
        // And an out-of-range slot saturates inside the row rather than
        // spilling into the next one's range.
        assert_eq!(slot_micros(7, 99), end);
    }

    #[test]
    fn an_implausible_timestamp_yields_no_event_rather_than_1970() {
        // Emitting it would park the event at the head of every timeline it
        // appears on, which is far more visible than a dropped row.
        assert!(timestamp_for(0, 1, SLOT_START).is_none());
        assert!(timestamp_for(42, 1, SLOT_START).is_none());
    }

    #[test]
    fn the_agent_id_falls_back_when_a_session_has_no_working_dir() {
        assert_eq!(agent_id(Some("/home/u/src/repo"), "goose"), "goose-repo");
        assert_eq!(agent_id(Some("/home/u/src/repo/"), "goose"), "goose-repo");
        assert_eq!(agent_id(Some("/"), "goose"), "goose");
        assert_eq!(agent_id(None, "goose"), "goose");
    }

    #[test]
    fn a_content_blob_that_is_not_an_array_yields_no_blocks() {
        // The row must still advance the watermark; erroring would stall the
        // poller on it forever.
        assert!(parse_blocks(Some("not json")).is_empty());
        assert!(parse_blocks(Some(r#"{"type":"text"}"#)).is_empty());
        assert!(parse_blocks(None).is_empty());
        assert_eq!(parse_blocks(Some(r#"[{"type":"text"}]"#)).len(), 1);
    }
}
