//! `agents.selected` and scoped backfill requests, driven through the REAL
//! binary against a real home on disk.
//!
//! The selection is written by `failproofai config` into `config.json` and the
//! request by the CLI into `state/backfill-request.json`; the daemon notices both
//! on its own. So the property under test is "a file somebody else wrote is
//! obeyed", which only the binary can show — the same reason
//! `collector_reload_e2e.rs` drives it.
//!
//! What is asserted is what the journal says about each deployment: the
//! supervisor's `collector started tasks=N`, and the line each source logs as it
//! starts, which carries how many cursors it resumed and the first-sight window
//! it was built with.
//!
//! Unlike that file's harness, this one gives the daemon its own `HOME` and
//! clears every root override. With session capture on, an inherited `HOME`
//! would point the sources at the developer's real transcripts — and their own
//! Hermes profiles or extra-path overrides would change the task counts.

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fpai_collect::cursor::{CursorStore, FileCursor};

fn binary_path() -> &'static str {
    env!("CARGO_BIN_EXE_failproofaid")
}

/// Every variable that moves a source's root or the credential.
const ROOT_OVERRIDES: &[&str] = &[
    "CLAUDE_PROJECTS_PATH",
    "CODEX_HOME",
    "COPILOT_HOME",
    "PI_CODING_AGENT_DIR",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_HOME",
    "FACTORY_HOME",
    "ANTIGRAVITY_HOME",
    "CURSOR_HOME",
    "GOOSE_DB_PATH",
    "GOOSE_HOME",
    "DEVIN_DB_PATH",
    "DEVIN_HOME",
    "HERMES_HOME",
    "XDG_DATA_HOME",
    "AGENTEYE_HOME",
    "FAILPROOFAI_INGEST_KEY",
    "FAILPROOFAI_INGEST_URL",
];

const HARNESSES: &[&str] = &[
    "claude",
    "codex",
    "copilot",
    "openclaw",
    "pi",
    "factory",
    "antigravity",
    "cursor",
    "goose",
    "opencode",
    "devin",
    "hermes",
];

const DAY: Duration = Duration::from_secs(86_400);

fn ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

/// A scratch failproofai home (`fp/`) and user home (`home/`), removed on drop.
struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // Short: the socket path below has to fit in a sockaddr_un.
        let root =
            std::env::temp_dir().join(format!("fpai-sel-{}-{tag}-{nanos}", std::process::id()));
        let s = Scratch { root };
        // `run/` and `state/` at 0700: the daemon refuses to adopt a run
        // directory it did not create if the permissions are wider.
        for dir in ["fp/run", "fp/state", "fp/hook-activity", "home", "files"] {
            std::fs::create_dir_all(s.root.join(dir)).unwrap();
        }
        {
            use std::os::unix::fs::PermissionsExt;
            for dir in ["fp/run", "fp/state"] {
                std::fs::set_permissions(s.root.join(dir), std::fs::Permissions::from_mode(0o700))
                    .unwrap();
            }
        }
        let creds = s.fp().join("credentials.json");
        // Nothing listens there; nothing in these tests is ever uploaded.
        std::fs::write(
            &creds,
            r#"{"ingest":{"url":"http://127.0.0.1:59999/v1/events","key":"k"}}"#,
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&creds, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        s
    }

    fn fp(&self) -> PathBuf {
        self.root.join("fp")
    }

    fn home(&self) -> PathBuf {
        self.root.join("home")
    }

    fn config(&self, body: &str) {
        std::fs::write(self.fp().join("config.json"), body).unwrap();
    }

    fn request_path(&self) -> PathBuf {
        self.fp().join("state").join("backfill-request.json")
    }

    fn request(&self, body: &str) {
        std::fs::write(self.request_path(), body).unwrap();
    }

    /// A session file `age` old, outside every root, so no source re-reads it.
    fn file_aged(&self, name: &str, age: Duration) -> PathBuf {
        let path = self.root.join("files").join(name);
        std::fs::write(&path, "x").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - age)
            .unwrap();
        path
    }

    /// A cursor store at `cursors/<rel>` with one cursor per file.
    fn cursors(&self, rel: &str, files: &[&Path]) {
        let mut store = CursorStore::load(self.fp().join("cursors").join(rel));
        for (i, file) in files.iter().enumerate() {
            store.set(FileCursor {
                path: file.to_path_buf(),
                dev: 1,
                inode: i as u64 + 1,
                offset: 1,
                size_seen: 1,
                ..Default::default()
            });
        }
        store.save().unwrap();
    }

    fn cursor_count(&self, rel: &str) -> usize {
        CursorStore::load(self.fp().join("cursors").join(rel)).len()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// `config.json` with session capture on, `agents` as given (`None` omits the
/// key, as every config written before it existed does) and `sources` as the
/// body of `collector.sources`.
fn config(agents: Option<&str>, sources: &str) -> String {
    let agents = agents
        .map(|a| format!(r#""agents":{a},"#))
        .unwrap_or_default();
    format!(
        r#"{{{agents}"mode":{{"kind":"cloud"}},"collector":{{"sessions":true,"hooks":true,"hooks_verbosity":"decisions","redact":"minimal","environment":"local","sources":{{{sources}}}}}}}"#
    )
}

struct DaemonGuard {
    child: Option<Child>,
    stderr: Arc<Mutex<String>>,
}

impl DaemonGuard {
    fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    fn count(&self, needle: &str) -> usize {
        self.stderr().matches(needle).count()
    }

    /// Waits for `needle` to appear `at_least` times, or fails with the log.
    fn wait_for(&self, needle: &str, at_least: usize) {
        let within = Duration::from_secs(20);
        let deadline = Instant::now() + within;
        loop {
            let n = self.count(needle);
            if n >= at_least {
                return;
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

    fn assert_absent(&self, needle: &str) {
        assert_eq!(
            self.count(needle),
            0,
            "{needle:?} should not appear. daemon said:\n{}",
            self.stderr()
        );
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

fn spawn_daemon(s: &Scratch) -> DaemonGuard {
    let mut command = Command::new(binary_path());
    command
        .env("FAILPROOFAI_HOME", s.fp())
        .env("HOME", s.home())
        .env(
            "FAILPROOFAI_DAEMON_SOCKET",
            s.fp().join("run").join("failproofaid.sock"),
        )
        // Never report from a test, and never start a real worker or poll a
        // cloud: none of it is under test, and all of it would be noise.
        .env("FAILPROOFAI_TELEMETRY_DISABLED", "1")
        .env("FAILPROOFAI_WORKER_CMD", "exit 0")
        .env("FAILPROOFAI_CLOUD_POLICY_RECONCILE_MS", "600000")
        .env("FAILPROOFAI_AUDIT_POLL_MS", "600000")
        // Short so the test is not paced by the 5s production default.
        .env("FAILPROOFAI_COLLECTOR_CONFIG_POLL_MS", "500")
        // The assertions read info-level lines.
        .env("RUST_LOG", "info")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for var in ROOT_OVERRIDES {
        command.env_remove(var);
    }
    for harness in HARNESSES {
        command.env_remove(format!(
            "FAILPROOFAI_{}_EXTRA_PATHS",
            harness.to_ascii_uppercase()
        ));
    }
    let mut child = command.spawn().expect("failed to spawn failproofaid");

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

/// The start line a file source logs, up to and including its window.
fn file_source(source: &str, resumed: usize, window_days: u64) -> String {
    format!(
        "file source started source=\"{source}\" resumed={resumed} since_days=Some({window_days})"
    )
}

#[test]
fn with_no_agents_key_every_source_starts() {
    // The regression this feature must not cause: a config written before
    // `agents` existed collects every harness, exactly as it did.
    let s = Scratch::new("all");
    s.config(&config(None, ""));
    let daemon = spawn_daemon(&s);
    daemon.wait_for("collector started tasks=18", 1);
    for source in [
        "claude",
        "claude-subagent",
        "codex",
        "copilot",
        "openclaw",
        "pi",
        "factory",
        "antigravity",
        "cursor",
    ] {
        daemon.wait_for(&file_source(source, 0, 7), 1);
    }
    for source in ["goose", "opencode", "devin", "hermes"] {
        daemon.wait_for(&format!("sqlite source started source=\"{source}\""), 1);
    }
    daemon.assert_absent("agents.selected");
}

#[test]
fn an_unselected_agent_and_its_extra_paths_never_start() {
    let s = Scratch::new("unsel");
    std::fs::create_dir_all(s.home().join(".hermes/profiles/prod")).unwrap();
    let work = s.root.join("work");
    let codex_box = s.root.join("box");
    s.config(&config(
        Some(r#"{"selected":["claude","hermes"],"seen":["claude","codex","hermes"]}"#),
        &format!(
            r#""claude":{{"extra_paths":["work={}"]}},"codex":{{"extra_paths":["box={}"]}}"#,
            work.display(),
            codex_box.display()
        ),
    ));
    let daemon = spawn_daemon(&s);

    // health, hook-activity, claude and claude-subagent with one extra path
    // each, two Hermes profile databases, and the two delivery tasks. Logged by
    // the supervisor before any task runs, so it is the whole deployment.
    daemon.wait_for("collector started tasks=10", 1);
    daemon.wait_for(&file_source("claude", 0, 7), 2);
    daemon.wait_for(&file_source("claude-subagent", 0, 7), 2);
    daemon.wait_for("sqlite source started source=\"hermes\"", 2);
    daemon.wait_for("claude: also capturing", 1);
    daemon.wait_for(
        "[failproofaid] codex is not traced; its 1 extra capture path is idle",
        1,
    );
    daemon.wait_for(
        "[failproofaid] agents.selected: collecting sessions from claude, hermes; not traced: codex,",
        1,
    );
    daemon.assert_absent("source=\"codex\"");
    daemon.assert_absent("codex: also capturing");
    daemon.assert_absent(&codex_box.display().to_string());
    daemon.assert_absent("source=\"goose\"");
}

#[test]
fn an_unknown_selected_name_is_warned_about_on_every_build_even_without_sessions() {
    // Session capture OFF: the warning lives outside the sessions block, because
    // the selection scopes backfills on a decisions-only machine too.
    let s = Scratch::new("unknown");
    let body = config(Some(r#"{"selected":["claude","claud"]}"#), "")
        .replace(r#""sessions":true"#, r#""sessions":false"#);
    s.config(&body);
    let daemon = spawn_daemon(&s);
    let warning = "[failproofaid] agents.selected names claud, which has no collector source; \
                   nothing is collected for it. Known: claude, codex, copilot, openclaw, pi, \
                   factory, antigravity, cursor, goose, opencode, devin, hermes";
    daemon.wait_for("collector started tasks=4", 1);
    daemon.wait_for(warning, 1);

    // Once per build: a cycle builds again and says it again.
    s.config(&body.replace(
        r#""hooks_verbosity":"decisions""#,
        r#""hooks_verbosity":"all""#,
    ));
    daemon.wait_for("cycling the collector", 1);
    daemon.wait_for("collector started", 2);
    daemon.wait_for(warning, 2);
    assert_eq!(daemon.count(warning), 2, "{}", daemon.stderr());
}

#[test]
fn changing_the_selection_mid_run_cycles_the_right_sources() {
    let s = Scratch::new("cycle");
    s.config(&config(
        Some(r#"{"selected":["claude"],"seen":["claude"]}"#),
        "",
    ));
    let daemon = spawn_daemon(&s);
    daemon.wait_for("collector started tasks=6", 1);
    daemon.wait_for(&file_source("claude", 0, 7), 1);
    daemon.wait_for(&file_source("claude-subagent", 0, 7), 1);
    daemon.assert_absent("source=\"codex\"");

    // What `failproofai config` writes when claude is unticked and codex
    // ticked. Nothing restarts the daemon; it has to notice.
    s.config(&config(
        Some(r#"{"selected":["codex"],"seen":["claude","codex"]}"#),
        "",
    ));
    daemon.wait_for("collector configuration changed; cycling the collector", 1);
    daemon.wait_for("collector started tasks=5", 1);
    daemon.wait_for(&file_source("codex", 0, 7), 1);
    // The second deployment did not start claude again.
    assert_eq!(
        daemon.count(&file_source("claude", 0, 7)),
        1,
        "{}",
        daemon.stderr()
    );

    // A newly detected agent changes only `seen`, which is nothing to cycle for.
    s.config(&config(
        Some(r#"{"selected":["codex"],"seen":["claude","codex","goose"]}"#),
        "",
    ));
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(
        daemon.count("cycling the collector"),
        1,
        "a seen-only edit cycled the collector:\n{}",
        daemon.stderr()
    );
}

#[test]
fn a_pending_request_is_applied_before_the_collector_first_starts() {
    let s = Scratch::new("pending");
    s.config(&config(Some(r#"{"selected":["claude","codex"]}"#), ""));
    let claude_file = s.file_aged("claude.jsonl", Duration::from_secs(3600));
    let subagent_file = s.file_aged("subagent.jsonl", Duration::from_secs(3600));
    let codex_file = s.file_aged("codex.jsonl", Duration::from_secs(3600));
    s.cursors("claude", &[&claude_file]);
    s.cursors("claude-subagent", &[&subagent_file]);
    s.cursors("codex", &[&codex_file]);
    // `failproofai backfill --agents claude --since 1d`, left for a daemon that
    // was not running.
    let now = SystemTime::now();
    s.request(&format!(
        r#"{{"sinceMs":{},"requestedAtMs":{},"agents":["claude"],"kind":"user"}}"#,
        ms(now - DAY),
        ms(now)
    ));

    let daemon = spawn_daemon(&s);
    daemon.wait_for("collector started", 1);
    // The FIRST deployment already started from the rewound stores, with
    // claude's window covering the request — so nothing ever resumed the
    // forgotten cursors, not even for one tick.
    daemon.wait_for(&file_source("claude", 0, 2), 1);
    daemon.wait_for(&file_source("claude-subagent", 0, 2), 1);
    // Not named: its cursor is resumed and its window is not widened.
    daemon.wait_for(&file_source("codex", 1, 7), 1);

    let log = daemon.stderr();
    let applied = log
        .find("backfill requested")
        .unwrap_or_else(|| panic!("the request was never applied:\n{log}"));
    let started = log.find("collector started").unwrap();
    assert!(
        applied < started,
        "the request must be applied before the first deployment starts:\n{log}"
    );
    assert!(!s.request_path().exists(), "an applied request is removed");

    // And no second cycle followed to apply it late.
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(daemon.count("collector started"), 1, "{}", daemon.stderr());
}

#[test]
fn a_stale_added_request_is_dropped_and_its_agents_keep_their_cursors() {
    let s = Scratch::new("stale");
    s.config(&config(Some(r#"{"selected":["codex"]}"#), ""));
    let codex_file = s.file_aged("codex.jsonl", Duration::from_secs(3600));
    s.cursors("codex", &[&codex_file]);
    // Written by an open-source `config` run eleven minutes ago, where nothing
    // was collecting.
    let written = SystemTime::now() - Duration::from_secs(11 * 60);
    s.request(&format!(
        r#"{{"sinceMs":{},"requestedAtMs":{},"agents":["codex"],"kind":"added"}}"#,
        ms(written - 7 * DAY),
        ms(written)
    ));

    let daemon = spawn_daemon(&s);
    daemon.wait_for("dropping a stale backfill request", 1);
    daemon.wait_for(&file_source("codex", 1, 7), 1);
    daemon.assert_absent("backfill requested");
    assert!(
        !s.request_path().exists(),
        "a dropped request is not retried"
    );
    assert_eq!(s.cursor_count("codex"), 1);
}

#[test]
fn a_fresh_added_request_forgets_every_cursor_and_leaves_hook_decisions_alone() {
    let s = Scratch::new("added");
    let codex_box = s.root.join("box");
    s.config(&config(
        Some(r#"{"selected":["codex"]}"#),
        &format!(
            r#""codex":{{"extra_paths":["box={}"]}}"#,
            codex_box.display()
        ),
    ));
    let fresh = s.file_aged("fresh.jsonl", Duration::from_secs(3600));
    // Last touched long before any window: a windowed rewind would keep it, and
    // the re-added agent would resume mid-file.
    let old = s.file_aged("old.jsonl", 60 * DAY);
    let boxed = s.file_aged("box.jsonl", 60 * DAY);
    let decisions = s.file_aged("decisions.jsonl", Duration::from_secs(3600));
    s.cursors("codex", &[&fresh, &old]);
    s.cursors("codex/box", &[&boxed]);
    s.cursors("hooks", &[&decisions]);
    let now = SystemTime::now();
    s.request(&format!(
        r#"{{"sinceMs":{},"requestedAtMs":{},"agents":["codex"],"kind":"added"}}"#,
        ms(now - 7 * DAY),
        ms(now)
    ));

    let daemon = spawn_daemon(&s);
    daemon.wait_for("backfill requested", 1);
    // Both instances, the default root and the extra path, start clean on the
    // default seven days — exactly like an agent traced for the first time.
    daemon.wait_for(&file_source("codex", 0, 7), 2);
    daemon.wait_for("hook-activity source started", 1);
    let log = daemon.stderr();
    let hooks_line = log
        .lines()
        .find(|l| l.contains("hook-activity source started"))
        .unwrap();
    assert!(
        hooks_line.contains("resumed=1"),
        "re-adding an agent must not re-send every CLI's decisions: {hooks_line}"
    );
    assert_eq!(s.cursor_count("codex"), 0);
    assert_eq!(s.cursor_count("codex/box"), 0);
}

#[test]
fn an_agent_re_added_on_a_running_daemon_never_resumes_its_stale_cursors() {
    // `failproofai config` re-adding codex: it writes the `added` request
    // FIRST and the selection after, so when the daemon reads the request codex
    // is not selected yet. The request must still reach it — otherwise the
    // next tick starts codex on the cursor it held before it was unticked.
    let s = Scratch::new("readd");
    s.config(&config(Some(r#"{"selected":["claude"]}"#), ""));
    let stale = s.file_aged("stale.jsonl", 60 * DAY);
    s.cursors("codex", &[&stale]);

    let daemon = spawn_daemon(&s);
    daemon.wait_for("collector started tasks=6", 1);

    let now = SystemTime::now();
    s.request(&format!(
        r#"{{"sinceMs":{},"requestedAtMs":{},"agents":["codex"],"kind":"added"}}"#,
        ms(now - 7 * DAY),
        ms(now)
    ));
    // The worst case: a tick lands between the two writes, so the request is
    // applied while codex is still unselected.
    daemon.wait_for("backfill requested", 1);
    assert_eq!(s.cursor_count("codex"), 0, "{}", daemon.stderr());
    s.config(&config(Some(r#"{"selected":["claude","codex"]}"#), ""));

    daemon.wait_for(&file_source("codex", 0, 7), 1);
    daemon.assert_absent("file source started source=\"codex\" resumed=1");
}
