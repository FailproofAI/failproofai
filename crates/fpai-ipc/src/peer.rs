//! Peer credentials, read from the kernel.
//!
//! Mandatory, and never read from a field the caller supplies. The UID is the
//! authorization context for a request and the key for per-UID policy, quota,
//! and (later) spool state, so a caller that could name its own UID could name
//! another user's policy set.
//!
//! | Platform | Mechanism |
//! |---|---|
//! | Linux | `getsockopt(SOL_SOCKET, SO_PEERCRED)` → `struct ucred { pid, uid, gid }` |
//! | macOS | `getpeereid(2)` → `(uid, gid)` |
//!
//! `std::os::unix::net::UnixStream::peer_cred` would cover the Linux half, but
//! it is unstable (`peer_credentials_unix_socket`) and this crate builds on a
//! pinned stable toolchain.

use std::io;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use nix::unistd::{Uid, User};

/// Kernel-reported identity of the process on the other end of a Unix socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PeerCred {
    /// Effective UID of the peer. The authorization context for the request.
    pub uid: u32,
    /// Effective GID of the peer.
    pub gid: u32,
    /// PID of the peer, when the platform reports one.
    ///
    /// `None` on macOS: `getpeereid(2)` returns only the UID and GID. It is an
    /// `Option` rather than a `0` sentinel so that a caller which needs a PID
    /// has to confront the platform that cannot supply one — and so that a
    /// missing PID can never be mistaken for PID 0. Nothing in enforcement may
    /// depend on it: a PID is a racy handle (the process can exit and the
    /// number be reused before it is used), which is the same reason
    /// `/proc/<pid>/cwd` is not trusted for `host.cwd`.
    pub pid: Option<i32>,
}

/// Read the peer's credentials from the kernel.
///
/// # Errors
///
/// The underlying `getsockopt`/`getpeereid` failure, verbatim — most often
/// `ENOTCONN` if the peer has already gone away. On a platform with neither
/// mechanism, [`io::ErrorKind::Unsupported`].
pub fn peer_credentials(sock: &UnixStream) -> io::Result<PeerCred> {
    platform::peer_credentials(sock)
}

/// Resolve a UID's home directory with `getpwuid_r(3)`.
///
/// # There is deliberately no fallback
///
/// A miss is an error, never a default such as `/home/<name>`, `/nonexistent`,
/// or the daemon's own `$HOME`. Home widens the allow set — `isAgentInternalPath`
/// treats paths under it as agent-internal — so a guessed home is a guessed
/// security boundary. PROTOCOL.md makes a `getpwuid_r` miss an `internal`
/// error for exactly this reason: refusing to answer is safe, answering wrongly
/// is not.
///
/// # ERANGE
///
/// `getpwuid_r` wants a caller-supplied buffer and returns `ERANGE` when it is
/// too small, which is not a failure but a request to retry with a larger one.
/// The loop lives in `nix::unistd::User::from_uid`, which sizes the first
/// attempt from `sysconf(_SC_GETPW_R_SIZE_MAX)` and doubles up to a 1 MiB cap —
/// so this function must not be rewritten onto raw `libc::getpwuid_r` without
/// bringing that loop with it. A single-shot call silently fails for any user
/// whose passwd entry (GECOS, long shell path, NIS/LDAP-sourced fields)
/// overflows the initial guess, which is a per-user, per-machine bug that no
/// test on the author's laptop will ever reproduce.
///
/// # Errors
///
/// [`io::ErrorKind::NotFound`] if there is no passwd entry for `uid` — which
/// `getpwuid_r` reports as success with a null result, and which must not be
/// confused with a lookup failure. [`io::ErrorKind::InvalidData`] if the entry
/// exists but its home is empty or relative, which is a broken account rather
/// than a usable answer. Any other `errno` from the lookup itself (NSS
/// unreachable, EIO, EMFILE) is returned verbatim.
pub fn home_for_uid(uid: u32) -> io::Result<PathBuf> {
    match User::from_uid(Uid::from_raw(uid)) {
        Ok(Some(user)) => {
            if user.dir.as_os_str().is_empty() || !user.dir.is_absolute() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "passwd entry for uid {uid} has a non-absolute home {:?}",
                        user.dir
                    ),
                ));
            }
            Ok(user.dir)
        }
        Ok(None) => Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("no passwd entry for uid {uid}"),
        )),
        Err(errno) => Err(io::Error::from_raw_os_error(errno as i32)),
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod platform {
    use std::io;
    use std::os::unix::net::UnixStream;

    use nix::sys::socket::{getsockopt, sockopt};

    use super::PeerCred;

    pub fn peer_credentials(sock: &UnixStream) -> io::Result<PeerCred> {
        // SO_PEERCRED is recorded by the kernel at connect(2) time from the
        // connecting process's credentials, so it cannot be spoofed by the peer
        // and does not race with a later setuid.
        let cred = getsockopt(sock, sockopt::PeerCredentials)
            .map_err(|errno| io::Error::from_raw_os_error(errno as i32))?;
        Ok(PeerCred {
            uid: cred.uid(),
            gid: cred.gid(),
            pid: Some(cred.pid()),
        })
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod platform {
    use std::io;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;

    use super::PeerCred;

    /// `getpeereid(2)`.
    ///
    /// `nix` exposes the Darwin `LOCAL_PEERCRED` socket option (as `XuCred`)
    /// but has no safe binding for `getpeereid`, so this is the one place in
    /// the crate that calls libc directly. It is three lines, has no lifetimes
    /// or ownership to get wrong, and PROTOCOL.md names `getpeereid(2)`
    /// specifically as the macOS mechanism — reaching for `LOCAL_PEERCRED`
    /// instead to avoid an `unsafe` block would silently substitute a different
    /// contract for the documented one.
    #[allow(
        unsafe_code,
        reason = "no safe binding for getpeereid(2); see the doc comment"
    )]
    pub fn peer_credentials(sock: &UnixStream) -> io::Result<PeerCred> {
        let mut uid: nix::libc::uid_t = 0;
        let mut gid: nix::libc::gid_t = 0;
        // SAFETY: `sock.as_raw_fd()` is a valid, open socket descriptor for as
        // long as `sock` is borrowed, which is the whole call. `uid` and `gid`
        // are live, correctly typed, properly aligned stack slots that outlive
        // the call, and getpeereid writes at most one value to each. The
        // function takes no ownership of the descriptor and stores no pointer.
        let rc = unsafe { nix::libc::getpeereid(sock.as_raw_fd(), &raw mut uid, &raw mut gid) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        // getpeereid reports no PID; see `PeerCred::pid`.
        Ok(PeerCred {
            uid,
            gid,
            pid: None,
        })
    }
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "ios"
)))]
mod platform {
    use std::io;
    use std::os::unix::net::UnixStream;

    use super::PeerCred;

    /// No supported mechanism on this platform.
    ///
    /// An explicit refusal rather than a permissive stub: a build that could
    /// not identify its peer must fail closed at the call site, not authorize
    /// everyone as UID 0. Windows transport is deferred beyond Phase 1 and will
    /// arrive as a named-pipe implementation with its own mechanism.
    pub fn peer_credentials(_sock: &UnixStream) -> io::Result<PeerCred> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "peer credentials are supported on Linux (SO_PEERCRED) and macOS (getpeereid) only",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A socketpair is the only way to test this without a listener, and some
    /// sandboxes forbid it. Skipping is correct there; failing would be noise.
    fn socket_pair() -> Option<(UnixStream, UnixStream)> {
        match UnixStream::pair() {
            Ok(pair) => Some(pair),
            Err(e) => {
                eprintln!("skipping: this environment cannot create a Unix socketpair: {e}");
                None
            }
        }
    }

    #[test]
    fn reads_our_own_uid_off_a_socketpair() {
        let Some((a, b)) = socket_pair() else { return };

        let expected_uid = nix::unistd::geteuid().as_raw();
        let expected_gid = nix::unistd::getegid().as_raw();

        for sock in [&a, &b] {
            match peer_credentials(sock) {
                Ok(cred) => {
                    assert_eq!(cred.uid, expected_uid);
                    assert_eq!(cred.gid, expected_gid);
                }
                Err(e) if e.kind() == io::ErrorKind::Unsupported => {
                    eprintln!("skipping: {e}");
                    return;
                }
                Err(e) => panic!("peer_credentials failed: {e}"),
            }
        }
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn reports_our_own_pid_on_linux() {
        let Some((a, _b)) = socket_pair() else { return };
        let cred = peer_credentials(&a).expect("SO_PEERCRED on a socketpair");
        assert_eq!(cred.pid, Some(std::process::id() as i32));
    }

    #[test]
    fn resolves_the_current_uid_to_an_absolute_home() {
        let uid = nix::unistd::geteuid().as_raw();
        match home_for_uid(uid) {
            Ok(home) => assert!(home.is_absolute(), "{home:?} is not absolute"),
            // A UID with no passwd entry is a legitimate state for a container
            // build user; the point of the test is that it errors rather than
            // inventing a home, which the next test asserts directly.
            Err(e) => eprintln!("skipping: uid {uid} has no usable passwd entry: {e}"),
        }
    }

    #[test]
    fn a_missing_uid_errors_rather_than_falling_back() {
        // Far outside any plausible allocation, including the 16-bit `nobody`
        // conventions (65534) and systemd's dynamic-user range.
        let absent = u32::MAX - 3;
        let err = home_for_uid(absent)
            .expect_err("a uid with no passwd entry must never resolve to a home");
        assert!(
            err.to_string().contains(&absent.to_string()) || err.raw_os_error().is_some(),
            "unhelpful error: {err}"
        );
    }

    #[test]
    fn root_resolves_when_the_machine_has_a_passwd_file() {
        // Not an assertion about the value: `/root` on Linux, `/var/root` on
        // macOS, and neither is guaranteed. Only that a real entry resolves to
        // an absolute path through the same code path as everything else.
        if let Ok(home) = home_for_uid(0) {
            assert!(home.is_absolute(), "{home:?}");
        }
    }
}
