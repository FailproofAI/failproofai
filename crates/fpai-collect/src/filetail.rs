//! Generic tailer for agents that keep sessions in append-structured JSONL.
//!
//! Everything format-specific lives behind [`Format`], a table of pure
//! functions each source supplies. The engine itself knows nothing about any
//! transcript grammar.
//!
//! # The invariant everything rests on
//!
//! **Every event is a pure function of one line plus its byte offset.** Nothing
//! is folded or aggregated across a poll window. So a live tail that happens to
//! split a turn across two polls produces byte-identical events to a single
//! full re-read, which is what lets the server's content-hash dedup collapse a
//! re-read instead of storing it twice. Any cross-line state a format needs is
//! persisted in the cursor ([`TailState`]) precisely so it holds the same value
//! at the same offset either way.
//!
//! # Not every source is append-only, and the ones that aren't lie quietly
//!
//! A byte cursor is correct only where files are strictly appended. Probing the
//! real CLIs showed two that are not, and neither announces itself:
//!
//! * **factory/droid** rewrites its first line in place when it names a
//!   session, changing that line's length and shifting every later offset. Same
//!   inode, and on a manual rename it restores the mtime — so neither
//!   inode-watching nor a size+mtime check notices.
//! * **cursor** rewrites the whole file on the first write of every turn.
//!
//! [`RereadPolicy`] is how a format declares which of those it is, so the
//! engine can do the right thing instead of silently desyncing.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::cursor::{self, CursorStore, FileCursor, TailState, identity};
use crate::spool::SpoolWriter;
use crate::supervisor::{Shutdown, TaskError};

/// Leading lines read once per file, and reused for every question that needs
/// the head of the transcript: the session's start event, its agent id, and any
/// state a format seeds before transforming its first line.
pub const HEADER_LINES: usize = 64;
/// Cap on the header read, so a transcript whose first line is enormous cannot
/// pull an unbounded amount into memory.
const HEADER_MAX_BYTES: u64 = 1024 * 1024;

/// How a format's files change after they are written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RereadPolicy {
    /// Strictly appended. A byte offset is sufficient.
    ByteCursor,
    /// Appended, but the first line may be rewritten in place, moving every
    /// later offset. The engine re-reads line 1 each poll and rebases the
    /// cursor by the difference before reading further.
    ValidatePrefix,
}

/// Identity shared by every event of one session. Immutable for the session's
/// life and persisted in the cursor, so it is identical across polls and
/// restarts.
#[derive(Debug, Clone, Default)]
pub struct Ctx {
    pub session_id: String,
    pub agent_id: String,
    pub environment: String,
    /// The file's modification time (epoch ms) captured ONCE at first discovery
    /// and carried immutably. Only for formats whose transcripts contain no
    /// timestamps of their own (cursor) — every other source ignores it and
    /// derives event times from the records themselves. Immutable like the rest
    /// of `Ctx`, so a source that reads it stays a pure function of its inputs.
    pub file_epoch_ms: Option<i64>,
}

/// The per-format adapter: a table of pure functions.
///
/// Function items coerce to these `fn` pointers, so a source declares a
/// `Format` const wiring its own helpers — no trait objects, no generics
/// rippling through the engine.
#[derive(Clone, Copy)]
pub struct Format {
    /// Source kind. Becomes the derived batch filename prefix and log tag.
    pub kind: &'static str,
    /// True if this path is one of the format's transcripts.
    ///
    /// The directory walk is recursive, so this predicate carries the whole
    /// filter — including excluding sibling files that must never be tailed.
    pub is_source_file: fn(&Path) -> bool,
    /// Session id from the path. `None` falls back to a synthetic id derived
    /// from the inode, with a warning.
    pub session_id_from_path: fn(&Path) -> Option<String>,
    /// Agent id from the path and/or the header lines.
    ///
    /// Takes the header because a path is not always enough: several CLIs
    /// encode their working directory into a folder name lossily, and the real
    /// value is inside the file.
    pub agent_id_from_path: fn(&Path, &[String]) -> Option<String>,
    /// Build the session's `agent_start` from its header lines, plus the
    /// timestamp that seeds the cursor.
    ///
    /// Must produce one whenever the file is a real session: the server selects
    /// sessions on this event, so a session without one never appears in the
    /// product at all, and its `agent_end` is gated on the same flag.
    pub agent_start: AgentStartFn,
    /// Prime carried state from the header before the first line is
    /// transformed.
    ///
    /// ⚠️ Not dedup-safe between a live tail and a later full re-read: this
    /// runs when the file is first discovered, which for a live session is
    /// while it is nearly empty, so it seeds nothing — whereas re-reading the
    /// finished file seeds from a header that has since grown. Only wire it up
    /// where a blank first row is worse than an occasional duplicate.
    pub seed_state: fn(&[String], &mut TailState),
    /// The single `agent_end`, derived deterministically from the last
    /// timestamp and the file size.
    pub agent_end: fn(&Ctx, &str, u64) -> Value,
    /// One content line to its timestamp and the events it yields.
    ///
    /// `None` for the timestamp means the line was skipped. Must stay a pure
    /// function of `(line, ctx, offset, state)`.
    pub transform_line: TransformLineFn,
    pub reread: RereadPolicy,
}

/// Builds a session's `agent_start` from its header, plus the timestamp that
/// seeds the cursor.
pub type AgentStartFn = fn(&[String], &Ctx, u64) -> Option<(Value, Option<String>)>;
/// Transforms one content line into its timestamp and the events it yields.
pub type TransformLineFn = fn(&str, &Ctx, u64, &mut TailState) -> (Option<String>, Vec<Value>);

/// A format that carries no cross-line state.
pub fn no_seed_state(_lines: &[String], _state: &mut TailState) {}

/// Runtime knobs, built by a source from its resolved config.
#[derive(Debug, Clone)]
pub struct Params {
    pub agent_id: String,
    pub environment: String,
    /// Machine this daemon runs on, stamped on every event. See `SpoolWriter`.
    pub machine_id: Option<String>,
    /// OS user this daemon runs as, stamped on every event. See `SpoolWriter`.
    pub user: Option<String>,
    /// Minutes a file must be idle at EOF before `agent_end` is emitted.
    pub end_idle_mins: u64,
    pub max_read_bytes: u64,
    pub max_batch_bytes: u64,
    /// Skip files older than this many days on first discovery. `None` reads
    /// everything, which on a normal machine is gigabytes of history.
    pub since_days: Option<u64>,
}

pub struct Spec {
    pub format: Format,
    pub roots: Vec<PathBuf>,
    pub spool_dir: PathBuf,
    pub state_dir: PathBuf,
    pub poll_interval: std::time::Duration,
    pub params: Params,
}

/// Tail every discovered file until shutdown.
pub async fn run(spec: Spec, sd: Shutdown) -> Result<(), TaskError> {
    let mut cursors = CursorStore::load(spec.state_dir.clone());

    // Log which roots actually exist. Without this an absent root is
    // indistinguishable from a quiet one, and a source that captures nothing
    // reads exactly as healthy as one that captures everything.
    for root in &spec.roots {
        tracing::info!(
            source = spec.format.kind,
            root = %root.display(),
            present = root.exists(),
            "file source root"
        );
    }
    tracing::info!(
        source = spec.format.kind,
        resumed = cursors.len(),
        "file source started"
    );

    loop {
        match poll_once(&spec, &mut cursors).await {
            Ok(outcome) => {
                crate::health::report_poll(
                    spec.format.kind,
                    spec.roots.iter().any(|r| r.exists()),
                    outcome.events,
                    cursors.len() as u64,
                );
                // AFTER report_poll, which clears `last_error` — a pass where
                // every file failed must not read as a clean one.
                if let Some(err) = outcome.first_error {
                    crate::health::report_error(
                        spec.format.kind,
                        &format!(
                            "{} file(s) could not be processed; first: {err}",
                            outcome.failed
                        ),
                    );
                }
            }
            Err(err) => {
                tracing::warn!(source = spec.format.kind, %err, "poll failed; retrying next tick");
                crate::health::report_error(spec.format.kind, &err.to_string());
            }
        }
        if !sd.sleep(spec.poll_interval).await {
            return Ok(());
        }
    }
}

/// What one pass did, for the health record.
struct PollOutcome {
    events: u64,
    /// Files that could not be processed at all this pass.
    ///
    /// Reported so a source whose root is unreadable is DISTINGUISHABLE from
    /// one that is merely idle — which is the whole reason per-source health
    /// exists. Previously a pass warned per file and returned `Ok(0)` even when
    /// every file failed, and `record_poll` then unconditionally cleared
    /// `last_error`, so a permanently broken source reported exactly what a
    /// healthy quiet one does.
    failed: u64,
    /// The first failure's message, for the health record's `last_error`.
    first_error: Option<String>,
}

/// One pass over every discovered file.
async fn poll_once(spec: &Spec, cursors: &mut CursorStore) -> Result<PollOutcome, TaskError> {
    let files = discover(&spec.roots, spec.format.is_source_file).await;
    let mut out = PollOutcome {
        events: 0,
        failed: 0,
        first_error: None,
    };
    for path in files {
        match process_file(spec, cursors, &path).await {
            Ok(n) => out.events += n,
            // Per-file, so one malformed transcript cannot stop the others —
            // but counted, so "none of them worked" is not silence.
            Err(err) => {
                tracing::warn!(file = %path.display(), %err, "could not process file");
                out.failed += 1;
                if out.first_error.is_none() {
                    out.first_error = Some(format!("{}: {err}", path.display()));
                }
            }
        }
    }
    cursors.retain_existing();
    cursors.save().map_err(io_err)?;
    Ok(out)
}

/// Tail one file. Returns how many events it spooled, for the health record.
async fn process_file(
    spec: &Spec,
    cursors: &mut CursorStore,
    path: &Path,
) -> Result<u64, TaskError> {
    let meta = tokio::fs::metadata(path).await.map_err(io_err)?;
    let (dev, inode) = identity(&meta);
    let size = meta.len();

    let mut cursor = match cursors.resume(dev, inode, path) {
        Some(c) => c.clone(),
        None => match new_cursor(spec, path, dev, inode, &meta).await? {
            Some(c) => c,
            None => return Ok(0), // outside the backfill window
        },
    };

    // A resumed cursor whose recorded path has CHANGED is either a rotation
    // (same file, new name — resume it) or INODE REUSE (the old file was
    // unlinked, freeing its inode for an unrelated new one — do not).
    // `CursorStore::resume` can only rule out the case where the recorded path
    // still exists and still holds this inode, and in a real reuse the old file
    // is gone, which is precisely how its inode came to be free. So that guard
    // never fired for the case it was named after, and a dead file's offset was
    // applied to different content: its opening bytes skipped, and
    // `agent_start_emitted` carried over so the new session never announced
    // itself and never appeared in the product at all.
    //
    // Checked only on this branch. The overwhelmingly common poll finds the
    // path unchanged and pays nothing.
    if cursor.path != path
        && let Some(recorded) = cursor.head_fingerprint
    {
        let head = read_range(path, 0, cursor::HEAD_FINGERPRINT_BYTES as u64)
            .await
            .unwrap_or_default();
        if cursor::head_fingerprint(&head) != recorded {
            tracing::warn!(
                recorded = %cursor.path.display(),
                found = %path.display(),
                "inode reused by a different file; starting from zero"
            );
            match new_cursor(spec, path, dev, inode, &meta).await? {
                Some(fresh) => cursor = fresh,
                None => return Ok(0),
            }
        }
    }
    cursor.path = path.to_path_buf();

    // A file that shrank was replaced or truncated; its offsets mean nothing.
    //
    // NEITHER does anything else derived from the old content, which is why
    // this re-derives the whole cursor from the file as it is now rather than
    // zeroing `offset` and `state` and keeping the rest. Leaving
    // `first_line_len` behind was the sharp edge: for a `ValidatePrefix` format
    // (Factory), `rebase_on_first_line` immediately below computes
    // `new_len - old_len` and applies it to the offset this branch had just set
    // to zero, so the very first read of the replaced file started at a bogus
    // offset and skipped bytes. `agent_start_emitted` staying true was as bad
    // in a quieter way: the server selects sessions on `agent_start`, so the
    // replacement content would be spooled and then be absent from the product
    // entirely, having never announced a session. `session_id`, `last_ts` and
    // `first_seen_epoch_ms` likewise described content that is gone.
    //
    // `new_cursor` is used rather than blanking the fields because the correct
    // values are all recoverable from the new content — it re-reads the header
    // for the session and agent ids, the first-line length, the seeded state
    // and the mtime anchor, exactly as it does for a file seen for the first
    // time. Which is what this now is.
    if size < cursor.offset {
        tracing::warn!(file = %path.display(), size, offset = cursor.offset, "file shrank; re-reading");
        match new_cursor(spec, path, dev, inode, &meta).await? {
            Some(fresh) => cursor = fresh,
            // Outside the backfill window: the replacement content is older
            // than we collect, so there is nothing to read.
            None => return Ok(0),
        }
    }

    if spec.format.reread == RereadPolicy::ValidatePrefix {
        rebase_on_first_line(path, &mut cursor).await;
    }

    let ctx = Ctx {
        session_id: cursor.session_id.clone().unwrap_or_default(),
        agent_id: cursor
            .agent_id
            .clone()
            .unwrap_or_else(|| spec.params.agent_id.clone()),
        environment: spec.params.environment.clone(),
        file_epoch_ms: cursor.first_seen_epoch_ms,
    };

    let mut writer = SpoolWriter::new(
        spec.spool_dir.clone(),
        spec.params.max_batch_bytes,
        spec.format.kind,
        &ctx.session_id,
    )
    .with_machine_id(spec.params.machine_id.clone())
    .with_user(spec.params.user.clone());
    let mut emitted = 0u64;

    // A session with no start event never appears in the product, so retry it
    // on every poll until it succeeds rather than only at discovery.
    if !cursor.agent_start_emitted {
        let header = read_header(path).await.unwrap_or_default();
        if let Some((event, ts)) = (spec.format.agent_start)(&header, &ctx, 0) {
            writer.push(event).await.map_err(io_err)?;
            emitted += 1;
            cursor.agent_start_emitted = true;
            if cursor.last_ts.is_none() {
                cursor.last_ts = ts;
            }
        }
    }

    // Growth resumes a session that had already ended, so it can end again
    // rather than freezing at its first end time.
    if cursor.ended && size > cursor.size_seen {
        cursor.ended = false;
    }

    let mut consumed = 0u64;
    if size > cursor.offset {
        let read_end = size.min(cursor.offset + spec.params.max_read_bytes);
        let chunk = read_range(path, cursor.offset, read_end)
            .await
            .map_err(io_err)?;

        // Hold back a partial final line: half a JSON object parses as nothing,
        // and consuming it would skip the record when it completes.
        if let Some(last_nl) = chunk.iter().rposition(|b| *b == b'\n') {
            let usable = &chunk[..=last_nl];
            let mut line_offset = cursor.offset;
            for line in usable.split_inclusive(|b| *b == b'\n') {
                let at = line_offset;
                line_offset += line.len() as u64;
                let Ok(text) = std::str::from_utf8(line) else {
                    continue;
                };
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                let (ts, events) = (spec.format.transform_line)(text, &ctx, at, &mut cursor.state);
                if let Some(ts) = ts {
                    cursor.last_ts = Some(ts);
                }
                for e in events {
                    writer.push(e).await.map_err(io_err)?;
                    emitted += 1;
                }
            }
            consumed = usable.len() as u64;
        }
    }

    // `agent_end` once the file is fully read, has actually started, and has
    // been idle long enough that more writes are unlikely.
    let at_eof = cursor.offset + consumed >= size;
    if !cursor.ended
        && at_eof
        && cursor.agent_start_emitted
        && let Some(last_ts) = cursor.last_ts.clone()
        && is_idle(&meta, spec.params.end_idle_mins)
    {
        writer
            .push((spec.format.agent_end)(&ctx, &last_ts, size))
            .await
            .map_err(io_err)?;
        cursor.ended = true;
    }

    // Flush BEFORE advancing the cursor. A crash between the two costs a
    // re-ship the server dedups; the other order loses events outright.
    writer.flush().await.map_err(io_err)?;

    cursor.offset += consumed;
    cursor.size_seen = size;
    cursors.set(cursor);
    Ok(emitted)
}

/// Build a cursor for a newly discovered file, or `None` to skip it.
async fn new_cursor(
    spec: &Spec,
    path: &Path,
    dev: u64,
    inode: u64,
    meta: &std::fs::Metadata,
) -> Result<Option<FileCursor>, TaskError> {
    if let Some(days) = spec.params.since_days
        && !within_days(meta, days)
    {
        return Ok(None);
    }

    let head = read_range(path, 0, cursor::HEAD_FINGERPRINT_BYTES as u64)
        .await
        .unwrap_or_default();
    let header = read_header(path).await.unwrap_or_default();
    let session_id = (spec.format.session_id_from_path)(path).unwrap_or_else(|| {
        // A synthetic id keeps the session distinct rather than merging it with
        // another, but it will not match anything else, so say so.
        tracing::warn!(
            file = %path.display(),
            "no session id in the path; using a synthetic one that will not correlate"
        );
        format!("{}-{dev}-{inode}", spec.format.kind)
    });
    let agent_id = (spec.format.agent_id_from_path)(path, &header)
        .unwrap_or_else(|| spec.params.agent_id.clone());

    let mut state = TailState::default();
    (spec.format.seed_state)(&header, &mut state);

    Ok(Some(FileCursor {
        path: path.to_path_buf(),
        dev,
        inode,
        offset: 0,
        size_seen: 0,
        session_id: Some(session_id),
        agent_id: Some(agent_id),
        agent_start_emitted: false,
        ended: false,
        last_ts: None,
        first_line_len: first_line_len(&header),
        first_seen_epoch_ms: mtime_epoch_ms(meta),
        head_fingerprint: Some(cursor::head_fingerprint(&head)),
        state,
    }))
}

/// The file's modification time as epoch milliseconds, if the platform reports
/// one. Captured once at discovery so a timestamp-less format can anchor on it.
fn mtime_epoch_ms(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

/// Re-read line 1 and shift the cursor by any change in its length.
///
/// factory/droid rewrites that line in place when it names a session. The file
/// keeps growing normally, but every offset past line 1 moves — so a cursor
/// left alone resumes mid-record and produces garbage from then on. Observed
/// live: line 1 grew 191 → 268 bytes while the file grew 191 → 9145.
async fn rebase_on_first_line(path: &Path, cursor: &mut FileCursor) {
    let Ok(header) = read_header(path).await else {
        return;
    };
    let Some(now_len) = first_line_len(&header) else {
        return;
    };
    let Some(was_len) = cursor.first_line_len else {
        cursor.first_line_len = Some(now_len);
        return;
    };
    if now_len == was_len {
        return;
    }

    let delta = now_len as i64 - was_len as i64;
    let rebased = (cursor.offset as i64 + delta).max(0) as u64;
    tracing::info!(
        file = %path.display(),
        was_len, now_len, delta,
        old_offset = cursor.offset, new_offset = rebased,
        "first line was rewritten in place; rebasing the cursor"
    );
    cursor.offset = rebased;
    cursor.first_line_len = Some(now_len);
}

fn first_line_len(header: &[String]) -> Option<u64> {
    header.first().map(|l| l.len() as u64 + 1) // +1 for the newline
}

/// Files under `roots` matching `predicate`, walked iteratively.
///
/// Missing or unreadable directories are skipped silently: the agent may
/// simply not be installed, which is not an error.
async fn discover(roots: &[PathBuf], predicate: fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = roots.to_vec();
    while let Some(dir) = stack.pop() {
        let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let path = entry.path();
            match entry.file_type().await {
                Ok(ft) if ft.is_dir() => stack.push(path),
                Ok(ft) if ft.is_file() && predicate(&path) => out.push(path),
                _ => {}
            }
        }
    }
    out.sort();
    out
}

async fn read_header(path: &Path) -> std::io::Result<Vec<String>> {
    let chunk = read_range(path, 0, HEADER_MAX_BYTES).await?;
    Ok(String::from_utf8_lossy(&chunk)
        .lines()
        .take(HEADER_LINES)
        .map(|s| s.to_string())
        .collect())
}

/// Read `[from, to)`, tolerating a file shorter than `to`.
async fn read_range(path: &Path, from: u64, to: u64) -> std::io::Result<Vec<u8>> {
    let mut f = tokio::fs::File::open(path).await?;
    f.seek(std::io::SeekFrom::Start(from)).await?;
    let mut buf = Vec::new();
    f.take(to.saturating_sub(from))
        .read_to_end(&mut buf)
        .await?;
    Ok(buf)
}

fn is_idle(meta: &std::fs::Metadata, mins: u64) -> bool {
    let Ok(modified) = meta.modified() else {
        return false;
    };
    std::time::SystemTime::now()
        .duration_since(modified)
        .map(|d| d.as_secs() >= mins.saturating_mul(60))
        .unwrap_or(false)
}

fn within_days(meta: &std::fs::Metadata, days: u64) -> bool {
    let Ok(modified) = meta.modified() else {
        return true; // unreadable mtime: include rather than silently drop
    };
    std::time::SystemTime::now()
        .duration_since(modified)
        .map(|d| d.as_secs() <= days.saturating_mul(86_400))
        .unwrap_or(true)
}

fn io_err(e: std::io::Error) -> TaskError {
    TaskError::from(e.to_string())
}
