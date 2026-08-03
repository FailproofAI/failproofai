//! GitHub Copilot CLI `events.jsonl` line → AgentEye events.
//!
//! Every function here is pure in `(line, ctx, offset, state)`, which is what
//! makes a live tail and a full re-read byte-identical and therefore
//! dedup-collapsible. Nothing may consult the clock, a counter, or anything
//! outside its arguments.
//!
//! # Record shapes, verified on disk
//!
//! Read from 4 live sessions under `~/.copilot/session-state/` plus 3 captured
//! transcripts (Copilot CLI 1.0.77, 140 records total). Every line — with no
//! exceptions in that corpus — is:
//!
//! ```text
//! {type, data, id, timestamp, parentId}
//! ```
//!
//! `timestamp` is ISO-8601 UTC with **milliseconds** on every record
//! (`2026-08-03T07:56:17.824Z`; 140/140 matched, and each file was monotonic).
//! `parentId` is null exactly once per file, on the opening record. The
//! per-`type` payloads this module reads:
//!
//! ```text
//! session.start            data.context.cwd, data.copilotVersion, data.sessionId
//! session.resume           data.context.cwd, data.selectedModel
//! session.model_change     data.newModel
//! system.message           data.content  ← the ~31 KB system prompt; SKIPPED
//! user.message             data.content (raw) + data.transformedContent (wrapped)
//! assistant.message        data.{content, model, outputTokens, toolRequests[],
//!                                messageId, turnId, interactionId}
//! tool.execution_start     data.{toolCallId, toolName, arguments, model}
//! tool.execution_complete  data.{toolCallId, success, result.content, model}
//! assistant.turn_start/_end, session.shutdown, hook.start/hook.end
//! ```
//!
//! # Deliberate omissions, each for a measured reason
//!
//! * **`system.message` is skipped entirely** rather than truncated. It is the
//!   31,047-character system prompt, it is not conversation, and a resume
//!   re-emits it *verbatim* — the captured resumed session carries two copies
//!   of the identical blob. Truncating would still put ~62 KB of boilerplate on
//!   the session timeline across a couple of resumes and would still render as
//!   a message the user never sent; skipping costs nothing that is not already
//!   in the prompt/response pairs.
//! * **`assistant.message.toolRequests[]` does not become `tool_use`.** The
//!   same call is announced there AND in its own `tool.execution_start` record.
//!   Across all 7 transcripts the two sets were identical (no requested-but-
//!   unstarted call, no started-but-unrequested call), so emitting both would
//!   double every tool call in the product. `tool.execution_start` wins because
//!   it is the record that pairs with `tool.execution_complete`.
//! * **`reasoningText` / `reasoningOpaque` are dropped.** `reasoningText` is
//!   *repeated verbatim* on every later `assistant.message` of the same
//!   interaction — in the captured corpus turn 1 always carries turn 0's
//!   reasoning, byte-identical, including the opaque blob. Emitting it would
//!   attribute thinking to a turn that did not produce it.
//! * **`result.detailedContent` is dropped.** For `bash` it equals
//!   `result.content` exactly; for `view` it is a synthetic `git diff` rendering
//!   of the same bytes. Either way it doubles the payload and adds no
//!   information.
//! * **`user.message.transformedContent` is dropped in favour of `content`.**
//!   The transformed form wraps the prompt in an injected
//!   `<current_datetime>` and `<system_reminder>` — machinery, not what the
//!   human typed.
//! * **`hook.start` / `hook.end` produce nothing.** failproofai's own
//!   hook-activity source already ships those, from the store that records the
//!   *decision*; re-deriving them here would double-count every hook on the
//!   `/hooks` page. Their `input` also embeds whole tool results, so they are
//!   the largest records after the system prompt.

use serde_json::{Map, Value, json};

use crate::cursor::TailState;
use crate::filetail::Ctx;

/// Longest derived id component.
const MAX_ID_PART: usize = 48;

/// Longest `goal` excerpt kept on `agent_start`.
const MAX_GOAL_CHARS: usize = 1024;

/// Make a derived id component safe and bounded.
///
/// Kept local rather than shared with the Claude or hook sources, which each
/// hold their own copy. The three MUST agree — a hook event and a transcript
/// event for one run landing under two agent ids is the defect this scheme
/// exists to prevent — but that agreement is asserted by a test rather than by
/// a shared symbol, so no source can be refactored into breaking another.
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

/// Normalize a Copilot timestamp to the microsecond form ingest expects,
/// offset by `index` microseconds.
///
/// Copilot writes milliseconds (`…T07:56:17.824Z`); the hook source emits
/// microseconds. Both streams share one session timeline, so they must sort
/// against each other — a millisecond string and a microsecond string do not
/// compare correctly as text, and the server orders by `(ts, random id)`.
///
/// The offset keeps several events derived from ONE line in order. Index 0 is
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

fn type_of(v: &Value) -> Option<&str> {
    v.get("type")?.as_str()
}

fn str_at<'a>(data: &'a Value, key: &str) -> Option<&'a str> {
    data.get(key)?.as_str().filter(|s| !s.is_empty())
}

/// `data.context.cwd` off a `session.start` or `session.resume` payload.
fn context_cwd(data: &Value) -> Option<&str> {
    data.get("context")?.get("cwd")?.as_str()
}

/// The envelope every emitted event carries.
///
/// `copilot_line_offset` is the dedup discriminator: the server collapses
/// events by content hash, so two genuinely repeated records — the same prompt
/// asked twice, the same command run twice — must hash differently or one of
/// them disappears from the product.
fn base(ctx: &Ctx, kind: &str, ts: &str, index: usize, offset: u64) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert("timestamp".into(), json!(with_index(ts, index)?));
    m.insert("session_id".into(), json!(ctx.session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("copilot_line_offset".into(), json!(offset));
    if index > 0 {
        m.insert("copilot_block_index".into(), json!(index));
    }
    Some(m)
}

/// Build the session's `agent_start` from its header lines.
///
/// Scans for the first line carrying a usable timestamp rather than trusting
/// line 1: a session with no `agent_start` is not merely incomplete, the server
/// selects sessions on that event, so it is absent from the product entirely.
///
/// The `goal` is reachable from the header despite the enormous
/// `system.message` sitting in front of it — the first `user.message` is the
/// 4th record and the whole prefix is ~32 KB, well inside the engine's 1 MB /
/// 64-line header budget.
pub fn agent_start(header: &[String], ctx: &Ctx, offset: u64) -> Option<(Value, Option<String>)> {
    let mut first_ts: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut version: Option<String> = None;
    let mut branch: Option<String> = None;
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
        let Some(data) = v.get("data") else {
            continue;
        };
        if cwd.is_none()
            && let Some(c) = context_cwd(data)
        {
            cwd = Some(c.to_string());
        }
        if version.is_none()
            && let Some(x) = str_at(data, "copilotVersion")
        {
            version = Some(x.to_string());
        }
        // Present only when the session's cwd is inside a repository. The
        // captured corpus has none — the probe ran in a non-git `/tmp` dir —
        // but `lib/copilot-sessions.ts` records `context.{gitRoot, branch, …}`
        // as verified against Copilot 1.0.39, so it is taken opportunistically
        // rather than assumed absent.
        if branch.is_none()
            && let Some(b) = data.get("context").and_then(|c| c.get("branch"))
            && let Some(b) = b.as_str().filter(|s| !s.is_empty())
        {
            branch = Some(b.to_string());
        }
        // The session's goal is its first real human prompt — `content`, not
        // `transformedContent`, which prepends injected machinery.
        if goal.is_none()
            && type_of(&v) == Some("user.message")
            && let Some(text) = str_at(data, "content")
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
        m.insert("copilot_cwd".into(), json!(c));
    }
    if let Some(b) = branch {
        m.insert("copilot_git_branch".into(), json!(b));
    }
    if let Some(v) = version {
        m.insert("copilot_version".into(), json!(v));
    }
    Some((Value::Object(m), Some(ts)))
}

/// The single `agent_end`, derived deterministically from the last timestamp
/// and the file size (used as its offset, so it is unique per session).
///
/// Index 999 puts it after every content event sharing that timestamp — the
/// server's tie-break is a random id, so without this a session can appear to
/// end before its last turn. It matters here in particular because
/// `session.shutdown` follows the final `assistant.turn_end` by ~70 ms, and a
/// crashed session has no shutdown record at all, leaving `agent_end` sharing
/// the exact timestamp of the last real event.
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
/// The `type` dispatch is an explicit allowlist rather than Claude's
/// "no timestamp means metadata" trick: every Copilot record carries a
/// timestamp, including the ones that must produce nothing, so there is no
/// free signal to lean on. Unknown types fall through to no events while still
/// returning their timestamp, so a record type a future Copilot release adds
/// costs nothing and still advances `agent_end`.
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
    let Some(data) = v.get("data") else {
        return (Some(ts), Vec::new());
    };

    let events = match type_of(&v) {
        // A user prompt names no model, and the server builds a
        // `model_request` row's summary from the model alone. Copilot writes
        // `session.model_change` BEFORE the first `user.message` in every
        // captured transcript, which is why this source needs no `seed_state`
        // — and therefore does not inherit the live-tail-vs-re-read hazard
        // documented on `Format::seed_state`.
        Some("session.model_change") => {
            remember_model(state, str_at(data, "newModel"));
            Vec::new()
        }
        // A resume re-announces the model it is resuming with, so the first
        // prompt after a resume is never modelless either.
        Some("session.resume") => {
            remember_model(state, str_at(data, "selectedModel"));
            Vec::new()
        }
        Some("user.message") => user_message(data, ctx, &ts, offset, state),
        Some("assistant.message") => assistant_message(data, ctx, &ts, offset, state),
        Some("tool.execution_start") => tool_use(data, ctx, &ts, offset, state),
        Some("tool.execution_complete") => tool_result(data, ctx, &ts, offset, state),
        _ => Vec::new(),
    };
    (Some(ts), events)
}

fn remember_model(state: &mut TailState, model: Option<&str>) {
    if let Some(m) = model {
        state.last_model = Some(m.to_string());
    }
}

/// A human prompt → `model_request`.
fn user_message(data: &Value, ctx: &Ctx, ts: &str, offset: u64, state: &TailState) -> Vec<Value> {
    let Some(text) = str_at(data, "content") else {
        return Vec::new();
    };
    let Some(mut m) = base(ctx, "model_request", ts, 0, offset) else {
        return Vec::new();
    };
    if let Some(model) = &state.last_model {
        m.insert("model".into(), json!(model));
    }
    m.insert(
        "messages".into(),
        json!([{ "role": "user", "content": text }]),
    );
    if let Some(id) = str_at(data, "interactionId") {
        m.insert("copilot_interaction_id".into(), json!(id));
    }
    vec![Value::Object(m)]
}

/// An assistant turn → exactly one `model_response`.
///
/// Emitted even when `content` is empty, which is the case for every
/// tool-calling turn. That is deliberate and load-bearing: `outputTokens`
/// appears ONLY on `assistant.message` — `tool.execution_start` carries none —
/// so skipping empty-content turns the way the Claude source skips empty text
/// blocks would silently drop most of a session's output tokens. Measured on
/// the captured corpus: 209 of 320 tokens in one session, 188 of 304 in
/// another. The `content` key is omitted rather than set to `""`, so a
/// consumer can tell "the model said nothing, it called tools" from "the model
/// said the empty string".
fn assistant_message(
    data: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    let model = str_at(data, "model");
    remember_model(state, model);

    let Some(mut m) = base(ctx, "model_response", ts, 0, offset) else {
        return Vec::new();
    };
    m.insert("role".into(), json!("assistant"));
    if let Some(text) = str_at(data, "content") {
        m.insert("content".into(), json!(text));
    }
    if let Some(model) = model {
        m.insert("model".into(), json!(model));
    }
    if let Some(n) = data.get("outputTokens").and_then(|x| x.as_u64()) {
        m.insert("output_tokens".into(), json!(n));
    }
    if let Some(id) = str_at(data, "messageId") {
        m.insert("copilot_message_id".into(), json!(id));
    }
    if let Some(id) = str_at(data, "turnId") {
        m.insert("copilot_turn_id".into(), json!(id));
    }
    if let Some(id) = str_at(data, "interactionId") {
        m.insert("copilot_interaction_id".into(), json!(id));
    }
    // The count, not the calls: the calls themselves arrive as their own
    // `tool.execution_start` records. Keeping the count is what makes a
    // contentless turn legible instead of looking like a dropped response.
    let requests = data
        .get("toolRequests")
        .and_then(|r| r.as_array())
        .map(|r| r.len())
        .unwrap_or(0);
    if requests > 0 {
        m.insert("copilot_tool_request_count".into(), json!(requests));
    }
    vec![Value::Object(m)]
}

/// A tool call → `tool_use`, and the name is stashed for its result.
fn tool_use(data: &Value, ctx: &Ctx, ts: &str, offset: u64, state: &mut TailState) -> Vec<Value> {
    let Some(mut m) = base(ctx, "tool_use", ts, 0, offset) else {
        return Vec::new();
    };
    let name = str_at(data, "toolName").unwrap_or("tool");
    // Fall back to an offset-derived id so two identical parallel calls cannot
    // hash-collapse into one row, and so a result can still find nothing
    // rather than finding the wrong call.
    let id = str_at(data, "toolCallId")
        .map(str::to_string)
        .unwrap_or_else(|| format!("copilot-{offset}"));
    state.remember_tool(id.clone(), name.to_string());

    m.insert("tool_name".into(), json!(name));
    m.insert("tool_call_id".into(), json!(id));
    if let Some(args) = data.get("arguments") {
        m.insert("input".into(), args.clone());
    }
    if let Some(model) = str_at(data, "model") {
        m.insert("model".into(), json!(model));
    }
    if let Some(t) = str_at(data, "turnId") {
        m.insert("copilot_turn_id".into(), json!(t));
    }
    vec![Value::Object(m)]
}

/// A tool completion → `tool_result`, paired to its call BY ID.
///
/// Never by position. Copilot runs a turn's tool calls in parallel and writes
/// each completion when it lands, so completions arrive out of order with
/// respect to their starts — a captured session starts (`glob`, `view`) and
/// completes (`view`, `glob`), 47 ms apart. Pairing positionally would label
/// every row in that turn with the wrong tool, which is worse than labelling
/// none of them: a wrong tool name is indistinguishable from a right one.
fn tool_result(data: &Value, ctx: &Ctx, ts: &str, offset: u64, state: &TailState) -> Vec<Value> {
    let Some(mut m) = base(ctx, "tool_result", ts, 0, offset) else {
        return Vec::new();
    };
    if let Some(id) = str_at(data, "toolCallId") {
        m.insert("tool_call_id".into(), json!(id));
        // The tool's name appears on NO completion record. Without carrying it
        // from the call, every tool result is a blank row in the product.
        if let Some(name) = state.tool_name(id) {
            m.insert("tool_name".into(), json!(name));
        }
    }
    let output = data
        .get("result")
        .and_then(|r| r.get("content"))
        .map(stringify);
    if let Some(text) = &output {
        m.insert("output".into(), json!(text));
    }
    // Absent `success` is treated as success: every record in the captured
    // corpus carries it, and inventing a failure for a field a future release
    // might drop would flag healthy sessions as broken.
    if data.get("success").and_then(|s| s.as_bool()) == Some(false) {
        // The server's `is_error` is a truthiness check, so this must never be
        // an empty string — a failure with no output would otherwise render as
        // a success.
        let reason = output
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .unwrap_or("copilot tool execution failed");
        m.insert("error".into(), json!(reason));
        m.insert("error_type".into(), json!("copilot_tool_error"));
    }
    if let Some(model) = str_at(data, "model") {
        m.insert("model".into(), json!(model));
    }
    if let Some(t) = str_at(data, "turnId") {
        m.insert("copilot_turn_id".into(), json!(t));
    }
    vec![Value::Object(m)]
}

/// Render a tool result payload as text.
///
/// Copilot writes `result.content` as a string in every captured record, but
/// the field is untyped JSON — a structured payload is rendered rather than
/// dropped, so a future tool returning an object does not produce an empty row.
fn stringify(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|b| match b {
                Value::String(s) => s.clone(),
                other => other
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| other.to_string()),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
