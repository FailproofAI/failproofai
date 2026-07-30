//! End-to-end tests against a real bound socket.
//!
//! These drive the daemon the way the hook client does — connect, handshake,
//! one framed request, one framed response — rather than calling `handle_*`
//! directly. That matters because most of the properties worth asserting here
//! live at the boundary rather than in the handler: peer credentials come from
//! the kernel, `home` is derived rather than received, a client-asserted `home`
//! is refused, and an oversize frame is rejected before anything is allocated.
//! A unit test that constructed an `EvaluateHook` in memory would assert none
//! of that.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use failproofaid::Daemon;

/// A daemon on a unique socket under the target dir, torn down on drop.
struct Harness {
    socket: PathBuf,
    _thread: thread::JoinHandle<()>,
}

impl Harness {
    fn start(name: &str) -> Self {
        // Under `target/` rather than /tmp: the repo's own dogfood policies
        // block reads outside the project directory, and keeping test artifacts
        // in-tree means a failed run leaves them somewhere obvious.
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join(format!("{name}.sock"));

        let daemon = Daemon::bind(&socket).expect("daemon must bind");
        let thread = thread::spawn(move || {
            // Serve until the listener errors, which happens when the socket is
            // removed at teardown.
            let _ = daemon.serve();
        });

        // The bind is synchronous, so the socket exists by the time `bind`
        // returned; no readiness poll needed.
        Self {
            socket,
            _thread: thread,
        }
    }

    fn connect(&self) -> Conn {
        let stream = UnixStream::connect(&self.socket).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        Conn { stream }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket);
    }
}

struct Conn {
    stream: UnixStream,
}

impl Conn {
    fn send(&mut self, value: &serde_json::Value) {
        let body = serde_json::to_vec(value).unwrap();
        let len = u32::try_from(body.len()).unwrap();
        self.stream.write_all(&len.to_be_bytes()).unwrap();
        self.stream.write_all(&body).unwrap();
        self.stream.flush().unwrap();
    }

    /// Send a raw length prefix without a matching body, to exercise the
    /// oversize and truncation paths.
    fn send_raw_prefix(&mut self, declared: u32) {
        self.stream.write_all(&declared.to_be_bytes()).unwrap();
        self.stream.flush().unwrap();
    }

    fn recv(&mut self) -> serde_json::Value {
        let mut len = [0u8; 4];
        self.stream.read_exact(&mut len).expect("length prefix");
        let mut body = vec![0u8; u32::from_be_bytes(len) as usize];
        self.stream.read_exact(&mut body).expect("body");
        serde_json::from_slice(&body).expect("json body")
    }

    fn handshake(&mut self) -> serde_json::Value {
        self.send(&serde_json::json!({
            "hello": { "protocol_version": 1, "client": "test", "client_version": "0" }
        }));
        self.recv()
    }
}

fn evaluate_request(command: &str) -> serde_json::Value {
    serde_json::json!({
        "request_id": "11111111-2222-3333-4444-555555555555",
        "op": { "evaluate_hook": {
            "cli": "claude",
            "event_type": "PreToolUse",
            "raw_event_type": "PreToolUse",
            "payload": { "tool_name": "Bash", "tool_input": { "command": command } },
            "session": {
                "session_id": "sess-e2e",
                "transcript_path": null,
                "permission_mode": "default",
                "hook_event_name": "PreToolUse"
            },
            "host": {
                "home": null,
                "cwd": "/home/u/project",
                "project_dir": null,
                "env_facts": { "CLAUDE_PROJECT_DIR": null }
            },
            "deadline_ms": 2000,
            "shadow": false
        }}
    })
}

#[test]
fn handshake_then_ping() {
    let h = Harness::start("ping");
    let mut c = h.connect();

    let ack = c.handshake();
    assert_eq!(ack["hello_ack"]["protocol_version"], 1);
    assert!(
        ack["hello_ack"]["generation_id"]
            .as_str()
            .unwrap()
            .starts_with("gen-"),
        "the ack must name the active generation so a client can correlate decisions"
    );

    c.send(&serde_json::json!({ "request_id": "p1", "op": { "ping": {} } }));
    let pong = c.recv();
    assert_eq!(pong["request_id"], "p1");
    assert!(pong["result"]["pong"]["daemon_version"].is_string());
}

#[test]
fn denies_sudo_with_the_exact_claude_shape() {
    let h = Harness::start("deny");
    let mut c = h.connect();
    c.handshake();

    c.send(&evaluate_request("sudo rm -rf /"));
    let res = c.recv();
    let ev = &res["result"]["evaluated"];

    assert_eq!(res["request_id"], "11111111-2222-3333-4444-555555555555");
    assert_eq!(ev["decision"], "deny");
    assert_eq!(ev["policy_name"], "failproofai/block-sudo");
    assert_eq!(ev["exit_code"], 0);
    assert_eq!(ev["stderr"], "");

    // The bytes a harness actually sees.
    let stdout: serde_json::Value = serde_json::from_str(ev["stdout"].as_str().unwrap()).unwrap();
    assert_eq!(
        stdout,
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason":
                    "Blocked Bash by failproofai because: sudo commands are blocked, as per the policy configured by the user"
            }
        })
    );

    assert!(ev["decision_id"].as_str().unwrap().starts_with("dec-"));
    assert_eq!(
        ev["needs_user_context"],
        serde_json::json!([]),
        "Stage 1 evaluates sealed-only and must report nothing pending"
    );
}

#[test]
fn allows_a_benign_command() {
    let h = Harness::start("allow");
    let mut c = h.connect();
    c.handshake();
    c.send(&evaluate_request("ls -la"));
    let res = c.recv();
    assert_eq!(res["result"]["evaluated"]["decision"], "allow");
    assert_eq!(res["result"]["evaluated"]["exit_code"], 0);
    assert_eq!(res["result"]["evaluated"]["stdout"], "");
}

#[test]
fn a_decision_reading_cwd_is_reported_sealed_unattested() {
    // `cwd` is client-asserted and cannot be derived, so a decision that saw it
    // must not claim full attestation. Reporting it honestly is the difference
    // between "unforgeable" being true and being marketing.
    let h = Harness::start("attest");
    let mut c = h.connect();
    c.handshake();
    c.send(&evaluate_request("ls"));
    let res = c.recv();
    assert_eq!(
        res["result"]["evaluated"]["attestation"],
        "sealed_unattested"
    );
}

#[test]
fn a_client_asserted_home_is_refused_not_overwritten() {
    // The single most important negative test in the file. `home` widens the
    // allow set — `isAgentInternalPath` whitelists everything under it — so a
    // client that could assert `home: "/"` would relax a sealed verdict.
    let h = Harness::start("forged-home");
    let mut c = h.connect();
    c.handshake();

    let mut req = evaluate_request("ls");
    req["op"]["evaluate_hook"]["host"]["home"] = serde_json::json!("/");
    c.send(&req);

    let res = c.recv();
    assert_eq!(
        res["result"]["error"]["code"], "client_asserted_home",
        "a forged home must be a protocol error, not silently corrected"
    );
    assert!(
        res["result"]["evaluated"].is_null(),
        "a rejected envelope must not produce a verdict"
    );
}

#[test]
fn an_unknown_env_fact_is_refused() {
    // The hook client's environment originates in the agent's process, so an
    // open-ended env map would be an injection channel into the daemon.
    let h = Harness::start("env-fact");
    let mut c = h.connect();
    c.handshake();

    let mut req = evaluate_request("ls");
    req["op"]["evaluate_hook"]["host"]["env_facts"]["LD_PRELOAD"] = serde_json::json!("/evil.so");
    c.send(&req);

    let res = c.recv();
    assert_eq!(res["result"]["error"]["code"], "unknown_env_fact");
    assert!(
        res["result"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("LD_PRELOAD"),
        "the error must name the offending key, or the client cannot fix it"
    );
}

#[test]
fn an_unsupported_protocol_version_is_refused_before_any_op() {
    let h = Harness::start("version");
    let mut c = h.connect();
    c.send(&serde_json::json!({
        "hello": { "protocol_version": 99, "client": "test", "client_version": "0" }
    }));
    let reply = c.recv();
    assert_eq!(reply["version_mismatch"]["received"], 99);
    assert_eq!(
        reply["version_mismatch"]["supported"],
        serde_json::json!([1])
    );
}

#[test]
fn an_oversize_frame_is_refused_without_allocating_it() {
    // 4 GiB declared, no body sent. If the daemon allocated on the declared
    // length this test would OOM the machine rather than fail.
    let h = Harness::start("oversize");
    let mut c = h.connect();
    c.handshake();
    c.send_raw_prefix(u32::MAX);

    let res = c.recv();
    assert_eq!(res["result"]["error"]["code"], "frame_too_large");
}

#[test]
fn a_malformed_request_body_is_an_error_not_a_crash() {
    let h = Harness::start("malformed");
    let mut c = h.connect();
    c.handshake();

    let body = b"{ this is not a request }";
    let len = u32::try_from(body.len()).unwrap();
    c.stream.write_all(&len.to_be_bytes()).unwrap();
    c.stream.write_all(body).unwrap();
    c.stream.flush().unwrap();

    let res = c.recv();
    assert_eq!(res["result"]["error"]["code"], "malformed_frame");
}

#[test]
fn home_is_derived_from_the_peer_uid_not_the_request() {
    // The connecting process is this test, so the derived home is the test
    // runner's own — and `block-read-outside-cwd` whitelisting `<that
    // home>/.claude` is only possible if the daemon looked it up itself. The
    // request carries `home: null` throughout.
    let h = Harness::start("derived-home");
    let mut c = h.connect();
    c.handshake();

    let home = std::env::var("HOME").expect("HOME must be set for this assertion");
    let mut req = evaluate_request("ls");
    req["op"]["evaluate_hook"]["payload"] = serde_json::json!({
        "tool_name": "Read",
        "tool_input": { "file_path": format!("{home}/.claude/CLAUDE.md") }
    });
    c.send(&req);

    let res = c.recv();
    // Allowed because it is under the *derived* home's agent directory. If the
    // daemon had used the service account's home, or an empty one, this would
    // deny.
    assert_eq!(res["result"]["evaluated"]["decision"], "allow");
}

#[test]
fn many_sequential_requests_on_one_connection_stay_consistent() {
    // The lane is shared and the worker is warm. Two things could go wrong:
    // state leaking between evaluations, and a response being matched to the
    // wrong request. Both would be silent.
    let h = Harness::start("sequential");
    let mut c = h.connect();
    c.handshake();

    for i in 0..200 {
        let deny = i % 2 == 0;
        let mut req = evaluate_request(if deny { "sudo id" } else { "echo hi" });
        req["request_id"] = serde_json::json!(format!("req-{i}"));
        c.send(&req);
        let res = c.recv();
        assert_eq!(
            res["request_id"],
            format!("req-{i}"),
            "response/request mismatch"
        );
        assert_eq!(
            res["result"]["evaluated"]["decision"],
            if deny { "deny" } else { "allow" },
            "iteration {i} diverged"
        );
    }
}

#[test]
fn concurrent_connections_are_served_independently() {
    // One enforcement lane, many connections. Requests must queue rather than
    // interleave into each other's answers.
    let h = Harness::start("concurrent");
    let socket = h.socket.clone();

    let handles: Vec<_> = (0..8)
        .map(|worker| {
            let socket = socket.clone();
            thread::spawn(move || {
                let stream = UnixStream::connect(&socket).expect("connect");
                stream
                    .set_read_timeout(Some(Duration::from_secs(30)))
                    .unwrap();
                let mut c = Conn { stream };
                c.handshake();
                for i in 0..25 {
                    let deny = (worker + i) % 2 == 0;
                    let mut req = evaluate_request(if deny { "sudo id" } else { "echo hi" });
                    req["request_id"] = serde_json::json!(format!("w{worker}-r{i}"));
                    c.send(&req);
                    let res = c.recv();
                    assert_eq!(res["request_id"], format!("w{worker}-r{i}"));
                    assert_eq!(
                        res["result"]["evaluated"]["decision"],
                        if deny { "deny" } else { "allow" }
                    );
                }
            })
        })
        .collect();

    for handle in handles {
        handle.join().expect("worker thread panicked");
    }
}

#[test]
fn a_connection_that_disconnects_mid_flight_does_not_take_the_daemon_down() {
    let h = Harness::start("abrupt");

    {
        let mut c = h.connect();
        c.handshake();
        c.send(&evaluate_request("sudo id"));
        // Drop without reading the response.
    }

    // The daemon must still be serving.
    let mut c = h.connect();
    c.handshake();
    c.send(&evaluate_request("sudo id"));
    assert_eq!(c.recv()["result"]["evaluated"]["decision"], "deny");
}
