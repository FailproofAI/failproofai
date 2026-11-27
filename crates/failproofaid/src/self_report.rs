//! Self Reports on a Cloud-managed machine: the desired-state field, the
//! effective settings file the daemon writes from it, and the sync it runs when
//! the feature flips (CONTRACT §4–§6).
//!
//! The daemon owns `self-report.json` only while the machine is Cloud
//! enrolled. Off Cloud the TypeScript CLI writes it from the local config, so
//! nothing here touches it then — except a file this daemon itself wrote for an
//! org the machine has since left, which is removed (a departed org's toggle
//! must not decide this machine any more). With the file gone the machine is an
//! open-source one, where Self Reports is on by default unless `config.json`
//! turned it off, so agents are re-synced to match.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use fpai_collect::self_report::{self as sr, Category, McpEndpoint, Settings};
use serde_json::Value;

/// `sync` is bounded: a wedged CLI must not hold a sync slot forever.
const SYNC_TIMEOUT: Duration = Duration::from_secs(60);

/// The `selfReport` block of a desired-state response, as the server sent it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Desired {
    pub enabled: bool,
    /// `None`: the server sent none, so the defaults apply.
    pub categories: Option<Vec<Category>>,
    pub guidance: Option<String>,
}

/// Read `selfReport` off a desired-state body. Absent ⇒ `None` (disabled).
///
/// Lenient on purpose: this rides the policy response, and a malformed block
/// must not refuse the policies beside it. An `enabled` that is not `true`
/// reads as off; a category without a string name and description is dropped.
pub fn decode(raw: &Value) -> Option<Desired> {
    let block = raw.get("selfReport")?.as_object()?;
    let categories = block
        .get("categories")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(Category {
                        name: item.get("name")?.as_str()?.to_string(),
                        description: item.get("description")?.as_str()?.to_string(),
                    })
                })
                .collect()
        });
    Some(Desired {
        enabled: block.get("enabled").and_then(Value::as_bool) == Some(true),
        categories,
        guidance: block
            .get("guidance")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// The last accepted response's block, waiting for the maintenance lane to
/// apply it. Outer `None`: no fresh response since the last apply.
static PENDING: Mutex<Option<Option<Desired>>> = Mutex::new(None);

/// Called with every ACCEPTED desired-state response.
pub fn note_desired(desired: Option<Desired>) {
    *PENDING.lock().unwrap_or_else(|p| p.into_inner()) = Some(desired);
}

pub(crate) fn take_pending() -> Option<Option<Desired>> {
    PENDING.lock().unwrap_or_else(|p| p.into_inner()).take()
}

/// The settings the file should hold for this response.
pub fn effective(desired: Option<&Desired>, port: u16, updated_at: String) -> Settings {
    let enabled = desired.is_some_and(|d| d.enabled);
    Settings {
        version: sr::SETTINGS_VERSION,
        enabled,
        source: "cloud".to_string(),
        categories: sr::sanitize_categories(desired.and_then(|d| d.categories.as_deref())),
        guidance: sr::sanitize_guidance(desired.and_then(|d| d.guidance.as_deref())),
        mcp: McpEndpoint::on_port(port),
        updated_at,
    }
}

/// What one apply did.
#[derive(Debug, PartialEq, Eq)]
pub struct Applied {
    pub written: bool,
    /// What an agent's entry would be may have changed: agent configs need
    /// `self-report sync`.
    pub needs_sync: bool,
}

/// Whether going from `previous` to `next` can change what `self-report sync`
/// writes into an agent's config. Categories and guidance never do (the server
/// reads them on every request); everything an entry is built from does:
///
/// - no file before: this is the first Cloud write. Before it the machine was
///   either on by default (it just enrolled) or off while it waited for this
///   answer (`failproofai config` syncs then and removes every entry), so no
///   file says nothing about what the agents hold;
/// - `source`: a local file is set aside while the org's setting is awaited,
///   which reads as off, so an org "on" that matches the old local "on" still
///   has agents to register;
/// - `enabled`, and the endpoint while on (its port is in the HTTP entries).
fn entries_may_change(previous: Option<&Settings>, next: &Settings) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    previous.source != next.source
        || previous.enabled != next.enabled
        || (next.enabled && previous.mcp != next.mcp)
}

/// Write `path` for this response, only when its content (not `updatedAt`)
/// changed.
pub fn apply(path: &Path, desired: Option<&Desired>, port: u16) -> io::Result<Applied> {
    let previous = sr::read_settings(path);
    let next = effective(desired, port, now_rfc3339());
    if previous.as_ref().is_some_and(|p| p.same_content(&next)) {
        return Ok(Applied {
            written: false,
            needs_sync: false,
        });
    }
    sr::write_settings(path, &next)?;
    Ok(Applied {
        written: true,
        needs_sync: entries_may_change(previous.as_ref(), &next),
    })
}

/// The machine is not enrolled: remove a file this daemon wrote for Cloud.
/// Returns whether agent configs need a sync: the removed file was enabled, or
/// the open-source default that now applies (on, unless `config.json` says
/// off) differs from it.
pub fn release(path: &Path) -> io::Result<bool> {
    let Some(previous) = sr::read_settings(path) else {
        return Ok(false);
    };
    if previous.source != "cloud" {
        return Ok(false);
    }
    match std::fs::remove_file(path) {
        Ok(()) => {
            let now_on = path
                .parent()
                .and_then(|home| sr::effective_settings(home, &|| false))
                .is_some_and(|s| s.enabled);
            Ok(previous.enabled || now_on)
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

/// One maintenance-lane pass. `enrolled`: `Some(true)` enrolled, `Some(false)`
/// definitely not, `None` unknown (credential unreadable: change nothing).
pub fn tick(enrolled: Option<bool>, withdrawn: &dyn Fn() -> bool) {
    let Ok(home) = crate::paths::failproofai_home() else {
        return;
    };
    let path = sr::settings_path(&home);
    match enrolled {
        Some(true) => {
            let Some(desired) = take_pending() else {
                return;
            };
            // A disconnect that landed during the poll: its answer is not ours
            // to apply any more.
            if withdrawn() {
                return;
            }
            match apply(&path, desired.as_ref(), port()) {
                Ok(Applied {
                    written: true,
                    needs_sync,
                }) => {
                    tracing::info!(
                        "Self Reports {} by FailproofAI Cloud",
                        if desired.as_ref().is_some_and(|d| d.enabled) {
                            "enabled"
                        } else {
                            "disabled"
                        }
                    );
                    if needs_sync {
                        spawn_sync();
                    }
                }
                Ok(_) => {}
                Err(err) => tracing::warn!(
                    "could not write {}: {err}; Self Reports settings unchanged",
                    path.display()
                ),
            }
        }
        Some(false) => {
            // Drop any response still pending from before the disconnect.
            let _ = take_pending();
            match release(&path) {
                Ok(true) => {
                    tracing::info!(
                        "Self Reports settings from FailproofAI Cloud removed; \
                         this machine's own setting applies"
                    );
                    spawn_sync();
                }
                Ok(false) => {}
                Err(err) => tracing::warn!("could not remove {}: {err}", path.display()),
            }
        }
        None => {}
    }
}

/// Log one Self Reports event that arrived over the socket (`selfReportLog`):
/// the stdio server's MCP traffic, or a CLI sync's result. Written exactly as
/// the HTTP server's own events, so the machine logs hold both the same way.
/// The preview is scrubbed and cut again here: the sender is not trusted to.
pub fn log_remote(ev: &fpai_ipc::SelfReportLogEvent) {
    let transport = match ev.transport.as_deref() {
        Some("cli") => "cli",
        _ => "stdio",
    };
    sr::log_event(&sr::McpLog {
        event: &ev.event,
        transport,
        agent: ev.agent.as_deref(),
        outcome: ev.outcome.as_deref(),
        reason: ev.reason.as_deref(),
        category: ev.category.as_deref(),
        known_category: ev.known_category,
        session: ev.session.as_deref(),
        detail: ev.preview.as_deref(),
        summary: ev.summary.as_deref(),
    });
}

/// Set on the sync child: print the sync's result on stdout (which this
/// daemon logs) rather than send it back over the socket.
pub const SYNC_LOG_ENV: &str = "FAILPROOFAI_SELF_REPORT_SYNC_LOG";

/// The MCP port, from `FAILPROOFAI_SELF_REPORT_PORT` once per process.
pub fn port() -> u16 {
    static PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
    *PORT.get_or_init(sr::port_from_env)
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

// ── `failproofai self-report sync` ───────────────────────────────────────────

/// How long the startup sync waits for the MCP server to report its bind.
const STARTUP_LISTEN_WAIT: Duration = Duration::from_secs(10);

/// Whether the startup sync should run: Self Reports is on (a missing file is
/// on off Cloud; `sr::effective_settings`).
fn enabled_on_disk(home: &Path, enrolled: &dyn Fn() -> bool) -> bool {
    sr::effective_settings(home, enrolled).is_some_and(|s| s.enabled)
}

/// Run `failproofai self-report sync --quiet` once at startup, after the MCP
/// server has bound its port (or failed to: then the sync's live check finds
/// no endpoint and keeps agents on stdio, which is right), when the feature is
/// on. Off its own thread: the accept loop starts right after this returns,
/// and the sync child's ping waits in the socket's backlog until it does.
pub fn spawn_startup_sync(
    listening: std::sync::mpsc::Receiver<bool>,
    shutdown: std::sync::Arc<AtomicBool>,
) {
    let started = std::thread::Builder::new()
        .name("fpai-self-report-startup".to_string())
        .spawn(move || {
            let bound = listening.recv_timeout(STARTUP_LISTEN_WAIT);
            if shutdown.load(Ordering::Relaxed) {
                return;
            }
            let Ok(home) = crate::paths::failproofai_home() else {
                return;
            };
            if !enabled_on_disk(&home, &*sr::enrolment_check()) {
                return;
            }
            if bound != Ok(true) {
                tracing::warn!("Self Reports MCP server is not listening; syncing agents to stdio");
            }
            spawn_sync();
        });
    if let Err(err) = started {
        tracing::warn!("could not start the Self Reports startup sync: {err}");
    }
}

static SYNC_RUNNING: AtomicBool = AtomicBool::new(false);
static SYNC_AGAIN: AtomicBool = AtomicBool::new(false);

/// Run `failproofai self-report sync --quiet` off the lane's thread. One at a
/// time: a flip while one runs queues exactly one more, since `sync` reads the
/// file afresh and is idempotent.
pub fn spawn_sync() {
    SYNC_AGAIN.store(true, Ordering::SeqCst);
    if SYNC_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let started = std::thread::Builder::new()
        .name("fpai-self-report-sync".to_string())
        .spawn(|| {
            loop {
                while SYNC_AGAIN.swap(false, Ordering::SeqCst) {
                    run_sync_once();
                }
                SYNC_RUNNING.store(false, Ordering::SeqCst);
                // A request that arrived between the last swap and the store.
                if !SYNC_AGAIN.load(Ordering::SeqCst) || SYNC_RUNNING.swap(true, Ordering::SeqCst) {
                    break;
                }
            }
        });
    if let Err(err) = started {
        SYNC_RUNNING.store(false, Ordering::SeqCst);
        tracing::warn!("could not start the Self Reports sync: {err}");
    }
}

/// The command that runs the CLI for `self-report sync`: the service unit's
/// `FAILPROOFAI_CLI_CMD` (the same one the audit lane runs), else a
/// `failproofai` found on `PATH` or in the npm/bun global bin directories. A
/// daemon started by hand in a container has no unit and so no
/// `FAILPROOFAI_CLI_CMD`, while the CLI an `npm install -g` put there is right
/// beside it.
fn sync_cli_command() -> Option<String> {
    crate::audit_lane::cli_command().or_else(|| {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let dirs = global_bin_dirs(
            std::env::var_os("NPM_CONFIG_PREFIX")
                .or_else(|| std::env::var_os("npm_config_prefix"))
                .map(PathBuf::from),
            home.as_deref(),
        );
        find_cli(std::env::var_os("PATH").as_deref(), &dirs).map(|path| shell_quote(&path))
    })
}

/// npm's (and bun's) global bin directories, beyond `PATH`: `$NPM_CONFIG_PREFIX/bin`,
/// `~/.npm-global/bin`, `/usr/local/bin` (npm's default prefix in the Node
/// images), `~/.bun/bin`.
fn global_bin_dirs(npm_prefix: Option<PathBuf>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(prefix) = npm_prefix.filter(|p| !p.as_os_str().is_empty()) {
        dirs.push(prefix.join("bin"));
    }
    if let Some(home) = home {
        dirs.push(home.join(".npm-global").join("bin"));
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    if let Some(home) = home {
        dirs.push(home.join(".bun").join("bin"));
    }
    dirs
}

/// The first executable `failproofai` in `PATH`, then in `extra`.
fn find_cli(path_var: Option<&std::ffi::OsStr>, extra: &[PathBuf]) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let on_path = path_var.map(|p| std::env::split_paths(p).collect::<Vec<_>>());
    on_path
        .unwrap_or_default()
        .into_iter()
        .chain(extra.iter().cloned())
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("failproofai"))
        .find(|candidate| {
            std::fs::metadata(candidate)
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

/// `path` as one `sh` word.
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

fn run_sync_once() {
    let Some(cli) = sync_cli_command() else {
        tracing::warn!(
            "no FAILPROOFAI_CLI_CMD and no `failproofai` on PATH or in the npm global bin, \
             so Self Reports agent configs were not synced — run `failproofai self-report sync`"
        );
        return;
    };
    // The service runs as its user (`failproofaid@<user>`, `User=` + an
    // explicit `HOME=`), so the child inherits that account and home. Checked
    // rather than assumed: a daemon started as root over someone else's home
    // (`sudo -E`, a hand-written unit without `User=`) would have root rewrite
    // that person's agent configs, and one whose home resolves to root's would
    // register the server where the user's agents never look.
    let home = match crate::paths::failproofai_home() {
        Ok(home) => home,
        Err(err) => {
            tracing::warn!("Self Reports sync skipped: {err}");
            return;
        }
    };
    // SAFETY: geteuid has no preconditions and cannot fail.
    let euid = unsafe { libc::geteuid() };
    if let Some(problem) = sync_identity_problem(&home, euid) {
        tracing::warn!("Self Reports sync skipped: {problem}");
        return;
    }
    report_sync(run_with_timeout(
        &format!("{cli} self-report sync --quiet"),
        &home,
        SYNC_TIMEOUT,
    ));
}

/// The daemon's log line for one sync child's exit.
fn report_sync(result: io::Result<Option<i32>>) {
    match result {
        Ok(Some(0)) => tracing::info!("Self Reports agent configs synced"),
        Ok(Some(code)) => tracing::warn!("`failproofai self-report sync` failed (exit {code})"),
        Ok(None) => tracing::warn!("`failproofai self-report sync` was killed (timeout or signal)"),
        Err(err) => tracing::warn!("could not run `failproofai self-report sync`: {err}"),
    }
}

/// Run `command` under `sh -c` in its own process group; kill the group after
/// `timeout`. `Ok(None)`: it ended by a signal (including the timeout's).
/// Why `self-report sync` must not run as this process for `home`, if it must
/// not: the home (`~/.failproofai`, else the directory that would hold it)
/// belongs to another account than the one the daemon runs as.
fn sync_identity_problem(home: &Path, euid: u32) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let probe = if home.exists() {
        home
    } else {
        home.parent().unwrap_or(home)
    };
    let owner = std::fs::metadata(probe).ok()?.uid();
    (owner != euid).then(|| {
        format!(
            "{} belongs to uid {owner} but the daemon runs as uid {euid}; run the service as that user \
             (failproofaid@<user>) or run `failproofai self-report sync` as them",
            probe.display()
        )
    })
}

fn run_with_timeout(command: &str, home: &Path, timeout: Duration) -> io::Result<Option<i32>> {
    run_with_timeout_in(command, home, timeout, None)
}

/// [`run_with_timeout`] with the child's whole environment given (tests: a
/// service's bare `PATH` and a scratch `HOME`, nothing inherited).
fn run_with_timeout_in(
    command: &str,
    home: &Path,
    timeout: Duration,
    only_env: Option<&[(&str, &std::ffi::OsStr)]>,
) -> io::Result<Option<i32>> {
    use std::os::unix::process::CommandExt;
    let mut command = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        if let Some(env) = only_env {
            c.env_clear();
            for (k, v) in env {
                c.env(k, v);
            }
        }
        c
    };
    let mut child = command
        // The CLI resolves the same home the daemon read self-report.json from.
        .env("FAILPROOFAI_HOME", home)
        .env(SYNC_LOG_ENV, "stdout")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()?;
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let mut readers = 0;
    for (label, pipe) in [
        (
            "stdout",
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn io::Read + Send>),
        ),
        (
            "stderr",
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn io::Read + Send>),
        ),
    ] {
        // `sync --quiet` prints nothing on success and one line per agent it
        // could not update on stderr, so a failure in the journal says which
        // agent and why. stderr is a warning; anything on stdout is info.
        if let Some(pipe) = pipe {
            let done = done_tx.clone();
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in io::BufReader::new(pipe).lines().map_while(Result::ok) {
                    if label == "stderr" {
                        tracing::warn!("self-report sync: {line}");
                    } else {
                        tracing::info!("self-report sync: {line}");
                    }
                }
                let _ = done.send(());
            });
            readers += 1;
        }
    }
    drop(done_tx);
    let started = Instant::now();
    let code = loop {
        if let Some(status) = child.try_wait()? {
            break status.code();
        }
        if started.elapsed() > timeout {
            kill_group(&mut child);
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    // Let the output reach the log ahead of the caller's verdict line, but
    // never wait on a pipe some leftover grandchild still holds.
    let deadline = Instant::now() + Duration::from_secs(1);
    for _ in 0..readers {
        let left = deadline.saturating_duration_since(Instant::now());
        if done_rx.recv_timeout(left).is_err() {
            break;
        }
    }
    Ok(code)
}

fn kill_group(child: &mut Child) {
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fpaid-self-report-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("self-report.json")
    }

    #[test]
    fn the_block_is_read_leniently() {
        assert_eq!(decode(&json!({"schemaVersion": 2})), None);
        assert_eq!(decode(&json!({"selfReport": "on"})), None);
        assert_eq!(
            decode(&json!({"selfReport": {"enabled": true}})),
            Some(Desired {
                enabled: true,
                categories: None,
                guidance: None
            })
        );
        let d = decode(&json!({"selfReport": {
            "enabled": "yes",
            "categories": [{"name": "a", "description": "A."}, {"name": 3}, "x"],
            "guidance": "Be brief."
        }}))
        .unwrap();
        assert!(!d.enabled, "only a real true enables");
        assert_eq!(
            d.categories,
            Some(vec![Category {
                name: "a".into(),
                description: "A.".into()
            }])
        );
        assert_eq!(d.guidance.as_deref(), Some("Be brief."));
    }

    #[test]
    fn absent_means_disabled_with_the_defaults() {
        let s = effective(None, 4319, "t".into());
        assert!(!s.enabled);
        assert_eq!(s.source, "cloud");
        assert_eq!(s.categories, sr::default_categories());
        assert_eq!(s.guidance, None);
        assert_eq!(s.mcp.url, "http://127.0.0.1:4319/mcp");

        let s = effective(
            Some(&Desired {
                enabled: true,
                categories: Some(vec![]),
                guidance: Some("  ".into()),
            }),
            5000,
            "t".into(),
        );
        assert!(s.enabled);
        assert_eq!(s.categories, sr::default_categories(), "never empty");
        assert_eq!(s.guidance, None);
        assert_eq!(s.mcp.port, 5000);
    }

    #[test]
    fn the_file_is_rewritten_only_when_its_content_changes() {
        let path = temp_path("apply");
        let on = Desired {
            enabled: true,
            categories: None,
            guidance: None,
        };

        // First write, even while off: before it the machine was on by default
        // (or off while it waited), so the agents' entries are unknown.
        assert_eq!(
            apply(&path, None, 4319).unwrap(),
            Applied {
                written: true,
                needs_sync: true
            }
        );
        let first = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            apply(&path, None, 4319).unwrap(),
            Applied {
                written: false,
                needs_sync: false
            }
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first, "untouched");

        assert_eq!(
            apply(&path, Some(&on), 4319).unwrap(),
            Applied {
                written: true,
                needs_sync: true
            }
        );
        assert!(sr::read_settings(&path).unwrap().enabled);

        // Categories changing rewrites but needs no sync: tools/list re-reads.
        let custom = Desired {
            enabled: true,
            categories: Some(vec![Category {
                name: "x".into(),
                description: "X.".into(),
            }]),
            guidance: None,
        };
        assert_eq!(
            apply(&path, Some(&custom), 4319).unwrap(),
            Applied {
                written: true,
                needs_sync: false
            }
        );
        // A new port does, while enabled.
        assert_eq!(
            apply(&path, Some(&custom), 4400).unwrap(),
            Applied {
                written: true,
                needs_sync: true
            }
        );
        assert_eq!(
            apply(&path, None, 4400).unwrap(),
            Applied {
                written: true,
                needs_sync: true
            }
        );
        let s = sr::read_settings(&path).unwrap();
        assert!(!s.enabled);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    #[test]
    fn the_first_cloud_write_syncs_even_when_it_matches_the_local_file() {
        // The laptop run: `config` wrote a local, enabled file, then synced
        // while enrolled (a local file then reads as off) and removed every
        // entry. The org's first answer, "on", matched the old `enabled`.
        let on = Desired {
            enabled: true,
            ..Default::default()
        };
        let path = temp_path("first-cloud");
        assert_eq!(
            apply(&path, Some(&on), 4319).unwrap(),
            Applied {
                written: true,
                needs_sync: true
            },
            "no file before"
        );

        let path = temp_path("local-to-cloud");
        let mut local = effective(Some(&on), 4319, "t".into());
        local.source = "local".into();
        sr::write_settings(&path, &local).unwrap();
        assert_eq!(
            apply(&path, Some(&on), 4319).unwrap(),
            Applied {
                written: true,
                needs_sync: true
            },
            "a local file replaced by the org's"
        );
        // From then on, only a change an entry is built from syncs.
        assert_eq!(
            apply(
                &path,
                Some(&Desired {
                    enabled: true,
                    guidance: Some("Be brief.".into()),
                    ..Default::default()
                }),
                4319
            )
            .unwrap(),
            Applied {
                written: true,
                needs_sync: false
            }
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn leaving_cloud_removes_only_a_cloud_file() {
        let path = temp_path("release");
        assert!(!release(&path).unwrap(), "no file");

        let mut local = effective(None, 4319, "t".into());
        local.source = "local".into();
        local.enabled = true;
        sr::write_settings(&path, &local).unwrap();
        assert!(!release(&path).unwrap());
        assert!(path.exists(), "the CLI's own file is kept");

        apply(
            &path,
            Some(&Desired {
                enabled: true,
                ..Default::default()
            }),
            4319,
        )
        .unwrap();
        assert!(
            release(&path).unwrap(),
            "an enabled cloud file needs a sync"
        );
        assert!(!path.exists());

        // A disabled cloud file: the machine is open source now, where Self
        // Reports is on by default, so agents need the sync too...
        apply(&path, None, 4319).unwrap();
        assert!(
            release(&path).unwrap(),
            "off -> the open-source default (on)"
        );
        assert!(!path.exists());

        // ...unless config.json turned it off here: off stays off.
        let home = path.parent().unwrap();
        std::fs::write(
            home.join("config.json"),
            r#"{"selfReport":{"enabled":false}}"#,
        )
        .unwrap();
        apply(&path, None, 4319).unwrap();
        assert!(
            !release(&path).unwrap(),
            "a disabled one with a local off does not"
        );
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_sync_that_overruns_is_killed() {
        let started = Instant::now();
        assert_eq!(
            run_with_timeout(
                "sleep 30",
                &std::env::temp_dir(),
                Duration::from_millis(300)
            )
            .unwrap(),
            None
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(
            run_with_timeout("exit 3", &std::env::temp_dir(), Duration::from_secs(5)).unwrap(),
            Some(3)
        );
        assert_eq!(
            run_with_timeout("echo hi", &std::env::temp_dir(), Duration::from_secs(5)).unwrap(),
            Some(0)
        );
    }

    #[test]
    fn the_startup_sync_runs_only_when_self_reports_is_on() {
        let home = temp_path("startup").parent().unwrap().to_path_buf();
        let oss = || false;
        let cloud = || true;
        assert!(
            enabled_on_disk(&home, &oss),
            "no file, open source: on by default"
        );
        assert!(
            !enabled_on_disk(&home, &cloud),
            "no file, enrolled: off until written"
        );
        let mut s = effective(None, 4319, "2026-11-26T00:00:00Z".into());
        sr::write_settings(&sr::settings_path(&home), &s).unwrap();
        assert!(!enabled_on_disk(&home, &oss), "disabled");
        s.enabled = true;
        sr::write_settings(&sr::settings_path(&home), &s).unwrap();
        assert!(enabled_on_disk(&home, &cloud), "enabled");
        std::fs::write(sr::settings_path(&home), "garbage").unwrap();
        assert!(!enabled_on_disk(&home, &oss), "unparsable: off");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn sync_runs_only_as_the_owner_of_the_home() {
        use std::os::unix::fs::MetadataExt;
        let dir = temp_path("sync-identity");
        let home = dir.parent().unwrap().to_path_buf();
        let me = std::fs::metadata(&home).unwrap().uid();
        assert_eq!(sync_identity_problem(&home, me), None);
        // A home that does not exist yet is judged by its parent.
        assert_eq!(sync_identity_problem(&home.join(".failproofai"), me), None);
        let other = me.wrapping_add(1);
        let problem = sync_identity_problem(&home, other).expect("a mismatch is refused");
        assert!(problem.contains(&format!("uid {me}")), "{problem}");
        assert!(problem.contains(&format!("uid {other}")), "{problem}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_cli_is_found_on_path_then_in_the_global_bins() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_path("find-cli").parent().unwrap().to_path_buf();
        let (a, b, global) = (root.join("a"), root.join("b"), root.join("g/bin"));
        for d in [&a, &b, &global] {
            std::fs::create_dir_all(d).unwrap();
        }
        let make = |dir: &Path, mode: u32| {
            let f = dir.join("failproofai");
            std::fs::write(&f, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(mode)).unwrap();
            f
        };
        // Not executable in `a`: skipped. Executable in `b`: found.
        make(&a, 0o644);
        let in_b = make(&b, 0o755);
        let path = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(find_cli(Some(path.as_os_str()), &[]), Some(in_b));
        // Nothing on PATH: the global bin.
        let in_global = make(&global, 0o755);
        let empty = std::env::join_paths([&a]).unwrap();
        assert_eq!(
            find_cli(Some(empty.as_os_str()), std::slice::from_ref(&global)),
            Some(in_global)
        );
        assert_eq!(find_cli(None, std::slice::from_ref(&a)), None);
        // A relative PATH entry is never used.
        assert_eq!(find_cli(Some(std::ffi::OsStr::new("relative")), &[]), None);

        let dirs = global_bin_dirs(Some(root.join("g")), Some(Path::new("/home/u")));
        assert_eq!(dirs[0], global);
        assert!(dirs.contains(&PathBuf::from("/home/u/.npm-global/bin")));
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
        assert_eq!(
            shell_quote(Path::new("/x/it's/failproofai")),
            "'/x/it'\\''s/failproofai'"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_sync_child_gets_the_daemons_home() {
        let dir = temp_path("sync-env");
        let home = dir.parent().unwrap().to_path_buf();
        let out = home.join("seen");
        let code = run_with_timeout(
            &format!("printf %s \"$FAILPROOFAI_HOME\" > '{}'", out.display()),
            &home,
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(code, Some(0));
        assert_eq!(
            std::fs::read_to_string(&out).unwrap(),
            home.display().to_string()
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A machine laid out like an nvm install run by a service: `node` and
    /// npm's `failproofai` link side by side in `<root>/nvm/bin`, the package's
    /// `dist/cli.mjs` (here a shim that runs this checkout's CLI with bun) in
    /// `lib/node_modules`, and a scratch `HOME`. Nothing is inherited from the
    /// test's environment, so no real agent config is ever read or written.
    struct ServiceMachine {
        root: PathBuf,
        home: PathBuf,
        bin: PathBuf,
        /// How the service runs the CLI: `<node> …/dist/cli.mjs`.
        cli: String,
    }

    impl ServiceMachine {
        fn new(name: &str) -> Self {
            let root = temp_path(name).parent().unwrap().to_path_buf();
            let home = root.join("home");
            let bin = root.join("nvm").join("bin");
            let pkg = root.join("nvm/lib/node_modules/failproofai/dist");
            std::fs::create_dir_all(home.join(".failproofai")).unwrap();
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::create_dir_all(&pkg).unwrap();
            let bun = std::env::var_os("PATH")
                .and_then(|p| find_named(&p, "bun"))
                .expect("bun on PATH (cargo test runs the TypeScript CLI with it)");
            // A real file, not a symlink: bun reports a symlink's target as its
            // execPath, and the point is the `node` the service was given.
            let node = bin.join("node");
            if std::fs::hard_link(&bun, &node).is_err() {
                std::fs::copy(&bun, &node).unwrap();
            }
            let repo_cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bin/failproofai.mjs");
            let cli_mjs = pkg.join("cli.mjs");
            std::fs::write(
                &cli_mjs,
                format!(
                    "#!/usr/bin/env node\nawait import({:?});\n",
                    repo_cli.canonicalize().unwrap().display().to_string()
                ),
            )
            .unwrap();
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&cli_mjs, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            std::os::unix::fs::symlink(&cli_mjs, bin.join("failproofai")).unwrap();
            let cli = format!("{} {}", shell_quote(&node), shell_quote(&cli_mjs));
            ServiceMachine {
                root,
                home,
                bin,
                cli,
            }
        }

        fn fp_home(&self) -> PathBuf {
            self.home.join(".failproofai")
        }

        /// Run `<cli> <args>` with `PATH`, the scratch `HOME`, and nothing else.
        fn run(&self, args: &str, path: &str) -> Option<i32> {
            let env: [(&str, &std::ffi::OsStr); 3] = [
                ("PATH", std::ffi::OsStr::new(path)),
                ("HOME", self.home.as_os_str()),
                ("FAILPROOFAI_TELEMETRY_DISABLED", std::ffi::OsStr::new("1")),
            ];
            run_with_timeout_in(
                &format!("{} {args}", self.cli),
                &self.fp_home(),
                SYNC_TIMEOUT,
                Some(&env),
            )
            .unwrap()
        }

        /// The agent configs that hold a `failproofai_local` entry.
        fn registered(&self) -> Vec<&'static str> {
            [
                ("claude", ".claude.json"),
                ("codex", ".codex/config.toml"),
                ("cursor", ".cursor/mcp.json"),
                ("copilot", ".copilot/mcp-config.json"),
                ("factory", ".factory/mcp.json"),
                ("devin", ".config/devin/mcp_config.json"),
            ]
            .into_iter()
            .filter(|(_, file)| {
                std::fs::read_to_string(self.home.join(file))
                    .is_ok_and(|text| text.contains("failproofai_local"))
            })
            .map(|(agent, _)| agent)
            .collect()
        }

        fn config(&self, file: &str) -> String {
            std::fs::read_to_string(self.home.join(file)).unwrap_or_default()
        }
    }

    impl Drop for ServiceMachine {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn find_named(path: &std::ffi::OsStr, name: &str) -> Option<PathBuf> {
        std::env::split_paths(path)
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
            .and_then(|p| p.canonicalize().ok())
    }

    const HOOKED: &str = "claude codex cursor copilot factory devin";

    /// The laptop run, end to end: no settings file; `config` (here its hook
    /// install) runs while the machine is enrolled with no org setting yet,
    /// which is off, so its sync registers nothing; then the daemon writes the
    /// org's "on". That first Cloud write must sync, and the sync, run the way
    /// the service runs it (bare PATH, `<node> dist/cli.mjs`), must register
    /// every hooked agent with no manual `self-report sync`.
    #[test]
    fn the_first_cloud_write_after_an_enrolled_config_registers_every_hooked_agent() {
        let m = ServiceMachine::new("cloud-first-sync");
        std::fs::write(m.fp_home().join("credentials.json"), r#"{"cloud":{}}"#).unwrap();
        let settings = sr::settings_path(&m.fp_home());
        assert!(!settings.exists());

        // `config` runs in the user's shell, where nvm's bin is on PATH.
        let shell_path = format!("{}:/usr/bin:/bin", m.bin.display());
        assert_eq!(
            m.run(
                &format!("policies --install --cli {HOOKED} --scope user"),
                &shell_path
            ),
            Some(0)
        );
        assert!(
            !settings.exists(),
            "an enrolled machine waits for the org's setting"
        );
        assert_eq!(
            m.registered(),
            Vec::<&str>::new(),
            "enrolled with no setting is off"
        );

        // The daemon's maintenance lane, with the org's first answer.
        let on = Desired {
            enabled: true,
            ..Default::default()
        };
        let applied = apply(&settings, Some(&on), 4319).unwrap();
        assert_eq!(
            applied,
            Applied {
                written: true,
                needs_sync: true
            }
        );
        // The sync the lane spawns, under the service's environment.
        assert_eq!(m.run("self-report sync --quiet", "/usr/bin:/bin"), Some(0));
        assert_eq!(
            m.registered(),
            vec!["claude", "codex", "cursor", "copilot", "factory", "devin"]
        );
        // No daemon answers here, so every entry is stdio, on npm's link
        // beside the service's node (on no PATH the service has).
        let link = m.bin.join("failproofai").display().to_string();
        assert!(
            m.config(".cursor/mcp.json").contains(&link),
            "{}",
            m.config(".cursor/mcp.json")
        );
        assert!(m.config(".codex/config.toml").contains(&link));
        // And the same answer again changes nothing.
        assert_eq!(
            apply(&settings, Some(&on), 4319).unwrap(),
            Applied {
                written: false,
                needs_sync: false
            }
        );
    }

    /// The startup sync under a service's PATH: `failproofai` is on no PATH
    /// the service has and the CLI runs as `dist/cli.mjs`, so the only way to
    /// a stdio command is npm's link beside the service's node. Without that
    /// link every server-recorded agent fails and the sync exits 1.
    #[test]
    fn the_startup_sync_finds_the_cli_beside_the_services_node() {
        let m = ServiceMachine::new("service-path");
        let shell_path = format!("{}:/usr/bin:/bin", m.bin.display());
        assert_eq!(
            m.run(
                &format!("policies --install --cli {HOOKED} --scope user"),
                &shell_path
            ),
            Some(0)
        );
        // Not enrolled and no file: on by default, so the install registered them.
        assert_eq!(m.registered().len(), 6);
        // Start over from no entries, then the daemon's startup sync.
        for file in [
            ".claude.json",
            ".codex/config.toml",
            ".cursor/mcp.json",
            ".copilot/mcp-config.json",
            ".factory/mcp.json",
            ".config/devin/mcp_config.json",
        ] {
            let _ = std::fs::remove_file(m.home.join(file));
        }
        assert_eq!(m.run("self-report sync --quiet", "/usr/bin:/bin"), Some(0));
        assert_eq!(m.registered().len(), 6);
        let link = m.bin.join("failproofai").display().to_string();
        assert!(m.config(".copilot/mcp-config.json").contains(&link));

        // The control: without the link the same sync fails, as it did.
        std::fs::remove_file(m.bin.join("failproofai")).unwrap();
        for file in [".cursor/mcp.json", ".copilot/mcp-config.json"] {
            let _ = std::fs::remove_file(m.home.join(file));
        }
        assert_eq!(m.run("self-report sync --quiet", "/usr/bin:/bin"), Some(1));
    }
}
