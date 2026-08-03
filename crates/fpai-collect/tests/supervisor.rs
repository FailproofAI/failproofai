//! Contract tests for the collector supervisor.
//!
//! These are the tests that justify running collection inside the daemon at
//! all. `failproofai` fails closed — an unreachable daemon denies every tool
//! call on the machine — so "a collector bug cannot take the daemon down" is
//! not a nice property, it is the precondition for the whole design. Each test
//! below pins one half of that claim.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use fpai_collect::{TaskError, TaskSpec, spawn_supervised};

/// Poll `cond` until true or `budget` elapses. Returns whether it became true.
/// Used instead of a fixed sleep so the tests are neither flaky nor slower
/// than they need to be.
fn wait_until(budget: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    cond()
}

#[test]
fn no_tasks_means_no_thread_and_no_runtime() {
    // The normal state on a machine that has not opted in to collection. It
    // must cost nothing at all — not an idle thread, not a Tokio runtime.
    let shutdown = Arc::new(AtomicBool::new(false));
    let handle = spawn_supervised(vec![], shutdown);
    assert!(
        handle.is_none(),
        "an empty task list must not start a runtime"
    );
}

#[test]
fn a_panicking_task_is_contained_and_restarted() {
    // The core claim. A transform that panics on some agent's malformed log
    // line must not unwind into the runtime, must not abort the process, and
    // must be tried again rather than silently dropped.
    let shutdown = Arc::new(AtomicBool::new(false));
    let starts = Arc::new(AtomicUsize::new(0));

    let s = starts.clone();
    let handle = spawn_supervised(
        vec![TaskSpec::new("panicky", move |_sd| {
            let s = s.clone();
            async move {
                s.fetch_add(1, Ordering::SeqCst);
                panic!("simulated transform bug");
            }
        })],
        shutdown.clone(),
    )
    .expect("supervisor should start");

    // Backoff starts at 1s, so a second start proves a real restart happened
    // rather than the first attempt being counted twice.
    assert!(
        wait_until(Duration::from_secs(5), || starts.load(Ordering::SeqCst)
            >= 2),
        "a panicking task must be restarted, got {} start(s)",
        starts.load(Ordering::SeqCst)
    );

    let m = handle.metrics();
    assert!(
        m.panics.load(Ordering::Relaxed) >= 1,
        "the panic must be counted"
    );
    assert_eq!(
        m.failures.load(Ordering::Relaxed),
        0,
        "a panic is not an Err — they are counted separately so a bug is distinguishable from a flaky environment"
    );

    assert!(handle.join_with_flush(Duration::from_secs(5)));
}

#[test]
fn a_panic_in_one_task_does_not_disturb_another() {
    // Isolation between tasks, not just between the collector and the daemon.
    // One badly-behaved source must not stop the others from shipping.
    let shutdown = Arc::new(AtomicBool::new(false));
    let healthy_ticks = Arc::new(AtomicUsize::new(0));

    let ticks = healthy_ticks.clone();
    let handle = spawn_supervised(
        vec![
            TaskSpec::new("panicky", |_sd| async {
                panic!("bad source");
            }),
            TaskSpec::new("healthy", move |sd| {
                let ticks = ticks.clone();
                // Shaped like a real source: loop until asked to stop, and
                // use the interruptible sleep so shutdown is prompt.
                async move {
                    while !sd.is_set() {
                        ticks.fetch_add(1, Ordering::SeqCst);
                        sd.sleep(Duration::from_millis(10)).await;
                    }
                    Ok(())
                }
            }),
        ],
        shutdown.clone(),
    )
    .expect("supervisor should start");

    assert!(
        wait_until(Duration::from_secs(5), || healthy_ticks
            .load(Ordering::SeqCst)
            >= 5),
        "the healthy task must keep running while its sibling panics"
    );

    assert!(handle.join_with_flush(Duration::from_secs(5)));
}

#[test]
fn a_failing_task_is_restarted_and_counted_as_a_failure_not_a_panic() {
    let shutdown = Arc::new(AtomicBool::new(false));
    let starts = Arc::new(AtomicUsize::new(0));

    let s = starts.clone();
    let handle = spawn_supervised(
        vec![TaskSpec::new("flaky", move |_sd| {
            let s = s.clone();
            async move {
                s.fetch_add(1, Ordering::SeqCst);
                Err(TaskError::from("upstream refused the connection"))
            }
        })],
        shutdown.clone(),
    )
    .expect("supervisor should start");

    assert!(
        wait_until(Duration::from_secs(5), || starts.load(Ordering::SeqCst)
            >= 2),
        "a failing task must be restarted"
    );

    let m = handle.metrics();
    assert!(m.failures.load(Ordering::Relaxed) >= 1);
    assert_eq!(
        m.panics.load(Ordering::Relaxed),
        0,
        "an Err is the environment, not a bug — it must not inflate the panic count"
    );

    assert!(handle.join_with_flush(Duration::from_secs(5)));
}

#[test]
fn a_task_that_finishes_cleanly_is_not_restarted() {
    // A one-shot task (a backfill pass, say) returning Ok is done. Restarting
    // it would turn "finished" into an infinite loop.
    let shutdown = Arc::new(AtomicBool::new(false));
    let starts = Arc::new(AtomicUsize::new(0));

    let s = starts.clone();
    let handle = spawn_supervised(
        vec![TaskSpec::new("oneshot", move |_sd| {
            let s = s.clone();
            async move {
                s.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        })],
        shutdown.clone(),
    )
    .expect("supervisor should start");

    // Well past the 1s backoff a restart would have used.
    std::thread::sleep(Duration::from_millis(2500));
    assert_eq!(
        starts.load(Ordering::SeqCst),
        1,
        "a completed task must run exactly once"
    );

    assert!(handle.join_with_flush(Duration::from_secs(5)));
}

#[test]
fn the_daemons_shutdown_flag_stops_the_collector() {
    // The collector observes the same flag the socket server does, so one
    // SIGTERM stops both. If this regressed, `systemctl stop` would hang until
    // its own timeout and then SIGKILL, losing whatever was buffered.
    let shutdown = Arc::new(AtomicBool::new(false));

    let handle = spawn_supervised(
        vec![TaskSpec::new("long-runner", |sd| async move {
            sd.sleep(Duration::from_secs(3600)).await;
            Ok(())
        })],
        shutdown.clone(),
    )
    .expect("supervisor should start");

    shutdown.store(true, Ordering::Relaxed);

    let drained = handle.join_with_flush(Duration::from_secs(5));
    assert!(
        drained,
        "the collector must stop when the daemon's shutdown flag is set"
    );
}

#[test]
fn shutdown_interrupts_a_backoff_rather_than_serving_it_out() {
    // A task failing repeatedly climbs to a 60s backoff. Process exit must not
    // wait for that: without an interruptible sleep, stopping the daemon while
    // a source was backing off would block for up to a minute.
    let shutdown = Arc::new(AtomicBool::new(false));
    let starts = Arc::new(AtomicUsize::new(0));

    let s = starts.clone();
    let handle = spawn_supervised(
        vec![TaskSpec::new("always-fails", move |_sd| {
            let s = s.clone();
            async move {
                s.fetch_add(1, Ordering::SeqCst);
                Err(TaskError::from("nope"))
            }
        })],
        shutdown.clone(),
    )
    .expect("supervisor should start");

    // Let it fail once and enter its backoff.
    assert!(wait_until(Duration::from_secs(2), || starts
        .load(Ordering::SeqCst)
        >= 1));

    let t0 = Instant::now();
    shutdown.store(true, Ordering::Relaxed);
    let drained = handle.join_with_flush(Duration::from_secs(5));
    let elapsed = t0.elapsed();

    assert!(drained, "must drain");
    assert!(
        elapsed < Duration::from_millis(1500),
        "shutdown waited out the backoff instead of interrupting it: took {elapsed:?}"
    );
}

#[test]
fn join_with_flush_gives_up_on_a_wedged_task_instead_of_hanging() {
    // The bound we actually promise. A task that ignores shutdown — stuck in a
    // blocking syscall, say — delays process exit by the flush budget and no
    // more. Hanging here is precisely the failure this module exists to
    // prevent, because the daemon would never exit and the service manager
    // would SIGKILL it mid-write.
    let shutdown = Arc::new(AtomicBool::new(false));

    let handle = spawn_supervised(
        vec![TaskSpec::new("wedged", |_sd| async {
            // `spawn_blocking` is not cancellable, which is exactly the shape
            // of a real wedge (a synchronous read on a stalled filesystem).
            tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_secs(30)))
                .await
                .ok();
            Ok(())
        })],
        shutdown.clone(),
    )
    .expect("supervisor should start");

    std::thread::sleep(Duration::from_millis(200));

    let t0 = Instant::now();
    let drained = handle.join_with_flush(Duration::from_millis(600));
    let elapsed = t0.elapsed();

    assert!(
        !drained,
        "a wedged task should report that it did not drain"
    );
    assert!(
        elapsed < Duration::from_secs(3),
        "join must respect its budget rather than waiting for the wedged task: took {elapsed:?}"
    );
}
