//! Antigravity (agy) CLI session capture — a [`filetail`](crate::filetail) adapter.
//!
//! Antigravity writes one live-appended JSONL transcript per conversation at
//! `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/
//! transcript_full.jsonl`, one step per line, alongside sibling
//! `<conversationId>.trajectory.jsonl` / `.trajectory-path.json` files we never
//! touch. We open the transcripts read-only and turn each newly-appended step
//! into AgentEye events; Antigravity's own files are never written, moved or
//! deleted.
//!
//! # The filename is a constant, so the session id comes from the ancestor dir
//!
//! Every conversation's transcript is named `transcript_full.jsonl`, so the id
//! is NOT in the filename — it names the `brain/<conversationId>/` directory the
//! file sits under. [`session_id_from_path`] walks the path for the UUID
//! directory sitting directly beneath a `brain` segment. The same constant name
//! is why the sibling `<uuid>.trajectory.jsonl` is excluded by
//! [`is_transcript`] for free.
//!
//! # The tree carries no project, so the agent id comes from inside
//!
//! `brain/<uuid>/` records the conversation id and nothing about the work, so —
//! like codex, which files by date — every project on the machine would land
//! under one agent id read off the path. The real working directory is in the
//! first `run_command` tool call's `Cwd` arg, so [`agent_id_from_path`] recovers
//! it from the header instead, matching the scheme the hook source derives from
//! the same cwd so a hook event and this transcript's events share one agent id.
//!
//! # Transcripts are appended, not rewritten in place
//!
//! Steps are strictly appended, so a byte cursor is sufficient
//! ([`RereadPolicy::ByteCursor`]). A `CHECKPOINT` step hints the conversation
//! may later be compacted, but a compaction rewrites the file to a shorter one
//! rather than editing a line in place — which the engine's shrink-detection
//! (offset > size ⇒ re-read from zero) already handles, so no `ValidatePrefix`
//! rebasing is needed.

pub mod transform;

use std::path::Path;

use crate::filetail::{Format, RereadPolicy, no_seed_state};

/// Transcripts: `transcript_full.jsonl` under a `brain/<uuid>/.system_generated/
/// logs/` directory anywhere below the configured roots.
pub const FORMAT: Format = Format {
    kind: "antigravity",
    is_source_file: is_transcript,
    session_id_from_path,
    agent_id_from_path,
    agent_start: transform::agent_start,
    // No `session_meta`-style header primes any carried state, and nothing needs
    // seeding before the first step.
    seed_state: no_seed_state,
    agent_end: transform::agent_end,
    transform_line: transform::transform_line,
    reread: RereadPolicy::ByteCursor,
};

/// The agent id used when the header carries no recoverable cwd.
pub const DEFAULT_AGENT_ID: &str = "antigravity";

/// The constant transcript filename, shared by every conversation.
const TRANSCRIPT_FILE: &str = "transcript_full.jsonl";
/// The directory each conversation dir sits directly under.
const BRAIN_DIR: &str = "brain";

const UUID_LEN: usize = 36;

/// `8-4-4-4-12` hex, checked positionally.
fn is_uuid36(s: &str) -> bool {
    s.len() == UUID_LEN
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// A transcript is `transcript_full.jsonl` under a conversation's
/// `.system_generated/logs/` directory.
///
/// The recursive walk means this predicate is the whole filter. The constant
/// filename excludes the sibling `<uuid>.trajectory.jsonl` / `.trajectory-path
/// .json` by construction; requiring the `brain/<uuid>/` ancestor keeps a stray
/// same-named file elsewhere in a widened root from being tailed as a session.
fn is_transcript(path: &Path) -> bool {
    if path.file_name().and_then(|n| n.to_str()) != Some(TRANSCRIPT_FILE) {
        return false;
    }
    let parent = path.parent();
    let in_logs = parent.and_then(|p| p.file_name()).and_then(|n| n.to_str()) == Some("logs")
        && parent
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            == Some(".system_generated");
    in_logs && session_id_from_path(path).is_some()
}

/// The conversation UUID naming the `brain/<uuid>/` ancestor IS the session id.
///
/// Taken from the ancestor directory rather than the filename, which is the
/// constant `transcript_full.jsonl` for every conversation and carries no id.
/// The walk finds the first UUID component sitting directly under a `brain`
/// segment, so it works whether the root is `brain/` itself or a parent of it.
fn session_id_from_path(path: &Path) -> Option<String> {
    let mut prev: Option<String> = None;
    for comp in path.components() {
        let cur = comp.as_os_str().to_str().map(str::to_string);
        if let (Some(p), Some(c)) = (prev.as_deref(), cur.as_deref())
            && p == BRAIN_DIR
            && is_uuid36(c)
        {
            return Some(c.to_string());
        }
        prev = cur;
    }
    None
}

/// `antigravity-<project>`, from the first `run_command`'s `Cwd` in the header.
///
/// NOT from the path: `brain/<uuid>/` records the conversation id and nothing
/// about the work, so without reading the header every project a developer
/// touches files under one agent id and the product cannot tell them apart. The
/// scheme matches what the hook source derives from the same working directory.
fn agent_id_from_path(_path: &Path, header: &[String]) -> Option<String> {
    let cwd = transform::cwd_from_header(header)?;
    transform::agent_id_from_cwd(&cwd)
}
