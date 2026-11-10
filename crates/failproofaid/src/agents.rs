//! Which agent each collector source belongs to.
//!
//! `agents.selected` in `config.json` names AGENTS (`claude`, `openclaw`, …), but
//! the collector runs SOURCES, and the two are not one-to-one: Claude has a
//! subagent source beside its main one, OpenClaw a SQLite store beside its JSONL
//! tailer, and the hook-activity source belongs to no agent at all. Matching a
//! source to an agent by name would skip `claude-subagent` whenever `claude` is
//! named — and, worse, `openclaw-sqlite`, which is the store current OpenClaw
//! versions actually write.
//!
//! So there is ONE table, and both of the things that need the answer read it:
//! the collector, deciding which tasks to start, and the backfill rewind,
//! deciding which cursor stores a request reaches. Two copies would drift, and
//! the failure would be silent in both directions — an agent nobody selected
//! still being collected, or a re-added agent resuming the stale cursors its
//! request was written to forget.
//!
//! A source's name is also the name of its top-level cursor directory under
//! `~/.failproofai/cursors/`. Nested stores inherit the agent of the directory
//! they sit in: `<source>/<label>/` for an extra capture path, and
//! `hermes/<profile>/` for each Hermes profile database.

/// Who a top-level cursor directory — equivalently, a collector source — is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    /// Started only while this agent is traced.
    Agent(&'static str),
    /// Collected whatever the selection says. The hook-activity store is
    /// CLI-agnostic — every row names its own integration — so there is no
    /// agent it could be switched off with.
    Shared,
}

/// Every source the collector registers, by its top-level cursor directory.
///
/// Ordered like `HARNESS_KEYS` in `main.rs`, which is the order the agents are
/// listed in the journal. `main.rs` asserts the two name the same twelve agents,
/// and that every task the collector builds has a row here.
pub const SOURCES: &[(&str, Owner)] = &[
    ("claude", Owner::Agent("claude")),
    ("claude-subagent", Owner::Agent("claude")),
    ("codex", Owner::Agent("codex")),
    ("copilot", Owner::Agent("copilot")),
    ("openclaw", Owner::Agent("openclaw")),
    ("openclaw-sqlite", Owner::Agent("openclaw")),
    ("pi", Owner::Agent("pi")),
    ("factory", Owner::Agent("factory")),
    ("antigravity", Owner::Agent("antigravity")),
    ("cursor", Owner::Agent("cursor")),
    ("goose", Owner::Agent("goose")),
    ("opencode", Owner::Agent("opencode")),
    ("devin", Owner::Agent("devin")),
    ("hermes", Owner::Agent("hermes")),
    ("hooks", Owner::Shared),
];

/// The owner of a source / top-level cursor directory, or `None` for a name
/// this daemon does not register — a directory another daemon version left.
pub fn owner_of(source: &str) -> Option<Owner> {
    SOURCES
        .iter()
        .find(|(name, _)| *name == source)
        .map(|(_, owner)| *owner)
}

/// Every agent with at least one collector source, once each, in table order.
pub fn known_agents() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for (_, owner) in SOURCES {
        if let Owner::Agent(agent) = owner
            && !out.contains(agent)
        {
            out.push(agent);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_and_openclaw_each_own_two_sources() {
        let sources_of = |agent: &str| -> Vec<&str> {
            SOURCES
                .iter()
                .filter(|(_, owner)| matches!(owner, Owner::Agent(a) if *a == agent))
                .map(|(name, _)| *name)
                .collect()
        };
        assert_eq!(sources_of("claude"), ["claude", "claude-subagent"]);
        // The SQLite half is the store OpenClaw 2026.9.2+ actually writes; a
        // name-only match would rewind and gate just the legacy JSONL tailer.
        assert_eq!(sources_of("openclaw"), ["openclaw", "openclaw-sqlite"]);
        for one_to_one in [
            "codex",
            "copilot",
            "pi",
            "factory",
            "antigravity",
            "cursor",
            "goose",
            "opencode",
            "devin",
            "hermes",
        ] {
            assert_eq!(sources_of(one_to_one), [one_to_one]);
        }
    }

    #[test]
    fn the_hook_store_belongs_to_no_agent() {
        assert_eq!(owner_of("hooks"), Some(Owner::Shared));
        assert!(!known_agents().contains(&"hooks"));
    }

    #[test]
    fn a_directory_this_daemon_does_not_register_has_no_owner() {
        assert_eq!(owner_of("some-future-source"), None);
        let known = known_agents();
        assert!(
            !known.contains(&"claude-subagent"),
            "a source, not an agent"
        );
        assert!(
            !known.contains(&"openclaw-sqlite"),
            "a source, not an agent"
        );
        assert_eq!(known.len(), 12);
    }
}
