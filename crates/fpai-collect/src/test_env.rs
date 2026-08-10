//! ONE lock for every test in this crate that reads or writes the
//! `FAILPROOFAI_<SOURCE>_EXTRA_PATHS` environment overrides.
//!
//! `cargo test` runs a crate's unit tests as threads in ONE process and
//! `std::env::set_var` is process-global, so a test that sets an override is
//! setting it for every test running at that instant — not just its own.
//!
//! Two tests here set `FAILPROOFAI_CLAUDE_EXTRA_PATHS` with no coordination at
//! all, and the reader that lost the race
//! (`reads_the_sources_tables_the_typescript_cli_writes`) asserted on the file's
//! `work=/srv/team/.claude/projects` and got the other test's `a=/one, b=/two`.
//! It failed roughly one run in six — often enough to be real, rarely enough to
//! be re-run and forgotten, and the failure names the wrong test entirely: the
//! one that reports is the victim, never the one that set the variable.
//!
//! READERS must take this lock too, not just writers. A mutex only serialises
//! the parties that ask for it, and here the reader is the one that fails.
//!
//! Poison-tolerant: the guarded data is `()`, so a panicking holder leaves no
//! broken invariant, and a failing test should fail alone rather than convert
//! every later `lock().unwrap()` into a second failure pointing at the lock.

use std::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Serialise a test that reads or writes the extra-path env overrides.
/// Hold the guard for the whole test body.
pub(crate) fn lock_env() -> MutexGuard<'static, ()> {
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
