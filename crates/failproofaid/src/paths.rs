//! Where things live in user scope.
//!
//! v1.0.0 ships **user scope only** — a deliberate simplification for this
//! version. There is no service account, no privileged install, and nothing
//! under `/opt`, `/var/lib`, `/etc` or `/Library`. The daemon runs as the
//! invoking user and keeps everything in that user's own two roots:
//!
//! | Root | Holds |
//! |---|---|
//! | `~/.failproofai/` | configuration, policy store, `install.json`, logs |
//! | `~/.agenteye/` | capture state — checkpoints, spool, delivery |
//!
//! Both already exist and are already the roots the shipped product uses, so
//! nothing migrates. That is most of the point: the managed-scope design
//! introduced a third and fourth location and a privileged installer to
//! populate them, and dropping it removes all of that rather than relocating
//! it.
//!
//! The socket is the one path that does not live in either, because a socket
//! belongs in a runtime directory that is cleared between boots rather than in
//! a state directory that is not.

use std::env;
use std::path::PathBuf;

/// The daemon's socket path, in preference order.
///
/// 1. `$FAILPROOFAI_DAEMON_SOCKET` — explicit override, used by tests.
/// 2. `$XDG_RUNTIME_DIR/failproofai/failproofaid.sock`.
/// 3. `~/.failproofai/run/failproofaid.sock`.
///
/// The third is not defensive padding. `XDG_RUNTIME_DIR` is unset over a plain
/// `ssh` session on several distributions and on macOS generally — which is
/// precisely where an agent CLI runs — so a daemon that only knew the second
/// would fail to start in a common, unremarkable environment.
///
/// Returns `None` only when neither `XDG_RUNTIME_DIR` nor `HOME` is set, which
/// is a broken environment rather than a supported one; the caller reports it
/// rather than inventing a path in the filesystem root.
#[must_use]
pub fn default_socket_path() -> Option<PathBuf> {
    if let Ok(explicit) = env::var("FAILPROOFAI_DAEMON_SOCKET")
        && !explicit.is_empty()
    {
        return Some(PathBuf::from(explicit));
    }
    if let Ok(runtime_dir) = env::var("XDG_RUNTIME_DIR")
        && !runtime_dir.is_empty()
    {
        return Some(
            PathBuf::from(runtime_dir)
                .join("failproofai")
                .join(SOCKET_FILE),
        );
    }
    home_dir().map(|home| {
        home.join(".failproofai")
            .join("run")
            .join(SOCKET_FILE)
    })
}

const SOCKET_FILE: &str = "failproofaid.sock";

/// `~/.failproofai/` — configuration, policy store, `install.json`, logs.
#[must_use]
pub fn failproofai_root() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".failproofai"))
}

/// `~/.agenteye/` — capture checkpoints, spool, delivery state.
///
/// Deliberately the collector's existing root rather than a new subdirectory of
/// `~/.failproofai/`. The daemon absorbs what the standalone collector did, and
/// the compatibility promise covers its on-disk state; relocating it would be a
/// migration nobody asked for.
#[must_use]
pub fn agenteye_root() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".agenteye"))
}

/// `~/.failproofai/install.json`.
#[must_use]
pub fn install_manifest_path() -> Option<PathBuf> {
    if let Ok(explicit) = env::var("FAILPROOFAI_INSTALL_JSON")
        && !explicit.is_empty()
    {
        return Some(PathBuf::from(explicit));
    }
    failproofai_root().map(|root| root.join("install.json"))
}

/// The invoking user's home directory.
///
/// `$HOME` first, because that is what the user's own shell and every other
/// tool in their session agree on; `getpwuid_r` as the fallback for a process
/// started without an environment (a systemd user unit with a minimal `Environment=`,
/// for instance).
///
/// Note this is *not* the same lookup as the one used for a request's `home`
/// field. That one is derived from the connecting peer's UID at the socket
/// boundary and must not consult the environment at all — see
/// `crates/PROTOCOL.md`. This is the daemon's own home, for placing its own
/// files.
fn home_dir() -> Option<PathBuf> {
    if let Ok(home) = env::var("HOME")
        && !home.is_empty()
    {
        return Some(PathBuf::from(home));
    }
    // SAFETY: `getuid` cannot fail and takes no arguments.
    let uid = unsafe { libc::getuid() };
    fpai_ipc::home_for_uid(uid).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Env-var mutation is process-global, so these run under one lock rather
    /// than racing each other across vitest-style parallel test threads.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvGuard {
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn set(vars: &[(&'static str, Option<&str>)]) -> Self {
            let saved = vars
                .iter()
                .map(|(k, _)| (*k, env::var(k).ok()))
                .collect::<Vec<_>>();
            for (k, v) in vars {
                match v {
                    // SAFETY: single-threaded within the ENV_LOCK guard.
                    Some(val) => unsafe { env::set_var(k, val) },
                    None => unsafe { env::remove_var(k) },
                }
            }
            Self { saved }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in &self.saved {
                match v {
                    // SAFETY: as above.
                    Some(val) => unsafe { env::set_var(k, val) },
                    None => unsafe { env::remove_var(k) },
                }
            }
        }
    }

    #[test]
    fn the_explicit_override_wins() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = EnvGuard::set(&[
            ("FAILPROOFAI_DAEMON_SOCKET", Some("/tmp/explicit.sock")),
            ("XDG_RUNTIME_DIR", Some("/run/user/1000")),
        ]);
        assert_eq!(
            default_socket_path().unwrap(),
            PathBuf::from("/tmp/explicit.sock")
        );
    }

    #[test]
    fn xdg_runtime_dir_is_preferred_when_set() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = EnvGuard::set(&[
            ("FAILPROOFAI_DAEMON_SOCKET", None),
            ("XDG_RUNTIME_DIR", Some("/run/user/1000")),
        ]);
        assert_eq!(
            default_socket_path().unwrap(),
            PathBuf::from("/run/user/1000/failproofai/failproofaid.sock")
        );
    }

    #[test]
    fn falls_back_to_home_when_xdg_runtime_dir_is_absent() {
        // The case that actually happens: a plain `ssh` session on several
        // distributions, and macOS generally. A daemon that only knew
        // XDG_RUNTIME_DIR would fail to start there.
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = EnvGuard::set(&[
            ("FAILPROOFAI_DAEMON_SOCKET", None),
            ("XDG_RUNTIME_DIR", None),
            ("HOME", Some("/home/enrolled")),
        ]);
        assert_eq!(
            default_socket_path().unwrap(),
            PathBuf::from("/home/enrolled/.failproofai/run/failproofaid.sock")
        );
    }

    #[test]
    fn an_empty_xdg_runtime_dir_is_treated_as_unset() {
        // Exported-but-empty is common in stripped environments and is not the
        // same as "the runtime directory is the filesystem root".
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = EnvGuard::set(&[
            ("FAILPROOFAI_DAEMON_SOCKET", None),
            ("XDG_RUNTIME_DIR", Some("")),
            ("HOME", Some("/home/enrolled")),
        ]);
        assert_eq!(
            default_socket_path().unwrap(),
            PathBuf::from("/home/enrolled/.failproofai/run/failproofaid.sock")
        );
    }

    #[test]
    fn the_two_state_roots_are_the_ones_the_product_already_uses() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = EnvGuard::set(&[("HOME", Some("/home/enrolled"))]);
        assert_eq!(
            failproofai_root().unwrap(),
            PathBuf::from("/home/enrolled/.failproofai")
        );
        assert_eq!(
            agenteye_root().unwrap(),
            PathBuf::from("/home/enrolled/.agenteye")
        );
    }

    #[test]
    fn nothing_resolves_outside_the_users_own_roots() {
        // The property the scope decision turns on: no path this module
        // produces lands anywhere requiring elevated privilege.
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = EnvGuard::set(&[
            ("FAILPROOFAI_DAEMON_SOCKET", None),
            ("XDG_RUNTIME_DIR", None),
            ("FAILPROOFAI_INSTALL_JSON", None),
            ("HOME", Some("/home/enrolled")),
        ]);
        for path in [
            default_socket_path().unwrap(),
            failproofai_root().unwrap(),
            agenteye_root().unwrap(),
            install_manifest_path().unwrap(),
        ] {
            let s = path.to_string_lossy().into_owned();
            for privileged in ["/opt/", "/var/lib/", "/etc/", "/Library/", "/usr/"] {
                assert!(
                    !s.starts_with(privileged),
                    "{s} is under {privileged}, which user scope must never touch"
                );
            }
            assert!(s.starts_with("/home/enrolled"), "{s} escaped the user's home");
        }
    }
}
