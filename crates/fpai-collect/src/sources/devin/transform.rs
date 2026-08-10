//! Devin `message_nodes` row → AgentEye events.
//!
//! Every function here is pure in its arguments. Nothing consults the clock, a
//! counter, or anything outside what it is handed, which is what makes two
//! reads of the same rows byte-identical and therefore collapsible by the
//! server's content-hash dedup.
//!
//! Record shapes are verbatim from a live `~/.local/share/devin/cli/sessions.db`
//! (devin v3000.1.27); see the parent module docs for the forest gotcha that
//! drives the dedup discriminator and the timestamp choice.
//!
//! # `chat_message` is OpenAI-style, not a typed-block array
//!
//! Unlike goose (Claude-style `toolRequest`/`toolResponse` blocks), each row's
//! `chat_message` is one OpenAI-shaped object:
//!
//! ```text
//! {"role":"user","content":"…","message_id":"<uuid>","metadata":{"created_at":"…Z"}}
//! {"role":"assistant","content":"…","thinking":"…",
//!  "tool_calls":[{"id":"<uuid>","name":"exec","arguments":{…},"index":0}], "metadata":…}
//! {"role":"tool","content":"…","tool_call_id":"<uuid>","message_id":"…","metadata":…}
//! {"role":"system",…}   ← skipped
//! ```
//!
//! `arguments` is already an OBJECT (not the JSON string of the OpenAI wire
//! format), so `tool_use.input` is the value verbatim.
//!
//! # The dedup discriminator is the message id, NOT the row id
//!
//! goose and factory key their dedup on `<kind>_row_id` / `<kind>_line_offset`,
//! because in those sources a row / line is a message. Devin's `message_nodes`
//! is a FOREST: every turn replays the earlier conversation under a fresh root,
//! so ONE logical message lands as 2-4 rows (verified live: 34 rows / 14 distinct
//! messages for one session). Keying on `row_id` would ship each message 2-4×
//! and the server would keep every copy.
//!
//! So [`base`] stamps `devin_message_id` — the `message_id` UUID inside
//! `chat_message`, which is identical across every replay of a message. The
//! server then collapses the replays, and two genuinely distinct messages that
//! happen to share text stay distinct (different `message_id`). This is the
//! deliberate inversion of goose, whose two identical rows are two real events.
//!
//! # The timestamp comes from `metadata.created_at`, NOT the row column
//!
//! For the collapse above to work, every replay of a message must render
//! byte-identical, which forbids any field that moves between replays. The DB
//! row's `created_at` column is exactly such a field — it was observed DIFFERING
//! across replays of one message. `metadata.created_at` (a nanosecond ISO string
//! carried INSIDE `chat_message`) is replay-stable, so it is the timestamp basis;
//! the row column is only a fallback for a message that lacks it, and a message
//! that hits the fallback and is then replayed with a different row time will not
//! collapse — an accepted, documented edge, not the common path.
//!
//! [`with_index`] is reused (as factory reuses it) to normalise the ISO string
//! to the microsecond form ingest expects and to offset the several events of one
//! message so they keep their order.

use serde_json::{Map, Value, json};

use crate::sources::claude::transform::{sanitize_id_part, with_index};
use crate::sqlitepoll::epoch_to_millis;

/// Longest session goal carried on `agent_start`.
const MAX_GOAL_CHARS: usize = 1024;

/// One `message_nodes` row with its `chat_message` already parsed.
///
/// `created_at` is the DB row column, epoch SECONDS — a fallback timestamp only,
/// because it is not replay-stable (see the module docs). The replay-stable time
/// lives at `message.metadata.created_at`.
#[derive(Debug, Clone, Default)]
pub struct MessageRow {
    pub row_id: i64,
    pub session_id: String,
    pub created_at: i64,
    /// Parsed `chat_message` object, or `Value::Null` when unparseable.
    pub message: Value,
}

impl MessageRow {
    /// `user` / `assistant` / `tool` / `system`, or `""` for an unparseable row.
    pub fn role(&self) -> &str {
        self.message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    /// The replay-stable ISO timestamp inside the message, if any.
    pub fn iso_created_at(&self) -> Option<&str> {
        self.message
            .pointer("/metadata/created_at")
            .and_then(Value::as_str)
    }

    /// The dedup identity: the message's own `message_id`, falling back to a
    /// row-derived id (which cannot collapse across replays) when absent.
    pub fn message_id(&self) -> String {
        match self.message.get("message_id") {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => format!("devin-row-{}", self.row_id),
        }
    }
}

/// The per-session pieces of the envelope.
#[derive(Debug, Clone, Default)]
pub struct RowCtx {
    pub environment: String,
    pub agent_id: String,
    pub model: Option<String>,
}

impl RowCtx {
    /// Build the envelope pieces for one session.
    ///
    /// The model is read off the SESSION row (`sessions.model`, `NOT NULL`) —
    /// there is no per-message model in the schema, so a user who switched model
    /// mid-session has the session's current model attributed to older rows,
    /// accepted for the same reason goose accepts it.
    pub fn new(
        working_dir: Option<&str>,
        model: Option<&str>,
        environment: &str,
        fallback_agent_id: &str,
    ) -> Self {
        Self {
            environment: environment.to_string(),
            agent_id: agent_id(working_dir, fallback_agent_id),
            model: model.filter(|m| !m.is_empty()).map(str::to_string),
        }
    }
}

/// `devin-<project>` from the session's `working_directory`.
///
/// `working_directory` is `NOT NULL` and populated for every live session, so
/// Devin sessions group by project like Claude's rather than collapsing into one
/// bucket. Sanitised with the Claude source's own function rather than a copy of
/// it: the hook source derives `devin-<project>` for the same run from the hook
/// row's `cwd`, and if the two spellings drifted apart one run's hook events and
/// session events would file under two agents that look unrelated.
pub fn agent_id(working_dir: Option<&str>, fallback: &str) -> String {
    let project = working_dir
        .and_then(|w| w.trim_end_matches('/').rsplit('/').find(|p| !p.is_empty()))
        .map(sanitize_id_part)
        .filter(|p| !p.is_empty());
    match project {
        Some(p) => format!("devin-{p}"),
        None => fallback.to_string(),
    }
}

/// Parse a `chat_message` blob into its object.
///
/// Anything that is not a JSON object yields `Null` rather than an error: a row
/// we cannot read must still advance the watermark, or the poller stalls on it
/// forever.
pub fn parse_message(content: Option<&str>) -> Value {
    match content.map(serde_json::from_str::<Value>) {
        Some(Ok(v @ Value::Object(_))) => v,
        _ => Value::Null,
    }
}

/// Format epoch milliseconds as the RFC3339-with-microseconds string ingest
/// requires.
///
/// Used only for the epoch-seconds paths (`agent_start` off `sessions.created_at`
/// and the row-column timestamp fallback); the common message path runs the ISO
/// string through [`with_index`]. Microseconds are forced rather than left to
/// RFC3339's variable precision so every source emits one shape and sorts against
/// the hook stream on a shared timeline.
fn to_rfc3339_micros(epoch_ms: i64, micros: u32) -> Option<String> {
    let nanos = (epoch_ms as i128) * 1_000_000 + (micros as i128) * 1_000;
    let dt = time::OffsetDateTime::from_unix_timestamp_nanos(nanos).ok()?;
    const FMT: &[time::format_description::BorrowedFormatItem<'_>] = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:6]Z"
    );
    dt.format(FMT).ok()
}

/// A message block's timestamp, offset by `index` so several events of one
/// message keep their order.
///
/// Prefers the replay-stable ISO `metadata.created_at`; only when it is absent or
/// unusable does it fall back to the DB row's epoch-seconds column, and an
/// implausible fallback yields `None` rather than dating the event to 1970 (which
/// would park it at the head of every timeline it appears on).
fn timestamp_for(iso: Option<&str>, row_created_at: i64, index: usize) -> Option<String> {
    if let Some(s) = iso.and_then(|raw| with_index(raw, index)) {
        return Some(s);
    }
    let ms = epoch_to_millis(row_created_at as f64);
    if ms == 0 {
        return None;
    }
    to_rfc3339_micros(ms, index.min(999) as u32)
}

/// The envelope every emitted event carries.
///
/// `devin_message_id` is the dedup discriminator — see the module docs for why it
/// is the message id and not the row id. `devin_block_index` distinguishes two
/// blocks of one message, which the message id alone cannot.
fn base(
    ctx: &RowCtx,
    kind: &str,
    session_id: &str,
    message_id: &str,
    timestamp: &str,
    index: usize,
) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("timestamp".into(), json!(timestamp));
    m.insert("session_id".into(), json!(session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("devin_message_id".into(), json!(message_id));
    if index > 0 {
        m.insert("devin_block_index".into(), json!(index));
    }
    m
}

/// The session's `agent_start`, ridden on the session's first row.
///
/// Stamped at the SESSION's `created_at` (immutable — the session's true start),
/// not the row's time: under the forest the first row by `row_id` is not the
/// earliest message by time, so the row's own timestamp would mis-date the start.
/// `sessions.last_activity_at` is deliberately not used anywhere — it mutates,
/// which is why there is no row-local `agent_end` here (see the parent docs).
pub fn agent_start(
    row: &MessageRow,
    working_dir: Option<&str>,
    session_created_at: Option<i64>,
    ctx: &RowCtx,
) -> Option<Value> {
    let ms = epoch_to_millis(session_created_at? as f64);
    if ms == 0 {
        return None;
    }
    let ts = to_rfc3339_micros(ms, 0)?;
    let message_id = row.message_id();
    let mut m = base(ctx, "agent_start", &row.session_id, &message_id, &ts, 0);
    // The goal is the session's opening human prompt. Taken only from a `user`
    // row's text: a session that opens with a system prompt gets no goal rather
    // than a guessed one.
    if row.role() == "user" {
        let text = extract_text(row.message.get("content"));
        if !text.is_empty() {
            m.insert(
                "goal".into(),
                json!(text.chars().take(MAX_GOAL_CHARS).collect::<String>()),
            );
        }
    }
    if let Some(wd) = working_dir.filter(|w| !w.is_empty()) {
        m.insert("devin_working_dir".into(), json!(wd));
    }
    if let Some(model) = &ctx.model {
        m.insert("model".into(), json!(model));
    }
    Some(Value::Object(m))
}

/// One row's `chat_message` to events.
///
/// `tool_names` maps a tool-call id to the name from the assistant `tool_calls`
/// entry that issued it, because a `role:"tool"` result names no tool and a
/// result naming no tool renders as a blank row.
pub fn content_events(
    row: &MessageRow,
    ctx: &RowCtx,
    tool_names: &std::collections::BTreeMap<String, String>,
) -> Vec<Value> {
    let message_id = row.message_id();
    let iso = row.iso_created_at().map(str::to_string);
    // One event per (message block); `index` orders them within the message.
    let mk = |kind: &str, index: usize| -> Option<Map<String, Value>> {
        let ts = timestamp_for(iso.as_deref(), row.created_at, index)?;
        Some(base(ctx, kind, &row.session_id, &message_id, &ts, index))
    };

    let mut out: Vec<Value> = Vec::new();
    let mut index = 0usize;
    match row.role() {
        "user" => {
            let text = extract_text(row.message.get("content"));
            if !text.is_empty()
                && let Some(mut m) = mk("model_request", index)
            {
                if let Some(model) = &ctx.model {
                    m.insert("model".into(), json!(model));
                }
                m.insert(
                    "messages".into(),
                    json!([{ "role": "user", "content": text }]),
                );
                out.push(Value::Object(m));
            }
        }
        "assistant" => {
            // A separate `thinking` field, not seen on every model but present in
            // the live corpus; an unhandled variant drops the reasoning silently.
            if let Some(thinking) = row
                .message
                .get("thinking")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                && let Some(mut m) = mk("model_response", index)
            {
                m.insert("role".into(), json!("assistant"));
                m.insert("content".into(), json!(thinking));
                m.insert("devin_thinking".into(), json!(true));
                if let Some(model) = &ctx.model {
                    m.insert("model".into(), json!(model));
                }
                out.push(Value::Object(m));
                index += 1;
            }
            let text = extract_text(row.message.get("content"));
            if !text.is_empty()
                && let Some(mut m) = mk("model_response", index)
            {
                m.insert("role".into(), json!("assistant"));
                m.insert("content".into(), json!(text));
                if let Some(model) = &ctx.model {
                    m.insert("model".into(), json!(model));
                }
                out.push(Value::Object(m));
                index += 1;
            }
            if let Some(calls) = row.message.get("tool_calls").and_then(Value::as_array) {
                for tc in calls {
                    let Some(mut m) = mk("tool_use", index) else {
                        continue;
                    };
                    let name = tool_call_name(tc);
                    // Fall back to a message-derived id so a call with no id of
                    // its own still cannot hash-collapse with a sibling — and the
                    // fallback is stable across replays (message id + position).
                    let id = tc
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("devin-{message_id}-{index}"));
                    m.insert("tool_name".into(), json!(name));
                    m.insert("tool_call_id".into(), json!(id));
                    m.insert("input".into(), tool_call_input(tc));
                    if let Some(model) = &ctx.model {
                        m.insert("model".into(), json!(model));
                    }
                    out.push(Value::Object(m));
                    index += 1;
                }
            }
        }
        "tool" => {
            if let Some(mut m) = mk("tool_result", index) {
                if let Some(id) = row.message.get("tool_call_id").and_then(Value::as_str) {
                    m.insert("tool_call_id".into(), json!(id));
                    if let Some(name) = tool_names.get(id) {
                        m.insert("tool_name".into(), json!(name));
                    }
                }
                m.insert(
                    "output".into(),
                    json!(extract_text(row.message.get("content"))),
                );
                out.push(Value::Object(m));
            }
        }
        // `system` (and any future role) carries no timeline row.
        _ => {}
    }
    out
}

/// `(id, name)` for every tool call an assistant `chat_message` issued.
///
/// Used by the poll to name a `tool_result` from the call it answers — both for
/// calls in the same batch and, via the parent's cross-batch lookup, for calls
/// that landed in an earlier poll.
pub fn tool_call_names(message: &Value) -> Vec<(String, String)> {
    let Some(calls) = message.get("tool_calls").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for tc in calls {
        if let Some(id) = tc
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            out.push((id.to_string(), tool_call_name(tc)));
        }
    }
    out
}

/// A tool call's name — flat `name`, tolerating the OpenAI `function.name` shape.
fn tool_call_name(tc: &Value) -> String {
    tc.get("name")
        .and_then(Value::as_str)
        .or_else(|| tc.pointer("/function/name").and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .unwrap_or("tool")
        .to_string()
}

/// A tool call's input. Devin's `arguments` is already an OBJECT; the JSON-string
/// (OpenAI wire) form is parsed for forward-compat, and anything else is `{}`.
fn tool_call_input(tc: &Value) -> Value {
    match tc
        .get("arguments")
        .or_else(|| tc.pointer("/function/arguments"))
    {
        Some(v @ Value::Object(_)) => v.clone(),
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or_else(|_| json!({})),
        _ => json!({}),
    }
}

/// Text from a `content` field that is a string or an array of `{type,text}`
/// blocks.
fn extract_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_id_falls_back_when_a_session_has_no_working_directory() {
        assert_eq!(agent_id(Some("/home/u/src/repo"), "devin"), "devin-repo");
        assert_eq!(agent_id(Some("/home/u/src/repo/"), "devin"), "devin-repo");
        assert_eq!(agent_id(Some("/"), "devin"), "devin");
        assert_eq!(agent_id(None, "devin"), "devin");
    }

    #[test]
    fn the_timestamp_prefers_the_replay_stable_iso_over_the_row_column() {
        // The whole basis of the forest collapse: two rows replaying one message
        // must render one timestamp, so it comes from the message's own ISO, not
        // the row's `created_at` — which was observed differing across replays.
        let a = timestamp_for(Some("2026-07-30T07:30:33.500577515Z"), 111, 0).unwrap();
        let b = timestamp_for(Some("2026-07-30T07:30:33.500577515Z"), 999, 0).unwrap();
        assert_eq!(a, b, "the row column must not affect a message with an ISO");
        assert_eq!(a, "2026-07-30T07:30:33.500577Z");
    }

    #[test]
    fn the_timestamp_falls_back_to_the_row_column_when_the_iso_is_absent() {
        // A message with no `metadata.created_at` still needs a time; the row's
        // epoch-seconds column serves, and an implausible one drops the event.
        let t = timestamp_for(None, 1_785_396_633, 0).unwrap();
        assert!(t.ends_with(".000000Z"), "got {t}");
        assert!(timestamp_for(None, 0, 0).is_none());
        assert!(timestamp_for(None, 42, 0).is_none());
    }

    #[test]
    fn blocks_of_one_message_get_ordered_distinct_timestamps() {
        let a = timestamp_for(Some("2026-07-30T07:30:33.500577515Z"), 0, 0).unwrap();
        let b = timestamp_for(Some("2026-07-30T07:30:33.500577515Z"), 0, 1).unwrap();
        assert!(a < b, "{a} must sort before {b}");
    }

    #[test]
    fn a_chat_message_that_is_not_an_object_yields_null() {
        assert_eq!(parse_message(Some("not json")), Value::Null);
        assert_eq!(parse_message(Some("[1,2,3]")), Value::Null);
        assert_eq!(parse_message(None), Value::Null);
        assert!(parse_message(Some(r#"{"role":"user"}"#)).is_object());
    }

    #[test]
    fn tool_call_input_is_the_object_verbatim_and_a_json_string_is_parsed() {
        let obj = json!({"id": "c1", "name": "exec", "arguments": {"command": "ls"}});
        assert_eq!(tool_call_input(&obj), json!({"command": "ls"}));
        let wire = json!({"id": "c1", "name": "exec", "arguments": "{\"command\":\"ls\"}"});
        assert_eq!(tool_call_input(&wire), json!({"command": "ls"}));
        let missing = json!({"id": "c1", "name": "exec"});
        assert_eq!(tool_call_input(&missing), json!({}));
    }
}
