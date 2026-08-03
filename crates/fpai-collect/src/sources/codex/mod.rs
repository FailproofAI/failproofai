//! Codex CLI session capture — a [`filetail`](crate::filetail) adapter.
//!
//! Codex writes live-appended JSONL rollouts under
//! `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<local-ts>-<uuid>.jsonl`, one
//! file per session, identically from the TUI, `codex exec`, and the IDE
//! extension. We open them read-only and turn each newly-appended line into
//! AgentEye events; Codex's own files are never written, moved or deleted.
//!
//! # The date tree carries no project, so the agent id comes from inside
//!
//! Unlike Claude Code, which files transcripts under a per-project directory,
//! Codex files them by calendar date — every project on the machine lands in
//! the same folder. The upstream collector concluded from this that "there is
//! no agent id to read off the path" and filed every codex session under one
//! configured id, which collapses every repo a developer touches into a single
//! agent. The working directory is right there in the `session_meta` line, so
//! [`agent_id_from_path`] reads it from the header instead — see there for why
//! the scheme has to match the hook source's exactly.
//!
//! # The session id must come from the filename
//!
//! `session_meta.payload.session_id` is NOT this file's id on a subagent or
//! forked rollout: on the one such rollout on this machine it holds the
//! *parent* thread's id while `payload.id` holds the file's, so keying on
//! `session_id` would merge a subagent's whole transcript into its parent's
//! timeline. The filename uuid is unambiguous and is also what the cursor keys
//! on, so it is the only source of the id here — the parent is carried
//! separately as `parent_id` on `agent_start`.
//!
//! # Files in the tree that must not be tailed
//!
//! Codex keeps `history.jsonl` and `session_index.jsonl` at `~/.codex/` rather
//! than under `sessions/`, so the configured root already excludes them; the
//! `rollout-` prefix and the trailing-uuid requirement exclude them anyway if a
//! root is ever widened. Archived rollouts are compressed (`.zst`) and
//! in-progress writes land on `.tmp` names — neither ends in `.jsonl`, so both
//! are excluded by construction rather than by an explicit rule that could rot.
//!
//! # Scope
//!
//! This covers the records that carry the session: start/end, prompts,
//! assistant turns, tool calls with their results, and per-turn token usage.
//! Deliberately not emitted, each because it would produce a row with nothing
//! in it or a duplicate of one already emitted: `reasoning` (encrypted, and its
//! `summary` is empty in all 1,018 on disk), `compacted` / `world_state`,
//! `patch_apply_end` (an orphan `call_id`), and the `event_msg` restatements of
//! the conversation. `turn_aborted` is not emitted either — AgentEye's `error`
//! type is outside the vocabulary this source shares with the Claude one, and
//! adding it here alone would make the two sources disagree about what a
//! session's event stream contains.

pub mod transform;

use std::path::Path;

use crate::filetail::{Format, RereadPolicy, no_seed_state};
use serde_json::Value;

/// Rollout transcripts: `rollout-<local-ts>-<uuid>.jsonl` anywhere under the
/// configured roots.
pub const FORMAT: Format = Format {
    kind: "codex",
    is_source_file: is_rollout,
    session_id_from_path,
    agent_id_from_path,
    agent_start: transform::agent_start,
    // Codex writes a `turn_context` carrying the model BEFORE the first human
    // prompt in every one of the 13 rollouts measured, so `transform_line` has
    // the model by the time it matters and nothing needs seeding from the
    // header. That sidesteps the live-tail-vs-re-read hazard documented on
    // `Format::seed_state` entirely rather than accepting it as Claude must.
    seed_state: no_seed_state,
    agent_end: transform::agent_end,
    transform_line: transform::transform_line,
    // Rollouts are strictly appended: a byte offset is sufficient. Verified by
    // re-reading line 1 of a live session — unlike factory/droid, Codex never
    // rewrites it to name the session, because the name is already in the path.
    reread: RereadPolicy::ByteCursor,
};

/// The agent id used when nothing can be derived.
pub const DEFAULT_AGENT_ID: &str = "codex";

const UUID_LEN: usize = 36;

/// `8-4-4-4-12` hex, checked positionally.
///
/// Stricter than "hex digits and dashes" on purpose: the filename is
/// `rollout-<YYYY-MM-DDTHH-MM-SS>-<uuid>`, whose timestamp half is also 36-ish
/// characters of digits and dashes, so a loose check would happily slice a
/// session id out of the middle of a date.
fn is_uuid36(s: &str) -> bool {
    s.len() == UUID_LEN
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// A rollout is `rollout-*.jsonl` whose stem ends in a uuid.
///
/// The walk is recursive, so this predicate carries the whole filter. Requiring
/// the uuid — rather than just the prefix and extension — is what keeps a
/// future sibling file in the same tree (`rollout-index.jsonl`, say) from being
/// tailed as a session under a synthetic id nothing else correlates with.
fn is_rollout(path: &Path) -> bool {
    session_id_from_path(path).is_some()
}

/// The uuid embedded in the filename IS the session id.
///
/// Taken from the trailing 36 characters rather than by counting dash-separated
/// groups: the timestamp half of the name contains dashes too, so group
/// counting only works while the timestamp's own format never changes.
fn session_id_from_path(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let cut = stem.len().checked_sub(UUID_LEN)?;
    // A `-` must separate the timestamp from the uuid, so a name that merely
    // ends in 36 hex-ish characters is not sliced mid-token.
    if cut > 0 && !stem[..cut].ends_with('-') {
        return None;
    }
    let uuid = stem.get(cut..)?;
    is_uuid36(uuid).then(|| uuid.to_string())
}

/// `codex-<project>`, from the real `cwd` on the rollout's first lines.
///
/// NOT from the path: Codex's tree is `sessions/<YYYY>/<MM>/<DD>/`, which
/// records the date and nothing about the work. Without reading the header,
/// every project a developer touches files under one agent id and the product
/// cannot tell them apart at all.
///
/// The scheme matches what the hook-activity source derives from the same
/// working directory, so a hook event and the rollout events for one run land
/// under a single agent rather than two that look unrelated.
fn agent_id_from_path(_path: &Path, header: &[String]) -> Option<String> {
    let cwd = header.iter().find_map(|line| {
        let v: Value = serde_json::from_str(line).ok()?;
        // `session_meta` first, but `turn_context` repeats the same value — so
        // a rollout whose header line 1 is truncated still files correctly.
        match v.get("type")?.as_str()? {
            "session_meta" | "turn_context" => {
                v.get("payload")?.get("cwd")?.as_str().map(str::to_string)
            }
            _ => None,
        }
    })?;
    let project = transform::sanitize_id_part(
        cwd.trim_end_matches('/')
            .rsplit('/')
            .find(|p| !p.is_empty())?,
    );
    (!project.is_empty()).then(|| format!("codex-{project}"))
}
