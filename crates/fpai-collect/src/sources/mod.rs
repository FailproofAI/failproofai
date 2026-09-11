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
