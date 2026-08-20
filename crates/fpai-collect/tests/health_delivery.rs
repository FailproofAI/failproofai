//! The health file must be able to say whether anything is ARRIVING.
//!
//! Its source map cannot. A source's job ends when it writes a batch into the
//! spool — the POST, the server's verdict and the parking of what would not go
//! are all after that — and the SDK's batches have no source entry at all,
//! because `failproofai-sdk` writes them into the spool from the user's own
//! process. So a machine shipping nothing but SDK events produced a file with
//! an empty, perfectly healthy `sources` map whether ingest was storing every
//! event or discarding all of them.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use fpai_collect::{Health, HealthFile, UploadMetrics};

#[test]
fn delivery_is_absent_until_an_uploader_attaches() {
    // All-zero counters and "this daemon has no credential, so nothing is being
    // delivered at all" are different facts. Rendering them the same would make
    // an unconfigured machine look like a broken one, and vice versa.
    let health = Health::new();
    let json = serde_json::to_string(&health.snapshot()).unwrap();
    assert!(
        !json.contains("delivery"),
        "an unconfigured daemon must omit the section, not zero it: {json}"
    );
}

#[test]
fn attached_delivery_counters_reach_the_snapshot() {
    let health = Health::new();
    let metrics = Arc::new(UploadMetrics::default());
    health.attach_delivery(metrics.clone());

    metrics.accepted_total.fetch_add(120, Ordering::Relaxed);
    metrics.skipped_total.fetch_add(7, Ordering::Relaxed);
    metrics
        .batches_fully_skipped
        .fetch_add(1, Ordering::Relaxed);
    metrics.last_ok_ts.store(1_787_216_518, Ordering::Relaxed);

    let snap = health.snapshot();
    let delivery = snap
        .delivery
        .expect("delivery must be reported once attached");
    assert_eq!(delivery.accepted, 120);
    assert_eq!(
        delivery.skipped, 7,
        "skipped is the counter that means data loss"
    );
    assert_eq!(delivery.batches_fully_skipped, 1);
    assert_eq!(delivery.last_ok_ts, 1_787_216_518);
}

#[test]
fn the_counters_are_read_live_rather_than_copied_at_attach() {
    // The `Uploader` owns them and outlives any supervised task restart, so the
    // health writer must read through to it. Snapshotting the values at attach
    // time would freeze the file at "nothing has happened yet" forever — which
    // reads exactly like a healthy idle machine.
    let health = Health::new();
    let metrics = Arc::new(UploadMetrics::default());
    health.attach_delivery(metrics.clone());
    assert_eq!(health.snapshot().delivery.unwrap().accepted, 0);

    metrics.accepted_total.fetch_add(5, Ordering::Relaxed);
    assert_eq!(health.snapshot().delivery.unwrap().accepted, 5);
}

#[test]
fn a_written_file_round_trips_through_the_published_type() {
    // `HealthFile` is what a reader outside this crate deserializes; an added
    // field that only serializes one way would be invisible to them.
    let dir = std::env::temp_dir().join(format!("fpai-health-{}", std::process::id()));
    let path = dir.join("collector-health.json");
    let health = Health::new();
    let metrics = Arc::new(UploadMetrics::default());
    metrics.skipped_total.fetch_add(3, Ordering::Relaxed);
    health.attach_delivery(metrics);
    health.write(&path).unwrap();

    let parsed: HealthFile =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(parsed.delivery.expect("round trip").skipped, 3);

    // An older file, written before this section existed, must still parse.
    let legacy: HealthFile = serde_json::from_str(r#"{"ts":1,"sources":{}}"#).unwrap();
    assert!(legacy.delivery.is_none());

    std::fs::remove_dir_all(&dir).ok();
}
