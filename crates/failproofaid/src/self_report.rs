//! Self Reports on a Cloud-managed machine: the desired-state field, the
//! effective settings file the daemon writes from it, and the sync it runs when
//! the feature flips (CONTRACT §4–§6).
//!
//! The daemon owns `self-report.json` only while the machine is Cloud
//! enrolled. Off Cloud the TypeScript CLI writes it from the local config, so
//! nothing here touches it then — except a file this daemon itself wrote for an
//! org the machine has since left, which is removed (a departed org's toggle
//! must not keep the tool registered in every agent).

use std::io;
use std::path::Path;
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

fn take_pending() -> Option<Option<Desired>> {
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
    /// `enabled` or the port changed: agent configs need `self-report sync`.
    pub needs_sync: bool,
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
    let was_enabled = previous.as_ref().is_some_and(|p| p.enabled);
    let port_changed = previous.as_ref().is_some_and(|p| p.mcp.port != port);
    Ok(Applied {
        written: true,
        needs_sync: was_enabled != next.enabled || (next.enabled && port_changed),
    })
}

/// The machine is not enrolled: remove a file this daemon wrote for Cloud.
/// Returns whether agent configs need a sync (the removed file was enabled).
pub fn release(path: &Path) -> io::Result<bool> {
    let Some(previous) = sr::read_settings(path) else {
        return Ok(false);
    };
    if previous.source != "cloud" {
        return Ok(false);
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(previous.enabled),
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
                    tracing::info!("Self Reports settings from FailproofAI Cloud removed");
                    spawn_sync();
                }
                Ok(false) => {}
                Err(err) => tracing::warn!("could not remove {}: {err}", path.display()),
            }
        }
        None => {}
    }
}

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

fn run_sync_once() {
    // The CLI the service unit names, the same way the audit lane runs it.
    let Some(cli) = crate::audit_lane::cli_command() else {
        tracing::warn!(
            "Self Reports changed but this service unit carries no FAILPROOFAI_CLI_CMD, \
             so agent configs were not updated — run `failproofai self-report sync`"
        );
        return;
    };
    match run_with_timeout(&format!("{cli} self-report sync --quiet"), SYNC_TIMEOUT) {
        Ok(Some(0)) => tracing::info!("Self Reports agent configs synced"),
        Ok(Some(code)) => tracing::warn!("`failproofai self-report sync` failed (exit {code})"),
        Ok(None) => tracing::warn!("`failproofai self-report sync` was killed (timeout or signal)"),
        Err(err) => tracing::warn!("could not run `failproofai self-report sync`: {err}"),
    }
}

/// Run `command` under `sh -c` in its own process group; kill the group after
/// `timeout`. `Ok(None)`: it ended by a signal (including the timeout's).
fn run_with_timeout(command: &str, timeout: Duration) -> io::Result<Option<i32>> {
    use std::os::unix::process::CommandExt;
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()?;
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
        if let Some(pipe) = pipe {
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in io::BufReader::new(pipe).lines().map_while(Result::ok) {
                    tracing::info!("self-report sync {label}: {line}");
                }
            });
        }
    }
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status.code());
        }
        if started.elapsed() > timeout {
            kill_group(&mut child);
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
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

        // First write while off: nothing was registered, nothing to sync.
        assert_eq!(
            apply(&path, None, 4319).unwrap(),
            Applied {
                written: true,
                needs_sync: false
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

        apply(&path, None, 4319).unwrap();
        assert!(!release(&path).unwrap(), "a disabled one does not");
        assert!(!path.exists());
    }

    #[test]
    fn a_sync_that_overruns_is_killed() {
        let started = Instant::now();
        assert_eq!(
            run_with_timeout("sleep 30", Duration::from_millis(300)).unwrap(),
            None
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(
            run_with_timeout("exit 3", Duration::from_secs(5)).unwrap(),
            Some(3)
        );
        assert_eq!(
            run_with_timeout("echo hi", Duration::from_secs(5)).unwrap(),
            Some(0)
        );
    }
}
