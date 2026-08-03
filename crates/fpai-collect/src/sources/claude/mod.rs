//! Claude Code session capture — a [`filetail`](crate::filetail) adapter.
//!
//! Claude Code writes live-appended JSONL transcripts under
//! `~/.claude/projects/<slug>/<sessionId>.jsonl`. We open them read-only and
//! turn each newly-appended line into AgentEye events; Claude Code's own files
//! are never written, moved or deleted.
//!
//! # The layout (verified against 158 transcripts in 14 projects, CC 2.1.220)
//!
//! ```text
//! projects/<slug>/<sessionId>.jsonl                                  main
//! projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl        subagent
//! projects/<slug>/<sessionId>/subagents/workflows/wf_<id>/agent-<agentId>.jsonl
//! ```
//!
//! # Siblings that must not be tailed
//!
//! Three live in the same tree and each breaks something different:
//!
//! * `<sessionId>.jsonl.tool-calls.json` — rewritten **in place**, so a byte
//!   cursor would re-ship its contents forever. Excluded by requiring `.jsonl`.
//! * `subagents/**/journal.jsonl` — a different schema (`{type, key, agentId}`,
//!   no timestamps at all). Excluded from [`FORMAT`] by requiring a bare-UUID
//!   stem and from [`SUBAGENT_FORMAT`] by requiring an `agent-` prefix.
//! * `~/.claude/history.jsonl` — out of scope by construction, since the
//!   configured root is `projects/` rather than the home.
//!
//! # `/compact` rewrites the transcript
//!
//! Compaction can shrink the file. The engine detects the shrink and re-reads
//! from zero, which re-ships the surviving prefix; the server dedups it because
//! every event is a pure function of its line and offset. Separately, the
//! `system`/`compact_boundary` record it leaves behind is transformed into an
//! event — see [`transform::transform_line`].
//!
//! # Why there are two `Format`s
//!
//! [`FORMAT`] claims main transcripts; [`SUBAGENT_FORMAT`] claims subagent ones.
//! They must stay **disjoint**: a file claimed by both would ship every line
//! twice, under two different session ids. `is_source_file` is a bare
//! `fn(&Path) -> bool` with nowhere to hide shared state, so the disjointness is
//! carried by the `subagents` path component alone — asserted by a test.

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

/// Subagent transcripts: `agent-<agentId>.jsonl` under a `subagents/` ancestor.
///
/// Only the file-identity half differs from [`FORMAT`]. The line grammar is
/// byte-for-byte the same — a subagent's `user` and `assistant` records carry
/// the identical fields, verified across all 122 subagent transcripts on this
/// machine — so `transform_line`, `seed_state` and `agent_end` are shared
/// rather than cloned, and any fix to the main path reaches both.
pub const SUBAGENT_FORMAT: Format = Format {
    kind: "claude-subagent",
    is_source_file: is_subagent_transcript,
    session_id_from_path: subagent_session_id,
    agent_id_from_path: subagent_agent_id,
    agent_start: transform::subagent_start,
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

/// The `subagents/` directory itself, for a path beneath it.
///
/// Anchored on the literal component, never on a depth count: the workflow
/// layout inserts two extra levels (`subagents/workflows/wf_<id>/`), so a
/// depth-based guess is confidently wrong on exactly one of the two shapes and
/// would file those subagents under a session id that does not exist.
fn subagents_dir(path: &Path) -> Option<&Path> {
    path.ancestors()
        .skip(1)
        .find(|a| a.file_name().is_some_and(|n| n == SUBAGENTS_DIR))
}

/// The agent id a subagent filename carries: `agent-<agentId>.jsonl`.
///
/// The `agent-` prefix is what excludes `journal.jsonl`, the one other `.jsonl`
/// that lives under `subagents/`. Measured across all 124 files there: 122
/// match `agent-<17 hex>` and 2 are `journal.jsonl`. The hex shape is
/// deliberately NOT required — a future id alphabet would then silently stop
/// being captured, whereas the prefix alone already separates the two.
fn subagent_id(path: &Path) -> Option<&str> {
    let agent = path
        .file_name()?
        .to_str()?
        .strip_suffix(".jsonl")?
        .strip_prefix("agent-")?;
    (!agent.is_empty()).then_some(agent)
}

/// A subagent transcript is `agent-<agentId>.jsonl` under a `subagents/`
/// ancestor. Disjoint from [`is_transcript`] by that same ancestor check.
fn is_subagent_transcript(path: &Path) -> bool {
    subagent_id(path).is_some() && under_subagents(path)
}

/// A subagent becomes a CHILD session keyed `<parentSessionId>:<agentId>`.
///
/// The parent id is the directory *containing* `subagents/` — not anything in
/// the file. Every subagent line does carry a `sessionId`, but it is the
/// PARENT's, so trusting it would collapse every subagent into its parent's
/// timeline. Verified on all 122: the in-file `sessionId` equals the containing
/// directory's name and the in-file `agentId` equals the filename's, so the
/// path is both sufficient and in agreement.
fn subagent_session_id(path: &Path) -> Option<String> {
    let agent = subagent_id(path)?;
    let parent = subagents_dir(path)?.parent()?.file_name()?.to_str()?;
    (!parent.is_empty()).then(|| format!("{parent}:{agent}"))
}

/// `claude-<agentType>` — the native agent name (`Explore`, `general-purpose`,
/// `Plan`), so the kinds separate in the product instead of collapsing into one.
///
/// The type is on NO transcript line as `agentType`; it lives in the
/// `agent-<id>.meta.json` sidecar. The sidecar is tried first and that ordering
/// is load-bearing: `agent_id` is frozen onto the cursor at discovery, and a
/// subagent's `agent_start` resolves on byte 0 (its first line is a real
/// timestamped user turn), whereas the in-file `attributionAgent` fallback does
/// not appear until line 3-4 — so a file discovered one line in would freeze the
/// fallback onto every event of that session. Measured here: the sidecar exists
/// for 122 of 122, and `attributionAgent` agrees with it in 122 of 122.
///
/// `None` when neither is readable, which hands the engine's configured default
/// ([`SUBAGENT_DEFAULT_AGENT_ID`]) back: an unnameable subagent must still be
/// captured.
fn subagent_agent_id(path: &Path, header: &[String]) -> Option<String> {
    let raw = sidecar_agent_type(path).or_else(|| header_agent_type(header))?;
    let part = transform::sanitize_id_part(&raw);
    (!part.is_empty()).then(|| format!("claude-{part}"))
}

/// `agentType` from the sidecar beside a subagent transcript.
///
/// A blocking read, deliberately: the file is ~130 bytes and this runs once per
/// newly discovered transcript, from the same code path that already stats and
/// reads the transcript's header. Every failure — absent, unreadable,
/// malformed, no `agentType` — is a `None` that routes to the next fallback.
fn sidecar_agent_type(path: &Path) -> Option<String> {
    let stem = path.file_name()?.to_str()?.strip_suffix(".jsonl")?;
    let text = std::fs::read_to_string(path.with_file_name(format!("{stem}.meta.json"))).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let t = v.get("agentType")?.as_str()?;
    (!t.is_empty()).then(|| t.to_string())
}

/// `attributionAgent` off the header — the same name, written into the
/// transcript itself. Present on 11,299 assistant lines corpus-wide.
fn header_agent_type(header: &[String]) -> Option<String> {
    header.iter().find_map(|line| {
        serde_json::from_str::<Value>(line)
            .ok()?
            .get("attributionAgent")?
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    })
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

/// The agent id used for a subagent whose type cannot be resolved. Distinct
/// from [`DEFAULT_AGENT_ID`] so an unnameable subagent is still visibly a
/// subagent rather than merging into the main-transcript catch-all.
pub const SUBAGENT_DEFAULT_AGENT_ID: &str = "claude-subagent";
