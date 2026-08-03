//! OpenClaw session capture — a [`filetail`](crate::filetail) adapter.
//!
//! OpenClaw writes live-appended JSONL transcripts at
//! `<state>/agents/<agentId>/sessions/<sessionId>.jsonl`, where `<state>` is
//! `$OPENCLAW_STATE_DIR`, else `$OPENCLAW_HOME`, else `~/.openclaw`. We open
//! them read-only; OpenClaw's own files are never written, moved or deleted.
//!
//! # The sibling that must never be discovered
//!
//! `<sessionId>.trajectory.jsonl` sits *directly beside* the transcript, shares
//! its stem, and has the same `.jsonl` extension — so the obvious "tail every
//! `.jsonl` under the sessions directory" predicate picks it up. It is an
//! OpenTelemetry trace of the same session, and it is enormous: measured on the
//! probe capture, the transcript is 5,640 bytes and the trajectory beside it is
//! 334,468 — 59x for zero additional information, since every turn it describes
//! is already in the transcript. Shipping it turns ~6 KB per session into
//! ~340 KB, i.e. it decides whether this source is affordable at all. That is
//! why [`is_transcript`] rejects it by name *before* any other check, even
//! though the bare-UUID stem rule would already exclude it — one rule silently
//! loosened must not be able to cost 59x.
//!
//! Three more neighbours are excluded for their own reasons:
//!
//! * `<sessionId>.trajectory-path.json` — a pointer at the trace above.
//!   Excluded by requiring `.jsonl`.
//! * `sessions.json` — the per-agent session index, **rewritten in place** on
//!   every interaction. A byte cursor over a rewritten file re-ships its whole
//!   contents forever. Excluded by requiring `.jsonl` and a UUID stem.
//! * `sessions/skills-prompts/sha256/**` — content-addressed prompt blobs,
//!   nested below the sessions directory. Excluded by requiring the transcript
//!   to sit *directly* in `sessions/`.
//!
//! `<state>/state/openclaw.sqlite` (964 KB on the probe capture) and the
//! agent's `workspace/` git checkout are outside the root entirely — see
//! [`default_roots`], which points at `agents/` rather than the state directory
//! so neither is even walked.
//!
//! # Grouping is by agent, not by working directory
//!
//! Every other source derives its agent id from the session's `cwd`. OpenClaw's
//! `cwd` is the agent *workspace* (`/root/.openclaw/workspace` on the capture —
//! identical in the `session` header and in every tool result's
//! `details.cwd`), which is a fixed per-agent scratch directory and has nothing
//! to do with what the session was about: the probe session read and counted
//! files in `/work`, and `cwd` never mentions it. Grouping on it would file
//! every session of every agent under one meaningless project. The `agentId`
//! path component is the real axis — see [`agent_id_from_path`].
//!
//! # Scope
//!
//! Covers the records that carry the session: its `session` header, the model
//! it runs on, user prompts, assistant text, tool calls and tool results.
//! `thinking_level_change` and `custom` records (bootstrap-context markers,
//! model snapshots) advance the session clock but emit nothing — they describe
//! the harness, not the conversation.

pub mod transform;

use std::path::{Path, PathBuf};

use crate::filetail::{Format, RereadPolicy, no_seed_state};

/// Main transcripts: `<uuid>.jsonl` sitting directly inside a `sessions/`
/// directory.
pub const FORMAT: Format = Format {
    kind: "openclaw",
    is_source_file: is_transcript,
    session_id_from_path,
    agent_id_from_path,
    agent_start: transform::agent_start,
    // No seeding. OpenClaw announces its model in a `model_change` RECORD
    // written before the first user prompt (line 2 of the capture, against the
    // first prompt on line 5), so the model reaches `TailState` through the
    // ordinary line stream. That sidesteps the live-tail-versus-re-read
    // divergence documented on `Format::seed_state` entirely: a session
    // discovered while nearly empty and a full re-read of the finished file
    // both learn the model at the same byte offset.
    seed_state: no_seed_state,
    agent_end: transform::agent_end,
    transform_line: transform::transform_line,
    reread: RereadPolicy::ByteCursor,
};

/// The agent id used when nothing can be derived from the path.
pub const DEFAULT_AGENT_ID: &str = "openclaw";

/// The directory a transcript must sit directly inside.
const SESSIONS_DIR: &str = "sessions";
/// The directory holding one subdirectory per agent.
const AGENTS_DIR: &str = "agents";
/// The OpenTelemetry trace written beside every transcript. 59x its size.
const TRAJECTORY_SUFFIX: &str = ".trajectory.jsonl";

fn is_uuid36(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Whether `path`'s immediate parent is the `sessions/` directory.
///
/// "Immediate" is load-bearing: the walk is recursive, and
/// `sessions/skills-prompts/sha256/<ab>/<hash>.txt` is a real subtree of
/// content-addressed prompt blobs. Requiring the parent — rather than any
/// ancestor — keeps a future blob that happens to be named `.jsonl` from being
/// tailed as if it were a conversation.
fn in_sessions_dir(path: &Path) -> bool {
    path.parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n == SESSIONS_DIR)
}

/// A transcript is `<uuid>.jsonl` directly inside `sessions/`.
///
/// The directory walk is recursive, so this predicate carries the whole filter.
/// See the module docs for what each clause keeps out; the trajectory check is
/// first and by name because it is the one whose failure is measured in
/// hundreds of kilobytes per session rather than in wrong rows.
fn is_transcript(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if name.ends_with(TRAJECTORY_SUFFIX) {
        return false;
    }
    let Some(stem) = name.strip_suffix(".jsonl") else {
        return false;
    };
    is_uuid36(stem) && in_sessions_dir(path)
}

/// The filename stem IS the session id.
///
/// Deliberately the only source of it, even though the `session` header record
/// repeats it: two answers that can disagree is worse than one, and the path is
/// what the cursor keys on.
fn session_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_name()?.to_str()?.strip_suffix(".jsonl")?;
    is_uuid36(stem).then(|| stem.to_string())
}

/// `openclaw-<agentId>`, from the `agents/<agentId>/sessions/` path shape.
///
/// NOT from the transcript's `cwd`, which is the agent's fixed workspace and
/// identical across every session it ever runs — see the module docs. The
/// header is accepted and ignored so the signature matches
/// [`crate::filetail::Format`].
///
/// The full `agents/<id>/sessions/` shape is required rather than searched for,
/// because a bare "find the component after `agents`" scan would pick the wrong
/// one for a state directory living under, say, `/home/agents/`. Returning
/// `None` when the shape does not hold leaves the engine to fall back to the
/// configured default id, which files the session under a plainly-generic agent
/// instead of a confidently wrong one.
fn agent_id_from_path(path: &Path, _header: &[String]) -> Option<String> {
    let sessions = path.parent()?;
    let agent_dir = sessions.parent()?;
    if agent_dir.parent()?.file_name()? != AGENTS_DIR {
        return None;
    }
    let id = transform::sanitize_id_part(agent_dir.file_name()?.to_str()?);
    (!id.is_empty()).then(|| format!("openclaw-{id}"))
}

/// Where transcripts live, honoring OpenClaw's own state-directory overrides.
///
/// Points at `agents/` rather than the state directory itself. The state
/// directory also holds `state/openclaw.sqlite` (964 KB on the capture) and the
/// agent's `workspace/`, which is a git checkout — re-walking a `.git` tree on
/// every poll is work that can never produce an event.
pub fn default_roots() -> Vec<PathBuf> {
    let state = std::env::var_os("OPENCLAW_STATE_DIR")
        .or_else(|| std::env::var_os("OPENCLAW_HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".openclaw")))
        .unwrap_or_else(|| PathBuf::from(".openclaw"));
    vec![state.join(AGENTS_DIR)]
}
