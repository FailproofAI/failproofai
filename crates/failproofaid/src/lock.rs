//! Single-instance guard: at most one `failproofaid` per OS user.
//!
//! Uses an advisory `flock()` on a dedicated lock file rather than a
//! PID file — a PID file has to be checked-then-trusted (the PID could
//! have been reused by an unrelated process since), whereas `flock` is
//! released automatically by the kernel when the holding process exits or
//! is killed, for any reason, with no stale-file cleanup required.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::io::AsRawFd;
use std::path::Path;

pub struct SingletonLock {
    // Held for the guard's lifetime; the flock is released when this File
    // (and its underlying fd) is dropped.
    _file: File,
}

#[derive(Debug)]
pub enum LockError {
    Io(io::Error),
    AlreadyRunning,
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Io(e) => write!(f, "io error acquiring daemon lock: {e}"),
            LockError::AlreadyRunning => {
                write!(f, "another failproofaid is already running for this user")
            }
        }
    }
}

impl std::error::Error for LockError {}

/// Tries to acquire the singleton lock at `path`, creating the file if
/// needed. Returns [`LockError::AlreadyRunning`] immediately (non-blocking)
/// if another live process already holds it.
pub fn acquire(path: &Path) -> Result<SingletonLock, LockError> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .map_err(LockError::Io)?;

    let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if ret != 0 {
        let err = io::Error::last_os_error();
        return match err.raw_os_error() {
            Some(libc::EWOULDBLOCK) => Err(LockError::AlreadyRunning),
            _ => Err(LockError::Io(err)),
        };
    }
    Ok(SingletonLock { _file: file })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_acquire_in_the_same_process_fails_while_the_first_is_held() {
        let tmp = std::env::temp_dir().join(format!(
            "failproofaid-lock-test-{}-{}",
            std::process::id(),
            line!()
        ));
        let first = acquire(&tmp).expect("first acquire should succeed");
        let second = acquire(&tmp);
        assert!(matches!(second, Err(LockError::AlreadyRunning)));
        drop(first);
        // Once released, a fresh acquire succeeds again.
        let third = acquire(&tmp);
        assert!(third.is_ok());
        std::fs::remove_file(&tmp).ok();
    }
}
