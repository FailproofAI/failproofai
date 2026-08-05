//! Resolves where failproofaid's runtime state lives on disk.
//!
//! User-scope only (per the plan: no elevation, everything under the
//! invoking user's home directory) — Linux and macOS only, matching the
//! rest of this crate.

use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

/// `~/.failproofai/run` — directory holding the socket and singleton lock
/// file. Overridable via `FAILPROOFAI_DAEMON_SOCKET`'s parent for local dev
/// (see `run_dir_override`), so a `bun run daemon:dev` loop never touches a
/// real installed daemon's state.
pub fn run_dir() -> io::Result<PathBuf> {
    if let Some(socket_override) = std::env::var_os("FAILPROOFAI_DAEMON_SOCKET") {
        let path = PathBuf::from(socket_override);
        return path
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::other("FAILPROOFAI_DAEMON_SOCKET has no parent directory"));
    }
    let home = std::env::var_os("HOME")
        .ok_or_else(|| io::Error::other("HOME is not set; failproofaid is user-scope only"))?;
    Ok(PathBuf::from(home).join(".failproofai").join("run"))
}

pub fn socket_path() -> io::Result<PathBuf> {
    if let Some(socket_override) = std::env::var_os("FAILPROOFAI_DAEMON_SOCKET") {
        return Ok(PathBuf::from(socket_override));
    }
    Ok(run_dir()?.join("failproofaid.sock"))
}

pub fn lock_path() -> io::Result<PathBuf> {
    Ok(run_dir()?.join("failproofaid.lock"))
}

/// Where the daemon tells the worker subprocess to listen — a second
/// socket, distinct from `socket_path()`, that only this process ever
/// connects to. Overridable via `FAILPROOFAI_WORKER_SOCKET` for local dev
/// (mirrors `FAILPROOFAI_DAEMON_SOCKET`'s override for the client-facing
/// socket).
pub fn worker_socket_path() -> io::Result<PathBuf> {
    if let Some(socket_override) = std::env::var_os("FAILPROOFAI_WORKER_SOCKET") {
        return Ok(PathBuf::from(socket_override));
    }
    Ok(run_dir()?.join("worker.sock"))
}

/// Local cache for cloud-managed policy generations. The override keeps
/// tests and development runs away from a user's real policy directory.
pub fn cloud_managed_policy_dir() -> io::Result<PathBuf> {
    if let Some(path) = std::env::var_os("FAILPROOFAI_CLOUD_POLICY_DIR") {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var_os("HOME").ok_or_else(|| {
        io::Error::other("HOME is not set; cannot resolve cloud policy directory")
    })?;
    Ok(PathBuf::from(home)
        .join(".failproofai")
        .join("policies")
        .join("cloud-managed"))
}

// ── Layout 2 ─────────────────────────────────────────────────────────────────
//
// These MUST mirror `src/hooks/fp-home.ts` exactly. The daemon and the CLI are
// separate processes with separate path logic, so a divergence does not fail —
// it means the daemon writes where the dashboard never reads, and an absent
// directory is indistinguishable from an idle one. `crates/failproofaid/tests/
// layout.rs` asserts the two agree.

/// `~/.failproofai/hook-activity` — the decision log. Promoted out of `cache/`
/// in layout 2: nothing regenerates it, so it was never a cache.
pub fn hook_activity_dir() -> io::Result<PathBuf> {
    Ok(failproofai_home()?.join("hook-activity"))
}

/// `~/.failproofai/cursors/<source>` — per-source collector watermarks.
pub fn cursors_dir() -> io::Result<PathBuf> {
    Ok(failproofai_home()?.join("cursors"))
}

/// `~/.failproofai/state/audit-schedule.json` — when the scheduled audit last
/// ran and when the next one is due.
///
/// The one path under `state/` that IS mirrored here, and the exception is the
/// point: the collector derives its own paths from the `home` it is handed (see
/// the note below), whereas this file has exactly two parties — the daemon,
/// which is its sole writer, and `auditScheduleFile()` in `src/hooks/fp-home.ts`,
/// which the dashboard's last-run / next-due readout reads. Two processes with
/// two path expressions is precisely the drift this section exists to prevent.
pub fn audit_schedule_path() -> io::Result<PathBuf> {
    Ok(failproofai_home()?
        .join("state")
        .join("audit-schedule.json"))
}

// The collector's own paths — state/, spool/, failed/, collector-health.json,
// custom-agents/, credentials.toml, config.toml — are NOT mirrored here.
// `fpai-collect` derives them from the `home` it is handed (see its
// `config.rs` and `health.rs`), so a copy in this file would be dead code that
// exists only to drift out of agreement with the one that is actually used.
// What must agree is the LAYOUT, and `__tests__/e2e/layout/` asserts that
// end to end against a real daemon.

/// `~/.failproofai` — the root the collector reads its configuration from.
///
/// `FAILPROOFAI_HOME` overrides it so tests and development runs never touch a
/// real user's config, and so a containerised daemon can be pointed at a
/// mounted volume.
pub fn failproofai_home() -> io::Result<PathBuf> {
    if let Some(path) = std::env::var_os("FAILPROOFAI_HOME") {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var_os("HOME")
        .ok_or_else(|| io::Error::other("HOME is not set; cannot resolve the failproofai home"))?;
    Ok(PathBuf::from(home).join(".failproofai"))
}

/// Creates the run directory (`0700`) if it doesn't exist yet. This
/// directory holds a socket that evaluates security-relevant decisions, so
/// a freshly created one is always locked to owner-only.
///
/// If the directory already exists, this deliberately does **not** chmod
/// it into shape — only a directory failproofaid created itself gets its
/// permissions enforced. `FAILPROOFAI_DAEMON_SOCKET` is a raw path (dev/test
/// override; see `run_dir`), and blindly tightening permissions on whatever
/// pre-existing directory its parent happens to resolve to would let a
/// misconfigured override silently reach out and chmod an unrelated shared
/// directory (worst case, something like `/tmp` itself). Failing loudly is
/// the safe default; a real deployment's `~/.failproofai/run` is always
/// failproofaid's own directory and will simply be created fresh the first
/// time, taking the safe branch below.
pub fn ensure_run_dir() -> io::Result<PathBuf> {
    let dir = run_dir()?;
    if dir.exists() {
        let mode = fs::metadata(&dir)?.permissions().mode() & 0o777;
        if mode != 0o700 {
            return Err(io::Error::other(format!(
                "run directory {} already exists with permissions {:o} (expected 0700) — \
                 refusing to modify a directory failproofaid did not create itself",
                dir.display(),
                mode
            )));
        }
        return Ok(dir);
    }
    fs::create_dir_all(&dir)?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // std::env::set_var affects the whole process, so these tests must not
    // run concurrently with each other or with other tests reading these
    // vars.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn socket_override_takes_precedence_over_home() {
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::set_var("FAILPROOFAI_DAEMON_SOCKET", "/tmp/example/daemon.sock");
        }
        assert_eq!(
            socket_path().unwrap(),
            PathBuf::from("/tmp/example/daemon.sock")
        );
        assert_eq!(run_dir().unwrap(), PathBuf::from("/tmp/example"));
        unsafe {
            std::env::remove_var("FAILPROOFAI_DAEMON_SOCKET");
        }
    }

    #[test]
    fn default_socket_path_lives_under_home_dot_failproofai_run() {
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::remove_var("FAILPROOFAI_DAEMON_SOCKET");
            std::env::set_var("HOME", "/home/example-user");
        }
        assert_eq!(
            socket_path().unwrap(),
            PathBuf::from("/home/example-user/.failproofai/run/failproofaid.sock")
        );
    }

    #[test]
    fn ensure_run_dir_creates_it_with_owner_only_permissions() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp =
            std::env::temp_dir().join(format!("failproofaid-paths-test-{}", std::process::id()));
        unsafe {
            std::env::set_var(
                "FAILPROOFAI_DAEMON_SOCKET",
                tmp.join("run").join("failproofaid.sock"),
            );
        }
        let dir = ensure_run_dir().unwrap();
        let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        fs::remove_dir_all(&tmp).ok();
        unsafe {
            std::env::remove_var("FAILPROOFAI_DAEMON_SOCKET");
        }
    }

    #[test]
    fn ensure_run_dir_refuses_to_touch_a_preexisting_directory_with_the_wrong_permissions() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!(
            "failproofaid-paths-test-preexisting-{}",
            std::process::id()
        ));
        // Simulate FAILPROOFAI_DAEMON_SOCKET being pointed at some
        // unrelated, already-existing directory (e.g. a misconfigured
        // override resolving to a shared temp dir) — this must error
        // instead of silently chmod-ing a directory failproofaid doesn't
        // own.
        fs::create_dir_all(&tmp).unwrap();
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)).unwrap();
        unsafe {
            std::env::set_var("FAILPROOFAI_DAEMON_SOCKET", tmp.join("failproofaid.sock"));
        }

        let result = ensure_run_dir();
        assert!(result.is_err(), "expected an error, got {result:?}");
        let mode_after = fs::metadata(&tmp).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode_after, 0o755, "permissions must be left untouched");

        fs::remove_dir_all(&tmp).ok();
        unsafe {
            std::env::remove_var("FAILPROOFAI_DAEMON_SOCKET");
        }
    }
}
