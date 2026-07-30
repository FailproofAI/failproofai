//! The handshake and one request/response exchange, over a real Unix socket.
//!
//! Everything else in this crate tests framing against a `Vec<u8>` and the
//! envelope against a `Value`. This test puts both on a socket with a peer on
//! the other end, because that is where the two meet: a partial write, a
//! half-closed direction, or a peer credential read on the wrong side of the
//! pair are invisible to an in-memory test.
//!
//! There is no daemon here — that is `failproofaid`'s crate. The "daemon" below
//! is twenty lines of test scaffolding whose only job is to be a second end.

use std::io;
use std::os::unix::net::UnixStream;
use std::thread;

use fpai_ipc::envelope::{
    ClientHandshake, Hello, HelloAck, Op, OpResult, PROTOCOL_VERSION, Ping, Pong, Request,
    Response, ServerHandshake, VersionMismatch, is_supported_protocol_version,
};
use fpai_ipc::framing::{read_frame, write_frame};
use fpai_ipc::peer::peer_credentials;

/// Some sandboxes forbid `socketpair(2)`. Skipping there is correct; failing
/// would be noise that hides a real regression.
fn socket_pair() -> Option<(UnixStream, UnixStream)> {
    match UnixStream::pair() {
        Ok(pair) => Some(pair),
        Err(e) => {
            eprintln!("skipping: this environment cannot create a Unix socketpair: {e}");
            None
        }
    }
}

fn send<T: serde::Serialize>(sock: &mut UnixStream, message: &T) {
    write_frame(sock, &serde_json::to_vec(message).unwrap()).expect("write frame");
}

fn receive<T: serde::de::DeserializeOwned>(sock: &mut UnixStream) -> T {
    let body = read_frame(sock).expect("read frame");
    serde_json::from_slice(&body).expect("decode frame body")
}

/// A stand-in daemon: read the handshake, answer it, then serve one op.
fn serve(mut sock: UnixStream) -> io::Result<()> {
    // Peer credentials come from the kernel, before anything the client said is
    // even parsed. That ordering is the point: identity is never derived from
    // the envelope.
    let peer = peer_credentials(&sock)?;
    assert_eq!(peer.uid, nix::unistd::geteuid().as_raw());

    let ClientHandshake::Hello(hello) = receive(&mut sock);

    if !is_supported_protocol_version(hello.protocol_version) {
        send(
            &mut sock,
            &ServerHandshake::VersionMismatch(VersionMismatch::for_received(
                hello.protocol_version,
            )),
        );
        // …then close, without serving anything.
        return Ok(());
    }

    send(
        &mut sock,
        &ServerHandshake::HelloAck(HelloAck {
            protocol_version: PROTOCOL_VERSION,
            daemon_version: "0.0.16-beta.0".into(),
            generation_id: "gen-deadbeef".into(),
        }),
    );

    let request: Request = receive(&mut sock);
    let result = match request.op {
        Op::Ping(Ping {}) => OpResult::Pong(Pong {
            daemon_version: "0.0.16-beta.0".into(),
            uptime_ms: 12_345,
        }),
        Op::EvaluateHook(_) => unreachable!("this test only pings"),
    };
    // `request_id` is echoed verbatim.
    send(
        &mut sock,
        &Response {
            request_id: request.request_id,
            result,
        },
    );
    Ok(())
}

#[test]
fn a_supported_version_is_acknowledged_and_the_request_id_is_echoed() {
    let Some((mut client, daemon)) = socket_pair() else {
        return;
    };
    let server = thread::spawn(move || serve(daemon));

    send(
        &mut client,
        &ClientHandshake::Hello(Hello {
            protocol_version: PROTOCOL_VERSION,
            client: "failproofai-hook".into(),
            client_version: "0.0.16-beta.0".into(),
        }),
    );

    let ServerHandshake::HelloAck(ack) = receive(&mut client) else {
        panic!("a supported version must be acknowledged");
    };
    assert_eq!(ack.protocol_version, PROTOCOL_VERSION);
    assert_eq!(ack.generation_id, "gen-deadbeef");

    let request_id = "3f1b9c2e-0000-4000-8000-000000000001";
    send(
        &mut client,
        &Request {
            request_id: request_id.into(),
            op: Op::Ping(Ping {}),
        },
    );

    let response: Response = receive(&mut client);
    assert!(response.is_reply_to(request_id));
    let OpResult::Pong(pong) = response.result else {
        panic!("expected a pong")
    };
    assert_eq!(pong.uptime_ms, 12_345);

    server.join().unwrap().unwrap();
}

#[test]
fn an_unsupported_version_gets_a_mismatch_frame_and_then_a_close() {
    let Some((mut client, daemon)) = socket_pair() else {
        return;
    };
    let server = thread::spawn(move || serve(daemon));

    send(
        &mut client,
        &ClientHandshake::Hello(Hello {
            protocol_version: 2,
            client: "failproofai-hook".into(),
            client_version: "99.0.0".into(),
        }),
    );

    match receive::<ServerHandshake>(&mut client) {
        ServerHandshake::VersionMismatch(mismatch) => {
            assert_eq!(mismatch.received, 2);
            assert_eq!(mismatch.supported, vec![PROTOCOL_VERSION]);
        }
        ServerHandshake::HelloAck(_) => panic!("an unsupported version must not be acknowledged"),
    }

    server.join().unwrap().unwrap();

    // The client's rule is "anything other than hello_ack means fall back to the
    // legacy in-process evaluator — never guess, never retry with a different
    // version". So the next read must report a clean close rather than hang or
    // hand back a second frame the client might act on.
    let err = read_frame(&mut client).unwrap_err();
    assert!(err.is_clean_disconnect(), "got {err:?}");
}

#[test]
fn a_frame_larger_than_the_cap_is_refused_before_it_reaches_the_socket() {
    let Some((mut client, _daemon)) = socket_pair() else {
        return;
    };
    // The sender is the first line of defence: an oversize body never becomes
    // bytes on the wire, so the receiver's cap is a second check rather than
    // the only one.
    let oversize = vec![b'x'; fpai_ipc::MAX_FRAME_BODY + 1];
    let err = write_frame(&mut client, &oversize).unwrap_err();
    assert_eq!(err.error_code(), Some(fpai_ipc::ErrorCode::FrameTooLarge));
}
