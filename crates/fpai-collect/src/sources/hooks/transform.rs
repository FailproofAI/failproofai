//! Turning a failproofai hook-activity row into AgentEye events.
//!
//! # Why this maps onto an existing schema
//!
//! AgentEye already has `hook_triggered` and `hook_completed` as first-class
//! event types, with `hook_name` and `hook_id` promoted to their own columns, a
//! `/hooks` page, and a latency endpoint that pairs the two legs on `hook_id`.
//! So this needs no server or dashboard work — it only has to emit the shape
//! that machinery already reads.
//!
//! One activity row carries a duration, so it yields BOTH legs with exact
//! latency rather than a start whose end has to be inferred.
//!
//! # `hook_id` uniqueness is load-bearing
//!
//! The server pairs legs on `hook_id` and dedups on a content hash. Two rows
//! colliding on an id would collapse into one row in the product — the
//! measured corpus has 8,613 `PreToolUse` rows in a single session, and a
//! per-session id would have merged all of them. The id therefore carries the
//! row's byte offset, which is unique within a file by construction and stable
//! across a re-read.

use serde::Deserialize;
use serde_json::{Map, Value, json};

/// One row of `~/.failproofai/cache/hook-activity/*.jsonl`.
///
/// Field names match `HookActivityEntry` in `hook-activity-store.ts`. Every
/// field except the timestamp is optional here even where TypeScript declares
/// it required: this parses rows written by older versions, and a row that
/// fails to deserialize is a row that never reaches the dashboard.
#[derive(Debug, Clone, Deserialize)]
pub struct HookRow {
    /// Epoch milliseconds.
    pub timestamp: i64,
    #[serde(rename = "eventType")]
    pub event_type: Option<String>,
    /// Which agent CLI fired the hook.
    pub integration: Option<String>,
    #[serde(rename = "toolName")]
    pub tool_name: Option<String>,
    #[serde(rename = "policyName")]
    pub policy_name: Option<String>,
    #[serde(rename = "matchedPolicies")]
    pub matched_policies: Option<Vec<String>>,
    /// `allow` | `deny` | `instruct`.
    pub decision: Option<String>,
    pub reason: Option<String>,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<f64>,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    #[serde(rename = "permissionMode")]
    pub permission_mode: Option<String>,
}

impl HookRow {
    pub fn decision_str(&self) -> &str {
        self.decision.as_deref().unwrap_or("allow")
    }

    /// True for the 99.1% of rows that are plain no-ops.
    pub fn is_allow(&self) -> bool {
        self.decision_str() == "allow"
    }
}

/// Format epoch milliseconds as the RFC3339-with-microseconds string ingest
/// requires, offsetting by `index` microseconds.
///
/// The offset exists because the server orders events by `(ts, random id)`.
/// Both legs of a pair derived from one row share a millisecond, so without it
/// `hook_completed` can sort before its own `hook_triggered` — visibly wrong
/// on a timeline. Index 0 keeps the row's exact time, so the start leg is
/// never moved.
pub fn to_rfc3339_micros(epoch_ms: i64, index: u32) -> Option<String> {
    let nanos = (epoch_ms as i128) * 1_000_000 + (index as i128) * 1_000;
    let dt = time::OffsetDateTime::from_unix_timestamp_nanos(nanos).ok()?;
    // Microseconds are forced rather than left to RFC3339's variable
    // precision, so every event has one shape and the server parses one
    // format. It also matches what the session sources emit, so the two
    // streams sort against each other correctly on a shared timeline.
    const FMT: &[time::format_description::BorrowedFormatItem<'_>] = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:6]Z"
    );
    dt.format(FMT).ok()
}

/// Sanitize one component of a derived agent id.
fn sanitize_id_part(s: &str) -> String {
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
    let collapsed = cleaned
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    collapsed.chars().take(48).collect()
}

/// The agent id an event is filed under.
///
/// `<integration>-<project>` where a working directory is known, matching the
/// scheme the session sources use, so a hook event and the transcript events
/// for the same run land under one agent rather than two that look unrelated.
/// Falls back to the bare integration name when there is no cwd — a gateway
/// session, say.
pub fn agent_id(row: &HookRow) -> String {
    let base = row.integration.as_deref().unwrap_or("failproofai");
    match row.cwd.as_deref().and_then(project_name) {
        Some(project) => format!("{}-{}", sanitize_id_part(base), project),
        None => sanitize_id_part(base),
    }
}

/// Last path component of a working directory.
fn project_name(cwd: &str) -> Option<String> {
    let trimmed = cwd.trim_end_matches('/');
    let last = trimmed.rsplit('/').find(|p| !p.is_empty())?;
    let cleaned = sanitize_id_part(last);
    (!cleaned.is_empty()).then_some(cleaned)
}

/// Common envelope every emitted event carries.
fn base(
    row: &HookRow,
    session_id: &str,
    environment: &str,
    kind: &str,
    index: u32,
) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert(
        "timestamp".into(),
        json!(to_rfc3339_micros(row.timestamp, index)?),
    );
    m.insert("session_id".into(), json!(session_id));
    m.insert("agent_id".into(), json!(agent_id(row)));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(environment));
    Some(m)
}

/// Build the `hook_triggered` / `hook_completed` pair for one row.
///
/// `offset` is the row's byte position in its file, which is what makes
/// `hook_id` unique and stable across a re-read.
///
/// Returns nothing when the row has no session id: ingest requires one, so
/// emitting would produce a line the server silently skips.
pub fn to_events(row: &HookRow, offset: u64, environment: &str) -> Vec<Value> {
    let Some(session_id) = row.session_id.as_deref().filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    let event_name = row.event_type.as_deref().unwrap_or("Hook");
    let hook_id = format!("{session_id}:{}:{offset}", row.timestamp);

    let Some(mut start) = base(row, session_id, environment, "hook_triggered", 0) else {
        return Vec::new();
    };
    start.insert("hook_name".into(), json!(event_name));
    start.insert("hook_id".into(), json!(hook_id));
    // `trigger_event` is emitted on the START leg only. The server filters on
    // it via a semijoin over hook_id, so duplicating it on the end leg would
    // double-count every hook in that view.
    start.insert("trigger_event".into(), json!(event_name));
    if let Some(d) = row.duration_ms {
        start.insert("duration_ms".into(), json!(d));
    }
    let mut input = Map::new();
    if let Some(t) = &row.tool_name {
        input.insert("tool_name".into(), json!(t));
    }
    if let Some(c) = &row.cwd {
        input.insert("cwd".into(), json!(c));
    }
    if let Some(p) = &row.permission_mode {
        input.insert("permission_mode".into(), json!(p));
    }
    if !input.is_empty() {
        start.insert("input".into(), Value::Object(input));
    }

    let Some(mut end) = base(row, session_id, environment, "hook_completed", 1) else {
        return Vec::new();
    };
    end.insert("hook_name".into(), json!(event_name));
    end.insert("hook_id".into(), json!(hook_id));
    end.insert("outcome".into(), json!(row.decision_str()));
    if let Some(d) = row.duration_ms {
        end.insert("duration_ms".into(), json!(d));
    }
    if let Some(p) = &row.policy_name {
        end.insert("failproofai_policy".into(), json!(p));
    }
    if let Some(m) = &row.matched_policies {
        end.insert("failproofai_matched".into(), json!(m));
    }
    if let Some(t) = &row.tool_name {
        end.insert("tool_name".into(), json!(t));
    }
    if !row.is_allow() {
        // The server's `is_error` is a truthiness check, so this must never be
        // an empty string — a deny with no reason would otherwise render as a
        // success.
        let reason = row
            .reason
            .as_deref()
            .filter(|r| !r.trim().is_empty())
            .unwrap_or("blocked by failproofai");
        end.insert("error".into(), json!(reason));
        end.insert(
            "error_type".into(),
            json!(format!("failproofai_{}", row.decision_str())),
        );
    }

    vec![Value::Object(start), Value::Object(end)]
}

/// One rolled-up `allow` bucket.
///
/// Under the default verbosity, `allow` rows are aggregated rather than
/// dropped. Keeping the count is what preserves the denominator: "we evaluated
/// 19,000 calls and blocked 15" stays answerable, which it would not be if the
/// no-ops were simply discarded.
#[derive(Debug, Clone)]
pub struct AllowBucket {
    pub session_id: String,
    pub agent_id: String,
    pub event_name: String,
    pub tool_name: Option<String>,
    /// Truncated to the minute; also the bucket's emitted timestamp.
    pub minute_ms: i64,
    pub count: u64,
    pub total_duration_ms: f64,
    pub max_duration_ms: f64,
}

/// The key rows are grouped under: same session, event, tool and minute.
pub fn bucket_key(row: &HookRow) -> Option<(String, String, Option<String>, i64)> {
    let session = row.session_id.clone().filter(|s| !s.is_empty())?;
    let event = row.event_type.clone().unwrap_or_else(|| "Hook".into());
    let minute = row.timestamp - row.timestamp.rem_euclid(60_000);
    Some((session, event, row.tool_name.clone(), minute))
}

impl AllowBucket {
    pub fn add(&mut self, row: &HookRow) {
        self.count += 1;
        let d = row.duration_ms.unwrap_or(0.0);
        self.total_duration_ms += d;
        if d > self.max_duration_ms {
            self.max_duration_ms = d;
        }
    }

    /// A single `hook_completed` standing for every allow in the bucket.
    ///
    /// One leg, not a pair: an aggregate has no single invocation to pair
    /// with, and inventing a `hook_triggered` would make the latency endpoint
    /// report a duration that belongs to no real hook call.
    pub fn to_event(&self, environment: &str) -> Option<Value> {
        let mut m = Map::new();
        m.insert(
            "timestamp".into(),
            json!(to_rfc3339_micros(self.minute_ms, 0)?),
        );
        m.insert("session_id".into(), json!(self.session_id));
        m.insert("agent_id".into(), json!(self.agent_id));
        m.insert("type".into(), json!("hook_completed"));
        m.insert("environment".into(), json!(environment));
        m.insert("hook_name".into(), json!(self.event_name));
        m.insert(
            "hook_id".into(),
            json!(format!(
                "{}:{}:{}:{}:agg",
                self.session_id,
                self.minute_ms,
                self.event_name,
                self.tool_name.as_deref().unwrap_or("-")
            )),
        );
        m.insert("outcome".into(), json!("allow"));
        m.insert("failproofai_allow_count".into(), json!(self.count));
        m.insert(
            "duration_ms".into(),
            json!((self.total_duration_ms / self.count as f64 * 1000.0).round() / 1000.0),
        );
        m.insert(
            "failproofai_max_duration_ms".into(),
            json!(self.max_duration_ms),
        );
        if let Some(t) = &self.tool_name {
            m.insert("tool_name".into(), json!(t));
        }
        Some(Value::Object(m))
    }
}
