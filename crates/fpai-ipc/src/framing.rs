//! Length-prefixed JSON framing shared by the daemon and every client of it.
//!
//! Frame = 4-byte big-endian `u32` byte length, followed by that many bytes
//! of UTF-8 JSON. One frame in, one frame out, per connection — the daemon
//! never keeps a connection open across multiple logical requests, so there
//! is no need for a request-id-multiplexed protocol.

use serde::Serialize;
use serde::de::DeserializeOwned;
use std::io::{self, Read, Write};

/// Hard cap on a single frame's declared length. A hook payload is at most
/// 1 MiB (see `handler.ts`'s own stdin cap); 16 MiB leaves headroom without
/// letting a corrupt or hostile length prefix trigger an unbounded
/// allocation before a single byte of the body has even been read.
pub const MAX_FRAME_LEN: u32 = 16 * 1024 * 1024;

#[derive(Debug)]
pub enum FramingError {
    Io(io::Error),
    FrameTooLarge { declared: u32, max: u32 },
    Json(serde_json::Error),
}

impl std::fmt::Display for FramingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FramingError::Io(e) => write!(f, "io error: {e}"),
            FramingError::FrameTooLarge { declared, max } => {
                write!(f, "frame length {declared} exceeds max {max}")
            }
            FramingError::Json(e) => write!(f, "invalid JSON frame: {e}"),
        }
    }
}

impl std::error::Error for FramingError {}

impl From<io::Error> for FramingError {
    fn from(e: io::Error) -> Self {
        FramingError::Io(e)
    }
}

impl From<serde_json::Error> for FramingError {
    fn from(e: serde_json::Error) -> Self {
        FramingError::Json(e)
    }
}

/// Serializes `value` to JSON and writes it as one length-prefixed frame.
pub fn write_message<W: Write, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<(), FramingError> {
    let body = serde_json::to_vec(value)?;
    let len = u32::try_from(body.len()).map_err(|_| FramingError::FrameTooLarge {
        declared: u32::MAX,
        max: MAX_FRAME_LEN,
    })?;
    if len > MAX_FRAME_LEN {
        return Err(FramingError::FrameTooLarge {
            declared: len,
            max: MAX_FRAME_LEN,
        });
    }
    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

/// Reads one length-prefixed frame and deserializes it as `T`. Rejects the
/// frame (without allocating a body buffer) if the declared length exceeds
/// [`MAX_FRAME_LEN`], so a corrupt or adversarial length prefix can't be
/// used to force a large allocation.
pub fn read_message<R: Read, T: DeserializeOwned>(reader: &mut R) -> Result<T, FramingError> {
    let mut len_bytes = [0u8; 4];
    reader.read_exact(&mut len_bytes)?;
    let len = u32::from_be_bytes(len_bytes);
    if len > MAX_FRAME_LEN {
        return Err(FramingError::FrameTooLarge {
            declared: len,
            max: MAX_FRAME_LEN,
        });
    }
    let mut body = vec![0u8; len as usize];
    reader.read_exact(&mut body)?;
    let value = serde_json::from_slice(&body)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::io::Cursor;

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Sample {
        a: u32,
        b: String,
    }

    #[test]
    fn round_trips_a_simple_value() {
        let mut buf = Vec::new();
        let msg = Sample {
            a: 42,
            b: "hello".to_string(),
        };
        write_message(&mut buf, &msg).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: Sample = read_message(&mut cursor).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn round_trips_empty_string_fields() {
        let mut buf = Vec::new();
        let msg = Sample {
            a: 0,
            b: String::new(),
        };
        write_message(&mut buf, &msg).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: Sample = read_message(&mut cursor).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn rejects_a_declared_length_over_the_cap_without_reading_a_body() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(MAX_FRAME_LEN + 1).to_be_bytes());
        // Deliberately no body bytes follow — if `read_message` tried to
        // allocate/read the declared length before checking the cap, this
        // would hang or panic on the short read instead of erroring cleanly.
        let mut cursor = Cursor::new(buf);
        let result: Result<Sample, _> = read_message(&mut cursor);
        assert!(matches!(result, Err(FramingError::FrameTooLarge { .. })));
    }

    #[test]
    fn refuses_to_write_a_frame_over_the_cap() {
        #[derive(Serialize)]
        struct Big {
            data: String,
        }
        let big = Big {
            data: "x".repeat((MAX_FRAME_LEN as usize) + 1),
        };
        let mut buf = Vec::new();
        let result = write_message(&mut buf, &big);
        assert!(matches!(result, Err(FramingError::FrameTooLarge { .. })));
    }

    #[test]
    fn rejects_truncated_frames() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&10u32.to_be_bytes());
        buf.extend_from_slice(b"short"); // fewer than the declared 10 bytes
        let mut cursor = Cursor::new(buf);
        let result: Result<Sample, _> = read_message(&mut cursor);
        assert!(matches!(result, Err(FramingError::Io(_))));
    }

    #[test]
    fn rejects_malformed_json_inside_a_valid_frame() {
        let mut buf = Vec::new();
        let body = b"not json";
        buf.extend_from_slice(&(body.len() as u32).to_be_bytes());
        buf.extend_from_slice(body);
        let mut cursor = Cursor::new(buf);
        let result: Result<Sample, _> = read_message(&mut cursor);
        assert!(matches!(result, Err(FramingError::Json(_))));
    }
}
