//! Per-source capture. Each module owns one agent's on-disk format and turns
//! it into AgentEye events dropped into the shared spool; everything
//! downstream — spool, cursor persistence, redaction, delivery — is common.
//!
//! Sources fall into three shapes:
//!
//! * **File tailers** ([`crate::filetail`]) — claude, codex, copilot, legacy
//!   openclaw, pi, factory, antigravity. Each supplies a `Format` table of pure
//!   functions.
//! * **SQLite pollers** ([`crate::sqlitepoll`]) — goose, opencode, hermes,
//!   devin. Each supplies a `SqliteFormat` and declares how its database orders
//!   changes.
//! * **OpenClaw SQLite** — 2026.9.2+ uses one database per agent and per-session
//!   sequence/rewrite cursors, so it has a specialised poller beside its legacy
//!   file adapter.
//! * **The hook stream** ([`hooks`]) — CLI-agnostic, and the one capability
//!   that comes from failproofai sitting in the hook path rather than reading
//!   somebody else's files.

pub mod antigravity;
pub mod claude;
pub mod codex;
pub mod copilot;
pub mod cursor;
pub mod devin;
pub mod factory;
pub mod goose;
pub mod hermes;
pub mod hooks;
pub mod openclaw;
pub mod opencode;
pub mod pi;

use serde_json::{Map, Value, json};

/// The `human_input` twin of a prompt a person typed.
///
/// Every harness writes whatever reached the model as `role: user` — cron
/// wrappers, injected instructions, sub-agent hand-offs and the human's own
/// words alike — and each source keeps emitting all of that as `model_request`,
/// untouched. This event is emitted IN ADDITION, only for a line the harness's
/// own record says a human wrote, so "what did the person say" is a query on
/// one event type rather than a per-harness guess made downstream.
///
/// `envelope` is the source's own `base(…)` at block index 1: same session,
/// agent and line/row id as the prompt's `model_request` at index 0, so the two
/// events differ in type and body and never dedup into one — and the
/// `model_request` keeps the exact bytes it had before this event existed.
pub fn human_input(mut envelope: Map<String, Value>, input_id: &str, text: &str) -> Value {
    envelope.insert("input_id".into(), json!(input_id));
    envelope.insert("response".into(), json!(text));
    Value::Object(envelope)
}
