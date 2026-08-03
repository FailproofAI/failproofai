mod cloud_client;
pub mod cloud_policies;
mod lock;
mod paths;
mod server;
mod worker;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-v") {
        println!("failproofaid {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    if let Err(err) = run() {
        eprintln!("[failproofaid] {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let lock_path = paths::lock_path()?;
    paths::ensure_run_dir()?;
    let _singleton = lock::acquire(&lock_path)?;

    let socket_path = paths::socket_path()?;
    let worker_socket_path = paths::worker_socket_path()?;
    let worker = Arc::new(worker::Worker::new(
        worker_socket_path,
        worker::WorkerCommand::from_env(),
    ));
    // Pre-warm off the startup path: the socket must be accepting
    // connections promptly (a service manager / health check shouldn't wait
    // on a Node cold start), but a request that arrives before warm-up
    // finishes still gets a correct, just slightly slower, answer — `call()`
    // -> `ensure_started()` shares the same lock and simply waits for
    // whichever spawn (this one or its own) is already in flight.
    {
        let warm_worker = worker.clone();
        std::thread::spawn(move || warm_worker.warm());
    }
    // The shutdown flag and its signal handler are installed BEFORE anything
    // long-running starts, so the collector below can observe the same flag
    // the socket server does. One SIGTERM then stops both; a second signal
    // path would be one more thing to get wrong during shutdown.
    let shutdown = Arc::new(AtomicBool::new(false));
    install_signal_handler(shutdown.clone());

    // Cloud policy integrity is a maintenance-lane responsibility, never a
    // hook-path operation. The monitor is useful before cloud transport lands:
    // it keeps the active generation and content-addressed artifact cache in
    // agreement and reports when both verified copies have been lost.
    let cloud_policy_store = cloud_policies::PolicyStore::new(paths::cloud_managed_policy_dir()?);
    let cloud_monitor = match cloud_client::CloudClient::from_env()? {
        Some(cloud) => {
            eprintln!("[failproofaid] cloud-managed policy polling enabled");
            cloud_client::spawn_cloud_manager(
                cloud_policy_store,
                cloud,
                shutdown.clone(),
                cloud_client::poll_interval_from_env(),
            )
        }
        None => cloud_policies::spawn_integrity_monitor(
            cloud_policy_store,
            shutdown.clone(),
            cloud_policy_reconcile_interval(),
        ),
    };

    // Log/hook collection. Runs on its own thread with its own Tokio runtime
    // so it can never share fate with the accept loop — this daemon fails
    // closed, so a collector fault would otherwise deny every tool call on the
    // machine (see fpai_collect::supervisor). It observes the same `shutdown`
    // flag the server and the cloud monitor do, so one SIGTERM stops all three.
    //
    // INERT until ingest is configured: `collector_tasks()` returns an empty
    // list, `spawn_supervised` then declines to start a thread or a runtime at
    // all, and the daemon behaves byte-for-byte as it did before this existed.
    let collector = fpai_collect::spawn_supervised(collector_tasks(), shutdown.clone());

    let srv = server::Server::bind(&socket_path, worker)?;
    eprintln!("[failproofaid] listening on {}", socket_path.display());

    let run_result = srv.run_until(shutdown);

    // Drain both background workers before returning. The collector gets a
    // bounded budget rather than an unbounded join: process exit must not wait
    // on a task that has wedged. Done before `?` so a server error still gets
    // the collector a chance to flush instead of dropping buffered events.
    if let Some(collector) = collector {
        collector.join_with_flush(fpai_collect::DEFAULT_FLUSH_BUDGET);
    }
    let _ = cloud_monitor.join();

    run_result?;
    Ok(())
}

/// The collector tasks to supervise for this process.
///
/// Empty until the ingest configuration lands, which is what keeps the
/// collector inert on every machine for now: an empty list means no thread and
/// no runtime, so an un-opted-in install pays nothing at all for this code
/// path existing.
fn collector_tasks() -> Vec<fpai_collect::TaskSpec> {
    Vec::new()
}

fn cloud_policy_reconcile_interval() -> Duration {
    const DEFAULT_MS: u64 = 30_000;
    const MINIMUM_MS: u64 = 100;
    let configured = std::env::var("FAILPROOFAI_CLOUD_POLICY_RECONCILE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_MS);
    Duration::from_millis(configured.max(MINIMUM_MS))
}

/// Requests a clean shutdown (socket file removal, lock release via Drop)
/// on SIGTERM/SIGINT instead of dying mid-accept-loop — this is how a
/// systemd `stop`/launchd unload is expected to end the process.
fn install_signal_handler(shutdown: Arc<AtomicBool>) {
    static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

    extern "C" fn handle_signal(_sig: libc::c_int) {
        SHUTDOWN_REQUESTED.store(true, Ordering::Relaxed);
    }

    unsafe {
        libc::signal(
            libc::SIGTERM,
            handle_signal as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGINT,
            handle_signal as *const () as libc::sighandler_t,
        );
    }

    std::thread::spawn(move || {
        loop {
            if SHUTDOWN_REQUESTED.load(Ordering::Relaxed) {
                shutdown.store(true, Ordering::Relaxed);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    });
}
