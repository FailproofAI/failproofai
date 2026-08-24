//! The collector picks up a configuration change without a daemon restart.
//!
//! The collector resolves its ingest credential once, when it starts, and the
//! uploader caches the bearer key at construction. So rotating a key used to
//! leave the file correct and the process wrong: `--connect` verified the NEW
//! key and reported success, the service stayed healthy, `credentials.json`
//! held a key that worked when curled — and every batch 401'd and parked.
//!
//! Observed live before this existed: a key revoked at 13:05:37 and replaced 37
//! seconds later was still producing 401s twenty minutes on, with 26 parked
//! batches and a CLI insisting the machine was connected. The only symptom was
//! data that never arrived, which is the hardest kind of failure to notice.
//!
//! These drive the REAL binary against a real config file on disk, because the
//! property under test is "an edit somebody else made is noticed". `config.json`
//! says "Safe to edit by hand" and means it — a fleet tool, an editor or a `sed`
//! are all legitimate, and none of them run our code. A test that called an
//! internal reload function would prove something else entirely.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn binary_path() -> &'static str {
    env!("CARGO_BIN_EXE_failproofaid")
}

fn unique_home(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "failproofaid-reload-{}-{}-{}",
        std::process::id(),
        name,
        nanos
    ))
}

/// Writes a home the daemon will accept.
///
/// `run/` and `state/` are created at 0700 deliberately: the daemon refuses to
/// adopt a run directory it did not create if the permissions are wider, which
/// is a real guard and not something a test should route around.
fn make_home(home: &Path, ingest_key: &str) {
    std::fs::create_dir_all(home.join("run")).unwrap();
    std::fs::create_dir_all(home.join("state")).unwrap();
    std::fs::create_dir_all(home.join("hook-activity")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for d in ["run", "state"] {
            std::fs::set_permissions(home.join(d), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
    }
    std::fs::write(
        home.join("config.json"),
        r#"{"mode":{"kind":"cloud"},"collector":{"sessions":false,"hooks":true,"hooks_verbosity":"decisions","redact":"minimal","environment":"local"}}"#,
    )
    .unwrap();
    write_credentials(home, ingest_key);
}

fn write_credentials(home: &Path, key: &str) {
    let path = home.join("credentials.json");
    std::fs::write(
        &path,
        format!(r#"{{"ingest":{{"url":"http://127.0.0.1:59999/v1/events","key":"{key}"}}}}"#),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

struct DaemonGuard {
    child: Option<Child>,
    stderr: Arc<Mutex<String>>,
}

impl DaemonGuard {
    fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    /// Waits for `needle` to appear `at_least` times, or fails with the log.
    fn wait_for(&self, needle: &str, at_least: usize, within: Duration) -> usize {
        let deadline = Instant::now() + within;
        loop {
            let n = self.stderr().matches(needle).count();
            if n >= at_least {
                return n;
            }
            if Instant::now() >= deadline {
                panic!(
                    "waited {within:?} for {at_least}x {needle:?}, saw {n}. daemon said:\n{}",
                    self.stderr()
                );
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn spawn_daemon(home: &Path) -> DaemonGuard {
    let mut child = Command::new(binary_path())
        .env("FAILPROOFAI_HOME", home)
        .env(
            "FAILPROOFAI_DAEMON_SOCKET",
            home.join("run/failproofaid.sock"),
        )
        // Never report from a test — a scratch home with no opt-out resolves
        // telemetry to its shipped default, which is ON.
        .env("FAILPROOFAI_TELEMETRY_DISABLED", "1")
        // Short so the test is not paced by the 5s production default.
        .env("FAILPROOFAI_COLLECTOR_CONFIG_POLL_MS", "500")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn failproofaid");

    let log = Arc::new(Mutex::new(String::new()));
    if let Some(pipe) = child.stderr.take() {
        let sink = log.clone();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(pipe).lines().map_while(Result::ok) {
                let mut g = sink.lock().unwrap();
                g.push_str(&line);
                g.push('\n');
            }
        });
    }
    DaemonGuard {
        child: Some(child),
        stderr: log,
    }
}

#[test]
fn a_credential_edited_by_hand_cycles_the_collector() {
    // The headline case, and deliberately a HAND edit: the daemon must notice a
    // change nothing of ours made. A CLI that restarts the service covers only
    // the changes it made itself, which is being told rather than reloading.
    let home = unique_home("hand-edit");
    make_home(&home, "the-old-and-now-revoked-key");
    let daemon = spawn_daemon(&home);
    daemon.wait_for("collector enabled", 1, Duration::from_secs(20));

    write_credentials(&home, "a-freshly-minted-replacement-key");

    daemon.wait_for(
        "collector configuration changed; cycling the collector",
        1,
        Duration::from_secs(20),
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn it_keeps_noticing_changes_rather_than_reloading_once() {
    // A one-shot reload would pass the test above and still strand the second
    // rotation, so the loop is asserted rather than the first iteration.
    //
    // Each edit waits for the previous deployment to be RUNNING, not merely for
    // the cycle to be announced. "cycling the collector" is logged before
    // `join_with_flush` drains the old deployment, so an edit made on that log
    // line lands mid-cycle and is picked up by the same rebuild — the daemon
    // coalesces to the latest config, correctly, and no second cycle is ever
    // logged. Asserting the count without this sync tests the timing of the
    // test, not the behaviour of the daemon.
    let home = unique_home("repeat");
    make_home(&home, "key-one");
    let daemon = spawn_daemon(&home);
    daemon.wait_for("collector started", 1, Duration::from_secs(20));

    write_credentials(&home, "key-two");
    daemon.wait_for("cycling the collector", 1, Duration::from_secs(20));
    daemon.wait_for("collector started", 2, Duration::from_secs(20));

    write_credentials(&home, "key-three");
    daemon.wait_for("cycling the collector", 2, Duration::from_secs(20));
    daemon.wait_for("collector started", 3, Duration::from_secs(20));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn an_unchanged_config_does_not_cycle_anything() {
    // Re-reading the file every tick must not look like a change, or the
    // collector would be torn down and rebuilt twice a second — losing the
    // in-flight batches of every deployment.
    let home = unique_home("stable");
    make_home(&home, "a-stable-key");
    let daemon = spawn_daemon(&home);
    daemon.wait_for("collector enabled", 1, Duration::from_secs(20));

    // Several poll intervals with nobody touching anything.
    std::thread::sleep(Duration::from_secs(4));

    assert_eq!(
        daemon.stderr().matches("cycling the collector").count(),
        0,
        "an untouched config cycled the collector. daemon said:\n{}",
        daemon.stderr()
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_half_written_config_is_waited_out_rather_than_acted_on() {
    // A file caught mid-save is unreadable, not "disabled". Treating that as a
    // change would tear down a healthy collector and rebuild it from the same
    // bytes a tick later — and on a fleet tool that rewrites configs, on every
    // rewrite.
    let home = unique_home("torn");
    make_home(&home, "a-stable-key");
    let daemon = spawn_daemon(&home);
    daemon.wait_for("collector enabled", 1, Duration::from_secs(20));

    // Truncated TOML: a real mid-save state, not invented garbage.
    let mut f = std::fs::File::create(home.join("credentials.json")).unwrap();
    f.write_all(b"{\"ingest\":{\"url\":\"http://127.0.0.1:59999/v1/ev")
        .unwrap();
    drop(f);
    std::thread::sleep(Duration::from_secs(3));

    assert_eq!(
        daemon.stderr().matches("cycling the collector").count(),
        0,
        "a torn config cycled the collector. daemon said:\n{}",
        daemon.stderr()
    );

    // And once the write completes, the change IS picked up — waiting must not
    // mean ignoring.
    write_credentials(&home, "the-completed-write");
    daemon.wait_for("cycling the collector", 1, Duration::from_secs(20));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn disabling_collection_stops_it_and_re_enabling_starts_it_again() {
    // `--disconnect` used to require a restart to take effect, so a machine that
    // had left its organisation went on shipping. The reverse matters just as
    // much: re-enabling must not need one either, or the fix is half a fix.
    //
    // The lever is the CREDENTIAL, because that is what `--disconnect` actually
    // removes (`clearIngestCredential` in cloud-enrollment-cli.ts). This used to
    // toggle `collector.hooks` as a stand-in, which no longer disables anything:
    // that flag gates the daemon's own hook-activity source and deliberately
    // does NOT gate delivery, since the spool also carries batches the
    // `failproofai-sdk` wrote from the user's own process. Toggling the real
    // thing is a stronger test of the scenario this exists for, and the
    // companion test below pins the behaviour that replaced the old lever.
    let home = unique_home("toggle");
    make_home(&home, "a-stable-key");
    let daemon = spawn_daemon(&home);
    daemon.wait_for("collector enabled", 1, Duration::from_secs(20));

    let creds = home.join("credentials.json");
    let on = std::fs::read_to_string(&creds).unwrap();
    std::fs::remove_file(&creds).unwrap();
    daemon.wait_for("no longer enabled", 1, Duration::from_secs(20));

    std::fs::write(&creds, &on).unwrap();
    daemon.wait_for("collector enabled", 2, Duration::from_secs(20));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn turning_both_capture_sources_off_leaves_delivery_running() {
    // The counterweight to the change above, and the bug it came from: with
    // `sessions` and `hooks` both false the daemon used to start NOTHING — no
    // spool watcher, no sweeper, no log line — so every batch the SDK wrote
    // sat on disk forever, with no error on either side and an unread spool
    // indistinguishable from an idle one.
    //
    // Those two settings gate the daemon's own capture sources, and each is
    // checked again where its source is registered, so leaving them off still
    // starts neither. What they must not gate is delivery.
    let home = unique_home("sources-off");
    make_home(&home, "a-stable-key");
    let cfg = home.join("config.json");
    let on = std::fs::read_to_string(&cfg).unwrap();
    std::fs::write(&cfg, on.replace(r#""hooks":true"#, r#""hooks":false"#)).unwrap();

    let daemon = spawn_daemon(&home);
    daemon.wait_for("collector enabled", 1, Duration::from_secs(20));
    // The watcher is the thing that ships an SDK batch; without it this daemon
    // is a process that reports healthy and delivers nothing.
    daemon.wait_for("spool watcher started", 1, Duration::from_secs(20));
    assert!(
        !daemon.stderr().contains("hook-activity source started"),
        "hooks=false must still switch the daemon's own hook source off:\n{}",
        daemon.stderr()
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// An extra capture path added by hand is picked up without a restart.
///
/// `failproofai harness add-path` writes `[collector.sources.<harness>]
/// extra_paths` and tells the user the daemon will notice on its own. That
/// promise rests entirely on `sources` living inside the `CollectorConfig` the
/// manager compares each tick — nothing registers the field explicitly, and
/// moving it anywhere resolved later would break the promise silently: the CLI
/// keeps reporting success, the config keeps parsing, and the running daemon
/// simply never captures the path until it is restarted for some unrelated
/// reason.
///
/// Asserted on the REAL binary against a hand-edited file, like the cases above
/// and for the same reason — the property is "an edit somebody else made is
/// noticed", and a fleet tool or a `sed` is a legitimate way to make it.
///
/// The task-count line is what proves the path was actually REGISTERED rather
/// than merely triggering a cycle: `sessions = true` turns the session sources
/// on, and each labelled path adds its own task on top (claude's extra path
/// adds two — the main and subagent formats share a root).
#[test]
fn an_extra_capture_path_added_by_hand_is_registered_without_a_restart() {
    let home = unique_home("extra-path");
    make_home(&home, "a-key");
    // Session capture on: extra paths are a session-source feature, and the
    // default config `make_home` writes has it off.
    let cfg = home.join("config.json");
    let base = std::fs::read_to_string(&cfg)
        .unwrap()
        .replace(r#""sessions":false"#, r#""sessions":true"#);
    std::fs::write(&cfg, &base).unwrap();

    let daemon = spawn_daemon(&home);
    daemon.wait_for("collector enabled", 1, Duration::from_secs(20));
    daemon.wait_for("collector started", 1, Duration::from_secs(20));

    let extra = home.join("extra-claude-projects");
    std::fs::create_dir_all(&extra).unwrap();
    // Appending a TOML table to a JSON file produces something no parser
    // accepts, and `load_settings` treats an unreadable config as "unchanged" —
    // so the daemon would never cycle and this test would wait out its full
    // timeout for a reason that had nothing to do with the feature.
    std::fs::write(
        &cfg,
        base.replace(
            r#""environment":"local""#,
            &format!(
                r#""environment":"local","sources":{{"claude":{{"extra_paths":["late={}"]}}}}"#,
                extra.display()
            ),
        ),
    )
    .unwrap();

    daemon.wait_for(
        "collector configuration changed; cycling the collector",
        1,
        Duration::from_secs(20),
    );
    // The daemon names every extra path it accepts, so this is the line that
    // says the entry was parsed and not rejected.
    daemon.wait_for("also capturing", 1, Duration::from_secs(20));
    daemon.wait_for("collector started", 2, Duration::from_secs(20));
    let _ = std::fs::remove_dir_all(&home);
}
