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

use serde::{Deserialize, Deserializer};
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
    /// `builtin` | `custom` | `convention` | `cloud` | `pack`. Absent on rows
    /// written before attribution existed, which is meaningful — see the note in
    /// `hook-activity-store.ts` about not guessing a bucket.
    ///
    /// Deliberately `Option<String>` and forwarded verbatim rather than a typed
    /// enum: this side has no opinion about the value, so adding a source on the
    /// TypeScript side needs no coordinated release here. The doc comment is the
    /// only thing that goes stale, which is the trade taken on purpose.
    #[serde(rename = "policySource")]
    pub policy_source: Option<String>,
    #[serde(rename = "cloudPolicyId")]
    pub cloud_policy_id: Option<String>,
    #[serde(rename = "packId")]
    pub pack_id: Option<String>,
    #[serde(rename = "packVersion")]
    pub pack_version: Option<String>,
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

    // ---- Jev (two-tier evaluator) ----------------------------------------
    // Present only when the machine has a Jev (BYOK) config and the event was
    // a gate. Read leniently: a field of the wrong type becomes `None` instead
    // of failing the row, because a row that fails to deserialize never
    // reaches the dashboard at all, and these fields are the least important
    // thing on it. Every value is re-validated in [`JevFacts::of`] before it
    // is emitted.
    /// `jev` | `jev-fallback`.
    #[serde(default, deserialize_with = "lenient")]
    pub evaluator: Option<String>,
    /// Jev's own verdict, before combining with the regex results.
    #[serde(rename = "jevDecision", default, deserialize_with = "lenient")]
    pub jev_decision: Option<String>,
    /// Reviewable policies whose deny/instruct Jev cleared.
    #[serde(rename = "jevCleared", default, deserialize_with = "lenient")]
    pub jev_cleared: Option<Vec<Value>>,
    #[serde(rename = "jevFallbackReason", default, deserialize_with = "lenient")]
    pub jev_fallback_reason: Option<String>,
    #[serde(rename = "jevLatencyMs", default, deserialize_with = "lenient")]
    pub jev_latency_ms: Option<f64>,
    #[serde(rename = "jevModel", default, deserialize_with = "lenient")]
    pub jev_model: Option<String>,
    /// `shadow` | `enforce`.
    #[serde(rename = "jevMode", default, deserialize_with = "lenient")]
    pub jev_mode: Option<String>,
}

/// Deserialize `T`, or `None` when the value is absent, null, or the wrong
/// shape — never an error that would drop the whole row.
fn lenient<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let v = Value::deserialize(d)?;
    Ok(serde_json::from_value(v).ok())
}

// ---- Jev field validation ----------------------------------------------------
//
// Mirrors `sanitizeJevActivity` in `src/hooks/jev-activity.ts`. The TypeScript
// store already applies it on write; this side applies it again because it
// reads whatever is on disk, including rows from another build. The rule both
// enforce is the one every shipped hook field follows: decisions, codes and
// names — never command or prompt text. `jevFallbackReason` is the field that
// could otherwise carry free text (an error message), so it is reduced to one
// of a closed list of codes ([`JEV_REASON_CODES`]) and anything else becomes
// `other`.
//
// `jevCleared` and `jevModel` are checked for shape only: a registered policy
// name (no control characters or line breaks, whitespace only under a
// registered namespace such as `custom/`) and the model-id alphabet `jev.json`
// accepts. That keeps a bare sentence, a command line or a prompt out, but a
// fragment of the right shape — a path, a file name — would pass. Those two
// fields rely on the writer supplying registered policy names and the
// provider's model id.

/// Longest fallback reason code kept verbatim.
pub const JEV_REASON_MAX_CHARS: usize = 40;
/// Most cleared-policy names carried on one event.
pub const JEV_CLEARED_MAX: usize = 64;

/// Every fallback reason code a row may carry, besides `http-NNN`. Any other
/// reason ships as `other` — even a short kebab-case word, which could be the
/// first word of the judged command. `JEV_REASON_CODES` in
/// `src/hooks/jev-activity.ts` is the same list; a test keeps the two
/// identical.
pub const JEV_REASON_CODES: &[&str] = &[
    "aborted",
    "cloudflare-error",
    "cloudflare-incomplete",
    "config",
    "error",
    "malformed",
    "model-mismatch",
    "network",
    "no-api-key",
    "no-transport",
    "other",
    "out-of-credits",
    "prepare-error",
    "rate-limited",
    "request-too-large",
    "timeout",
    "truncated",
    "unavailable",
    "upstream-error",
];

/// Lowercase kebab-case: `timeout`, `http-429`, `out-of-credits`.
fn is_reason_code(s: &str) -> bool {
    !s.is_empty()
        && s.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// Leading words that are renamed on the way in: the evaluator's free-text
/// prefixes, each mapped to its code. `prepare` is the one that differs: the
/// evaluator writes `prepare: <message>` and the combine rules cut that down to
/// a bare `prepare`; both become `prepare-error`.
const FREE_TEXT_PREFIXES: &[(&str, &str)] = &[
    ("prepare", "prepare-error"),
    ("error", "error"),
    ("timeout", "timeout"),
    ("network", "network"),
    ("malformed", "malformed"),
    ("truncated", "truncated"),
    ("rate-limited", "rate-limited"),
    ("out-of-credits", "out-of-credits"),
    ("model-mismatch", "model-mismatch"),
    ("request-too-large", "request-too-large"),
    ("config", "config"),
];

/// Whitespace exactly as JavaScript's `\s` and `String.prototype.trim` see
/// it, so the validators below apply the same rule as
/// `src/hooks/jev-activity.ts` to the same bytes. Rust's
/// `char::is_whitespace` differs in two code points: it counts U+0085 (NEL, a
/// C1 control) and not U+FEFF (the byte-order mark); JavaScript does the
/// opposite.
fn is_js_whitespace(c: char) -> bool {
    c == '\u{FEFF}' || (c.is_whitespace() && c != '\u{85}')
}

/// A fallback reason reduced to a known code, or `None` when there is none.
///
/// A known code — alone, or in front of `:` / `(` and free text — is kept
/// (renamed through [`FREE_TEXT_PREFIXES`]); anything else is `other`.
pub fn jev_reason_code(raw: &str) -> Option<String> {
    let s = raw.trim_matches(is_js_whitespace).to_lowercase();
    if s.is_empty() {
        return None;
    }
    let head_len = s
        .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
        .unwrap_or(s.len());
    let (head, rest) = s.split_at(head_len);
    let rest = rest.trim_start_matches(is_js_whitespace);
    let code_shaped = head.len() <= JEV_REASON_MAX_CHARS
        && is_reason_code(head)
        && (rest.is_empty() || rest.starts_with(':') || rest.starts_with('('));
    if code_shaped {
        let is_http = head.len() == 8
            && head.starts_with("http-")
            && head[5..].chars().all(|c| c.is_ascii_digit());
        if is_http {
            return Some(head.to_string());
        }
        let code = FREE_TEXT_PREFIXES
            .iter()
            .find(|(p, _)| *p == head)
            .map_or(head, |(_, code)| *code);
        if JEV_REASON_CODES.contains(&code) {
            return Some(code.to_string());
        }
    }
    Some("other".into())
}

/// Longest model id kept.
pub const JEV_MODEL_MAX_CHARS: usize = 200;
/// Longest cleared-policy name kept.
pub const JEV_POLICY_NAME_MAX_CHARS: usize = 200;

/// `jev-1.13.0`, `typesafe/jev-1.13-20260917`, `~typesafe/jev-latest`,
/// `@cf/typesafe/jev`: exactly what `jev.json` accepts for `model`, since the
/// recorded model must match the configured one. `MODEL_RE` in
/// `src/hooks/jev-activity.ts` is the same rule.
fn is_model_id(s: &str) -> bool {
    !s.is_empty()
        && s.chars().count() <= JEV_MODEL_MAX_CHARS
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/@~+-".contains(c))
}

/// The namespaces the handler registers a loaded hook under
/// (`${prefix}/${hook.name}`), plus the builtins' `failproofai/`. The hook's
/// own name after the prefix is whatever its author wrote, spaces included.
fn has_registered_namespace(s: &str) -> bool {
    let Some((ns, _)) = s.split_once('/') else {
        return false;
    };
    matches!(ns, "custom" | "pack" | "cloud" | "failproofai")
        || ns.strip_prefix(".failproofai-").is_some_and(|scope| {
            (1..=32).contains(&scope.len())
                && scope
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
}

/// A registered policy name: 1–200 characters, no control characters or line
/// breaks, and whitespace only under a registered namespace
/// (`custom/No secrets in logs`). A bare sentence or command line is not a
/// policy name. `isJevPolicyName` in `src/hooks/jev-activity.ts` is the same
/// rule.
fn is_policy_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars().count() <= JEV_POLICY_NAME_MAX_CHARS
        && s.chars()
            .all(|c| !c.is_control() && c != '\u{2028}' && c != '\u{2029}')
        && (!s.chars().any(is_js_whitespace) || has_registered_namespace(s))
}

/// What happened to Jev on one call. `evaluator: "jev"` alone does not say:
/// when a hard policy denies, the combine rules abort Jev and record
/// `{ evaluator: "jev", jevMode }`, and when no semantic policy applies to the
/// call they send no request and record
/// `{ evaluator: "jev", jevDecision: "allow", jevMode }`. Mirrors `jevOutcome`
/// in `src/hooks/jev-activity.ts`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum JevOutcome {
    /// Jev's answer was read and the combine rules applied it.
    #[default]
    Answered,
    /// Jev was asked and was unavailable, truncated or mismatched; the regex
    /// result stood.
    Fallback,
    /// A hard policy denied first, so Jev was aborted and never consulted.
    NotConsulted,
    /// No semantic policy applies to the call (TodoWrite, Task, …): Jev had
    /// nothing to ask and no request was sent.
    NoRequest,
}

impl JevOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Answered => "answered",
            Self::Fallback => "fallback",
            Self::NotConsulted => "not-consulted",
            Self::NoRequest => "no-request",
        }
    }

    /// True when Jev actually answered or was asked and fell back — the calls
    /// that say something about Jev.
    fn was_asked(self) -> bool {
        matches!(self, Self::Answered | Self::Fallback)
    }
}

/// The part of a row's Jev facts that rows are grouped by in an allow
/// roll-up: which engine decided, what became of Jev, in which mode, and why
/// it fell back. All are closed or bounded sets, so they cost the roll-up
/// little.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct JevKey {
    /// `jev` | `jev-fallback`.
    pub evaluator: String,
    pub outcome: JevOutcome,
    pub mode: Option<String>,
    pub fallback_reason: Option<String>,
}

/// Every validated Jev fact on one row.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JevFacts {
    pub key: JevKey,
    pub decision: Option<String>,
    pub cleared: Vec<String>,
    pub latency_ms: Option<f64>,
    pub model: Option<String>,
}

impl JevFacts {
    /// The row's Jev facts, or `None` when the row does not say which
    /// evaluator ran — Jev was not configured, or the value is not one this
    /// side knows. Nothing Jev-related is emitted for such a row.
    pub fn of(row: &HookRow) -> Option<Self> {
        let evaluator = row
            .evaluator
            .as_deref()
            .filter(|e| matches!(*e, "jev" | "jev-fallback"))?
            .to_string();
        let mode = row
            .jev_mode
            .as_deref()
            .filter(|m| matches!(*m, "shadow" | "enforce"))
            .map(str::to_string);
        let fallback_reason = row.jev_fallback_reason.as_deref().and_then(jev_reason_code);
        let decision = row
            .jev_decision
            .as_deref()
            .filter(|d| matches!(*d, "allow" | "instruct" | "deny"))
            .map(str::to_string);
        let mut cleared: Vec<String> = Vec::new();
        for name in row.jev_cleared.iter().flatten().filter_map(Value::as_str) {
            if cleared.len() >= JEV_CLEARED_MAX {
                break;
            }
            if is_policy_name(name) && !cleared.iter().any(|c| c == name) {
                cleared.push(name.to_string());
            }
        }
        let latency_ms = row
            .jev_latency_ms
            .filter(|l| l.is_finite() && *l >= 0.0)
            .map(f64::round);
        let model = row
            .jev_model
            .as_deref()
            .map(|m| m.trim_matches(is_js_whitespace))
            .filter(|m| is_model_id(m))
            .map(str::to_string);
        // Answered when the row carries anything only a request produces: a
        // cleared list (even an empty one), a latency, a model, or a deny /
        // instruct verdict (the evaluator reaches those only from answers). An
        // allow and nothing else is the no-request shape; no readable Jev
        // field at all is the not-consulted shape.
        let outcome = if evaluator == "jev-fallback" {
            JevOutcome::Fallback
        } else if row.jev_cleared.is_some()
            || latency_ms.is_some()
            || model.is_some()
            || matches!(decision.as_deref(), Some("deny" | "instruct"))
        {
            JevOutcome::Answered
        } else if decision.is_some() {
            JevOutcome::NoRequest
        } else {
            JevOutcome::NotConsulted
        };
        Some(Self {
            key: JevKey {
                evaluator,
                outcome,
                mode,
                fallback_reason,
            },
            decision,
            cleared,
            latency_ms,
            model,
        })
    }

    /// True when this row must be shipped on its own rather than rolled into
    /// an allow aggregate: Jev overruled a regex deny/instruct (a clear), or
    /// Jev's own verdict was stricter than the outcome (shadow mode, where the
    /// regex result was enforced). Either is a decision someone will want to
    /// find, and a count cannot show it.
    pub fn is_notable(&self, final_decision: &str) -> bool {
        self.key.outcome.was_asked()
            && (!self.cleared.is_empty()
                || (final_decision == "allow"
                    && matches!(self.decision.as_deref(), Some("deny" | "instruct"))))
    }

    /// Everything except the key, for an individually shipped event. Nothing
    /// for a call Jev was not consulted on or had nothing to ask about: it has
    /// no verdict, clears, latency or model to report, and must not look as if
    /// it had.
    fn apply_detail(&self, m: &mut Map<String, Value>) {
        if !self.key.outcome.was_asked() {
            return;
        }
        if let Some(d) = &self.decision {
            m.insert("jev_decision".into(), json!(d));
        }
        // An answered call carries its (possibly empty) list, so "Jev answered
        // and cleared nothing" is distinguishable from "not asked".
        if self.key.outcome == JevOutcome::Answered {
            m.insert("jev_cleared".into(), json!(self.cleared));
        }
        if let Some(l) = self.latency_ms {
            m.insert("jev_latency_ms".into(), json!(l));
        }
        if let Some(model) = &self.model {
            m.insert("jev_model".into(), json!(model));
        }
    }
}

impl JevKey {
    fn apply(&self, m: &mut Map<String, Value>) {
        // Prefixed: "evaluator" alone would read as the server's own
        // evaluation feature, which is a different thing.
        m.insert("failproofai_evaluator".into(), json!(self.evaluator));
        // Always present on a Jev row: `failproofai_evaluator: "jev"` alone
        // does not say whether Jev answered or a hard deny came first.
        m.insert("jev_outcome".into(), json!(self.outcome.as_str()));
        if let Some(mode) = &self.mode {
            m.insert("jev_mode".into(), json!(mode));
        }
        if let Some(r) = &self.fallback_reason {
            m.insert("jev_fallback_reason".into(), json!(r));
        }
    }
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
    pub pack_id: Option<String>,
    pub pack_version: Option<String>,
    pub cloud_version: Option<i64>,
    pub cloud_deployment: Option<i64>,
    pub paused: bool,
    /// Which engine decided (regex alone when `None`). Part of the key for the
    /// same reason the rest is: a bucket mixing Jev-decided and fallback allows
    /// could say neither honestly.
    pub jev: Option<JevKey>,
}

impl Attribution {
    pub fn of(row: &HookRow) -> Self {
        Self {
            policy_source: row.policy_source.clone(),
            cloud_policy_id: row.cloud_policy_id.clone(),
            pack_id: row.pack_id.clone(),
            pack_version: row.pack_version.clone(),
            cloud_version: row.cloud_version,
            cloud_deployment: row.cloud_deployment,
            paused: row.paused_by.is_some(),
            jev: JevFacts::of(row).map(|j| j.key),
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
        if let Some(id) = &self.pack_id {
            m.insert("pack_id".into(), json!(id));
        }
        if let Some(version) = &self.pack_version {
            m.insert("pack_version".into(), json!(version));
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
        if let Some(jev) = &self.jev {
            jev.apply(m);
        }
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

    /// True when the row's Jev facts must not disappear into an allow count.
    /// See [`JevFacts::is_notable`].
    pub fn has_jev_signal(&self) -> bool {
        JevFacts::of(self).is_some_and(|j| j.is_notable(self.decision_str()))
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
    // So do the rest of the Jev facts, for the same reason.
    if let Some(jev) = JevFacts::of(row) {
        jev.apply_detail(&mut end);
    }
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
    /// Jev latency over the rows that carry one: sum, count and max. Only an
    /// aggregate can show Jev's cost on the allow path, which is nearly all of
    /// it.
    pub jev_latency_total_ms: f64,
    pub jev_latency_count: u64,
    pub jev_max_latency_ms: f64,
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
        if let Some(l) = JevFacts::of(row).and_then(|j| j.latency_ms) {
            self.jev_latency_total_ms += l;
            self.jev_latency_count += 1;
            if l > self.jev_max_latency_ms {
                self.jev_max_latency_ms = l;
            }
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
        // The Jev part of the key joins the id only when present, so every
        // bucket without it keeps the exact id earlier builds produced — a
        // re-read after an upgrade must still dedup against what was shipped.
        let jev_part = a
            .jev
            .as_ref()
            .map(|j| {
                format!(
                    ":{}:{}:{}:{}",
                    j.evaluator,
                    j.outcome.as_str(),
                    j.mode.as_deref().unwrap_or("-"),
                    j.fallback_reason.as_deref().unwrap_or("-"),
                )
            })
            .unwrap_or_default();
        m.insert(
            "hook_id".into(),
            json!(format!(
                "{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}{}:agg",
                self.session_id,
                self.minute_ms,
                self.event_name,
                self.tool_name.as_deref().unwrap_or("-"),
                a.policy_source.as_deref().unwrap_or("-"),
                a.cloud_policy_id.as_deref().unwrap_or("-"),
                a.pack_id.as_deref().unwrap_or("-"),
                a.pack_version.as_deref().unwrap_or("-"),
                a.cloud_version
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "-".into()),
                a.cloud_deployment
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "-".into()),
                if a.paused { "paused" } else { "-" },
                jev_part,
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
        if self.jev_latency_count > 0 {
            m.insert(
                "jev_latency_ms".into(),
                json!(
                    (self.jev_latency_total_ms / self.jev_latency_count as f64 * 1000.0).round()
                        / 1000.0
                ),
            );
            m.insert("jev_max_latency_ms".into(), json!(self.jev_max_latency_ms));
        }
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

    #[test]
    fn pack_identity_survives_collection() {
        let row: HookRow = serde_json::from_str(
            r#"{"timestamp":1700000000,"policySource":"pack","packId":"acme/finance","packVersion":"1.2.0"}"#,
        )
        .expect("pack-attributed rows deserialize");
        let attribution = Attribution::of(&row);
        assert_eq!(attribution.pack_id.as_deref(), Some("acme/finance"));
        assert_eq!(attribution.pack_version.as_deref(), Some("1.2.0"));

        let mut output = Map::new();
        attribution.apply(&mut output);
        assert_eq!(output.get("pack_id"), Some(&json!("acme/finance")));
        assert_eq!(output.get("pack_version"), Some(&json!("1.2.0")));
    }
}
