//! Verifies that a Unix socket peer is running as the same OS user as this
//! process.
//!
//! failproofaid's service definition is installed system-wide but runs the
//! process as the configured user. The socket directory is `0700` and the
//! socket file `0600`. This check is a second, defense-in-depth
//! layer against the narrow window between a socket file existing and its
//! permissions having been fully applied, and against misconfigured
//! filesystems (e.g. a shared mount with unexpectedly loose permissions).
//! It is not a stronger security boundary than the filesystem permissions
//! already provide — same OS user can always reach this daemon regardless.

use std::io;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;

/// Returns the effective UID of the process on the other end of `stream`.
#[cfg(target_os = "linux")]
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    use std::mem;

    let fd = stream.as_raw_fd();
    let mut cred: libc::ucred = unsafe { mem::zeroed() };
    let mut len = mem::size_of::<libc::ucred>() as libc::socklen_t;

    let ret = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut libc::ucred as *mut libc::c_void,
            &mut len,
        )
    };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(cred.uid)
}

/// Returns the effective UID of the process on the other end of `stream`.
#[cfg(target_os = "macos")]
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let fd = stream.as_raw_fd();
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;

    let ret = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

/// Returns this process's own effective UID, for comparison against
/// [`peer_uid`].
pub fn own_uid() -> u32 {
    unsafe { libc::geteuid() }
}

/// `true` if `stream`'s peer is running as this process's own OS user.
pub fn is_same_user(stream: &UnixStream) -> io::Result<bool> {
    Ok(peer_uid(stream)? == own_uid())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_socketpair_peer_is_always_the_same_user() {
        // socketpair() connects two ends of the same process — the peer
        // UID must equal our own, on every CI runner regardless of who's
        // executing the test.
        let (a, _b) = UnixStream::pair().unwrap();
        assert!(is_same_user(&a).unwrap());
        assert_eq!(peer_uid(&a).unwrap(), own_uid());
    }
}
