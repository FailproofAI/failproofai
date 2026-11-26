//! Self Reports: the `report` tool an agent calls when it is stuck.
//!
//! This module owns three things every other part reads the same way:
//!
//! - the effective settings file, `$FAILPROOFAI_HOME/self-report.json`, and the
//!   tool built from it (name, description, input schema);
//! - the daemon's MCP server, Streamable HTTP on `127.0.0.1:<port>/mcp`,
//!   answering JSON (no SSE stream);
//! - the server-side fallback recording for agents whose hooks never see an
//!   MCP call: such a call is written here as a `self_report` event in the SDK
//!   spool format, so it reaches Cloud through the existing upload.
//!
//! The settings file is written by the daemon when the machine is Cloud
//! managed and by the TypeScript CLI otherwise. A missing or unparsable file
//! means the feature is off.
//!
//! The server binds loopback only and refuses any request whose `Host` or
//! `Origin` is not this port on `127.0.0.1` / `localhost`, so a web page in a
//! browser cannot reach it (DNS rebinding or a cross-origin POST). It has no
//! auth, on purpose: everything it can do is append one report.

use std::fs;
use std::io::{self, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use axum::routing::any;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::sources::hooks::transform::{self, HookRow};
use crate::supervisor::{Shutdown, TaskError};

/// The settings file under the failproofai home.
pub const SETTINGS_FILE: &str = "self-report.json";
/// Default loopback port of the MCP server.
pub const DEFAULT_PORT: u16 = 4319;
/// Overrides [`DEFAULT_PORT`]; read by the daemon at start.
pub const PORT_ENV: &str = "FAILPROOFAI_SELF_REPORT_PORT";
/// MCP server name, as registered in each agent.
pub const SERVER_NAME: &str = "failproofai";
/// The tool's name inside the MCP server.
pub const TOOL_NAME: &str = "report";
/// The one thing a call ever returns.
pub const RESULT_TEXT: &str = "Recorded.";
/// The settings file format version.
pub const SETTINGS_VERSION: u32 = 1;
/// Request body ceiling.
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// `detail` is cut to this many characters.
pub const MAX_DETAIL_CHARS: usize = 2000;
/// Limits on an org's own category list (CONTRACT §2).
pub const MAX_CATEGORIES: usize = 32;
pub const MAX_CATEGORY_NAME_CHARS: usize = 64;
pub const MAX_CATEGORY_DESCRIPTION_CHARS: usize = 500;
pub const MAX_GUIDANCE_CHARS: usize = 2000;
/// How far back a hook-activity session may be to own a fallback report.
pub const SESSION_LOOKBACK: Duration = Duration::from_secs(6 * 3600);
/// The session id a fallback report carries when no session matches.
pub const UNATTRIBUTED_SESSION: &str = "unattributed";

/// Integrations whose hooks do not see MCP calls (or not which server a call
/// is for), so the MCP server records the report itself. Mirrors
/// `SELF_REPORT_SERVER_RECORDS` in the TypeScript CLI. claude and codex are
/// recorded by their hooks and must not be here, or each of their reports
/// would arrive twice. cursor is here: the hook failproofai installs names an
/// MCP call `MCP:<tool>` with no server.
pub const SERVER_RECORDS: &[&str] = &[
    "openclaw",
    "pi",
    "devin",
    "hermes",
    "goose",
    "factory",
    "antigravity",
    "copilot",
    "opencode",
    "cursor",
];

/// MCP protocol revisions this server answers in. The first is what it offers
/// a client asking for one it does not know.
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05", "2025-11-25"];

const DESCRIPTION_HEAD: &str = "Report to FailproofAI that you are stuck. Call this only when you are blocked and cannot make progress on your own; do not call it for normal work, clarifying questions or a single error. One call per distinct problem.\nReporting does not unblock you and changes no decision: afterwards, work around the problem or tell the user what is blocking you. There is no need to mention this report to the user.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Category {
    pub name: String,
    pub description: String,
}

/// The six categories used when an org defines none of its own.
pub fn default_categories() -> Vec<Category> {
    [
        (
            "looping",
            "You keep repeating the same or circular steps without making progress.",
        ),
        (
            "cannot_do_request",
            "The user asked for something you cannot do here: a missing capability, tool or permission, or it is only possible by cheating.",
        ),
        (
            "invalid_tool_or_credential",
            "A tool, MCP server, plugin, API key or token you need is broken, invalid, expired or rejected.",
        ),
        (
            "missing_context",
            "Information or access you need is missing and you cannot get it yourself. Not for normal clarifying questions.",
        ),
        (
            "repeated_tool_failure",
            "A command or tool failed on several distinct attempts and is blocking you. A single error is not enough.",
        ),
        (
            "task_failure",
            "You genuinely tried and could not complete the task. Not for refusals or policy blocks.",
        ),
    ]
    .into_iter()
    .map(|(name, description)| Category {
        name: name.to_string(),
        description: description.to_string(),
    })
    .collect()
}

/// `^[a-z][a-z0-9_]{0,63}$`.
pub fn is_valid_category_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && name.len() <= MAX_CATEGORY_NAME_CHARS
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// An org's category list made usable: invalid entries and duplicate names
/// dropped, over-long descriptions cut, at most [`MAX_CATEGORIES`]. Falls back
/// to the defaults when nothing usable is left, because an enabled tool with
/// an empty enum could never be called.
pub fn sanitize_categories(categories: Option<&[Category]>) -> Vec<Category> {
    let mut out: Vec<Category> = Vec::new();
    for category in categories.unwrap_or_default() {
        let description = category.description.trim();
        if !is_valid_category_name(&category.name)
            || description.is_empty()
            || out.iter().any(|c| c.name == category.name)
        {
            continue;
        }
        out.push(Category {
            name: category.name.clone(),
            description: truncate_chars(description, MAX_CATEGORY_DESCRIPTION_CHARS),
        });
        if out.len() == MAX_CATEGORIES {
            break;
        }
    }
    if out.is_empty() {
        default_categories()
    } else {
        out
    }
}

/// Guidance trimmed and capped; empty becomes `None`.
pub fn sanitize_guidance(guidance: Option<&str>) -> Option<String> {
    guidance
        .map(str::trim)
        .filter(|g| !g.is_empty())
        .map(|g| truncate_chars(g, MAX_GUIDANCE_CHARS))
}

pub fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => s[..at].to_string(),
        None => s.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpEndpoint {
    pub port: u16,
    pub url: String,
}

impl McpEndpoint {
    pub fn on_port(port: u16) -> Self {
        McpEndpoint {
            port,
            url: format!("http://127.0.0.1:{port}/mcp"),
        }
    }
}

/// `self-report.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    pub version: u32,
    pub enabled: bool,
    /// `cloud` | `local`.
    pub source: String,
    pub categories: Vec<Category>,
    pub guidance: Option<String>,
    pub mcp: McpEndpoint,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

impl Settings {
    /// Equal in everything but when it was written.
    pub fn same_content(&self, other: &Settings) -> bool {
        Settings {
            updated_at: String::new(),
            ..self.clone()
        } == Settings {
            updated_at: String::new(),
            ..other.clone()
        }
    }
}

pub fn settings_path(home: &Path) -> PathBuf {
    home.join(SETTINGS_FILE)
}

/// The file, or `None` when it is missing or does not parse (both: disabled).
pub fn read_settings(path: &Path) -> Option<Settings> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Write the settings atomically (tmp + rename), mode 0644.
pub fn write_settings(path: &Path, settings: &Settings) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::fs::PermissionsExt;
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("settings path has no parent"))?;
    fs::create_dir_all(dir)?;
    let mut text = serde_json::to_string_pretty(settings).map_err(io::Error::other)?;
    text.push('\n');
    let tmp = dir.join(format!(
        ".{SETTINGS_FILE}.{}.{}.tmp",
        std::process::id(),
        next_seq()
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o644)
            .open(&tmp)?;
        // The umask may have taken bits off the mode above; readers run as
        // other users (a system daemon writes, an agent reads), so set it.
        file.set_permissions(fs::Permissions::from_mode(0o644))?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// The port from [`PORT_ENV`], else [`DEFAULT_PORT`]. A value that is not a
/// port number falls back to the default with a warning.
pub fn port_from_env() -> u16 {
    port_from(std::env::var(PORT_ENV).ok().as_deref())
}

pub fn port_from(raw: Option<&str>) -> u16 {
    match raw.map(str::trim).filter(|v| !v.is_empty()) {
        None => DEFAULT_PORT,
        Some(v) => match v.parse::<u16>() {
            Ok(port) if port > 0 => port,
            _ => {
                tracing::warn!("{PORT_ENV}={v:?} is not a port number; using {DEFAULT_PORT}");
                DEFAULT_PORT
            }
        },
    }
}

/// The tool description (identical text in every implementation).
pub fn describe(categories: &[Category], guidance: Option<&str>) -> String {
    let mut text = String::from(DESCRIPTION_HEAD);
    text.push_str("\n\nCategories:");
    for category in categories {
        text.push_str(&format!("\n- {}: {}", category.name, category.description));
    }
    if let Some(g) = guidance.filter(|g| !g.is_empty()) {
        text.push_str("\n\n");
        text.push_str(g);
    }
    text
}

pub fn input_schema(categories: &[Category]) -> Value {
    let names: Vec<&str> = categories.iter().map(|c| c.name.as_str()).collect();
    json!({
        "type": "object",
        "properties": {
            "category": {"type": "string", "enum": names},
            "detail": {"type": "string", "description": "One factual sentence: what is blocking you."}
        },
        "required": ["category", "detail"],
        "additionalProperties": false
    })
}

/// The MCP server's `instructions` (identical text in the TypeScript stdio
/// server, `selfReportInstructions`). Claude Code defers MCP tools behind tool
/// search, so the model never reads the tool description up front; a server's
/// instructions go into the system prompt.
pub fn instructions(categories: &[Category], guidance: Option<&str>) -> String {
    let names: Vec<&str> = categories.iter().map(|c| c.name.as_str()).collect();
    let mut text = format!(
        "FailproofAI records when an agent is stuck. If you get stuck ({}), call this server's \
         `report` tool once with two arguments: `category` (one of those names) and `detail` \
         (one factual sentence). It does not unblock you: continue, or tell the user what is \
         blocking you. There is no need to mention the report to the user.",
        names.join(", ")
    );
    if let Some(g) = guidance.filter(|g| !g.is_empty()) {
        text.push_str("\n\n");
        text.push_str(g);
    }
    text
}

fn effective_categories(settings: &Settings) -> Vec<Category> {
    if settings.categories.is_empty() {
        default_categories()
    } else {
        settings.categories.clone()
    }
}

/// The initialize result's `instructions`, or `None` when the feature is off.
pub fn server_instructions(settings: Option<&Settings>) -> Option<String> {
    let settings = settings.filter(|s| s.enabled)?;
    Some(instructions(
        &effective_categories(settings),
        settings.guidance.as_deref(),
    ))
}

/// The MCP tool definition, or `None` when the feature is off.
pub fn tool_definition(settings: Option<&Settings>) -> Option<Value> {
    let settings = settings.filter(|s| s.enabled)?;
    let categories = effective_categories(settings);
    Some(json!({
        "name": TOOL_NAME,
        "description": describe(&categories, settings.guidance.as_deref()),
        "inputSchema": input_schema(&categories),
    }))
}

// ── Settings cache ───────────────────────────────────────────────────────────

/// `self-report.json`, re-read only when its mtime or size changes.
struct SettingsCache {
    path: PathBuf,
    state: Mutex<Option<(SystemTime, u64, Option<Settings>)>>,
}

impl SettingsCache {
    fn new(path: PathBuf) -> Self {
        SettingsCache {
            path,
            state: Mutex::new(None),
        }
    }

    fn current(&self) -> Option<Settings> {
        let meta = fs::metadata(&self.path).ok();
        let stamp = meta.and_then(|m| Some((m.modified().ok()?, m.len())));
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some((mtime, len)) = stamp else {
            *state = None;
            return None;
        };
        if let Some((cached_mtime, cached_len, settings)) = state.as_ref()
            && *cached_mtime == mtime
            && *cached_len == len
        {
            return settings.clone();
        }
        let settings = read_settings(&self.path);
        *state = Some((mtime, len, settings.clone()));
        settings
    }
}

// ── This daemon's identity ───────────────────────────────────────────────────

/// Random per process, sent as `serverInfo.instanceId` in the MCP
/// `initialize` result and in the daemon's IPC `Pong`. The CLI points agents at
/// the HTTP endpoint only when the two agree: a socket ping and a port probe
/// can otherwise reach two different daemons (another user's, or another
/// FAILPROOFAI_HOME's whose bind won the port), and the report would then be
/// recorded and uploaded under that daemon's home and credentials.
pub fn instance_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(crate::uploader::new_request_id)
}

/// The port this process's MCP listener is bound to, 0 while none is.
static LISTENING_PORT: AtomicU32 = AtomicU32::new(0);

/// The port [`spawn`]'s listener holds right now, or `None` when it never
/// bound (a busy port) or has stopped. The daemon's `Pong` carries it.
pub fn listening() -> Option<u16> {
    match LISTENING_PORT.load(Ordering::SeqCst) {
        0 => None,
        port => u16::try_from(port).ok(),
    }
}

// ── The HTTP server ──────────────────────────────────────────────────────────

struct Server {
    home: PathBuf,
    port: u16,
    settings: SettingsCache,
}

/// Start the daemon's MCP server on its own thread and its own small runtime.
///
/// Not a collector task: the collector runs only with an ingest credential,
/// and OSS machines need this too. Not the collector's supervisor either, so it
/// never shows up in (or is cycled with) the collector's lifecycle. A busy
/// port logs one warning and the thread ends; the daemon carries on, as with
/// the OTLP relay. Stops when `shutdown` is set.
///
/// `listening` hears `true` once the port is bound (connections are accepted
/// from then on) or `false` when it could not be; the daemon waits on it to
/// run its startup `self-report sync` against a server that is really there.
pub fn spawn(
    home: PathBuf,
    port: u16,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    listening: std::sync::mpsc::Sender<bool>,
) -> Option<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("fpai-self-report".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(err) => {
                    tracing::warn!(%err, "Self Reports MCP server off: no runtime; daemon continues");
                    let _ = listening.send(false);
                    return;
                }
            };
            runtime.block_on(async move {
                let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
                let listener = match tokio::net::TcpListener::bind(address).await {
                    Ok(listener) => listener,
                    Err(err) => {
                        tracing::warn!(
                            port,
                            %err,
                            "Self Reports MCP server off: loopback port unavailable; daemon continues"
                        );
                        let _ = listening.send(false);
                        return;
                    }
                };
                tracing::info!(port, "Self Reports MCP server listening on 127.0.0.1");
                LISTENING_PORT.store(u32::from(port), Ordering::SeqCst);
                let _ = listening.send(true);
                if let Err(err) = serve(listener, home, Shutdown::from_daemon(shutdown)).await {
                    tracing::warn!(%err, "Self Reports MCP server stopped");
                }
                LISTENING_PORT.store(0, Ordering::SeqCst);
            });
        })
        .inspect_err(|err| tracing::warn!(%err, "could not start the Self Reports MCP server"))
        .ok()
}

/// Serve on an already-bound listener until shutdown. The Host/Origin checks
/// use the listener's own port.
pub async fn serve(
    listener: tokio::net::TcpListener,
    home: PathBuf,
    sd: Shutdown,
) -> Result<(), TaskError> {
    let port = listener
        .local_addr()
        .map_err(|e| TaskError(e.to_string()))?
        .port();
    let server = Arc::new(Server {
        settings: SettingsCache::new(settings_path(&home)),
        home,
        port,
    });
    let app = Router::new().route("/mcp", any(handle)).with_state(server);
    axum::serve(listener, app)
        .with_graceful_shutdown(async move { while sd.sleep(Duration::from_millis(100)).await {} })
        .await
        .map_err(|e| TaskError(e.to_string()))
}

fn status(code: StatusCode) -> Response {
    Response::builder()
        .status(code)
        .body(Body::empty())
        .unwrap()
}

fn json_response(code: StatusCode, body: &Value) -> Response {
    Response::builder()
        .status(code)
        .header("Content-Type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// `Host` must be this port on a loopback name; `Origin`, when sent, too.
fn allowed(headers: &HeaderMap, port: u16) -> bool {
    let hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    let host_ok = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|h| hosts.iter().any(|ok| h.eq_ignore_ascii_case(ok)));
    if !host_ok {
        return false;
    }
    match headers.get("origin") {
        None => true,
        Some(origin) => origin.to_str().ok().is_some_and(|o| {
            hosts
                .iter()
                .any(|ok| o.eq_ignore_ascii_case(&format!("http://{ok}")))
        }),
    }
}

/// `?agent=` and `?cwd=` from the request URI.
#[derive(Debug, Default, Clone)]
struct Caller {
    agent: Option<String>,
    cwd: Option<String>,
}

impl Caller {
    fn from_query(query: Option<&str>) -> Self {
        let mut caller = Caller::default();
        for pair in query.unwrap_or_default().split('&') {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            let value = percent_decode(value);
            if value.is_empty() {
                continue;
            }
            match key {
                "agent" => caller.agent = Some(value),
                "cwd" => caller.cwd = Some(value),
                _ => {}
            }
        }
        caller
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn handle(State(server): State<Arc<Server>>, request: Request) -> Response {
    if !allowed(request.headers(), server.port) {
        return status(StatusCode::FORBIDDEN);
    }
    if request.method() != Method::POST {
        // No SSE stream and no session to delete.
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header("Allow", "POST")
            .body(Body::empty())
            .unwrap();
    }
    let caller = Caller::from_query(request.uri().query());
    let Ok(body) = to_bytes(request.into_body(), MAX_BODY_BYTES).await else {
        return status(StatusCode::PAYLOAD_TOO_LARGE);
    };
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &rpc_error(Value::Null, -32700, "Parse error"),
        );
    };
    let server2 = server.clone();
    let answer = tokio::task::spawn_blocking(move || match message {
        Value::Array(batch) if !batch.is_empty() => {
            let replies: Vec<Value> = batch
                .into_iter()
                .filter_map(|m| server2.dispatch(m, &caller))
                .collect();
            (!replies.is_empty()).then_some(Value::Array(replies))
        }
        Value::Array(_) => Some(rpc_error(Value::Null, -32600, "Invalid Request")),
        single => server2.dispatch(single, &caller),
    })
    .await;
    match answer {
        Ok(Some(reply)) => json_response(StatusCode::OK, &reply),
        // Only notifications (or responses) were sent.
        Ok(None) => status(StatusCode::ACCEPTED),
        Err(_) => status(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

impl Server {
    /// One JSON-RPC message. `None` for a notification or a client response.
    fn dispatch(&self, message: Value, caller: &Caller) -> Option<Value> {
        let Some(obj) = message.as_object() else {
            return Some(rpc_error(Value::Null, -32600, "Invalid Request"));
        };
        let method = obj.get("method").and_then(Value::as_str);
        let id = obj.get("id").cloned();
        let Some(method) = method else {
            // A response to something we never asked, or garbage.
            return id.map(|id| rpc_error(id, -32600, "Invalid Request"));
        };
        // A notification (`notifications/initialized`, `notifications/cancelled`…)
        // gets no reply.
        let id = id?;
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        Some(match method {
            "initialize" => {
                let asked = params.get("protocolVersion").and_then(Value::as_str);
                let version = asked
                    .filter(|v| PROTOCOL_VERSIONS.contains(v))
                    .unwrap_or(PROTOCOL_VERSIONS[0]);
                let mut result = json!({
                    "protocolVersion": version,
                    // listChanged is false: answers are plain JSON with no
                    // stream to push the notification on. A client sees a
                    // changed list on its next tools/list.
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {
                        "name": SERVER_NAME,
                        "version": env!("CARGO_PKG_VERSION"),
                        "instanceId": instance_id(),
                    },
                });
                if let Some(text) = server_instructions(self.settings.current().as_ref()) {
                    result["instructions"] = Value::String(text);
                }
                rpc_result(id, result)
            }
            "ping" => rpc_result(id, json!({})),
            "tools/list" => {
                let tools: Vec<Value> = tool_definition(self.settings.current().as_ref())
                    .into_iter()
                    .collect();
                rpc_result(id, json!({"tools": tools}))
            }
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str);
                if name != Some(TOOL_NAME) {
                    return Some(rpc_error(id, -32602, "Unknown tool"));
                }
                let args = params.get("arguments").cloned().unwrap_or(Value::Null);
                self.record(&args, caller);
                rpc_result(
                    id,
                    json!({"content": [{"type": "text", "text": RESULT_TEXT}], "isError": false}),
                )
            }
            _ => rpc_error(id, -32601, "Method not found"),
        })
    }

    /// The fallback recording. A failure is logged and never reaches the agent:
    /// the call's answer is `Recorded.` whatever happens here.
    ///
    /// Nothing is recorded unless the settings file says enabled right now: a
    /// client that listed the tool before it was turned off (or that never
    /// listed it) can still send a call. Read from disk, not the cache, so a
    /// disable is honoured on the very next call (as the stdio server does).
    fn record(&self, args: &Value, caller: &Caller) {
        let Some(agent) = caller
            .agent
            .as_deref()
            .filter(|a| SERVER_RECORDS.contains(a))
        else {
            return;
        };
        if !read_settings(&settings_path(&self.home)).is_some_and(|s| s.enabled) {
            return;
        }
        let report = Report::from_args(args);
        let event = fallback_event(&self.home, agent, caller.cwd.as_deref(), &report, now_ms());
        if let Err(err) = write_event_file(&self.home, &[event]) {
            tracing::warn!(%err, agent, "could not record a self report");
        }
    }
}

// ── Recording ────────────────────────────────────────────────────────────────

/// Other names a model uses for `category` when it calls the tool without
/// loading its schema. Identical in the CLI (`SELF_REPORT_ARG_ALIASES`) and
/// both SDKs; test-fixtures/self-report/arg-aliases.json holds the list.
pub const CATEGORY_ALIASES: &[&str] = &["type", "kind"];

/// Other names for `detail` (seen live: `summary` and `sentence`).
pub const DETAIL_ALIASES: &[&str] = &[
    "summary",
    "sentence",
    "message",
    "description",
    "reason",
    "text",
    "details",
];

/// A call's arguments, as recorded: an unknown category is kept as-is; a
/// missing or empty argument falls back to its first non-empty alias, else "";
/// unknown keys are ignored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub category: String,
    pub detail: String,
}

impl Report {
    pub fn from_args(args: &Value) -> Self {
        let text = |key: &str, aliases: &[&str]| {
            std::iter::once(key)
                .chain(aliases.iter().copied())
                .filter_map(|k| args.get(k).and_then(Value::as_str))
                .find(|v| !v.is_empty())
                .unwrap_or_default()
                .to_string()
        };
        Report {
            category: text("category", CATEGORY_ALIASES),
            detail: truncate_chars(&text("detail", DETAIL_ALIASES), MAX_DETAIL_CHARS),
        }
    }
}

/// How closely a hook row's cwd matches the caller's: 2 the same directory,
/// 1 an ancestor or descendant of it, 0 unrelated or unknown. Trailing slashes
/// are ignored; `/` is an ancestor of every absolute path. Same as
/// `selfReportCwdAffinity` in the CLI's stdio server.
pub fn cwd_affinity(want: &str, have: Option<&str>) -> u8 {
    let Some(have) = have.filter(|h| !h.is_empty()) else {
        return 0;
    };
    let a = want.trim_end_matches('/');
    let b = have.trim_end_matches('/');
    if a == b {
        return 2;
    }
    if a.is_empty() || b.is_empty() {
        return 1;
    }
    let under = |child: &str, parent: &str| {
        child
            .strip_prefix(parent)
            .is_some_and(|rest| rest.starts_with('/'))
    };
    u8::from(under(b, a) || under(a, b))
}

/// The session a report from `integration` belongs to, in hook activity
/// within [`SESSION_LOOKBACK`] of `now_ms`, with the cwd its row had. Most
/// specific first when `cwd` is known: the newest session in exactly that
/// directory, else in one above or below it.
///
/// Never a cross-project guess. When `cwd` is unknown (an HTTP call carries
/// only `?agent=`) or no row is related to it, the newest row is taken only if
/// every row of that integration in the window has the same cwd, i.e. there is
/// one project to choose from; otherwise `None`, and the report is
/// `unattributed`. The installer registers every agent recorded here over
/// stdio, where the CLI knows the server's real cwd; this guards a
/// hand-written or older HTTP registration.
pub fn find_session(
    home: &Path,
    integration: &str,
    cwd: Option<&str>,
    now_ms: i64,
) -> Option<(String, Option<String>)> {
    let dir = home.join("hook-activity");
    // `current.jsonl` rotates to a page every 25 rows, so the newest session
    // may be in the newest page when current was just rotated.
    let mut files = vec![dir.join("current.jsonl")];
    if let Ok(entries) = fs::read_dir(&dir) {
        let mut pages: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("page-") && n.ends_with(".jsonl"))
            })
            .collect();
        pages.sort();
        files.extend(pages.into_iter().rev().take(2));
    }
    let oldest = now_ms - SESSION_LOOKBACK.as_millis() as i64;
    let mut best: Option<(u8, i64, String, Option<String>)> = None;
    // The distinct cwds seen, to tell one project from several.
    let mut cwds: Vec<Option<String>> = Vec::new();
    for file in files {
        let Ok(text) = read_tail(&file, 1024 * 1024) else {
            continue;
        };
        for line in text.lines() {
            let Ok(row) = serde_json::from_str::<HookRow>(line.trim()) else {
                continue;
            };
            let Some(session) = row.session_id.as_deref().filter(|s| !s.is_empty()) else {
                continue;
            };
            if row.integration.as_deref() != Some(integration) || row.timestamp < oldest {
                continue;
            }
            let row_cwd = row
                .cwd
                .as_deref()
                .map(|c| c.trim_end_matches('/').to_string());
            if !cwds.contains(&row_cwd) {
                cwds.push(row_cwd);
            }
            let rank = cwd.map_or(0, |want| cwd_affinity(want, row.cwd.as_deref()));
            if best
                .as_ref()
                .is_some_and(|(r, at, _, _)| (*r, *at) >= (rank, row.timestamp))
            {
                continue;
            }
            best = Some((rank, row.timestamp, session.to_string(), row.cwd.clone()));
        }
    }
    match best {
        Some((0, ..)) if cwds.len() > 1 => None,
        Some((_, _, session, cwd)) => Some((session, cwd)),
        None => None,
    }
}

/// The last `max` bytes of a file, from the first whole line in them.
fn read_tail(path: &Path, max: u64) -> io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0
        && let Some(nl) = text.find('\n')
    {
        text.drain(..=nl);
    }
    Ok(text)
}

/// The collector's `environment` label, as the hook events carry it.
fn environment(home: &Path) -> (String, crate::config::Redact) {
    match crate::config::load(home) {
        Ok(cfg) => (cfg.settings.environment, cfg.settings.redact),
        Err(_) => {
            let defaults = crate::config::Settings::default();
            (defaults.environment, defaults.redact)
        }
    }
}

/// The `self_report` event the MCP server writes for an integration in
/// [`SERVER_RECORDS`].
pub fn fallback_event(
    home: &Path,
    integration: &str,
    cwd: Option<&str>,
    report: &Report,
    now_ms: i64,
) -> Value {
    let found = find_session(home, integration, cwd, now_ms);
    let (session_id, row_cwd) = match found {
        Some((session, row_cwd)) => (session, row_cwd),
        None => (UNATTRIBUTED_SESSION.to_string(), None),
    };
    let identity = HookRow {
        integration: Some(integration.to_string()),
        cwd: row_cwd.or_else(|| cwd.map(str::to_string)),
        ..Default::default()
    };
    let (environment, redact) = environment(home);
    let mut event = json!({
        "type": "self_report",
        "session_id": session_id,
        "agent_id": transform::agent_id(&identity),
        "timestamp": transform::to_rfc3339_micros(now_ms, 0).unwrap_or_default(),
        "environment": environment,
        "category": report.category,
        "detail": report.detail,
        "source": "mcp",
        "integration": integration,
    });
    crate::redact::scrub_value(&mut event, redact);
    event
}

static SEQ: AtomicU64 = AtomicU64::new(0);

fn next_seq() -> u64 {
    SEQ.fetch_add(1, Ordering::Relaxed)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Write one batch into `<home>/custom-agents/events/` in the SDK writer's
/// format: `event-<YYYY-MM-DDTHH-MM-SS-mmmZ>-<pid>-<seq>.jsonl`, one JSON event
/// per line, written to `.tmp` (0600, exclusive), fsynced, then renamed.
pub fn write_event_file(home: &Path, events: &[Value]) -> io::Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let dir = home.join("custom-agents").join("events");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    let now = time::OffsetDateTime::now_utc();
    const FMT: &[time::format_description::BorrowedFormatItem<'_>] = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]-[minute]-[second]-[subsecond digits:3]Z"
    );
    let stamp = now.format(FMT).map_err(io::Error::other)?;
    let stem = format!(
        "event-{stamp}-{}-self-report-{}",
        std::process::id(),
        next_seq()
    );
    let tmp = dir.join(format!("{stem}.tmp"));
    let path = dir.join(format!("{stem}.jsonl"));
    let mut content = String::new();
    for event in events {
        content.push_str(&event.to_string());
        content.push('\n');
    }
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map(|()| path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fpai-self-report-{name}-{}-{}",
            std::process::id(),
            next_seq()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn enabled(categories: Vec<Category>, guidance: Option<&str>) -> Settings {
        Settings {
            version: SETTINGS_VERSION,
            enabled: true,
            source: "local".into(),
            categories,
            guidance: guidance.map(str::to_string),
            mcp: McpEndpoint::on_port(DEFAULT_PORT),
            updated_at: "2026-11-25T10:00:00Z".into(),
        }
    }

    #[test]
    fn the_description_is_the_contract_text() {
        let cats = vec![
            Category {
                name: "a".into(),
                description: "First.".into(),
            },
            Category {
                name: "b_2".into(),
                description: "Second.".into(),
            },
        ];
        let want = format!("{DESCRIPTION_HEAD}\n\nCategories:\n- a: First.\n- b_2: Second.");
        assert_eq!(describe(&cats, None), want);
        assert_eq!(describe(&cats, Some("")), want);
        assert_eq!(
            describe(&cats, Some("Be brief.")),
            format!("{want}\n\nBe brief.")
        );
        assert!(DESCRIPTION_HEAD.starts_with("Report to FailproofAI that you are stuck."));
        assert!(DESCRIPTION_HEAD.ends_with("There is no need to mention this report to the user."));
    }

    #[test]
    fn the_schema_enumerates_the_categories() {
        let schema = input_schema(&default_categories());
        assert_eq!(
            schema["properties"]["category"]["enum"],
            json!([
                "looping",
                "cannot_do_request",
                "invalid_tool_or_credential",
                "missing_context",
                "repeated_tool_failure",
                "task_failure"
            ])
        );
        assert_eq!(schema["required"], json!(["category", "detail"]));
        assert_eq!(schema["additionalProperties"], json!(false));
    }

    #[test]
    fn no_tool_when_disabled_or_missing() {
        assert!(tool_definition(None).is_none());
        let mut s = enabled(default_categories(), None);
        s.enabled = false;
        assert!(tool_definition(Some(&s)).is_none());
        s.enabled = true;
        assert_eq!(tool_definition(Some(&s)).unwrap()["name"], "report");
    }

    #[test]
    fn category_names_follow_the_pattern() {
        assert!(is_valid_category_name("looping"));
        assert!(is_valid_category_name("a1_b"));
        assert!(is_valid_category_name(&"a".repeat(64)));
        assert!(!is_valid_category_name(&"a".repeat(65)));
        assert!(!is_valid_category_name("1abc"));
        assert!(!is_valid_category_name("Abc"));
        assert!(!is_valid_category_name("a-b"));
        assert!(!is_valid_category_name(""));
    }

    #[test]
    fn invalid_categories_are_dropped_and_none_left_means_defaults() {
        let cats = vec![
            Category {
                name: "ok".into(),
                description: "x".repeat(600),
            },
            Category {
                name: "Bad".into(),
                description: "d".into(),
            },
            Category {
                name: "ok".into(),
                description: "dup".into(),
            },
            Category {
                name: "empty".into(),
                description: "  ".into(),
            },
        ];
        let out = sanitize_categories(Some(&cats));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].description.chars().count(), 500);
        assert_eq!(sanitize_categories(Some(&[])), default_categories());
        assert_eq!(sanitize_categories(None), default_categories());
        let many: Vec<Category> = (0..40)
            .map(|i| Category {
                name: format!("c{i}"),
                description: "d".into(),
            })
            .collect();
        assert_eq!(sanitize_categories(Some(&many)).len(), MAX_CATEGORIES);
        assert_eq!(sanitize_guidance(Some("  ")), None);
        assert_eq!(
            sanitize_guidance(Some(&"g".repeat(3000)))
                .unwrap()
                .chars()
                .count(),
            2000
        );
    }

    #[test]
    fn the_port_comes_from_the_environment_value() {
        assert_eq!(port_from(None), 4319);
        assert_eq!(port_from(Some("")), 4319);
        assert_eq!(port_from(Some("5000")), 5000);
        assert_eq!(port_from(Some("0")), 4319);
        assert_eq!(port_from(Some("nope")), 4319);
        assert_eq!(port_from(Some("70000")), 4319);
    }

    #[test]
    fn settings_round_trip_with_the_contract_keys() {
        let home = temp_home("roundtrip");
        let path = settings_path(&home);
        let s = enabled(default_categories(), Some("g"));
        write_settings(&path, &s).unwrap();
        let raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["version"], 1);
        assert_eq!(raw["mcp"]["url"], "http://127.0.0.1:4319/mcp");
        assert_eq!(raw["updatedAt"], "2026-11-25T10:00:00Z");
        assert_eq!(read_settings(&path), Some(s.clone()));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        fs::write(&path, "{not json").unwrap();
        assert_eq!(read_settings(&path), None);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn the_cache_rereads_a_changed_file() {
        let home = temp_home("cache");
        let path = settings_path(&home);
        let cache = SettingsCache::new(path.clone());
        assert!(cache.current().is_none());
        write_settings(&path, &enabled(default_categories(), None)).unwrap();
        assert!(cache.current().unwrap().enabled);
        let mut off = enabled(default_categories(), None);
        off.enabled = false;
        off.guidance = Some("a longer file so the size changes too".into());
        write_settings(&path, &off).unwrap();
        assert!(!cache.current().unwrap().enabled);
        fs::remove_file(&path).unwrap();
        assert!(cache.current().is_none());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn host_and_origin_must_be_this_loopback_port() {
        let headers = |host: Option<&str>, origin: Option<&str>| {
            let mut h = HeaderMap::new();
            if let Some(v) = host {
                h.insert("host", v.parse().unwrap());
            }
            if let Some(v) = origin {
                h.insert("origin", v.parse().unwrap());
            }
            h
        };
        assert!(allowed(&headers(Some("127.0.0.1:4319"), None), 4319));
        assert!(allowed(&headers(Some("localhost:4319"), None), 4319));
        assert!(allowed(
            &headers(Some("localhost:4319"), Some("http://127.0.0.1:4319")),
            4319
        ));
        assert!(!allowed(&headers(None, None), 4319));
        assert!(!allowed(&headers(Some("127.0.0.1:4320"), None), 4319));
        assert!(!allowed(&headers(Some("evil.example:4319"), None), 4319));
        assert!(!allowed(
            &headers(Some("127.0.0.1:4319"), Some("http://evil.example")),
            4319
        ));
        assert!(!allowed(
            &headers(Some("127.0.0.1:4319"), Some("https://127.0.0.1:4319")),
            4319
        ));
        assert!(!allowed(
            &headers(Some("127.0.0.1:4319"), Some("null")),
            4319
        ));
    }

    #[test]
    fn the_query_names_the_agent_and_cwd() {
        let c = Caller::from_query(Some("agent=openclaw&cwd=%2Fhome%2Fu%2Fproj&x=1"));
        assert_eq!(c.agent.as_deref(), Some("openclaw"));
        assert_eq!(c.cwd.as_deref(), Some("/home/u/proj"));
        let c = Caller::from_query(None);
        assert!(c.agent.is_none() && c.cwd.is_none());
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
    }

    #[test]
    fn report_arguments_are_kept_as_given() {
        let r = Report::from_args(&json!({"category": "made_up", "detail": "x".repeat(3000)}));
        assert_eq!(r.category, "made_up");
        assert_eq!(r.detail.chars().count(), 2000);
        let r = Report::from_args(&json!({}));
        assert_eq!(
            r,
            Report {
                category: String::new(),
                detail: String::new()
            }
        );
    }

    #[test]
    fn the_newest_matching_session_owns_the_report() {
        let home = temp_home("session");
        let dir = home.join("hook-activity");
        fs::create_dir_all(&dir).unwrap();
        let now = 1_800_000_000_000_i64;
        let row = |at: i64, integration: &str, session: &str, cwd: &str| {
            json!({"timestamp": at, "eventType": "PreToolUse", "integration": integration,
                   "sessionId": session, "cwd": cwd, "toolName": "x", "decision": "allow"})
            .to_string()
        };
        fs::write(
            dir.join("page-1-0.jsonl"),
            format!("{}\n", row(now - 1000, "openclaw", "s-page", "/w/a")),
        )
        .unwrap();
        fs::write(
            dir.join("current.jsonl"),
            [
                row(now - 7 * 3600 * 1000, "openclaw", "s-old", "/w/a"),
                row(now - 5000, "openclaw", "s-older", "/w/b"),
                row(now - 100, "pi", "s-pi", "/w/a"),
                String::from("not json"),
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();
        // No cwd and openclaw rows in /w/a and /w/b: two projects, no guess.
        assert_eq!(find_session(&home, "openclaw", None, now), None);
        assert_eq!(
            find_session(&home, "openclaw", Some("/w/b"), now).map(|s| s.0),
            Some("s-older".to_string())
        );
        // A descendant beats a newer unrelated row; no relation at all, with
        // rows from two projects, is not a guess at either.
        assert_eq!(
            find_session(&home, "openclaw", Some("/w/b/sub"), now),
            Some(("s-older".to_string(), Some("/w/b".to_string())))
        );
        assert_eq!(
            find_session(&home, "openclaw", Some("/elsewhere"), now),
            None
        );
        assert_eq!(find_session(&home, "goose", Some("/w/a"), now), None);
        assert_eq!(find_session(&home, "goose", None, now), None);
        assert_eq!(
            find_session(&home, "openclaw", None, now + 8 * 3600 * 1000),
            None
        );

        let event = fallback_event(
            &home,
            "openclaw",
            Some("/w/a"),
            &Report {
                category: "looping".into(),
                detail: "stuck".into(),
            },
            now,
        );
        assert_eq!(event["type"], "self_report");
        assert_eq!(event["session_id"], "s-page");
        assert_eq!(event["agent_id"], "openclaw-a");
        assert_eq!(event["source"], "mcp");
        assert_eq!(event["integration"], "openclaw");
        assert_eq!(event["environment"], "local");
        assert!(event.get("tool_call_id").is_none());

        let event = fallback_event(
            &home,
            "goose",
            Some("/w/proj"),
            &Report {
                category: "c".into(),
                detail: String::new(),
            },
            now,
        );
        assert_eq!(event["session_id"], UNATTRIBUTED_SESSION);
        assert_eq!(event["agent_id"], "goose-proj");
        let _ = fs::remove_dir_all(home);
    }

    fn server_for(home: &Path) -> Server {
        Server {
            home: home.to_path_buf(),
            port: DEFAULT_PORT,
            settings: SettingsCache::new(settings_path(home)),
        }
    }

    fn event_files(home: &Path) -> usize {
        fs::read_dir(home.join("custom-agents/events"))
            .map(|d| {
                d.filter_map(Result::ok)
                    .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
                    .count()
            })
            .unwrap_or(0)
    }

    fn call_report(server: &Server, agent: &str) -> Value {
        let caller = Caller {
            agent: Some(agent.to_string()),
            cwd: None,
        };
        server
            .dispatch(
                json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                       "params": {"name": "report", "arguments": {"category": "looping", "detail": "d"}}}),
                &caller,
            )
            .unwrap()
    }

    #[test]
    fn an_http_report_is_recorded_only_while_the_settings_say_enabled() {
        let home = temp_home("http-enabled");
        let server = server_for(&home);
        let path = settings_path(&home);
        // Missing settings: answered, not recorded.
        let reply = call_report(&server, "copilot");
        assert_eq!(reply["result"]["content"][0]["text"], RESULT_TEXT);
        assert_eq!(event_files(&home), 0, "missing settings");
        // Malformed settings.
        fs::write(&path, "{not json").unwrap();
        call_report(&server, "copilot");
        assert_eq!(event_files(&home), 0, "malformed settings");
        // Disabled.
        let mut off = enabled(default_categories(), None);
        off.enabled = false;
        write_settings(&path, &off).unwrap();
        let reply = call_report(&server, "copilot");
        assert_eq!(reply["result"]["isError"], false);
        assert_eq!(event_files(&home), 0, "disabled settings");
        // Enabled: one event.
        write_settings(&path, &enabled(default_categories(), None)).unwrap();
        call_report(&server, "copilot");
        assert_eq!(event_files(&home), 1, "enabled settings");
        // Disabled again, with the cache primed by the enabled read: honoured
        // on the next call.
        assert!(server.settings.current().unwrap().enabled);
        write_settings(&path, &off).unwrap();
        call_report(&server, "copilot");
        assert_eq!(event_files(&home), 1, "disabled after enabled");
        // A hook-recorded agent is never recorded here.
        write_settings(&path, &enabled(default_categories(), None)).unwrap();
        call_report(&server, "claude");
        assert_eq!(event_files(&home), 1, "claude is recorded by its hook");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn initialize_names_this_process() {
        let home = temp_home("instance");
        let server = server_for(&home);
        let reply = server
            .dispatch(
                json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
                &Caller::default(),
            )
            .unwrap();
        let info = &reply["result"]["serverInfo"];
        assert_eq!(info["name"], SERVER_NAME);
        assert_eq!(info["instanceId"], instance_id());
        assert_eq!(instance_id().len(), 32);
        assert_eq!(instance_id(), instance_id(), "stable for the process");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn no_cwd_is_attributed_only_within_one_project() {
        let home = temp_home("one-project");
        let dir = home.join("hook-activity");
        fs::create_dir_all(&dir).unwrap();
        let now = 1_800_000_000_000_i64;
        let row = |at: i64, session: &str, cwd: &str| {
            json!({"timestamp": at, "eventType": "PreToolUse", "integration": "copilot",
                   "sessionId": session, "cwd": cwd, "toolName": "x", "decision": "allow"})
            .to_string()
        };
        // One project (two sessions in it): the newest owns the report.
        fs::write(
            dir.join("current.jsonl"),
            [
                row(now - 3000, "a-1", "/repo/a"),
                row(now - 2000, "a-2", "/repo/a/"),
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();
        assert_eq!(
            find_session(&home, "copilot", None, now),
            Some(("a-2".to_string(), Some("/repo/a/".to_string())))
        );
        // Then project B is active too: a report with no cwd is not given to
        // B's (newer) session, nor to A's.
        fs::write(
            dir.join("current.jsonl"),
            [
                row(now - 3000, "a-1", "/repo/a"),
                row(now - 1000, "b-1", "/repo/b"),
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();
        assert_eq!(find_session(&home, "copilot", None, now), None);
        let report = Report {
            category: "looping".into(),
            detail: "d".into(),
        };
        let event = fallback_event(&home, "copilot", None, &report, now);
        assert_eq!(event["session_id"], UNATTRIBUTED_SESSION);
        // A known cwd still picks its own project.
        assert_eq!(
            find_session(&home, "copilot", Some("/repo/a"), now).map(|s| s.0),
            Some("a-1".to_string())
        );
        let event = fallback_event(&home, "copilot", Some("/repo/a"), &report, now);
        assert_eq!(event["session_id"], "a-1");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn cwd_affinity_ranks_exact_then_related() {
        assert_eq!(cwd_affinity("/a/b", Some("/a/b/")), 2);
        assert_eq!(cwd_affinity("/a/b", Some("/a")), 1);
        assert_eq!(cwd_affinity("/a", Some("/a/b/c")), 1);
        assert_eq!(cwd_affinity("/a/b", Some("/a/bc")), 0);
        assert_eq!(cwd_affinity("/root", Some("/")), 1);
        assert_eq!(cwd_affinity("/a", None), 0);
        assert_eq!(cwd_affinity("/a", Some("")), 0);
    }

    #[test]
    fn a_fallback_report_takes_the_matched_rows_agent() {
        let home = temp_home("row-agent");
        let dir = home.join("hook-activity");
        fs::create_dir_all(&dir).unwrap();
        let now = 1_800_000_000_000_i64;
        fs::write(
            dir.join("current.jsonl"),
            json!({"timestamp": now - 1000, "eventType": "PreToolUse", "integration": "hermes",
                   "sessionId": "local-1", "cwd": "/root/.hermes/hermes-agent", "decision": "allow"})
            .to_string()
                + "\n",
        )
        .unwrap();
        let report = Report {
            category: "looping".into(),
            detail: "d".into(),
        };
        let event = fallback_event(&home, "hermes", Some("/root"), &report, now);
        assert_eq!(event["session_id"], "local-1");
        assert_eq!(event["agent_id"], "hermes-hermes-agent");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn event_files_use_the_sdk_writer_format() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home("writer");
        let path = write_event_file(&home, &[json!({"type": "self_report"})]).unwrap();
        let name = path.file_name().unwrap().to_str().unwrap().to_string();
        assert!(
            name.starts_with("event-") && name.ends_with(".jsonl"),
            "{name}"
        );
        // event-YYYY-MM-DDTHH-MM-SS-mmmZ-...
        assert_eq!(&name[16..17], "T");
        assert_eq!(&name[29..31], "Z-");
        assert_eq!(path.parent().unwrap(), home.join("custom-agents/events"));
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"type\":\"self_report\"}\n"
        );
        let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "tmp"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = fs::remove_dir_all(home);
    }

    // ── Shared golden files (test-fixtures/self-report/) ───────────────────
    //
    // The CLI (src/hooks/self-report*.ts) and the TypeScript SDK test against
    // the same files, so the description, schema, categories, server-recorded
    // list and event fields cannot drift between the three implementations.

    fn golden(name: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-fixtures/self-report")
            .join(name);
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    fn golden_lines(name: &str) -> Vec<String> {
        golden(name)
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn golden_description_and_schema() {
        let cats = default_categories();
        assert_eq!(describe(&cats, None), golden("description.golden.txt"));
        assert_eq!(
            describe(
                &cats,
                Some("Report a missing repository as missing_context.")
            ),
            golden("description-guidance.golden.txt")
        );
        let want: Value = serde_json::from_str(&golden("input-schema.golden.json")).unwrap();
        assert_eq!(input_schema(&cats), want);
    }

    #[test]
    fn golden_instructions() {
        let cats = default_categories();
        assert_eq!(instructions(&cats, None), golden("instructions.golden.txt"));
        assert_eq!(
            instructions(
                &cats,
                Some("Report a missing repository as missing_context.")
            ),
            golden("instructions-guidance.golden.txt")
        );
        assert!(golden("instructions.golden.txt").chars().count() < 600);
    }

    #[test]
    fn golden_arg_aliases() {
        let fixture: Value = serde_json::from_str(&golden("arg-aliases.json")).unwrap();
        assert_eq!(fixture["aliases"]["category"], json!(CATEGORY_ALIASES));
        assert_eq!(fixture["aliases"]["detail"], json!(DETAIL_ALIASES));
        let cases = fixture["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            assert_eq!(
                Report::from_args(&case["args"]),
                Report {
                    category: case["category"].as_str().unwrap().to_string(),
                    detail: case["detail"].as_str().unwrap().to_string(),
                },
                "{}",
                case["args"]
            );
        }
    }

    #[test]
    fn golden_default_categories() {
        let want: Vec<Category> = serde_json::from_str(&golden("categories.golden.json")).unwrap();
        assert_eq!(default_categories(), want);
    }

    #[test]
    fn golden_server_records() {
        let got: Vec<String> = SERVER_RECORDS.iter().map(|s| s.to_string()).collect();
        assert_eq!(got, golden_lines("server-records.golden.txt"));
        for hooked in ["claude", "codex"] {
            assert!(!SERVER_RECORDS.contains(&hooked), "{hooked}");
        }
    }

    fn golden_fields() -> (Vec<String>, Vec<String>, Vec<String>) {
        let spec: Value = serde_json::from_str(&golden("event-fields.golden.json")).unwrap();
        let list = |k: &str| -> Vec<String> {
            spec[k]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect()
        };
        (list("order"), list("optional"), list("fallbackExtras"))
    }

    fn keys(v: &Value) -> std::collections::BTreeSet<String> {
        v.as_object().unwrap().keys().cloned().collect()
    }

    #[test]
    fn golden_event_fields_fallback_writer() {
        let (order, _, extras) = golden_fields();
        let home = temp_home("golden-fallback");
        let report = Report {
            category: "looping".into(),
            detail: "Same step again.".into(),
        };
        let event = fallback_event(&home, "hermes", Some("/tmp/p"), &report, 1_764_064_800_000);
        let want: std::collections::BTreeSet<String> =
            order.iter().chain(extras.iter()).cloned().collect();
        assert_eq!(keys(&event), want);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn golden_event_fields_hook_row() {
        let (order, optional, extras) = golden_fields();
        let row: crate::sources::hooks::transform::HookRow = serde_json::from_value(json!({
            "timestamp": 1_764_064_800_000_i64,
            "sessionId": "s1",
            "integration": "claude",
            "eventType": "PreToolUse",
            "toolName": "mcp__failproofai__report",
            "decision": "allow",
            "toolCallId": "toolu_1",
            "selfReport": {"category": "looping", "detail": "again", "source": "mcp"}
        }))
        .unwrap();
        let events = crate::sources::hooks::transform::to_events(&row, 0, "local");
        let report = events
            .iter()
            .find(|e| e["type"] == "self_report")
            .expect("a self_report event");
        let want: std::collections::BTreeSet<String> = order
            .iter()
            .chain(optional.iter())
            .chain(extras.iter())
            .cloned()
            .collect();
        assert_eq!(keys(report), want);
    }
}
