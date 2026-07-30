//! `failproofaid` — the failproofai local enforcement daemon.
//!
//! Stage 1 usage:
//!
//! ```text
//! failproofaid --socket /run/failproofai/failproofaid.sock
//! ```
//!
//! The privileged install that creates that directory, registers the service,
//! and creates the `_failproofai` account is Stage 3. Until then the binary is
//! run directly with an explicit socket path, which is how the test suite and
//! the parity harness drive it.

use std::process::ExitCode;

use failproofaid::server::Daemon;

const DEFAULT_SOCKET: &str = "/run/failproofai/failproofaid.sock";

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut socket =
        std::env::var("FAILPROOFAI_DAEMON_SOCKET").unwrap_or_else(|_| DEFAULT_SOCKET.into());

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => match args.next() {
                Some(path) => socket = path,
                None => {
                    eprintln!("--socket requires a path");
                    return ExitCode::from(2);
                }
            },
            "--version" => {
                println!("{}", env!("CARGO_PKG_VERSION"));
                return ExitCode::SUCCESS;
            }
            "--help" | "-h" => {
                println!(
                    "failproofaid {}\n\n\
                     USAGE\n  \
                     failproofaid [--socket <path>]\n\n\
                     The socket path also reads from $FAILPROOFAI_DAEMON_SOCKET.\n\
                     Default: {DEFAULT_SOCKET}",
                    env!("CARGO_PKG_VERSION")
                );
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("unknown argument: {other}");
                return ExitCode::from(2);
            }
        }
    }

    // Binding returns only once the sealed bundle has loaded, so a failure here
    // is a failed start rather than a daemon that accepts traffic it cannot
    // answer. `Type=notify` on the systemd unit depends on that ordering.
    let daemon = match Daemon::bind(&socket) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[failproofaid] failed to start on {socket}: {e}");
            return ExitCode::FAILURE;
        }
    };

    eprintln!(
        "[failproofaid] listening on {} (generation {})",
        daemon.socket_path().display(),
        daemon.generation_id()
    );

    if let Err(e) = daemon.serve() {
        eprintln!("[failproofaid] listener stopped: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
