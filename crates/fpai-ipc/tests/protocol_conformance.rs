//! Conformance against `crates/PROTOCOL.md`, the shared source of truth.
//!
//! Three implementations are written against that document independently — this
//! crate, `failproofaid`, and `src/hooks/daemon-client.ts` — so a rename on one
//! side is invisible until two of them meet on a socket. Nothing else in this
//! crate can catch that: a serde round-trip proves the Rust types agree with
//! *themselves*.
//!
//! So every example below is pasted verbatim out of the document, and each is
//! also asserted to still be a substring of it. That is the load-bearing half:
//! editing PROTOCOL.md without editing this file fails the build, and editing
//! this file to match a changed document forces a reviewer to look at the diff
//! that changed the wire format.
//!
//! Comparison is between `serde_json::Value`s, so key order is free but every
//! name, nesting level, and null is pinned.

use fpai_ipc::envelope::{
    Attestation, ClientHandshake, ErrorCode, Op, OpResult, Response, ServerHandshake,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

/// The document itself. `include_str!` rather than a runtime read: a missing or
/// moved PROTOCOL.md must be a compile error, not a skipped test.
const PROTOCOL_MD: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../PROTOCOL.md"));

// --- Handshake -------------------------------------------------------------

const HELLO: &str = r#"{ "hello": { "protocol_version": 1, "client": "failproofai-hook", "client_version": "0.0.16-beta.0" } }"#;

const HELLO_ACK: &str = r#"{ "hello_ack": { "protocol_version": 1, "daemon_version": "0.0.16-beta.0", "generation_id": "gen-<hex>" } }"#;

const VERSION_MISMATCH: &str = r#"{ "version_mismatch": { "supported": [1], "received": 2 } }"#;

// --- Ping ------------------------------------------------------------------

const PING_OP: &str = r#"{ "op": { "ping": {} } }"#;

const PONG_RESULT: &str =
    r#"{ "result": { "pong": { "daemon_version": "0.0.16-beta.0", "uptime_ms": 12345 } } }"#;

// --- EvaluateHook ----------------------------------------------------------

const EVALUATE_HOOK_OP: &str = r#"{
  "op": {
    "evaluate_hook": {
      "cli": "claude",
      "event_type": "PreToolUse",
      "raw_event_type": "PreToolUse",
      "payload": { "tool_name": "Bash", "tool_input": { "command": "sudo rm -rf /" } },
      "session": {
        "session_id": "sess-1",
        "transcript_path": "/home/u/.claude/projects/x/sess-1.jsonl",
        "permission_mode": "default",
        "hook_event_name": "PreToolUse"
      },
      "host": {
        "home": null,
        "cwd": "/home/u/project",
        "project_dir": null,
        "env_facts": { "CLAUDE_PROJECT_DIR": null }
      },
      "deadline_ms": 800,
      "shadow": false
    }
  }
}"#;

const EVALUATED_RESULT: &str = r#"{
  "result": {
    "evaluated": {
      "decision_id": "dec-<hex>",
      "generation_id": "gen-<hex>",
      "exit_code": 0,
      "stdout": "{\"hookSpecificOutput\":{…}}",
      "stderr": "",
      "decision": "deny",
      "policy_name": "failproofai/block-sudo",
      "policy_names": null,
      "reason": "sudo commands are blocked",
      "attestation": "sealed",
      "matched_policies": ["failproofai/block-sudo"],
      "needs_user_context": []
    }
  }
}"#;

// --- Errors ----------------------------------------------------------------

const ERROR_RESPONSE: &str = r#"{ "request_id": "…", "result": { "error": { "code": "client_asserted_home", "message": "…" } } }"#;

const EVERY_EXAMPLE: &[(&str, &str)] = &[
    ("hello", HELLO),
    ("hello_ack", HELLO_ACK),
    ("version_mismatch", VERSION_MISMATCH),
    ("ping op", PING_OP),
    ("pong result", PONG_RESULT),
    ("evaluate_hook op", EVALUATE_HOOK_OP),
    ("evaluated result", EVALUATED_RESULT),
    ("error response", ERROR_RESPONSE),
];

/// Parse an example as `T`, re-serialize, and require the JSON to be identical.
fn assert_lossless<T: Serialize + DeserializeOwned>(label: &str, value: &Value) {
    let parsed: T = serde_json::from_value(value.clone())
        .unwrap_or_else(|e| panic!("{label}: PROTOCOL.md example does not deserialize: {e}"));
    let reserialized = serde_json::to_value(&parsed)
        .unwrap_or_else(|e| panic!("{label}: does not re-serialize: {e}"));
    assert_eq!(
        &reserialized, value,
        "{label}: re-serialized JSON differs from the PROTOCOL.md example"
    );
}

fn parse(example: &str) -> Value {
    serde_json::from_str(example).expect("example is valid JSON")
}

#[test]
fn every_pasted_example_is_still_verbatim_in_the_document() {
    for (label, example) in EVERY_EXAMPLE {
        assert!(
            PROTOCOL_MD.contains(example),
            "{label}: this example is no longer present verbatim in crates/PROTOCOL.md. \
             The wire format changed; update this test *and* the Rust types together."
        );
    }
}

#[test]
fn handshake_examples_round_trip() {
    assert_lossless::<ClientHandshake>("hello", &parse(HELLO));
    assert_lossless::<ServerHandshake>("hello_ack", &parse(HELLO_ACK));
    assert_lossless::<ServerHandshake>("version_mismatch", &parse(VERSION_MISMATCH));
}

#[test]
fn a_hello_ack_is_distinguishable_from_a_version_mismatch() {
    // The client's whole fallback rule is "anything other than hello_ack means
    // use the legacy evaluator", so the two must not both parse as acceptance.
    let ack: ServerHandshake = serde_json::from_str(HELLO_ACK).unwrap();
    assert!(matches!(ack, ServerHandshake::HelloAck(_)));
    let mismatch: ServerHandshake = serde_json::from_str(VERSION_MISMATCH).unwrap();
    let ServerHandshake::VersionMismatch(mismatch) = mismatch else {
        panic!("version_mismatch parsed as an acknowledgement");
    };
    assert_eq!(mismatch.supported, vec![1]);
    assert_eq!(mismatch.received, 2);
}

#[test]
fn op_examples_round_trip() {
    // The op/result examples are shown without their `request_id` wrapper, so
    // they are checked at the `op` and `result` keys.
    assert_lossless::<Op>("ping op", &parse(PING_OP)["op"]);
    assert_lossless::<OpResult>("pong result", &parse(PONG_RESULT)["result"]);
    assert_lossless::<Op>("evaluate_hook op", &parse(EVALUATE_HOOK_OP)["op"]);
    assert_lossless::<OpResult>("evaluated result", &parse(EVALUATED_RESULT)["result"]);
}

#[test]
fn the_error_example_round_trips_as_a_whole_response() {
    assert_lossless::<Response>("error response", &parse(ERROR_RESPONSE));
}

#[test]
fn the_evaluate_hook_example_carries_the_fields_the_daemon_reads() {
    let Op::EvaluateHook(op) =
        serde_json::from_value(parse(EVALUATE_HOOK_OP)["op"].clone()).unwrap()
    else {
        panic!("example did not parse as evaluate_hook");
    };
    assert_eq!(op.cli, "claude");
    assert_eq!(op.event_type, "PreToolUse");
    assert_eq!(op.payload["tool_name"], "Bash");
    assert_eq!(op.payload["tool_input"]["command"], "sudo rm -rf /");
    assert_eq!(op.session.permission_mode.as_deref(), Some("default"));
    assert_eq!(op.deadline_ms, 800);
    assert!(!op.shadow);
    // `home` is null and `env_facts` holds only the one closed-set key, so the
    // document's own example is a valid request.
    op.host
        .validate()
        .expect("the PROTOCOL.md example must be an acceptable envelope");
    assert_eq!(op.host.cwd.as_deref(), Some("/home/u/project"));
    assert_eq!(op.host.env_facts.claude_project_dir(), None);
}

#[test]
fn the_evaluated_example_carries_the_evaluation_result_fields_verbatim() {
    let OpResult::Evaluated(result) =
        serde_json::from_value(parse(EVALUATED_RESULT)["result"].clone()).unwrap()
    else {
        panic!("example did not parse as evaluated");
    };
    // These seven are byte-for-byte the fields `EvaluationResult` already has in
    // src/hooks/policy-evaluator.ts; the client writes them out unchanged.
    assert_eq!(result.exit_code, 0);
    assert!(result.stdout.contains("hookSpecificOutput"));
    assert_eq!(result.stderr, "");
    assert_eq!(result.decision.as_str(), "deny");
    assert_eq!(
        result.policy_name.as_deref(),
        Some("failproofai/block-sudo")
    );
    assert_eq!(result.policy_names, None);
    assert_eq!(result.reason.as_deref(), Some("sudo commands are blocked"));

    assert_eq!(result.attestation, Attestation::Sealed);
    assert_eq!(result.matched_policies, vec!["failproofai/block-sudo"]);
    // Stage 1 always returns this empty; a client seeing a non-empty list must
    // fall back to legacy.
    assert!(result.needs_user_context.is_empty());
}

#[test]
fn every_error_code_appears_in_the_documents_table() {
    for code in [
        ErrorCode::ClientAssertedHome,
        ErrorCode::UnknownEnvFact,
        ErrorCode::CanonicalizationMismatch,
        ErrorCode::FrameTooLarge,
        ErrorCode::MalformedFrame,
        ErrorCode::DeadlineExceeded,
        ErrorCode::UnsupportedOp,
        ErrorCode::Internal,
    ] {
        let row = format!("| `{}` |", code.as_str());
        assert!(
            PROTOCOL_MD.contains(&row),
            "error code `{code}` is not a row in the PROTOCOL.md error table"
        );
    }
}

#[test]
fn every_attestation_value_appears_in_the_documents_table() {
    for attestation in [
        Attestation::Sealed,
        Attestation::SealedUnattested,
        Attestation::UserContext,
    ] {
        let row = format!("| `{}` |", attestation.as_str());
        assert!(
            PROTOCOL_MD.contains(&row),
            "attestation `{attestation}` is not a row in the PROTOCOL.md attestation table"
        );
    }
}

#[test]
fn the_frame_maximum_matches_the_document() {
    assert_eq!(fpai_ipc::MAX_FRAME_BODY, 1_048_576);
    assert!(
        PROTOCOL_MD.contains("Maximum body: 1 MiB (1_048_576)"),
        "the 1 MiB body cap is no longer stated in PROTOCOL.md"
    );
}

#[test]
fn the_protocol_version_matches_the_document() {
    assert_eq!(fpai_ipc::PROTOCOL_VERSION, 1);
    assert!(PROTOCOL_MD.contains("protocol v1"));
}
