//! The daemon's own log file: `~/.failproofai/logs/daemon.log`, size-rotated.
//!
//! Stderr still goes where it always has (journald on Linux, launchd's
//! `failproofaid.err.log` on macOS), unchanged, because `systemctl status`, the
//! e2e tests and every support recipe read it. This file exists so that every
//! machine has its log in ONE place under `~/.failproofai` — on Linux it
//! otherwise lived only in the journal — bounded in size, and in a form that
//! can be collected for support.
//!
//! Never fatal: a home that cannot hold a log must not stop enforcement, so
//! any failure here simply leaves logging on stderr alone.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Rotate once the active file passes this.
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;
/// Rotated files kept beside the active one: `daemon.log.1` … `.N`.
pub const KEEP: usize = 3;

struct Inner {
    path: PathBuf,
    max_bytes: u64,
    keep: usize,
    file: Option<File>,
    size: u64,
}

impl Inner {
    /// Owner-only, created that way and tightened if an older file is not:
    /// the log carries machine ids and policy diagnostics, and a home another
    /// account can traverse must not make it readable to them.
    ///
    /// Only a regular file is used. Opened non-blocking and without following
    /// a link, so a FIFO placed there (whose open waits for a reader) cannot
    /// stall startup, which runs before the socket is bound, and a symlink
    /// cannot point the log somewhere else.
    fn open(&mut self) {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
            .open(&self.path)
            .ok()
            .filter(|file| file.metadata().is_ok_and(|m| m.is_file()));
        self.size = match &self.file {
            Some(file) => {
                let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
                file.metadata().map(|m| m.len()).unwrap_or(0)
            }
            None => 0,
        };
    }

    fn rotate(&mut self) {
        self.file = None;
        rotate_file(&self.path, self.keep);
        self.open();
    }

    fn write(&mut self, buf: &[u8]) {
        if self.size >= self.max_bytes {
            self.rotate();
        } else if self.file.is_none() {
            // A rotation whose new file could not be created (a full disk,
            // say): try again rather than stay silent until a restart.
            self.open();
        }
        if let Some(file) = self.file.as_mut()
            && file.write_all(buf).is_ok()
        {
            self.size += buf.len() as u64;
        }
    }
}

/// `path` → `path.1` → … → `path.<keep>`, dropping the oldest. Missing files
/// are skipped; a failed rename leaves the rest as they were.
/// `<path>.<n>`, built from the path's own bytes rather than its display
/// form, which replaces anything that is not UTF-8.
fn numbered(path: &Path, n: usize) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{n}"));
    PathBuf::from(name)
}

pub fn rotate_file(path: &Path, keep: usize) {
    let numbered = |n: usize| numbered(path, n);
    if keep == 0 {
        let _ = fs::remove_file(path);
        return;
    }
    let _ = fs::remove_file(numbered(keep));
    for n in (1..keep).rev() {
        let _ = fs::rename(numbered(n), numbered(n + 1));
    }
    let _ = fs::rename(path, numbered(1));
}

/// A cloneable, rotating append-only writer for `tracing_subscriber`.
#[derive(Clone)]
pub struct RotatingFile(Arc<Mutex<Inner>>);

impl RotatingFile {
    /// Creates the log's own directory, never its parents: a missing
    /// failproofai home is not this module's to create (the run directory
    /// checks the permissions of directories it did not make itself).
    pub fn open(path: PathBuf, max_bytes: u64, keep: usize) -> Option<Self> {
        let dir = path.parent()?;
        if !dir.is_dir() {
            fs::create_dir(dir).ok()?;
        }
        let mut inner = Inner {
            path,
            max_bytes,
            keep,
            file: None,
            size: 0,
        };
        inner.open();
        inner.file.as_ref()?;
        Some(RotatingFile(Arc::new(Mutex::new(inner))))
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // Poison-tolerant: a panic mid-write elsewhere must not end logging.
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.write(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(file) = inner.file.as_mut() {
            file.flush()?;
        }
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for RotatingFile {
    type Writer = RotatingFile;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// Rotate a log some other process appends to (launchd's stderr file on macOS)
/// when it has grown past `max_bytes`. Called once at startup, before this
/// process writes to it: launchd opened it `O_APPEND` for our own stderr, so a
/// rename moves our fd's writes into `.1` — which is why the old file is
/// copied and then TRUNCATED in place instead.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn bound_inherited_log(path: &Path, max_bytes: u64, keep: usize) {
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.len() <= max_bytes {
        return;
    }
    let first = numbered(path, 1);
    let _ = fs::remove_file(numbered(path, keep));
    for n in (1..keep).rev() {
        let _ = fs::rename(numbered(path, n), numbered(path, n + 1));
    }
    if fs::copy(path, &first).is_ok() {
        let _ = OpenOptions::new()
            .write(true)
            .open(path)
            .and_then(|f| f.set_len(0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fpai-logfile-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rotates_past_the_limit_and_keeps_only_the_newest() {
        let dir = temp_dir("rotate");
        let path = dir.join("daemon.log");
        let mut log = RotatingFile::open(path.clone(), 10, 2).unwrap();
        for line in [
            "aaaaaaaaaa\n",
            "bbbbbbbbbb\n",
            "cccccccccc\n",
            "dddddddddd\n",
        ] {
            log.write_all(line.as_bytes()).unwrap();
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), "dddddddddd\n");
        assert_eq!(
            fs::read_to_string(dir.join("daemon.log.1")).unwrap(),
            "cccccccccc\n"
        );
        assert_eq!(
            fs::read_to_string(dir.join("daemon.log.2")).unwrap(),
            "bbbbbbbbbb\n"
        );
        assert!(
            !dir.join("daemon.log.3").exists(),
            "only `keep` rotations remain"
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_log_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        let path = dir.join("daemon.log");
        fs::write(&path, "older\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let mut log = RotatingFile::open(path.clone(), 10, 1).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        log.write_all(b"0123456789ab\n").unwrap();
        log.write_all(b"x\n").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600,
            "after rotation"
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_fifo_in_place_of_the_log_neither_blocks_nor_is_used() {
        let dir = temp_dir("fifo");
        let path = dir.join("daemon.log");
        let c = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
        // SAFETY: a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let started = std::time::Instant::now();
        assert!(RotatingFile::open(path, 10, 1).is_none());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "the open did not wait for a reader"
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_missing_home_is_never_created() {
        let dir = temp_dir("no-home");
        let home = dir.join("home");
        assert!(RotatingFile::open(home.join("logs").join("daemon.log"), 10, 1).is_none());
        assert!(!home.exists());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn an_unwritable_home_is_not_fatal() {
        assert!(RotatingFile::open(PathBuf::from("/proc/fpai-no/daemon.log"), 10, 1).is_none());
    }

    #[test]
    fn an_oversized_inherited_log_is_kept_once_and_truncated_in_place() {
        let dir = temp_dir("inherited");
        let path = dir.join("failproofaid.err.log");
        fs::write(&path, "x".repeat(50)).unwrap();
        // Another process's O_APPEND handle on the same file, as launchd holds.
        let mut appender = OpenOptions::new().append(true).open(&path).unwrap();
        bound_inherited_log(&path, 20, 2);
        appender.write_all(b"after\n").unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("failproofaid.err.log.1"))
                .unwrap()
                .len(),
            50
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "after\n",
            "the live handle keeps writing here"
        );

        // A small one is left alone.
        bound_inherited_log(&path, 20, 2);
        assert_eq!(fs::read_to_string(&path).unwrap(), "after\n");
        fs::remove_dir_all(dir).ok();
    }
}
