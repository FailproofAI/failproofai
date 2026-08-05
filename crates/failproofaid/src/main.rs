mod audit_lane;
mod cloud_client;
pub mod cloud_policies;
mod lock;
mod paths;
mod server;
mod telemetry;
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

    // The shutdown flag and its signal handler are installed BEFORE anything
    // long-running starts, so every lane below observes the same flag the socket
    // server does. One SIGTERM then stops all of them; a second signal path
    // would be one more thing to get wrong during shutdown.
    let shutdown = Arc::new(AtomicBool::new(false));
    install_signal_handler(shutdown.clone());

    // Telemetry first, and deliberately ahead of the worker: the warm-up below
    // is the earliest thing that reports, and a lane installed after it would
    // drop the very event that says whether the worker came up. `spawn` only
    // resolves the opt-out and installs an in-memory buffer — every request it
    // ever makes happens on its own thread, never here and never on the hook
    // path (see the module header; this daemon fails closed).
    let telemetry_lane = telemetry::spawn(shutdown.clone());
    let started_at = telemetry::record_started();

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
    // INERT until ingest is configured. But the config is not necessarily
    // ready at startup: `failproofai config` installs the daemon and THEN
    // connects, so the very first daemon start usually sees no ingest yet. A
    // manager thread waits for the config to become enabled and starts the
    // collector once it is — the collector's analogue of the cloud lane
    // re-resolving enrolment per tick, so enabling collection takes effect
    // within one interval with no restart and no root (see
    // `spawn_collector_manager`). The manager owns the collector's lifecycle,
    // including draining it on shutdown.
    let collector_mgr = spawn_collector_manager(shutdown.clone());

    // The scheduled local audit. Another lane on the same pattern — its own
    // thread, the same shutdown flag, every error swallowed — but it never
    // evaluates anything in-process: it spawns `failproofai audit --scheduled`
    // as a separate short-lived process, because a ~104-second scan on the warm
    // worker's single serialized chain would exceed worker.rs's 30s cap and turn
    // into a DENY on every tool call across all 12 CLIs (see audit_lane's header).
    //
    // Started unconditionally although the feature is OFF by default: like the
    // collector manager and the cloud lane, it re-reads config.toml every tick,
    // so switching it on with `failproofai config` — which writes that file
    // WITHOUT root, against a system unit — takes effect without a restart.
    let audit_lane = audit_lane::spawn(shutdown.clone());

    // Handled rather than `?`-ed, because a bare `?` here returns past every
    // join below — including the telemetry flush — so a daemon that cannot bind
    // its socket would buffer `daemon_started` and then take it to the grave.
    // That is the single most interesting failure this daemon has: on a
    // `daemonConfigured` machine it is every tool call across all 12 CLIs denied
    // against a socket nothing is listening on, in a `Restart=on-failure` loop,
    // and it is precisely the case nobody can see from outside the machine.
    // (Every other `?` between the lane starting and here can only fail when
    // HOME is unset, in which case the lane has already stopped and buffered
    // nothing.)
    let srv = match server::Server::bind(&socket_path, worker) {
        Ok(srv) => srv,
        Err(err) => {
            shutdown.store(true, Ordering::Relaxed);
            let _ = telemetry_lane.join();
            telemetry::record_stopped("bind_failed", started_at);
            telemetry::shutdown_flush();
            return Err(err.into());
        }
    };
    eprintln!("[failproofaid] listening on {}", socket_path.display());

    let run_result = srv.run_until(shutdown);

    // Join the manager, which drains the collector within its flush budget
    // before returning. Done before `?` so a server error still gives the
    // collector a chance to flush instead of dropping buffered events.
    let _ = collector_mgr.join();
    let _ = cloud_monitor.join();
    // Returns promptly even mid-scan: the lane watches the same flag while it
    // waits on its child and kills the process group rather than waiting the
    // scan out, so a `systemctl stop` is never held up by an audit.
    let _ = audit_lane.join();

    // Joined BEFORE the stop event is recorded, so nothing contends with the
    // final send. `run_result` is what distinguishes the two ways this daemon
    // ends: a signal (the ordinary stop, and every upgrade) from a socket server
    // that gave up, which on a fail-closed machine is every tool call denied
    // until systemd restarts it.
    let _ = telemetry_lane.join();
    telemetry::record_stopped(
        if run_result.is_ok() {
            "signal"
        } else {
            "server_error"
        },
        started_at,
    );
    telemetry::shutdown_flush();

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
/// Own the collector's lifecycle on a dedicated thread.
///
/// The collector config is not necessarily complete when the daemon starts:
/// `failproofai config` installs the service, so the daemon comes up, and only
/// THEN runs the connect step that writes `ingest.json` and the collector
/// block. Resolving the config once at startup therefore left a freshly-set-up
/// machine shipping nothing until the next manual restart — the exact confusion
/// a user hit while testing.
///
/// This mirrors what the cloud-policy lane already does: it re-resolves its
/// config every tick precisely so `--connect` needs no root (restarting a
/// system unit does). The collector follows the same rule — it waits for the
/// config to become enabled, then starts once. Enabling collection thus takes
/// effect within one poll interval, no restart, no sudo.
///
/// It starts the collector once and does not tear it back down on a later
/// `--disconnect` — that remains a restart, matching today's behaviour and
/// avoiding a second start against the set-once health registry. The gap this
/// closes is the common one: enabled *after* startup never taking effect.
fn spawn_collector_manager(daemon_shutdown: Arc<AtomicBool>) -> std::thread::JoinHandle<()> {
    let interval = collector_config_poll_interval();
    std::thread::Builder::new()
        .name("fpai-collect-mgr".to_string())
        .spawn(move || {
            // Wait until collection is enabled. A cheap config read each tick,
            // not the full task build, so an incomplete config waits quietly
            // rather than logging on every interval.
            loop {
                if daemon_shutdown.load(Ordering::Relaxed) {
                    return;
                }
                if collector_is_enabled() {
                    break;
                }
                let deadline = std::time::Instant::now() + interval;
                while std::time::Instant::now() < deadline {
                    if daemon_shutdown.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            }

            // Enabled — build and start. `collector_tasks()` logs "collector
            // enabled" once; `spawn_supervised` returns None only if the config
            // flipped back to disabled between the check and the build, or the
            // runtime failed to start.
            let Some(collector) =
                fpai_collect::spawn_supervised(collector_tasks(), daemon_shutdown.clone())
            else {
                return;
            };

            // Publish the counters the collector already keeps for its health
            // record, so the telemetry lane can POLL them. A pull, not a push:
            // no telemetry code enters `fpai-collect`, and a task quietly
            // restarting in a loop stops being invisible from outside the
            // machine.
            telemetry::set_collector_metrics(collector.metrics());

            while !daemon_shutdown.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(200));
            }
            collector.join_with_flush(fpai_collect::DEFAULT_FLUSH_BUDGET);
        })
        .expect("failed to spawn the collector manager thread")
}

/// Cheap "should the collector be running?" check — reads the two small config
/// files. Any error resolves to `false`; the full `collector_tasks()` build
/// logs the reason when it acts on an enabled config.
fn collector_is_enabled() -> bool {
    let Ok(home) = paths::failproofai_home() else {
        return false;
    };
    fpai_collect::config::load(&home)
        .map(|cfg| cfg.is_enabled())
        .unwrap_or(false)
}

/// How often to re-check whether the collector config has become enabled.
/// Short by default — it is two small JSON reads — so enabling collection after
/// a fresh setup is prompt. `FAILPROOFAI_COLLECTOR_CONFIG_POLL_MS` overrides it.
fn collector_config_poll_interval() -> Duration {
    const DEFAULT_MS: u64 = 5_000;
    const MINIMUM_MS: u64 = 500;
    let ms = std::env::var("FAILPROOFAI_COLLECTOR_CONFIG_POLL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_MS);
    Duration::from_millis(ms.max(MINIMUM_MS))
}

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

    let cursors_root = paths::cursors_dir().unwrap_or_else(|_| home.join("cursors"));

    // The OS user this daemon runs as — the profile half of the (machine_id,
    // user) identity. Resolved once and stamped onto every event by every source
    // below, so two profiles on one machine stay distinct in the fleet views.
    let os_user = current_os_user();

    if cfg.settings.hooks {
        // Hook activity: one source covering every CLI failproofai is
        // installed in, because the store is CLI-agnostic — each row names its
        // own integration. Reads the same store the dashboard's activity tab
        // does, and never writes to it.
        // Layout 2: promoted out of cache/ (see paths.rs).
        let store_dir = paths::hook_activity_dir().unwrap_or_else(|_| home.join("hook-activity"));
        let state_dir = cursors_root.join("hooks");
        let spool_dir = cfg.own_spool_dir.clone();
        let verbosity = cfg.settings.hooks_verbosity;
        let environment = cfg.settings.environment.clone();
        let machine_id = cfg.settings.machine_id.clone();
        let hooks_user = os_user.clone();
        tasks.push(fpai_collect::TaskSpec::new("hook-activity", move |sd| {
            fpai_collect::sources::hooks::run(
                store_dir.clone(),
                state_dir.clone(),
                spool_dir.clone(),
                verbosity,
                environment.clone(),
                machine_id.clone(),
                hooks_user.clone(),
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
        let cursors = cursors_root.clone();

        use fpai_collect::sources::{
            antigravity, claude, codex, copilot, cursor, factory, openclaw, pi,
        };
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
            os_user.as_deref(),
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
            os_user.as_deref(),
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
            os_user.as_deref(),
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
            os_user.as_deref(),
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
            os_user.as_deref(),
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
            os_user.as_deref(),
        );
        file_source(
            &mut tasks,
            "factory",
            factory::FORMAT,
            vec![factory_sessions_root()],
            factory::DEFAULT_AGENT_ID,
            &spool,
            &cursors,
            &env,
            machine.as_deref(),
            os_user.as_deref(),
        );
        file_source(
            &mut tasks,
            "antigravity",
            antigravity::FORMAT,
            vec![antigravity_brain_root()],
            antigravity::DEFAULT_AGENT_ID,
            &spool,
            &cursors,
            &env,
            machine.as_deref(),
            os_user.as_deref(),
        );
        file_source(
            &mut tasks,
            "cursor",
            cursor::FORMAT,
            vec![cursor_projects_root()],
            cursor::DEFAULT_AGENT_ID,
            &spool,
            &cursors,
            &env,
            machine.as_deref(),
            os_user.as_deref(),
        );

        use fpai_collect::sources::{devin, goose, hermes, opencode};
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
            os_user.as_deref(),
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
            os_user.as_deref(),
        );
        sqlite_source(
            &mut tasks,
            "devin",
            devin::FORMAT,
            devin::db_path(),
            devin::DEFAULT_AGENT_ID,
            &spool,
            cursors.join("devin"),
            &env,
            machine.as_deref(),
            os_user.as_deref(),
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
                os_user.as_deref(),
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
    user: Option<&str>,
) {
    let spool_dir = spool_dir.to_path_buf();
    // One cursor store per source, never shared: the store writes its whole map
    // atomically, so two sources sharing a file would clobber each other and the
    // loser would re-read from zero after every restart.
    let state_dir = cursor_root.join(name);
    let environment = environment.to_string();
    let machine_id = machine_id.map(str::to_string);
    let user = user.map(str::to_string);
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
                    user: user.clone(),
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
    user: Option<&str>,
) {
    let spool_dir = spool_dir.to_path_buf();
    let environment = environment.to_string();
    let machine_id = machine_id.map(str::to_string);
    let user = user.map(str::to_string);
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
                    user: user.clone(),
                    max_rows_per_poll: 2000,
                    max_batch_bytes: fpai_collect::spool::DEFAULT_MAX_BATCH_BYTES,
                    max_drain_passes: 20,
                },
            },
            sd,
        )
    }));
}

/// The OS user this daemon runs as, for stamping onto collected events.
///
/// Resolved from the real uid via the password database, not `$USER`: a
/// system-scope service unit runs with a minimal environment where `$USER` may
/// be unset or stale, whereas the uid is always authoritative. Returns `None`
/// when the uid has no passwd entry (or the name is empty/non-UTF-8), in which
/// case events simply carry no user — the same "never invent an identity"
/// stance `machine_id` takes.
fn current_os_user() -> Option<String> {
    // SAFETY: getuid reads this process's credentials and cannot fail.
    let uid = unsafe { libc::getuid() };
    // The reentrant getpwuid_r fills a caller-owned buffer, so nothing here
    // races on the shared static that the plain getpwuid returns.
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 1024];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    loop {
        // SAFETY: `pwd`, `buf` and `result` all outlive the call; `result`
        // receives either `&mut pwd` or null.
        let rc =
            unsafe { libc::getpwuid_r(uid, &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
        if rc == libc::ERANGE {
            // Buffer too small — grow and retry, capped so a broken libc cannot
            // spin us into unbounded allocation.
            if buf.len() >= 64 * 1024 {
                return None;
            }
            buf.resize(buf.len() * 2, 0);
            continue;
        }
        if rc != 0 || result.is_null() {
            return None;
        }
        break;
    }
    // SAFETY: `pw_name` points into `buf`, valid until `buf` is dropped; the
    // string is copied out before that happens.
    let name = unsafe { std::ffi::CStr::from_ptr(pwd.pw_name) };
    name.to_str()
        .ok()
        .map(str::to_string)
        .filter(|s| !s.is_empty())
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

/// `~/.factory/sessions`, honouring the `FACTORY_HOME` override the audit
/// adapter uses so tests can point at a fixture tree.
fn factory_sessions_root() -> std::path::PathBuf {
    if let Some(p) = std::env::var_os("FACTORY_HOME") {
        return std::path::PathBuf::from(p).join("sessions");
    }
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    home.join(".factory").join("sessions")
}

/// `~/.gemini/antigravity-cli/brain`, honouring the `ANTIGRAVITY_HOME` override
/// (which points at the `antigravity-cli` dir) the audit adapter uses.
fn antigravity_brain_root() -> std::path::PathBuf {
    if let Some(p) = std::env::var_os("ANTIGRAVITY_HOME") {
        return std::path::PathBuf::from(p).join("brain");
    }
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    home.join(".gemini").join("antigravity-cli").join("brain")
}

/// `~/.cursor/projects`, honouring the `CURSOR_HOME` override the audit adapter
/// uses so tests can point at a fixture tree.
fn cursor_projects_root() -> std::path::PathBuf {
    if let Some(p) = std::env::var_os("CURSOR_HOME") {
        return std::path::PathBuf::from(p).join("projects");
    }
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    home.join(".cursor").join("projects")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_os_user_resolves_the_running_user() {
        // Guards the unsafe getpwuid_r plumbing: whoever runs the tests has a
        // passwd entry, so the lookup must yield a non-empty name.
        let name = current_os_user().expect("the running uid should resolve to a passwd entry");
        assert!(!name.is_empty());
        // It reads the process uid, not the environment, so it is stable across
        // calls within one process.
        assert_eq!(current_os_user().as_deref(), Some(name.as_str()));
    }
}
