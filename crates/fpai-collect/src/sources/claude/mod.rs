//! Claude Code session capture — a [`filetail`](crate::filetail) adapter.
//!
//! Claude Code writes live-appended JSONL transcripts under
//! `~/.claude/projects/<slug>/<sessionId>.jsonl`. We open them read-only and
//! turn each newly-appended line into AgentEye events; Claude Code's own files
//! are never written, moved or deleted.
//!
//! # Siblings that must not be tailed
//!
//! Three live in the same tree and each breaks something different:
//!
//! * `<sessionId>.jsonl.tool-calls.json` — rewritten **in place**, so a byte
//!   cursor would re-ship its contents forever. Excluded by requiring `.jsonl`.
//! * `subagents/**/journal.jsonl` — a different two-field schema. Excluded by
//!   requiring a bare-UUID stem.
//! * `~/.claude/history.jsonl` — out of scope by construction, since the
//!   configured root is `projects/` rather than the home.
//!
//! # `/compact` rewrites the transcript
//!
//! Compaction can shrink the file. The engine detects the shrink and re-reads
//! from zero, which re-ships the surviving prefix; the server dedups it because
//! every event is a pure function of its line and offset.
//!
//! # Scope
//!
//! This covers the event types that carry the session: start/end, user prompts,
//! assistant turns, and tool calls with their results. Subagent transcripts
//! (`<sessionId>/subagents/agent-*.jsonl`), thinking blocks, compact
//! boundaries and synthetic error turns are deliberately not handled yet — they
//! need their own `Format` or their own event types, and are tracked as
//! follow-on work rather than half-implemented here.

pub mod transform;

use std::path::Path;

use crate::cursor::TailState;
use crate::filetail::{Format, RereadPolicy};
use serde_json::Value;

/// Main transcripts: `<uuid>.jsonl` directly inside a project directory.
pub const FORMAT: Format = Format {
    kind: "claude",
    is_source_file: is_transcript,
    session_id_from_path,
    agent_id_from_path,
    agent_start: transform::agent_start,
    seed_state,
    agent_end: transform::agent_end,
    transform_line: transform::transform_line,
    reread: RereadPolicy::ByteCursor,
};

const SUBAGENTS_DIR: &str = "subagents";

fn is_uuid36(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn under_subagents(path: &Path) -> bool {
    path.ancestors()
        .skip(1)
        .any(|a| a.file_name().is_some_and(|n| n == SUBAGENTS_DIR))
}

/// A main transcript is `<uuid>.jsonl` not under a `subagents/` ancestor.
///
/// The walk is recursive, so this predicate carries the whole filter. The
/// `.jsonl` requirement excludes the in-place-rewritten `.tool-calls.json`; the
/// bare-UUID stem excludes `journal.jsonl`; the `subagents` check keeps this
/// from claiming files a future subagent format will own, which would otherwise
/// ship every subagent line twice under two session ids.
fn is_transcript(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let Some(stem) = name.strip_suffix(".jsonl") else {
        return false;
    };
    is_uuid36(stem) && !under_subagents(path)
}

/// The filename stem IS the session id.
///
/// Deliberately the only source of it: taking it from the file's header too
/// would give two answers that could disagree, and the path is what the cursor
/// and the hook-activity source both key on.
fn session_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_name()?.to_str()?.strip_suffix(".jsonl")?;
    is_uuid36(stem).then(|| stem.to_string())
}

/// `claude-<project>`, from the real `cwd` on the transcript's first lines.
///
/// NOT decoded from the directory name. Claude Code encodes the working
/// directory by replacing every `/` with `-`, and folder names contain `-`
/// too — so the encoding is not invertible. Measured on this machine, 3 of 16
/// project directories decode wrongly by splitting on the last `-`
/// (`openclaw-local`, `agentic-test`, `sensor-app`). The `cwd` field is exact.
///
/// The scheme matches what the hook-activity source derives, so hook events and
/// transcript events for one run land under a single agent rather than two that
/// look unrelated.
fn agent_id_from_path(_path: &Path, header: &[String]) -> Option<String> {
    let cwd = header.iter().find_map(|line| {
        serde_json::from_str::<Value>(line)
            .ok()?
            .get("cwd")?
            .as_str()
            .map(str::to_string)
    })?;
    let project = transform::sanitize_id_part(
        cwd.trim_end_matches('/')
            .rsplit('/')
            .find(|p| !p.is_empty())?,
    );
    (!project.is_empty()).then(|| format!("claude-{project}"))
}

/// Prime the model from the header so the session's FIRST prompt is not blank.
///
/// A user line carries no model and inherits it from the preceding assistant
/// line — and the first prompt of a session has no preceding assistant line at
/// all. The server builds a `model_request` row's summary from the model alone,
/// so without this the opening row of every session renders empty, which is the
/// row most likely to be looked at.
///
/// See the warning on [`Format::seed_state`]: this is not dedup-safe between a
/// live tail and a later full re-read. Accepted deliberately here — a blank
/// opening row is a permanent visible defect, a duplicate is a transient one.
fn seed_state(header: &[String], state: &mut TailState) {
    for line in header {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(model) = v
            .get("message")
            .and_then(|m| m.get("model"))
            .and_then(|m| m.as_str())
        {
            state.last_model = Some(model.to_string());
            return;
        }
    }
}

/// The agent id used when nothing can be derived.
pub const DEFAULT_AGENT_ID: &str = "claude";
