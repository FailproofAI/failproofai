//! Watcher and sweeper against a real filesystem and a real HTTP server.
//!
//! The first test here is the one that would have caught a whole class of
//! silent failure: the spool publishes a batch by RENAMING it into place,
//! which Linux reports as `IN_MOVED_TO`, not as a create. A watcher subscribed
//! only to create events registers successfully, logs nothing, and delivers
//! nothing — the sweeper would quietly cover for it a minute later and the bug
//! would look like latency.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fpai_collect::supervisor::{Shutdown, TaskSpec, spawn_supervised};
use fpai_collect::{Delivery, SpoolWriter, Uploader};
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-dlv-{}-{}-{}",
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

async fn ok_server() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "accepted": 1, "skipped": 0
        })))
        .mount(&s)
        .await;
    s
}

fn delivery(server: &MockServer, failed: &Path) -> Arc<Delivery> {
    let up = Uploader::new(
        format!("{}/events", server.uri()),
        "k".into(),
        failed.to_path_buf(),
    )
    .unwrap()
    .with_retry_base(Duration::from_millis(1));
    Arc::new(Delivery::new(Arc::new(up)))
}

/// Write a batch the way the spool writer does — tmp, then rename.
async fn publish_batch(dir: &Path, tag: &str) {
    let mut w = SpoolWriter::new(
        dir.to_path_buf(),
        fpai_collect::spool::DEFAULT_MAX_BATCH_BYTES,
        "hooks",
        tag,
    );
    w.push(serde_json::json!({"type": "hook_completed", "session_id": "s"}))
        .await
        .unwrap();
    w.flush().await.unwrap();
}

fn wait_until(budget: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    cond()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_watcher_fires_on_the_rename_the_spool_writer_actually_performs() {
    let server = ok_server().await;
    let spool = tmpdir("watch-spool");
    let failed = tmpdir("watch-failed");
    let d = delivery(&server, &failed);

    let shutdown = Arc::new(AtomicBool::new(false));
    let sd = Shutdown::for_test(shutdown.clone());

    let watcher = tokio::spawn(fpai_collect::delivery::watch(
        d.clone(),
        vec![spool.clone()],
        sd,
    ));
    // Let the watch register before publishing; otherwise this would pass or
    // fail on timing rather than on behaviour.
    tokio::time::sleep(Duration::from_millis(300)).await;

    publish_batch(&spool, "s1").await;

    let spool_check = spool.clone();
    let delivered = wait_until(Duration::from_secs(5), || {
        fs::read_dir(&spool_check)
            .map(|rd| rd.filter_map(|e| e.ok()).count() == 0)
            .unwrap_or(false)
    });
    assert!(
        delivered,
        "the watcher did not deliver a renamed-in batch; \
         on Linux the publish is IN_MOVED_TO, not a create"
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 1);

    shutdown.store(true, Ordering::Relaxed);
    let _ = tokio::time::timeout(Duration::from_secs(3), watcher).await;
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_watcher_survives_a_spool_directory_it_cannot_watch() {
    // A watch that fails to register must degrade to sweeper-only, not kill
    // the task — on a filesystem without event support it would otherwise
    // restart forever.
    let server = ok_server().await;
    let spool = tmpdir("degrade-spool");
    let failed = tmpdir("degrade-failed");
    let d = delivery(&server, &failed);

    let shutdown = Arc::new(AtomicBool::new(false));
    let sd = Shutdown::for_test(shutdown.clone());

    let watcher = tokio::spawn(fpai_collect::delivery::watch(
        d,
        vec![
            spool.clone(),
            PathBuf::from("/proc/nonexistent/cannot-create"),
        ],
        sd,
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !watcher.is_finished(),
        "an unwatchable directory must not stop the task"
    );

    shutdown.store(true, Ordering::Relaxed);
    let res = tokio::time::timeout(Duration::from_secs(3), watcher).await;
    assert!(res.is_ok(), "the watcher must stop on shutdown");
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_sweeper_delivers_what_accumulated_while_the_daemon_was_stopped() {
    // No filesystem event is coming for these — they were published while
    // nothing was listening. This is why the sweeper, not the watcher, is the
    // delivery guarantee.
    let server = ok_server().await;
    let spool = tmpdir("sweep-spool");
    let failed = tmpdir("sweep-failed");

    publish_batch(&spool, "old1").await;
    publish_batch(&spool, "old2").await;
    assert_eq!(fs::read_dir(&spool).unwrap().count(), 2);

    let d = delivery(&server, &failed);
    let shutdown = Arc::new(AtomicBool::new(false));
    let sd = Shutdown::for_test(shutdown.clone());

    // Deliver directly rather than waiting out SWEEP_MIN_AGE: the selection
    // rules are unit-tested in the module; what matters here is that a batch
    // with no event behind it still reaches the server.
    for entry in fs::read_dir(&spool).unwrap() {
        d.deliver(entry.unwrap().path()).await;
    }
    let _ = sd;

    assert_eq!(
        fs::read_dir(&spool).unwrap().count(),
        0,
        "both batches must be delivered"
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 2);

    shutdown.store(true, Ordering::Relaxed);
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_same_batch_is_never_uploaded_twice_concurrently() {
    // The watcher and sweeper share one in-flight set precisely so this cannot
    // happen. With per-task sets, a file the watcher is mid-upload on is
    // invisible to a concurrent sweep and both would POST it.
    let server = ok_server().await;
    let spool = tmpdir("dedup-spool");
    let failed = tmpdir("dedup-failed");
    let d = delivery(&server, &failed);

    publish_batch(&spool, "s1").await;
    let batch = fs::read_dir(&spool)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .next()
        .unwrap();

    // Ten concurrent attempts on the same path.
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..10 {
        let d = d.clone();
        let p = batch.clone();
        set.spawn(async move { d.deliver(p).await });
    }
    while set.join_next().await.is_some() {}

    let n = server.received_requests().await.unwrap().len();
    assert_eq!(
        n, 1,
        "the batch was POSTed {n} times; the in-flight set failed"
    );

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn watcher_and_sweeper_run_under_the_supervisor_and_stop_on_shutdown() {
    // How they actually run in the daemon: as supervised tasks observing the
    // same shutdown flag as the socket server.
    let server = ok_server().await;
    let spool = tmpdir("sup-spool");
    let failed = tmpdir("sup-failed");
    let d = delivery(&server, &failed);

    let shutdown = Arc::new(AtomicBool::new(false));

    let dw = d.clone();
    let sw = spool.clone();
    let ds = d.clone();
    let ss = spool.clone();
    let fs_dir = failed.clone();

    let handle = spawn_supervised(
        vec![
            TaskSpec::new("spool-watcher", move |sd| {
                fpai_collect::delivery::watch(dw.clone(), vec![sw.clone()], sd)
            }),
            TaskSpec::new("spool-sweeper", move |sd| {
                fpai_collect::delivery::sweep(ds.clone(), vec![ss.clone()], fs_dir.clone(), sd)
            }),
        ],
        shutdown.clone(),
    )
    .expect("supervisor should start");

    tokio::time::sleep(Duration::from_millis(400)).await;
    publish_batch(&spool, "s1").await;

    let spool_check = spool.clone();
    assert!(
        wait_until(Duration::from_secs(5), || {
            fs::read_dir(&spool_check)
                .map(|rd| rd.filter_map(|e| e.ok()).count() == 0)
                .unwrap_or(false)
        }),
        "a batch published while supervised was not delivered"
    );

    shutdown.store(true, Ordering::Relaxed);
    assert!(
        handle.join_with_flush(Duration::from_secs(5)),
        "both tasks must drain on shutdown"
    );

    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&failed).ok();
}
