//! Session-log and hook-activity collection for `failproofaid`.
//!
//! This crate is deliberately separate from `failproofaid` rather than a
//! module inside it. The daemon crate gates every tool call on the machine
//! (its CLI fails closed on an unreachable daemon), so it is kept small and
//! its tests kept fast; collection is a much larger body of code with a much
//! lower blast radius, and it should be buildable and testable without
//! standing up a socket server at all.
//!
//! The only thing the daemon needs from here is
//! [`supervisor::spawn_supervised`], which hands back a handle it joins during
//! shutdown. Everything else is internal.

pub mod config;
pub mod cursor;
pub mod delivery;
pub mod sources;
pub mod spool;
pub mod supervisor;
pub mod uploader;

pub use config::{CollectorConfig, DEFAULT_INGEST_URL, HooksVerbosity, Ingest, Redact, Settings};
pub use delivery::Delivery;
pub use spool::SpoolWriter;
pub use supervisor::{
    CollectorHandle, DEFAULT_FLUSH_BUDGET, Shutdown, SupervisorMetrics, TaskError, TaskSpec,
    spawn_supervised,
};
pub use uploader::{UploadError, UploadMetrics, Uploader};
