//! Persistent read positions, so a restart resumes instead of re-shipping.
//!
//! # Why files are keyed by (device, inode) rather than by path
//!
//! The hook-activity store rotates by RENAMING `current.jsonl` to
//! `page-<ts>-<seq>.jsonl` and creating a fresh `current.jsonl`. A path-keyed
//! cursor gets both halves of that wrong at once: it thinks the rotated file
//! is brand new (and re-ships all of it), and it carries the old offset onto
//! the fresh `current.jsonl` (and skips its first records). Keying on the
//! inode means the cursor simply follows the file it belongs to, and the new
//! `current.jsonl` correctly starts at zero.
//!
//! The same shape shows up in every source that rotates or moves its files, so
//! this store is deliberately general — the format-specific tailing engine in
//! the next phase reuses it unchanged.
//!
//! # Inode reuse
//!
//! An inode freed by a deleted file can be handed to an unrelated new one. A
//! cursor keyed only on the inode would then apply a stale offset to different
//! content and silently skip its beginning. [`FileCursor::matches`] guards
//! that by also comparing the recorded path, so a reused inode under a
//! different name is treated as new rather than resumed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Bumped only for a change no `#[serde(default)]` can absorb. A mismatch is
/// treated as an empty store — re-reading costs a re-ship the server dedups,
/// while a half-understood cursor could skip records permanently.
const SCHEMA: u32 = 1;

const CURSOR_FILE: &str = "cursors.json";

/// State a format carries from one line to the next within a session.
///
/// Persisted with the cursor rather than held in memory, so a resumed read
/// reproduces byte-identical events — which is what lets the server's
/// content-hash dedup collapse a re-read instead of storing it twice.
///
/// Fields are format-specific but live here because the cursor is what makes
/// them durable. A format that carries no state leaves them all unset.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct TailState {
    /// Model of the most recent assistant turn. A user line carries none and
    /// inherits it, so without this the first prompt of a session renders with
    /// no model at all.
    pub last_model: Option<String>,
    /// The last message id whose token usage was already attributed.
    ///
    /// One API response is written across several lines that each repeat the
    /// SAME usage object, so counting per line inflates token totals several
    /// times over. Gating on the group id is cross-line state, but of the safe
    /// kind: persisted here, so a resumed read holds the same value at the same
    /// offset as a full re-read would.
    pub last_usage_message_id: Option<String>,
    /// In-flight `tool_use` id → tool name.
    ///
    /// A tool result names no tool, and the server builds a result row's
    /// summary from the tool name alone — so without this every tool result is
    /// a blank row. A `Vec` rather than a map because eviction has to be
    /// deterministic AND drop the oldest first; a map keyed by random ids would
    /// evict in an order unrelated to age.
    pub pending_tools: Vec<(String, String)>,
}

/// Most in-flight tool calls remembered per session. Bounds the cursor file
/// when a transcript has calls that never produce a result.
pub const MAX_PENDING_TOOLS: usize = 64;

impl TailState {
    pub fn remember_tool(&mut self, id: String, name: String) {
        if self.pending_tools.iter().any(|(i, _)| *i == id) {
            return;
        }
        self.pending_tools.push((id, name));
        if self.pending_tools.len() > MAX_PENDING_TOOLS {
            self.pending_tools.remove(0);
        }
    }

    pub fn tool_name(&self, id: &str) -> Option<&str> {
        self.pending_tools
            .iter()
            .find(|(i, _)| i == id)
            .map(|(_, n)| n.as_str())
    }
}

/// Where one file has been read up to, and what the format knows about it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct FileCursor {
    /// Last known path. Compared on resume to catch inode reuse; not the key.
    pub path: PathBuf,
    pub dev: u64,
    pub inode: u64,
    /// Bytes consumed. Only ever advanced after the events derived from them
    /// have been durably spooled.
    pub offset: u64,
    /// File size when the offset was last advanced. Used to detect truncation.
    pub size_seen: u64,

    // Everything below is `serde(default)` so adding a field needs no SCHEMA
    // bump: an older cursor file simply reads them as unset, which is the same
    // state a freshly-discovered file starts in.
    /// Identity stamped on every event from this file. Immutable once set, so
    /// it cannot drift mid-session.
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Whether this session's `agent_start` has been emitted.
    ///
    /// Load-bearing: the server selects sessions on `agent_start`, so a session
    /// without one is not merely incomplete, it is absent from the product
    /// entirely — and `agent_end` is gated on the same flag, so it never ends
    /// either.
    #[serde(default)]
    pub agent_start_emitted: bool,
    /// Whether `agent_end` has been emitted. Cleared if the file grows again,
    /// so a resumed session can end a second time rather than freezing.
    #[serde(default)]
    pub ended: bool,
    /// Most recent timestamp seen, which `agent_end` is derived from.
    #[serde(default)]
    pub last_ts: Option<String>,
    /// Length of the file's first line, for formats that rewrite it in place.
    #[serde(default)]
    pub first_line_len: Option<u64>,
    #[serde(default)]
    pub state: TailState,
}

impl FileCursor {
    /// Whether this cursor may be resumed for `path`.
    ///
    /// A file that moved but kept its inode (the rotation case) still matches
    /// only if we choose to allow it — see [`CursorStore::resume`], which
    /// treats a same-inode different-path file as the same file. What must
    /// never match is a *different* file that inherited a freed inode, and
    /// that is what a differing name catches.
    pub fn matches(&self, dev: u64, inode: u64) -> bool {
        self.dev == dev && self.inode == inode
    }
}

/// Every cursor for one source, persisted as a single atomically-written file.
///
/// One store per source, never shared. The whole map is written at once, so
/// two sources sharing a file would clobber each other and the loser would
/// re-ship from zero after every restart.
#[derive(Debug, Default)]
pub struct CursorStore {
    dir: PathBuf,
    cursors: BTreeMap<String, FileCursor>,
}

#[derive(Debug, Deserialize, Serialize)]
struct OnDisk {
    schema: u32,
    /// `BTreeMap` rather than `HashMap` so the file has a stable order and a
    /// diff between two runs shows real movement rather than rehashing.
    cursors: BTreeMap<String, FileCursor>,
}

fn key(dev: u64, inode: u64) -> String {
    format!("{dev}:{inode}")
}

impl CursorStore {
    /// Load the store for `dir`, or an empty one if it is absent or unreadable.
    ///
    /// Corruption is logged and treated as empty rather than propagated: a
    /// source that refuses to start because its cursor file is damaged
    /// collects nothing until a human intervenes, whereas starting over
    /// re-ships records the server already dedups.
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join(CURSOR_FILE);
        let cursors = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<OnDisk>(&text) {
                Ok(d) if d.schema == SCHEMA => d.cursors,
                Ok(d) => {
                    tracing::warn!(
                        path = %path.display(),
                        found = d.schema,
                        expected = SCHEMA,
                        "cursor schema mismatch; starting from scratch"
                    );
                    BTreeMap::new()
                }
                Err(err) => {
                    tracing::warn!(
                        path = %path.display(),
                        %err,
                        "cursor file is unreadable; starting from scratch"
                    );
                    BTreeMap::new()
                }
            },
            Err(_) => BTreeMap::new(),
        };
        CursorStore { dir, cursors }
    }

    pub fn is_empty(&self) -> bool {
        self.cursors.is_empty()
    }

    pub fn len(&self) -> usize {
        self.cursors.len()
    }

    /// The cursor to resume from for a file, if one applies.
    ///
    /// A same-inode file whose path changed IS resumed: that is exactly the
    /// rotation case, and re-reading a rotated page from zero would duplicate
    /// every record in it. A cursor whose recorded path names a *different*
    /// file that still exists is refused, since the inode was reused.
    pub fn resume(&self, dev: u64, inode: u64, path: &Path) -> Option<&FileCursor> {
        let c = self.cursors.get(&key(dev, inode))?;
        if !c.matches(dev, inode) {
            return None;
        }
        if c.path != path && still_the_same_inode(&c.path, dev, inode) {
            // The recorded path exists AND still holds THIS inode, so the file
            // we recorded has not moved — yet we are being asked about the same
            // inode under a different name. That is a hardlink or an
            // inconsistency, not a rotation, and resuming would apply one
            // file's offset to another's content.
            //
            // Mere existence of the recorded path is NOT enough to conclude
            // this, which is what an earlier version got wrong: after the hook
            // store rotates, `current.jsonl` exists again immediately — as a
            // brand-new inode — so an existence check refused to resume the
            // rotated page and re-shipped every row in it.
            tracing::warn!(
                recorded = %c.path.display(),
                found = %path.display(),
                "same inode under two live paths; not resuming"
            );
            return None;
        }
        Some(c)
    }

    pub fn set(&mut self, cursor: FileCursor) {
        self.cursors.insert(key(cursor.dev, cursor.inode), cursor);
    }

    /// Drop cursors whose files no longer exist, so the store does not grow
    /// without bound as pages are pruned.
    pub fn retain_existing(&mut self) {
        self.cursors.retain(|_, c| c.path.exists());
    }

    /// Persist atomically (tmp → fsync → rename) at owner-only permissions.
    ///
    /// Callers write this AFTER the events derived from the new offsets are
    /// durable. A crash between the two costs a re-ship, which the server
    /// dedups; the other order loses records outright.
    pub fn save(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let body = serde_json::to_string_pretty(&OnDisk {
            schema: SCHEMA,
            cursors: self.cursors.clone(),
        })
        .map_err(std::io::Error::other)?;

        let tmp = self.dir.join(format!("{CURSOR_FILE}.tmp"));
        write_private(&tmp, body.as_bytes())?;
        std::fs::rename(&tmp, self.dir.join(CURSOR_FILE))
    }
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

/// Whether `path` currently exists AND holds exactly `(dev, inode)`.
///
/// Distinguishes "the recorded file is still where we left it" from "a new
/// file has taken that name", which is the difference between an ambiguous
/// cursor and an ordinary rotation.
fn still_the_same_inode(path: &Path, dev: u64, inode: u64) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) => identity(&meta) == (dev, inode),
        Err(_) => false,
    }
}

/// `(device, inode)` for a file. On non-unix, a hash of the path — which
/// cannot detect rotation, so those platforms re-read a rotated file once.
#[cfg(unix)]
pub fn identity(meta: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

#[cfg(not(unix))]
pub fn identity(_meta: &std::fs::Metadata) -> (u64, u64) {
    (0, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "fpai-cur-{}-{}-{}",
            name,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn cursor(path: &Path, dev: u64, inode: u64, offset: u64) -> FileCursor {
        FileCursor {
            path: path.to_path_buf(),
            dev,
            inode,
            offset,
            size_seen: offset,
            ..Default::default()
        }
    }

    #[test]
    fn a_saved_cursor_round_trips() {
        let dir = tmpdir("roundtrip");
        let mut s = CursorStore::load(dir.clone());
        s.set(cursor(Path::new("/x/current.jsonl"), 1, 42, 1024));
        s.save().unwrap();

        let reloaded = CursorStore::load(dir.clone());
        assert_eq!(reloaded.len(), 1);
        assert_eq!(
            reloaded
                .resume(1, 42, Path::new("/x/current.jsonl"))
                .unwrap()
                .offset,
            1024
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_rotated_file_keeps_its_position() {
        // The hook store renames current.jsonl to page-*.jsonl. Re-reading
        // that page from zero would duplicate every record in it.
        let dir = tmpdir("rotate");
        let mut s = CursorStore::load(dir.clone());
        s.set(cursor(Path::new("/x/current.jsonl"), 1, 42, 900));

        let resumed = s.resume(1, 42, Path::new("/x/page-123-0.jsonl"));
        assert!(
            resumed.is_some(),
            "a renamed file must resume at its recorded offset"
        );
        assert_eq!(resumed.unwrap().offset, 900);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_fresh_file_after_rotation_starts_at_zero() {
        // The new current.jsonl has a different inode, so nothing resumes and
        // its first records are not skipped.
        let dir = tmpdir("fresh");
        let mut s = CursorStore::load(dir.clone());
        s.set(cursor(Path::new("/x/current.jsonl"), 1, 42, 900));
        assert!(s.resume(1, 99, Path::new("/x/current.jsonl")).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_same_inode_under_two_live_paths_is_not_resumed() {
        // A hardlink, or an inconsistency. Resuming would apply one file's
        // offset to another's content.
        //
        // Uses REAL inodes: with synthetic ones this test passed for the wrong
        // reason, because the guard could never look up what it was comparing.
        #[cfg(unix)]
        {
            let dir = tmpdir("twopaths");
            let recorded = dir.join("recorded.jsonl");
            std::fs::write(&recorded, "content\n").unwrap();
            let link = dir.join("link.jsonl");
            std::fs::hard_link(&recorded, &link).unwrap();

            let meta = std::fs::metadata(&recorded).unwrap();
            let (dev, ino) = identity(&meta);

            let mut s = CursorStore::load(dir.clone());
            s.set(cursor(&recorded, dev, ino, 5));

            assert!(
                s.resume(dev, ino, &link).is_none(),
                "the recorded path still holds this inode, so a second live path is ambiguous"
            );
            // The recorded path itself still resumes normally.
            assert!(s.resume(dev, ino, &recorded).is_some());
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn a_rotated_file_resumes_even_though_its_old_name_was_recreated() {
        // The exact hook-store sequence, with real inodes: current.jsonl is
        // renamed to a page and a NEW current.jsonl appears immediately. An
        // existence-only guard refuses here and re-ships the whole page.
        #[cfg(unix)]
        {
            let dir = tmpdir("rotate-real");
            let current = dir.join("current.jsonl");
            std::fs::write(&current, "row\n").unwrap();
            let (dev, ino) = identity(&std::fs::metadata(&current).unwrap());

            let mut s = CursorStore::load(dir.clone());
            s.set(cursor(&current, dev, ino, 4));

            let page = dir.join("page-1-0.jsonl");
            std::fs::rename(&current, &page).unwrap();
            std::fs::write(&current, "").unwrap(); // fresh file, new inode

            let resumed = s.resume(dev, ino, &page);
            assert!(
                resumed.is_some(),
                "the rotated page must resume; its old name being recreated is not inode reuse"
            );
            assert_eq!(resumed.unwrap().offset, 4);
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn a_corrupt_cursor_file_starts_from_scratch_rather_than_failing() {
        // Refusing to start would mean collecting nothing until a human
        // noticed. Starting over costs a re-ship the server dedups.
        let dir = tmpdir("corrupt");
        std::fs::write(dir.join(CURSOR_FILE), "{not json").unwrap();
        let s = CursorStore::load(dir.clone());
        assert!(s.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_future_schema_is_not_half_understood() {
        let dir = tmpdir("schema");
        std::fs::write(
            dir.join(CURSOR_FILE),
            r#"{"schema":99,"cursors":{"1:42":{"path":"/x","dev":1,"inode":42,"offset":5,"size_seen":5}}}"#,
        )
        .unwrap();
        let s = CursorStore::load(dir.clone());
        assert!(
            s.is_empty(),
            "a newer schema must be discarded, not partially read"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pruned_files_are_dropped_so_the_store_stays_bounded() {
        let dir = tmpdir("prune");
        let live = dir.join("live.jsonl");
        std::fs::write(&live, "x").unwrap();

        let mut s = CursorStore::load(dir.clone());
        s.set(cursor(&live, 1, 1, 10));
        s.set(cursor(&dir.join("gone.jsonl"), 1, 2, 10));
        assert_eq!(s.len(), 2);

        s.retain_existing();
        assert_eq!(s.len(), 1, "a cursor for a deleted page must be dropped");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_cursor_file_is_owner_only() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = tmpdir("mode");
            let mut s = CursorStore::load(dir.clone());
            s.set(cursor(Path::new("/x/a.jsonl"), 1, 1, 1));
            s.save().unwrap();
            let mode = std::fs::metadata(dir.join(CURSOR_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "got {mode:o}");
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}
