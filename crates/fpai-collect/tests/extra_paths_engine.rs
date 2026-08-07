//! Extra capture paths, end to end through the real engines.
//!
//! The unit tests in `extra_paths.rs` cover the grammar. These cover the thing
//! the grammar exists for: that a second location is captured with the same
//! fidelity as the default one, that the two do not contaminate each other, and
//! that a machine with no extra path configured behaves exactly as it did
//! before this feature existed.
//!
//! Every assertion here failed before the feature landed, and the interesting
//! ones fail for a DIFFERENT reason than "the field does not exist": with the
//! label threaded only into `filetail`'s own agent-id resolution rather than
//! into `SpoolWriter`, `two_paths_holding_the_same_project_do_not_merge` still
//! passes for the file engine and `a_sqlite_extra_path_namespaces_derived_ids`
//! silently does not — which is exactly the split the choke-point placement
//! exists to prevent.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::filetail::{self, Params, Spec};
use fpai_collect::sources::claude;
use fpai_collect::supervisor::Shutdown;
use serde_json::Value;

const UUID_A: &str = "fb9f0d4f-f739-4069-ac16-9add45fd2506";
const UUID_B: &str = "aa9f0d4f-f739-4069-ac16-9add45fd2507";

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-xp-{}-{}-{}",
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

fn spec(roots: Vec<PathBuf>, spool: PathBuf, state: PathBuf, label: Option<&str>) -> Spec {
    Spec {
        format: claude::FORMAT,
        roots,
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(150),
        health_key: label.map(|l| format!("claude:{l}")),
        params: Params {
            redact: fpai_collect::Redact::Minimal,
            agent_id: claude::DEFAULT_AGENT_ID.into(),
            environment: "local".into(),
            machine_id: None,
            user: None,
            end_idle_mins: 0,
            max_read_bytes: 8 * 1024 * 1024,
            max_batch_bytes: 8 * 1024 * 1024,
            since_days: None,
            label: label.map(str::to_string),
        },
    }
}

async fn run_briefly(s: Spec, ms: u64) {
    let sd = Shutdown::for_test(Arc::new(AtomicBool::new(false)));
    let _ = tokio::time::timeout(Duration::from_millis(ms), filetail::run(s, sd)).await;
}

fn spooled(dir: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else {
        return out;
    };
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        for l in fs::read_to_string(&p).unwrap().lines() {
            if !l.trim().is_empty() {
                out.push(serde_json::from_str(l).unwrap());
            }
        }
    }
    out
}

/// A real Claude transcript, with `cwd` controlling the derived agent id.
fn write_session(root: &Path, project_cwd: &str, uuid: &str, prompts: &[&str]) -> PathBuf {
    let slug = project_cwd.replace('/', "-");
    let proj = root.join(slug);
    fs::create_dir_all(&proj).unwrap();
    let mut lines = Vec::new();
    for (i, p) in prompts.iter().enumerate() {
        lines.push(
            serde_json::json!({
                "type": "user",
                "timestamp": format!("2026-07-18T09:4{}:04.058Z", i.min(9)),
                "cwd": project_cwd,
                "message": {"role": "user", "content": p},
            })
            .to_string(),
        );
    }
    let f = proj.join(format!("{uuid}.jsonl"));
    fs::write(&f, lines.join("\n") + "\n").unwrap();
    f
}

fn agent_ids(events: &[Value]) -> Vec<String> {
    let mut v: Vec<String> = events
        .iter()
        .filter_map(|e| e["agent_id"].as_str().map(str::to_string))
        .collect();
    v.sort();
    v.dedup();
    v
}

// ── the regression that matters most ─────────────────────────────────────

/// A machine with nothing configured must be byte-for-byte what it was.
///
/// `label: None` is the overwhelmingly common case, and the whole feature is
/// worthless if it costs anything there.
#[tokio::test(flavor = "multi_thread")]
async fn default_path_only_is_unchanged_by_the_feature_existing() {
    let root = tmpdir("def-root");
    let spool = tmpdir("def-spool");
    let state = tmpdir("def-state");
    write_session(&root, "/home/u/myrepo", UUID_A, &["hello"]);

    run_briefly(
        spec(vec![root.clone()], spool.clone(), state.clone(), None),
        900,
    )
    .await;

    let ev = spooled(&spool);
    assert!(!ev.is_empty(), "default root produced nothing");
    assert_eq!(
        agent_ids(&ev),
        vec!["claude-myrepo".to_string()],
        "an unlabelled instance must not namespace anything"
    );
    for e in &ev {
        assert_eq!(e["session_id"], UUID_A);
    }

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

// ── the feature ──────────────────────────────────────────────────────────

/// The core claim: an extra path is captured, and its ids are namespaced.
#[tokio::test(flavor = "multi_thread")]
async fn an_extra_path_is_captured_and_namespaced() {
    let extra = tmpdir("x1-root");
    let spool = tmpdir("x1-spool");
    let state = tmpdir("x1-state");
    write_session(&extra, "/srv/team/myrepo", UUID_A, &["from the share"]);

    run_briefly(
        spec(
            vec![extra.clone()],
            spool.clone(),
            state.clone(),
            Some("work"),
        ),
        900,
    )
    .await;

    let ev = spooled(&spool);
    assert!(!ev.is_empty(), "extra path produced nothing");
    assert_eq!(agent_ids(&ev), vec!["work-claude-myrepo".to_string()]);

    // Namespacing must not corrupt anything else on the event.
    let types: Vec<&str> = ev.iter().filter_map(|e| e["type"].as_str()).collect();
    assert!(types.contains(&"agent_start"), "got {types:?}");
    for e in &ev {
        assert_eq!(e["session_id"], UUID_A);
    }

    fs::remove_dir_all(&extra).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

/// The reason the label is part of the grammar rather than optional.
///
/// Two locations holding the same project derive the SAME agent id, because it
/// comes from the `cwd` recorded inside the transcript and both copies say the
/// same thing. Without the label they merge into one agent whose sessions
/// interleave from two unrelated machines' worth of history.
#[tokio::test(flavor = "multi_thread")]
async fn two_paths_holding_the_same_project_do_not_merge() {
    let default_root = tmpdir("m-default");
    let extra_root = tmpdir("m-extra");
    let spool = tmpdir("m-spool");
    let state_a = tmpdir("m-state-a");
    let state_b = tmpdir("m-state-b");

    // Same cwd in both, different session ids — exactly a laptop and a share
    // holding checkouts of one repo.
    write_session(&default_root, "/home/u/myrepo", UUID_A, &["local work"]);
    write_session(&extra_root, "/home/u/myrepo", UUID_B, &["share work"]);

    run_briefly(
        spec(
            vec![default_root.clone()],
            spool.clone(),
            state_a.clone(),
            None,
        ),
        900,
    )
    .await;
    run_briefly(
        spec(
            vec![extra_root.clone()],
            spool.clone(),
            state_b.clone(),
            Some("share"),
        ),
        900,
    )
    .await;

    let ev = spooled(&spool);
    let ids = agent_ids(&ev);
    assert_eq!(
        ids,
        vec![
            "claude-myrepo".to_string(),
            "share-claude-myrepo".to_string()
        ],
        "the two locations must stay distinct agents; got {ids:?}"
    );

    // And each id carries only its own session.
    for e in &ev {
        let id = e["agent_id"].as_str().unwrap();
        let sid = e["session_id"].as_str().unwrap();
        if id.starts_with("share-") {
            assert_eq!(sid, UUID_B, "share events carried the local session");
        } else {
            assert_eq!(sid, UUID_A, "local events carried the share session");
        }
    }

    for d in [&default_root, &extra_root, &spool, &state_a, &state_b] {
        fs::remove_dir_all(d).ok();
    }
}

/// Steady-state: several paths for one harness, tailed at the same time, with
/// content appended while both are live.
#[tokio::test(flavor = "multi_thread")]
async fn three_simultaneous_paths_for_one_harness_all_tail() {
    let a = tmpdir("s-a");
    let b = tmpdir("s-b");
    let c = tmpdir("s-c");
    let spool = tmpdir("s-spool");
    let (sa, sb, sc) = (tmpdir("s-st-a"), tmpdir("s-st-b"), tmpdir("s-st-c"));

    write_session(&a, "/home/u/alpha", UUID_A, &["one"]);
    write_session(&b, "/home/u/beta", UUID_B, &["two"]);
    write_session(&c, "/home/u/gamma", UUID_A, &["three"]);

    let sd = Shutdown::for_test(Arc::new(AtomicBool::new(false)));
    let h1 = tokio::spawn(filetail::run(
        spec(vec![a.clone()], spool.clone(), sa.clone(), None),
        sd.clone(),
    ));
    let h2 = tokio::spawn(filetail::run(
        spec(vec![b.clone()], spool.clone(), sb.clone(), Some("two")),
        sd.clone(),
    ));
    let h3 = tokio::spawn(filetail::run(
        spec(vec![c.clone()], spool.clone(), sc.clone(), Some("three")),
        sd.clone(),
    ));

    tokio::time::sleep(Duration::from_millis(1100)).await;
    for h in [h1, h2, h3] {
        h.abort();
    }

    let ev = spooled(&spool);
    let ids = agent_ids(&ev);
    assert!(ids.contains(&"claude-alpha".to_string()), "got {ids:?}");
    assert!(ids.contains(&"two-claude-beta".to_string()), "got {ids:?}");
    assert!(
        ids.contains(&"three-claude-gamma".to_string()),
        "got {ids:?}"
    );

    // Each instance kept its own cursor store, so none is empty and none was
    // clobbered by another. This is the failure the per-instance state dir
    // exists to prevent: a shared store writes its whole map atomically, so the
    // loser re-reads from zero after every restart.
    for (d, who) in [(&sa, "default"), (&sb, "two"), (&sc, "three")] {
        let has = fs::read_dir(d).map(|r| r.count() > 0).unwrap_or(false);
        assert!(has, "{who} instance persisted no cursor of its own");
    }

    for d in [&a, &b, &c, &spool, &sa, &sb, &sc] {
        fs::remove_dir_all(d).ok();
    }
}

/// A path added to an ALREADY-RUNNING configuration backfills its history.
///
/// The mechanism is that the new instance has no cursor, so every file under it
/// is a first discovery and is read from the start of the backfill window. This
/// asserts the outcome rather than the mechanism: history written long before
/// the path was registered still arrives.
#[tokio::test(flavor = "multi_thread")]
async fn a_newly_added_path_backfills_history_written_before_it_was_added() {
    let default_root = tmpdir("bf-default");
    let extra_root = tmpdir("bf-extra");
    let spool = tmpdir("bf-spool");
    let state_a = tmpdir("bf-state-a");
    let state_b = tmpdir("bf-state-b");

    // History that already existed on the share, with several turns so a
    // partial read would be visible.
    write_session(
        &extra_root,
        "/srv/archive/oldrepo",
        UUID_B,
        &["turn one", "turn two", "turn three"],
    );
    write_session(&default_root, "/home/u/myrepo", UUID_A, &["current"]);

    // The machine as it was: default path only. The share is not captured.
    run_briefly(
        spec(
            vec![default_root.clone()],
            spool.clone(),
            state_a.clone(),
            None,
        ),
        900,
    )
    .await;
    let before = agent_ids(&spooled(&spool));
    assert_eq!(
        before,
        vec!["claude-myrepo".to_string()],
        "the share must not be captured before it is registered"
    );

    // ...and now the operator registers it. A fresh instance, fresh cursor.
    run_briefly(
        spec(
            vec![extra_root.clone()],
            spool.clone(),
            state_b.clone(),
            Some("archive"),
        ),
        900,
    )
    .await;

    let ev = spooled(&spool);
    let after = agent_ids(&ev);
    assert!(
        after.contains(&"archive-claude-oldrepo".to_string()),
        "history under the newly added path was not backfilled; got {after:?}"
    );

    // The pre-existing turns, not just an agent_start.
    let prompts = ev
        .iter()
        .filter(|e| e["agent_id"] == "archive-claude-oldrepo")
        .filter(|e| e["type"] == "model_request")
        .count();
    assert!(
        prompts >= 3,
        "only {prompts} of 3 historical turns backfilled"
    );

    for d in [&default_root, &extra_root, &spool, &state_a, &state_b] {
        fs::remove_dir_all(d).ok();
    }
}

/// Re-running an instance ships nothing new — the label must not defeat the
/// cursor, which would re-ship the whole path on every poll forever.
#[tokio::test(flavor = "multi_thread")]
async fn a_labelled_instance_resumes_from_its_cursor() {
    let extra = tmpdir("r-root");
    let spool = tmpdir("r-spool");
    let state = tmpdir("r-state");
    write_session(&extra, "/srv/x/repo", UUID_A, &["hi"]);

    run_briefly(
        spec(vec![extra.clone()], spool.clone(), state.clone(), Some("w")),
        900,
    )
    .await;
    let first = spooled(&spool).len();
    assert!(first > 0);

    let spool2 = tmpdir("r-spool2");
    run_briefly(
        spec(
            vec![extra.clone()],
            spool2.clone(),
            state.clone(),
            Some("w"),
        ),
        900,
    )
    .await;
    let second = spooled(&spool2);
    let non_end: Vec<&Value> = second.iter().filter(|e| e["type"] != "agent_end").collect();
    assert!(
        non_end.is_empty(),
        "a resumed labelled instance re-shipped {} events",
        non_end.len()
    );

    for d in [&extra, &spool, &spool2, &state] {
        fs::remove_dir_all(d).ok();
    }
}

// ── the SQLite half ──────────────────────────────────────────────────────
//
// This is why the label is applied in `SpoolWriter::push` and not in either
// engine. A SQLite format is handed `params.agent_id` as a FALLBACK and derives
// the real id from the row — `devin::agent_id(working_directory, fallback)`
// returns `devin-<project>` and never looks at the fallback for a session that
// has a working directory, which is all of them. So prefixing `params.agent_id`
// would namespace only the sessions that failed to derive an id: the rare ones,
// and none of the ones anybody looks at.

mod sqlite_half {
    use super::{spooled, tmpdir};
    use fpai_collect::sources::devin;
    use fpai_collect::sqlitepoll::{self, Params, Spec};
    use fpai_collect::supervisor::Shutdown;
    use rusqlite::{Connection, params};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    const SCHEMA: &str = r#"
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
    model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER,
    shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT,
    hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
    created_at INTEGER NOT NULL, metadata TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id), UNIQUE(session_id, node_id));
"#;

    const T0: i64 = 1_785_396_633;
    const ISO0: &str = "2026-07-30T07:30:33.500577515Z";

    /// A Devin database holding one session in `working_dir`.
    fn db_with(name: &str, working_dir: &str) -> (PathBuf, PathBuf) {
        let dir = tmpdir(name);
        let path = dir.join("sessions.db");
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO sessions(id, working_directory, backend_type, model, agent_mode,
                                  created_at, last_activity_at, hidden)
             VALUES ('s1', ?1, 'anthropic', 'claude-sonnet-4-6', 'auto', ?2, ?2, 0)",
            params![working_dir, T0],
        )
        .unwrap();
        let msg = serde_json::json!({"role": "user", "content": "hello"}).to_string();
        let meta = serde_json::json!({"created_at": ISO0}).to_string();
        conn.execute(
            "INSERT INTO message_nodes(session_id, node_id, chat_message, created_at, metadata)
             VALUES ('s1', 1, ?1, ?2, ?3)",
            params![msg, T0, meta],
        )
        .unwrap();
        (dir, path)
    }

    fn spec(db: &Path, spool: PathBuf, state: PathBuf, label: Option<&str>) -> Spec {
        Spec {
            format: devin::FORMAT,
            db_path: db.to_path_buf(),
            spool_dir: spool,
            state_dir: state,
            poll_interval: Duration::from_millis(150),
            health_key: label.map(|l| format!("devin:{l}")),
            params: Params {
                redact: fpai_collect::Redact::Minimal,
                agent_id: devin::DEFAULT_AGENT_ID.into(),
                environment: "local".into(),
                machine_id: None,
                user: None,
                max_rows_per_poll: 500,
                max_batch_bytes: 8 * 1024 * 1024,
                max_drain_passes: 8,
                label: label.map(str::to_string),
            },
        }
    }

    async fn run_briefly(s: Spec, ms: u64) {
        let sd = Shutdown::for_test(Arc::new(AtomicBool::new(false)));
        let _ = tokio::time::timeout(Duration::from_millis(ms), sqlitepoll::run(s, sd)).await;
    }

    /// The id the format DERIVES from the row is namespaced, not just the
    /// fallback. Prefixing `params.agent_id` passes nothing here.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_sqlite_extra_path_namespaces_derived_ids() {
        let (dir, db) = db_with("sq-x", "/srv/team/checkout");
        let spool = tmpdir("sq-x-spool");
        let state = tmpdir("sq-x-state");

        run_briefly(spec(&db, spool.clone(), state.clone(), Some("team")), 900).await;

        let ev = spooled(&spool);
        assert!(!ev.is_empty(), "sqlite extra path produced nothing");
        for e in &ev {
            assert_eq!(
                e["agent_id"], "team-devin-checkout",
                "the DERIVED id must be namespaced, not just the fallback"
            );
        }

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&spool).ok();
        std::fs::remove_dir_all(&state).ok();
    }

    /// ...and an unlabelled SQLite instance is untouched.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_default_sqlite_instance_is_not_namespaced() {
        let (dir, db) = db_with("sq-d", "/home/u/checkout");
        let spool = tmpdir("sq-d-spool");
        let state = tmpdir("sq-d-state");

        run_briefly(spec(&db, spool.clone(), state.clone(), None), 900).await;

        let ev = spooled(&spool);
        assert!(!ev.is_empty());
        for e in &ev {
            assert_eq!(e["agent_id"], "devin-checkout");
        }

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&spool).ok();
        std::fs::remove_dir_all(&state).ok();
    }
}
