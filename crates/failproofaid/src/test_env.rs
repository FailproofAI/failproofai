//! ONE lock for every test in this crate that mutates environment variables.
//!
//! `std::env::set_var` is process-global and `cargo test` runs the tests of a
//! binary as threads inside ONE process, so any two tests touching `HOME` or
//! `FAILPROOFAI_HOME` must be serialised against each other.
//!
//! `paths.rs` and `cloud_client.rs` each used to declare their own `ENV_LOCK`,
//! both carrying a comment saying these tests must not run concurrently "with
//! anything else reading the same variables" — which two separate mutexes is
//! exactly what cannot deliver. Both modules set `HOME` and `FAILPROOFAI_HOME`,
//! so a `paths` test could clear the home a `cloud_client` test had just set
//! and the latter would read the DEVELOPER'S REAL `~/.failproofai/`. On a
//! machine with real credentials on disk that is an assertion failure in a test
//! that is not wrong, in a run that is not reproducible.
//!
//! It also cascades, which is how it was found: the panicking test poisons the
//! mutex, and every later `.lock().unwrap()` on it panics too — so one race
//! surfaced as two failures in tests that never ran and pointed at the lock
//! rather than at the cause. `lock_env` therefore recovers from poisoning
//! rather than propagating it: the data behind this mutex is `()`, so there is
//! no invariant a panicking holder could have left broken, and a failing test
//! should fail alone instead of taking the rest of the module with it.

use std::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Serialise a test that reads or writes process-global environment variables.
/// Hold the returned guard for as long as the env must stay untouched.
pub(crate) fn lock_env() -> MutexGuard<'static, ()> {
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
