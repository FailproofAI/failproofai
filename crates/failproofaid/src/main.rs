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

use failproofaid::paths::default_socket_path;
use failproofaid::server::Daemon;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    // User scope: $XDG_RUNTIME_DIR/failproofai/ when set, else
    // ~/.failproofai/run/. Nothing under /run, /opt or /var/lib — see
    // failproofaid::paths.
    let mut socket = match default_socket_path() {
        Some(path) => path.to_string_lossy().into_owned(),
        None => {
            eprintln!(
                "[failproofaid] cannot locate a socket directory: neither $XDG_RUNTIME_DIR \
                 nor $HOME is set. Pass --socket explicitly."
            );
            return ExitCode::from(2);
        }
    };

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
                     Runs as the invoking user. State lives in ~/.failproofai/ and\n\
                     ~/.agenteye/; nothing is installed with elevated privilege.\n\n\
                     SOCKET, in preference order\n  \
                     $FAILPROOFAI_DAEMON_SOCKET\n  \
                     $XDG_RUNTIME_DIR/failproofai/failproofaid.sock\n  \
                     ~/.failproofai/run/failproofaid.sock\n\n\
                     Resolved for this environment: {}",
                    env!("CARGO_PKG_VERSION"),
                    default_socket_path()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "<neither $XDG_RUNTIME_DIR nor $HOME is set>".into()),
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
