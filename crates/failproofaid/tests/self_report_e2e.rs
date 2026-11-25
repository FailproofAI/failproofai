//! The real daemon binary serves the Self Reports MCP endpoint without any
//! ingest credential (an OSS machine), and a busy port never costs the
//! enforcement socket.
use std::io::BufRead;
use std::net::TcpListener;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fpai_ipc::{ClientMessage, PROTOCOL_VERSION, ServerMessage, read_message, write_message};

struct Daemon {
    child: Child,
    home: PathBuf,
    log: Arc<Mutex<String>>,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn spawn(port: u16) -> Daemon {
    let home = std::env::temp_dir().join(format!(
        "fpai-self-report-daemon-{}",
        fpai_collect::uploader::new_request_id()
    ));
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join("config.json"),
        r#"{"telemetry":{"enabled":false},"audit":{"auto":false}}"#,
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_failproofaid"))
        .env("HOME", &home)
        .env("FAILPROOFAI_HOME", &home)
        .env(
            "FAILPROOFAI_DAEMON_SOCKET",
            home.join("run/failproofaid.sock"),
        )
        .env("FAILPROOFAI_TELEMETRY_DISABLED", "1")
        .env("FAILPROOFAI_SELF_REPORT_PORT", port.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let log = Arc::new(Mutex::new(String::new()));
    let sink = log.clone();
    let pipe = child.stderr.take().unwrap();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(pipe).lines().map_while(Result::ok) {
            let mut log = sink.lock().unwrap();
            log.push_str(&line);
            log.push('\n');
        }
    });
    Daemon { child, home, log }
}

fn wait(what: &str, predicate: impl Fn() -> bool) {
    let start = Instant::now();
    while !predicate() {
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "timed out: {what}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn ping(daemon: &Daemon) {
    let mut stream = UnixStream::connect(daemon.home.join("run/failproofaid.sock")).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write_message(
        &mut stream,
        &ClientMessage::Ping {
            protocol_version: PROTOCOL_VERSION,
        },
    )
    .unwrap();
    let response: ServerMessage = read_message(&mut stream).unwrap();
    assert!(matches!(response, ServerMessage::Pong { .. }));
}

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn an_oss_daemon_serves_the_report_tool() {
    let port = free_port();
    let daemon = spawn(port);
    fpai_collect::self_report::write_settings(
        &daemon.home.join("self-report.json"),
        &fpai_collect::self_report::Settings {
            version: 1,
            enabled: true,
            source: "local".into(),
            categories: fpai_collect::self_report::default_categories(),
            guidance: None,
            mcp: fpai_collect::self_report::McpEndpoint::on_port(port),
            updated_at: "2026-11-25T10:00:00Z".into(),
        },
    )
    .unwrap();
    let client = reqwest::blocking::Client::new();
    let url = format!("http://127.0.0.1:{port}/mcp");
    let list = || {
        client
            .post(&url)
            .header("Content-Type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
            .send()
            .ok()
            .and_then(|r| r.json::<serde_json::Value>().ok())
    };
    wait("the MCP endpoint", || list().is_some());
    let reply = list().unwrap();
    assert_eq!(reply["result"]["tools"][0]["name"], "report");
    let call = client
        .post(&url)
        .body(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"report","arguments":{"category":"looping","detail":"d"}}}"#)
        .send()
        .unwrap()
        .json::<serde_json::Value>()
        .unwrap();
    assert_eq!(call["result"]["content"][0]["text"], "Recorded.");
    ping(&daemon);
    // OSS: the daemon never writes the settings file itself.
    let written =
        fpai_collect::self_report::read_settings(&daemon.home.join("self-report.json")).unwrap();
    assert_eq!(written.source, "local");
}

#[test]
fn a_busy_self_report_port_never_costs_the_enforcement_socket() {
    let holder = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = holder.local_addr().unwrap().port();
    let mut daemon = spawn(port);
    wait("the busy-port warning", || {
        daemon
            .log
            .lock()
            .unwrap()
            .contains("Self Reports MCP server off")
    });
    wait("the socket", || {
        daemon.home.join("run/failproofaid.sock").exists()
    });
    ping(&daemon);
    std::thread::sleep(Duration::from_millis(300));
    assert!(daemon.child.try_wait().unwrap().is_none(), "still running");
    assert_eq!(
        daemon
            .log
            .lock()
            .unwrap()
            .matches("Self Reports MCP server off")
            .count(),
        1,
        "logged once, not restarted in a loop"
    );
    drop(holder);
}
