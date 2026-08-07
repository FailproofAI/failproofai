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
///
/// Derived from [`failproofai_home`] and NOT from `$HOME` directly, because the
/// CLI derives the same path from `FAILPROOFAI_HOME` (`fp-home.ts`'s `runDir`).
/// While this read `$HOME` unconditionally, setting `FAILPROOFAI_HOME` put the
/// two processes on different sockets: the daemon bound one, the hook looked for
/// the other, found nothing, and — on a `daemonConfigured` machine, which fails
/// closed — DENIED every tool call across all 11 CLIs, with a perfectly healthy
/// daemon running the whole time.
pub fn run_dir() -> io::Result<PathBuf> {
    if let Some(socket_override) = std::env::var_os("FAILPROOFAI_DAEMON_SOCKET") {
        let path = PathBuf::from(socket_override);
        return path
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::other("FAILPROOFAI_DAEMON_SOCKET has no parent directory"));
    }
    Ok(failproofai_home()?.join("run"))
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

/// `~/.failproofai/policies/cloud-policies` — where pulled deployments land.
/// The override keeps tests and development runs away from a user's real
/// policy directory.
///
/// The directory name is `cloud-policies`, matching `fp-home.ts`'s
/// `cloudPoliciesDir`, which is what the hook path actually reads. Layout 2
/// renamed it from `cloud-managed` and this function kept writing the old
/// name — so the daemon downloaded every deployment, verified it, wrote it to
/// disk, and the CLI read an empty directory and enforced nothing. Both halves
/// looked healthy; only the combination was broken.
pub fn cloud_managed_policy_dir() -> io::Result<PathBuf> {
    if let Some(path) = std::env::var_os("FAILPROOFAI_CLOUD_POLICY_DIR") {
        return Ok(PathBuf::from(path));
    }
    Ok(failproofai_home()?.join("policies").join("cloud-policies"))
}

// ── Layout 2 ─────────────────────────────────────────────────────────────────
//
// These MUST mirror `src/hooks/fp-home.ts` exactly. The daemon and the CLI are
// separate processes with separate path logic, so a divergence does not fail —
// it means the daemon writes where the dashboard never reads, and an absent
// directory is indistinguishable from an idle one.
//
// `every_mirrored_path_agrees_with_fp_home_ts` at the bottom of this file is
// the guard: it queries the TypeScript module in a child process and compares,
// so adding a mirrored path means adding a row to `mirrored_paths()`. It
// replaces a citation of `crates/failproofaid/tests/layout.rs`, which was never
// created — three of these rows were wrong in production at once while this
// comment claimed they were covered.

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
/// `~/.failproofai/state/backfill-request.json` — a pending `failproofai
/// backfill`, waiting for the daemon to act on it.
///
/// A FILE rather than an IPC call, for two reasons. The CLI hands off and
/// returns immediately, so nothing is holding a connection to answer on; and a
/// request that outlives a daemon restart is the one a person expects — a
/// backfill asked for while the service happened to be cycling should still
/// happen, not vanish.
///
/// The daemon deletes it once acted on, so the file's existence IS the pending
/// state and there is no separate "done" flag to get out of step with it.
pub fn backfill_request_path() -> io::Result<PathBuf> {
    Ok(failproofai_home()?
        .join("state")
        .join("backfill-request.json"))
}

/// Where `failproofai flush` leaves its request. Same hand-off shape as the
/// backfill request: the CLI cannot deliver spooled batches itself (the
/// uploader's concurrency limiter and in-flight set live in the running
/// daemon, and a second uploader would POST the same files twice), so it
/// writes a request the daemon drains on its next tick.
pub fn flush_request_path() -> io::Result<PathBuf> {
    Ok(failproofai_home()?.join("state").join("flush-request.json"))
}

pub fn audit_schedule_path() -> io::Result<PathBuf> {
    Ok(failproofai_home()?
        .join("state")
        .join("audit-schedule.json"))
}

/// `~/.failproofai/state/telemetry-id` — the anonymous instance id the CLI
/// resolved, so the daemon reports under the SAME PostHog person the CLI does.
///
/// Mirrored for the same reason `audit_schedule_path` is, with the direction
/// reversed: the CLI is the sole writer (`getInstanceId()` in
/// `lib/telemetry-id.ts`) and the daemon only reads. Two path expressions would
/// not fail — the daemon would simply never find the file, fall to a tier it can
/// recompute, and file this machine under a second person that looks exactly
/// like a second machine.
/// Takes the home rather than resolving it, unlike its neighbours: its only
/// caller (the telemetry lane) already holds one, and passing it is what lets
/// the identity ladder be tested against a scratch directory without mutating
/// process-global environment under a parallel test harness.
pub fn telemetry_id_path(home: &std::path::Path) -> PathBuf {
    home.join("state").join("telemetry-id")
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
            std::env::remove_var("FAILPROOFAI_HOME");
            std::env::set_var("HOME", "/home/example-user");
        }
        assert_eq!(
            socket_path().unwrap(),
            PathBuf::from("/home/example-user/.failproofai/run/failproofaid.sock")
        );
    }

    #[test]
    fn the_socket_follows_failproofai_home_because_the_cli_does() {
        // The regression this exists for: while `run_dir` read `$HOME`
        // directly, setting FAILPROOFAI_HOME put the daemon on one socket and
        // the hook on another (`fp-home.ts`'s `runDir` has always honoured it).
        // A daemon-configured machine fails closed when it cannot reach the
        // daemon — so a HEALTHY daemon denied every tool call across all 11
        // CLIs, and the only symptom was the generic "could not be reached".
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::remove_var("FAILPROOFAI_DAEMON_SOCKET");
            std::env::set_var("HOME", "/home/example-user");
            std::env::set_var("FAILPROOFAI_HOME", "/tmp/alt-home");
        }
        assert_eq!(
            socket_path().unwrap(),
            PathBuf::from("/tmp/alt-home/run/failproofaid.sock")
        );
        assert_eq!(
            worker_socket_path().unwrap(),
            PathBuf::from("/tmp/alt-home/run/worker.sock")
        );
        assert_eq!(
            lock_path().unwrap(),
            PathBuf::from("/tmp/alt-home/run/failproofaid.lock")
        );
        unsafe {
            std::env::remove_var("FAILPROOFAI_HOME");
        }
    }

    #[test]
    fn pulled_policies_land_where_the_cli_reads_them() {
        // `fp-home.ts`: `cloudPoliciesDir = policies/cloud-policies`. This
        // wrote layout 1's `policies/cloud-managed`, so the daemon downloaded
        // every deployment, verified its hashes, wrote it to disk — and the CLI
        // read an empty directory and enforced nothing. Both halves logged
        // success; only the combination was broken.
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::remove_var("FAILPROOFAI_CLOUD_POLICY_DIR");
            std::env::set_var("FAILPROOFAI_HOME", "/tmp/alt-home");
        }
        assert_eq!(
            cloud_managed_policy_dir().unwrap(),
            PathBuf::from("/tmp/alt-home/policies/cloud-policies")
        );
        unsafe {
            std::env::remove_var("FAILPROOFAI_HOME");
            std::env::set_var("HOME", "/home/example-user");
        }
        assert_eq!(
            cloud_managed_policy_dir().unwrap(),
            PathBuf::from("/home/example-user/.failproofai/policies/cloud-policies")
        );
    }

    #[test]
    fn every_runtime_path_shares_one_home() {
        // Two notions of "the failproofai home" in one process is the shape of
        // all three bugs above: some paths read `$HOME/.failproofai` and the
        // rest read FAILPROOFAI_HOME, so the daemon silently split itself
        // across two directories.
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::remove_var("FAILPROOFAI_DAEMON_SOCKET");
            std::env::remove_var("FAILPROOFAI_CLOUD_POLICY_DIR");
            std::env::set_var("HOME", "/home/example-user");
            std::env::set_var("FAILPROOFAI_HOME", "/tmp/one-home");
        }
        for path in [
            run_dir().unwrap(),
            cloud_managed_policy_dir().unwrap(),
            hook_activity_dir().unwrap(),
            cursors_dir().unwrap(),
        ] {
            assert!(
                path.starts_with("/tmp/one-home"),
                "{} escaped FAILPROOFAI_HOME",
                path.display()
            );
        }
        unsafe {
            std::env::remove_var("FAILPROOFAI_HOME");
        }
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

    /// Every path this file and `fp-home.ts` must both resolve the same way,
    /// as `(rust value, the `fp-home.ts` export that must equal it)`.
    ///
    /// Add a row whenever a path is mirrored. A Rust-only or TS-only path does
    /// NOT belong here — see the note above `failproofai_home` about the
    /// collector deriving its own paths from the home it is handed.
    fn mirrored_paths() -> Vec<(&'static str, PathBuf, &'static str)> {
        vec![
            ("run_dir", run_dir().unwrap(), "runDir()"),
            ("socket_path", socket_path().unwrap(), "daemonSocket()"),
            (
                "worker_socket_path",
                worker_socket_path().unwrap(),
                "workerSocket()",
            ),
            ("lock_path", lock_path().unwrap(), "daemonLock()"),
            (
                "cloud_managed_policy_dir",
                cloud_managed_policy_dir().unwrap(),
                "cloudPoliciesDir()",
            ),
            (
                "hook_activity_dir",
                hook_activity_dir().unwrap(),
                "hookActivityDir()",
            ),
            ("cursors_dir", cursors_dir().unwrap(), "cursorsDir()"),
            (
                "audit_schedule_path",
                audit_schedule_path().unwrap(),
                "auditScheduleFile()",
            ),
            (
                "telemetry_id_path",
                telemetry_id_path(&failproofai_home().unwrap()),
                "telemetryIdFile()",
            ),
            (
                "cloud_client::credentials_path",
                crate::cloud_client::credentials_path().unwrap(),
                "credentialsFile()",
            ),
        ]
    }

    /// The cross-language guard this file's header has always claimed.
    ///
    /// Two processes, two path expressions, and a divergence that does not
    /// fail — it means the daemon writes where the CLI never reads, and an
    /// absent directory is indistinguishable from an idle one. Three rows here
    /// were live bugs at once: `run_dir` read `$HOME` while the CLI honoured
    /// `FAILPROOFAI_HOME` (so a healthy daemon denied every tool call on a
    /// fail-closed machine), `cloud_managed_policy_dir` still wrote layout 1's
    /// `cloud-managed` (so every verified deployment landed in a directory
    /// nothing opened), and the credential moved to `credentials.toml` on one
    /// side only (so `--connect` wrote a token the daemon never read). Each was
    /// fixed by hand; nothing stopped the next one, and BOTH files cited a test
    /// that did not exist — `fp-home.ts` named `__tests__/hooks/fp-home.test.ts`
    /// (no reference to `crates/`) and this file named
    /// `crates/failproofaid/tests/layout.rs` (never created).
    ///
    /// It asks the OTHER implementation rather than restating its answers:
    /// hardcoding the expected strings here — which the tests above do, and
    /// which is why they all passed while all three rows were wrong — only
    /// pins Rust against Rust.
    #[test]
    fn every_mirrored_path_agrees_with_fp_home_ts() {
        let _guard = ENV_LOCK.lock().unwrap();

        let home =
            std::env::temp_dir().join(format!("failproofaid-layout-parity-{}", std::process::id()));
        unsafe {
            // Both overrides off: they short-circuit the very derivation under
            // test, and a green run with them set is what let the cloud rows
            // stay broken in production for as long as they did.
            std::env::remove_var("FAILPROOFAI_DAEMON_SOCKET");
            std::env::remove_var("FAILPROOFAI_WORKER_SOCKET");
            std::env::remove_var("FAILPROOFAI_CLOUD_POLICY_DIR");
            std::env::remove_var("FAILPROOFAI_CLOUD_CREDENTIALS");
            std::env::set_var("FAILPROOFAI_HOME", &home);
        }

        let rows = mirrored_paths();

        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("crates/failproofaid should be two levels under the repo root")
            .to_path_buf();
        let fp_home_ts = repo_root.join("src").join("hooks").join("fp-home.ts");
        assert!(fp_home_ts.exists(), "expected {fp_home_ts:?} to exist");

        // Ask the TypeScript module itself, in a child process that sees the
        // same FAILPROOFAI_HOME.
        let script = format!(
            "const m = await import({:?}); console.log(JSON.stringify({{{}}}));",
            fp_home_ts.to_string_lossy(),
            rows.iter()
                .map(|(name, _, ts_expr)| format!("{name:?}: m.{ts_expr}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let out = std::process::Command::new("bun")
            .arg("-e")
            .arg(&script)
            .env("FAILPROOFAI_HOME", &home)
            .env_remove("FAILPROOFAI_DAEMON_SOCKET")
            .env_remove("FAILPROOFAI_WORKER_SOCKET")
            .env_remove("FAILPROOFAI_CLOUD_POLICY_DIR")
            .env_remove("FAILPROOFAI_CLOUD_CREDENTIALS")
            .output()
            .expect("bun must be on PATH — the rust-quality CI job installs it");
        assert!(
            out.status.success(),
            "querying fp-home.ts failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let ts: serde_json::Value =
            serde_json::from_slice(&out.stdout).expect("fp-home.ts must print one JSON object");

        for (name, rust_value, ts_expr) in &rows {
            let ts_value = ts
                .get(name)
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| panic!("fp-home.ts returned nothing for {name}"));
            assert_eq!(
                rust_value.to_string_lossy(),
                ts_value,
                "paths.rs::{name} and fp-home.ts's {ts_expr} disagree — the daemon \
                 would write where the CLI never reads"
            );
        }

        unsafe {
            std::env::remove_var("FAILPROOFAI_HOME");
        }
    }
}
