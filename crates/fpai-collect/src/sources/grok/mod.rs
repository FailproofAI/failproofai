//! grok CLI session capture — a [`filetail`](crate::filetail) adapter.
//!
//! grok stores a session as a DIRECTORY, not a file:
//! `~/.grok/sessions/<percent-encoded-cwd>/<sessionId>/chat_history.jsonl`,
//! beside `events.jsonl`, `summary.json` and lock files we never touch. We open
//! the transcript read-only; grok's own files are never written or moved.
//!
//! Three things make this the odd one out, and each shapes the code below:
//!
//! 1. **The session id is the PARENT DIRECTORY**, not the filename — every
//!    session's transcript is called `chat_history.jsonl`.
//! 2. **The cwd folder is PERCENT-encoded** (`%2Fhome%2Fyou%2Frepo`), where
//!    Claude/Factory/Qwen dash-encode. It decodes losslessly, so unlike those
//!    the agent id can come straight from the path.
//! 3. **The transcript carries NO timestamps at all.** Per-event times live in
//!    the sibling `events.jsonl`, which is not 1:1 with the turns. Rather than
//!    mis-pair them this takes the cursor source's approach: stamp from the
//!    file's mtime (`Ctx::file_epoch_ms`, captured once at discovery) plus the
//!    byte offset, which keeps time approximately real AND a pure function of
//!    the inputs, as the content-hash dedup requires.

pub mod transform;

use std::path::Path;

use crate::filetail::{Format, RereadPolicy, no_seed_state};

/// Transcripts: a `chat_history.jsonl` whose parent directory is a uuid.
pub const FORMAT: Format = Format {
    kind: "grok",
    is_source_file: is_transcript,
    session_id_from_path,
    agent_id_from_path,
    agent_start: transform::agent_start,
    seed_state: no_seed_state,
    agent_end: transform::agent_end,
    transform_line: transform::transform_line,
    // grok appends to chat_history.jsonl. A wholesale rewrite changes the size
    // and the engine re-reads from zero; offset-keyed events then hash
    // identically, so the server collapses the re-ship.
    reread: RereadPolicy::ByteCursor,
};

/// The agent id used when the folder yields no project.
pub const DEFAULT_AGENT_ID: &str = "grok";

/// The one filename grok gives every session transcript.
const TRANSCRIPT: &str = "chat_history.jsonl";

const UUID_LEN: usize = 36;

/// `8-4-4-4-12` hex, checked positionally. grok mints UUIDv7s, which are
/// positionally identical.
fn is_uuid36(s: &str) -> bool {
    s.len() == UUID_LEN
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// A transcript is exactly `<uuid>/chat_history.jsonl`. The recursive walk means
/// this predicate is the whole filter; requiring both the filename and a uuid
/// parent excludes `events.jsonl`, `rewind_points.jsonl` and every lock file.
fn is_transcript(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()) == Some(TRANSCRIPT)
        && session_id_from_path(path).is_some()
}

/// The session id is the PARENT directory name, since every transcript shares
/// one filename.
fn session_id_from_path(path: &Path) -> Option<String> {
    let dir = path.parent()?.file_name()?.to_str()?;
    is_uuid36(dir).then(|| dir.to_string())
}

/// `grok-<project>` from the percent-encoded cwd folder that CONTAINS the
/// session dir (`…/<%2Fpath%2Fto%2Frepo>/<uuid>/chat_history.jsonl`).
///
/// Percent-encoding is reversible, so unlike Factory/Qwen this needs no lookup
/// inside the file — but the header is still consulted as a fallback for a
/// folder that fails to decode.
fn agent_id_from_path(path: &Path, _header: &[String]) -> Option<String> {
    let folder = path.parent()?.parent()?.file_name()?.to_str()?;
    transform::agent_id_from_folder(folder)
}
