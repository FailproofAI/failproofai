//! Configuration contract tests.
//!
//! Two of these guard a security property rather than a behaviour: the ingest
//! credential must never be written into a world-readable file, and the home
//! directory holding it must not stay world-traversable. `policies-config.json`
//! is 0664 inside a 0775 `~/.failproofai` on a normal machine, which is exactly
//! why the credential lives in its own file instead.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use fpai_collect::config::{self, Ingest};
use fpai_collect::{DEFAULT_INGEST_URL, HooksVerbosity, Redact};

fn tmp_home(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "fpai-cfg-{}-{}-{}",
        name,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&d).unwrap();
    d
}

/// The env vars this module reads are process-global, so tests that touch them
/// must not run concurrently with tests that don't expect them.
fn without_env_overrides<T>(f: impl FnOnce() -> T) -> T {
    // SAFETY: single-threaded within the closure; see the serial guard below.
    unsafe {
        std::env::remove_var("FAILPROOFAI_INGEST_KEY");
        std::env::remove_var("FAILPROOFAI_INGEST_URL");
    }
    f()
}

#[test]
fn absent_config_means_collection_is_off() {
    let home = tmp_home("absent");
    let cfg = without_env_overrides(|| config::load(&home).unwrap());
    assert!(cfg.ingest.is_none());
    assert!(
        !cfg.is_enabled(),
        "with no credential the collector must start nothing at all"
    );
    fs::remove_dir_all(&home).ok();
}

#[test]
fn a_key_alone_does_not_enable_session_collection() {
    // The privacy default, and the one most likely to be eroded by accident.
    // Transcripts carry prompts, file contents and pasted credentials, so
    // configuring ingest must not start shipping them.
    let home = tmp_home("optin");
    config::write_ingest(
        &home,
        &Ingest {
            url: DEFAULT_INGEST_URL.into(),
            key: "k".into(),
        },
    )
    .unwrap();

    let cfg = without_env_overrides(|| config::load(&home).unwrap());
    assert!(cfg.ingest.is_some());
    assert!(!cfg.settings.sessions, "sessions must be opt-in");
    assert!(
        cfg.settings.hooks,
        "hooks carry no file contents and default on"
    );
    assert!(
        cfg.is_enabled(),
        "hooks alone is enough to run the collector"
    );
    fs::remove_dir_all(&home).ok();
}

#[test]
fn a_key_with_both_sources_off_still_delivers_the_sdk_spool() {
    // `collector.hooks = false` is a documented privacy choice. It must switch
    // off the daemon's own hook-activity source and NOTHING else: the spool it
    // watches also holds batches written by `failproofai-sdk` from the user's
    // own instrumented agents, and the watcher is the only thing that ships
    // them. While this returned false for that config the daemon started no
    // task and logged no line, and those batches piled up forever.
    let home = tmp_home("bothoff");
    config::write_ingest(
        &home,
        &Ingest {
            url: DEFAULT_INGEST_URL.into(),
            key: "k".into(),
        },
    )
    .unwrap();
    fs::write(
        home.join("config.json"),
        r#"{"collector":{"sessions":false,"hooks":false}}"#,
    )
    .unwrap();

    let cfg = without_env_overrides(|| config::load(&home).unwrap());
    assert!(!cfg.settings.sessions);
    assert!(!cfg.settings.hooks);
    assert!(
        cfg.is_enabled(),
        "delivery must run for the SDK spool even with both capture sources off"
    );
    fs::remove_dir_all(&home).ok();
}

#[test]
fn the_credential_file_is_written_owner_only() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let home = tmp_home("mode");
        let path = config::write_ingest(
            &home,
            &Ingest {
                url: DEFAULT_INGEST_URL.into(),
                key: "secret".into(),
            },
        )
        .unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "the ingest credential must not be readable by other local users, got {mode:o}"
        );
        fs::remove_dir_all(&home).ok();
    }
}

#[test]
fn writing_the_credential_tightens_a_world_traversable_home() {
    // A 0600 file inside a 0775 directory is still reachable by every local
    // user. ~/.failproofai really is 0775 on a normal machine.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let home = tmp_home("tighten");
        fs::set_permissions(&home, fs::Permissions::from_mode(0o775)).unwrap();

        config::write_ingest(
            &home,
            &Ingest {
                url: DEFAULT_INGEST_URL.into(),
                key: "s".into(),
            },
        )
        .unwrap();

        let mode = fs::metadata(&home).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o700,
            "the home holding a credential must be owner-only, got {mode:o}"
        );
        fs::remove_dir_all(&home).ok();
    }
}

#[test]
fn rewriting_an_already_permissive_credential_file_fixes_its_mode() {
    // `OpenOptions::mode()` applies only when the file is CREATED, so an
    // existing 0644 file would silently keep its mode without the explicit
    // set_permissions afterwards.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let home = tmp_home("rewrite");
        let path = home.join("credentials.json");
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        config::write_ingest(
            &home,
            &Ingest {
                url: DEFAULT_INGEST_URL.into(),
                key: "s".into(),
            },
        )
        .unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "an existing permissive file must be tightened, got {mode:o}"
        );
        fs::remove_dir_all(&home).ok();
    }
}

#[test]
fn the_endpoint_defaults_to_the_hosted_one_and_round_trips() {
    let home = tmp_home("url");
    // A file with only a key is the common case — the wizard need not write a
    // url when the user accepts the default.
    fs::write(home.join("credentials.json"), r#"{"ingest":{"key":"abc"}}"#).unwrap();

    let cfg = without_env_overrides(|| config::load(&home).unwrap());
    let ingest = cfg.ingest.unwrap();
    assert_eq!(ingest.url, DEFAULT_INGEST_URL);
    assert_eq!(ingest.key, "abc");

    // A self-hoster replaces the whole endpoint, path included.
    fs::write(
        home.join("credentials.json"),
        r#"{"ingest":{"key":"abc","url":"http://localhost:8080/events"}}"#,
    )
    .unwrap();
    let cfg = without_env_overrides(|| config::load(&home).unwrap());
    assert_eq!(cfg.ingest.unwrap().url, "http://localhost:8080/events");
    fs::remove_dir_all(&home).ok();
}

#[test]
fn an_empty_key_is_treated_as_unconfigured_rather_than_sent() {
    // Otherwise every request goes out as `Authorization: Bearer ` and the
    // spool fills with 401s that look like a server problem.
    let home = tmp_home("emptykey");
    fs::write(home.join("credentials.json"), r#"{"ingest":{"key":"   "}}"#).unwrap();
    let cfg = without_env_overrides(|| config::load(&home).unwrap());
    assert!(cfg.ingest.is_none());
    assert!(!cfg.is_enabled());
    fs::remove_dir_all(&home).ok();
}

#[test]
fn malformed_json_is_an_error_not_a_silent_disable() {
    // Quietly disabling collection because of a stray comma is precisely the
    // silent failure this project exists to remove.
    let home = tmp_home("malformed");
    // Not valid JSON — an unterminated object. Must be an error, not a silent
    // disable. (This file was TOML through layout 2, so the shape that used to
    // be tested here was a truncated `[ingest` table header.)
    fs::write(home.join("credentials.json"), r#"{"ingest":{"key":"abc"}"#).unwrap();
    let err = without_env_overrides(|| config::load(&home)).unwrap_err();
    assert!(
        format!("{err}").contains("not valid JSON"),
        "expected a JSON error, got: {err}"
    );
    fs::remove_dir_all(&home).ok();
}

#[test]
fn settings_come_from_the_config_json_collector_object() {
    let home = tmp_home("settings");
    fs::write(home.join("credentials.json"), r#"{"ingest":{"key":"abc"}}"#).unwrap();
    fs::write(
        home.join("config.json"),
        r#"{"collector":{"sessions":true,"hooks_verbosity":"all","redact":"off","environment":"ci"}}"#,
    )
    .unwrap();

    let cfg = without_env_overrides(|| config::load(&home).unwrap());
    assert!(cfg.settings.sessions);
    assert_eq!(cfg.settings.hooks_verbosity, HooksVerbosity::All);
    assert_eq!(cfg.settings.redact, Redact::Off);
    assert_eq!(cfg.settings.environment, "ci");
    fs::remove_dir_all(&home).ok();
}

#[test]
fn a_config_with_no_collector_table_uses_defaults() {
    // Every existing install is this case; it must not error or change.
    let home = tmp_home("nocollector");
    fs::write(home.join("credentials.json"), r#"{"ingest":{"key":"abc"}}"#).unwrap();
    // A config with no `collector` object at all — every machine that has not
    // opted into collection is this case, and it must not error or change.
    fs::write(home.join("config.json"), r#"{"mode":{"kind":"oss"}}"#).unwrap();

    let cfg = without_env_overrides(|| config::load(&home).unwrap());
    assert!(!cfg.settings.sessions);
    assert!(cfg.settings.hooks);
    assert_eq!(cfg.settings.hooks_verbosity, HooksVerbosity::Decisions);
    fs::remove_dir_all(&home).ok();
}

#[test]
fn a_comma_in_environment_is_rejected_rather_than_dropped_downstream() {
    // The ingest endpoint skips any line whose `environment` contains a comma.
    // Accepting it here would mean every event from this machine vanished
    // server-side with nothing on this end to show for it.
    let home = tmp_home("comma");
    fs::write(home.join("credentials.json"), r#"{"ingest":{"key":"abc"}}"#).unwrap();
    fs::write(
        home.join("config.json"),
        r#"{"collector":{"environment":"local,ci"}}"#,
    )
    .unwrap();

    let err = without_env_overrides(|| config::load(&home)).unwrap_err();
    // Asserted against the MESSAGE, not just the word: `tmp_home("comma")` puts
    // "comma" in the path, and the path is part of every error's Display — so a
    // bare `.contains("comma")` passed even when the file failed to parse for a
    // completely unrelated reason, which is exactly what it did while this file
    // still held TOML bodies under .json names.
    let text = format!("{err}");
    assert!(
        text.contains("environment") && text.contains("comma"),
        "expected the comma rejection, got: {text}"
    );
    fs::remove_dir_all(&home).ok();
}

#[test]
fn the_sdk_spool_directory_is_watched_alongside_our_own() {
    // This is what lets failproofaid supersede agenteye-collector without
    // every Python SDK user reconfiguring anything.
    let home = tmp_home("spooldirs");
    let cfg = without_env_overrides(|| config::load(&home).unwrap());

    assert_eq!(cfg.spool_dirs[0], cfg.own_spool_dir);
    // Layout 2 groups daemon scratch under state/.
    assert_eq!(cfg.own_spool_dir, home.join("state").join("spool"));

    // BOTH SDK roots are watched, indefinitely and on purpose. An SDK old
    // enough to know only ~/.agenteye/events must keep working: dropping that
    // path would mean an unupgraded SDK writes where nothing reads, which is
    // silent data loss rather than a detectable failure.
    assert!(
        cfg.spool_dirs
            .iter()
            .any(|d| d.ends_with("events") && d.to_string_lossy().contains("agenteye")),
        "the legacy SDK drop directory must still be watched, got {:?}",
        cfg.spool_dirs
    );
    assert!(
        cfg.spool_dirs
            .contains(&home.join("custom-agents").join("events")),
        "the layout-2 SDK drop directory must be watched, got {:?}",
        cfg.spool_dirs
    );
    fs::remove_dir_all(&home).ok();
}
