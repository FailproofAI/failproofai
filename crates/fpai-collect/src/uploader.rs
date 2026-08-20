//! Ships spooled batches to the ingest endpoint.
//!
//! Four properties here are load-bearing. Each one exists because its absence
//! loses data rather than merely slowing things down.
//!
//! **The timeout is per-read, not per-request.** A whole-request timeout also
//! bounds streaming the body, and the body is re-sent in full on every retry —
//! so a large batch on an ordinary uplink can never finish, and burns its
//! entire retry budget failing the same way each time. A per-read timeout
//! bounds progress instead of total size. On its own it bounds nothing,
//! though: a server trickling one byte inside every window would hold the
//! request open forever, so a deliberately generous total cap stays as a
//! backstop. It is a large multiple of the read timeout so it only ever
//! catches a genuinely stuck request, never a merely slow one.
//!
//! **A 2xx is not automatically a success.** Ingest answers
//! `{"accepted":N,"skipped":M}` and silently skips any line it cannot parse —
//! a missing `session_id`, an unparseable timestamp, a comma in
//! `environment`. Without reading that body, a batch the server discarded
//! entirely is indistinguishable from a perfect upload.
//!
//! **`failed/` is a retry queue, not a graveyard.** A batch there is data the
//! server does not have, and it is the last copy. Batches are retried in place
//! with the attempt count encoded in the filename, and only ever parked as
//! `.poison` — never deleted.
//!
//! **Oversized batches are split in memory.** Writing the chunks to disk
//! beside the original would create files the watcher had never seen, so it
//! would pick them up and post them concurrently with this function — the same
//! payload delivered twice.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

/// Suffix marking a batch that exhausted its retry budget. Deliberately NOT
/// `.jsonl`, so every directory scan and the watcher skip it for free rather
/// than each needing its own filter.
pub const POISON_SUFFIX: &str = ".poison";

/// Largest body sent in one request. Bigger spool files are split.
pub const DEFAULT_MAX_UPLOAD_BYTES: u64 = 8 * 1024 * 1024;
/// Total attempts per batch, including the first.
pub const DEFAULT_MAX_RETRIES: u32 = 5;
/// Base for the exponential backoff.
pub const DEFAULT_RETRY_BASE: Duration = Duration::from_millis(1000);
/// Per-read timeout. Bounds progress, not total transfer size.
pub const DEFAULT_READ_TIMEOUT: Duration = Duration::from_secs(120);
/// Attempts a parked batch gets before it is marked poison.
pub const DEFAULT_FAILED_RETRIES_MAX: u32 = 3;
/// Ceiling applied to a server-supplied `Retry-After`, so a misconfigured
/// header cannot park the uploader for hours.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(300);

#[derive(Debug)]
pub enum UploadError {
    /// A definitive client error. Not retried — the cause is a rotated key or
    /// a wrong URL, and retrying burns the budget of every other batch.
    Client {
        status: u16,
    },
    Server {
        status: u16,
        attempts: u32,
    },
    Network {
        attempts: u32,
        detail: String,
    },
    /// A 2xx whose ack says the server stored NONE of the batch. Not a
    /// success: the events are not on the server and this file is their last
    /// copy, so it is parked rather than deleted.
    StoredNothing {
        skipped: u64,
    },
    Io(std::io::Error),
}

impl std::fmt::Display for UploadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UploadError::Client { status } => write!(f, "client error {status}: not retried"),
            UploadError::Server { status, attempts } => {
                write!(f, "server error {status} after {attempts} attempt(s)")
            }
            UploadError::StoredNothing { skipped } => {
                write!(
                    f,
                    "the server stored none of this batch ({skipped} skipped)"
                )
            }
            UploadError::Network { attempts, detail } => {
                write!(f, "network error after {attempts} attempt(s): {detail}")
            }
            UploadError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl std::error::Error for UploadError {}

impl From<std::io::Error> for UploadError {
    fn from(e: std::io::Error) -> Self {
        UploadError::Io(e)
    }
}

/// What ingest reports it did with a batch. `skipped` counts lines it refused
/// to store; those are gone, and nothing retries them.
#[derive(Debug, Default, Deserialize)]
struct IngestAck {
    // REQUIRED — no serde default. This is what proves the 2xx came from the
    // ingest endpoint and not a login page, a proxy or a static host that
    // happens to answer 200. An adversarial red-team pointed a live daemon at a
    // dashboard-lookalike (POST /events -> 307 -> /login -> 200 text/html); the
    // old `resp.json().unwrap_or_default()` turned that HTML into a default ack,
    // reported the batch delivered, and DELETED the spool file — silent, total
    // data loss. A body without a numeric `accepted` now fails to parse and the
    // batch is parked instead.
    accepted: u64,
    #[serde(default)]
    skipped: u64,
}

/// Delivery counters. Live on the long-lived `Uploader` so a supervised task
/// restart never resets them to zero — a counter that silently rewinds is
/// worse than no counter, because it reads as "nothing has gone wrong".
#[derive(Debug, Default)]
pub struct UploadMetrics {
    pub accepted_total: AtomicU64,
    pub skipped_total: AtomicU64,
    /// Batches the server answered 200 for while storing NONE of their events.
    pub batches_fully_skipped: AtomicU64,
    /// Unix seconds of the last upload the server accepted.
    pub last_ok_ts: AtomicU64,
}

pub struct Uploader {
    client: reqwest::Client,
    url: String,
    key: String,
    failed_dir: PathBuf,
    max_upload_bytes: u64,
    max_retries: u32,
    retry_base: Duration,
    failed_retries_max: u32,
    metrics: Arc<UploadMetrics>,
}

impl Uploader {
    pub fn new(url: String, key: String, failed_dir: PathBuf) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(DEFAULT_READ_TIMEOUT)
            // Backstop only — see the module docs. Large multiple of the read
            // timeout so it catches a stuck request, never a slow one.
            .timeout(DEFAULT_READ_TIMEOUT.saturating_mul(10))
            // NEVER follow a redirect. reqwest follows by default, and a
            // misconfigured or hostile ingest URL that 307s to another host
            // then re-POSTs the batch there — verified live, an attacker server
            // received full event payloads (prompts, command text) while the
            // spool file was deleted as "delivered". With no following, a 3xx
            // surfaces as a status that post_batch parks as a client error.
            // reqwest already strips the bearer token across hosts; this stops
            // the body from leaving too.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("could not build the HTTP client: {e}"))?;

        Ok(Uploader {
            client,
            url,
            key,
            failed_dir,
            max_upload_bytes: DEFAULT_MAX_UPLOAD_BYTES,
            max_retries: DEFAULT_MAX_RETRIES,
            retry_base: DEFAULT_RETRY_BASE,
            failed_retries_max: DEFAULT_FAILED_RETRIES_MAX,
            metrics: Arc::new(UploadMetrics::default()),
        })
    }

    /// Shorten every delay. Tests only — without it each retry test would wait
    /// out a real multi-second backoff.
    #[doc(hidden)]
    pub fn with_retry_base(mut self, base: Duration) -> Self {
        self.retry_base = base;
        self
    }

    #[doc(hidden)]
    pub fn with_max_upload_bytes(mut self, bytes: u64) -> Self {
        self.max_upload_bytes = bytes;
        self
    }

    pub fn metrics(&self) -> Arc<UploadMetrics> {
        self.metrics.clone()
    }

    /// Upload one batch file, deleting it once every chunk has landed.
    ///
    /// A `NotFound` on read is `Ok`: another task already handled this file.
    /// The delete happens only after all chunks succeed, so a crash part-way
    /// leaves the original intact and the worst case is re-sending chunks the
    /// server already has — byte-identical, so it dedups them.
    pub async fn upload_file(&self, path: &Path) -> Result<(), UploadError> {
        let bytes = match tokio::fs::read(path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(UploadError::Io(e)),
        };

        for chunk in split_lines(&bytes, self.max_upload_bytes) {
            self.post_batch(path, chunk).await?;
        }

        match tokio::fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(UploadError::Io(e)),
        }
    }

    /// POST one body, retrying per policy. `path` is used only for parking and
    /// log context — this never deletes it.
    async fn post_batch(&self, path: &Path, bytes: Vec<u8>) -> Result<(), UploadError> {
        let mut attempt: u32 = 0;

        loop {
            let result = self
                .client
                .post(&self.url)
                .header("Authorization", format!("Bearer {}", self.key))
                .header("Content-Type", "application/x-ndjson")
                // A HEADER, not a payload field, so it stays OUT of the
                // server's content-hash dedup key — otherwise every upgrade
                // would make previously-shipped events look new.
                .header("X-Failproofai-Collector-Version", env!("CARGO_PKG_VERSION"))
                .body(bytes.clone())
                .send()
                .await;

            attempt += 1;

            match result {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        // A 2xx is necessary but NOT sufficient. Require the body
                        // to actually be an ingest ack (a numeric `accepted`);
                        // otherwise this "success" is a login page or a proxy,
                        // and returning Ok here deletes the spool file behind it.
                        // Park instead, non-retryable — it will parse-fail
                        // identically until the URL is fixed.
                        match resp.json::<IngestAck>().await {
                            Ok(ack) => {
                                // `record_ack`'s own contract: "A 200 that stored
                                // nothing is an error, not a success." It said so
                                // and then returned Ok anyway, so `upload_file`
                                // deleted the file — the module's stated invariant
                                // is that `failed/` is a retry queue and a batch
                                // the server does not have is "never deleted", and
                                // this was the one path that broke it.
                                //
                                // Parked retryable (client_status None), not
                                // poison-on-sight: the observed cause was an
                                // intermediary mangling an oversized body, which a
                                // retry can survive. `park_inner` bounds that —
                                // attempt is encoded in the filename and becomes
                                // `.poison` at `failed_retries_max`, after which it
                                // is kept forever and never retried again.
                                if self.record_ack(path, &ack) {
                                    self.park(path, None, attempt).await;
                                    return Err(UploadError::StoredNothing {
                                        skipped: ack.skipped,
                                    });
                                }
                                return Ok(());
                            }
                            Err(_) => {
                                let code = status.as_u16();
                                self.park(path, Some(code), attempt).await;
                                return Err(UploadError::Client { status: code });
                            }
                        }
                    }

                    let code = status.as_u16();
                    // 408 and 429 are the two 4xx that mean "try again" rather
                    // than "you are wrong". Treating them as definitive would
                    // park a batch the server explicitly asked us to resend.
                    let retryable = status.is_server_error() || code == 408 || code == 429;
                    if !retryable {
                        self.park(path, Some(code), attempt).await;
                        return Err(UploadError::Client { status: code });
                    }
                    if attempt >= self.max_retries {
                        self.park(path, None, attempt).await;
                        return Err(UploadError::Server {
                            status: code,
                            attempts: attempt,
                        });
                    }
                    let wait = retry_after(&resp).unwrap_or_else(|| self.backoff(attempt));
                    tokio::time::sleep(wait).await;
                }
                Err(err) => {
                    if attempt >= self.max_retries {
                        self.park(path, None, attempt).await;
                        return Err(UploadError::Network {
                            attempts: attempt,
                            detail: err.to_string(),
                        });
                    }
                    tokio::time::sleep(self.backoff(attempt)).await;
                }
            }
        }
    }

    /// Interpret the ack body. A 200 that stored nothing is an error, not a
    /// success — it is the shape a systematically malformed transform takes,
    /// and without this it looks identical to a healthy upload.
    fn record_ack(&self, path: &Path, ack: &IngestAck) -> bool {
        self.metrics
            .accepted_total
            .fetch_add(ack.accepted, Ordering::Relaxed);
        self.metrics
            .skipped_total
            .fetch_add(ack.skipped, Ordering::Relaxed);
        self.metrics
            .last_ok_ts
            .store(unix_now_secs(), Ordering::Relaxed);

        if ack.accepted == 0 && ack.skipped > 0 {
            self.metrics
                .batches_fully_skipped
                .fetch_add(1, Ordering::Relaxed);
            tracing::error!(
                file = %path.display(),
                skipped = ack.skipped,
                "the server accepted the request but stored NONE of its events; \
                 every line was rejected as malformed"
            );
        } else if ack.skipped > 0 {
            tracing::warn!(
                file = %path.display(),
                accepted = ack.accepted,
                skipped = ack.skipped,
                "the server skipped some events in this batch"
            );
        }

        ack.accepted == 0 && ack.skipped > 0
    }

    /// `base * 2^(attempt-1)` plus jitter.
    ///
    /// The jitter matters more than the curve: without it every collector that
    /// went down during the same outage retries in lockstep afterwards and
    /// re-creates the outage. Derived from the clock rather than a PRNG so this
    /// crate needs no `rand` dependency — jitter needs to be *spread*, not
    /// unpredictable.
    fn backoff(&self, attempt: u32) -> Duration {
        let base = self.retry_base.as_millis() as u64;
        let exp = base.saturating_mul(1u64 << attempt.saturating_sub(1).min(16));
        let jitter = if base == 0 {
            0
        } else {
            (nanos_now() % base as u128) as u64
        };
        Duration::from_millis(exp.saturating_add(jitter))
    }

    /// Move a batch into `failed/`, encoding its retry state in the filename.
    ///
    /// Never deletes and never overwrites: a collision gets a numeric suffix,
    /// because the file being moved is the only copy of data the server does
    /// not have.
    async fn park(&self, path: &Path, client_status: Option<u16>, _attempt: u32) {
        if let Err(err) = self.park_inner(path, client_status).await {
            tracing::error!(
                file = %path.display(),
                %err,
                "could not park a failed batch; it stays in the spool and will be retried"
            );
        }
    }

    async fn park_inner(
        &self,
        path: &Path,
        client_status: Option<u16>,
    ) -> Result<(), std::io::Error> {
        tokio::fs::create_dir_all(&self.failed_dir).await?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("batch.jsonl");

        let mut parked = ParkedName::parse(name);
        parked.attempt += 1;
        if client_status.is_some() {
            parked.client_status = client_status;
        }
        parked.poison = parked.attempt >= self.failed_retries_max.max(1);

        let dest = unique_destination(&self.failed_dir, &parked.render()).await;
        tracing::warn!(
            file = %path.display(),
            dest = %dest.display(),
            attempt = parked.attempt,
            poison = parked.poison,
            "parking an undelivered batch"
        );
        tokio::fs::rename(path, &dest).await
    }
}

/// Retry state carried in a parked batch's filename:
/// `<base>.a<N>[.c<STATUS>].jsonl[.poison]`.
///
/// The filename IS the database. A sidecar would need its own atomicity story
/// and could desynchronise from the batch it describes; a rename cannot.
#[derive(Debug, PartialEq, Eq)]
pub struct ParkedName {
    pub base: String,
    pub attempt: u32,
    pub client_status: Option<u16>,
    pub poison: bool,
}

impl ParkedName {
    pub fn parse(name: &str) -> Self {
        let (name, poison) = match name.strip_suffix(POISON_SUFFIX) {
            Some(rest) => (rest, true),
            None => (name, false),
        };
        let stem = name.strip_suffix(".jsonl").unwrap_or(name);

        let mut base = stem.to_string();
        let mut attempt = 0;
        let mut client_status = None;

        // Suffixes are stripped right to left: `.cNNN` then `.aN`. Parsing
        // rather than merely matching the prefix is what keeps a real spool
        // name safe — `claude-...-0` has no `.c`/`.a` to find, and anything
        // that does but is not numeric is left as part of the base.
        if let Some(idx) = base.rfind(".c")
            && let Ok(code) = base[idx + 2..].parse::<u16>()
        {
            client_status = Some(code);
            base.truncate(idx);
        }
        if let Some(idx) = base.rfind(".a")
            && let Ok(n) = base[idx + 2..].parse::<u32>()
        {
            attempt = n;
            base.truncate(idx);
        }

        ParkedName {
            base,
            attempt,
            client_status,
            poison,
        }
    }

    pub fn render(&self) -> String {
        let mut s = format!("{}.a{}", self.base, self.attempt);
        if let Some(code) = self.client_status {
            s.push_str(&format!(".c{code}"));
        }
        s.push_str(".jsonl");
        if self.poison {
            s.push_str(POISON_SUFFIX);
        }
        s
    }

    /// Whether an automatic retry pass should pick this up. A batch the server
    /// definitively rejected will fail identically until the cause is fixed,
    /// so retrying it just burns the budget of batches that could succeed.
    pub fn is_auto_retryable(&self) -> bool {
        !self.poison && self.client_status.is_none()
    }
}

/// Split a body on line boundaries so no chunk exceeds `max`.
///
/// A single line longer than `max` is emitted alone rather than dropped: the
/// spool writer already guarantees no such line exists, so reaching this means
/// the cap was lowered after the batch was written, and the server refusing it
/// is more useful than this function silently discarding it.
fn split_lines(bytes: &[u8], max: u64) -> Vec<Vec<u8>> {
    if bytes.len() as u64 <= max {
        return vec![bytes.to_vec()];
    }
    let mut out = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    for line in bytes.split_inclusive(|b| *b == b'\n') {
        if !cur.is_empty() && (cur.len() + line.len()) as u64 > max {
            out.push(std::mem::take(&mut cur));
        }
        cur.extend_from_slice(line);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// A `Retry-After` in seconds, capped so a bad header cannot stall delivery.
fn retry_after(resp: &reqwest::Response) -> Option<Duration> {
    let raw = resp.headers().get(reqwest::header::RETRY_AFTER)?;
    let secs: u64 = raw.to_str().ok()?.trim().parse().ok()?;
    Some(Duration::from_secs(secs).min(MAX_RETRY_AFTER))
}

/// `<dir>/<name>`, or `<name>.1`, `.2`, … if taken. A collision must never
/// destroy an undelivered batch.
async fn unique_destination(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if tokio::fs::metadata(&first).await.is_err() {
        return first;
    }
    for n in 1..1000 {
        let candidate = dir.join(format!("{name}.{n}"));
        if tokio::fs::metadata(&candidate).await.is_err() {
            return candidate;
        }
    }
    dir.join(format!("{name}.{}", nanos_now()))
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn nanos_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parked_names_round_trip() {
        let p = ParkedName {
            base: "hooks-s1-123-0".into(),
            attempt: 2,
            client_status: Some(404),
            poison: false,
        };
        assert_eq!(p.render(), "hooks-s1-123-0.a2.c404.jsonl");
        assert_eq!(ParkedName::parse(&p.render()), p);
    }

    #[test]
    fn a_poison_name_round_trips_and_is_not_jsonl() {
        let p = ParkedName {
            base: "claude-s-1-0".into(),
            attempt: 3,
            client_status: None,
            poison: true,
        };
        let rendered = p.render();
        assert_eq!(rendered, "claude-s-1-0.a3.jsonl.poison");
        // The whole point of the suffix ordering: a poison file is not a
        // `.jsonl`, so every scan skips it without a dedicated filter.
        assert!(!crate::spool::is_batch_file(Path::new(&rendered)));
        assert_eq!(ParkedName::parse(&rendered), p);
    }

    #[test]
    fn a_fresh_batch_carries_no_retry_state() {
        // Spool filenames are `<prefix>-<tag>-<run>-<seq>.jsonl` and the tag is
        // sanitised to alphanumerics and `-`, so a real name can never parse as
        // one that has already been retried.
        let p = ParkedName::parse("claude-3ee9c788-1785741108180149712-0.jsonl");
        assert_eq!(p.attempt, 0);
        assert_eq!(p.client_status, None);
        assert!(!p.poison);
        assert_eq!(p.base, "claude-3ee9c788-1785741108180149712-0");
    }

    #[test]
    fn only_batches_with_no_definitive_rejection_are_auto_retried() {
        let park = |n: &str| ParkedName::parse(n);
        assert!(park("a.a1.jsonl").is_auto_retryable());
        // A 4xx will fail identically until the key or URL is fixed.
        assert!(!park("a.a1.c401.jsonl").is_auto_retryable());
        assert!(!park("a.a3.jsonl.poison").is_auto_retryable());
    }

    #[test]
    fn splitting_respects_line_boundaries_and_the_cap() {
        let body = b"aaaa\nbbbb\ncccc\ndddd\n";
        let chunks = split_lines(body, 10);
        assert!(chunks.len() > 1);
        for c in &chunks {
            assert!(c.len() <= 10, "chunk of {} bytes exceeds cap", c.len());
            assert!(c.ends_with(b"\n"), "a chunk must not split a line");
        }
        let rejoined: Vec<u8> = chunks.concat();
        assert_eq!(rejoined, body, "splitting must lose nothing");
    }

    #[test]
    fn a_body_under_the_cap_is_one_chunk() {
        let body = b"one\ntwo\n";
        assert_eq!(split_lines(body, 1024).len(), 1);
    }

    #[test]
    fn an_oversized_single_line_is_emitted_rather_than_dropped() {
        let body = b"aaaaaaaaaaaaaaaaaaaaaaaa\n";
        let chunks = split_lines(body, 4);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], body);
    }
}
