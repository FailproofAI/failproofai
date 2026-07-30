//! Canonicalization for `failproofaid`, driven entirely by generated data.
//!
//! Twelve vendor CLIs each name their events, their tools, and their tool-input
//! keys differently. `src/hooks/types.ts` is the single source of truth for all
//! of it — every entry annotated with the vendor version it was verified live
//! against — and `scripts/gen-canon-tables.ts` projects it into
//! `crates/generated/canonicalization-tables.json`, which this crate embeds at
//! compile time.
//!
//! **There is deliberately no hand-written table in this crate.** A second copy
//! of a twelve-CLI mapping is a second thing to keep in sync, and the failure
//! mode of drift here is not a crash — it is a policy that silently stops
//! matching because a tool arrived under a name nothing recognises. The
//! TypeScript side keeps its annotations where reviewers already look, a CI
//! drift gate re-runs the generator and fails on any diff, and Rust reads the
//! output.
//!
//! ## The failure-mode encoder
//!
//! One thing in this crate *is* a second implementation, and the plan names it
//! as such: a minimal response encoder covering one row per `(cli, event)`,
//! used only when the sealed worker is circuit-broken and cannot answer. It is
//! not a reimplementation of `policy-evaluator.ts`'s full matrix — it produces
//! only the configured failure-mode response, which is a far smaller and far
//! more stable surface than the deny/instruct/allow encodings.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The generated tables, embedded at compile time.
///
/// `include_str!` rather than a runtime read: the daemon must not resolve
/// anything through a mutable path at evaluation time, and a table read from
/// disk at startup is a table an attacker with write access to `/var/lib` could
/// swap. Compiling it in makes the tables part of the signed artifact.
const CANON_JSON: &str = include_str!("../../generated/canonicalization-tables.json");
const CAPABILITY_JSON: &str = include_str!("../../generated/enforcement-capability.json");

/// The schema version this crate understands.
///
/// A mismatch is a hard failure at load, not a best-effort parse. The tables and
/// the code that reads them ship together, so a mismatch means something was
/// rebuilt without the other — exactly the situation where guessing is worst.
pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
pub struct CanonTables {
    pub schema_version: u32,
    pub canonical_event_types: Vec<String>,
    pub canonical_tool_names: Vec<String>,
    pub clis: BTreeMap<String, CliTable>,
    #[serde(default)]
    pub generated_from: String,
    #[serde(default)]
    pub regenerate_with: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CliTable {
    /// Vendor event name -> canonical `HookEventType`.
    #[serde(default)]
    pub event_map: BTreeMap<String, String>,
    /// The vendor's own event names, in the order `types.ts` declares them.
    #[serde(default)]
    pub event_types: Vec<String>,
    /// Vendor tool name -> canonical tool name.
    #[serde(default)]
    pub tool_map: BTreeMap<String, String>,
    /// Canonical tool name -> (vendor input key -> canonical input key).
    #[serde(default)]
    pub tool_input_map: BTreeMap<String, BTreeMap<String, String>>,
    /// Per-CLI payload field renames applied before anything else.
    #[serde(default)]
    pub payload_normalizations: Vec<Normalization>,
    /// Canonical events this CLI can actually deliver.
    #[serde(default)]
    pub reachable_canonical_events: Vec<String>,
    /// Vendor events with no canonical counterpart — a hook we install that no
    /// policy can subscribe to. Recorded rather than silently dropped.
    #[serde(default)]
    pub unmapped_event_types: Vec<String>,
}

/// A payload field rename, expressed as data rather than as a code branch.
///
/// These come from `handler.ts`'s per-CLI normalization blocks — Antigravity's
/// camelCase protojson, Copilot's `permissionRequest`, Goose's `working_dir`.
/// They are part of canonicalization: a daemon that skips one produces a
/// *different verdict*, because e.g. `block-read-outside-cwd` loses the cwd it
/// enforces against.
/// One step of a payload path.
///
/// Paths are not uniformly object keys: Antigravity delivers the working
/// directory as `workspacePaths[0]`, which the generator emits as
/// `["workspacePaths", 0]`. Modelling the index as a number rather than
/// stringifying it keeps the distinction between the key `"0"` and the first
/// element of an array, which are different things in JSON and would silently
/// diverge on a payload that had both.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum PathSegment {
    Key(String),
    Index(usize),
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Normalization {
    /// Path into the payload, outermost first (`["toolCall", "name"]`).
    pub from: Vec<PathSegment>,
    /// Canonical top-level key to write.
    pub to: String,
    /// Type the source value must have for the rename to apply.
    pub require_type: RequireType,
    /// When the rename applies relative to the target's current state.
    pub when: When,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequireType {
    String,
    Defined,
    NonEmptyString,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum When {
    /// Overwrite unconditionally.
    Always,
    /// Only when the canonical key is absent.
    TargetUndefined,
    /// Only when the canonical key is absent or empty.
    TargetMissingOrEmpty,
}

/// What a given CLI does with a decision on a given event.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// The vendor honours a deny; enforcement is real.
    Block,
    /// The hook fires but the vendor ignores any decision.
    Observe,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CapabilityTables {
    pub schema_version: u32,
    pub clis: BTreeMap<String, CliCapability>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CliCapability {
    #[serde(default)]
    pub capabilities: BTreeMap<String, Capability>,
    /// Events deliberately left unverified — reported, never assumed to block.
    #[serde(default)]
    pub unverified_events: Vec<String>,
}

#[derive(Debug)]
pub enum CanonError {
    UnsupportedSchema { found: u32, supported: u32 },
    Parse(serde_json::Error),
    UnknownCli(String),
}

impl std::fmt::Display for CanonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedSchema { found, supported } => write!(
                f,
                "canonicalization tables declare schema_version {found}, this build understands \
                 {supported}. The tables and the daemon ship together; regenerate with \
                 `bun scripts/gen-canon-tables.ts` and rebuild."
            ),
            Self::Parse(e) => write!(f, "failed to parse generated canonicalization tables: {e}"),
            Self::UnknownCli(cli) => write!(
                f,
                "unknown CLI '{cli}'. It must be a member of INTEGRATION_TYPES in \
                 src/hooks/types.ts and present in the generated tables."
            ),
        }
    }
}

impl std::error::Error for CanonError {}

/// Load and validate the embedded tables.
pub fn load() -> Result<(CanonTables, CapabilityTables), CanonError> {
    let canon: CanonTables = serde_json::from_str(CANON_JSON).map_err(CanonError::Parse)?;
    if canon.schema_version != SUPPORTED_SCHEMA_VERSION {
        return Err(CanonError::UnsupportedSchema {
            found: canon.schema_version,
            supported: SUPPORTED_SCHEMA_VERSION,
        });
    }
    let caps: CapabilityTables =
        serde_json::from_str(CAPABILITY_JSON).map_err(CanonError::Parse)?;
    if caps.schema_version != SUPPORTED_SCHEMA_VERSION {
        return Err(CanonError::UnsupportedSchema {
            found: caps.schema_version,
            supported: SUPPORTED_SCHEMA_VERSION,
        });
    }
    Ok((canon, caps))
}

impl CanonTables {
    pub fn cli(&self, cli: &str) -> Result<&CliTable, CanonError> {
        self.clis
            .get(cli)
            .ok_or_else(|| CanonError::UnknownCli(cli.to_string()))
    }

    /// Vendor event name -> canonical `HookEventType`.
    ///
    /// Returns `None` for a vendor event with no canonical counterpart —
    /// Copilot's `ErrorOccurred` is the live example. Passing it through
    /// unchanged would let it masquerade as a canonical event that policies can
    /// match on, so it is refused rather than guessed.
    pub fn canonical_event(&self, cli: &str, raw: &str) -> Result<Option<&str>, CanonError> {
        Ok(self.cli(cli)?.event_map.get(raw).map(String::as_str))
    }

    /// Vendor tool name -> canonical tool name.
    ///
    /// Unknown tools pass through unchanged, matching
    /// `tool-name-canonicalize.ts`. That is deliberate: a vendor adding a tool
    /// should not make every policy stop matching, and a policy keyed on an
    /// unrecognised name simply does not fire.
    pub fn canonical_tool<'a>(&'a self, cli: &str, raw: &'a str) -> Result<&'a str, CanonError> {
        Ok(self
            .cli(cli)?
            .tool_map
            .get(raw)
            .map(String::as_str)
            .unwrap_or(raw))
    }

    /// Vendor input key -> canonical input key, for one canonical tool.
    pub fn canonical_input_key<'a>(
        &'a self,
        cli: &str,
        canonical_tool: &str,
        raw_key: &'a str,
    ) -> Result<&'a str, CanonError> {
        Ok(self
            .cli(cli)?
            .tool_input_map
            .get(canonical_tool)
            .and_then(|m| m.get(raw_key))
            .map(String::as_str)
            .unwrap_or(raw_key))
    }

    /// Apply a CLI's payload normalizations, then canonicalize tool name and
    /// tool-input keys, in the order `pipeline` declares.
    ///
    /// Mirrors `handler.ts` step for step. The daemon re-derives this rather
    /// than trusting the client's canonicalization, and a disagreement is a
    /// `canonicalization_mismatch` protocol error — see `crates/PROTOCOL.md`.
    pub fn canonicalize_payload(
        &self,
        cli: &str,
        payload: &mut serde_json::Value,
    ) -> Result<(), CanonError> {
        let table = self.cli(cli)?;

        for rule in &table.payload_normalizations {
            apply_normalization(payload, rule);
        }

        let Some(obj) = payload.as_object_mut() else {
            return Ok(());
        };

        // Tool name, in place, so the registry filter and policy bodies agree.
        let raw_tool = obj
            .get("tool_name")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let canonical_tool = match raw_tool {
            Some(raw) => {
                let canonical = self.canonical_tool(cli, &raw)?.to_owned();
                if canonical != raw {
                    obj.insert(
                        "tool_name".into(),
                        serde_json::Value::String(canonical.clone()),
                    );
                }
                Some(canonical)
            }
            None => None,
        };

        // Tool-input keys, keyed by the CANONICAL tool name.
        if let (Some(tool), Some(serde_json::Value::Object(input))) =
            (canonical_tool.as_deref(), obj.get_mut("tool_input"))
            && let Some(key_map) = table.tool_input_map.get(tool)
        {
            // Collected first: renaming while iterating the map would be a
            // borrow conflict, and a `from` key that is also some other rule's
            // `to` must not be re-renamed in the same pass.
            let renames: Vec<(String, String)> = key_map
                .iter()
                .filter(|(from, _)| input.contains_key(*from))
                .map(|(from, to)| (from.clone(), to.clone()))
                .collect();
            for (from, to) in renames {
                if let Some(value) = input.remove(&from) {
                    input.insert(to, value);
                }
            }
        }

        Ok(())
    }
}

fn apply_normalization(payload: &mut serde_json::Value, rule: &Normalization) {
    if !payload.is_object() {
        return;
    }

    // Walk `from` as a path into the payload. Borrowing throughout — the
    // mutable borrow is only taken once the value to write has been cloned out.
    let mut cursor: &serde_json::Value = payload;
    for segment in &rule.from {
        let next = match segment {
            PathSegment::Key(k) => cursor.get(k.as_str()),
            PathSegment::Index(i) => cursor.get(*i),
        };
        match next {
            Some(v) => cursor = v,
            None => return,
        }
    }

    let matches_type = match rule.require_type {
        RequireType::String => cursor.is_string(),
        RequireType::Defined => !cursor.is_null(),
        RequireType::NonEmptyString => cursor.as_str().is_some_and(|s| !s.is_empty()),
    };
    if !matches_type {
        return;
    }
    let value = cursor.clone();

    let Some(obj) = payload.as_object_mut() else {
        return;
    };
    let should_write = match rule.when {
        When::Always => true,
        When::TargetUndefined => !obj.contains_key(&rule.to),
        When::TargetMissingOrEmpty => obj
            .get(&rule.to)
            .is_none_or(|v| v.as_str().is_some_and(str::is_empty) || v.is_null()),
    };
    if should_write {
        obj.insert(rule.to.clone(), value);
    }
}

impl CapabilityTables {
    /// What this CLI does with a decision on this canonical event.
    ///
    /// `None` means **not verified**, and callers must never read that as
    /// "blocks". Reporting a deny as enforced when the harness actually ignores
    /// that event is the single most misleading thing this system could do.
    pub fn capability(&self, cli: &str, event: &str) -> Option<Capability> {
        self.clis.get(cli)?.capabilities.get(event).copied()
    }

    /// Whether a deny on this `(cli, event)` is genuinely enforced.
    pub fn enforces(&self, cli: &str, event: &str) -> bool {
        matches!(self.capability(cli, event), Some(Capability::Block))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tables() -> (CanonTables, CapabilityTables) {
        load().expect("embedded tables must load")
    }

    #[test]
    fn embedded_tables_load_and_declare_the_supported_schema() {
        let (canon, caps) = tables();
        assert_eq!(canon.schema_version, SUPPORTED_SCHEMA_VERSION);
        assert_eq!(caps.schema_version, SUPPORTED_SCHEMA_VERSION);
        assert!(!canon.clis.is_empty());
    }

    #[test]
    fn every_event_map_is_total_over_its_own_event_types() {
        // The property the plan's L0 layer names: "every per-CLI event map is
        // total over HOOK_EVENT_TYPES". Stated precisely, a CLI's map must
        // cover its OWN declared vendor events, and every value must be a
        // canonical event. A gap here means a real hook fires and reaches
        // nothing.
        let (canon, _) = tables();
        let canonical: std::collections::BTreeSet<&str> = canon
            .canonical_event_types
            .iter()
            .map(String::as_str)
            .collect();

        for (cli, table) in &canon.clis {
            for raw in &table.event_types {
                if table.unmapped_event_types.contains(raw) {
                    continue; // recorded as having no canonical counterpart
                }
                let mapped = table
                    .event_map
                    .get(raw)
                    .unwrap_or_else(|| panic!("{cli}: event '{raw}' has no mapping"));
                assert!(
                    canonical.contains(mapped.as_str()),
                    "{cli}: event '{raw}' maps to '{mapped}', which is not a canonical event type",
                );
            }
        }
    }

    #[test]
    fn unknown_cli_is_an_error_not_a_default() {
        let (canon, _) = tables();
        assert!(matches!(
            canon.canonical_event("not-a-cli", "PreToolUse"),
            Err(CanonError::UnknownCli(_))
        ));
    }

    #[test]
    fn goose_tool_names_and_input_keys_canonicalize() {
        // Goose is the useful case: it has both a tool map and a tool-input
        // map, and its `path` -> `file_path` rename is what makes the path
        // builtins fire at all.
        let (canon, _) = tables();
        assert_eq!(canon.canonical_tool("goose", "shell").unwrap(), "Bash");
        assert_eq!(canon.canonical_tool("goose", "view").unwrap(), "Read");
        assert_eq!(
            canon.canonical_input_key("goose", "Read", "path").unwrap(),
            "file_path"
        );
    }

    #[test]
    fn unknown_tools_pass_through_rather_than_erroring() {
        let (canon, _) = tables();
        assert_eq!(
            canon.canonical_tool("goose", "some_new_tool").unwrap(),
            "some_new_tool"
        );
    }

    #[test]
    fn goose_working_dir_normalizes_to_cwd() {
        let (canon, _) = tables();
        let mut payload = serde_json::json!({
            "working_dir": "/home/u/project",
            "tool_name": "shell",
            "tool_input": { "command": "ls" }
        });
        canon.canonicalize_payload("goose", &mut payload).unwrap();
        assert_eq!(payload["cwd"], "/home/u/project");
        assert_eq!(payload["tool_name"], "Bash");
    }

    #[test]
    fn goose_read_path_becomes_file_path() {
        let (canon, _) = tables();
        let mut payload = serde_json::json!({
            "tool_name": "view",
            "tool_input": { "path": "/etc/passwd" }
        });
        canon.canonicalize_payload("goose", &mut payload).unwrap();
        assert_eq!(payload["tool_name"], "Read");
        assert_eq!(payload["tool_input"]["file_path"], "/etc/passwd");
        assert!(payload["tool_input"].get("path").is_none());
    }

    #[test]
    fn target_undefined_does_not_overwrite_an_existing_value() {
        let (canon, _) = tables();
        // Goose's `event` -> `hook_event_name` rule is `when: target_undefined`.
        let mut payload = serde_json::json!({
            "event": "PreToolUse",
            "hook_event_name": "AlreadySet"
        });
        canon.canonicalize_payload("goose", &mut payload).unwrap();
        assert_eq!(payload["hook_event_name"], "AlreadySet");
    }

    #[test]
    fn canonicalization_is_idempotent() {
        // The daemon re-derives canonicalization on a payload the client has
        // already canonicalized, so applying it twice must be a no-op.
        // Otherwise every request would look like a mismatch.
        let (canon, _) = tables();
        for cli in canon.clis.keys() {
            let mut once = serde_json::json!({
                "tool_name": "shell",
                "tool_input": { "path": "/x", "command": "ls" },
                "working_dir": "/home/u"
            });
            canon.canonicalize_payload(cli, &mut once).unwrap();
            let mut twice = once.clone();
            canon.canonicalize_payload(cli, &mut twice).unwrap();
            assert_eq!(once, twice, "{cli}: canonicalization is not idempotent");
        }
    }

    #[test]
    fn an_unverified_capability_is_never_reported_as_blocking() {
        let (_, caps) = tables();
        for (cli, entry) in &caps.clis {
            for event in &entry.unverified_events {
                assert!(
                    !caps.enforces(cli, event),
                    "{cli}/{event} is listed unverified but enforces() said it blocks",
                );
            }
        }
    }

    #[test]
    fn capability_tables_cover_every_cli_in_the_canon_tables() {
        let (canon, caps) = tables();
        for cli in canon.clis.keys() {
            assert!(
                caps.clis.contains_key(cli),
                "{cli} has canonicalization data but no enforcement-capability entry",
            );
        }
    }
}
