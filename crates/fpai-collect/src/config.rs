//! Collector configuration: where to send events, and what to collect.
//!
//! # Two files, on purpose
//!
//! Every credential lives in `~/.failproofai/credentials.toml` at mode 0600.
//! Everything else — which sources are on, backfill window, hook verbosity —
//! lives in `config.toml` under `[collector]`, beside the rest of the settings,
//! where it is readable, diffable and safe to commit to a dotfiles repo.
//!
//! That split is not tidiness. `config.toml` is written with a bare
//! `writeFileSync`, so it inherits the umask and lands at 0664 on a normal
//! machine — inside `~/.failproofai/`, which is itself 0775. Putting an API key
//! there would publish it to every local user on the box, which is exactly why
//! `ingest.json` and `cloud.json` were separate files before layout 2 merged
//! them into one owner-only file.
//!
//! # Disabled is the default, and it is a real default
//!
//! No `[ingest]` table, or one with no key, means collection is off: no tasks,
//! so no thread and no runtime (see [`crate::supervisor::spawn_supervised`]). A
//! machine that has not opted in pays nothing for this code existing. Session
//! collection additionally requires its own explicit opt-in, because
//! transcripts carry prompts, file contents and whatever the user pasted into
//! a terminal — configuring a key must not silently start shipping those.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The hosted ingest endpoint. A COMPLETE endpoint including its path, not a
/// base to join onto — byte-identical to what `agenteye-collector` defaults
/// to, so a migrated config needs no rewriting and a self-hoster replaces the
/// whole value with one of their own.
pub const DEFAULT_INGEST_URL: &str = "https://server.befailproof.ai/events";

/// Filename of the credential file inside the failproofai home.
/// Layout 2: every credential in one owner-only TOML file, keyed by table.
const CREDENTIALS_FILE: &str = "credentials.toml";
/// Layout 2: non-secret configuration, including the collector block.
const CONFIG_FILE: &str = "config.toml";

/// Mode the credential file must have. Anything wider is a finding.
#[cfg(unix)]
const CREDENTIAL_MODE: u32 = 0o600;

/// What the daemon needs in order to ship anything at all.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Ingest {
    /// Complete endpoint URL. Absent in the file means [`DEFAULT_INGEST_URL`].
    #[serde(default = "default_url")]
    pub url: String,
    /// An `events:add` API key, sent as a bearer token.
    pub key: String,
}

fn default_url() -> String {
    DEFAULT_INGEST_URL.to_string()
}

/// How much hook activity to ship.
///
/// Measured on a real machine: 19,339 rows over 17 days from one developer on
/// one CLI, of which 99.1% were plain `allow`. Emitting a triggered/completed
/// pair per row is ~38,700 events for that one machine, almost all of it
/// no-ops — hence a default that keeps every decision exact and rolls the rest
/// up rather than dropping it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum HooksVerbosity {
    /// Every hook invocation, in full.
    All,
    /// `deny` and `instruct` in full; `allow` aggregated per (session, event,
    /// tool) per minute. The aggregate carries a count, so the denominator
    /// survives — "we evaluated 19,000 calls and blocked 15" stays answerable.
    #[default]
    Decisions,
    /// No hook events at all.
    Off,
}

/// Client-side redaction strength.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Redact {
    /// A fixed, deterministic pattern set over tool inputs and outputs.
    /// Deterministic is load-bearing, not incidental: the server dedups on a
    /// content hash, so a redaction that varied between reads of the same
    /// bytes would defeat it.
    #[default]
    Minimal,
    /// Ship verbatim.
    Off,
}

/// The non-secret half, read from `config.toml` under `[collector]`.
///
/// snake_case keys, matching TOML convention and what `fp-config.ts` writes.
/// This was camelCase while the source was `policies-config.json`; carrying
/// that over would have meant every field silently falling back to its default.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Settings {
    /// Ship agent session transcripts. Defaults to FALSE and is deliberately
    /// separate from having a key: transcripts carry prompts, file contents
    /// and pasted credentials, so configuring ingest must not silently start
    /// sending them.
    #[serde(default)]
    pub sessions: bool,
    /// Ship hook activity. Defaults to TRUE once ingest is configured — it
    /// carries decisions and tool names, never file contents, and it is the
    /// capability that justifies collecting from inside failproofai at all.
    #[serde(default = "default_true")]
    pub hooks: bool,
    #[serde(default)]
    pub hooks_verbosity: HooksVerbosity,
    #[serde(default)]
    pub redact: Redact,
    /// Label stamped on every event. Rejected if it contains a comma: the
    /// ingest endpoint skips any line whose `environment` has one, so a comma
    /// here would silently drop every event this machine produced.
    #[serde(default = "default_environment")]
    pub environment: String,
    /// The id of the machine this daemon runs on, written by
    /// `failproofai config --connect --machine-id <id>`. Stamped on every
    /// collected event so the server groups by machine rather than by
    /// `agent_id` (a per-project identity). Absent on config written before
    /// this field existed; such events carry no machine.
    #[serde(default)]
    pub machine_id: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_environment() -> String {
    "local".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            sessions: false,
            hooks: true,
            hooks_verbosity: HooksVerbosity::default(),
            redact: Redact::default(),
            environment: default_environment(),
            machine_id: None,
        }
    }
}

/// Everything the collector needs, resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectorConfig {
    /// `None` means collection is off for this process.
    pub ingest: Option<Ingest>,
    pub settings: Settings,
    /// Directories watched for ready-to-upload event batches, in the order
    /// they are scanned.
    pub spool_dirs: Vec<PathBuf>,
    /// Where this daemon writes its own derived batches. Always the first
    /// entry of `spool_dirs`.
    pub own_spool_dir: PathBuf,
    /// Batches the server rejected, parked for retry.
    pub failed_dir: PathBuf,
}

impl CollectorConfig {
    /// True when there is a usable credential AND at least one stream enabled.
    /// This is what `collector_tasks()` keys off, so an unconfigured machine
    /// starts no thread and no runtime.
    pub fn is_enabled(&self) -> bool {
        self.ingest.is_some() && (self.settings.sessions || self.settings.hooks)
    }
}

#[derive(Debug)]
pub enum ConfigError {
    Io(io::Error),
    /// The file exists but is not valid JSON. Deliberately NOT treated as
    /// "absent": silently disabling collection because someone fat-fingered a
    /// comma is the kind of quiet failure this project exists to remove.
    Malformed {
        path: PathBuf,
        detail: String,
    },
    /// A value is present but unusable.
    Invalid(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Io(e) => write!(f, "{e}"),
            ConfigError::Malformed { path, detail } => {
                write!(f, "{} is not valid JSON: {detail}", path.display())
            }
            ConfigError::Invalid(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for ConfigError {}

impl From<io::Error> for ConfigError {
    fn from(e: io::Error) -> Self {
        ConfigError::Io(e)
    }
}

/// Resolve the collector's configuration.
///
/// `home` is the failproofai home (`~/.failproofai`), passed rather than
/// derived so tests need no environment mutation.
///
/// Precedence for the endpoint and key is env → file → default, matching every
/// other knob in this codebase. The env override exists for containers and for
/// local development against a stack on `localhost`, where writing a file to a
/// real home directory would be the wrong shape.
pub fn load(home: &Path) -> Result<CollectorConfig, ConfigError> {
    let ingest = load_ingest(home)?;
    let settings = load_settings(home)?;

    if settings.environment.contains(',') {
        // Fail here rather than let ingest silently skip every line. The
        // server splits on commas, so this is unrecoverable downstream and
        // invisible upstream — exactly the shape of bug worth erroring on.
        return Err(ConfigError::Invalid(format!(
            "collector environment {:?} contains a comma, which the ingest endpoint rejects; \
             every event from this machine would be silently dropped",
            settings.environment
        )));
    }

    // Layout 2 groups daemon scratch under state/, leaving the top level to
    // things a person would actually open. Mirrors `fp-home.ts`.
    let state_dir = home.join("state");
    let own_spool_dir = state_dir.join("spool");
    let failed_dir = state_dir.join("failed");

    // Watch our own derived batches first, then EVERY directory an SDK might
    // write to. Watching all of them is what lets failproofaid supersede
    // agenteye-collector without every SDK user having to reconfigure
    // anything: their events keep being collected, by a different daemon, with
    // no change on their side.
    //
    // Both SDK roots are watched deliberately and indefinitely. An SDK old
    // enough to write only `~/.agenteye/events` must keep working — migrating
    // it and dropping the old path would mean an unupgraded SDK writes to a
    // directory nothing reads, which is silent data loss rather than a
    // detectable failure.
    let mut spool_dirs = vec![own_spool_dir.clone()];
    for sdk_spool in [custom_agents_events_dir(home), agenteye_events_dir()] {
        if !spool_dirs.contains(&sdk_spool) {
            spool_dirs.push(sdk_spool);
        }
    }

    Ok(CollectorConfig {
        ingest,
        settings,
        spool_dirs,
        own_spool_dir,
        failed_dir,
    })
}

/// The layout-2 SDK spool root, under the failproofai home.
///
/// The destination an SDK should prefer once it knows about it; the legacy
/// `~/.agenteye/events` below stays watched regardless, so preferring this one
/// is an SDK-side improvement rather than a requirement.
fn custom_agents_events_dir(home: &Path) -> PathBuf {
    home.join("custom-agents").join("events")
}

/// The directory the AgentEye Python SDK drops event batches into. Honors
/// `AGENTEYE_HOME` for the same reason the SDK and collector do.
fn agenteye_events_dir() -> PathBuf {
    let base = std::env::var_os("AGENTEYE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".agenteye")))
        .unwrap_or_else(|| PathBuf::from(".agenteye"));
    base.join("events")
}

fn load_ingest(home: &Path) -> Result<Option<Ingest>, ConfigError> {
    let path = home.join(CREDENTIALS_FILE);

    let from_file: Option<Ingest> = match fs::read_to_string(&path) {
        Ok(text) => {
            warn_if_world_readable(&path);
            let doc: toml::Value = toml::from_str(&text).map_err(|e| ConfigError::Malformed {
                path: path.clone(),
                detail: e.to_string(),
            })?;
            // A credentials file with no [ingest] table is not malformed — it
            // is a machine connected for policy but not reporting, which is a
            // supported half-state.
            //
            // `url` DEFAULTS rather than being required: the wizard writes only
            // a key when the user accepts the hosted endpoint, so requiring it
            // would read a perfectly good credential as absent and silently
            // disable collection. Only `key` makes the table meaningful.
            doc.get("ingest").and_then(|t| {
                let key = t.get("key")?.as_str()?.to_string();
                let url = t
                    .get("url")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(default_url);
                Some(Ingest { url, key })
            })
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(ConfigError::Io(e)),
    };

    let key = env_nonempty("FAILPROOFAI_INGEST_KEY")
        .or_else(|| from_file.as_ref().map(|i| i.key.clone()));
    let url = env_nonempty("FAILPROOFAI_INGEST_URL")
        .or_else(|| from_file.as_ref().map(|i| i.url.clone()))
        .unwrap_or_else(default_url);

    // A file with an empty key is "configured but not really" — treat it as
    // absent rather than sending `Authorization: Bearer ` and collecting 401s.
    match key {
        Some(key) if !key.trim().is_empty() => Ok(Some(Ingest { url, key })),
        _ => Ok(None),
    }
}

fn load_settings(home: &Path) -> Result<Settings, ConfigError> {
    let path = home.join(CONFIG_FILE);
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Settings::default()),
        Err(e) => return Err(ConfigError::Io(e)),
    };

    let root: toml::Value = toml::from_str(&text).map_err(|e| ConfigError::Malformed {
        path: path.clone(),
        detail: e.to_string(),
    })?;

    match root.get("collector") {
        None => Ok(Settings::default()),
        Some(v) => v.clone().try_into().map_err(|e| ConfigError::Malformed {
            path,
            detail: format!("the [collector] table is not usable: {e}"),
        }),
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Log loudly if the credential file is readable by anyone but its owner.
///
/// Warn rather than refuse: the key still works, and disabling collection over
/// a permission bit would be a confusing failure for something the operator
/// can fix in one command. But it is never silent — a credential readable by
/// every local user is worth a line in the journal every startup.
#[cfg(unix)]
fn warn_if_world_readable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = fs::metadata(path) else { return };
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        tracing::warn!(
            path = %path.display(),
            mode = format!("{mode:o}"),
            "the ingest credential is readable by other users on this machine; \
             tighten it with `chmod 600`"
        );
    }
}

#[cfg(not(unix))]
fn warn_if_world_readable(_path: &Path) {}

/// Write the credential file with owner-only permissions.
///
/// Used by the setup wizard through the daemon, and by tests. The mode is set
/// at CREATE time rather than chmod-ed afterwards, so the key is never briefly
/// world-readable between the write and the fix.
pub fn write_ingest(home: &Path, ingest: &Ingest) -> Result<PathBuf, ConfigError> {
    fs::create_dir_all(home)?;
    tighten_home(home);

    let path = home.join(CREDENTIALS_FILE);

    // Merge, never replace. credentials.toml also carries the cloud token and
    // the dashboard session; rewriting the file from this one writer would
    // silently disconnect both. Layout 1 could get away with a whole-file write
    // because each credential had its own file.
    let mut doc: toml::Table = fs::read_to_string(&path)
        .ok()
        .and_then(|t| toml::from_str(&t).ok())
        .unwrap_or_default();

    let mut table = toml::Table::new();
    table.insert("url".into(), toml::Value::String(ingest.url.clone()));
    table.insert("key".into(), toml::Value::String(ingest.key.clone()));
    doc.insert("ingest".into(), toml::Value::Table(table));

    let body = format!(
        "# failproofai credentials — owner-only (0600). Do not commit.\n\n{}",
        toml::to_string_pretty(&doc)
            .map_err(|e| ConfigError::Invalid(format!("could not serialize credentials: {e}")))?
    );

    write_private(&path, body.as_bytes())?;
    Ok(path)
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ConfigError> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(CREDENTIAL_MODE)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    // `mode()` only applies when the file is CREATED, so an existing file that
    // was already too permissive would keep its mode. Set it explicitly too.
    fs::set_permissions(path, fs::Permissions::from_mode(CREDENTIAL_MODE))?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ConfigError> {
    fs::write(path, bytes)?;
    Ok(())
}

/// Best-effort tightening of the failproofai home to owner-only.
///
/// It is 0775 on a normal machine because nothing ever needed it otherwise.
/// Once a credential lives inside it, a world-traversable parent undermines
/// the 0600 on the file itself. Best-effort because failing to chmod a
/// directory we do not own must not stop the daemon starting.
#[cfg(unix)]
fn tighten_home(home: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = fs::metadata(home) else { return };
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        match fs::set_permissions(home, fs::Permissions::from_mode(0o700)) {
            Ok(()) => tracing::info!(
                path = %home.display(),
                was = format!("{mode:o}"),
                "tightened the failproofai home to 0700 so the ingest credential inside it is not world-readable"
            ),
            Err(err) => tracing::warn!(
                path = %home.display(),
                %err,
                "could not tighten the failproofai home; the ingest credential's directory stays group/world-traversable"
            ),
        }
    }
}

#[cfg(not(unix))]
fn tighten_home(_home: &Path) {}
