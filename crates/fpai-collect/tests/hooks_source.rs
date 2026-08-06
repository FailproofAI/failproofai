//! Hook-activity source: transform correctness, rotation, and resume.
//!
//! Row shapes here are verbatim from `~/.failproofai/cache/hook-activity/` on a
//! real machine (19,339 rows over 17 days, 12 distinct event types).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::config::HooksVerbosity;
use fpai_collect::sources::hooks;
use fpai_collect::sources::hooks::transform::{self, HookRow};
use fpai_collect::supervisor::Shutdown;
use serde_json::Value;

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-hooks-{}-{}-{}",
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

/// A deny row, verbatim in shape from the real store.
fn deny_row() -> String {
    serde_json::json!({
        "timestamp": 1785740912184i64,
        "eventType": "PreToolUse",
        "integration": "claude",
        "toolName": "Bash",
        "policyName": "failproofai/block-sudo",
        "matchedPolicies": ["failproofai/block-env-files", "failproofai/block-sudo"],
        "decision": "deny",
        "reason": "sudo commands are blocked",
        "durationMs": 1,
        "sessionId": "3ee9c788-8772-4f92-be0b-a80ede7ac48e",
        "cwd": "/home/sidd/Desktop/work-failproofai/failproofai",
        "permissionMode": "default"
    })
    .to_string()
}

fn allow_row(ts: i64, tool: &str) -> String {
    serde_json::json!({
        "timestamp": ts,
        "eventType": "PreToolUse",
        "integration": "claude",
        "toolName": tool,
        "matchedPolicies": ["failproofai/block-sudo"],
        "decision": "allow",
        "durationMs": 42,
        "sessionId": "sess-a",
        "cwd": "/home/u/repo",
        "permissionMode": "default"
    })
    .to_string()
}

fn parse(s: &str) -> HookRow {
    serde_json::from_str(s).unwrap()
}

/// Read every event out of the spool directory.
fn spooled(dir: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).unwrap().filter_map(|e| e.ok()) {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        for line in fs::read_to_string(&p).unwrap().lines() {
            if !line.trim().is_empty() {
                out.push(serde_json::from_str(line).unwrap());
            }
        }
    }
    out
}

async fn run_once(store: &Path, state: &Path, spool: &Path, v: HooksVerbosity) {
    let sd = Shutdown::for_test(Arc::new(AtomicBool::new(false)));
    // The source polls every 5s; run it briefly, which is long enough for the
    // first pass (which happens immediately) to complete.
    let fut = hooks::run(
        store.to_path_buf(),
        state.to_path_buf(),
        spool.to_path_buf(),
        v,
        "local".into(),
        None,
        None,
        sd,
    );
    let _ = tokio::time::timeout(Duration::from_millis(1500), fut).await;
}

#[test]
fn epoch_millis_become_rfc3339_with_microseconds() {
    // Verified against `date -u -d @1785740912.184`.
    let s = transform::to_rfc3339_micros(1785740912184, 0).unwrap();
    assert_eq!(s, "2026-08-03T07:08:32.184000Z");
    // The index offset separates the two legs of one pair by a microsecond, so
    // hook_completed cannot sort before its own hook_triggered.
    let s1 = transform::to_rfc3339_micros(1785740912184, 1).unwrap();
    assert_eq!(s1, "2026-08-03T07:08:32.184001Z");
    assert!(s < s1);
}

#[test]
fn a_leap_day_is_handled() {
    // The reason this uses a date library rather than hand-rolled maths.
    // 2024-02-29T00:00:00Z
    assert_eq!(
        transform::to_rfc3339_micros(1709164800000, 0).unwrap(),
        "2024-02-29T00:00:00.000000Z"
    );
}

#[test]
fn a_deny_row_becomes_a_paired_trigger_and_completion() {
    let events = transform::to_events(&parse(&deny_row()), 4096, "local");
    assert_eq!(events.len(), 2);

    let start = &events[0];
    let end = &events[1];
    assert_eq!(start["type"], "hook_triggered");
    assert_eq!(end["type"], "hook_completed");

    // Paired on hook_id — this is what the server's latency endpoint joins on.
    assert_eq!(start["hook_id"], end["hook_id"]);
    assert!(start["hook_id"].as_str().unwrap().contains("4096"));

    assert_eq!(start["hook_name"], "PreToolUse");
    assert_eq!(start["trigger_event"], "PreToolUse");
    // trigger_event on the START leg only: the server filters via a semijoin
    // over hook_id, so duplicating it would double-count every hook.
    assert!(end.get("trigger_event").is_none());

    assert_eq!(end["outcome"], "deny");
    assert_eq!(end["error"], "sudo commands are blocked");
    assert_eq!(end["error_type"], "failproofai_deny");
    assert_eq!(end["failproofai_policy"], "failproofai/block-sudo");
    assert_eq!(start["duration_ms"], 1.0);
}

#[test]
fn an_allow_row_carries_no_error_field() {
    // The server's is_error is a truthiness check, so an `error` present on an
    // allow would render every successful hook as a failure.
    let row = parse(&allow_row(1785740912184, "Read"));
    let events = transform::to_events(&row, 0, "local");
    assert_eq!(events[1]["outcome"], "allow");
    assert!(events[1].get("error").is_none());
    assert!(events[1].get("error_type").is_none());
}

#[test]
fn a_deny_with_no_reason_still_gets_a_non_empty_error() {
    let mut v: serde_json::Value = serde_json::from_str(&deny_row()).unwrap();
    v["reason"] = Value::Null;
    let events = transform::to_events(&serde_json::from_value(v).unwrap(), 0, "local");
    let err = events[1]["error"].as_str().unwrap();
    assert!(!err.is_empty(), "an empty error would read as a success");
}

#[test]
fn a_row_with_no_session_id_is_dropped_rather_than_shipped() {
    // Ingest requires session_id and silently skips lines without one, so
    // emitting would just inflate the server's skipped counter.
    let mut v: serde_json::Value = serde_json::from_str(&deny_row()).unwrap();
    v["sessionId"] = Value::Null;
    let events = transform::to_events(&serde_json::from_value(v).unwrap(), 0, "local");
    assert!(events.is_empty());
}

#[test]
fn the_agent_id_matches_what_the_session_sources_produce() {
    // The collector's claude source files this machine's sessions under
    // `claude-failproofai`. Hook events must land under the same agent or the
    // dashboard shows two that look unrelated.
    let row = parse(&deny_row());
    assert_eq!(transform::agent_id(&row), "claude-failproofai");

    // No cwd (a gateway session) falls back to the bare integration.
    let mut v: serde_json::Value = serde_json::from_str(&deny_row()).unwrap();
    v["cwd"] = Value::Null;
    assert_eq!(
        transform::agent_id(&serde_json::from_value(v).unwrap()),
        "claude"
    );
}

#[test]
fn two_rows_in_one_session_never_collide_on_hook_id() {
    // The real corpus has 8,613 PreToolUse rows in one session. A per-session
    // id would have collapsed all of them into a single row server-side.
    let row = parse(&deny_row());
    let a = transform::to_events(&row, 100, "local");
    let b = transform::to_events(&row, 200, "local");
    assert_ne!(a[0]["hook_id"], b[0]["hook_id"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn decisions_verbosity_keeps_denies_exact_and_rolls_up_allows() {
    let store = tmpdir("verb-store");
    let state = tmpdir("verb-state");
    let spool = tmpdir("verb-spool");

    // 10 allows in one minute + 1 deny.
    let mut lines: Vec<String> = (0..10)
        .map(|i| allow_row(1785740912000 + i * 100, "Bash"))
        .collect();
    lines.push(deny_row());
    fs::write(store.join("current.jsonl"), lines.join("\n") + "\n").unwrap();

    run_once(&store, &state, &spool, HooksVerbosity::Decisions).await;

    let events = spooled(&spool);
    let triggered: Vec<_> = events
        .iter()
        .filter(|e| e["type"] == "hook_triggered")
        .collect();
    let completed: Vec<_> = events
        .iter()
        .filter(|e| e["type"] == "hook_completed")
        .collect();

    // The deny is a full pair; the 10 allows collapse to one aggregate leg.
    assert_eq!(
        triggered.len(),
        1,
        "only the deny should produce a trigger leg"
    );
    assert_eq!(triggered[0]["outcome"], Value::Null);
    assert_eq!(
        completed.len(),
        2,
        "one deny completion + one allow aggregate"
    );

    let agg = completed.iter().find(|e| e["outcome"] == "allow").unwrap();
    assert_eq!(
        agg["failproofai_allow_count"], 10,
        "the count is what preserves the denominator"
    );
    assert!(agg["hook_id"].as_str().unwrap().ends_with(":agg"));

    fs::remove_dir_all(&store).ok();
    fs::remove_dir_all(&state).ok();
    fs::remove_dir_all(&spool).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn all_verbosity_emits_a_pair_for_every_row() {
    let store = tmpdir("all-store");
    let state = tmpdir("all-state");
    let spool = tmpdir("all-spool");

    let lines: Vec<String> = (0..5)
        .map(|i| allow_row(1785740912000 + i * 100, "Bash"))
        .collect();
    fs::write(store.join("current.jsonl"), lines.join("\n") + "\n").unwrap();

    run_once(&store, &state, &spool, HooksVerbosity::All).await;

    let events = spooled(&spool);
    assert_eq!(
        events.len(),
        10,
        "5 rows should yield 5 pairs, got {}",
        events.len()
    );

    fs::remove_dir_all(&store).ok();
    fs::remove_dir_all(&state).ok();
    fs::remove_dir_all(&spool).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_pass_ships_nothing_new() {
    // The cursor is the whole point: without it every poll re-ships the entire
    // 800-file store every five seconds.
    let store = tmpdir("resume-store");
    let state = tmpdir("resume-state");
    let spool = tmpdir("resume-spool");
    fs::write(store.join("current.jsonl"), deny_row() + "\n").unwrap();

    run_once(&store, &state, &spool, HooksVerbosity::All).await;
    let first = spooled(&spool).len();
    assert_eq!(first, 2);

    for e in fs::read_dir(&spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }
    run_once(&store, &state, &spool, HooksVerbosity::All).await;
    assert_eq!(spooled(&spool).len(), 0, "a resumed pass must ship nothing");

    fs::remove_dir_all(&store).ok();
    fs::remove_dir_all(&state).ok();
    fs::remove_dir_all(&spool).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn rotation_does_not_re_ship_the_rotated_page() {
    // The store renames current.jsonl to page-*.jsonl at 25 rows. A path-keyed
    // cursor would treat the rotated page as brand new and duplicate all of it.
    let store = tmpdir("rot-store");
    let state = tmpdir("rot-state");
    let spool = tmpdir("rot-spool");

    fs::write(store.join("current.jsonl"), deny_row() + "\n").unwrap();
    run_once(&store, &state, &spool, HooksVerbosity::All).await;
    assert_eq!(spooled(&spool).len(), 2);

    for e in fs::read_dir(&spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }

    // Rotate exactly as hook-activity-store.ts does.
    fs::rename(
        store.join("current.jsonl"),
        store.join("page-1784294318708-0.jsonl"),
    )
    .unwrap();
    fs::write(store.join("current.jsonl"), "").unwrap();

    run_once(&store, &state, &spool, HooksVerbosity::All).await;
    assert_eq!(
        spooled(&spool).len(),
        0,
        "the rotated page must not be re-shipped under its new name"
    );

    fs::remove_dir_all(&store).ok();
    fs::remove_dir_all(&state).ok();
    fs::remove_dir_all(&spool).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_partially_written_final_line_is_held_back() {
    // Hook rows are appended by short-lived processes; a poll can land
    // mid-write. Half a JSON object must not be consumed, and the cursor must
    // not advance past it.
    let store = tmpdir("partial-store");
    let state = tmpdir("partial-state");
    let spool = tmpdir("partial-spool");

    let complete = deny_row();
    fs::write(
        store.join("current.jsonl"),
        format!("{complete}\n{{\"timestamp\":178574091"),
    )
    .unwrap();

    run_once(&store, &state, &spool, HooksVerbosity::All).await;
    assert_eq!(
        spooled(&spool).len(),
        2,
        "only the complete row should ship"
    );

    // Complete the truncated line; the next pass must pick it up.
    let mut full = fs::read_to_string(store.join("current.jsonl")).unwrap();
    full.truncate(complete.len() + 1);
    full.push_str(&(allow_row(1785740999999, "Read") + "\n"));
    fs::write(store.join("current.jsonl"), full).unwrap();

    for e in fs::read_dir(&spool).unwrap().filter_map(|e| e.ok()) {
        fs::remove_file(e.path()).ok();
    }
    run_once(&store, &state, &spool, HooksVerbosity::All).await;
    assert_eq!(
        spooled(&spool).len(),
        2,
        "the completed line must ship on the next pass"
    );

    fs::remove_dir_all(&store).ok();
    fs::remove_dir_all(&state).ok();
    fs::remove_dir_all(&spool).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn non_jsonl_store_files_are_ignored() {
    // current.count, stats.json and current.lock live in the same directory.
    let store = tmpdir("filter-store");
    let state = tmpdir("filter-state");
    let spool = tmpdir("filter-spool");

    fs::write(store.join("current.jsonl"), deny_row() + "\n").unwrap();
    fs::write(store.join("current.count"), "17").unwrap();
    fs::write(store.join("stats.json"), r#"{"totalEvents":19339}"#).unwrap();
    fs::write(store.join("current.lock"), "12345").unwrap();

    run_once(&store, &state, &spool, HooksVerbosity::All).await;
    assert_eq!(spooled(&spool).len(), 2, "only the .jsonl should be read");

    fs::remove_dir_all(&store).ok();
    fs::remove_dir_all(&state).ok();
    fs::remove_dir_all(&spool).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_row_does_not_stop_the_rest_of_the_file() {
    let store = tmpdir("bad-store");
    let state = tmpdir("bad-state");
    let spool = tmpdir("bad-spool");

    fs::write(
        store.join("current.jsonl"),
        format!("{{not json\n{}\n", deny_row()),
    )
    .unwrap();

    run_once(&store, &state, &spool, HooksVerbosity::All).await;
    assert_eq!(spooled(&spool).len(), 2, "the good row must still ship");

    fs::remove_dir_all(&store).ok();
    fs::remove_dir_all(&state).ok();
    fs::remove_dir_all(&spool).ok();
}

// ---------------------------------------------------------------------------
// Decision attribution
//
// These fields were added to the activity store (#632) after this source was
// written (#640), so nothing carried them across. The server reads
// `payload.policy_source` and `payload.paused` directly; without them every
// real row arrives unattributed and the guardrails view can only report that
// no policy decided anything.
// ---------------------------------------------------------------------------

/// A cloud-decided deny on a managed, currently-paused machine.
fn attributed_deny_row() -> String {
    serde_json::json!({
        "timestamp": 1785740912184i64,
        "eventType": "PreToolUse",
        "integration": "claude",
        "toolName": "Bash",
        "policyName": "cloud/org-blocks-curl@3/no-curl",
        "decision": "deny",
        "reason": "curl is blocked by your organisation",
        "durationMs": 4,
        "sessionId": "3ee9c788-8772-4f92-be0b-a80ede7ac48e",
        "cwd": "/home/sidd/work/failproofai",
        "policySource": "cloud",
        "cloudPolicyId": "org-blocks-curl",
        "cloudRevision": 3,
        "cloudGeneration": 8,
        "pausedBy": "session",
        "pauseExpiresAt": 1785742712184i64
    })
    .to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_decision_carries_its_attribution_to_the_server() {
    let store = tmpdir("attr-store");
    let state = tmpdir("attr-state");
    let spool = tmpdir("attr-spool");

    fs::write(store.join("current.jsonl"), attributed_deny_row() + "\n").unwrap();
    run_once(&store, &state, &spool, HooksVerbosity::All).await;

    let events = spooled(&spool);
    let end = events
        .iter()
        .find(|e| e["type"] == "hook_completed")
        .expect("a completed leg");

    // Exactly the keys the server's queries extract.
    assert_eq!(end["policy_source"], "cloud");
    assert_eq!(end["cloud_policy_id"], "org-blocks-curl");
    assert_eq!(end["cloud_revision"], 3);
    assert_eq!(end["cloud_generation"], 8);
    assert_eq!(end["paused"], true, "must be a bool, not a string");
    assert_eq!(end["paused_by"], "session");

    fs::remove_dir_all(&store).ok();
    fs::remove_dir_all(&state).ok();
    fs::remove_dir_all(&spool).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unattributed_row_says_so_rather_than_claiming_a_source() {
    let store = tmpdir("noattr-store");
    let state = tmpdir("noattr-state");
    let spool = tmpdir("noattr-spool");

    // The pre-attribution shape, still on disk on any machine that has not
    // rotated its store. Guessing a source for it would put a count behind a
    // rollout that did not produce it.
    fs::write(store.join("current.jsonl"), deny_row() + "\n").unwrap();
    run_once(&store, &state, &spool, HooksVerbosity::All).await;

    let events = spooled(&spool);
    let end = events
        .iter()
        .find(|e| e["type"] == "hook_completed")
        .unwrap();

    assert!(end.get("policy_source").is_none());
    assert!(end.get("cloud_policy_id").is_none());
    // `paused` is the exception: absent and false must not be distinguishable
    // to a reader counting unenforced calls.
    assert_eq!(end["paused"], false);

    fs::remove_dir_all(&store).ok();
    fs::remove_dir_all(&state).ok();
    fs::remove_dir_all(&spool).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_allow_rollup_never_mixes_two_policy_sources() {
    let store = tmpdir("mix-store");
    let state = tmpdir("mix-state");
    let spool = tmpdir("mix-spool");

    // Same session, event, tool and minute — everything the old key grouped
    // on. Only the attribution differs, so with attribution outside the key
    // these collapse into one event whose source is wrong for half of them.
    let cloud_allow = serde_json::json!({
        "timestamp": 1785740912000i64, "eventType": "PreToolUse", "integration": "claude",
        "toolName": "Bash", "decision": "allow", "durationMs": 2,
        "sessionId": "s1", "cwd": "/w", "policySource": "cloud",
        "cloudPolicyId": "org-guard", "cloudRevision": 2, "cloudGeneration": 8
    })
    .to_string();
    let plain_allow = serde_json::json!({
        "timestamp": 1785740912100i64, "eventType": "PreToolUse", "integration": "claude",
        "toolName": "Bash", "decision": "allow", "durationMs": 2,
        "sessionId": "s1", "cwd": "/w"
    })
    .to_string();

    fs::write(
        store.join("current.jsonl"),
        format!("{cloud_allow}\n{plain_allow}\n"),
    )
    .unwrap();
    run_once(&store, &state, &spool, HooksVerbosity::Decisions).await;

    let events = spooled(&spool);
    assert_eq!(events.len(), 2, "one bucket per source, not one merged");

    let cloud = events
        .iter()
        .find(|e| e["policy_source"] == "cloud")
        .expect("the cloud-decided allow keeps its source");
    assert_eq!(cloud["failproofai_allow_count"], 1);

    let plain = events
        .iter()
        .find(|e| e.get("policy_source").is_none())
        .expect("the unattributed allow stays unattributed");
    assert_eq!(plain["failproofai_allow_count"], 1);

    // …and they must reach the server as two rows, not one.
    //
    // Splitting the bucket is only half the job. Per `transform.rs`'s own
    // header, the server pairs legs on `hook_id` and dedups on a content hash,
    // so two events carrying the SAME id collapse back into one row in the
    // product — undoing this split downstream, silently, in exactly the two
    // cases it exists for: the minute a pause starts, and the minute a cloud
    // generation flips during a rollout. The aggregate id was built from
    // session/minute/event/tool only, all four of which are identical here by
    // construction, so both events shipped with byte-identical ids and this
    // test passed anyway.
    assert_ne!(
        cloud["hook_id"], plain["hook_id"],
        "two buckets the key split apart must not share a hook_id"
    );

    fs::remove_dir_all(&store).ok();
    fs::remove_dir_all(&state).ok();
    fs::remove_dir_all(&spool).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_observed_verdict_survives_the_allow_rollup() {
    let store = tmpdir("obs-store");
    let state = tmpdir("obs-state");
    let spool = tmpdir("obs-spool");

    // Observe mode evaluates a policy and DISCARDS the verdict, so the row is
    // an allow. Rolled up with the other allows, the would-be verdict — the
    // only thing a trial produces — disappears into a count.
    let observed = serde_json::json!({
        "timestamp": 1785740912000i64, "eventType": "PreToolUse", "integration": "claude",
        "toolName": "Bash", "decision": "allow", "durationMs": 3,
        "sessionId": "s1", "cwd": "/w", "cloudGeneration": 8,
        "observed": [{"policyId": "org-trials-git-push", "revision": 1, "decision": "deny"}]
    })
    .to_string();
    let ordinary = serde_json::json!({
        "timestamp": 1785740912100i64, "eventType": "PreToolUse", "integration": "claude",
        "toolName": "Bash", "decision": "allow", "durationMs": 1,
        "sessionId": "s1", "cwd": "/w", "cloudGeneration": 8
    })
    .to_string();

    fs::write(
        store.join("current.jsonl"),
        format!("{observed}\n{ordinary}\n"),
    )
    .unwrap();
    run_once(&store, &state, &spool, HooksVerbosity::Decisions).await;

    let events = spooled(&spool);
    let trial = events
        .iter()
        .find(|e| e.get("failproofai_observed").is_some())
        .expect("the observed verdict must reach the server intact");
    assert_eq!(trial["failproofai_observed"][0]["decision"], "deny");
    assert_eq!(
        trial["failproofai_observed"][0]["policyId"],
        "org-trials-git-push"
    );

    // The ordinary allow still rolls up — the exemption is narrow.
    assert!(
        events
            .iter()
            .any(|e| e.get("failproofai_allow_count").is_some()),
        "non-observed allows must still aggregate"
    );

    fs::remove_dir_all(&store).ok();
    fs::remove_dir_all(&state).ok();
    fs::remove_dir_all(&spool).ok();
}
