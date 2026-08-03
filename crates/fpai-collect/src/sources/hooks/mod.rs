//! The hook-activity source.
//!
//! Tails `~/.failproofai/cache/hook-activity/*.jsonl` and turns each row into
//! AgentEye hook events. This is the capability `agenteye-collector`
//! structurally cannot have: failproofai already sits in the hook path of
//! every supported agent CLI, and nothing else on the machine does.
//!
//! # One source covers every CLI
//!
//! The store is CLI-agnostic — each row carries its own `integration` — so
//! twelve agents are covered by one tailer rather than twelve. Coverage is a
//! function of where failproofai's hooks are installed, not of anything here.
//!
//! # Session ids line up for free
//!
//! Measured on a real machine: 25 of 43 hook sessions share an exact session id
//! with a Claude transcript, and a live Copilot run produced a hook `sessionId`
//! identical to both its resume id and the id inside its own transcript. So
//! hook events land on the same AgentEye session as the tool calls around them
//! with no mapping table, which is what makes them useful rather than a
//! separate stream nobody correlates.
//!
//! # Rotation
//!
//! The store appends to `current.jsonl` and, every 25 rows, RENAMES it to
//! `page-<ts>-<seq>.jsonl` before creating a fresh `current.jsonl`. Cursors are
//! keyed by inode precisely so that rename is a no-op for us — see
//! [`crate::cursor`]. The store's other files (`current.count`, `stats.json`,
//! `current.lock`) are excluded by the `.jsonl` check.
//!
//! # A known limit of the aggregated mode
//!
//! Under [`HooksVerbosity::Decisions`], `allow` rows are rolled up per
//! `(session, event, tool, minute)`. That roll-up is computed per poll pass, so
//! it is only idempotent when a re-read covers the same rows.
//!
//! In normal operation it is: cursors advance only after the pass's events are
//! durably spooled, so a crash re-reads exactly what it read before and
//! produces byte-identical buckets, which the server's content-hash dedup
//! collapses. Measured against a 20,392-row corpus, a second run with cursors
//! intact emits nothing at all.
//!
//! What is NOT idempotent is a re-read that sees a *different* number of rows
//! for a bucket than a previous one did — losing the cursor file after a pass,
//! say. The bucket is then emitted twice with different counts, and because the
//! payloads differ the server stores both rather than collapsing them, so that
//! minute's allow total is overstated. Deny and instruct events are unaffected:
//! they are emitted per row with an offset-derived id, so a re-read reproduces
//! them exactly.
//!
//! Aggregating a stream cannot avoid this in general — a bucket is only final
//! once no more rows can land in it, which is not knowable while tailing. Use
//! [`HooksVerbosity::All`] where exact allow counts matter more than volume.

pub mod transform;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::config::HooksVerbosity;
use crate::cursor::{CursorStore, FileCursor, identity};
use crate::spool::{DEFAULT_MAX_BATCH_BYTES, SpoolWriter, is_batch_file};
use crate::supervisor::{Shutdown, TaskError};
use transform::{AllowBucket, HookRow, bucket_key};

/// How often the store is re-scanned. Hook rows are written by short-lived
/// processes many times a minute; this is frequent enough to feel live without
/// scanning 800 files constantly.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Most bytes read from one file per poll. Bounds memory when a backlog is
/// being worked through.
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

/// Run the source until shutdown.
pub async fn run(
    store_dir: PathBuf,
    state_dir: PathBuf,
    spool_dir: PathBuf,
    verbosity: HooksVerbosity,
    environment: String,
    sd: Shutdown,
) -> Result<(), TaskError> {
    if verbosity == HooksVerbosity::Off {
        // Nothing to do, but returning Ok would end the task; idle instead so
        // the supervisor's task list stays a straightforward reflection of
        // what is configured.
        while !sd.is_set() {
            sd.sleep(POLL_INTERVAL).await;
        }
        return Ok(());
    }

    let mut cursors = CursorStore::load(state_dir.clone());
    tracing::info!(
        dir = %store_dir.display(),
        resumed = cursors.len(),
        ?verbosity,
        "hook-activity source started"
    );

    loop {
        if let Err(err) = poll_once(
            &store_dir,
            &spool_dir,
            &mut cursors,
            verbosity,
            &environment,
        )
        .await
        {
            // Logged and retried on the next tick rather than returned: one
            // unreadable page must not restart the source and re-scan
            // everything.
            tracing::warn!(%err, "hook-activity poll failed; retrying next tick");
        }
        if !sd.sleep(POLL_INTERVAL).await {
            return Ok(());
        }
    }
}

/// One pass over the store.
async fn poll_once(
    store_dir: &Path,
    spool_dir: &Path,
    cursors: &mut CursorStore,
    verbosity: HooksVerbosity,
    environment: &str,
) -> Result<(), TaskError> {
    let files = list_pages(store_dir).await;
    if files.is_empty() {
        return Ok(());
    }

    let mut writer = SpoolWriter::new(
        spool_dir.to_path_buf(),
        DEFAULT_MAX_BATCH_BYTES,
        "hooks",
        "activity",
    );
    // Allow rows are rolled up across the whole pass, so a bucket spanning two
    // files still emits once.
    let mut buckets: BTreeMap<(String, String, Option<String>, i64), AllowBucket> = BTreeMap::new();
    let mut advanced: Vec<FileCursor> = Vec::new();

    for path in files {
        let Ok(meta) = tokio::fs::metadata(&path).await else {
            continue;
        };
        let (dev, inode) = identity(&meta);
        let size = meta.len();

        let mut offset = cursors
            .resume(dev, inode, &path)
            .map(|c| c.offset)
            .unwrap_or(0);

        // The store never rewrites a page, so a shrink means the file was
        // replaced under a reused inode. Re-read rather than seek past the end.
        if size < offset {
            tracing::warn!(file = %path.display(), size, offset, "file shrank; re-reading from the start");
            offset = 0;
        }
        if size == offset {
            continue;
        }

        let read_end = size.min(offset + MAX_READ_BYTES);
        let Ok(chunk) = read_range(&path, offset, read_end).await else {
            continue;
        };

        // Consume only up to the last newline: the final line may still be
        // being written, and half a JSON object parses as nothing.
        let Some(last_nl) = chunk.iter().rposition(|b| *b == b'\n') else {
            continue;
        };
        let usable = &chunk[..=last_nl];

        let mut line_start = offset;
        for line in usable.split_inclusive(|b| *b == b'\n') {
            let this_offset = line_start;
            line_start += line.len() as u64;

            let Ok(text) = std::str::from_utf8(line) else {
                continue;
            };
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            let Ok(row) = serde_json::from_str::<HookRow>(text) else {
                continue;
            };

            let aggregate = verbosity == HooksVerbosity::Decisions && row.is_allow();
            if aggregate {
                if let Some(key) = bucket_key(&row) {
                    buckets
                        .entry(key.clone())
                        .or_insert_with(|| AllowBucket {
                            session_id: key.0.clone(),
                            agent_id: transform::agent_id(&row),
                            event_name: key.1.clone(),
                            tool_name: key.2.clone(),
                            minute_ms: key.3,
                            count: 0,
                            total_duration_ms: 0.0,
                            max_duration_ms: 0.0,
                        })
                        .add(&row);
                }
                continue;
            }

            for event in transform::to_events(&row, this_offset, environment) {
                writer.push(event).await.map_err(io_err)?;
            }
        }

        advanced.push(FileCursor {
            path: path.clone(),
            dev,
            inode,
            offset: offset + usable.len() as u64,
            size_seen: size,
        });
    }

    for bucket in buckets.values() {
        if let Some(event) = bucket.to_event(environment) {
            writer.push(event).await.map_err(io_err)?;
        }
    }

    // Flush BEFORE advancing cursors. A crash between the two costs a re-ship,
    // which the server dedups on a content hash; the other order loses the
    // events outright.
    writer.flush().await.map_err(io_err)?;

    for c in advanced {
        cursors.set(c);
    }
    cursors.retain_existing();
    cursors.save().map_err(io_err)?;
    Ok(())
}

fn io_err(e: std::io::Error) -> TaskError {
    TaskError::from(e.to_string())
}

/// Every `.jsonl` in the store, oldest first.
///
/// Oldest first so a backlog is shipped in the order it happened; the
/// `.jsonl` filter is what excludes `current.count`, `stats.json` and the
/// lock file without naming them.
async fn list_pages(dir: &Path) -> Vec<PathBuf> {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return Vec::new();
    };
    let mut out: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        if !is_batch_file(&path) {
            continue;
        }
        let modified = entry
            .metadata()
            .await
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        out.push((modified, path));
    }
    out.sort_by_key(|(t, _)| *t);
    out.into_iter().map(|(_, p)| p).collect()
}

async fn read_range(path: &Path, from: u64, to: u64) -> std::io::Result<Vec<u8>> {
    let mut f = tokio::fs::File::open(path).await?;
    f.seek(std::io::SeekFrom::Start(from)).await?;
    let mut buf = vec![0u8; (to - from) as usize];
    f.read_exact(&mut buf).await?;
    Ok(buf)
}
