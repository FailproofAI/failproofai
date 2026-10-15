//! A relay bind failure and live enable/disable must never share fate with the
//! daemon's enforcement socket. Real binary, loopback HTTP and Unix Ping.
use std::io::{BufRead, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
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
fn settings(home: &Path, port: u16, enabled: bool) {
    let body = serde_json::json!({
        "mode": {"kind":"cloud"}, "collector": {
            "sessions": true, "agents": {"claude":{"sessions":false},"codex":{"sessions":false}},
            "hooks": false, "otlp": {"enabled":enabled,"port":port}
        }, "telemetry":{"enabled":false}, "audit":{"auto":false}
    });
    std::fs::write(home.join("config.json"), body.to_string()).unwrap();
}
fn start(port: u16, enabled: bool) -> Daemon {
    let home = std::env::temp_dir().join(format!(
        "fpai-otlp-daemon-{}",
        fpai_collect::uploader::new_request_id()
    ));
    std::fs::create_dir_all(&home).unwrap();
    settings(&home, port, enabled);
    std::fs::write(
        home.join("credentials.json"),
        r#"{"ingest":{"url":"http://127.0.0.1:59999/v1/events","key":"test"}}"#,
    )
    .unwrap();
    spawn(home)
}
fn spawn(home: PathBuf) -> Daemon {
    let mut child = Command::new(env!("CARGO_BIN_EXE_failproofaid"))
        .env("HOME", &home)
        .env("FAILPROOFAI_HOME", &home)
        .env(
            "FAILPROOFAI_DAEMON_SOCKET",
            home.join("run/failproofaid.sock"),
        )
        .env("FAILPROOFAI_TELEMETRY_DISABLED", "1")
        .env("FAILPROOFAI_COLLECTOR_CONFIG_POLL_MS", "100")
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
fn wait(predicate: impl Fn() -> bool) {
    let start = Instant::now();
    while !predicate() {
        assert!(start.elapsed() < Duration::from_secs(20), "timed out");
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

#[test]
fn busy_port_logs_once_and_daemon_keeps_answering() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut daemon = start(port, true);
    wait(|| daemon.log.lock().unwrap().contains("OTLP relay off:"));
    ping(&daemon);
    std::thread::sleep(Duration::from_millis(500));
    assert!(daemon.child.try_wait().unwrap().is_none());
    assert_eq!(
        daemon
            .log
            .lock()
            .unwrap()
            .matches("OTLP relay off:")
            .count(),
        1
    );
    // The log line can land before the health file is written; wait for it the
    // same way, rather than reading once and racing the daemon.
    let health_file = daemon.home.join("state/otlp-health.json");
    wait(|| {
        std::fs::read_to_string(&health_file)
            .map(|health| health.contains("port_busy"))
            .unwrap_or(false)
    });
    // Both default and subagent Claude tasks must be absent.
    let log = daemon.log.lock().unwrap();
    assert!(!log.contains("source=\"claude\""));
    assert!(!log.contains("source=\"claude-subagent\""));
    assert!(!log.contains("source=\"codex\""));
}

#[test]
fn relay_starts_and_stops_on_config_reload_without_daemon_restart() {
    let reserved = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let daemon = start(port, false);
    wait(|| daemon.home.join("run/failproofaid.sock").exists());
    // The socket is bound before the collector manager snapshots its config.
    // Wait for the first deployment before testing a subsequent hand edit.
    wait(|| daemon.log.lock().unwrap().contains("collector started"));
    std::thread::sleep(Duration::from_millis(250));
    ping(&daemon);
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    settings(&daemon.home, port, true);
    wait(|| TcpStream::connect(("127.0.0.1", port)).is_ok());
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    // Generous: a loaded CI box can take seconds to answer; a hang still fails.
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.write_all(b"POST /v1/logs HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"));
    ping(&daemon);
    settings(&daemon.home, port, false);
    wait(|| TcpStream::connect(("127.0.0.1", port)).is_err());
    ping(&daemon);
}

#[test]
fn collector_health_acknowledges_only_the_config_used_by_the_replacement_tasks() {
    let daemon = start(4318, false);
    let health_path = daemon.home.join("state/collector-health.json");
    wait(|| health_path.exists());
    let config_path = daemon.home.join("config.json");
    let mut config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    config["collector"]["config_generation"] = "otel-test-generation".into();
    config["collector"]["agents"]["codex"]["sessions"] = false.into();
    config["collector"]["agents"]["codex"]["sessions_resume_after"] = 1234567890000u64.into();
    std::fs::write(&config_path, config.to_string()).unwrap();
    wait(|| {
        std::fs::read_to_string(&health_path)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .is_some_and(|health| health["config_generation"] == "otel-test-generation")
    });
    assert!(
        daemon
            .log
            .lock()
            .unwrap()
            .contains("collector configuration changed")
    );
    assert!(!daemon.log.lock().unwrap().contains("source=\"codex\""));
    ping(&daemon);
    // A second enable requires a fresh acknowledgement, not the old heartbeat.
    config["collector"]["config_generation"] = "otel-next-generation".into();
    std::fs::write(&config_path, config.to_string()).unwrap();
    wait(|| {
        std::fs::read_to_string(&health_path)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .is_some_and(|health| health["config_generation"] == "otel-next-generation")
    });
    ping(&daemon);
}

#[test]
fn sdk_spool_delivers_without_opening_a_tcp_listener() {
    let capture = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let origin_port = capture.local_addr().unwrap().port();
    let reserved = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let relay_port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let daemon = start(relay_port, false);
    std::fs::write(
        daemon.home.join("credentials.json"),
        format!(
            r#"{{"ingest":{{"url":"http://127.0.0.1:{origin_port}/v1/events","key":"test"}}}}"#
        ),
    )
    .unwrap();
    let spool = daemon.home.join("state/spool-otlp");
    std::fs::create_dir_all(&spool).unwrap();
    // Exact shared SDK format: metadata line followed by ExportTraceServiceRequest JSON.
    let batch = spool.join("otlp-sdk-contract.jsonl");
    std::fs::write(&batch, b"{\"path\":\"/v1/traces\",\"content_type\":\"application/json\",\"encoding\":null}\n{\"resourceSpans\":[]}").unwrap();
    capture.set_nonblocking(true).unwrap();
    let start = Instant::now();
    let mut stream = loop {
        if let Ok((stream, _)) = capture.accept() {
            break stream;
        }
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "SDK batch never reached capture server"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut request = vec![0; 4096];
    let read = stream.read(&mut request).unwrap();
    let request = String::from_utf8_lossy(&request[..read]).to_lowercase();
    // Cloud's OTLP base is <origin>/otel; the spool keeps the local /v1 path.
    assert!(request.starts_with("post /otel/v1/traces "));
    assert!(request.contains("authorization: bearer test"));
    assert!(request.contains("content-type: application/json"));
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
        .unwrap();
    wait(|| !batch.exists());
    assert!(TcpStream::connect(("127.0.0.1", relay_port)).is_err());
    ping(&daemon);
}

/// An org change must take the relay's undelivered queue with it: the relay
/// starts with the new key, and the old org's batches are not the new org's.
#[tokio::test(flavor = "multi_thread")]
async fn org_change_archives_the_otlp_queue_before_the_relay_delivers_with_the_new_key() {
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let home = std::env::temp_dir().join(format!(
        "fpai-otlp-org-{}",
        fpai_collect::uploader::new_request_id()
    ));
    let state = home.join("state");
    let spool = state.join("spool-otlp");
    let failed = state.join("failed/otlp");
    std::fs::create_dir_all(&spool).unwrap();
    std::fs::create_dir_all(&failed).unwrap();
    let reserved = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    settings(&home, port, false);
    // Org A was the last applied boundary and left batches undelivered.
    std::fs::write(state.join("collector-org.json"), r#"{"id":"A","since":0}"#).unwrap();
    let old = b"{\"path\":\"/v1/traces\",\"content_type\":\"application/json\",\"encoding\":null}\n{\"ORG_A_SPAN\":1}";
    std::fs::write(spool.join("otlp-org-a.jsonl"), old).unwrap();
    std::fs::write(failed.join("otlp-org-a-retry.a1.jsonl"), old).unwrap();
    std::fs::write(
        home.join("credentials.json"),
        serde_json::json!({
            "ingest": {"url": format!("{}/v1/events", server.uri()), "key": "B"},
            "org": {"id": "B", "since": 1}
        })
        .to_string(),
    )
    .unwrap();
    let daemon = spawn(home.clone());
    let archive = state.join("previous-org/A");
    wait(|| {
        archive.join("spool-otlp/otlp-org-a.jsonl").exists()
            && archive
                .join("failed-otlp/otlp-org-a-retry.a1.jsonl")
                .exists()
    });
    // A batch recorded under B is delivered, proving the relay is running...
    std::fs::write(
        spool.join("otlp-org-b.jsonl"),
        b"{\"path\":\"/v1/traces\",\"content_type\":\"application/json\",\"encoding\":null}\n{\"ORG_B_SPAN\":1}",
    )
    .unwrap();
    let start = Instant::now();
    loop {
        let received = server.received_requests().await.unwrap();
        if received
            .iter()
            .any(|r| String::from_utf8_lossy(&r.body).contains("ORG_B_SPAN"))
        {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "B's batch never arrived"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // ...and nothing of A's ever reached B's endpoint.
    for request in server.received_requests().await.unwrap() {
        assert!(!String::from_utf8_lossy(&request.body).contains("ORG_A_SPAN"));
    }
    assert_eq!(
        std::fs::read(archive.join("spool-otlp/otlp-org-a.jsonl")).unwrap(),
        old
    );
    ping(&daemon);
}
