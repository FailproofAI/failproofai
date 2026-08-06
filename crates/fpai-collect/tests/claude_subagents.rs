//! Claude subagent transcripts: file identity, the parent link, and the
//! disjointness the two `Format`s rest on.
//!
//! Path shapes and record shapes are verbatim from the 124 files under
//! `~/.claude/projects/**/subagents/` (Claude Code 2.1.220).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::filetail::{self, Ctx, Params, RereadPolicy, Spec};
use fpai_collect::sources::claude;
use fpai_collect::supervisor::Shutdown;
use serde_json::{Value, json};

/// A real parent session id, and a real 17-hex agent id.
const PARENT: &str = "3ee9c788-8772-4f92-be0b-a80ede7ac48e";
const AGENT: &str = "a5a59824a02ebc510";

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-clsub-{}-{}-{}",
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

/// `projects/<slug>/<parent>/subagents/`.
fn flat(root: &Path) -> PathBuf {
    root.join("-home-u-repo").join(PARENT).join("subagents")
}

/// `projects/<slug>/<parent>/subagents/workflows/wf_<id>/` — the same tree with
/// two extra levels inserted.
fn workflow(root: &Path) -> PathBuf {
    flat(root).join("workflows").join("wf_ca1e341f-c30")
}

fn ctx() -> Ctx {
    Ctx {
        session_id: format!("{PARENT}:{AGENT}"),
        agent_id: "claude-Explore".into(),
        environment: "local".into(),

        ..Default::default()
    }
}

/// The first line of a real subagent transcript: a genuine timestamped `user`
/// turn carrying the PARENT's `sessionId` and its own `agentId`.
fn sub_prompt(ts: &str, text: &str) -> String {
    json!({"parentUuid":null,"isSidechain":true,"agentId":AGENT,"type":"user",
      "uuid":"669bdae5-3111-4d87-bb17-f18874e96232","timestamp":ts,
      "cwd":"/home/u/repo","sessionId":PARENT,"version":"2.1.220",
      "gitBranch":"feat/collector",
      "message":{"role":"user","content":text}})
    .to_string()
}

fn sub_tool_use(ts: &str, call_id: &str, name: &str) -> String {
    json!({"isSidechain":true,"agentId":AGENT,"type":"assistant","timestamp":ts,
      "attributionAgent":"Explore","sessionId":PARENT,
      "message":{"model":"claude-opus-4-8","id":"msg_01","role":"assistant",
        "content":[{"type":"tool_use","id":call_id,"name":name,"input":{"command":"ls"}}],
        "usage":{"input_tokens":2,"output_tokens":91}}})
    .to_string()
}

// ── file identity ────────────────────────────────────────────────────────

#[test]
fn a_subagent_transcript_is_claimed_in_both_the_flat_and_workflow_layouts() {
    // The workflow layout inserts `workflows/wf_<id>/` between `subagents/` and
    // the file. Anchoring on a depth count instead of the literal component
    // would be confidently wrong on exactly one of the two shapes.
    let root = Path::new("/p");
    let is = claude::SUBAGENT_FORMAT.is_source_file;
    assert!(is(&flat(root).join(format!("agent-{AGENT}.jsonl"))));
    assert!(is(&workflow(root).join(format!("agent-{AGENT}.jsonl"))));
}

#[test]
fn the_subagent_format_rejects_its_siblings() {
    let root = Path::new("/p");
    let is = claude::SUBAGENT_FORMAT.is_source_file;
    // A different schema entirely (`{type, key, agentId}`, no timestamps) that
    // lives in both layouts. Tailing it would invent a session out of nothing.
    assert!(!is(&flat(root).join("journal.jsonl")));
    assert!(!is(&workflow(root).join("journal.jsonl")));
    // The sidecar this format READS for the agent type; it is rewritten and is
    // not a transcript.
    assert!(!is(&flat(root).join(format!("agent-{AGENT}.meta.json"))));
    // An empty agent id would key a session on nothing.
    assert!(!is(&flat(root).join("agent-.jsonl")));
    // `agent-*.jsonl` outside the tree is not ours.
    assert!(!is(&root.join("-home-u-repo").join("agent-x.jsonl")));
}

#[test]
fn the_two_claude_formats_are_disjoint_over_every_path_in_the_tree() {
    // If both claimed one file it would be tailed twice and every line would
    // ship under two different session ids — silently doubling a session's
    // token totals and its tool-call counts.
    let root = Path::new("/p");
    let proj = root.join("-home-u-repo");
    let paths = [
        proj.join(format!("{PARENT}.jsonl")),
        proj.join(format!("{PARENT}.jsonl.tool-calls.json")),
        proj.join("journal.jsonl"),
        flat(root).join(format!("agent-{AGENT}.jsonl")),
        flat(root).join(format!("agent-{AGENT}.meta.json")),
        flat(root).join("journal.jsonl"),
        workflow(root).join(format!("agent-{AGENT}.jsonl")),
        workflow(root).join("journal.jsonl"),
        proj.join("notes.txt"),
    ];
    for p in paths {
        let main = (claude::FORMAT.is_source_file)(&p);
        let sub = (claude::SUBAGENT_FORMAT.is_source_file)(&p);
        assert!(!(main && sub), "both formats claim {}", p.display());
    }
}

#[test]
fn a_subagent_becomes_a_child_session_keyed_on_its_parent_and_its_agent_id() {
    let root = Path::new("/p");
    let expected = format!("{PARENT}:{AGENT}");
    let id = claude::SUBAGENT_FORMAT.session_id_from_path;
    assert_eq!(
        id(&flat(root).join(format!("agent-{AGENT}.jsonl"))).as_deref(),
        Some(expected.as_str())
    );
    // The workflow layout carries the SAME parent id, two levels deeper. The
    // parent is the directory containing `subagents/`, never a fixed depth.
    assert_eq!(
        id(&workflow(root).join(format!("agent-{AGENT}.jsonl"))).as_deref(),
        Some(expected.as_str())
    );
}

#[test]
fn a_layout_with_no_subagents_component_yields_none_rather_than_a_guess() {
    // `None` routes to the engine's synthetic dev+inode id and a warning, which
    // is recoverable. A guessed parent would file a subagent's turns under some
    // other session, which is not.
    let id = claude::SUBAGENT_FORMAT.session_id_from_path;
    assert_eq!(id(Path::new("/p/proj/agent-abc.jsonl")), None);
    assert_eq!(id(Path::new("/p/proj/subagents/journal.jsonl")), None);
}

// ── agent type ───────────────────────────────────────────────────────────

#[test]
fn the_agent_type_comes_from_the_sidecar_because_it_is_on_no_transcript_line() {
    // `agentType` appears zero times in the transcripts themselves; the
    // `.meta.json` sidecar is the only place it is written as such.
    let dir = tmpdir("sidecar");
    let subs = flat(&dir);
    fs::create_dir_all(&subs).unwrap();
    let transcript = subs.join(format!("agent-{AGENT}.jsonl"));
    fs::write(&transcript, b"").unwrap();
    fs::write(
        subs.join(format!("agent-{AGENT}.meta.json")),
        br#"{"agentType":"Explore","description":"Map the daemon","spawnDepth":1}"#,
    )
    .unwrap();

    let derived = (claude::SUBAGENT_FORMAT.agent_id_from_path)(&transcript, &[]);
    assert_eq!(derived.as_deref(), Some("claude-Explore"));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_sidecar_wins_over_the_in_file_field_because_it_has_no_startup_window() {
    // Ordering is load-bearing: `agent_id` is frozen onto the cursor at
    // discovery and a subagent's `agent_start` resolves on byte 0, while
    // `attributionAgent` is not written until line 3-4. A file discovered one
    // line in would otherwise freeze the fallback onto every event.
    let dir = tmpdir("sidecar-wins");
    let subs = flat(&dir);
    fs::create_dir_all(&subs).unwrap();
    let transcript = subs.join(format!("agent-{AGENT}.jsonl"));
    fs::write(&transcript, b"").unwrap();
    fs::write(
        subs.join(format!("agent-{AGENT}.meta.json")),
        br#"{"agentType":"Explore"}"#,
    )
    .unwrap();
    let header = vec![r#"{"type":"assistant","attributionAgent":"general-purpose"}"#.to_string()];
    assert_eq!(
        (claude::SUBAGENT_FORMAT.agent_id_from_path)(&transcript, &header).as_deref(),
        Some("claude-Explore")
    );

    // A malformed sidecar degrades to the in-file field rather than failing
    // capture — the two agreed in 122 of 122 measured, so it is a real answer.
    fs::write(subs.join(format!("agent-{AGENT}.meta.json")), b"{not json").unwrap();
    assert_eq!(
        (claude::SUBAGENT_FORMAT.agent_id_from_path)(&transcript, &header).as_deref(),
        Some("claude-general-purpose")
    );

    // Neither available: `None` hands the engine its configured default, so an
    // unnameable subagent is still captured.
    assert_eq!(
        (claude::SUBAGENT_FORMAT.agent_id_from_path)(&transcript, &[]),
        None
    );
    fs::remove_dir_all(&dir).ok();
}

// ── the parent link ──────────────────────────────────────────────────────

#[test]
fn the_start_event_names_the_parent_without_ever_saying_parent_id() {
    // ⚠️ The dashboard matches `parent_id` against an AGENT id, not a session
    // id — so putting a session UUID there resolves to nothing and silently
    // mis-links every subagent. These two names are the contract.
    let header = vec![sub_prompt("2026-07-18T09:42:04.058Z", "map the daemon")];
    let (ev, ts) = (claude::SUBAGENT_FORMAT.agent_start)(&header, &ctx(), 0).unwrap();
    assert_eq!(ev["type"], "agent_start");
    assert_eq!(ts.as_deref(), Some("2026-07-18T09:42:04.058Z"));
    assert_eq!(ev["claude_parent_session_id"], PARENT);
    assert_eq!(ev["claude_agent_id"], AGENT);
    assert!(
        ev.get("parent_id").is_none(),
        "parent_id would be matched against an agent_id and resolve to nothing"
    );
    // A subagent's first line IS its task prompt, so the goal resolves at once.
    assert_eq!(ev["goal"], "map the daemon");
    assert_eq!(ev["session_id"], format!("{PARENT}:{AGENT}"));
}

#[test]
fn a_main_session_start_carries_no_parent_link() {
    // The two formats share `transform::agent_start`; only the subagent wrapper
    // may add the link, or a top-level session would claim a parent.
    let header = vec![
        r#"{"type":"user","timestamp":"2026-07-18T09:42:04.058Z","cwd":"/home/u/repo",
                 "message":{"role":"user","content":"hi"}}"#
            .to_string(),
    ];
    let main_ctx = Ctx {
        session_id: PARENT.into(),
        agent_id: "claude-repo".into(),
        environment: "local".into(),

        ..Default::default()
    };
    let (ev, _) = (claude::FORMAT.agent_start)(&header, &main_ctx, 0).unwrap();
    assert!(ev.get("claude_parent_session_id").is_none());
    assert!(ev.get("claude_agent_id").is_none());
}

// ── engine ───────────────────────────────────────────────────────────────

fn spec(root: PathBuf, spool: PathBuf, state: PathBuf) -> Spec {
    Spec {
        format: claude::SUBAGENT_FORMAT,
        roots: vec![root],
        spool_dir: spool,
        state_dir: state,
        poll_interval: Duration::from_millis(200),
        params: Params {
            redact: fpai_collect::Redact::Minimal,
            agent_id: claude::SUBAGENT_DEFAULT_AGENT_ID.into(),
            environment: "local".into(),
            machine_id: None,
            user: None,
            end_idle_mins: 0,
            max_read_bytes: 8 * 1024 * 1024,
            max_batch_bytes: 8 * 1024 * 1024,
            since_days: None,
        },
    }
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

async fn run_briefly(s: Spec, ms: u64) {
    let sd = Shutdown::for_test(Arc::new(AtomicBool::new(false)));
    let _ = tokio::time::timeout(Duration::from_millis(ms), filetail::run(s, sd)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_workflow_subagent_lands_as_a_child_session_named_after_its_type() {
    let root = tmpdir("wf-root");
    let spool = tmpdir("wf-spool");
    let state = tmpdir("wf-state");

    // The deep layout, plus both decoys that share the directory.
    let dir = workflow(&root);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join(format!("agent-{AGENT}.jsonl")),
        [
            sub_prompt("2026-07-18T09:42:04.058Z", "map the daemon"),
            sub_tool_use("2026-07-18T09:42:05.000Z", "toolu_01", "Grep"),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    fs::write(
        dir.join(format!("agent-{AGENT}.meta.json")),
        br#"{"agentType":"general-purpose","spawnDepth":1}"#,
    )
    .unwrap();
    fs::write(
        dir.join("journal.jsonl"),
        b"{\"type\":\"started\",\"key\":\"v2:abc\",\"agentId\":\"aother\"}\n",
    )
    .unwrap();

    run_briefly(spec(root.clone(), spool.clone(), state.clone()), 1200).await;

    let ev = spooled(&spool);
    let types: Vec<&str> = ev.iter().filter_map(|e| e["type"].as_str()).collect();
    assert!(types.contains(&"agent_start"), "got {types:?}");
    assert!(types.contains(&"tool_use"), "got {types:?}");
    assert!(types.contains(&"agent_end"), "got {types:?}");

    let want = format!("{PARENT}:{AGENT}");
    for e in &ev {
        assert_eq!(e["session_id"], want, "one child session, not the parent's");
        assert_eq!(e["agent_id"], "claude-general-purpose");
    }
    // journal.jsonl must contribute nothing at all.
    assert!(
        ev.iter().all(|e| e["session_id"] == want),
        "journal.jsonl was tailed"
    );

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_main_format_walking_the_same_root_ignores_subagent_files() {
    // Both sources are pointed at ONE root by the daemon, so this is the live
    // arrangement: if the main format claimed these files, every subagent line
    // would ship a second time under the parent's session id.
    let root = tmpdir("shared-root");
    let spool = tmpdir("shared-spool");
    let state = tmpdir("shared-state");

    let dir = flat(&root);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join(format!("agent-{AGENT}.jsonl")),
        sub_prompt("2026-07-18T09:42:04.058Z", "sub work") + "\n",
    )
    .unwrap();

    let mut s = spec(root.clone(), spool.clone(), state.clone());
    s.format = claude::FORMAT;
    s.params.agent_id = claude::DEFAULT_AGENT_ID.into();
    run_briefly(s, 1000).await;

    assert!(
        spooled(&spool).is_empty(),
        "the main format must not claim subagent transcripts"
    );

    fs::remove_dir_all(&root).ok();
    fs::remove_dir_all(&spool).ok();
    fs::remove_dir_all(&state).ok();
}

#[test]
fn subagent_transcripts_are_byte_tailable_like_the_main_ones() {
    assert_eq!(claude::SUBAGENT_FORMAT.reread, RereadPolicy::ByteCursor);
    assert_eq!(claude::SUBAGENT_FORMAT.kind, "claude-subagent");
}
