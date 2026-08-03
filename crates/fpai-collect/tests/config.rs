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
        let path = home.join("ingest.json");
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
    fs::write(home.join("ingest.json"), r#"{"key":"abc"}"#).unwrap();

    let cfg = without_env_overrides(|| config::load(&home).unwrap());
    let ingest = cfg.ingest.unwrap();
    assert_eq!(ingest.url, DEFAULT_INGEST_URL);
    assert_eq!(ingest.key, "abc");

    // A self-hoster replaces the whole endpoint, path included.
    fs::write(
        home.join("ingest.json"),
        r#"{"key":"abc","url":"http://localhost:8080/events"}"#,
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
    fs::write(home.join("ingest.json"), r#"{"key":"   "}"#).unwrap();
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
    fs::write(home.join("ingest.json"), r#"{"key": "abc",}"#).unwrap();
    let err = without_env_overrides(|| config::load(&home)).unwrap_err();
    assert!(
        format!("{err}").contains("not valid JSON"),
        "expected a JSON error, got: {err}"
    );
    fs::remove_dir_all(&home).ok();
}

#[test]
fn settings_come_from_the_policies_config_collector_block() {
    let home = tmp_home("settings");
    fs::write(home.join("ingest.json"), r#"{"key":"abc"}"#).unwrap();
    fs::write(
        home.join("policies-config.json"),
        r#"{"enabledPolicies":["block-sudo"],
            "collector":{"sessions":true,"hooksVerbosity":"all","redact":"off","environment":"ci"}}"#,
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
fn a_policies_config_with_no_collector_block_uses_defaults() {
    // Every existing install is this case; it must not error or change.
    let home = tmp_home("nocollector");
    fs::write(home.join("ingest.json"), r#"{"key":"abc"}"#).unwrap();
    fs::write(
        home.join("policies-config.json"),
        r#"{"enabledPolicies":[]}"#,
    )
    .unwrap();

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
    fs::write(home.join("ingest.json"), r#"{"key":"abc"}"#).unwrap();
    fs::write(
        home.join("policies-config.json"),
        r#"{"collector":{"environment":"local,ci"}}"#,
    )
    .unwrap();

    let err = without_env_overrides(|| config::load(&home)).unwrap_err();
    assert!(format!("{err}").contains("comma"), "got: {err}");
    fs::remove_dir_all(&home).ok();
}

#[test]
fn the_sdk_spool_directory_is_watched_alongside_our_own() {
    // This is what lets failproofaid supersede agenteye-collector without
    // every Python SDK user reconfiguring anything.
    let home = tmp_home("spooldirs");
    let cfg = without_env_overrides(|| config::load(&home).unwrap());

    assert_eq!(cfg.spool_dirs[0], cfg.own_spool_dir);
    assert_eq!(cfg.own_spool_dir, home.join("spool"));
    assert!(
        cfg.spool_dirs
            .iter()
            .any(|d| d.ends_with("events") && d.to_string_lossy().contains("agenteye")),
        "the SDK's drop directory must be watched too, got {:?}",
        cfg.spool_dirs
    );
    fs::remove_dir_all(&home).ok();
}
