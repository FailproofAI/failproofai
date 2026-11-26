//! The daemon's Self Reports MCP server, driven over real HTTP on an ephemeral
//! loopback port: the JSON-RPC methods, the tool built from `self-report.json`,
//! the Host/Origin/body-size refusals and the fallback recording.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{SystemTime, UNIX_EPOCH};

use fpai_collect::self_report::{self, Category, McpEndpoint, Settings};
use fpai_collect::supervisor::Shutdown;
use serde_json::{Value, json};

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-sr-mcp-{}-{}-{}",
        name,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&d).unwrap();
    d
}

fn write_settings(home: &Path, enabled: bool, categories: Vec<Category>) {
    self_report::write_settings(
        &self_report::settings_path(home),
        &Settings {
            version: 1,
            enabled,
            source: "local".into(),
            categories,
            guidance: Some("Prefer one report.".into()),
            mcp: McpEndpoint::on_port(4319),
            updated_at: "2026-11-25T10:00:00Z".into(),
        },
    )
    .unwrap();
}

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
    client: reqwest::Client,
}

impl Running {
    async fn start(home: &Path) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let sd = Shutdown::for_test(stop.clone());
        let home = home.to_path_buf();
        let task = tokio::spawn(async move {
            self_report::serve(listener, home, sd).await.unwrap();
        });
        Running {
            port,
            stop,
            task,
            client: reqwest::Client::new(),
        }
    }

    fn url(&self, query: &str) -> String {
        format!("http://127.0.0.1:{}/mcp{query}", self.port)
    }

    async fn rpc(&self, query: &str, body: Value) -> (u16, Option<Value>) {
        let response = self
            .client
            .post(self.url(query))
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .map(|v| v.to_str().unwrap().to_string());
        let text = response.text().await.unwrap();
        if text.is_empty() {
            return (status, None);
        }
        assert_eq!(content_type.as_deref(), Some("application/json"));
        (status, Some(serde_json::from_str(&text).unwrap()))
    }

    async fn stop(self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        self.task.await.unwrap();
    }
}

async fn list(server: &Running) -> Value {
    let request = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
    server.rpc("", request).await.1.unwrap()["result"]["tools"].clone()
}

fn event_files(home: &Path) -> Vec<Value> {
    let dir = home.join("custom-agents").join("events");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        if entry.path().extension().is_some_and(|x| x == "jsonl") {
            for line in fs::read_to_string(entry.path()).unwrap().lines() {
                out.push(serde_json::from_str(line).unwrap());
            }
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn initialize_list_and_call_the_report_tool() {
    let home = tmpdir("flow");
    write_settings(&home, true, self_report::default_categories());
    let server = Running::start(&home).await;

    let (status, reply) = server
        .rpc(
            "",
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "protocolVersion":"2025-06-18","capabilities":{},
                "clientInfo":{"name":"test","version":"0"}}}),
        )
        .await;
    assert_eq!(status, 200);
    let reply = reply.unwrap();
    assert_eq!(reply["id"], 1);
    assert_eq!(reply["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(reply["result"]["serverInfo"]["name"], "failproofai");
    assert!(reply["result"]["capabilities"]["tools"].is_object());
    // The instructions Claude Code puts in the system prompt (its tools are
    // deferred behind tool search, so the description alone is never seen).
    assert_eq!(
        reply["result"]["instructions"],
        self_report::instructions(
            &self_report::default_categories(),
            Some("Prefer one report.")
        )
    );

    // An unknown revision is answered in ours.
    let (_, reply) = server
        .rpc(
            "",
            json!({"jsonrpc":"2.0","id":"x","method":"initialize","params":{"protocolVersion":"1999-01-01"}}),
        )
        .await;
    assert_eq!(reply.unwrap()["result"]["protocolVersion"], "2025-06-18");

    let (status, reply) = server
        .rpc(
            "",
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await;
    assert_eq!((status, reply), (202, None));

    let (_, reply) = server
        .rpc("", json!({"jsonrpc":"2.0","id":2,"method":"ping"}))
        .await;
    assert_eq!(reply.unwrap()["result"], json!({}));

    let (_, reply) = server
        .rpc("", json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}))
        .await;
    let tools = reply.unwrap()["result"]["tools"].clone();
    assert_eq!(tools.as_array().unwrap().len(), 1);
    let tool = &tools[0];
    assert_eq!(tool["name"], "report");
    let categories = self_report::default_categories();
    assert_eq!(
        tool["description"],
        self_report::describe(&categories, Some("Prefer one report."))
    );
    assert_eq!(tool["inputSchema"], self_report::input_schema(&categories));

    let (status, reply) = server
        .rpc(
            "",
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{
                "name":"report","arguments":{"category":"looping","detail":"same edit three times"}}}),
        )
        .await;
    assert_eq!(status, 200);
    let reply = reply.unwrap();
    assert_eq!(reply["id"], 4);
    assert_eq!(
        reply["result"]["content"],
        json!([{"type":"text","text":"Recorded."}])
    );
    // No ?agent= (or a hook-recorded agent): nothing written server-side.
    assert!(event_files(&home).is_empty());

    let (_, reply) = server
        .rpc(
            "",
            json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"other","arguments":{}}}),
        )
        .await;
    assert_eq!(reply.unwrap()["error"]["code"], -32602);
    let (_, reply) = server
        .rpc(
            "",
            json!({"jsonrpc":"2.0","id":6,"method":"resources/list"}),
        )
        .await;
    assert_eq!(reply.unwrap()["error"]["code"], -32601);

    // A batch answers each request and skips the notification.
    let (_, reply) = server
        .rpc(
            "",
            json!([{"jsonrpc":"2.0","id":7,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"}]),
        )
        .await;
    assert_eq!(reply.unwrap().as_array().unwrap().len(), 1);

    let response = server
        .client
        .post(server.url(""))
        .body("{not json")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 400);

    let response = server.client.get(server.url("")).send().await.unwrap();
    assert_eq!(response.status().as_u16(), 405);

    server.stop().await;
    fs::remove_dir_all(&home).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tool_list_follows_the_settings_file() {
    let home = tmpdir("follow");
    let server = Running::start(&home).await;
    assert_eq!(list(&server).await, json!([]), "no file: off");
    let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}});
    let instructions = |reply: Option<Value>| reply.unwrap()["result"].get("instructions").cloned();
    assert_eq!(
        instructions(server.rpc("", init.clone()).await.1),
        None,
        "no file: no instructions field"
    );

    write_settings(
        &home,
        true,
        vec![Category {
            name: "org_custom".into(),
            description: "An org's own category.".into(),
        }],
    );
    let tools = list(&server).await;
    assert_eq!(
        tools[0]["inputSchema"]["properties"]["category"]["enum"],
        json!(["org_custom"])
    );
    let text = instructions(server.rpc("", init.clone()).await.1).unwrap();
    assert!(text.as_str().unwrap().contains("(org_custom)"), "{text}");
    assert!(
        text.as_str().unwrap().ends_with("\n\nPrefer one report."),
        "{text}"
    );

    write_settings(&home, false, self_report::default_categories());
    assert_eq!(list(&server).await, json!([]), "disabled: empty list");
    assert_eq!(
        instructions(server.rpc("", init.clone()).await.1),
        None,
        "disabled: no instructions field"
    );

    fs::write(self_report::settings_path(&home), "garbage").unwrap();
    assert_eq!(list(&server).await, json!([]), "unparsable: off");

    server.stop().await;
    fs::remove_dir_all(&home).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn foreign_hosts_and_origins_are_refused() {
    let home = tmpdir("guard");
    write_settings(&home, true, self_report::default_categories());
    let server = Running::start(&home).await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"ping"}).to_string();
    let send = |host: Option<String>, origin: Option<&str>| {
        let mut request = server.client.post(server.url("")).body(body.clone());
        if let Some(h) = host {
            request = request.header("Host", h);
        }
        if let Some(o) = origin {
            request = request.header("Origin", o);
        }
        async move { request.send().await.unwrap().status().as_u16() }
    };
    let port = server.port;
    assert_eq!(send(None, None).await, 200);
    assert_eq!(send(Some(format!("localhost:{port}")), None).await, 200);
    assert_eq!(
        send(None, Some(&format!("http://localhost:{port}"))).await,
        200
    );
    assert_eq!(send(Some("evil.example".into()), None).await, 403);
    assert_eq!(send(Some(format!("evil.example:{port}")), None).await, 403);
    assert_eq!(send(None, Some("https://evil.example")).await, 403);
    assert_eq!(send(None, Some("null")).await, 403);

    // A refused GET is refused for its Host, before its method.
    let status = server
        .client
        .get(server.url(""))
        .header("Origin", "http://evil.example")
        .send()
        .await
        .unwrap()
        .status()
        .as_u16();
    assert_eq!(status, 403);

    let big = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"ping","params":{{"pad":"{}"}}}}"#,
        "x".repeat(70 * 1024)
    );
    let status = server
        .client
        .post(server.url(""))
        .body(big)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16();
    assert_eq!(status, 413);

    server.stop().await;
    fs::remove_dir_all(&home).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_recorded_agent_gets_its_report_written() {
    let home = tmpdir("record");
    write_settings(&home, true, self_report::default_categories());
    let activity = home.join("hook-activity");
    fs::create_dir_all(&activity).unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    fs::write(
        activity.join("current.jsonl"),
        json!({"timestamp": now - 1000, "eventType": "PreToolUse", "integration": "openclaw",
               "sessionId": "oc-session", "cwd": "/srv/agents/helpdesk", "decision": "allow"})
        .to_string()
            + "\n",
    )
    .unwrap();
    let server = Running::start(&home).await;
    let call = |query: &'static str, category: &'static str| {
        server.rpc(
            query,
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
                "name":"report","arguments":{"category":category,"detail":"the ticket API returns 401"}}}),
        )
    };

    // Hook-recorded agents are never written here: their hook already does.
    let (_, reply) = call("?agent=claude", "invalid_tool_or_credential").await;
    assert_eq!(reply.unwrap()["result"]["content"][0]["text"], "Recorded.");
    assert!(event_files(&home).is_empty());

    let (_, reply) = call("?agent=openclaw", "invalid_tool_or_credential").await;
    assert_eq!(reply.unwrap()["result"]["content"][0]["text"], "Recorded.");
    let events = event_files(&home);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event["type"], "self_report");
    assert_eq!(event["session_id"], "oc-session");
    assert_eq!(event["agent_id"], "openclaw-helpdesk");
    assert_eq!(event["integration"], "openclaw");
    assert_eq!(event["source"], "mcp");
    assert_eq!(event["category"], "invalid_tool_or_credential");
    assert_eq!(event["detail"], "the ticket API returns 401");
    assert_eq!(event["environment"], "local");

    // No matching session: still recorded, unattributed.
    let (_, _) = call("?agent=goose", "made_up").await;
    let events = event_files(&home);
    let goose = events
        .iter()
        .find(|e| e["integration"] == "goose")
        .expect("recorded");
    assert_eq!(goose["session_id"], "unattributed");
    assert_eq!(goose["category"], "made_up");

    // A model that guessed the argument names: the detail is kept, extras ignored.
    let (_, reply) = server
        .rpc(
            "?agent=pi",
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
                "name":"report","arguments":{"category":"looping","sentence":"same edit again","extra":1}}}),
        )
        .await;
    assert_eq!(reply.unwrap()["result"]["content"][0]["text"], "Recorded.");
    let events = event_files(&home);
    let pi = events
        .iter()
        .find(|e| e["integration"] == "pi")
        .expect("recorded");
    assert_eq!(pi["category"], "looping");
    assert_eq!(pi["detail"], "same edit again");

    server.stop().await;
    fs::remove_dir_all(&home).ok();
}

#[test]
fn spawn_reports_whether_it_is_listening() {
    let home = tmpdir("spawn");
    let stop = Arc::new(AtomicBool::new(false));

    // Bound: `true`, and the port answers.
    let holder = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = holder.local_addr().unwrap().port();
    drop(holder);
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = self_report::spawn(home.clone(), port, stop.clone(), tx).unwrap();
    assert_eq!(
        rx.recv_timeout(std::time::Duration::from_secs(10)),
        Ok(true)
    );
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());

    // Busy port: `false`, and the daemon carries on.
    let (tx2, rx2) = std::sync::mpsc::channel();
    let busy = self_report::spawn(home.clone(), port, stop.clone(), tx2).unwrap();
    assert_eq!(
        rx2.recv_timeout(std::time::Duration::from_secs(10)),
        Ok(false)
    );
    busy.join().unwrap();

    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    handle.join().unwrap();
    fs::remove_dir_all(&home).ok();
}
