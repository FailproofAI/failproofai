//! Uploader behaviour against a real HTTP server.
//!
//! The unit tests in the module cover the pure parts (filename retry state,
//! line splitting). These cover the parts that only show up over the wire, and
//! each one guards a way of losing data silently rather than loudly.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::{UploadError, Uploader};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-up-{}-{}-{}",
        name,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&d).unwrap();
    d
}

fn write_batch(dir: &Path, name: &str, lines: usize) -> PathBuf {
    let p = dir.join(name);
    let body: String = (0..lines)
        .map(|i| format!("{{\"type\":\"tool_use\",\"n\":{i}}}\n"))
        .collect();
    fs::write(&p, body).unwrap();
    p
}

/// Fast retries so a test does not wait out a real backoff.
fn uploader(server: &MockServer, failed: &Path) -> Uploader {
    Uploader::new(
        format!("{}/events", server.uri()),
        "test-key".into(),
        failed.to_path_buf(),
    )
    .unwrap()
    .with_retry_base(Duration::from_millis(1))
}

fn parked(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

#[tokio::test]
async fn a_2xx_with_an_accepting_ack_deletes_the_batch() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/events"))
        .and(header("content-type", "application/x-ndjson"))
        .and(header("authorization", "Bearer test-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "accepted": 3, "skipped": 0
        })))
        .mount(&server)
        .await;

    let spool = tmpdir("ok-spool");
    let failed = tmpdir("ok-failed");
    let batch = write_batch(&spool, "hooks-s-1-0.jsonl", 3);

    let up = uploader(&server, &failed);
    up.upload_file(&batch).await.unwrap();

    assert!(!batch.exists(), "a delivered batch must be deleted");
    assert!(parked(&failed).is_empty());
    assert_eq!(up.metrics().accepted_total.load(Ordering::Relaxed), 3);
    assert!(up.metrics().last_ok_ts.load(Ordering::Relaxed) > 0);

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test]
async fn a_200_that_stored_nothing_is_counted_as_fully_skipped() {
    // The failure this exists for: a systematically malformed transform gets
    // HTTP 200 for every batch while the server stores none of it. Without
    // reading the ack body that is indistinguishable from working perfectly.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "accepted": 0, "skipped": 5
        })))
        .mount(&server)
        .await;

    let spool = tmpdir("skip-spool");
    let failed = tmpdir("skip-failed");
    let batch = write_batch(&spool, "claude-s-1-0.jsonl", 5);

    let up = uploader(&server, &failed);
    // It used to return Ok here, so `upload_file` deleted the batch: the events
    // were not on the server, this file was their last copy, and it went in the
    // bin behind one ERROR line in the daemon's own log. That contradicted this
    // module's stated invariant — `failed/` is a retry queue and such a batch is
    // "never deleted" — and it is the whole reason the ack body is read at all.
    let err = up.upload_file(&batch).await.unwrap_err();
    assert!(
        matches!(err, UploadError::StoredNothing { skipped: 5 }),
        "expected StoredNothing, got {err:?}"
    );

    let m = up.metrics();
    assert_eq!(m.batches_fully_skipped.load(Ordering::Relaxed), 1);
    assert_eq!(m.skipped_total.load(Ordering::Relaxed), 5);
    assert_eq!(m.accepted_total.load(Ordering::Relaxed), 0);

    // The data survives, in failed/, rather than being deleted.
    assert!(
        !batch.exists(),
        "the batch should have moved out of the spool"
    );
    let parked: Vec<_> = fs::read_dir(&failed).unwrap().flatten().collect();
    assert_eq!(parked.len(), 1, "the batch should be parked, not deleted");

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test]
async fn a_4xx_parks_immediately_with_its_status_and_is_not_retried() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1) // exactly one attempt: retrying a rotated key is pointless
        .mount(&server)
        .await;

    let spool = tmpdir("4xx-spool");
    let failed = tmpdir("4xx-failed");
    let batch = write_batch(&spool, "claude-s-1-0.jsonl", 2);

    let up = uploader(&server, &failed);
    let err = up.upload_file(&batch).await.unwrap_err();
    assert!(format!("{err}").contains("401"));

    let files = parked(&failed);
    assert_eq!(files.len(), 1, "got {files:?}");
    assert!(
        files[0].contains(".c401"),
        "the status must be recorded so an automatic retry pass skips it: {files:?}"
    );
    assert!(!batch.exists(), "the batch moved rather than being copied");

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test]
async fn a_429_is_retried_rather_than_treated_as_definitive() {
    // 408 and 429 are the two 4xx that mean "try again". Parking them would
    // strand a batch the server explicitly asked us to resend.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "0"))
        .expect(5) // max_retries, not 1
        .mount(&server)
        .await;

    let spool = tmpdir("429-spool");
    let failed = tmpdir("429-failed");
    let batch = write_batch(&spool, "claude-s-1-0.jsonl", 1);

    let up = uploader(&server, &failed);
    let err = up.upload_file(&batch).await.unwrap_err();
    assert!(format!("{err}").contains("429"));

    // Parked WITHOUT a client status, so it stays auto-retryable.
    let files = parked(&failed);
    assert_eq!(files.len(), 1, "got {files:?}");
    assert!(
        !files[0].contains(".c429"),
        "a retryable status must not be recorded as definitive: {files:?}"
    );

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test]
async fn a_5xx_retries_then_parks_without_a_client_status() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .expect(5)
        .mount(&server)
        .await;

    let spool = tmpdir("5xx-spool");
    let failed = tmpdir("5xx-failed");
    let batch = write_batch(&spool, "claude-s-1-0.jsonl", 1);

    let up = uploader(&server, &failed);
    let err = up.upload_file(&batch).await.unwrap_err();
    assert!(format!("{err}").contains("503"));

    let files = parked(&failed);
    assert_eq!(files.len(), 1);
    assert!(files[0].contains(".a1"), "attempt count encoded: {files:?}");
    assert!(
        !files[0].ends_with(".poison"),
        "one failure is not poison yet"
    );

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test]
async fn a_transient_failure_that_recovers_still_delivers() {
    let server = MockServer::start().await;
    // Fail twice, then succeed. Mounted newest-first by wiremock, so the
    // limited mock is consulted before the fallback.
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .up_to_n_times(2)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "accepted": 1, "skipped": 0
        })))
        .mount(&server)
        .await;

    let spool = tmpdir("flap-spool");
    let failed = tmpdir("flap-failed");
    let batch = write_batch(&spool, "claude-s-1-0.jsonl", 1);

    let up = uploader(&server, &failed);
    up.upload_file(&batch).await.unwrap();

    assert!(!batch.exists());
    assert!(
        parked(&failed).is_empty(),
        "a recovered batch must not be parked"
    );
    assert_eq!(up.metrics().accepted_total.load(Ordering::Relaxed), 1);

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test]
async fn an_oversized_batch_is_split_and_every_chunk_delivered() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "accepted": 1, "skipped": 0
        })))
        .mount(&server)
        .await;

    let spool = tmpdir("split-spool");
    let failed = tmpdir("split-failed");
    let batch = write_batch(&spool, "claude-s-1-0.jsonl", 50);

    // Cap well under the file size, forcing several requests.
    let up = uploader(&server, &failed).with_max_upload_bytes(64);
    up.upload_file(&batch).await.unwrap();

    let requests = server.received_requests().await.unwrap();
    assert!(
        requests.len() > 1,
        "expected a split, got {} request(s)",
        requests.len()
    );

    // Splitting happens IN MEMORY. Chunks written to disk beside the original
    // would be files the watcher had never seen, so it would post them
    // concurrently — the same payload delivered twice.
    let leftovers: Vec<String> = fs::read_dir(&spool)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert!(
        leftovers.is_empty(),
        "split chunks must never hit the spool: {leftovers:?}"
    );

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test]
async fn a_vanished_batch_is_not_an_error() {
    // Two tasks can race for the same file; whoever loses must not report a
    // failure for work the other already did.
    let server = MockServer::start().await;
    let spool = tmpdir("gone-spool");
    let failed = tmpdir("gone-failed");
    let up = uploader(&server, &failed);

    up.upload_file(&spool.join("never-existed.jsonl"))
        .await
        .unwrap();

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test]
async fn parking_never_overwrites_an_existing_parked_batch() {
    // A parked batch is the last copy of data the server does not have, so a
    // name collision must not destroy one.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;

    let spool = tmpdir("collide-spool");
    let failed = tmpdir("collide-failed");
    let up = uploader(&server, &failed);

    for i in 0..2 {
        let batch = write_batch(&spool, "claude-s-1-0.jsonl", i + 1);
        let _ = up.upload_file(&batch).await;
    }

    let files = parked(&failed);
    assert_eq!(
        files.len(),
        2,
        "both parked batches must survive: {files:?}"
    );

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test]
async fn a_batch_written_by_the_spool_writer_is_delivered_end_to_end() {
    // The two halves have to agree on the filename shape and the NDJSON body.
    // Testing them separately would let a change to either drift silently.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "accepted": 2, "skipped": 0
        })))
        .mount(&server)
        .await;

    let spool = tmpdir("e2e-spool");
    let failed = tmpdir("e2e-failed");

    let mut w = fpai_collect::SpoolWriter::new(
        spool.clone(),
        fpai_collect::spool::DEFAULT_MAX_BATCH_BYTES,
        "hooks",
        "18efefd6",
    );
    w.push(serde_json::json!({
        "timestamp": "2026-08-03T10:00:00.000000Z", "session_id": "s1",
        "agent_id": "claude", "type": "hook_triggered", "hook_name": "PreToolUse"
    }))
    .await
    .unwrap();
    w.push(serde_json::json!({
        "timestamp": "2026-08-03T10:00:00.000100Z", "session_id": "s1",
        "agent_id": "claude", "type": "hook_completed", "hook_name": "PreToolUse"
    }))
    .await
    .unwrap();
    w.flush().await.unwrap();

    let batch = fs::read_dir(&spool)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| fpai_collect::spool::is_batch_file(p))
        .expect("the spool writer should have produced a batch");

    let up = uploader(&server, &failed);
    up.upload_file(&batch).await.unwrap();

    assert!(!batch.exists());
    assert!(parked(&failed).is_empty());
    assert_eq!(up.metrics().accepted_total.load(Ordering::Relaxed), 2);

    // The body the server received is exactly the NDJSON the spool wrote.
    let reqs = server.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 1);
    let body = String::from_utf8(reqs[0].body.clone()).unwrap();
    assert_eq!(body.lines().count(), 2);
    assert!(body.contains("hook_triggered") && body.contains("hook_completed"));

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

// ---------------------------------------------------------------------------
// Redirect / non-ack hardening
//
// An adversarial red-team pointed a live daemon at a dashboard-lookalike
// (POST /events -> 307 -> /login -> 200 text/html). reqwest followed the
// redirect, re-POSTed the batch to the login page, parsed the HTML as a
// default ack, and DELETED the spool file. Cross-host, the same follow shipped
// full event payloads to an attacker. These pin the fix.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_redirect_is_parked_not_followed() {
    // The exfiltration vector: a 3xx must never be followed, or the batch (and
    // its prompts/command text) is re-POSTed to wherever Location points.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/events"))
        .respond_with(ResponseTemplate::new(307).insert_header("location", "/login?next=%2Fevents"))
        .expect(1) // exactly one POST — the redirect is NOT followed to /login
        .mount(&server)
        .await;
    // If the client followed the redirect it would hit this; it must not.
    Mock::given(method("POST"))
        .and(path("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>login</html>"))
        .expect(0)
        .mount(&server)
        .await;

    let spool = tmpdir("redir-spool");
    let failed = tmpdir("redir-failed");
    let batch = write_batch(&spool, "hooks-s-1-0.jsonl", 3);

    let up = uploader(&server, &failed);
    let err = up.upload_file(&batch).await.unwrap_err();
    assert!(format!("{err}").contains("307"), "got {err}");

    let files = parked(&failed);
    assert_eq!(
        files.len(),
        1,
        "the batch must be parked, not lost: {files:?}"
    );
    assert!(
        files[0].contains(".c307"),
        "the redirect status must be recorded: {files:?}"
    );
    assert!(
        !batch.exists(),
        "the batch moved to failed/, it was not deleted as delivered"
    );

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test]
async fn a_200_that_is_not_an_ingest_ack_is_parked_not_deleted() {
    // A login page, a proxy or a static host can answer 200. Without a numeric
    // `accepted` it is not delivery, and treating it as such deletes the only
    // copy of the data.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>hello</html>"))
        .expect(1)
        .mount(&server)
        .await;

    let spool = tmpdir("noack-spool");
    let failed = tmpdir("noack-failed");
    let batch = write_batch(&spool, "hooks-s-1-0.jsonl", 3);

    let up = uploader(&server, &failed);
    let err = up.upload_file(&batch).await.unwrap_err();
    assert!(format!("{err}").contains("200"), "got {err}");

    let files = parked(&failed);
    assert_eq!(files.len(), 1, "a non-ack 200 must be parked: {files:?}");
    assert!(
        !batch.exists(),
        "the batch moved to failed/ rather than vanishing"
    );

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test]
async fn a_200_whose_json_lacks_accepted_is_parked() {
    // `{"status":"ok"}` parses as JSON but is not an ingest ack. The required
    // `accepted` field is what rejects it.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_string(r#"{"status":"ok"}"#),
        )
        .expect(1)
        .mount(&server)
        .await;

    let spool = tmpdir("badack-spool");
    let failed = tmpdir("badack-failed");
    let batch = write_batch(&spool, "hooks-s-1-0.jsonl", 2);

    let up = uploader(&server, &failed);
    assert!(up.upload_file(&batch).await.is_err());
    assert_eq!(parked(&failed).len(), 1, "must be parked");
    assert!(!batch.exists());

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}
