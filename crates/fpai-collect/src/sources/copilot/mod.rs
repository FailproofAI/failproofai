//! GitHub Copilot CLI session capture — a [`filetail`](crate::filetail) adapter.
//!
//! Copilot writes one live-appended JSONL transcript per session at
//! `~/.copilot/session-state/<sessionId>/events.jsonl` (`COPILOT_HOME`
//! overrides the home). We open them read-only and turn each newly-appended
//! line into AgentEye events; Copilot's own files are never written, moved or
//! deleted.
//!
//! # The file is genuinely append-only, which is why a byte cursor is safe
//!
//! Proven rather than assumed, because two of the CLIs probed for this engine
//! rewrite their transcripts without saying so (see [`RereadPolicy`]). A
//! session was captured, resumed, and captured again: same inode, and the
//! first 39,797 bytes of the resumed file are md5-identical to the entire
//! pre-resume file. A resume appends `session.resume` and carries on — it does
//! not rewrite, renumber, or compact anything. Hence
//! [`RereadPolicy::ByteCursor`].
//!
//! # Siblings that must not be tailed
//!
//! Every one of these lives inside the same tree, and each breaks something
//! different:
//!
//! * `workspace.yaml` — rewritten **in place** on every resume (`updated_at`
//!   moves), so a byte cursor would either re-ship it or resume mid-record.
//!   It is also YAML, not JSONL.
//! * `checkpoints/index.md` — rewritten in place as checkpoints are added, and
//!   Markdown rather than JSON.
//! * `session.db`, and `session-store.db` / `-wal` / `-shm` one level up —
//!   SQLite. A byte cursor over a page-rewriting binary file produces garbage
//!   indefinitely, and the `-wal` here is 900 KB and churning.
//! * `logs/process-*.log` — process-scoped, NOT session-scoped: one file spans
//!   every session a `copilot` process ran, so its lines have no single session
//!   id to file events under. Plain text, and it embeds base64 icon blobs.
//!
//! [`is_transcript`] excludes all of them by requiring the exact filename
//! `events.jsonl`, which is an allowlist rather than a denylist on purpose:
//! whatever artifact a future Copilot release drops in a session directory is
//! excluded by default instead of needing to be discovered in production.
//!
//! # Scope
//!
//! This covers the records that carry the session: start/end, prompts,
//! assistant turns, and tool calls with their results. `hook.start` / `hook.end`
//! are deliberately not mapped — failproofai's own hook-activity source already
//! ships those from the store that records the decision, and re-deriving them
//! here would double-count every hook. Checkpoints, `files/`, `research/` and
//! the SQLite indexes are out of scope by construction.

pub mod transform;

use std::path::{Path, PathBuf};

use crate::filetail::{Format, RereadPolicy, no_seed_state};
use serde_json::Value;

/// One transcript per session directory: `<sessionId>/events.jsonl`.
pub const FORMAT: Format = Format {
    kind: "copilot",
    is_source_file: is_transcript,
    session_id_from_path,
    agent_id_from_path,
    agent_start: transform::agent_start,
    // No priming needed, unlike the Claude source. Copilot writes
    // `session.model_change` before the first `user.message`, so the opening
    // prompt already has a model by the time it is transformed — which also
    // means this source avoids the live-tail-vs-re-read hazard documented on
    // `Format::seed_state`.
    seed_state: no_seed_state,
    agent_end: transform::agent_end,
    transform_line: transform::transform_line,
    reread: RereadPolicy::ByteCursor,
};

/// The agent id used when nothing can be derived.
pub const DEFAULT_AGENT_ID: &str = "copilot";

/// The one file per session directory that is a transcript.
const TRANSCRIPT_FILE: &str = "events.jsonl";

/// Directory holding one subdirectory per session.
const SESSION_STATE_DIR: &str = "session-state";

/// Where Copilot keeps its per-session directories.
///
/// `COPILOT_HOME` overrides `~/.copilot` — the same override the CLI itself
/// honours, and the one `lib/copilot-sessions.ts` reads, so a machine that
/// relocates its Copilot home stays covered by both halves of the product.
pub fn session_state_root() -> PathBuf {
    if let Some(home) = std::env::var_os("COPILOT_HOME") {
        return PathBuf::from(home).join(SESSION_STATE_DIR);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".copilot")
        .join(SESSION_STATE_DIR)
}

/// A transcript is any file named exactly `events.jsonl`.
///
/// The directory walk is recursive, so this predicate carries the whole filter.
/// See the module docs for what each excluded sibling would break; the point of
/// matching the name exactly is that they are excluded by construction rather
/// than by a list that has to be kept current.
fn is_transcript(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()) == Some(TRANSCRIPT_FILE)
}

/// The session id is the name of the directory containing the transcript.
///
/// Every transcript is `events.jsonl`, so unlike Claude the filename carries
/// nothing — the directory does. Verified on disk: the directory name equals
/// `session.start`'s `data.sessionId` in all 4 live sessions, including one
/// started with an explicitly chosen `--session-id`.
///
/// Deliberately the only source of it. The header carries the same id, and
/// reading both would give two answers that can disagree — while the path is
/// what the cursor keys on and what the hook source's `sessionId` must match
/// for hook events and transcript events to land on one timeline.
fn session_id_from_path(path: &Path) -> Option<String> {
    if !is_transcript(path) {
        return None;
    }
    let dir = path.parent()?.file_name()?.to_str()?;
    // A transcript sitting directly in the session-state root has no session
    // directory; a synthetic id is better than filing it under the root's name,
    // which every such file would share.
    (!dir.is_empty() && dir != SESSION_STATE_DIR).then(|| dir.to_string())
}

/// `copilot-<project>`, from the real `cwd` on the transcript's first lines.
///
/// NOT decoded from the directory name, which is a bare session UUID and
/// encodes no path at all — Copilot keeps the working directory as a real
/// field (`session.start` → `data.context.cwd`, repeated on `session.resume`),
/// so there is nothing to invert and nothing to get wrong.
///
/// The scheme matches what the Claude and hook sources derive, so a hook event
/// and the transcript events for one run land under a single agent rather than
/// two that look unrelated.
fn agent_id_from_path(_path: &Path, header: &[String]) -> Option<String> {
    let cwd = header.iter().find_map(|line| {
        serde_json::from_str::<Value>(line)
            .ok()?
            .get("data")?
            .get("context")?
            .get("cwd")?
            .as_str()
            .map(str::to_string)
    })?;
    let project = transform::sanitize_id_part(
        cwd.trim_end_matches('/')
            .rsplit('/')
            .find(|p| !p.is_empty())?,
    );
    (!project.is_empty()).then(|| format!("copilot-{project}"))
}
