//! Antigravity (agy) transcript → AgentEye events.
//!
//! Antigravity writes one plain-JSONL transcript per conversation, one *step*
//! per line, under `.../brain/<conversationId>/.system_generated/logs/
//! transcript_full.jsonl`. A step is
//! `{step_index, source, type, status, created_at, content?, tool_calls?}` and
//! its uppercase `type` drives the transform:
//!
//! ```text
//! USER_INPUT           content = user text               → model_request
//! PLANNER_RESPONSE     content = assistant text          → model_response
//!                      tool_calls = [{name, args}]        → one tool_use each
//! <TOOL> / CODE_ACTION content = the tool result string  → tool_result
//! CONVERSATION_HISTORY | CHECKPOINT                       → skipped
//! ```
//!
//! Two quirks this source has to absorb, both verified live against agy v1.1.2:
//!
//! * **`step_index` is a STRING** (`"0"`, `"1"`, …) and `created_at` has second
//!   precision (`2026-07-14T13:32:00Z`, no milliseconds). [`with_index`] still
//!   normalises the latter to the six-digit microsecond form ingest expects, so
//!   antigravity events sort against the hook source's on a shared timeline.
//! * **Tool calls carry no id.** One is synthesised as `<name>-<step_index>-<j>`
//!   and remembered, because the result step that follows carries neither an id
//!   nor a tool name — its `type` IS the uppercased tool name (`RUN_COMMAND`),
//!   so results pair back to their call by FIFO. The one measured exception is
//!   `write_to_file`, whose result arrives as `CODE_ACTION` rather than
//!   `WRITE_TO_FILE`; only `run_command`→`RUN_COMMAND` is exact. So pairing
//!   tries an exact name match first and falls back to the oldest outstanding
//!   call, which is what attaches a `CODE_ACTION` to its `write_to_file`.

use serde_json::{Map, Value, json};

use crate::cursor::TailState;
use crate::filetail::Ctx;
// Reused, not re-cloned: `sanitize_id_part` MUST agree with the hook source's
// so a hook event and this transcript's events land under one agent id (the
// Claude/codex/factory sources take the same import), and `with_index` is a
// pure timestamp normaliser that behaves identically on antigravity's
// second-precision stamps.
use crate::sources::claude::transform::{sanitize_id_part, with_index};

/// Longest session goal kept — the human's first prompt.
const MAX_GOAL_CHARS: usize = 500;

/// Step `type` values that are metadata, not turns.
const META_STEP_TYPES: [&str; 2] = ["CONVERSATION_HISTORY", "CHECKPOINT"];

/// The envelope every emitted event carries.
///
/// `antigravity_line_offset` is the dedup discriminator: two identical events
/// from different lines must hash differently. One transcript is one session, so
/// a byte offset is unique within it and stable across a re-read.
fn base(ctx: &Ctx, kind: &str, ts: &str, index: usize, offset: u64) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert("timestamp".into(), json!(with_index(ts, index)?));
    m.insert("session_id".into(), json!(ctx.session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("antigravity_line_offset".into(), json!(offset));
    if index > 0 {
        m.insert("antigravity_block_index".into(), json!(index));
    }
    Some(m)
}

/// `(type, value)` for a line, or `None` when it is not JSON with a `type`.
fn parsed(line: &str) -> Option<(String, Value)> {
    let v: Value = serde_json::from_str(line).ok()?;
    let t = v.get("type")?.as_str()?.to_string();
    Some((t, v))
}

/// The step's `created_at`, second-precision ISO on every step measured.
fn ts_of(v: &Value) -> Option<String> {
    v.get("created_at")?.as_str().map(str::to_string)
}

/// The `step_index`, a STRING on disk. Falls back to the byte offset (also
/// unique within a session) so a step missing it still synthesises a stable id.
fn step_index_of(v: &Value, offset: u64) -> String {
    match v.get("step_index") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => offset.to_string(),
    }
}

/// Best-effort cwd from a single step: the first tool call carrying a
/// `Cwd`/`cwd` arg (`run_command` records it).
fn cwd_from_step(v: &Value) -> Option<String> {
    let calls = v.get("tool_calls")?.as_array()?;
    for call in calls {
        let Some(args) = call.get("args") else {
            continue;
        };
        for key in ["Cwd", "cwd"] {
            if let Some(c) = args
                .get(key)
                .and_then(|c| c.as_str())
                .filter(|s| !s.is_empty())
            {
                return Some(c.to_string());
            }
        }
    }
    None
}

/// Best-effort cwd from the header: the first tool call carrying a `Cwd`/`cwd`
/// arg, scanning lines in order. Shared with the module's `agent_id_from_path`.
pub fn cwd_from_header(header: &[String]) -> Option<String> {
    header.iter().find_map(|line| {
        let v: Value = serde_json::from_str(line).ok()?;
        cwd_from_step(&v)
    })
}

/// Derive `antigravity-<project>` from an absolute cwd.
pub fn agent_id_from_cwd(cwd: &str) -> Option<String> {
    let project = sanitize_id_part(
        cwd.trim_end_matches('/')
            .rsplit('/')
            .find(|p| !p.is_empty())?,
    );
    (!project.is_empty()).then(|| format!("antigravity-{project}"))
}

/// Build the session's `agent_start` from its header.
///
/// Antigravity has no `session_meta` line, so provenance is recovered from the
/// steps themselves: the goal is the first `USER_INPUT`, the cwd is the first
/// `run_command`'s `Cwd`, and the event is anchored on the first step with a
/// parseable `created_at` — a transcript with no such step yet simply has no
/// start event, exactly like an empty live session. Returns the seed timestamp
/// (second tuple element) that primes `agent_end`.
pub fn agent_start(header: &[String], ctx: &Ctx, offset: u64) -> Option<(Value, Option<String>)> {
    let mut first_ts: Option<String> = None;
    let mut goal: Option<String> = None;
    let mut cwd: Option<String> = None;

    for line in header {
        let Some((t, v)) = parsed(line) else {
            continue;
        };
        if first_ts.is_none()
            // A timestamp the server cannot parse would seed `agent_end` with an
            // unusable value; skip such a line for anchoring.
            && let Some(ts) = ts_of(&v).filter(|ts| with_index(ts, 0).is_some())
        {
            first_ts = Some(ts);
        }
        if t == "USER_INPUT"
            && goal.is_none()
            && let Some(text) = v
                .get("content")
                .and_then(|c| c.as_str())
                .filter(|s| !s.is_empty())
        {
            goal = Some(text.chars().take(MAX_GOAL_CHARS).collect());
        }
        if cwd.is_none() {
            cwd = cwd_from_step(&v);
        }
    }

    let ts = first_ts?;
    let mut m = base(ctx, "agent_start", &ts, 0, offset)?;
    if let Some(g) = goal {
        m.insert("goal".into(), json!(g));
    }
    if let Some(c) = cwd {
        m.insert("antigravity_cwd".into(), json!(c));
    }
    Some((Value::Object(m), Some(ts)))
}

/// The single `agent_end`, at index 999 so it sorts after every content event
/// sharing its timestamp.
pub fn agent_end(ctx: &Ctx, last_ts: &str, size: u64) -> Value {
    match base(ctx, "agent_end", last_ts, 999, size) {
        Some(m) => Value::Object(m),
        None => json!({
            "timestamp": last_ts,
            "session_id": ctx.session_id,
            "agent_id": ctx.agent_id,
            "type": "agent_end",
            "environment": ctx.environment,
        }),
    }
}

/// One step to its timestamp and the events it yields.
///
/// Metadata steps (`CONVERSATION_HISTORY`, `CHECKPOINT`) carry no turn but still
/// return their timestamp, so `agent_end` reflects when the file last moved. Any
/// type that is neither a user prompt, a planner turn, nor metadata is a
/// tool-result step — its `type` is the uppercased tool name — so the match
/// falls through to `tool_result_events` rather than enumerating tool names.
pub fn transform_line(
    line: &str,
    ctx: &Ctx,
    offset: u64,
    state: &mut TailState,
) -> (Option<String>, Vec<Value>) {
    let Some((t, v)) = parsed(line) else {
        return (None, Vec::new());
    };
    if META_STEP_TYPES.contains(&t.as_str()) {
        return (
            ts_of(&v).filter(|ts| with_index(ts, 0).is_some()),
            Vec::new(),
        );
    }
    let Some(ts) = ts_of(&v).filter(|ts| with_index(ts, 0).is_some()) else {
        return (None, Vec::new());
    };
    let events = match t.as_str() {
        "USER_INPUT" => user_input_events(&v, ctx, &ts, offset),
        "PLANNER_RESPONSE" => planner_response_events(&v, ctx, &ts, offset, state),
        // A tool-result step: its `type` is the uppercased tool name
        // (`RUN_COMMAND`), or `CODE_ACTION` for a `write_to_file` result.
        _ => tool_result_events(&t, &v, ctx, &ts, offset, state),
    };
    (Some(ts), events)
}

/// A `USER_INPUT` step: the human's prompt.
fn user_input_events(v: &Value, ctx: &Ctx, ts: &str, offset: u64) -> Vec<Value> {
    let text = v
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or_default();
    if text.is_empty() {
        return Vec::new();
    }
    let Some(mut m) = base(ctx, "model_request", ts, 0, offset) else {
        return Vec::new();
    };
    m.insert(
        "messages".into(),
        json!([{ "role": "user", "content": text }]),
    );
    vec![Value::Object(m)]
}

/// A `PLANNER_RESPONSE` step: assistant text and/or tool calls.
///
/// The text becomes a `model_response` at block index 0; each tool call becomes
/// a `tool_use` at index `j + 1`, so several events from one step keep a stable
/// order under the server's `(ts, random id)` sort. A tool call carries no id,
/// so one is synthesised and remembered for the result step to pair against.
fn planner_response_events(
    v: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    let mut out = Vec::new();

    if let Some(text) = v.get("content").and_then(|c| c.as_str())
        && !text.trim().is_empty()
        && let Some(mut m) = base(ctx, "model_response", ts, 0, offset)
    {
        m.insert("role".into(), json!("assistant"));
        m.insert("content".into(), json!(text));
        out.push(Value::Object(m));
    }

    if let Some(calls) = v.get("tool_calls").and_then(|c| c.as_array()) {
        let step = step_index_of(v, offset);
        for (j, call) in calls.iter().enumerate() {
            let Some(mut m) = base(ctx, "tool_use", ts, j + 1, offset) else {
                continue;
            };
            let name = call.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
            // No id on disk — synthesise one so the result step can pair back and
            // parallel identical calls cannot hash-collapse into one row.
            let id = format!("{name}-{step}-{j}");
            state.remember_tool(id.clone(), name.to_string());
            m.insert("tool_name".into(), json!(name));
            m.insert("tool_call_id".into(), json!(id));
            if let Some(args) = call.get("args") {
                m.insert("input".into(), args.clone());
            }
            out.push(Value::Object(m));
        }
    }
    out
}

/// A tool-result step, paired back onto the call it belongs to.
///
/// FIFO pairing: an exact name match first (`RUN_COMMAND` → the oldest pending
/// `run_command`), else the oldest outstanding call — which is what attaches a
/// `CODE_ACTION` to its `write_to_file`, whose type does NOT match its name. An
/// empty queue means there is nothing to attribute the result to, so it goes out
/// unnamed rather than being dropped.
fn tool_result_events(
    step_type: &str,
    v: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    let Some(mut m) = base(ctx, "tool_result", ts, 0, offset) else {
        return Vec::new();
    };
    let pos = state
        .pending_tools
        .iter()
        .position(|(_, name)| name.eq_ignore_ascii_case(step_type))
        .or_else(|| (!state.pending_tools.is_empty()).then_some(0));
    if let Some(i) = pos {
        let (id, name) = state.pending_tools.remove(i);
        m.insert("tool_name".into(), json!(name));
        m.insert("tool_call_id".into(), json!(id));
    }
    if let Some(content) = v.get("content") {
        m.insert("output".into(), json!(stringify(content)));
    }
    vec![Value::Object(m)]
}

/// Flatten a tool-result `content` (a string on disk, or defensively an array
/// of text blocks) to text.
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
