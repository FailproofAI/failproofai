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
    let health = std::fs::read_to_string(daemon.home.join("state/otlp-health.json")).unwrap();
    assert!(health.contains("port_busy"));
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
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
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
    assert!(request.starts_with("post /v1/traces "));
    assert!(request.contains("authorization: bearer test"));
    assert!(request.contains("content-type: application/json"));
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
        .unwrap();
    wait(|| !batch.exists());
    assert!(TcpStream::connect(("127.0.0.1", relay_port)).is_err());
    ping(&daemon);
}
