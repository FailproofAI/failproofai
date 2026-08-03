//! Per-source capture. Each module owns one agent's on-disk format and turns
//! it into AgentEye events dropped into the shared spool; everything
//! downstream — spool, cursor persistence, delivery — is common.

pub mod claude;
pub mod hooks;
