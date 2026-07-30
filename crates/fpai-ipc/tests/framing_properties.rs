//! Property tests for framing and for envelope round-tripping.
//!
//! Framing is algebraic in the same sense the lattice is: `read_frame` must
//! invert `write_frame` for *every* body, and must fail — never return a
//! plausible-looking wrong body — for every truncation of every frame. Examples
//! cover the boundaries; these cover the middle.

use fpai_ipc::envelope::{
    ClientHandshake, EnvFacts, ErrorBody, ErrorCode, EvaluateHook, Evaluated, Hello, HelloAck,
    HostContext, Op, OpResult, Ping, Pong, Request, Response, ServerHandshake, SessionFields,
    VersionMismatch,
};
use fpai_ipc::framing::{FrameError, MAX_FRAME_BODY, read_frame, write_frame};
use fpai_ipc::{Attestation, Decision};
use proptest::prelude::*;

fn any_body() -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(any::<u8>(), 1..8192)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 1024, ..ProptestConfig::default() })]

    #[test]
    fn a_frame_round_trips(body in any_body()) {
        let mut wire = Vec::new();
        write_frame(&mut wire, &body).unwrap();
        prop_assert_eq!(wire.len(), body.len() + 4);
        prop_assert_eq!(&wire[..4], &u32::try_from(body.len()).unwrap().to_be_bytes()[..]);
        prop_assert_eq!(read_frame(&mut wire.as_slice()).unwrap(), body);
    }

    /// Consecutive frames stay separated, in order, with nothing bleeding
    /// between them — the property that makes a length prefix worth the four
    /// bytes over newline delimiting when bodies contain newlines.
    #[test]
    fn frames_do_not_bleed_into_each_other(bodies in prop::collection::vec(any_body(), 1..8)) {
        let mut wire = Vec::new();
        for body in &bodies {
            write_frame(&mut wire, body).unwrap();
        }

        let mut cursor = wire.as_slice();
        for body in &bodies {
            prop_assert_eq!(&read_frame(&mut cursor).unwrap(), body);
        }
        prop_assert!(read_frame(&mut cursor).unwrap_err().is_clean_disconnect());
    }

    /// Every truncation of a frame is an error, and specifically never a
    /// successfully-decoded shorter body. A silently-accepted short frame would
    /// hand the daemon a JSON parse failure it would report as
    /// `malformed_frame` — the right code for the wrong reason, and unfixable
    /// from the logs.
    #[test]
    fn every_truncation_fails(body in any_body(), cut in 0usize..8192) {
        let mut wire = Vec::new();
        write_frame(&mut wire, &body).unwrap();
        let keep = cut % wire.len();
        wire.truncate(keep);

        let err = read_frame(&mut wire.as_slice()).unwrap_err();
        match keep {
            0 => prop_assert!(err.is_clean_disconnect(), "got {err:?}"),
            1..=3 => prop_assert!(
                matches!(err, FrameError::TruncatedLength { read } if read == keep),
                "got {err:?}"
            ),
            _ => prop_assert!(
                matches!(err, FrameError::TruncatedBody { declared, read }
                         if declared == body.len() && read == keep - 4),
                "got {err:?}"
            ),
        }
    }

    /// Any declared length above the cap is rejected, whatever the bytes behind
    /// it look like.
    #[test]
    fn any_oversize_declaration_is_rejected(
        declared in (u32::try_from(MAX_FRAME_BODY).unwrap() + 1)..=u32::MAX,
        trailing in prop::collection::vec(any::<u8>(), 0..64),
    ) {
        let mut wire = declared.to_be_bytes().to_vec();
        wire.extend_from_slice(&trailing);
        let err = read_frame(&mut wire.as_slice()).unwrap_err();
        prop_assert!(matches!(err, FrameError::TooLarge { declared: d } if d == declared), "got {err:?}");
        prop_assert_eq!(err.error_code(), Some(ErrorCode::FrameTooLarge));
    }

    /// A body at or below the cap is always accepted; one byte over is always
    /// refused. Stated over a range so an off-by-one in either direction fails.
    #[test]
    fn the_cap_is_inclusive(len in 1usize..=64) {
        let at_cap = vec![b'x'; MAX_FRAME_BODY - len + 1];
        prop_assert!(write_frame(&mut Vec::new(), &at_cap).is_ok());
        let over = vec![b'x'; MAX_FRAME_BODY + len];
        let err = write_frame(&mut Vec::new(), &over).unwrap_err();
        prop_assert!(matches!(err, FrameError::TooLarge { .. }), "got {err:?}");
    }

    // ---- envelope round-tripping ----------------------------------------

    /// Every message type survives a JSON round-trip losslessly, including
    /// bodies with quotes, backslashes, newlines, and non-BMP characters —
    /// tool input is arbitrary text and regularly contains all four.
    #[test]
    fn every_message_type_round_trips(
        id in any::<String>(),
        text in any::<String>(),
        n in any::<u64>(),
        exit_code in any::<i32>(),
        flag in any::<bool>(),
    ) {
        let hello = ClientHandshake::Hello(Hello {
            protocol_version: 1,
            client: text.clone(),
            client_version: text.clone(),
        });
        prop_assert_eq!(
            serde_json::from_str::<ClientHandshake>(&serde_json::to_string(&hello).unwrap()).unwrap(),
            hello
        );

        for handshake in [
            ServerHandshake::HelloAck(HelloAck {
                protocol_version: 1,
                daemon_version: text.clone(),
                generation_id: id.clone(),
            }),
            ServerHandshake::VersionMismatch(VersionMismatch {
                supported: vec![1],
                received: 2,
            }),
        ] {
            let encoded = serde_json::to_vec(&handshake).unwrap();
            prop_assert_eq!(serde_json::from_slice::<ServerHandshake>(&encoded).unwrap(), handshake);
        }

        let request = Request {
            request_id: id.clone(),
            op: Op::EvaluateHook(Box::new(EvaluateHook {
                cli: text.clone(),
                event_type: text.clone(),
                raw_event_type: text.clone(),
                payload: serde_json::from_value(serde_json::json!({
                    "tool_name": "Bash",
                    "tool_input": { "command": text.clone() },
                })).unwrap(),
                session: SessionFields {
                    session_id: Some(id.clone()),
                    transcript_path: None,
                    permission_mode: Some(text.clone()),
                    hook_event_name: None,
                },
                host: HostContext {
                    home: None,
                    cwd: Some(text.clone()),
                    project_dir: None,
                    env_facts: EnvFacts::with_claude_project_dir(Some(text.clone())),
                },
                deadline_ms: n,
                shadow: flag,
            })),
        };
        let encoded = serde_json::to_vec(&request).unwrap();
        prop_assert_eq!(serde_json::from_slice::<Request>(&encoded).unwrap(), request.clone());

        // …and through the framing layer, which is where a body with a NUL or a
        // newline in it would break a delimiter-based transport.
        let mut wire = Vec::new();
        write_frame(&mut wire, &encoded).unwrap();
        let body = read_frame(&mut wire.as_slice()).unwrap();
        prop_assert_eq!(serde_json::from_slice::<Request>(&body).unwrap(), request);

        let ping = Request { request_id: id.clone(), op: Op::Ping(Ping {}) };
        prop_assert_eq!(
            serde_json::from_str::<Request>(&serde_json::to_string(&ping).unwrap()).unwrap(),
            ping
        );

        for result in [
            OpResult::Pong(Pong { daemon_version: text.clone(), uptime_ms: n }),
            OpResult::Error(ErrorBody { code: ErrorCode::Internal, message: text.clone() }),
            OpResult::Evaluated(Box::new(Evaluated {
                decision_id: id.clone(),
                generation_id: id.clone(),
                exit_code,
                stdout: text.clone(),
                stderr: text.clone(),
                decision: Decision::Deny,
                policy_name: Some(text.clone()),
                policy_names: Some(vec![text.clone()]),
                reason: None,
                attestation: Attestation::SealedUnattested,
                matched_policies: vec![text.clone()],
                needs_user_context: vec![],
            })),
        ] {
            let response = Response { request_id: id.clone(), result };
            let encoded = serde_json::to_vec(&response).unwrap();
            prop_assert_eq!(serde_json::from_slice::<Response>(&encoded).unwrap(), response);
        }
    }

    /// An unknown top-level field on any request-side type is a hard failure,
    /// whatever it is called. `deny_unknown_fields` is what makes a client that
    /// invents a host field fail loudly instead of having it silently ignored.
    #[test]
    fn any_unknown_request_side_field_is_rejected(name in "[a-z_]{1,16}") {
        prop_assume!(!["home", "cwd", "project_dir", "env_facts"].contains(&name.as_str()));

        let mut object = serde_json::Map::new();
        object.insert("home".into(), serde_json::Value::Null);
        object.insert("cwd".into(), serde_json::Value::Null);
        object.insert("project_dir".into(), serde_json::Value::Null);
        object.insert("env_facts".into(), serde_json::json!({}));
        object.insert(name.clone(), serde_json::json!("anything"));

        let err = serde_json::from_value::<HostContext>(object.into()).unwrap_err();
        prop_assert!(err.to_string().contains(&name), "{err}");
    }

    /// Any `env_facts` key outside the closed set is rejected, and the error
    /// names it.
    #[test]
    fn any_unknown_env_fact_is_rejected(name in "[A-Z_]{1,24}") {
        prop_assume!(name != "CLAUDE_PROJECT_DIR");

        let mut host = HostContext::default();
        host.env_facts.insert(name.clone(), Some("value".into()));
        let err = host.validate().unwrap_err();
        prop_assert_eq!(err.code(), ErrorCode::UnknownEnvFact);
        prop_assert!(err.to_string().contains(&name), "{err}");
    }

    /// Any non-null `home` is rejected, whatever it is set to. The dangerous
    /// value is `"/"`, but the rule is not value-dependent — a rule that only
    /// caught the obviously-hostile value would be a filter, not a boundary.
    #[test]
    fn any_asserted_home_is_rejected(home in any::<String>()) {
        let host = HostContext { home: Some(home), ..HostContext::default() };
        prop_assert_eq!(host.validate().unwrap_err().code(), ErrorCode::ClientAssertedHome);
    }
}
