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
/// `Default` is derived so test literals can use `..Default::default()`. The
/// store gains fields as the product does, and every construction site
/// enumerating all of them turns each addition into unrelated breakage.
#[derive(Debug, Clone, Default, Deserialize)]
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

    // ---- Decision attribution -------------------------------------------
    // Which policy decided, and under what deployment. Without these the
    // dashboard can group decisions only by the policy's display NAME, which
    // is exactly the substring-parsing this data was added to replace: every
    // row arrives unattributed, so "how much is my org's policy actually
    // doing" has no answer.
    /// `builtin` | `custom` | `convention` | `cloud`. Absent on rows written
    /// before attribution existed, which is meaningful — see the note in
    /// `hook-activity-store.ts` about not guessing a bucket.
    #[serde(rename = "policySource")]
    pub policy_source: Option<String>,
    #[serde(rename = "cloudPolicyId")]
    pub cloud_policy_id: Option<String>,
    /// `cloudRevision` is the pre-rename spelling, and the alias is what keeps
    /// history attributed.
    ///
    /// These rows are written by a DAEMON, not received from a server, so a
    /// machine that was cloud-connected before the rename has real
    /// `hook-activity/*.jsonl` naming `cloudRevision`/`cloudGeneration`. There is
    /// no `deny_unknown_fields` here, so those keys do not error — they are
    /// silently ignored, and every pre-upgrade cloud-decided row deserializes with
    /// `None` and renders as unattributed. Which is the question this field was
    /// added to answer: "how much is my org's policy actually doing".
    ///
    /// Same reasoning as the aliases on `ActiveDeployment` and the legacy
    /// desired-state shape: a rename is safe on a symbol and never on the name of
    /// data an older build already wrote.
    #[serde(rename = "cloudVersion", alias = "cloudRevision")]
    pub cloud_version: Option<i64>,
    /// Present on EVERY row of a managed machine, not just cloud-decided ones:
    /// "what was deployed here" is a different question from "what decided",
    /// and only the former separates a rollout that changed no outcomes from
    /// one that never reached the machine.
    #[serde(rename = "cloudDeployment", alias = "cloudGeneration")]
    pub cloud_deployment: Option<i64>,

    // ---- Suspension ------------------------------------------------------
    /// Set while `failproofai config --pause` is in effect. An `allow` on such
    /// a row proves nothing, so shipping it without this would assert a clean
    /// window over exactly the window that was not enforced.
    #[serde(rename = "pausedBy")]
    pub paused_by: Option<String>,
    #[serde(rename = "pauseExpiresAt")]
    pub pause_expires_at: Option<i64>,

    /// Verdicts from observe-mode policies: evaluated, then discarded. The
    /// whole measurement a trial exists to produce.
    pub observed: Option<Value>,
}

/// The attribution facts for one row.
///
/// This is both what gets emitted AND part of the aggregation key. Those have
/// to be the same set: an aggregate that mixed two policy sources could carry
/// no honest attribution at all, so anything emitted here must be something
/// rows were grouped by.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Attribution {
    pub policy_source: Option<String>,
    pub cloud_policy_id: Option<String>,
    pub cloud_version: Option<i64>,
    pub cloud_deployment: Option<i64>,
    pub paused: bool,
}

impl Attribution {
    pub fn of(row: &HookRow) -> Self {
        Self {
            policy_source: row.policy_source.clone(),
            cloud_policy_id: row.cloud_policy_id.clone(),
            cloud_version: row.cloud_version,
            cloud_deployment: row.cloud_deployment,
            paused: row.paused_by.is_some(),
        }
    }

    /// Write the attribution onto an outgoing event.
    ///
    /// Names are snake_case to match every other payload key the server reads.
    /// `paused` is emitted as a real boolean because the server tests it with
    /// `JSONExtractBool`, which a string would fail.
    fn apply(&self, m: &mut Map<String, Value>) {
        if let Some(s) = &self.policy_source {
            m.insert("policy_source".into(), json!(s));
        }
        if let Some(id) = &self.cloud_policy_id {
            m.insert("cloud_policy_id".into(), json!(id));
        }
        if let Some(r) = self.cloud_version {
            m.insert("cloud_version".into(), json!(r));
        }
        if let Some(g) = self.cloud_deployment {
            m.insert("cloud_deployment".into(), json!(g));
        }
        // Always emitted, never conditionally: an absent key and `false` must
        // not be distinguishable to a reader counting unenforced calls.
        m.insert("paused".into(), json!(self.paused));
    }
}

impl HookRow {
    pub fn decision_str(&self) -> &str {
        self.decision.as_deref().unwrap_or("allow")
    }

    /// True when observe-mode policies recorded a would-be verdict.
    ///
    /// Such a row is an `allow` by construction — the verdict was discarded —
    /// so it would otherwise be swept into an allow aggregate and the trial's
    /// only measurement would be erased by the roll-up.
    pub fn has_observation(&self) -> bool {
        match &self.observed {
            Some(Value::Array(a)) => !a.is_empty(),
            Some(Value::Null) | None => false,
            Some(_) => true,
        }
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
    // Attribution rides the END leg only: it is a property of the decision,
    // and the start leg is emitted before one exists.
    Attribution::of(row).apply(&mut end);
    if let Some(by) = &row.paused_by {
        end.insert("paused_by".into(), json!(by));
    }
    if let Some(exp) = row.pause_expires_at {
        end.insert("pause_expires_at".into(), json!(exp));
    }
    if row.has_observation() {
        // Carried whole rather than flattened: a row can observe several
        // policies at once, and the id/version/decision only mean anything
        // together.
        end.insert(
            "failproofai_observed".into(),
            row.observed.clone().unwrap_or(Value::Null),
        );
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
    /// Shared by every row in the bucket — see `BucketKey`.
    pub attribution: Attribution,
}

/// The key rows are grouped under: same session, event, tool, minute — and the
/// same attribution.
///
/// Attribution is part of the key rather than a field sampled from the first
/// row because a bucket is emitted as ONE event carrying ONE set of facts. Group
/// a cloud-decided allow with an unattributed one and whichever attribution is
/// emitted is wrong for the rest, which is worse than no attribution: it moves
/// a count into a bucket someone is using to judge a rollout. Splitting instead
/// costs extra events only when a minute genuinely mixed sources.
pub type BucketKey = (String, String, Option<String>, i64, Attribution);

pub fn bucket_key(row: &HookRow) -> Option<BucketKey> {
    let session = row.session_id.clone().filter(|s| !s.is_empty())?;
    let event = row.event_type.clone().unwrap_or_else(|| "Hook".into());
    let minute = row.timestamp - row.timestamp.rem_euclid(60_000);
    Some((
        session,
        event,
        row.tool_name.clone(),
        minute,
        Attribution::of(row),
    ))
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
        // The attribution is part of the id because it is part of the KEY.
        //
        // `BucketKey` deliberately includes `Attribution`, so a minute that
        // mixes policy sources emits one aggregate per source rather than one
        // row carrying whichever attribution happened to be first. Building the
        // id from session/minute/event/tool alone gave those buckets
        // byte-identical ids — and per this file's own header, the server
        // dedups on `hook_id`, so the split was undone downstream and the two
        // rows collapsed back into one. That happened in exactly the two cases
        // the split was built for: the minute a pause starts, and the minute a
        // cloud deployment flips during a rollout, which is the measurement
        // `cloud_deployment` exists to enable.
        let a = &self.attribution;
        m.insert(
            "hook_id".into(),
            json!(format!(
                "{}:{}:{}:{}:{}:{}:{}:{}:{}:agg",
                self.session_id,
                self.minute_ms,
                self.event_name,
                self.tool_name.as_deref().unwrap_or("-"),
                a.policy_source.as_deref().unwrap_or("-"),
                a.cloud_policy_id.as_deref().unwrap_or("-"),
                a.cloud_version
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "-".into()),
                a.cloud_deployment
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "-".into()),
                if a.paused { "paused" } else { "-" },
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
        // Honest by construction: every row in this bucket was grouped BY this
        // attribution, so it describes all of them.
        self.attribution.apply(&mut m);
        Some(Value::Object(m))
    }
}

#[cfg(test)]
mod rename_compat_tests {
    use super::*;

    /// A row written before the rename keeps its cloud attribution.
    ///
    /// These pages come from a DAEMON, so a machine that was cloud-connected
    /// before the rename has real rows naming `cloudRevision`/`cloudGeneration`.
    /// There is no `deny_unknown_fields` here, so without the aliases those keys
    /// are silently ignored and every pre-upgrade cloud-decided row deserializes
    /// to `None` — rendering as unattributed, which is the one question these
    /// fields exist to answer.
    #[test]
    fn a_pre_rename_row_keeps_its_cloud_attribution() {
        let row: HookRow = serde_json::from_str(
            r#"{"timestamp":1700000000,"cloudPolicyId":"block-curl","cloudRevision":3,"cloudGeneration":9}"#,
        )
        .expect("a pre-rename hook-activity row must still deserialize");
        assert_eq!(
            row.cloud_version,
            Some(3),
            "cloudRevision must alias to cloudVersion"
        );
        assert_eq!(
            row.cloud_deployment,
            Some(9),
            "cloudGeneration must alias to cloudDeployment"
        );
    }

    /// And the current spelling is unaffected.
    #[test]
    fn the_current_spelling_still_wins() {
        let row: HookRow = serde_json::from_str(
            r#"{"timestamp":1700000000,"cloudPolicyId":"block-curl","cloudVersion":4,"cloudDeployment":11}"#,
        )
        .expect("current rows deserialize");
        assert_eq!(row.cloud_version, Some(4));
        assert_eq!(row.cloud_deployment, Some(11));
    }
}
