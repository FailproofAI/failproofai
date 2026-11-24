//! Wire protocol shared by `failproofaid` and every client/test that talks
//! to it: message framing, the JSON envelope, and Unix-socket peer
//! verification.

pub mod envelope;
pub mod framing;
pub mod peer;

pub use envelope::{
    ClientMessage, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, ServerMessage,
    is_supported_protocol_version,
};
pub use framing::{FramingError, MAX_FRAME_LEN, read_message, write_message};
