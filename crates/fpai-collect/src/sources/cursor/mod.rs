//! Cursor CLI session capture — a [`filetail`](crate::filetail) adapter.
//!
//! Cursor writes live transcripts under
//! `~/.cursor/projects/<flattened-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl`,
//! one file per session. We open them read-only and turn each newly-appended
//! line into AgentEye events; Cursor's own files are never written.
//!
//! # No timestamps — the file's mtime is the anchor
//!
//! A cursor transcript carries no timestamps on any line. The engine captures
//! the file's mtime once at discovery and hands it to the transform on `Ctx`
//! (`file_epoch_ms`), which stamps each event at that base plus the byte offset
//! in microseconds — real (about when the session ran) and pure (stable across
//! re-reads). See `transform::synth_ts`.
//!
//! # The session id comes from the filename
//!
//! The `<sessionId>.jsonl` stem is the uuid and equals its parent directory
//! name; the cursor keys on it. The flattened-cwd folder is the only cwd signal
//! (the transcript itself carries none) and is lossy, so the agent id is a
//! best-effort `cursor-<project>` from its last segment.

pub mod transform;

use std::path::Path;

use crate::filetail::{Format, RereadPolicy, no_seed_state};

/// Transcripts: `<uuid>.jsonl` whose stem equals its parent dir, under an
/// `agent-transcripts` ancestor.
pub const FORMAT: Format = Format {
    kind: "cursor",
    is_source_file: is_transcript,
    session_id_from_path,
    agent_id_from_path,
    agent_start: transform::agent_start,
    seed_state: no_seed_state,
    agent_end: transform::agent_end,
    transform_line: transform::transform_line,
    // Cursor appends; if it ever rewrites a transcript wholesale the size
    // changes, and the engine's shrink-detection re-reads from zero — the
    // offset-keyed events then hash identically, so the server collapses the
    // re-ship rather than double-counting.
    reread: RereadPolicy::ByteCursor,
};

/// The agent id used when the folder yields no project.
pub const DEFAULT_AGENT_ID: &str = "cursor";

const UUID_LEN: usize = 36;

/// `8-4-4-4-12` hex, checked positionally.
fn is_uuid36(s: &str) -> bool {
    s.len() == UUID_LEN
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// A transcript is `<uuid>.jsonl` whose stem equals its parent directory name
/// (Cursor nests each session in its own uuid dir) and sits under an
/// `agent-transcripts` ancestor. The recursive walk means this is the whole
/// filter; the parent-name and ancestor checks exclude any other `.jsonl`.
fn is_transcript(path: &Path) -> bool {
    let Some(uuid) = session_id_from_path(path) else {
        return false;
    };
    let parent_ok = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        == Some(uuid.as_str());
    let under_transcripts = path
        .components()
        .any(|c| c.as_os_str() == "agent-transcripts");
    parent_ok && under_transcripts
}

/// The uuid embedded in the filename IS the session id.
fn session_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_name()?.to_str()?.strip_suffix(".jsonl")?;
    is_uuid36(stem).then(|| stem.to_string())
}

/// `cursor-<project>` from the flattened-cwd folder that CONTAINS
/// `agent-transcripts` (`…/<folder>/agent-transcripts/<uuid>/<uuid>.jsonl`).
fn agent_id_from_path(path: &Path, _header: &[String]) -> Option<String> {
    let mut prev: Option<&std::ffi::OsStr> = None;
    for c in path.components() {
        if c.as_os_str() == "agent-transcripts" {
            return transform::agent_id_from_folder(prev?.to_str()?);
        }
        prev = Some(c.as_os_str());
    }
    None
}
