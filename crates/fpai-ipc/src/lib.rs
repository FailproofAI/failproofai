//! Wire types for the `failproofaid` local IPC protocol, version 1.
//!
//! `crates/PROTOCOL.md` is the single source of truth shared by this crate,
//! `failproofaid`, and `src/hooks/daemon-client.ts`. All three are written
//! against it independently, so anything ambiguous there becomes a silent
//! interop bug — and `tests/protocol_conformance.rs` in this crate parses the
//! document's own example JSON verbatim so a rename on one side of the wire
//! fails the build rather than the field.
//!
//! Scope: framing, envelope types, peer credentials, and the decision lattice.
//! **No daemon logic and no policy logic.** The transport (which socket, which
//! listener, which lane) belongs to `failproofaid`; canonicalization belongs to
//! `fpai-canon`; what a verdict *means* belongs to the policy layer. What lives
//! here is only what all of them must agree on byte-for-byte.
//!
//! ```
//! use fpai_ipc::{
//!     combine::Decision,
//!     envelope::{ClientHandshake, Hello, PROTOCOL_VERSION},
//!     framing::{read_frame, write_frame},
//! };
//!
//! let hello = ClientHandshake::Hello(Hello {
//!     protocol_version: PROTOCOL_VERSION,
//!     client: "failproofai-hook".into(),
//!     client_version: "0.0.16-beta.0".into(),
//! });
//!
//! let mut wire = Vec::new();
//! write_frame(&mut wire, &serde_json::to_vec(&hello).unwrap()).unwrap();
//!
//! let body = read_frame(&mut wire.as_slice()).unwrap();
//! assert_eq!(serde_json::from_slice::<ClientHandshake>(&body).unwrap(), hello);
//! assert_eq!(Decision::Allow.max(Decision::Deny), Decision::Deny);
//! ```

#![forbid(unsafe_op_in_unsafe_fn)]
#![warn(missing_docs, clippy::missing_errors_doc, clippy::missing_panics_doc)]

pub mod combine;
pub mod envelope;
pub mod framing;
#[cfg(unix)]
pub mod peer;

pub use combine::{Decision, Tier, TieredDecision, TieredOutcome, combine, combine_all};
pub use envelope::{
    Attestation, ClientHandshake, EnvFacts, ErrorBody, ErrorCode, EvaluateHook, Evaluated, Hello,
    HelloAck, HostContext, Op, OpResult, PROTOCOL_VERSION, Ping, Pong, ProtocolError, Request,
    Response, ServerHandshake, SessionFields, VersionMismatch,
};
pub use framing::{FrameError, MAX_FRAME_BODY, read_frame, write_frame};
#[cfg(feature = "tokio")]
pub use framing::{read_frame_async, write_frame_async};
#[cfg(unix)]
pub use peer::{PeerCred, current_uid, home_for_uid, peer_credentials};
