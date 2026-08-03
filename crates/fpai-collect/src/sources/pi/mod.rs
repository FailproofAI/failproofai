//! Pi (`@mariozechner/pi-coding-agent`) session capture — a
//! [`filetail`](crate::filetail) adapter.
//!
//! pi writes one JSONL transcript per session under
//! `~/.pi/agent/sessions/<encoded-cwd>/<ISO-timestamp>_<uuid>.jsonl`. We open
//! them read-only and turn each newly-appended line into AgentEye events; pi's
//! own files are never written, moved or deleted.
//!
//! # The file does not exist until the first assistant message completes
//!
//! `SessionManager._persist()` short-circuits while the session has no
//! assistant message in it, buffering entries in memory and marking itself
//! unflushed; the first assistant response then writes the whole prefix at
//! once. Measured on a live run: the file appeared at 1551 bytes, already
//! containing the header, the model change, the thinking-level change, the user
//! prompt and the assistant turn.
//!
//! Two consequences, both of which look like bugs if you do not know this:
//!
//! * **A run killed before its first assistant message leaves ZERO trace on
//!   disk.** Discovery finding nothing in a directory pi is actively writing to
//!   is normal, not an error, and must never be logged or handled as one.
//! * The engine's `agent_start` retry loop is never exercised for pi in
//!   practice — by the time a file exists, its header is complete — which is
//!   also why [`Format::seed_state`](crate::filetail::Format::seed_state) is
//!   left as a no-op here. See `transform_line`'s `model_change` arm: pi orders
//!   the model ahead of the first prompt inside the file itself, so the opening
//!   row is never blank and nothing has to be seeded out of band. That matters
//!   because seeding is the one part of the format table that is NOT dedup-safe
//!   between a live tail and a later full re-read.
//!
//! # `_rewriteFile()` rewrites the whole file, but only on cold paths
//!
//! Steady-state turns are `appendFileSync`, so a byte cursor is correct and
//! [`RereadPolicy::ByteCursor`] is what this format declares. Two paths do a
//! full `writeFileSync` over an existing transcript:
//!
//! * resuming a file whose entries all failed to parse — it is replaced by a
//!   lone fresh header, a large **shrink**;
//! * migrating a session written by pi with `version < 3`.
//!
//! The shrink case is covered: the engine notices `size < cursor.offset`,
//! resets to zero and re-reads, which re-ships the surviving prefix for the
//! server to dedup. That is the behaviour `a_rewritten_transcript_that_shrank_
//! is_re_read_rather_than_seeked_past` pins. A migration that happens to leave
//! the file the same size or larger would not be detected — accepted, because
//! v3 has been current since well before either probed release and a
//! `ValidatePrefix` policy would not help anyway (the migration rewrites
//! interior records, not line 1).
//!
//! Forking and branching are NOT in that list, contrary to what the shape of
//! the code suggests: both write a **new** file and leave the source transcript
//! untouched, so they appear to this source as an ordinary new session whose
//! header carries a `parentSession` pointer.
//!
//! # Scope
//!
//! Session start/end, user prompts, assistant turns, tool calls and their
//! results. `compaction`, `branch_summary`, `label`, `session_info`, `custom`
//! and `thinking_level_change` records are recognised as records — they keep
//! the session clock moving — but emit no events; they need their own event
//! types rather than being forced into these.

pub mod transform;

use std::path::{Path, PathBuf};

use crate::filetail::{Format, RereadPolicy, no_seed_state};
use serde_json::Value;

/// Session transcripts: `<ISO-timestamp>_<uuid>.jsonl` under an encoded-cwd
/// directory.
pub const FORMAT: Format = Format {
    kind: "pi",
    is_source_file: is_transcript,
    session_id_from_path,
    agent_id_from_path,
    agent_start: transform::agent_start,
    // Deliberately nothing: pi's own record order already primes the model
    // before the first prompt. See the module docs.
    seed_state: no_seed_state,
    agent_end: transform::agent_end,
    transform_line: transform::transform_line,
    reread: RereadPolicy::ByteCursor,
};

/// The agent id used when nothing can be derived.
pub const DEFAULT_AGENT_ID: &str = "pi";

/// Where pi keeps its sessions.
///
/// `PI_CODING_AGENT_DIR` relocates the whole agent directory (`~/.pi/agent`),
/// and sessions hang off it — there is no separate root override. The tilde is
/// expanded because pi expands it too: a value of `~/elsewhere` that we took
/// literally would have us watching a directory named `~` under the process
/// cwd, i.e. capturing nothing, silently.
///
/// Not exhaustive by construction. `PI_CODING_AGENT_SESSION_DIR`, `--session-dir`
/// and a project's `settings.json` can each point ONE session at an arbitrary
/// directory outside this root; those sessions are not discovered. Widening the
/// walk to find them would mean walking the whole filesystem, so they are out of
/// scope rather than half-handled.
pub fn sessions_root() -> PathBuf {
    let agent_dir = match std::env::var_os("PI_CODING_AGENT_DIR") {
        Some(raw) => expand_tilde(PathBuf::from(raw)),
        None => home().join(".pi").join("agent"),
    };
    agent_dir.join("sessions")
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn expand_tilde(path: PathBuf) -> PathBuf {
    let Some(s) = path.to_str() else {
        return path;
    };
    match s {
        "~" => home(),
        _ => match s.strip_prefix("~/") {
            Some(rest) => home().join(rest),
            None => path,
        },
    }
}

fn is_uuid36(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// The uuid half of a `<ISO-timestamp>_<uuid>` stem.
///
/// Split from the RIGHT: the timestamp half is `2026-08-03T07-57-44-591Z`, full
/// of the same `-` the uuid uses, so only the underscore separates them
/// reliably. The uuid itself never contains one.
fn uuid_in_stem(stem: &str) -> Option<&str> {
    let (ts, id) = stem.rsplit_once('_')?;
    (!ts.is_empty() && is_uuid36(id)).then_some(id)
}

/// A transcript is `<ISO-timestamp>_<uuid>.jsonl`.
///
/// The walk is recursive, so this predicate carries the whole filter. Requiring
/// both halves of the stem keeps this from claiming anything an operator (or a
/// future pi) drops beside the transcripts — an editor's `.jsonl~`, an export,
/// a hand-made note — any of which a byte cursor would otherwise tail as if it
/// were a session.
fn is_transcript(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_suffix(".jsonl"))
        .and_then(uuid_in_stem)
        .is_some()
}

/// The uuid after the `_` in the filename IS the session id.
///
/// Deliberately the only source of it: the header's `id` field holds the same
/// value, but taking it from both would give two answers that could disagree,
/// and the path is what the cursor keys on. The uuid is also what the hook
/// source reports as `session_id`, so hook events and transcript events for one
/// run land on a single timeline.
fn session_id_from_path(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_suffix(".jsonl"))
        .and_then(uuid_in_stem)
        .map(str::to_string)
}

/// `pi-<project>`, from the real `cwd` on the transcript's header.
///
/// NOT decoded from the directory name. pi encodes the working directory as
/// `--${cwd.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--`, mapping every
/// separator to `-` while leaving literal `-` alone — so the encoding is not
/// invertible, and the loss is not a corner case: the probe's own
/// `/tmp/probe-pi` becomes `--tmp-probe-pi--`, which decodes back to
/// `/tmp/probe/pi` and yields the project name `pi` instead of `probe-pi`. The
/// `cwd` field on line 1 is exact.
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
    (!project.is_empty()).then(|| format!("pi-{project}"))
}
