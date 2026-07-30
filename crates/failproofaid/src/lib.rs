//! `failproofaid` — the failproofai local enforcement plane.
//!
//! Stage 1 is a walking skeleton: the sealed policy worker, and enough of the
//! IPC surface to answer `Ping` and `EvaluateHook`. The spool and the schema
//! catalog land in later stages.
//!
//! ## Scope
//!
//! v1.0.0 ships **user scope only** — a deliberate simplification for this
//! version. The daemon runs as the invoking user, keeps its state in
//! `~/.failproofai/` and `~/.agenteye/`, and installs nothing with elevated
//! privilege. The shipped runtime is exactly two processes: this daemon and the
//! `failproofai` CLI. (The hook client the harness spawns per event is a third
//! process, but it is started by the harness rather than by us and holds no
//! state.)
//!
//! Two things fall out of that and are worth stating where someone will read
//! them. There is no per-user agent: it existed only because a service account
//! could not traverse `0700` homes to read transcripts, and running as the user
//! removes the problem rather than bridging it. And the sealed tier makes **no
//! verdict-integrity claim** — the governed agent and this daemon are the same
//! user, so it can `ptrace`, preload, or replace the binary. What the tier does
//! buy is a warm evaluator, no per-call temp files, an enforced deadline, and a
//! sandbox that contains a buggy policy rather than an adversary. See
//! `crates/PROTOCOL.md` for the long form.
//!
//! See `crates/PROTOCOL.md` for the wire contract and
//! `desgin-docs/v1.0.0/phase-1-local-enforcement/03-daemon-architecture.md` for
//! what this process is eventually responsible for.

pub mod paths;
pub mod server;
pub mod worker;

pub use paths::{
    agenteye_root, default_agenteye_root, default_failproofai_root, default_install_manifest_path,
    default_socket_path, failproofai_root, install_manifest_path, socket_path,
};
pub use server::{Daemon, Lane};
pub use worker::{SealedWorker, WorkerError};
