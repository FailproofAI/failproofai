//! Qwen Code session capture — a [`filetail`](crate::filetail) adapter.
//!
//! qwen writes live-appended JSONL at
//! `~/.qwen/projects/<encoded-cwd>/chats/<sessionId>.jsonl`, one file per
//! session. We open them read-only; qwen's own files are never written, moved
//! or deleted.
//!
//! # Closest to Factory on disk, furthest from it inside
//!
//! The layout is Factory's (Claude-style encoded-cwd folder, `<uuid>.jsonl`
//! stem) with one extra `chats/` level. The BODIES are not: qwen descends from
//! Gemini CLI, so a message is `message.parts[]` of `{text}` /
//! `{functionCall}` / `{functionResponse}` and the assistant role is spelled
//! `"model"`. See [`transform`].
//!
//! # The encoded-cwd folder is lossy, so the agent id comes from inside
//!
//! Every line carries a real `cwd`, which is what [`agent_id_from_path`] reads
//! — matching the scheme the hook source derives from the same cwd, so a hook
//! event and this transcript's events share one agent id.

pub mod transform;

use std::path::Path;

use crate::filetail::{Format, RereadPolicy, no_seed_state};

/// Transcripts: `<uuid>.jsonl` directly inside a `chats/` directory.
pub const FORMAT: Format = Format {
    kind: "qwen",
    is_source_file: is_transcript,
    session_id_from_path,
    agent_id_from_path,
    agent_start: transform::agent_start,
    // Nothing needs priming: the model is on each assistant line's `model`.
    seed_state: no_seed_state,
    agent_end: transform::agent_end,
    transform_line: transform::transform_line,
    // qwen appends. A wholesale rewrite changes the size, and the engine's
    // shrink-detection re-reads from zero — offset-keyed events then hash
    // identically, so the server collapses the re-ship rather than doubling it.
    reread: RereadPolicy::ByteCursor,
};

/// The agent id used when no line carries a cwd.
pub const DEFAULT_AGENT_ID: &str = "qwen";

const UUID_LEN: usize = 36;

/// `8-4-4-4-12` hex, checked positionally.
fn is_uuid36(s: &str) -> bool {
    s.len() == UUID_LEN
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// A transcript is `<uuid>.jsonl` whose parent directory is `chats`. The
/// recursive walk means this predicate is the whole filter; requiring the
/// `chats/` parent excludes any other `.jsonl` a widened root might contain.
fn is_transcript(path: &Path) -> bool {
    if session_id_from_path(path).is_none() {
        return false;
    }
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        == Some("chats")
}

/// The uuid embedded in the filename IS the session id.
fn session_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_name()?.to_str()?.strip_suffix(".jsonl")?;
    is_uuid36(stem).then(|| stem.to_string())
}

/// `qwen-<project>`, from the real `cwd` present on every line.
fn agent_id_from_path(_path: &Path, header: &[String]) -> Option<String> {
    let cwd = header.iter().find_map(|line| {
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        v.get("cwd")?.as_str().map(str::to_string)
    })?;
    transform::agent_id_from_cwd(&cwd)
}
