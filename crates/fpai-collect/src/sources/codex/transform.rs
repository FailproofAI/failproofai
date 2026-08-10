//! Codex CLI rollout line → AgentEye events.
//!
//! Every function here is pure in `(line, ctx, offset, state)`, which is what
//! makes a live tail and a full re-read byte-identical and therefore
//! dedup-collapsible. Nothing may consult the clock, a counter, or anything
//! outside its arguments.
//!
//! Record shapes verified against the 6,520 lines of the 13 real rollouts under
//! `~/.codex/sessions/` on this machine (Codex CLI 0.145.0 / 0.146.0):
//!
//! ```text
//! envelope   {timestamp, type, payload}   — exactly these three keys, always
//! type       session_meta | turn_context | response_item | event_msg
//!            | world_state | compacted
//!
//! session_meta   {id, session_id, cwd, cli_version, originator, source,
//!                 git:{branch,commit_hash,repository_url}, parent_thread_id?}
//! turn_context   {model, cwd, approval_policy, sandbox_policy, …}
//! response_item  {type:"message", role, content:[{type:"input_text"
//!                   |"output_text", text}]}
//!                {type:"function_call", call_id, name, arguments:"<json>"}
//!                {type:"custom_tool_call", call_id, name, input:"<js>"}
//!                {type:"function_call_output"|"custom_tool_call_output",
//!                   call_id, output:<string | [{type,text}]>}
//!                {type:"reasoning", encrypted_content, summary:[]}
//! event_msg      {type:"token_count", info:{last_token_usage:{…}}}
//!                {type:"user_message"|"agent_message", message}
//!                {type:"task_started"|"task_complete"|"turn_aborted"
//!                   |"patch_apply_end"|"thread_settings_applied", …}
//! ```
//!
//! Two things the shape above contradicts in the format notes this was written
//! from, both confirmed by grepping every rollout on disk:
//!
//! * There is **no `exec_command_end` event** carrying `aggregated_output` and
//!   a `{secs,nanos}` duration — zero occurrences. On 0.145/0.146 a tool result
//!   is always the `*_call_output` response item.
//! * `custom_tool_call` outnumbers `function_call` **1130 to 133**, and its
//!   `input` is a JavaScript snippet rather than a JSON string. Treating only
//!   `function_call` as a tool call would miss 89% of this machine's tool use.
//!
//! # Timestamps
//!
//! Every line carries `timestamp` as `YYYY-MM-DDTHH:MM:SS.mmmZ` — millisecond
//! precision, no exceptions across 6,520 lines. [`with_index`] pads that to the
//! six-digit microsecond form ingest expects, so codex events sort correctly
//! against the hook source's events on a shared session timeline.

use serde_json::{Map, Value, json};

use crate::cursor::TailState;
use crate::filetail::Ctx;

/// Longest derived id component.
const MAX_ID_PART: usize = 48;
/// Longest session goal carried on `agent_start`.
const MAX_GOAL_CHARS: usize = 1024;

/// Make a derived id component safe and bounded.
///
/// Deliberately byte-identical to the hook source's private copy (and Claude's)
/// rather than shared: the three must agree or a hook event and the transcript
/// events for the same run land under two agent ids that look unrelated, so a
/// test asserts the agreement instead of an import enforcing it.
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

/// Normalize a rollout timestamp to the microsecond form ingest expects,
/// offset by `index` microseconds.
///
/// The offset is what keeps several events derived from ONE line in order: the
/// server sorts by `(ts, random id)`, so events sharing a timestamp come back
/// shuffled without it. Index 0 is untouched, so the primary event of a line
/// keeps the line's exact time.
///
/// Saturates within the second rather than carrying, so an offset can never
/// reorder an event past a genuinely later line.
pub fn with_index(ts: &str, index: usize) -> Option<String> {
    let body = ts.strip_suffix('Z')?;
    let (main, frac) = match body.rsplit_once('.') {
        Some((m, f)) => (m, f),
        None => (body, ""),
    };
    // Codex writes milliseconds; pad to microseconds so every event has one
    // shape and sorts against the hook source's events correctly. A longer
    // fraction (a future release could widen it) is truncated rather than
    // rejected — losing sub-microsecond precision beats dropping the line.
    let mut micros: u32 = if frac.is_empty() {
        0
    } else {
        let padded = format!("{frac:0<6}");
        padded.get(..6)?.parse().ok()?
    };
    micros = (micros + index.min(999) as u32).min(999_999);
    Some(format!("{main}.{micros:06}Z"))
}

/// The envelope every emitted event carries.
///
/// `codex_line_offset` is the dedup discriminator: two identical events from
/// different lines must hash differently, or the server collapses them. A
/// rollout file is one session, so a byte offset is unique within it by
/// construction and stable across a re-read.
fn base(ctx: &Ctx, kind: &str, ts: &str, index: usize, offset: u64) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    m.insert("timestamp".into(), json!(with_index(ts, index)?));
    m.insert("session_id".into(), json!(ctx.session_id));
    m.insert("agent_id".into(), json!(ctx.agent_id));
    m.insert("type".into(), json!(kind));
    m.insert("environment".into(), json!(ctx.environment));
    m.insert("codex_line_offset".into(), json!(offset));
    if index > 0 {
        m.insert("codex_block_index".into(), json!(index));
    }
    Some(m)
}

/// The three envelope fields, or `None` for a line that is not a rollout record.
fn envelope(line: &str) -> Option<(String, String, Value)> {
    let v: Value = serde_json::from_str(line).ok()?;
    let ts = v.get("timestamp")?.as_str()?.to_string();
    // A timestamp we cannot place on the timeline is worse than no line at all:
    // it would seed `agent_end` with a value the server cannot parse.
    with_index(&ts, 0)?;
    let kind = v.get("type")?.as_str()?.to_string();
    let payload = v.get("payload").cloned().unwrap_or(Value::Null);
    Some((ts, kind, payload))
}

fn payload_type(p: &Value) -> Option<&str> {
    p.get("type")?.as_str()
}

/// Build the session's `agent_start` from its header lines.
///
/// **Always emits an `agent_start`, never an `agent_end`.** The upstream
/// collector's codex source had a fallback path that emitted an `agent_end`
/// here while still latching the "started" flag; the server selects sessions on
/// `agent_start`, so such a session never appears in `GET /sessions` at all —
/// and because the flag was latched it could never start, and because it never
/// started it could never end either. One wrong constant made the whole session
/// invisible and unrecoverable.
///
/// The `session_meta` line is preferred because it carries the provenance, but
/// a rollout whose header is truncated or unreadable still anchors on the first
/// line with a usable timestamp rather than going uncollected.
pub fn agent_start(header: &[String], ctx: &Ctx, offset: u64) -> Option<(Value, Option<String>)> {
    let mut first_ts: Option<String> = None;
    let mut meta: Option<(String, Value)> = None;
    let mut cwd: Option<String> = None;
    let mut goal: Option<String> = None;

    for line in header {
        let Some((ts, kind, payload)) = envelope(line) else {
            continue;
        };
        if first_ts.is_none() {
            first_ts = Some(ts.clone());
        }
        match kind.as_str() {
            "session_meta" if meta.is_none() => {
                if let Some(c) = payload.get("cwd").and_then(|c| c.as_str()) {
                    cwd = Some(c.to_string());
                }
                meta = Some((ts, payload));
            }
            // `turn_context` repeats the working directory, so a rollout whose
            // `session_meta` is unreadable still files under the right project.
            "turn_context" if cwd.is_none() => {
                if let Some(c) = payload.get("cwd").and_then(|c| c.as_str()) {
                    cwd = Some(c.to_string());
                }
            }
            // The session's goal is the human's first typed prompt. Taken from
            // `event_msg.user_message` rather than the `response_item` user
            // messages around it: those also carry the injected AGENTS.md and
            // permission preamble (145 user response items vs 127 real prompts
            // on this machine), so the response-item stream would make a
            // config file the session's goal.
            "event_msg" if goal.is_none() && payload_type(&payload) == Some("user_message") => {
                if let Some(text) = payload.get("message").and_then(|m| m.as_str())
                    && !text.is_empty()
                {
                    goal = Some(text.chars().take(MAX_GOAL_CHARS).collect());
                }
            }
            _ => {}
        }
    }

    let (ts, payload) = match meta {
        Some((ts, payload)) => (ts, payload),
        None => (first_ts?, Value::Null),
    };
    let mut m = base(ctx, "agent_start", &ts, 0, offset)?;
    if let Some(g) = goal {
        m.insert("goal".into(), json!(g));
    }
    if let Some(c) = cwd {
        m.insert("codex_cwd".into(), json!(c));
    }
    if let Some(v) = payload.get("cli_version").and_then(|v| v.as_str()) {
        m.insert("codex_cli_version".into(), json!(v));
    }
    if let Some(v) = payload
        .get("git")
        .and_then(|g| g.get("branch"))
        .and_then(|b| b.as_str())
    {
        m.insert("codex_git_branch".into(), json!(v));
    }
    // A subagent or resumed thread records its parent here. Worth carrying:
    // `session_meta.session_id` is the PARENT's id on those rollouts, not this
    // file's, which is exactly why the session id comes off the filename.
    for key in ["parent_thread_id", "forked_from_id"] {
        if !m.contains_key("parent_id")
            && let Some(v) = payload.get(key).and_then(|v| v.as_str())
        {
            m.insert("parent_id".into(), json!(v));
        }
    }
    Some((Value::Object(m), Some(ts)))
}

/// The single `agent_end`, derived deterministically from the last timestamp
/// and the file size (used as its offset, so it is unique per session).
///
/// Index 999 puts it after every content event sharing that timestamp — the
/// server's tie-break is a random id, so without this a session can appear to
/// end before its last turn. Codex writes a `token_count` line in the same
/// millisecond as the tool output it bills, so ties are the normal case here,
/// not an edge one.
pub fn agent_end(ctx: &Ctx, last_ts: &str, size: u64) -> Value {
    match base(ctx, "agent_end", last_ts, 999, size) {
        Some(m) => Value::Object(m),
        // `base` only fails on an unparseable timestamp, which cannot happen
        // here: `last_ts` came from a line `envelope` already normalized.
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
/// Every branch falls through to "no events" rather than enumerating what to
/// ignore, so `world_state`, `compacted`, `thread_settings_applied` and
/// whatever the next Codex release adds cost nothing. The timestamp is still
/// returned for those lines: they are real activity, and `agent_end` should
/// reflect when the file last moved rather than when its last *interesting*
/// record was written.
pub fn transform_line(
    line: &str,
    ctx: &Ctx,
    offset: u64,
    state: &mut TailState,
) -> (Option<String>, Vec<Value>) {
    let Some((ts, kind, payload)) = envelope(line) else {
        return (None, Vec::new());
    };

    let events = match kind.as_str() {
        // Not emitted; carries the active model forward for every later event.
        // Codex writes it before the first human prompt in all 13 rollouts
        // measured, which is why this source needs no `seed_state` and so
        // avoids the live-tail-vs-re-read hazard documented on that hook.
        "turn_context" => {
            if let Some(model) = payload.get("model").and_then(|m| m.as_str()) {
                state.last_model = Some(model.to_string());
            }
            Vec::new()
        }
        "response_item" => response_item_events(&payload, ctx, &ts, offset, state),
        "event_msg" => event_msg_events(&payload, ctx, &ts, offset, state),
        // `session_meta` is the engine's `agent_start`; emitting it here too
        // would give the session two start events at the same offset.
        _ => Vec::new(),
    };
    (Some(ts), events)
}

/// A `response_item` is one item of an OpenAI Responses API turn.
///
/// Codex writes exactly one item per line — verified across all 6,520 lines —
/// so every branch here yields at most one event and the block index stays 0.
/// The plumbing for a non-zero index is still in [`base`] because the shape is
/// not guaranteed: `agent_end` uses it today, and a future Codex that batches
/// items onto one line would otherwise ship them in random order.
fn response_item_events(
    p: &Value,
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
) -> Vec<Value> {
    match payload_type(p) {
        Some("message") => message_events(p, ctx, ts, offset, state),
        Some("function_call") => tool_use(
            ctx,
            ts,
            offset,
            state,
            p,
            named(p, "tool"),
            parse_arguments(p.get("arguments")),
        ),
        Some("custom_tool_call") => tool_use(
            ctx,
            ts,
            offset,
            state,
            p,
            named(p, "tool"),
            parse_arguments(p.get("input")),
        ),
        // Responses-API item types that produce a `*_call_output` result like
        // any other tool. Not observed in the rollouts on this machine, but
        // omitting the CALL while still emitting its RESULT is precisely the
        // blank-tool-name row this source exists to avoid, so they are carried.
        Some("local_shell_call") => tool_use(
            ctx,
            ts,
            offset,
            state,
            p,
            "local_shell".into(),
            p.get("action").cloned().unwrap_or(Value::Null),
        ),
        Some("web_search_call") => tool_use(
            ctx,
            ts,
            offset,
            state,
            p,
            "web_search".into(),
            p.get("action").cloned().unwrap_or(Value::Null),
        ),
        Some("function_call_output") | Some("custom_tool_call_output") => {
            tool_result(ctx, ts, offset, state, p)
        }
        // `reasoning` carries `encrypted_content` and, in every one of the
        // 1,018 on disk, an EMPTY `summary` with no `content` — so an event
        // built from it is a blank assistant row with nothing in it.
        _ => Vec::new(),
    }
}

/// A `message` item: the conversation itself.
///
/// Assistant messages become a `model_response`, everything else (user,
/// developer) a `model_request`. Content is an array of parts of ONE message,
/// so the parts are joined rather than split into several events — the largest
/// on this machine has 52 of them, which as separate rows would bury the turn
/// it belongs to.
fn message_events(p: &Value, ctx: &Ctx, ts: &str, offset: u64, state: &TailState) -> Vec<Value> {
    let role = p.get("role").and_then(|r| r.as_str()).unwrap_or("user");
    let Some(blocks) = p.get("content").and_then(|c| c.as_array()) else {
        return Vec::new();
    };
    let texts: Vec<&str> = blocks
        .iter()
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .filter(|t| !t.is_empty())
        .collect();
    if texts.is_empty() {
        return Vec::new();
    }

    if role == "assistant" {
        let Some(mut m) = base(ctx, "model_response", ts, 0, offset) else {
            return Vec::new();
        };
        m.insert("role".into(), json!("assistant"));
        m.insert("content".into(), json!(texts.join("\n")));
        insert_model(&mut m, state);
        return vec![Value::Object(m)];
    }

    let Some(mut m) = base(ctx, "model_request", ts, 0, offset) else {
        return Vec::new();
    };
    // One entry per content part: `messages` is an array by shape, so the parts
    // survive individually without needing an event each.
    let messages: Vec<Value> = texts
        .iter()
        .map(|t| json!({ "role": role, "content": t }))
        .collect();
    m.insert("messages".into(), json!(messages));
    insert_model(&mut m, state);
    vec![Value::Object(m)]
}

/// An `event_msg` is Codex's UI-facing stream, mostly duplicating the
/// `response_item` records.
fn event_msg_events(p: &Value, ctx: &Ctx, ts: &str, offset: u64, state: &TailState) -> Vec<Value> {
    match payload_type(p) {
        // The accounting record of one model response, written on its own line
        // in the same millisecond as the item it bills. Attaching it to that
        // item would need cross-line buffering, which is exactly what breaks
        // the "one line in, same events out" invariant a re-read depends on —
        // so it becomes its own event instead.
        Some("token_count") => {
            let Some(usage) = p.get("info").and_then(|i| i.get("last_token_usage")) else {
                return Vec::new();
            };
            let Some(mut m) = base(ctx, "model_response", ts, 0, offset) else {
                return Vec::new();
            };
            if let Some(n) = usage.get("input_tokens").and_then(|x| x.as_u64()) {
                m.insert("input_tokens".into(), json!(n));
            }
            if let Some(n) = usage.get("output_tokens").and_then(|x| x.as_u64()) {
                m.insert("output_tokens".into(), json!(n));
            }
            m.insert("codex_usage".into(), usage.clone());
            m.insert("codex_kind".into(), json!("token_count"));
            insert_model(&mut m, state);
            vec![Value::Object(m)]
        }
        // `user_message` / `agent_message` restate the `response_item` message
        // lines Codex writes for the same turn — measured 127 vs 145 user and
        // 284 vs 292 assistant, i.e. the response-item stream is a superset.
        // Emitting both would double every prompt and every reply.
        //
        // `patch_apply_end` looks like a tool result but its `call_id` is an
        // internal `exec-<uuid>` that matches NO tool call on disk (checked for
        // all 130 of them), so it would render as an orphan row with no tool
        // name; the apply_patch call's own `*_call_output` already carries the
        // outcome.
        _ => Vec::new(),
    }
}

fn insert_model(m: &mut Map<String, Value>, state: &TailState) {
    if let Some(model) = &state.last_model {
        m.insert("model".into(), json!(model));
    }
}

/// A tool's name, defaulted rather than omitted — a nameless row in the product
/// is indistinguishable from a broken one.
fn named(p: &Value, fallback: &str) -> String {
    p.get("name")
        .and_then(|n| n.as_str())
        .filter(|n| !n.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

/// `call_id` is what a result quotes back; `id` is the item's own id and only
/// a fallback.
fn call_id_of(p: &Value) -> Option<String> {
    for key in ["call_id", "id"] {
        if let Some(v) = p.get(key).and_then(|v| v.as_str())
            && !v.is_empty()
        {
            return Some(v.to_string());
        }
    }
    None
}

fn tool_use(
    ctx: &Ctx,
    ts: &str,
    offset: u64,
    state: &mut TailState,
    p: &Value,
    name: String,
    input: Value,
) -> Vec<Value> {
    let Some(mut m) = base(ctx, "tool_use", ts, 0, offset) else {
        return Vec::new();
    };
    // Fall back to an offset-derived id so a call with no id cannot hash-
    // collapse into another one; a rollout line is unique by its offset.
    let id = call_id_of(p).unwrap_or_else(|| format!("codex-{offset}"));
    // The result line names no tool. Without carrying it from here, every tool
    // result is a blank row in the product.
    state.remember_tool(id.clone(), name.clone());
    m.insert("tool_name".into(), json!(name));
    m.insert("tool_call_id".into(), json!(id));
    if !input.is_null() {
        m.insert("input".into(), input);
    }
    insert_model(&mut m, state);
    vec![Value::Object(m)]
}

fn tool_result(ctx: &Ctx, ts: &str, offset: u64, state: &TailState, p: &Value) -> Vec<Value> {
    let Some(mut m) = base(ctx, "tool_result", ts, 0, offset) else {
        return Vec::new();
    };
    if let Some(id) = call_id_of(p) {
        m.insert("tool_call_id".into(), json!(id));
        // The remembered name wins over the payload's own: on disk
        // `function_call_output.name` is literally `null` and
        // `custom_tool_call_output` has no `name` key at all, so the payload is
        // only consulted in case a later Codex starts filling it in.
        let name = state
            .tool_name(&id)
            .map(str::to_string)
            .or_else(|| p.get("name").and_then(|n| n.as_str()).map(str::to_string))
            .filter(|n| !n.is_empty());
        if let Some(name) = name {
            m.insert("tool_name".into(), json!(name));
        }
    }
    if let Some(output) = p.get("output") {
        m.insert("output".into(), json!(stringify(output)));
    }
    vec![Value::Object(m)]
}

/// Render a tool result payload as text. Codex uses a bare string, or an array
/// of `{type:"input_text", text}` blocks (a wall-time preamble plus the real
/// output, in the rollouts measured).
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

/// Normalise a tool call's serialized arguments into structured JSON.
///
/// Codex serialises them as a *string*, and the two tool families disagree
/// about what is in it. Measured over every tool call on this machine:
///
/// | shape | whole-string JSON | lifted `{…}` | kept raw |
/// |---|---|---|---|
/// | `function_call.arguments` | 133 | 0 | 0 |
/// | `custom_tool_call.input`  | 0 | 989 | 141 |
///
/// So a plain `serde_json::from_str` — which is all the format notes describe —
/// recovers the arguments of 133 of 1,263 calls and leaves 89% of this
/// machine's tool use rendering as an opaque blob of JavaScript. The raw string
/// is kept when nothing parses, so no branch here can lose information.
fn parse_arguments(arg: Option<&Value>) -> Value {
    match arg {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) => {
            if let Ok(v) = serde_json::from_str::<Value>(s) {
                v
            } else if let Some(v) = lift_json_object(s) {
                v
            } else {
                json!({ "raw": s })
            }
        }
        Some(other) => other.clone(),
    }
}

/// Scan successive balanced `{…}` substrings and return the first that reads as
/// a JSON object, repairing JavaScript object-literal keys if needed.
///
/// `custom_tool_call.input` is a JS snippet like
/// `const r = await tools.exec_command({cmd:"ls","workdir":"/x"})`, so the
/// arguments are an inner brace group, and the model quotes keys inconsistently
/// *within the same object*. Trying successive groups is what handles a snippet
/// that opens with a destructuring pattern — `let{output,...rest}=await …` puts
/// the real arguments in the SECOND group.
///
/// Pure and deterministic, so a re-read reproduces the same value.
fn lift_json_object(s: &str) -> Option<Value> {
    let bytes = s.as_bytes();
    let mut search = 0usize;
    while let Some(rel) = s[search..].find('{') {
        let start = search + rel;
        let Some(end) = balanced_end(bytes, start) else {
            break; // unbalanced from here on; no later group can close either
        };
        // `start`/`end` sit on ASCII braces, so the slice is char-safe.
        let candidate = &s[start..=end];
        if let Ok(v @ Value::Object(_)) = serde_json::from_str::<Value>(candidate) {
            return Some(v);
        }
        if let Ok(v @ Value::Object(_)) = serde_json::from_str::<Value>(&quote_bare_keys(candidate))
        {
            return Some(v);
        }
        search = start + 1; // that group was not JSON — try the next one
    }
    None
}

/// Index of the `}` closing the group that opens at `start`, honouring string
/// literals and backslash escapes.
///
/// Byte-wise is safe: `{`, `}`, `"` and `\` are ASCII, and no UTF-8
/// continuation byte can equal an ASCII value.
fn balanced_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &c) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Quote bare identifier keys so a JavaScript object literal parses as JSON.
///
/// Only rewrites an identifier that is BOTH at a key position (directly after
/// `{` or `,`, whitespace aside) AND followed by `:`. That leaves values,
/// spread patterns (`{output,...rest}`) and anything inside a string literal
/// untouched — and an already-quoted key can never match, so valid JSON passes
/// through byte-identical. Callers only use the result when the unrepaired
/// candidate failed to parse, so a mangled repair costs nothing.
fn quote_bare_keys(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    let mut in_str = false;
    let mut escaped = false;
    let mut at_key = false;
    let mut chars = s.char_indices().peekable();

    while let Some((i, c)) = chars.next() {
        if in_str {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                at_key = false;
                out.push(c);
            }
            '{' | ',' => {
                at_key = true;
                out.push(c);
            }
            _ if c.is_whitespace() => out.push(c),
            _ if at_key && (c.is_ascii_alphabetic() || c == '_' || c == '$') => {
                let mut end = i + c.len_utf8();
                while let Some(&(j, d)) = chars.peek() {
                    if d.is_ascii_alphanumeric() || d == '_' || d == '$' {
                        end = j + d.len_utf8();
                        chars.next();
                    } else {
                        break;
                    }
                }
                let ident = &s[i..end];
                if s[end..].trim_start().starts_with(':') {
                    out.push('"');
                    out.push_str(ident);
                    out.push('"');
                } else {
                    out.push_str(ident);
                }
                at_key = false;
            }
            _ => {
                at_key = false;
                out.push(c);
            }
        }
    }
    out
}
