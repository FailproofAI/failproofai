//! Collector configuration: where to send events, and what to collect.
//!
//! # Two files, on purpose
//!
//! Every credential lives in `~/.failproofai/credentials.json` at mode 0600.
//! Everything else — which sources are on, backfill window, hook verbosity —
//! lives in `config.json` under `collector`, beside the rest of the settings,
//! where it is readable, diffable and safe to commit to a dotfiles repo.
//!
//! That split is not tidiness. `config.json` is written with a bare
//! `writeFileSync`, so it inherits the umask and lands at 0664 on a normal
//! machine — inside `~/.failproofai/`, which is itself 0775. Putting an API key
//! there would publish it to every local user on the box, which is exactly why
//! `ingest.json` and `cloud.json` were separate files before layout 2 merged
//! them into one owner-only file.
//!
//! # Disabled is the default, and it is a real default
//!
//! No `ingest` object, or one with no key, means collection is off: no tasks,
//! so no thread and no runtime (see [`crate::supervisor::spawn_supervised`]). A
//! machine that has not opted in pays nothing for this code existing. Session
//! collection additionally requires its own explicit opt-in, because
//! transcripts carry prompts, file contents and whatever the user pasted into
//! a terminal — configuring a key must not silently start shipping those.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The hosted ingest endpoint. A COMPLETE endpoint including its path, not a
/// base to join onto — a self-hoster replaces the whole value with one of
/// their own.
///
/// MUST stay byte-identical to `DEFAULT_INGEST_URL` in `collector-config.ts`.
/// The two sides resolve a credential independently, so a divergence would
/// mean the CLI verified one endpoint at setup and the daemon posted to
/// another — and the daemon would look healthy while nothing arrived.
///
/// `/v1/events`, not `/events`: on the dashboard hostname only `/v1/*` reaches
/// the server, so the versioned path is the only one that works on every
/// deployment shape. Both paths are the same handler on the server itself, so
/// this is not a behaviour change for anyone already pointed at that host.
///
/// The DASHBOARD hostname, not the API server's. The reverse proxy in front of
/// the hosted deployment already routes `/v1/*` and `/enforcement/v1/*` to the
/// server, so this reaches ingest exactly as the server hostname did — while
/// leaving the server without a public name of its own to expose.
///
/// It also makes one origin sufficient. Ingest, `/v1/auth/introspect` and
/// `/enforcement/v1/*` all hang off the origin a person pastes into
/// `--connect`, and that origin is now the one already in their browser rather
/// than a second hostname they have to be told about.
///
/// Machines already carrying the server hostname in `credentials.json` keep
/// working untouched: this is only the value used when no URL was recorded.
pub const DEFAULT_INGEST_URL: &str = "https://app.befailproof.ai/v1/events";

/// Filename of the credential file inside the failproofai home.
/// Layout 2: every credential in one owner-only TOML file, keyed by table.
const CREDENTIALS_FILE: &str = "credentials.json";
/// Layout 2: non-secret configuration, including the collector block.
const CONFIG_FILE: &str = "config.json";

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

/// The non-secret half, read from `config.json` under `collector`.
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
    /// Per-source extra capture paths, keyed by source name (`claude`,
    /// `hermes`, …) — `collector.sources.<name>` in `config.json`.
    ///
    /// A map rather than a struct with 13 fields: the source list is data, not
    /// schema, and a struct would mean a newly added source silently ignoring
    /// its own config key until somebody remembered to add the field. An
    /// unrecognised key here is caught by the caller, which knows the real
    /// source list, and reported rather than dropped — a typo'd `[collector.
    /// sources.claud]` that parsed cleanly and captured nothing is exactly the
    /// silent failure this project exists to remove.
    #[serde(default)]
    pub sources: BTreeMap<String, SourceSettings>,
}

/// The `collector.sources.<name>` table.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct SourceSettings {
    /// Extra locations to capture, each `label=path` or bare `path`. Resolved
    /// by [`crate::extra_paths::resolve`]; see that module for the grammar and
    /// for what each rejection prevents.
    #[serde(default)]
    pub extra_paths: Vec<String>,
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
            sources: BTreeMap::new(),
        }
    }
}

impl Settings {
    /// Raw `extra_paths` entries for one source, env override winning whole.
    ///
    /// `FAILPROOFAI_<SOURCE>_EXTRA_PATHS`, comma-separated — the same
    /// env → file → default precedence as every other knob here, and the same
    /// env name shape AgentEye's collector uses (`AGENTEYE_HERMES_EXTRA_PATHS`).
    /// It REPLACES the file's list rather than appending to it: a container that
    /// sets the variable is describing that container's whole layout, and
    /// silently inheriting a host path from a mounted config would capture a
    /// directory the operator never asked for.
    ///
    /// The source name is upper-cased with `-` mapped to `_`, so
    /// `claude-subagent` reads `FAILPROOFAI_CLAUDE_SUBAGENT_EXTRA_PATHS`.
    pub fn extra_paths_for(&self, source: &str) -> Vec<String> {
        let var = format!(
            "FAILPROOFAI_{}_EXTRA_PATHS",
            source.to_ascii_uppercase().replace('-', "_")
        );
        if let Some(raw) = env_nonempty(&var) {
            return raw
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect();
        }
        self.sources
            .get(source)
            .map(|s| s.extra_paths.clone())
            .unwrap_or_default()
    }

    /// Configured source names that are not in `known`.
    ///
    /// Returned rather than warned about here so the caller — which owns the
    /// real source list — decides how loud to be. A typo'd table parses fine
    /// and captures nothing, and nothing else in the pipeline would ever
    /// mention it.
    pub fn unknown_sources(&self, known: &[&str]) -> Vec<String> {
        self.sources
            .keys()
            .filter(|k| !known.contains(&k.as_str()))
            .cloned()
            .collect()
    }
}

/// Which agents this machine traces: the `agents` object at the TOP LEVEL of
/// `config.json` (beside `collector`, not inside it), written by
/// `failproofai config`.
///
/// `selected` is an opt-in list of integration ids (`claude`, `codex`, …). A
/// harness whose id is not in it starts no collector task at all: not its
/// default roots, not its extra paths, and for Hermes not a single profile.
/// ABSENT means every harness, which is what every config written before this
/// existed says, so an old file keeps collecting exactly what it did.
///
/// Read the way `readAgents` in `src/hooks/fp-config.ts` reads it, because the
/// CLI that writes this key and the daemon that obeys it have to agree on what a
/// given file means: `config --status` saying one thing while the collector does
/// another is the failure, whichever of the two is "right". So a value that is
/// not usable reads as ABSENT, never as an error and never as "nothing". The CLI
/// chose that direction so a broken file cannot quietly switch tracing off;
/// `unusable` records it so the daemon can say so instead of widening silently.
/// Within a usable list, non-strings and blank entries are dropped and repeats
/// collapse, exactly as the CLI does. Names are otherwise kept as written: the
/// daemon owns the list of real agents, and warns about one it does not know.
///
/// `seen` (what the CLI detected at its last run) is deliberately NOT read. It
/// changes whenever a new agent is installed, and every field here is one the
/// collector manager compares: a re-run of `config` that only noticed a new
/// binary would cycle the collector for nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentSelection {
    /// `None` = every harness. `Some(ids)` = only these, possibly none at all.
    pub selected: Option<Vec<String>>,
    /// `agents` was present but could not be read, so it was treated as absent.
    pub unusable: bool,
}

impl AgentSelection {
    /// Interpret the top-level `agents` value of `config.json`.
    pub fn from_config_value(agents: Option<&serde_json::Value>) -> Self {
        let absent = AgentSelection::default();
        let unusable = AgentSelection {
            selected: None,
            unusable: true,
        };
        let Some(value) = agents.filter(|v| !v.is_null()) else {
            return absent;
        };
        let Some(table) = value.as_object() else {
            return unusable;
        };
        match table.get("selected") {
            // `{ "seen": [...] }` alone, or a cleared selection: no selection.
            None | Some(serde_json::Value::Null) => absent,
            Some(serde_json::Value::Array(items)) => {
                let mut ids: Vec<String> = Vec::new();
                for id in items.iter().filter_map(serde_json::Value::as_str) {
                    if !id.trim().is_empty() && !ids.iter().any(|kept| kept == id) {
                        ids.push(id.to_string());
                    }
                }
                AgentSelection {
                    selected: Some(ids),
                    unusable: false,
                }
            }
            Some(_) => unusable,
        }
    }

    /// Whether `agent` is traced. Every agent is, when nothing was selected.
    pub fn traces(&self, agent: &str) -> bool {
        self.selected
            .as_ref()
            .is_none_or(|ids| ids.iter().any(|id| id == agent))
    }

    /// Whether a selection is in force at all.
    pub fn is_selective(&self) -> bool {
        self.selected.is_some()
    }

    /// Selected names that are not in `known`, in the order they were written.
    ///
    /// Returned rather than warned about here, like [`Settings::unknown_sources`]:
    /// the caller owns the real agent list. A misspelt id selects nothing and
    /// collects nothing, and nothing else in the pipeline would ever mention it.
    pub fn unknown(&self, known: &[&str]) -> Vec<String> {
        self.selected
            .iter()
            .flatten()
            .filter(|id| !known.contains(&id.as_str()))
            .cloned()
            .collect()
    }
}

/// Everything the collector needs, resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectorConfig {
    /// `None` means collection is off for this process.
    pub ingest: Option<Ingest>,
    pub settings: Settings,
    /// The top-level `agents.selected`. Inside this struct, rather than read by
    /// the daemon on its own, for the same reason `settings.sources` is: the
    /// collector manager cycles the collector whenever the WHOLE value differs
    /// from the one the running deployment was built from. A selection resolved
    /// anywhere else would be written by `failproofai config`, reported as
    /// applied, and ignored by a running daemon until some unrelated change or a
    /// restart.
    pub agents: AgentSelection,
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
    /// True when there is a usable credential. This is what `collector_tasks()`
    /// keys off, so an unconfigured machine starts no thread and no runtime.
    ///
    /// Deliberately NOT `&& (sessions || hooks)`. Those two gate the daemon's
    /// OWN capture sources — CLI session transcripts and hook activity — and
    /// each is checked again where its source is registered, so leaving them
    /// off still starts neither. What they must not gate is DELIVERY, because
    /// the spool also carries batches this daemon did not produce: the
    /// `failproofai-sdk` writes its own events into `custom-agents/events/`,
    /// and the spool watcher is the only thing that ships them.
    ///
    /// While they did gate it, `collector.hooks = false` — a documented
    /// privacy choice, and the only one available to somebody who wants their
    /// instrumented agents shipped and nothing else — silently disabled the
    /// SDK too: no task started, no line logged, and batches accumulated in
    /// the spool forever. An unread spool is indistinguishable from an idle
    /// one, which is the exact failure this project exists to remove.
    pub fn is_enabled(&self) -> bool {
        self.ingest.is_some()
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
    // ONE read of config.json for both halves, so a file rewritten between two
    // reads cannot yield the collector settings of one version and the agent
    // selection of another.
    let doc = read_config_doc(home)?;
    let settings = settings_from(&doc)?;
    let agents =
        AgentSelection::from_config_value(doc.as_ref().and_then(|(_, root)| root.get("agents")));

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
        agents,
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
            let doc: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| ConfigError::Malformed {
                    path: path.clone(),
                    detail: e.to_string(),
                })?;
            // A credentials file with no `ingest` object is not malformed — it
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

/// `config.json`, parsed, with the path it came from. `None` when there is no
/// file, which is every machine that has not been set up.
fn read_config_doc(home: &Path) -> Result<Option<(PathBuf, serde_json::Value)>, ConfigError> {
    let path = home.join(CONFIG_FILE);
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(ConfigError::Io(e)),
    };

    let root: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| ConfigError::Malformed {
            path: path.clone(),
            detail: e.to_string(),
        })?;
    Ok(Some((path, root)))
}

/// The `collector` object of a parsed `config.json`.
fn settings_from(doc: &Option<(PathBuf, serde_json::Value)>) -> Result<Settings, ConfigError> {
    let Some((path, root)) = doc else {
        return Ok(Settings::default());
    };
    match root.get("collector") {
        None => Ok(Settings::default()),
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| ConfigError::Malformed {
            path: path.clone(),
            detail: format!("the collector object is not usable: {e}"),
        }),
    }
}

#[cfg(test)]
fn load_settings(home: &Path) -> Result<Settings, ConfigError> {
    settings_from(&read_config_doc(home)?)
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

    // Merge, never replace. credentials.json also carries the cloud token and
    // the dashboard session; rewriting the file from this one writer would
    // silently disconnect both. Layout 1 could get away with a whole-file write
    // because each credential had its own file.
    let mut doc: serde_json::Map<String, serde_json::Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();

    doc.insert(
        "ingest".into(),
        serde_json::json!({ "url": ingest.url, "key": ingest.key }),
    );

    // No leading comment line any more: JSON has nowhere to put one, and a file
    // that is not valid JSON is a file the other readers reject.
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(&doc)
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

#[cfg(test)]
mod extra_path_settings_tests {
    use super::*;

    /// The exact bytes `writeConfig` in `src/hooks/fp-config.ts` produces after
    /// two `failproofai harness add-path` runs, captured from a live CLI
    /// invocation rather than hand-written.
    ///
    /// This is the seam with nothing holding it together: the TypeScript CLI
    /// writes this file and the Rust daemon reads it, and neither is generated
    /// from the other. Both halves parse cleanly on their own while disagreeing
    /// — which is how `collector` came to be snake_case at all (it was
    /// camelCase under `policies-config.json`, and carrying that over would have
    /// meant every field silently falling back to its default).
    /// Layout 3 made this JSON, which removed the hazard this fixture used to
    /// guard: TOML required `[collector.sources.*]` AFTER every scalar of
    /// `collector`, and a writer emitting them earlier produced a file where
    /// `environment` and `redact` silently belonged to a sub-table. JSON has no
    /// such ordering rule — one fewer way for the two writers to disagree.
    const WRITTEN_BY_THE_CLI: &str = r#"{
      "mode": {
        "kind": "oss"
      },
      "daemon": {
        "configured": false
      },
      "collector": {
        "sessions": true,
        "hooks": true,
        "hooks_verbosity": "decisions",
        "redact": "minimal",
        "environment": "local",
        "machine_id": "m-123",
        "sources": {
          "claude": {
            "extra_paths": [
              "work=/srv/team/.claude/projects"
            ]
          },
          "hermes": {
            "extra_paths": [
              "/srv/hermes-prod/state.db",
              "b=/srv/other.db"
            ]
          }
        }
      },
      "audit": {
        "auto": false,
        "interval_days": 7
      }
    }
    "#;

    fn home_with(text: &str) -> tempdir::Dir {
        let d = tempdir::Dir::new();
        fs::write(d.path().join(CONFIG_FILE), text).unwrap();
        d
    }

    /// A minimal scratch directory; the crate has no dev-dep on `tempfile`.
    mod tempdir {
        use std::path::{Path, PathBuf};
        pub struct Dir(PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let p = std::env::temp_dir().join(format!(
                    "fpai-cfg-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn reads_the_sources_tables_the_typescript_cli_writes() {
        // Serialised against every other test touching these env overrides;
        // two of them set FAILPROOFAI_CLAUDE_EXTRA_PATHS process-wide. See test_env.rs.
        let _env = crate::test_env::lock_env();
        let d = home_with(WRITTEN_BY_THE_CLI);
        let s = load_settings(d.path()).unwrap();

        // The scalars after which the sub-tables appear must NOT have been
        // swallowed into one.
        assert!(s.sessions, "sessions was lost to a sub-table");
        assert_eq!(s.environment, "local");
        assert_eq!(s.machine_id.as_deref(), Some("m-123"));

        assert_eq!(
            s.extra_paths_for("claude"),
            vec!["work=/srv/team/.claude/projects".to_string()]
        );
        assert_eq!(
            s.extra_paths_for("hermes"),
            vec![
                "/srv/hermes-prod/state.db".to_string(),
                "b=/srv/other.db".to_string()
            ]
        );
        assert!(s.extra_paths_for("codex").is_empty());
        assert!(s.unknown_sources(&["claude", "hermes"]).is_empty());
    }

    #[test]
    fn a_config_with_no_sources_table_reads_as_none_configured() {
        // Serialised against every other test touching these env overrides;
        // two of them set FAILPROOFAI_CLAUDE_EXTRA_PATHS process-wide. See test_env.rs.
        let _env = crate::test_env::lock_env();
        let d = home_with(r#"{"collector":{"sessions":true}}"#);
        let s = load_settings(d.path()).unwrap();
        assert!(s.sources.is_empty());
        for h in ["claude", "hermes", "codex"] {
            assert!(s.extra_paths_for(h).is_empty());
        }
    }

    #[test]
    fn an_unrecognised_source_table_is_reported_rather_than_ignored() {
        // Serialised against every other test touching these env overrides;
        // two of them set FAILPROOFAI_CLAUDE_EXTRA_PATHS process-wide. See test_env.rs.
        let _env = crate::test_env::lock_env();
        let d = home_with(r#"{"collector":{"sources":{"claud":{"extra_paths":["/srv/x"]}}}}"#);
        let s = load_settings(d.path()).unwrap();
        assert_eq!(s.unknown_sources(&["claude"]), vec!["claud".to_string()]);
    }

    /// The env override REPLACES the file's list. A container setting it is
    /// describing that container's whole layout; inheriting a host path from a
    /// mounted config would capture a directory nobody asked for.
    #[test]
    fn the_env_override_replaces_the_file_and_splits_on_commas() {
        // Serialised against every other test touching these env overrides;
        // two of them set FAILPROOFAI_CLAUDE_EXTRA_PATHS process-wide. See test_env.rs.
        let _env = crate::test_env::lock_env();
        let d = home_with(WRITTEN_BY_THE_CLI);
        let s = load_settings(d.path()).unwrap();
        // SAFETY: single-threaded test; restored before returning.
        unsafe {
            std::env::set_var("FAILPROOFAI_CLAUDE_EXTRA_PATHS", " a=/one , b=/two ,, ");
        }
        assert_eq!(
            s.extra_paths_for("claude"),
            vec!["a=/one".to_string(), "b=/two".to_string()]
        );
        unsafe {
            std::env::remove_var("FAILPROOFAI_CLAUDE_EXTRA_PATHS");
        }
        // ...and falls back to the file once it is gone.
        assert_eq!(
            s.extra_paths_for("claude"),
            vec!["work=/srv/team/.claude/projects".to_string()]
        );
    }

    /// Adding an extra path must change the resolved `CollectorConfig`.
    ///
    /// This is what makes `failproofai harness add-path` take effect on a
    /// RUNNING daemon with no restart and no sudo. `spawn_collector_manager` in
    /// failproofaid re-reads this config on an interval and cycles the collector
    /// whenever the whole value differs from the one the live generation was
    /// built from — it does not know or care which field moved.
    ///
    /// So the mechanism rests entirely on `sources` being INSIDE the compared
    /// value. Move it out — to its own file, a lazily-read side table, anything
    /// resolved after this struct — and nothing breaks loudly: the CLI keeps
    /// reporting success, the config keeps parsing, and the running daemon
    /// simply never picks the path up until it is restarted for some other
    /// reason. Verified live at the time of writing: task count 21 -> 23 within
    /// one poll interval, and the first transcript under the new path reached
    /// the server.
    #[test]
    fn collector_config_change_cycles_the_collector() {
        // Serialised against every other test touching these env overrides;
        // two of them set FAILPROOFAI_CLAUDE_EXTRA_PATHS process-wide. See test_env.rs.
        let _env = crate::test_env::lock_env();
        let d = home_with(r#"{"collector":{"sessions":true}}"#);
        let before = load(d.path()).unwrap();

        fs::write(
            d.path().join(CONFIG_FILE),
            r#"{"collector":{"sessions":true,"sources":{"claude":{"extra_paths":["late=/srv/x"]}}}}"#,
        )
        .unwrap();
        let after = load(d.path()).unwrap();

        assert_ne!(
            before, after,
            "adding an extra path did not change CollectorConfig, so a running \
             daemon would never cycle and the path would be captured only after \
             an unrelated restart"
        );
        assert_eq!(
            after.settings.extra_paths_for("claude"),
            vec!["late=/srv/x".to_string()]
        );

        // ...and removing it changes back, so `remove-path` also takes effect.
        fs::write(
            d.path().join(CONFIG_FILE),
            r#"{"collector":{"sessions":true}}"#,
        )
        .unwrap();
        assert_eq!(load(d.path()).unwrap(), before);
    }

    // ── agents.selected ─────────────────────────────────────────────────────

    fn selection_from(text: &str) -> AgentSelection {
        let root: serde_json::Value = serde_json::from_str(text).unwrap();
        AgentSelection::from_config_value(root.get("agents"))
    }

    #[test]
    fn no_agents_key_means_every_agent_is_traced() {
        // Every config written before the key existed, which must keep
        // collecting exactly what it did.
        for text in [
            r#"{"collector":{"sessions":true}}"#,
            r#"{"agents":null}"#,
            // `seen` alone is the CLI's bookkeeping, not a selection.
            r#"{"agents":{"seen":["claude"]}}"#,
            r#"{"agents":{"selected":null,"seen":[]}}"#,
        ] {
            let s = selection_from(text);
            assert_eq!(s, AgentSelection::default(), "{text}");
            assert!(!s.is_selective());
            assert!(s.traces("claude") && s.traces("hermes"), "{text}");
        }
    }

    #[test]
    fn a_selection_traces_only_what_it_names() {
        let s = selection_from(r#"{"agents":{"selected":["claude","hermes"],"seen":["goose"]}}"#);
        assert!(s.is_selective());
        assert!(s.traces("claude") && s.traces("hermes"));
        assert!(!s.traces("codex"));
        assert!(!s.traces("goose"), "`seen` selects nothing");

        let none = selection_from(r#"{"agents":{"selected":[]}}"#);
        assert!(none.is_selective());
        assert!(!none.traces("claude"), "an empty selection traces nothing");
    }

    /// The same reading `readAgents` in `src/hooks/fp-config.ts` gives, so the
    /// CLI's "tracing every agent" and the collector cannot disagree about one
    /// file: a garbage value is absent, never "nothing".
    #[test]
    fn a_selection_is_read_the_way_the_cli_reads_it() {
        let s =
            selection_from(r#"{"agents":{"selected":["claude",7,"","  ","claude",null,"codx"]}}"#);
        assert_eq!(
            s.selected,
            Some(vec!["claude".to_string(), "codx".to_string()]),
            "non-strings and blanks dropped, repeats collapsed, names kept as written"
        );
        assert!(!s.unusable);
        assert_eq!(s.unknown(&["claude", "codex"]), vec!["codx".to_string()]);

        for garbage in [
            r#"{"agents":"claude"}"#,
            r#"{"agents":["claude"]}"#,
            r#"{"agents":{"selected":"claude"}}"#,
            r#"{"agents":{"selected":{"claude":true}}}"#,
        ] {
            let s = selection_from(garbage);
            assert_eq!(s.selected, None, "{garbage}");
            assert!(
                s.unusable,
                "{garbage} must be reported, not silently widened"
            );
            assert!(s.traces("codex"), "{garbage}");
        }
    }

    /// The selection must be INSIDE the compared `CollectorConfig`, or a
    /// running daemon never notices `failproofai config` changed it — the same
    /// dependency `collector_config_change_cycles_the_collector` pins for
    /// `sources`.
    #[test]
    fn changing_the_selection_changes_the_collector_config_but_seen_does_not() {
        let _env = crate::test_env::lock_env();
        let d = home_with(r#"{"collector":{"sessions":true}}"#);
        let before = load(d.path()).unwrap();
        assert_eq!(before.agents, AgentSelection::default());

        fs::write(
            d.path().join(CONFIG_FILE),
            r#"{"agents":{"selected":["claude"],"seen":["claude"]},"collector":{"sessions":true}}"#,
        )
        .unwrap();
        let selected = load(d.path()).unwrap();
        assert_ne!(
            before, selected,
            "selecting agents did not change CollectorConfig, so a running daemon would \
             keep collecting every agent until an unrelated restart"
        );
        assert!(selected.agents.traces("claude") && !selected.agents.traces("codex"));

        // A newly detected agent changes only `seen`: nothing to cycle for.
        fs::write(
            d.path().join(CONFIG_FILE),
            r#"{"agents":{"selected":["claude"],"seen":["claude","goose"]},"collector":{"sessions":true}}"#,
        )
        .unwrap();
        assert_eq!(load(d.path()).unwrap(), selected);

        // ...and clearing the selection changes it back.
        fs::write(
            d.path().join(CONFIG_FILE),
            r#"{"collector":{"sessions":true}}"#,
        )
        .unwrap();
        assert_eq!(load(d.path()).unwrap(), before);
    }

    /// A source whose name contains `-` must map to a legal env var name.
    #[test]
    fn a_hyphenated_source_name_maps_to_an_underscored_env_var() {
        // Serialised against every other test touching these env overrides;
        // two of them set FAILPROOFAI_CLAUDE_EXTRA_PATHS process-wide. See test_env.rs.
        let _env = crate::test_env::lock_env();
        let s = Settings::default();
        unsafe {
            std::env::set_var("FAILPROOFAI_CLAUDE_SUBAGENT_EXTRA_PATHS", "/srv/sub");
        }
        assert_eq!(
            s.extra_paths_for("claude-subagent"),
            vec!["/srv/sub".to_string()]
        );
        unsafe {
            std::env::remove_var("FAILPROOFAI_CLAUDE_SUBAGENT_EXTRA_PATHS");
        }
    }
}
