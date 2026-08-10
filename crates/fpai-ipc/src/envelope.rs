//! The JSON envelope carried inside each [`crate::framing`] frame.
//!
//! This mirrors the `(argv --hook <Event> --cli <cli>, stdin JSON payload)
//! -> (stdout, stderr, exitCode)` contract every hook invocation already
//! has today — see `src/hooks/handler.ts`'s `handleHookEvent`. The daemon
//! adds nothing to that contract; it only relays it over a socket instead
//! of a fresh process's argv/stdin/stdout.

use serde::{Deserialize, Serialize};

/// Bumped whenever a wire-incompatible change is made to either message
/// enum below. A daemon-configured client fails closed on a mismatch and uses
/// the distinct failure category only to explain how to repair the skew.
/// There is no protocol negotiation.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    /// Cheap liveness/handshake check — used by tests and by a client that
    /// only wants to confirm a compatible daemon is listening.
    #[serde(rename_all = "camelCase")]
    Ping { protocol_version: u32 },
    /// One hook evaluation request, corresponding 1:1 to one
    /// `failproofai --hook <Event> --cli <cli>` invocation.
    #[serde(rename_all = "camelCase")]
    Hook {
        protocol_version: u32,
        hook_event: String,
        cli: String,
        /// The raw stdin payload the calling agent CLI wrote to the
        /// one-shot `failproofai` process — forwarded verbatim.
        stdin: String,
        /// Best-effort cwd of the *originating* CLI process, not the
        /// daemon's own cwd (the daemon is a single long-lived process; its
        /// own `cwd` does not vary per request and must never be used to
        /// resolve project config or custom policies).
        cwd: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMessage {
    #[serde(rename_all = "camelCase")]
    Pong { protocol_version: u32 },
    #[serde(rename_all = "camelCase")]
    HookResult {
        protocol_version: u32,
        exit_code: i32,
        stdout: String,
        stderr: String,
    },
    /// The daemon accepted the connection and parsed the request, but could
    /// not produce a verdict (e.g. the worker is down/hung). Distinct from
    /// `HookResult` so a client can tell "ran and decided" apart from
    /// "daemon couldn't evaluate at all" — the latter is what drives the
    /// client's fail-closed path.
    #[serde(rename_all = "camelCase")]
    Error {
        protocol_version: u32,
        message: String,
    },
}

impl ClientMessage {
    pub fn protocol_version(&self) -> u32 {
        match self {
            ClientMessage::Ping { protocol_version } => *protocol_version,
            ClientMessage::Hook {
                protocol_version, ..
            } => *protocol_version,
        }
    }
}

impl ServerMessage {
    pub fn protocol_version(&self) -> u32 {
        match self {
            ServerMessage::Pong { protocol_version } => *protocol_version,
            ServerMessage::HookResult {
                protocol_version, ..
            } => *protocol_version,
            ServerMessage::Error {
                protocol_version, ..
            } => *protocol_version,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_serializes_with_a_type_tag() {
        let msg = ClientMessage::Ping {
            protocol_version: PROTOCOL_VERSION,
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "ping");
        assert_eq!(json["protocolVersion"], PROTOCOL_VERSION);
    }

    #[test]
    fn hook_request_uses_camel_case_field_names_on_the_wire() {
        let msg = ClientMessage::Hook {
            protocol_version: PROTOCOL_VERSION,
            hook_event: "PreToolUse".to_string(),
            cli: "claude".to_string(),
            stdin: "{}".to_string(),
            cwd: Some("/repo".to_string()),
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "hook");
        assert_eq!(json["hookEvent"], "PreToolUse");
        assert_eq!(json["cli"], "claude");
        assert_eq!(json["cwd"], "/repo");
    }

    #[test]
    fn hook_request_cwd_is_optional() {
        let json = serde_json::json!({
            "type": "hook",
            "protocolVersion": 1,
            "hookEvent": "Stop",
            "cli": "codex",
            "stdin": "{}"
        });
        let msg: ClientMessage = serde_json::from_value(json).unwrap();
        match msg {
            ClientMessage::Hook { cwd, .. } => assert_eq!(cwd, None),
            _ => panic!("expected Hook variant"),
        }
    }

    #[test]
    fn unknown_message_type_fails_to_deserialize() {
        let json = serde_json::json!({ "type": "bogus", "protocolVersion": 1 });
        let result: Result<ClientMessage, _> = serde_json::from_value(json);
        assert!(result.is_err());
    }

    #[test]
    fn server_hook_result_round_trips() {
        let msg = ServerMessage::HookResult {
            protocol_version: PROTOCOL_VERSION,
            exit_code: 2,
            stdout: String::new(),
            stderr: "blocked".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let decoded: ServerMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn protocol_version_accessor_matches_every_variant() {
        assert_eq!(
            ClientMessage::Ping {
                protocol_version: 7
            }
            .protocol_version(),
            7
        );
        assert_eq!(
            ServerMessage::Error {
                protocol_version: 9,
                message: "x".to_string()
            }
            .protocol_version(),
            9
        );
    }
}
