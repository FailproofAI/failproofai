//! Length-prefixed framing for the `failproofaid` local IPC protocol.
//!
//! ```text
//! +--------+--------------------+
//! | u32 BE | body (UTF-8 JSON)  |
//! +--------+--------------------+
//!   length      length bytes
//! ```
//!
//! Length-prefixed rather than newline-delimited because payloads carry
//! arbitrary tool input, including newlines.
//!
//! Both a synchronous (`std::io`) and an asynchronous (`tokio::io`) pair are
//! provided. The daemon is a tokio listener and uses the async pair; the
//! transient hook client opens one socket, writes one frame, reads one frame and
//! exits, so it uses the sync pair and can build with
//! `default-features = false`. The two share `validate_declared` and
//! `encode_len`, so the size rules cannot drift between them.

use std::io::{self, Read, Write};

/// Maximum body length, in bytes: 1 MiB.
///
/// This matches the existing 1 MB stdin cap in `handleHookEvent`, so a payload
/// that the legacy path would have discarded cannot become a daemon-path OOM
/// instead.
pub const MAX_FRAME_BODY: usize = 1_048_576;

/// Width of the big-endian length prefix.
pub const LENGTH_PREFIX_LEN: usize = 4;

/// A framing-layer failure.
///
/// The three EOF cases are deliberately distinct constructors rather than one
/// `UnexpectedEof`: [`FrameError::Closed`] is a *clean disconnect* (the peer
/// went away between frames, which is normal and not an error to report), while
/// [`FrameError::TruncatedLength`] and [`FrameError::TruncatedBody`] mean the
/// peer died mid-frame and the connection is no longer interpretable.
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    /// EOF at a frame boundary: the peer closed cleanly. Not a protocol error.
    #[error("peer closed the connection at a frame boundary")]
    Closed,

    /// EOF after a partial length prefix.
    #[error("peer closed after {read} of {LENGTH_PREFIX_LEN} length-prefix bytes")]
    TruncatedLength {
        /// How many of the four prefix bytes arrived before EOF (1..=3).
        read: usize,
    },

    /// EOF part-way through a body whose length had already been declared.
    #[error("peer closed after {read} of {declared} declared body bytes")]
    TruncatedBody {
        /// The length the prefix declared.
        declared: usize,
        /// How many body bytes arrived before EOF.
        read: usize,
    },

    /// A declared (or requested) body length above [`MAX_FRAME_BODY`].
    ///
    /// Raised *before* the body buffer is allocated, so a hostile `u32::MAX`
    /// prefix costs four bytes of read, not 4 GiB of memory.
    #[error("declared body length {declared} exceeds the 1 MiB maximum")]
    TooLarge {
        /// The rejected length, as declared on the wire.
        declared: u32,
    },

    /// A zero-length body.
    ///
    /// A frame carries exactly one JSON value, and the shortest legal encoding
    /// of a JSON value is one byte, so a zero-length body is malformed rather
    /// than an "empty message".
    #[error("zero-length body is not a valid frame")]
    ZeroLength,

    /// The underlying transport failed.
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl FrameError {
    /// Whether this is the normal end of a connection rather than a fault.
    ///
    /// A listener loop uses this to distinguish "the client finished" from "the
    /// client crashed mid-frame", which are logged very differently.
    #[must_use]
    pub const fn is_clean_disconnect(&self) -> bool {
        matches!(self, Self::Closed)
    }

    /// The protocol error code to report to the peer, if one can be reported.
    ///
    /// [`FrameError::Closed`] and [`FrameError::Io`] return `None`: in both
    /// cases the transport is already gone, so there is nothing to write a
    /// reply onto. Everything else is answerable, and PROTOCOL.md requires the
    /// daemon to answer if it can before closing.
    #[must_use]
    pub const fn error_code(&self) -> Option<crate::envelope::ErrorCode> {
        use crate::envelope::ErrorCode;
        match self {
            Self::Closed | Self::Io(_) => None,
            Self::TooLarge { .. } => Some(ErrorCode::FrameTooLarge),
            Self::TruncatedLength { .. } | Self::TruncatedBody { .. } | Self::ZeroLength => {
                Some(ErrorCode::MalformedFrame)
            }
        }
    }
}

/// Validate a length read off the wire, **before** any allocation.
///
/// The ordering here is the whole point of the function: nothing in this crate
/// may turn an attacker-chosen `u32` into a capacity.
fn validate_declared(declared: u32) -> Result<usize, FrameError> {
    if declared == 0 {
        return Err(FrameError::ZeroLength);
    }
    if u64::from(declared) > MAX_FRAME_BODY as u64 {
        return Err(FrameError::TooLarge { declared });
    }
    // Infallible: `declared` is now known to be in 1..=MAX_FRAME_BODY, and
    // MAX_FRAME_BODY is a usize.
    Ok(declared as usize)
}

/// Validate an outbound body and compute its prefix.
fn encode_len(body: &[u8]) -> Result<u32, FrameError> {
    // Saturating, only ever used to fill in the error's diagnostic field.
    let declared = u32::try_from(body.len()).unwrap_or(u32::MAX);
    if body.is_empty() {
        return Err(FrameError::ZeroLength);
    }
    if body.len() > MAX_FRAME_BODY {
        return Err(FrameError::TooLarge { declared });
    }
    Ok(declared)
}

/// Build the on-wire bytes for one frame.
///
/// The prefix and body are emitted from a single buffer so that one `write_all`
/// carries the whole frame: a failure part-way through cannot leave a length
/// prefix on the stream with no body behind it, which would desynchronize the
/// peer permanently. The extra copy is bounded by [`MAX_FRAME_BODY`].
fn frame_bytes(body: &[u8]) -> Result<Vec<u8>, FrameError> {
    let declared = encode_len(body)?;
    let mut framed = Vec::with_capacity(LENGTH_PREFIX_LEN + body.len());
    framed.extend_from_slice(&declared.to_be_bytes());
    framed.extend_from_slice(body);
    Ok(framed)
}

/// Read into `buf` until it is full or the peer closes; return how much arrived.
fn fill<R: Read + ?Sized>(r: &mut R, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Write one frame: big-endian `u32` length prefix followed by `body`.
///
/// Does not flush; wrap the writer in a `BufWriter` and flush at the call site
/// if that is what you want.
///
/// # Errors
///
/// [`FrameError::ZeroLength`] for an empty body, [`FrameError::TooLarge`] for a
/// body above [`MAX_FRAME_BODY`], [`FrameError::Io`] if the transport fails.
///
/// ```
/// use fpai_ipc::framing::{read_frame, write_frame};
///
/// let mut wire = Vec::new();
/// write_frame(&mut wire, br#"{"hello":{}}"#).unwrap();
/// assert_eq!(&wire[..4], &[0, 0, 0, 12]);
/// assert_eq!(read_frame(&mut wire.as_slice()).unwrap(), br#"{"hello":{}}"#);
/// ```
pub fn write_frame<W: Write + ?Sized>(w: &mut W, body: &[u8]) -> Result<(), FrameError> {
    w.write_all(&frame_bytes(body)?)?;
    Ok(())
}

/// Read one frame, returning its body.
///
/// # Errors
///
/// [`FrameError::Closed`] at a clean frame boundary, [`FrameError::TruncatedLength`]
/// or [`FrameError::TruncatedBody`] on a short read, [`FrameError::TooLarge`] for
/// a declared length above [`MAX_FRAME_BODY`] (raised before allocating),
/// [`FrameError::ZeroLength`] for a declared length of zero, [`FrameError::Io`]
/// if the transport fails.
pub fn read_frame<R: Read + ?Sized>(r: &mut R) -> Result<Vec<u8>, FrameError> {
    let mut prefix = [0u8; LENGTH_PREFIX_LEN];
    match fill(r, &mut prefix)? {
        0 => return Err(FrameError::Closed),
        LENGTH_PREFIX_LEN => {}
        read => return Err(FrameError::TruncatedLength { read }),
    }

    let declared = validate_declared(u32::from_be_bytes(prefix))?;

    let mut body = vec![0u8; declared];
    let read = fill(r, &mut body)?;
    if read != declared {
        return Err(FrameError::TruncatedBody { declared, read });
    }
    Ok(body)
}

#[cfg(feature = "tokio")]
mod asynchronous {
    use super::{FrameError, LENGTH_PREFIX_LEN, frame_bytes, validate_declared};
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

    /// Read into `buf` until it is full or the peer closes; return how much arrived.
    ///
    /// `AsyncReadExt::read_exact` is deliberately not used: it collapses every
    /// EOF into one `UnexpectedEof`, which would erase the clean-disconnect /
    /// truncated-frame distinction the sync path preserves.
    async fn fill<R: AsyncRead + Unpin + ?Sized>(
        r: &mut R,
        buf: &mut [u8],
    ) -> std::io::Result<usize> {
        let mut filled = 0;
        while filled < buf.len() {
            match r.read(&mut buf[filled..]).await {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(filled)
    }

    /// Async [`super::write_frame`].
    ///
    /// # Errors
    ///
    /// Identical to [`super::write_frame`].
    pub async fn write_frame_async<W: AsyncWrite + Unpin + ?Sized>(
        w: &mut W,
        body: &[u8],
    ) -> Result<(), FrameError> {
        w.write_all(&frame_bytes(body)?).await?;
        Ok(())
    }

    /// Async [`super::read_frame`].
    ///
    /// # Errors
    ///
    /// Identical to [`super::read_frame`], including rejecting an oversize
    /// declared length before allocating the body buffer.
    pub async fn read_frame_async<R: AsyncRead + Unpin + ?Sized>(
        r: &mut R,
    ) -> Result<Vec<u8>, FrameError> {
        let mut prefix = [0u8; LENGTH_PREFIX_LEN];
        match fill(r, &mut prefix).await? {
            0 => return Err(FrameError::Closed),
            LENGTH_PREFIX_LEN => {}
            read => return Err(FrameError::TruncatedLength { read }),
        }

        let declared = validate_declared(u32::from_be_bytes(prefix))?;

        let mut body = vec![0u8; declared];
        let read = fill(r, &mut body).await?;
        if read != declared {
            return Err(FrameError::TruncatedBody { declared, read });
        }
        Ok(body)
    }
}

#[cfg(feature = "tokio")]
pub use asynchronous::{read_frame_async, write_frame_async};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_body() {
        let mut wire = Vec::new();
        write_frame(&mut wire, b"{}").unwrap();
        assert_eq!(wire, vec![0, 0, 0, 2, b'{', b'}']);
        assert_eq!(read_frame(&mut wire.as_slice()).unwrap(), b"{}");
    }

    #[test]
    fn reads_frames_back_to_back_then_reports_clean_close() {
        let mut wire = Vec::new();
        write_frame(&mut wire, b"{\"a\":1}").unwrap();
        write_frame(&mut wire, b"{\"b\":2}").unwrap();

        let mut cursor = wire.as_slice();
        assert_eq!(read_frame(&mut cursor).unwrap(), b"{\"a\":1}");
        assert_eq!(read_frame(&mut cursor).unwrap(), b"{\"b\":2}");

        let err = read_frame(&mut cursor).unwrap_err();
        assert!(matches!(err, FrameError::Closed), "got {err:?}");
        assert!(err.is_clean_disconnect());
        assert_eq!(err.error_code(), None);
    }

    #[test]
    fn eof_mid_body_is_distinct_from_eof_at_a_boundary() {
        let mut wire = Vec::new();
        write_frame(&mut wire, b"{\"abc\":1}").unwrap();
        wire.truncate(wire.len() - 3);

        let err = read_frame(&mut wire.as_slice()).unwrap_err();
        assert!(
            matches!(
                err,
                FrameError::TruncatedBody {
                    declared: 9,
                    read: 6
                }
            ),
            "got {err:?}"
        );
        assert!(!err.is_clean_disconnect());
        assert_eq!(
            err.error_code(),
            Some(crate::envelope::ErrorCode::MalformedFrame)
        );
    }

    #[test]
    fn eof_mid_length_prefix_is_truncation_not_a_clean_close() {
        let err = read_frame(&mut [0u8, 0, 1].as_slice()).unwrap_err();
        assert!(
            matches!(err, FrameError::TruncatedLength { read: 3 }),
            "got {err:?}"
        );
        assert!(!err.is_clean_disconnect());
    }

    #[test]
    fn zero_length_body_is_malformed_in_both_directions() {
        let err = read_frame(&mut [0u8, 0, 0, 0].as_slice()).unwrap_err();
        assert!(matches!(err, FrameError::ZeroLength), "got {err:?}");

        let err = write_frame(&mut Vec::new(), b"").unwrap_err();
        assert!(matches!(err, FrameError::ZeroLength), "got {err:?}");
    }

    #[test]
    fn accepts_a_body_of_exactly_the_maximum() {
        let body = vec![b'x'; MAX_FRAME_BODY];
        let mut wire = Vec::new();
        write_frame(&mut wire, &body).unwrap();
        assert_eq!(
            read_frame(&mut wire.as_slice()).unwrap().len(),
            MAX_FRAME_BODY
        );
    }

    #[test]
    fn rejects_one_byte_over_the_maximum_in_both_directions() {
        let over = u32::try_from(MAX_FRAME_BODY + 1).unwrap();
        let mut wire = over.to_be_bytes().to_vec();
        wire.extend_from_slice(b"x");

        let err = read_frame(&mut wire.as_slice()).unwrap_err();
        assert!(
            matches!(err, FrameError::TooLarge { declared } if declared == over),
            "got {err:?}"
        );
        assert_eq!(
            err.error_code(),
            Some(crate::envelope::ErrorCode::FrameTooLarge)
        );

        let err = write_frame(&mut Vec::new(), &vec![b'x'; MAX_FRAME_BODY + 1]).unwrap_err();
        assert!(
            matches!(err, FrameError::TooLarge { declared } if declared == over),
            "got {err:?}"
        );
    }

    /// A reader that panics if it is read from after the length prefix.
    ///
    /// This is the cheap half of the oversize proof — it shows `read_frame`
    /// never even *tries* to pull a 4 GiB body. The other half, that it never
    /// allocates one either, is `tests/no_huge_alloc.rs`, which counts bytes
    /// through a tracking global allocator.
    struct PrefixOnly {
        prefix: [u8; 4],
        consumed: bool,
    }

    impl Read for PrefixOnly {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            assert!(
                !self.consumed,
                "read_frame read past a rejected length prefix"
            );
            self.consumed = true;
            let n = buf.len().min(4);
            buf[..n].copy_from_slice(&self.prefix[..n]);
            Ok(n)
        }
    }

    #[test]
    fn u32_max_prefix_is_rejected_without_touching_the_body() {
        let mut reader = PrefixOnly {
            prefix: u32::MAX.to_be_bytes(),
            consumed: false,
        };
        let err = read_frame(&mut reader).unwrap_err();
        assert!(
            matches!(err, FrameError::TooLarge { declared: u32::MAX }),
            "got {err:?}"
        );
    }

    #[test]
    fn interrupted_reads_are_retried() {
        struct Flaky {
            wire: Vec<u8>,
            pos: usize,
            interrupt_next: bool,
        }
        impl Read for Flaky {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if self.interrupt_next {
                    self.interrupt_next = false;
                    return Err(io::Error::from(io::ErrorKind::Interrupted));
                }
                self.interrupt_next = true;
                if self.pos >= self.wire.len() {
                    return Ok(0);
                }
                buf[0] = self.wire[self.pos];
                self.pos += 1;
                Ok(1)
            }
        }

        let mut wire = Vec::new();
        write_frame(&mut wire, b"{\"k\":true}").unwrap();
        let mut flaky = Flaky {
            wire,
            pos: 0,
            interrupt_next: true,
        };
        assert_eq!(read_frame(&mut flaky).unwrap(), b"{\"k\":true}");
    }

    #[cfg(feature = "tokio")]
    mod async_tests {
        use super::super::*;

        #[tokio::test]
        async fn async_round_trips_and_matches_the_sync_encoding() {
            let mut wire = Vec::new();
            write_frame_async(&mut wire, b"{\"a\":1}").await.unwrap();

            let mut sync_wire = Vec::new();
            write_frame(&mut sync_wire, b"{\"a\":1}").unwrap();
            assert_eq!(wire, sync_wire);

            assert_eq!(
                read_frame_async(&mut wire.as_slice()).await.unwrap(),
                b"{\"a\":1}"
            );
        }

        #[tokio::test]
        async fn async_distinguishes_clean_close_from_truncation() {
            let empty: &[u8] = &[];
            let err = read_frame_async(&mut &empty[..]).await.unwrap_err();
            assert!(err.is_clean_disconnect(), "got {err:?}");

            let mut wire = Vec::new();
            write_frame_async(&mut wire, b"{\"a\":1}").await.unwrap();
            wire.truncate(5);
            let err = read_frame_async(&mut wire.as_slice()).await.unwrap_err();
            assert!(
                matches!(
                    err,
                    FrameError::TruncatedBody {
                        declared: 7,
                        read: 1
                    }
                ),
                "got {err:?}"
            );
        }

        #[tokio::test]
        async fn async_rejects_oversize_before_reading_a_body() {
            let mut wire = u32::MAX.to_be_bytes().to_vec();
            wire.extend_from_slice(b"x");
            let err = read_frame_async(&mut wire.as_slice()).await.unwrap_err();
            assert!(
                matches!(err, FrameError::TooLarge { declared: u32::MAX }),
                "got {err:?}"
            );
        }

        #[tokio::test]
        async fn async_rejects_zero_length() {
            let err = read_frame_async(&mut [0u8, 0, 0, 0].as_slice())
                .await
                .unwrap_err();
            assert!(matches!(err, FrameError::ZeroLength), "got {err:?}");
        }
    }
}
