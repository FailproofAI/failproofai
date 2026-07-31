//! The Unix-socket server: bind, accept, verify the peer, dispatch one
//! request per connection.
//!
//! Stage 2 scope only — `Hook` requests get an `Error` response saying so.
//! Wiring `Hook` up to a real warm Node/Bun worker is Stage 3's job (see
//! the plan's suggested implementation sequence); this stage proves the
//! socket, the framing, the protocol-version handshake, and peer
//! verification end to end with nothing downstream to depend on yet.

use fpai_ipc::{ClientMessage, PROTOCOL_VERSION, ServerMessage, peer, read_message, write_message};
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub struct Server {
    listener: UnixListener,
    socket_path: PathBuf,
}

impl Server {
    /// Binds a fresh listener at `socket_path`, replacing a stale socket
    /// file left behind by a process that didn't shut down cleanly (a live
    /// daemon is never listening on a leftover file — the singleton lock in
    /// `lock.rs` is what actually prevents two daemons; this only clears
    /// the debris of one that's already gone).
    pub fn bind(socket_path: &Path) -> io::Result<Self> {
        if socket_path.exists() {
            fs::remove_file(socket_path)?;
        }
        let listener = UnixListener::bind(socket_path)?;
        fs::set_permissions(socket_path, fs::Permissions::from_mode(0o600))?;
        Ok(Server {
            listener,
            socket_path: socket_path.to_path_buf(),
        })
    }

    /// Accepts and handles connections, one thread per connection, until
    /// `shutdown` is set to `true`. A short accept timeout keeps the loop
    /// polling `shutdown` instead of blocking forever in `accept()`, which
    /// is what lets tests stop a server cleanly instead of leaking a
    /// blocked thread for the rest of the test process's life.
    pub fn run_until(&self, shutdown: Arc<AtomicBool>) -> io::Result<()> {
        self.listener.set_nonblocking(true)?;
        while !shutdown.load(Ordering::Relaxed) {
            match self.listener.accept() {
                Ok((stream, _addr)) => {
                    std::thread::spawn(move || {
                        if let Err(err) = handle_connection(stream) {
                            log_connection_error(&err);
                        }
                    });
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(err) => return Err(err),
            }
        }
        Ok(())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket_path);
    }
}

fn log_connection_error(err: &io::Error) {
    eprintln!("[failproofaid] connection error: {err}");
}

/// Handles exactly one request on `stream`: verify the peer is the same OS
/// user, read one framed [`ClientMessage`], dispatch it, write back one
/// framed [`ServerMessage`], then let the connection close.
pub fn handle_connection(stream: UnixStream) -> io::Result<()> {
    match peer::is_same_user(&stream) {
        Ok(true) => {}
        Ok(false) => {
            // Different OS user: drop the connection with no response at
            // all, rather than an Error message that would confirm a
            // daemon is listening here to a peer that has no business
            // asking.
            return Ok(());
        }
        Err(err) => return Err(err),
    }

    let mut reader = stream.try_clone()?;
    let mut writer = stream;

    let request: ClientMessage = match read_message(&mut reader) {
        Ok(msg) => msg,
        Err(_) => return Ok(()), // malformed frame: nothing to respond to, nothing to act on
    };

    let response = dispatch(request);
    write_message(&mut writer, &response)
        .map_err(|e| io::Error::other(format!("failed to write response: {e}")))
}

fn dispatch(request: ClientMessage) -> ServerMessage {
    if request.protocol_version() != PROTOCOL_VERSION {
        return ServerMessage::Error {
            protocol_version: PROTOCOL_VERSION,
            message: format!(
                "protocol version mismatch: daemon speaks {PROTOCOL_VERSION}, client sent {}",
                request.protocol_version()
            ),
        };
    }

    match request {
        ClientMessage::Ping { .. } => ServerMessage::Pong {
            protocol_version: PROTOCOL_VERSION,
        },
        ClientMessage::Hook { .. } => ServerMessage::Error {
            protocol_version: PROTOCOL_VERSION,
            message: "hook evaluation is not wired up in this daemon build yet".to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    fn temp_socket_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "failproofaid-server-test-{}-{}-{}",
            std::process::id(),
            name,
            fastrand_ish()
        ))
    }

    // Avoids pulling in a `rand` dependency just to de-collide temp socket
    // paths across tests running in parallel threads.
    fn fastrand_ish() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
    }

    fn start_test_server(socket_path: PathBuf) -> (Arc<AtomicBool>, std::thread::JoinHandle<()>) {
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = shutdown.clone();
        let handle = std::thread::spawn(move || {
            let server = Server::bind(&socket_path).expect("bind should succeed");
            server
                .run_until(shutdown_clone)
                .expect("run_until should not error");
        });
        // Give the background thread a moment to actually bind before the
        // test tries to connect.
        std::thread::sleep(Duration::from_millis(50));
        (shutdown, handle)
    }

    #[test]
    fn ping_gets_pong() {
        let socket_path = temp_socket_path("ping");
        let (shutdown, handle) = start_test_server(socket_path.clone());

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &ClientMessage::Ping {
                protocol_version: PROTOCOL_VERSION,
            },
        )
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).unwrap();
        assert_eq!(
            response,
            ServerMessage::Pong {
                protocol_version: PROTOCOL_VERSION
            }
        );

        shutdown.store(true, Ordering::Relaxed);
        handle.join().unwrap();
    }

    #[test]
    fn hook_request_gets_a_not_yet_implemented_error_in_this_stage() {
        let socket_path = temp_socket_path("hook-stub");
        let (shutdown, handle) = start_test_server(socket_path.clone());

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &ClientMessage::Hook {
                protocol_version: PROTOCOL_VERSION,
                hook_event: "PreToolUse".to_string(),
                cli: "claude".to_string(),
                stdin: "{}".to_string(),
                cwd: None,
            },
        )
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).unwrap();
        match response {
            ServerMessage::Error { .. } => {}
            other => panic!("expected Error, got {other:?}"),
        }

        shutdown.store(true, Ordering::Relaxed);
        handle.join().unwrap();
    }

    #[test]
    fn mismatched_protocol_version_gets_an_explicit_error() {
        let socket_path = temp_socket_path("version-mismatch");
        let (shutdown, handle) = start_test_server(socket_path.clone());

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &ClientMessage::Ping {
                protocol_version: PROTOCOL_VERSION + 999,
            },
        )
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).unwrap();
        match response {
            ServerMessage::Error { message, .. } => {
                assert!(message.contains("version"));
            }
            other => panic!("expected Error, got {other:?}"),
        }

        shutdown.store(true, Ordering::Relaxed);
        handle.join().unwrap();
    }

    #[test]
    fn bind_replaces_a_stale_socket_file() {
        let socket_path = temp_socket_path("stale");
        // Simulate a leftover file from a crashed daemon: not even a valid
        // socket, just a regular file at that path.
        std::fs::write(&socket_path, b"not a socket").unwrap();

        let server = Server::bind(&socket_path).expect("bind should clear the stale file");
        drop(server);
        assert!(
            !socket_path.exists(),
            "Drop should clean up the socket file"
        );
    }

    #[test]
    fn bound_socket_file_is_owner_only() {
        let socket_path = temp_socket_path("perms");
        let server = Server::bind(&socket_path).unwrap();
        let mode = std::fs::metadata(&socket_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        drop(server);
    }

    #[test]
    fn multiple_concurrent_pings_all_get_answered() {
        let socket_path = temp_socket_path("concurrent");
        let (shutdown, handle) = start_test_server(socket_path.clone());

        let clients: Vec<_> = (0..8)
            .map(|_| {
                let path = socket_path.clone();
                std::thread::spawn(move || {
                    let mut stream = UnixStream::connect(&path).unwrap();
                    write_message(
                        &mut stream,
                        &ClientMessage::Ping {
                            protocol_version: PROTOCOL_VERSION,
                        },
                    )
                    .unwrap();
                    let response: ServerMessage = read_message(&mut stream).unwrap();
                    assert_eq!(
                        response,
                        ServerMessage::Pong {
                            protocol_version: PROTOCOL_VERSION
                        }
                    );
                })
            })
            .collect();
        for c in clients {
            c.join().unwrap();
        }

        shutdown.store(true, Ordering::Relaxed);
        handle.join().unwrap();
    }
}
