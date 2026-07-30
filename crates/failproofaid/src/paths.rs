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
//! introduced a third and fourth location plus a privileged installer to
//! populate them, and dropping it removes all of that rather than relocating
//! it.
//!
//! The socket is the one path in neither, because a socket belongs in a runtime
//! directory that is cleared between boots rather than in a state directory
//! that is not.
//!
//! ## Why every function takes its environment
//!
//! The resolvers are pure: they read nothing global and take `home` and
//! `runtime_dir` as arguments, with thin `*_from_env` wrappers doing the
//! actual reads. That is not ceremony. `std::env::set_var` is `unsafe` in
//! edition 2024 because it is a data race in a multi-threaded process, and a
//! test suite that mutates process environment to exercise a path resolver has
//! to either serialise every test behind a lock or accept flakiness. Passing
//! the environment in removes the problem rather than guarding it, and it means
//! the table of cases below is exhaustive and order-independent.

use std::path::PathBuf;

const SOCKET_FILE: &str = "failproofaid.sock";

/// Resolve the socket path from explicit inputs.
///
/// Preference order:
///
/// 1. `explicit` — `$FAILPROOFAI_DAEMON_SOCKET`, used by tests and by anyone
///    running more than one daemon.
/// 2. `runtime_dir` — `$XDG_RUNTIME_DIR/failproofai/`.
/// 3. `home` — `~/.failproofai/run/`.
///
/// The third is not defensive padding. `XDG_RUNTIME_DIR` is unset over a plain
/// `ssh` session on several distributions and on macOS generally — precisely
/// where an agent CLI runs — so a daemon that only knew the second would fail
/// to start in a common, unremarkable environment.
///
/// Empty strings count as unset. Exported-but-empty is normal in stripped
/// environments and is not the same as "the runtime directory is `/`".
#[must_use]
pub fn socket_path(
    explicit: Option<&str>,
    runtime_dir: Option<&str>,
    home: Option<&str>,
) -> Option<PathBuf> {
    if let Some(path) = non_empty(explicit) {
        return Some(PathBuf::from(path));
    }
    if let Some(dir) = non_empty(runtime_dir) {
        return Some(PathBuf::from(dir).join("failproofai").join(SOCKET_FILE));
    }
    non_empty(home).map(|h| {
        PathBuf::from(h)
            .join(".failproofai")
            .join("run")
            .join(SOCKET_FILE)
    })
}

/// `~/.failproofai/` — configuration, policy store, `install.json`, logs.
#[must_use]
pub fn failproofai_root(home: Option<&str>) -> Option<PathBuf> {
    non_empty(home).map(|h| PathBuf::from(h).join(".failproofai"))
}

/// `~/.agenteye/` — capture checkpoints, spool, delivery state.
///
/// Deliberately the collector's existing root rather than a new subdirectory of
/// `~/.failproofai/`. The daemon absorbs what the standalone collector did, and
/// the compatibility promise covers its on-disk state; relocating it would be a
/// migration nobody asked for.
#[must_use]
pub fn agenteye_root(home: Option<&str>) -> Option<PathBuf> {
    non_empty(home).map(|h| PathBuf::from(h).join(".agenteye"))
}

/// `~/.failproofai/install.json`, or `explicit` when given.
#[must_use]
pub fn install_manifest_path(explicit: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    if let Some(path) = non_empty(explicit) {
        return Some(PathBuf::from(path));
    }
    failproofai_root(home).map(|root| root.join("install.json"))
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

// ── Environment-reading wrappers ───────────────────────────────────────────

/// [`socket_path`] with the process environment supplied.
#[must_use]
pub fn default_socket_path() -> Option<PathBuf> {
    socket_path(
        std::env::var("FAILPROOFAI_DAEMON_SOCKET").ok().as_deref(),
        std::env::var("XDG_RUNTIME_DIR").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
}

/// [`failproofai_root`] with the process environment supplied.
#[must_use]
pub fn default_failproofai_root() -> Option<PathBuf> {
    failproofai_root(std::env::var("HOME").ok().as_deref())
}

/// [`agenteye_root`] with the process environment supplied.
#[must_use]
pub fn default_agenteye_root() -> Option<PathBuf> {
    agenteye_root(std::env::var("HOME").ok().as_deref())
}

/// [`install_manifest_path`] with the process environment supplied.
#[must_use]
pub fn default_install_manifest_path() -> Option<PathBuf> {
    install_manifest_path(
        std::env::var("FAILPROOFAI_INSTALL_JSON").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: Option<&str> = Some("/home/enrolled");

    #[test]
    fn the_explicit_override_wins_over_everything() {
        assert_eq!(
            socket_path(Some("/tmp/explicit.sock"), Some("/run/user/1000"), HOME).unwrap(),
            PathBuf::from("/tmp/explicit.sock")
        );
    }

    #[test]
    fn xdg_runtime_dir_is_preferred_when_set() {
        assert_eq!(
            socket_path(None, Some("/run/user/1000"), HOME).unwrap(),
            PathBuf::from("/run/user/1000/failproofai/failproofaid.sock")
        );
    }

    #[test]
    fn falls_back_to_home_when_xdg_runtime_dir_is_absent() {
        // The case that actually happens: a plain `ssh` session on several
        // distributions, and macOS generally. A daemon that only knew
        // XDG_RUNTIME_DIR would fail to start there.
        assert_eq!(
            socket_path(None, None, HOME).unwrap(),
            PathBuf::from("/home/enrolled/.failproofai/run/failproofaid.sock")
        );
    }

    #[test]
    fn empty_strings_are_treated_as_unset_at_every_level() {
        assert_eq!(
            socket_path(Some(""), Some(""), HOME).unwrap(),
            PathBuf::from("/home/enrolled/.failproofai/run/failproofaid.sock")
        );
        assert_eq!(
            socket_path(Some(""), Some("/run/user/1000"), HOME).unwrap(),
            PathBuf::from("/run/user/1000/failproofai/failproofaid.sock")
        );
    }

    #[test]
    fn nothing_resolves_without_a_home_or_runtime_dir() {
        // A broken environment is reported rather than papered over with a path
        // in the filesystem root.
        assert!(socket_path(None, None, None).is_none());
        assert!(socket_path(None, None, Some("")).is_none());
        assert!(failproofai_root(None).is_none());
        assert!(agenteye_root(None).is_none());
    }

    #[test]
    fn the_two_state_roots_are_the_ones_the_product_already_uses() {
        assert_eq!(
            failproofai_root(HOME).unwrap(),
            PathBuf::from("/home/enrolled/.failproofai")
        );
        assert_eq!(
            agenteye_root(HOME).unwrap(),
            PathBuf::from("/home/enrolled/.agenteye")
        );
    }

    #[test]
    fn the_install_manifest_sits_with_the_users_own_state() {
        assert_eq!(
            install_manifest_path(None, HOME).unwrap(),
            PathBuf::from("/home/enrolled/.failproofai/install.json")
        );
        assert_eq!(
            install_manifest_path(Some("/tmp/i.json"), HOME).unwrap(),
            PathBuf::from("/tmp/i.json")
        );
    }

    #[test]
    fn nothing_resolves_outside_the_users_own_roots() {
        // The property the whole scope decision turns on: no path this module
        // produces lands anywhere that would require elevated privilege.
        for path in [
            socket_path(None, None, HOME).unwrap(),
            socket_path(None, Some("/run/user/1000"), HOME).unwrap(),
            failproofai_root(HOME).unwrap(),
            agenteye_root(HOME).unwrap(),
            install_manifest_path(None, HOME).unwrap(),
        ] {
            let s = path.to_string_lossy().into_owned();
            for privileged in ["/opt/", "/var/lib/", "/etc/", "/Library/", "/usr/"] {
                assert!(
                    !s.starts_with(privileged),
                    "{s} is under {privileged}, which user scope must never touch"
                );
            }
        }
    }
}
