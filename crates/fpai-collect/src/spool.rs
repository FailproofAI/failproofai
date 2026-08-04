//! Durable hand-off between a source and the uploader.
//!
//! A source transforms records into events and pushes them here; this writes
//! them as `<prefix>-<tag>-<run>-<seq>.jsonl` batches into the spool directory,
//! where the watcher and sweeper pick them up. The agent's own files and
//! databases are never handed to the uploader, so they are never touched.
//!
//! # Three properties that are load-bearing
//!
//! **Writes are atomic.** Every batch is written to `.tmp`, fsynced, then
//! renamed into place. A reader therefore never observes a partial file — and
//! `.tmp` is not `.jsonl`, so the watcher skips it without needing to know
//! this. Combined with "flush before advancing the cursor", a crash costs at
//! most a re-ship, never a lost event.
//!
//! **No single line may exceed the batch cap.** A line larger than one request
//! could never be delivered: it would fail, be parked, be retried at the same
//! size, and fail identically forever. So oversized events are first shrunk by
//! truncating their long string fields, and dropped with a warning if they are
//! still too big. Dropping is the honest outcome — the record remains in the
//! agent's own store, so nothing is lost from the source, whereas parking it
//! would quietly accumulate undeliverable files.
//!
//! **Truncation is deterministic.** The server dedups on a content hash, so
//! the same input must always produce the same bytes. That rules out anything
//! involving time, randomness or a sampled decision, and is why truncation
//! marks the original length rather than, say, the moment it was cut.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::config::Redact;

/// Longest single string field kept intact. One oversized tool output must not
/// be able to push a whole batch past the body cap.
const MAX_FIELD_BYTES: usize = 1024 * 1024;

/// Floor for the batch cap. A cap below this would roll a new file per event.
const MIN_BATCH_BYTES: u64 = 64 * 1024;

/// Default batch cap, matching the ingest endpoint's body limit.
pub const DEFAULT_MAX_BATCH_BYTES: u64 = 8 * 1024 * 1024;

/// Accumulates events and writes them out as size-bounded batches.
pub struct SpoolWriter {
    dir: PathBuf,
    max_batch_bytes: u64,
    prefix: String,
    tag: String,
    run_id: u128,
    seq: u64,
    buf: String,
    buf_bytes: u64,
    redact: Redact,
    redacted: u64,
    /// The machine this daemon runs on, stamped on every event so the server
    /// can tell one machine from another. Without it, events carry only
    /// `agent_id` — a per-project/per-harness identity — and the fleet views
    /// mistake every project for a separate machine. `None` on a machine that
    /// was never enrolled with a machine id (older config); such events simply
    /// carry no machine and are excluded from machine-level counts rather than
    /// guessed into one.
    machine_id: Option<String>,
}

impl SpoolWriter {
    /// `prefix` is the source kind (`claude`, `hooks`, …) and `tag` a short
    /// session identifier; together they make a derived batch recognisable in
    /// a shared spool directory.
    ///
    /// `run_id` is nanoseconds since the epoch, which distinguishes files
    /// across restarts. Without it a fresh run would reuse `seq` 0 and could
    /// clobber a batch the previous run had written but not yet uploaded.
    pub fn new(dir: PathBuf, max_batch_bytes: u64, prefix: &str, tag: &str) -> Self {
        let run_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        SpoolWriter {
            dir,
            max_batch_bytes: max_batch_bytes.max(MIN_BATCH_BYTES),
            prefix: sanitize_tag(prefix),
            tag: sanitize_tag(tag),
            run_id,
            seq: 0,
            buf: String::new(),
            buf_bytes: 0,
            // Default ON. A source that forgets to opt in still gets scrubbed,
            // which is the safe direction for the mistake to fall.
            redact: Redact::Minimal,
            redacted: 0,
            machine_id: None,
        }
    }

    /// Override the redaction mode. Only `Redact::Off` changes anything —
    /// scrubbing is on by default so a new source cannot ship secrets by
    /// omission.
    pub fn with_redact(mut self, mode: Redact) -> Self {
        self.redact = mode;
        self
    }

    /// Set the machine id stamped on every event. An empty string is treated as
    /// absent, so a misconfigured blank id never becomes a machine of its own.
    pub fn with_machine_id(mut self, id: Option<String>) -> Self {
        self.machine_id = id.filter(|s| !s.is_empty());
        self
    }

    /// How many string leaves have been scrubbed. Reported without ever
    /// logging what was removed.
    pub fn redacted_count(&self) -> u64 {
        self.redacted
    }

    /// Events buffered but not yet written. Used by callers that must flush
    /// before advancing a cursor.
    pub fn pending_bytes(&self) -> u64 {
        self.buf_bytes
    }

    /// Append one event, rolling to a new batch first if it would not fit.
    pub async fn push(&mut self, mut event: Value) -> std::io::Result<()> {
        // The single choke point every event passes through, which is why
        // redaction happens here rather than in each transform: a source
        // cannot forget it, and a new source inherits it for free. It runs
        // BEFORE serialization, so what gets hashed, spooled and uploaded is
        // the scrubbed form — there is no window where the raw value exists on
        // disk.
        self.redacted += crate::redact::scrub_value(&mut event, self.redact) as u64;

        // Stamp the machine id here, at the one point every event passes
        // through — a source cannot forget it and a new source inherits it. Set
        // only when absent, so an event that already names its machine (a
        // re-shipped batch, say) is never overwritten.
        if let Some(id) = &self.machine_id
            && let Some(obj) = event.as_object_mut()
        {
            obj.entry("machine_id")
                .or_insert_with(|| Value::String(id.clone()));
        }

        let mut line = serialize(&event)?;

        if line.len() as u64 > self.max_batch_bytes {
            truncate_strings(&mut event, MAX_FIELD_BYTES);
            line = serialize(&event)?;
        }

        if line.len() as u64 > self.max_batch_bytes {
            // Still over cap after truncation — thousands of small fields, say.
            // Shipping it would produce a batch the server refuses, which then
            // parks and retries forever at the same size.
            let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("?");
            tracing::warn!(
                source = %self.prefix,
                bytes = line.len(),
                max = self.max_batch_bytes,
                event_type,
                "dropping an event that exceeds the batch cap even after truncation; \
                 it remains in the agent's own store"
            );
            return Ok(());
        }

        let needed = line.len() as u64 + 1; // +1 for the newline
        if !self.buf.is_empty() && self.buf_bytes + needed > self.max_batch_bytes {
            self.flush().await?;
        }
        self.buf.push_str(&line);
        self.buf.push('\n');
        self.buf_bytes += needed;
        Ok(())
    }

    /// Durably write the buffered events as one batch. No-op when empty.
    ///
    /// Callers MUST await this before advancing any persisted cursor. The
    /// ordering is the whole durability argument: flush-then-advance costs a
    /// re-ship on crash (which the server dedups), advance-then-flush loses
    /// the events outright.
    pub async fn flush(&mut self) -> std::io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        tokio::fs::create_dir_all(&self.dir).await?;

        let stem = format!("{}-{}-{}-{}", self.prefix, self.tag, self.run_id, self.seq);
        let tmp = self.dir.join(format!("{stem}.tmp"));
        let final_path = self.dir.join(format!("{stem}.jsonl"));

        let mut f = tokio::fs::File::create(&tmp).await?;
        f.write_all(self.buf.as_bytes()).await?;
        // fsync before rename: a rename is atomic with respect to readers, but
        // it does not guarantee the CONTENT reached disk. Without this, a
        // power loss can leave a correctly-named, zero-length batch — which
        // the uploader would happily deliver as an empty file.
        f.sync_all().await?;
        drop(f);
        tokio::fs::rename(&tmp, &final_path).await?;

        self.seq += 1;
        self.buf.clear();
        self.buf_bytes = 0;
        Ok(())
    }
}

fn serialize(event: &Value) -> std::io::Result<String> {
    serde_json::to_string(event).map_err(std::io::Error::other)
}

/// Keep a tag filename-safe and bounded.
///
/// The charset matters beyond hygiene: batch filenames encode retry state as
/// suffixes, so a tag containing a `.` could make a fresh batch parse as one
/// that had already been retried.
fn sanitize_tag(tag: &str) -> String {
    let cleaned: String = tag
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(16)
        .collect();
    if cleaned.is_empty() {
        "session".to_string()
    } else {
        cleaned
    }
}

/// Recursively truncate long string leaves to `cap` bytes at a char boundary.
///
/// Deterministic by construction: the marker records the ORIGINAL length, so
/// the same input always yields identical bytes. The truncated payload feeds
/// the server's dedup hash, so a marker containing a timestamp or a counter
/// would make every re-read of the same event look like a new one.
fn truncate_strings(v: &mut Value, cap: usize) {
    match v {
        Value::String(s) if s.len() > cap => {
            let orig = s.len();
            let mut end = cap;
            while end > 0 && !s.is_char_boundary(end) {
                end -= 1;
            }
            let mut truncated = s[..end].to_string();
            truncated.push_str(&format!("…[truncated {orig} bytes]"));
            *s = truncated;
        }
        Value::Array(a) => a.iter_mut().for_each(|e| truncate_strings(e, cap)),
        Value::Object(o) => o.values_mut().for_each(|e| truncate_strings(e, cap)),
        _ => {}
    }
}

/// True if `path` is a batch the uploader should pick up.
///
/// `.tmp` files are excluded by the extension check rather than by a separate
/// rule, which is exactly why the atomic write works: a batch is invisible
/// until the instant it is renamed.
pub fn is_batch_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("jsonl")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "fpai-spool-{}-{}-{}",
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

    fn batches(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".jsonl"))
            .collect();
        v.sort();
        v
    }

    #[tokio::test]
    async fn writes_one_batch_and_leaves_no_tmp_behind() {
        let dir = tmpdir("basic");
        let mut w = SpoolWriter::new(dir.clone(), DEFAULT_MAX_BATCH_BYTES, "hooks", "sess1");
        w.push(json!({"type": "hook_triggered", "n": 1}))
            .await
            .unwrap();
        w.push(json!({"type": "hook_completed", "n": 1}))
            .await
            .unwrap();
        w.flush().await.unwrap();

        let files = batches(&dir);
        assert_eq!(files.len(), 1, "expected one batch, got {files:?}");
        assert!(files[0].starts_with("hooks-sess1-"));

        let leftover_tmp = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(!leftover_tmp, "a .tmp file survived the rename");

        let body = std::fs::read_to_string(dir.join(&files[0])).unwrap();
        assert_eq!(body.lines().count(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn rolls_to_a_new_batch_at_the_size_cap() {
        let dir = tmpdir("roll");
        let mut w = SpoolWriter::new(dir.clone(), MIN_BATCH_BYTES, "claude", "s");
        for i in 0..100 {
            w.push(json!({"type": "tool_use", "n": i, "pad": "x".repeat(2000)}))
                .await
                .unwrap();
        }
        w.flush().await.unwrap();
        assert!(
            batches(&dir).len() > 1,
            "200KB of events under a 64KB cap must roll into several batches"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn no_written_line_ever_exceeds_the_batch_cap() {
        // The invariant the uploader depends on: a line bigger than one
        // request can never be delivered, so it must never reach the spool.
        let dir = tmpdir("cap");
        let mut w = SpoolWriter::new(dir.clone(), MIN_BATCH_BYTES, "claude", "s");
        w.push(json!({"type": "tool_result", "output": "y".repeat(3 * 1024 * 1024)}))
            .await
            .unwrap();
        w.flush().await.unwrap();

        for f in batches(&dir) {
            let body = std::fs::read_to_string(dir.join(&f)).unwrap();
            for line in body.lines() {
                assert!(
                    line.len() as u64 <= MIN_BATCH_BYTES,
                    "a {}-byte line was written under a {MIN_BATCH_BYTES}-byte cap",
                    line.len()
                );
            }
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn drops_an_event_that_is_still_over_cap_after_truncation() {
        // Many small fields: no single field is big enough for truncation to
        // shrink, so the whole line stays over cap and must be dropped rather
        // than written into a batch that could never be delivered.
        let dir = tmpdir("drop");
        let mut w = SpoolWriter::new(dir.clone(), MIN_BATCH_BYTES, "claude", "s");
        let mut obj = serde_json::Map::new();
        obj.insert("type".into(), json!("tool_result"));
        for i in 0..2000 {
            obj.insert(format!("f{i}"), json!("x".repeat(64)));
        }
        w.push(Value::Object(obj)).await.unwrap();
        w.flush().await.unwrap();

        assert!(
            batches(&dir).is_empty(),
            "an undeliverable event must be dropped, never spooled"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn truncation_is_deterministic() {
        // Non-negotiable: the server dedups on a content hash, so a re-read of
        // the same source bytes must produce identical output.
        let big = "a".repeat(3 * 1024 * 1024);
        let mut a = json!({"output": big.clone()});
        let mut b = json!({"output": big});
        truncate_strings(&mut a, MAX_FIELD_BYTES);
        truncate_strings(&mut b, MAX_FIELD_BYTES);
        assert_eq!(a, b);
        let s = a["output"].as_str().unwrap();
        assert!(s.contains("truncated"));
        assert!(s.len() < 2 * 1024 * 1024);
    }

    #[test]
    fn truncation_cuts_on_a_char_boundary() {
        // Cutting mid-codepoint would panic on the slice, or emit invalid
        // UTF-8 that the server rejects for the whole batch.
        let mut v = json!({ "output": "é".repeat(200) });
        truncate_strings(&mut v, 101); // lands mid-codepoint: 'é' is 2 bytes
        assert!(v["output"].as_str().unwrap().contains("truncated"));
    }

    #[test]
    fn a_tag_cannot_smuggle_retry_state_into_a_filename() {
        // Retry state is encoded as filename suffixes, so a tag containing a
        // dot could make a brand-new batch parse as an already-retried one.
        assert_eq!(sanitize_tag("sess.a1.c404"), "sessa1c404");
        assert_eq!(sanitize_tag("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_tag(""), "session");
        assert_eq!(sanitize_tag("!!!"), "session");
        assert_eq!(sanitize_tag(&"a".repeat(64)).len(), 16);
    }

    #[tokio::test]
    async fn flushing_an_empty_writer_creates_nothing() {
        let dir = tmpdir("empty");
        let mut w = SpoolWriter::new(dir.clone(), DEFAULT_MAX_BATCH_BYTES, "hooks", "s");
        w.flush().await.unwrap();
        assert!(batches(&dir).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn secrets_are_scrubbed_before_anything_touches_disk() {
        // The choke-point guarantee: a source that never thinks about
        // redaction still cannot write a credential into the spool.
        let dir = tmpdir("redact");
        let mut w = SpoolWriter::new(dir.clone(), DEFAULT_MAX_BATCH_BYTES, "claude", "s");
        w.push(json!({
            "type": "tool_use",
            "input": {"command": "curl -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123'"}
        }))
        .await
        .unwrap();
        w.flush().await.unwrap();

        let name = batches(&dir).remove(0);
        let body = std::fs::read_to_string(dir.join(&name)).unwrap();
        assert!(
            !body.contains("ghp_abcdefghij"),
            "a credential reached disk: {body}"
        );
        assert!(
            body.contains("[redacted:"),
            "redaction marker missing: {body}"
        );
        assert!(w.redacted_count() >= 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn machine_id_is_stamped_on_every_event_when_set() {
        // Without this the server can only group by agent_id — a per-project
        // identity — so one machine's many projects each read as a machine.
        let dir = tmpdir("machine-id");
        let mut w = SpoolWriter::new(dir.clone(), DEFAULT_MAX_BATCH_BYTES, "claude", "s")
            .with_machine_id(Some("beta-test".into()));
        w.push(json!({"type": "agent_start", "agent_id": "claude-foo"}))
            .await
            .unwrap();
        w.flush().await.unwrap();
        let name = batches(&dir).remove(0);
        let body = std::fs::read_to_string(dir.join(&name)).unwrap();
        assert!(body.contains(r#""machine_id":"beta-test""#), "got {body}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_absent_machine_id_stamps_nothing() {
        // A machine that was never given an id must not invent one — the server
        // excludes machine-less events rather than bucket them.
        let dir = tmpdir("no-machine-id");
        let mut w = SpoolWriter::new(dir.clone(), DEFAULT_MAX_BATCH_BYTES, "claude", "s");
        w.push(json!({"type": "agent_start"})).await.unwrap();
        w.flush().await.unwrap();
        let name = batches(&dir).remove(0);
        assert!(
            !std::fs::read_to_string(dir.join(&name))
                .unwrap()
                .contains("machine_id")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_empty_machine_id_is_treated_as_absent() {
        let dir = tmpdir("blank-machine-id");
        let mut w = SpoolWriter::new(dir.clone(), DEFAULT_MAX_BATCH_BYTES, "claude", "s")
            .with_machine_id(Some(String::new()));
        w.push(json!({"type": "agent_start"})).await.unwrap();
        w.flush().await.unwrap();
        let name = batches(&dir).remove(0);
        assert!(
            !std::fs::read_to_string(dir.join(&name))
                .unwrap()
                .contains("machine_id")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn redaction_can_be_turned_off() {
        let dir = tmpdir("redact-off");
        let mut w = SpoolWriter::new(dir.clone(), DEFAULT_MAX_BATCH_BYTES, "claude", "s")
            .with_redact(Redact::Off);
        w.push(json!({"output": "ghp_abcdefghijklmnopqrstuvwxyz0123"}))
            .await
            .unwrap();
        w.flush().await.unwrap();
        let name = batches(&dir).remove(0);
        assert!(
            std::fs::read_to_string(dir.join(&name))
                .unwrap()
                .contains("ghp_abcdefghij")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_jsonl_is_a_batch() {
        assert!(is_batch_file(Path::new("/s/hooks-a-1-0.jsonl")));
        // The atomic-write contract depends on this exclusion.
        assert!(!is_batch_file(Path::new("/s/hooks-a-1-0.tmp")));
        assert!(!is_batch_file(Path::new("/s/hooks-a-1-0.jsonl.poison")));
    }
}
