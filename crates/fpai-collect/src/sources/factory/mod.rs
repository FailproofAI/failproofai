//! Factory (droid) CLI session capture — a [`filetail`](crate::filetail) adapter.
//!
//! Factory writes live-appended JSONL under
//! `~/.factory/sessions/<encoded-cwd>/<sessionId>.jsonl`, one file per session,
//! alongside a `<sessionId>.settings.json` sibling we never touch. We open the
//! transcripts read-only and turn each newly-appended line into AgentEye
//! events; Factory's own files are never written, moved or deleted.
//!
//! # The encoded-cwd folder is lossy, so the agent id comes from inside
//!
//! The directory name is a Claude-style encoded cwd (`-home-chetan-Desktop-x`),
//! which cannot be decoded back to a path unambiguously. The real working
//! directory is in the `session_start` line, so [`agent_id_from_path`] reads it
//! from the header — matching the scheme the hook source derives from the same
//! cwd, so a hook event and this transcript's events share one agent id.
//!
//! # The session id comes from the filename
//!
//! The `<sessionId>.jsonl` stem is the session's uuid and is what the cursor
//! keys on, so it is the only source of the id — the in-file `session_start.id`
//! is not consulted.
//!
//! # First line is rewritten in place
//!
//! Factory rewrites the `session_start` line when it names the session (title),
//! which moves every later byte offset — so this uses
//! [`RereadPolicy::ValidatePrefix`], which re-reads line 1 each poll and rebases
//! the cursor by the difference.

pub mod transform;

use std::path::Path;

use crate::filetail::{Format, RereadPolicy, no_seed_state};

/// Transcripts: `<uuid>.jsonl` anywhere under the configured roots. The `.jsonl`
/// requirement excludes the `<uuid>.settings.json` sibling by construction.
pub const FORMAT: Format = Format {
    kind: "factory",
    is_source_file: is_transcript,
    session_id_from_path,
    agent_id_from_path,
    agent_start: transform::agent_start,
    // `session_start` carries the model on later assistant lines, not up front,
    // and nothing needs priming before the first content line.
    seed_state: no_seed_state,
    agent_end: transform::agent_end,
    transform_line: transform::transform_line,
    reread: RereadPolicy::ValidatePrefix,
};

/// The agent id used when the header carries no cwd.
pub const DEFAULT_AGENT_ID: &str = "factory";

const UUID_LEN: usize = 36;

/// `8-4-4-4-12` hex, checked positionally.
fn is_uuid36(s: &str) -> bool {
    s.len() == UUID_LEN
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// A transcript is `<uuid>.jsonl`. The recursive walk means this predicate is
/// the whole filter; requiring the uuid stem excludes any other `.jsonl` a
/// widened root might contain.
fn is_transcript(path: &Path) -> bool {
    session_id_from_path(path).is_some()
}

/// The uuid embedded in the filename IS the session id.
fn session_id_from_path(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_suffix(".jsonl")?;
    is_uuid36(stem).then(|| stem.to_string())
}

/// `factory-<project>`, from the real `cwd` on the `session_start` line.
fn agent_id_from_path(_path: &Path, header: &[String]) -> Option<String> {
    let cwd = header.iter().find_map(|line| {
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        (v.get("type")?.as_str()? == "session_start")
            .then(|| v.get("cwd")?.as_str().map(str::to_string))
            .flatten()
    })?;
    transform::agent_id_from_cwd(&cwd)
}
