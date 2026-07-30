//! `failproofaid` — the failproofai local enforcement plane.
//!
//! Stage 1 is a walking skeleton: the sealed policy worker, and enough of the
//! IPC surface to answer `Ping` and `EvaluateHook`. The privileged install, the
//! per-user agent, the spool, and the schema catalog land in later stages.
//!
//! See `crates/PROTOCOL.md` for the wire contract and
//! `desgin-docs/v1.0.0/phase-1-local-enforcement/03-daemon-architecture.md` for
//! what this process is eventually responsible for.

pub mod server;
pub mod worker;

pub use server::{Daemon, Lane};
pub use worker::{SealedWorker, WorkerError};
