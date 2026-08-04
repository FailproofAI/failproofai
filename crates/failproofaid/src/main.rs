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

/// Install a log subscriber, or the collector's diagnostics go nowhere.
///
/// `tracing` drops every event when no subscriber is registered, silently. The
/// uploader reports "the server accepted the request but stored NONE of its
/// events" through it — the single most important signal that a transform is
/// systematically malformed — so without this that failure is invisible.
///
/// Writes to stderr, which is where the daemon's existing `eprintln!` output
/// already goes and what systemd/launchd capture. `RUST_LOG` overrides the
/// default level.
fn init_logging() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    init_logging();
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
    // One lane, resolving enrolment per tick rather than once at startup.
    // `failproofai config --connect` writes its credential file without root,
    // and this is a SYSTEM unit — so noticing it only on restart would put
    // `sudo systemctl restart` back into a flow built to avoid it. The lane
    // also does integrity repair whether or not the machine is enrolled.
    let cloud_monitor = cloud_client::spawn_maintenance(
        cloud_policy_store,
        shutdown.clone(),
        cloud_client::poll_interval_from_env(),
        cloud_policy_reconcile_interval(),
    );

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
/// Returns an empty list — and therefore starts no thread and no runtime —
/// unless an ingest credential is configured AND at least one stream is
/// enabled. That is the normal state, so an install that has not opted in
/// pays nothing for this code path existing.
///
/// A configuration error is logged and treated as "off" rather than being
/// propagated: collection failing to start must never stop the daemon from
/// serving the socket, because the CLI fails closed and a daemon that refused
/// to boot over a malformed `ingest.json` would deny every tool call on the
/// machine. The error is loud so it is fixable, not silent.
fn collector_tasks() -> Vec<fpai_collect::TaskSpec> {
    let home = match paths::failproofai_home() {
        Ok(home) => home,
        Err(err) => {
            eprintln!("[failproofaid] collector disabled: {err}");
            return Vec::new();
        }
    };

    let cfg = match fpai_collect::config::load(&home) {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("[failproofaid] collector disabled: {err}");
            return Vec::new();
        }
    };

    if !cfg.is_enabled() {
        return Vec::new();
    }

    // `is_enabled()` already established there is one.
    let Some(ingest) = cfg.ingest.clone() else {
        return Vec::new();
    };

    let uploader = match fpai_collect::Uploader::new(
        ingest.url.clone(),
        ingest.key.clone(),
        cfg.failed_dir.clone(),
    ) {
        Ok(u) => std::sync::Arc::new(u),
        Err(err) => {
            eprintln!("[failproofaid] collector disabled: {err}");
            return Vec::new();
        }
    };

    eprintln!(
        "[failproofaid] collector enabled: sessions={} hooks={} ({:?}) -> {}",
        cfg.settings.sessions, cfg.settings.hooks, cfg.settings.hooks_verbosity, ingest.url,
    );

    // One `Delivery` shared by both tasks, so they share an upload semaphore
    // and an in-flight set. Separate ones would let the watcher and a
    // concurrent sweep POST the same batch twice.
    let delivery = std::sync::Arc::new(fpai_collect::Delivery::new(uploader));

    let watch_delivery = delivery.clone();
    let watch_dirs = cfg.spool_dirs.clone();
    let sweep_delivery = delivery;
    let sweep_dirs = cfg.spool_dirs.clone();
    let failed_dir = cfg.failed_dir.clone();

    let mut tasks = Vec::new();

    // Install the process health registry BEFORE any source starts, so no poll
    // reports into a registry that does not exist yet. The writer publishes it
    // on an interval and deletes it on clean shutdown — absence means "no
    // daemon", where a stale file makes a stopped daemon look like a running
    // one whose sources all went quiet.
    let health = std::sync::Arc::new(fpai_collect::Health::new());
    fpai_collect::health::install(health.clone());
    let health_file = fpai_collect::health_path(&home);
    tasks.push(fpai_collect::TaskSpec::new("health", move |sd| {
        fpai_collect::health::writer_task(
            health.clone(),
            health_file.clone(),
            fpai_collect::health::WRITE_INTERVAL,
            sd,
        )
    }));

    if cfg.settings.hooks {
        // Hook activity: one source covering every CLI failproofai is
        // installed in, because the store is CLI-agnostic — each row names its
        // own integration. Reads the same store the dashboard's activity tab
        // does, and never writes to it.
        let store_dir = home.join("cache").join("hook-activity");
        let state_dir = home.join("cursors").join("hooks");
        let spool_dir = cfg.own_spool_dir.clone();
        let verbosity = cfg.settings.hooks_verbosity;
        let environment = cfg.settings.environment.clone();
        let machine_id = cfg.settings.machine_id.clone();
        tasks.push(fpai_collect::TaskSpec::new("hook-activity", move |sd| {
            fpai_collect::sources::hooks::run(
                store_dir.clone(),
                state_dir.clone(),
                spool_dir.clone(),
                verbosity,
                environment.clone(),
                machine_id.clone(),
                sd,
            )
        }));
    }

    if cfg.settings.sessions {
        // Session transcripts, gated on the `sessions` opt-in because — unlike
        // hook activity — these carry prompts, file contents and whatever was
        // pasted into a terminal.
        //
        // Every source is registered the same way regardless of which engine it
        // uses, so adding one is a row here plus its own module.
        let spool = cfg.own_spool_dir.clone();
        let env = cfg.settings.environment.clone();
        let machine = cfg.settings.machine_id.clone();
        let cursors = home.join("cursors");

        use fpai_collect::sources::{claude, codex, copilot, openclaw, pi};
        file_source(
            &mut tasks,
            "claude",
            claude::FORMAT,
            vec![claude_projects_root()],
            claude::DEFAULT_AGENT_ID,
            &spool,
            &cursors,
            &env,
            machine.as_deref(),
        );
        // Subagent transcripts live under the SAME root, claimed by a second
        // format. A separate source, not a second predicate: `is_source_file`
        // is a bare fn, and each source needs its own cursor store — one store
        // writes its whole map atomically, so two sharing a file would clobber
        // each other and the loser would re-ship from zero after every restart.
        file_source(
            &mut tasks,
            "claude-subagent",
            claude::SUBAGENT_FORMAT,
            vec![claude_projects_root()],
            claude::SUBAGENT_DEFAULT_AGENT_ID,
            &spool,
            &cursors,
            &env,
            machine.as_deref(),
        );
        file_source(
            &mut tasks,
            "codex",
            codex::FORMAT,
            vec![codex_sessions_root()],
            codex::DEFAULT_AGENT_ID,
            &spool,
            &cursors,
            &env,
            machine.as_deref(),
        );
        file_source(
            &mut tasks,
            "copilot",
            copilot::FORMAT,
            vec![copilot::session_state_root()],
            copilot::DEFAULT_AGENT_ID,
            &spool,
            &cursors,
            &env,
            machine.as_deref(),
        );
        file_source(
            &mut tasks,
            "openclaw",
            openclaw::FORMAT,
            openclaw::default_roots(),
            openclaw::DEFAULT_AGENT_ID,
            &spool,
            &cursors,
            &env,
            machine.as_deref(),
        );
        file_source(
            &mut tasks,
            "pi",
            pi::FORMAT,
            vec![pi::sessions_root()],
            pi::DEFAULT_AGENT_ID,
            &spool,
            &cursors,
            &env,
            machine.as_deref(),
        );

        use fpai_collect::sources::{goose, hermes, opencode};
        sqlite_source(
            &mut tasks,
            "goose",
            goose::FORMAT,
            goose::db_path(),
            goose::DEFAULT_AGENT_ID,
            &spool,
            cursors.join("goose"),
            &env,
            machine.as_deref(),
        );
        sqlite_source(
            &mut tasks,
            "opencode",
            opencode::FORMAT,
            opencode::default_db_path(),
            opencode::DEFAULT_AGENT_ID,
            &spool,
            cursors.join("opencode"),
            &env,
            machine.as_deref(),
        );

        // Hermes profiles are SEPARATE databases, and the SQLite poller keys its
        // cursor on a fixed synthetic id — so two profiles sharing one state
        // directory would clobber each other's watermark and each would re-read
        // from zero after every restart. Each database gets its own.
        for (i, db) in hermes::default_db_paths().into_iter().enumerate() {
            let state = cursors.join("hermes").join(profile_dir_name(&db, i));
            sqlite_source(
                &mut tasks,
                "hermes",
                hermes::FORMAT,
                db,
                hermes::DEFAULT_AGENT_ID,
                &spool,
                state,
                &env,
                machine.as_deref(),
            );
        }
    }

    tasks.extend([
        // Latency: delivers a batch within milliseconds of it being published.
        fpai_collect::TaskSpec::new("spool-watcher", move |sd| {
            fpai_collect::delivery::watch(watch_delivery.clone(), watch_dirs.clone(), sd)
        }),
        // Guarantee: delivers anything the watcher never saw — published while
        // the daemon was stopped, or on a filesystem with no event support —
        // and retries parked batches on a much slower cadence.
        fpai_collect::TaskSpec::new("spool-sweeper", move |sd| {
            fpai_collect::delivery::sweep(
                sweep_delivery.clone(),
                sweep_dirs.clone(),
                failed_dir.clone(),
                sd,
            )
        }),
    ]);

    tasks
}

/// Where Claude Code keeps its transcripts.
///
/// `CLAUDE_PROJECTS_PATH` overrides it, matching the env var the TypeScript
/// side already honours, so a machine that has moved the directory is captured
/// by both halves rather than one.
fn claude_projects_root() -> std::path::PathBuf {
    if let Some(p) = std::env::var_os("CLAUDE_PROJECTS_PATH") {
        return std::path::PathBuf::from(p);
    }
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    home.join(".claude").join("projects")
}

/// Register one file-tailing source.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
fn file_source(
    tasks: &mut Vec<fpai_collect::TaskSpec>,
    name: &'static str,
    format: fpai_collect::filetail::Format,
    roots: Vec<std::path::PathBuf>,
    default_agent_id: &'static str,
    spool_dir: &std::path::Path,
    cursor_root: &std::path::Path,
    environment: &str,
    machine_id: Option<&str>,
) {
    let spool_dir = spool_dir.to_path_buf();
    // One cursor store per source, never shared: the store writes its whole map
    // atomically, so two sources sharing a file would clobber each other and the
    // loser would re-read from zero after every restart.
    let state_dir = cursor_root.join(name);
    let environment = environment.to_string();
    let machine_id = machine_id.map(str::to_string);
    tasks.push(fpai_collect::TaskSpec::new(name, move |sd| {
        fpai_collect::filetail::run(
            fpai_collect::filetail::Spec {
                format,
                roots: roots.clone(),
                spool_dir: spool_dir.clone(),
                state_dir: state_dir.clone(),
                poll_interval: std::time::Duration::from_secs(2),
                params: fpai_collect::filetail::Params {
                    agent_id: default_agent_id.to_string(),
                    environment: environment.clone(),
                    machine_id: machine_id.clone(),
                    end_idle_mins: 10,
                    max_read_bytes: 32 * 1024 * 1024,
                    max_batch_bytes: fpai_collect::spool::DEFAULT_MAX_BATCH_BYTES,
                    // Never the whole history by default. A normal machine holds
                    // hundreds of megabytes of transcripts, and shipping all of
                    // it on first start is not a reasonable default.
                    since_days: Some(7),
                },
            },
            sd,
        )
    }));
}

/// Register one SQLite-polling source.
#[allow(clippy::too_many_arguments)]
fn sqlite_source(
    tasks: &mut Vec<fpai_collect::TaskSpec>,
    name: &'static str,
    format: fpai_collect::sqlitepoll::SqliteFormat,
    db_path: std::path::PathBuf,
    default_agent_id: &'static str,
    spool_dir: &std::path::Path,
    state_dir: std::path::PathBuf,
    environment: &str,
    machine_id: Option<&str>,
) {
    let spool_dir = spool_dir.to_path_buf();
    let environment = environment.to_string();
    let machine_id = machine_id.map(str::to_string);
    tasks.push(fpai_collect::TaskSpec::new(name, move |sd| {
        fpai_collect::sqlitepoll::run(
            fpai_collect::sqlitepoll::Spec {
                format,
                db_path: db_path.clone(),
                spool_dir: spool_dir.clone(),
                state_dir: state_dir.clone(),
                poll_interval: std::time::Duration::from_secs(5),
                params: fpai_collect::sqlitepoll::Params {
                    agent_id: default_agent_id.to_string(),
                    environment: environment.clone(),
                    machine_id: machine_id.clone(),
                    max_rows_per_poll: 2000,
                    max_batch_bytes: fpai_collect::spool::DEFAULT_MAX_BATCH_BYTES,
                    max_drain_passes: 20,
                },
            },
            sd,
        )
    }));
}

/// A stable, filesystem-safe directory name for one Hermes profile database.
///
/// Derived from the profile directory rather than an index alone, so adding a
/// profile cannot renumber an existing one and silently reset its watermark.
fn profile_dir_name(db: &std::path::Path, index: usize) -> String {
    let name = db
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("default");
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(32)
        .collect();
    if safe.trim_matches('-').is_empty() {
        format!("profile-{index}")
    } else {
        safe
    }
}

/// Where OpenAI Codex keeps its rollout logs.
fn codex_sessions_root() -> std::path::PathBuf {
    if let Some(p) = std::env::var_os("CODEX_HOME") {
        return std::path::PathBuf::from(p).join("sessions");
    }
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    home.join(".codex").join("sessions")
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
