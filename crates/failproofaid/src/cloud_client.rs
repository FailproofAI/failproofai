use crate::cloud_policies::{
    ActiveDeployment, DESIRED_STATE_SCHEMA_VERSION, DesiredPolicy, DesiredState, PolicyErrorEntry,
    PolicyStore, ReconcileError,
};
use reqwest::Url;
use reqwest::blocking::Client;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const DEFAULT_POLL_MS: u64 = 30_000;
const MINIMUM_POLL_MS: u64 = 100;

/// The `policyErrors` parameter's ceiling, measured URL-ENCODED — the form it
/// actually travels in. Over it, whole entries are dropped from the end: the
/// list is truncated, never the JSON.
pub const MAX_POLICY_ERRORS_ENCODED_BYTES: usize = 4096;
/// One message's ceiling, so a single pathological message cannot push every
/// other entry out of the report.
const MAX_POLICY_ERROR_MESSAGE_CHARS: usize = 500;
const MAX_POLICY_ERROR_ID_CHARS: usize = 128;

/// Why a poll produced no usable desired state.
///
/// Split because only one half is worth REPORTING back: a payload this daemon
/// could not accept (an unknown `effect`, an unreadable body, a schema skew) is
/// the server's to see and fix, while a refused connection or a 502 is gone by
/// the time any report could reach anyone.
#[derive(Debug)]
struct PollFailure {
    message: String,
    reportable: bool,
}

impl PollFailure {
    fn transport(message: String) -> Self {
        Self {
            message,
            reportable: false,
        }
    }

    fn payload(message: String) -> Self {
        Self {
            message,
            reportable: true,
        }
    }
}

/// Compact JSON for the `policyErrors` parameter, within
/// [`MAX_POLICY_ERRORS_ENCODED_BYTES`] once URL-encoded.
///
/// Long messages are shortened first (by characters, so a multi-byte message is
/// never cut mid-codepoint), then whole entries are dropped from the end until
/// the encoded form fits. What is sent is always a complete JSON array.
///
/// Every message has its local paths redacted first ([`redact_local_paths`]):
/// the report leaves the machine, and a path names the user.
pub fn encode_policy_errors(entries: &[PolicyErrorEntry]) -> String {
    let home = std::env::var("HOME").ok();
    let clipped: Vec<PolicyErrorEntry> = entries
        .iter()
        .map(|entry| PolicyErrorEntry {
            id: clip(&entry.id, MAX_POLICY_ERROR_ID_CHARS),
            version: entry.version,
            kind: entry.kind.clone(),
            message: clip(
                &redact_local_paths(&entry.message, home.as_deref()),
                MAX_POLICY_ERROR_MESSAGE_CHARS,
            ),
        })
        .collect();
    let mut keep = clipped.len();
    loop {
        let json = serde_json::to_string(&clipped[..keep]).unwrap_or_else(|_| "[]".to_string());
        if keep == 0 || encoded_len(&json) <= MAX_POLICY_ERRORS_ENCODED_BYTES {
            return json;
        }
        keep -= 1;
    }
}

/// A policy error message with no local path in it (CONTRACT C9.5): the home
/// directory becomes `~`, and any other absolute path becomes its last segment.
///
/// The CLI applies the same rule before it writes `errors.json`
/// (`redactLocalPaths` in `cloud-policy-errors.ts`); this is the second copy on
/// the way out, so a report never carries a username whichever program wrote it.
///
/// A path starts at a `/` that begins the text or follows whitespace, a quote,
/// an opening bracket, `=`, `,` or `:` — but not a URL's `//host` after `:`,
/// and never a `/` following any other character, so a URL
/// (`https://host/path`) and a relative path (`a/b`) are left alone while
/// `file:///tmp/x` and `open:/etc/x` are not — and runs to the next whitespace,
/// quote, closing bracket, `,` or `;`.
pub fn redact_local_paths(message: &str, home: Option<&str>) -> String {
    let chars: Vec<char> = replace_home(message, home).chars().collect();
    let mut out = String::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let starts_path = chars[i] == '/'
            && (i == 0 || {
                let prev = chars[i - 1];
                prev.is_whitespace()
                    || matches!(prev, '"' | '\'' | '`' | '(' | '[' | '<' | '{' | '=' | ',')
                    // `scheme://host` is a URL; `file:///path` and `x:/path` are paths.
                    || (prev == ':'
                        && !(chars.get(i + 1) == Some(&'/') && chars.get(i + 2) != Some(&'/')))
            });
        if !starts_path {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let mut end = i;
        while end < chars.len() && !ends_path(chars[end]) {
            end += 1;
        }
        let path: String = chars[i..end].iter().collect();
        match path.trim_end_matches('/').rsplit('/').next() {
            Some(base) if !base.is_empty() => out.push_str(base),
            _ => out.push('/'),
        }
        i = end;
    }
    out
}

fn ends_path(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | '`' | ')' | ']' | '>' | '}' | ',' | ';')
}

/// `message` with every whole-segment occurrence of `home` replaced by `~`.
fn replace_home(message: &str, home: Option<&str>) -> String {
    let Some(home) = home
        .map(|h| h.trim_end_matches('/'))
        .filter(|h| h.len() > 1)
    else {
        return message.to_string();
    };
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(at) = rest.find(home) {
        let after = &rest[at + home.len()..];
        // `/home/al` must not match inside `/home/alice`.
        let whole = after
            .chars()
            .next()
            .is_none_or(|c| c == '/' || ends_path(c) || c == ':');
        out.push_str(&rest[..at]);
        out.push_str(if whole { "~" } else { home });
        rest = after;
    }
    out.push_str(rest);
    out
}

fn clip(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The length `value` takes as a query-parameter value, encoded exactly the
/// way the poll encodes it.
fn encoded_len(value: &str) -> usize {
    let mut url = Url::parse("http://x.invalid/").expect("static URL parses");
    url.query_pairs_mut().append_pair("v", value);
    url.query()
        .map_or(0, |query| query.len().saturating_sub("v=".len()))
}

/// The machine's current report: the daemon's own reconcile errors first, then
/// the CLI's. `None` — parameter omitted — only while NEITHER has ever written
/// an error state, so a machine that never had a problem sends nothing new,
/// and one that had a problem sends `[]` once it is fixed (which is what
/// clears it on the server).
///
/// `active` is the deployment in force when the report is read: `Some(None)`
/// for no deployment, `None` when it could not be read. The CLI's entries are
/// kept only while they still describe it (see [`cli_entry_is_current`]);
/// when it could not be read nothing is dropped, because "cannot tell" is not
/// "no deployment".
fn current_policy_errors(
    store: &PolicyStore,
    active: Option<Option<&ActiveDeployment>>,
) -> Option<Vec<PolicyErrorEntry>> {
    let daemon = store.read_daemon_policy_errors();
    let cli = store.read_cli_policy_errors();
    if daemon.is_none() && cli.is_none() {
        return None;
    }
    let mut all = daemon.unwrap_or_default();
    all.extend(
        cli.unwrap_or_default()
            .into_iter()
            .filter(|entry| active.is_none_or(|active| cli_entry_is_current(entry, active))),
    );
    Some(all)
}

/// Marks the CLI's "Cloud deploys Jev checks and sets no Jev mode" reports
/// (`localJevProblem` in `src/hooks/semantic/jev-config.ts`, D-FB-3).
const NO_CLOUD_JEV_MODE: &str = "sets no Jev mode";

/// Whether an entry of the CLI's `errors.json` still describes `active`.
///
/// The CLI rewrites that file only when a hook runs (CONTRACT C6), so after a
/// FailproofAI Cloud-side fix — a policy removed or re-pinned, a Jev mode set —
/// the machine would otherwise keep reporting the old problem until its next
/// tool call, and forever once it stops making them. So:
///
/// - One policy's entry (`regex | jev | both`) is kept only while that policy
///   is in the deployment, in either list, at the version it names.
/// - A machine-level entry (`kind: "daemon"`: `jevMode`, `active.json`,
///   `semanticPolicies`, `pack:<id>`) is kept, except the ones the CLI reports
///   only in a Jev state `active` no longer has — the same conditions
///   `recordCloudPolicyErrors` in `src/hooks/handler.ts` applies:
///   - `jev_unconfigured` needs Cloud to set `observe`/`enforce` (then a "sets
///     no Jev mode" report is the old state's), or to set no mode while
///     deploying Jev checks;
///   - a pack check's `jev_budget` drop needs deployed Cloud Jev checks and a
///     mode other than `off`.
///
/// The daemon's own entries are never filtered: they describe its last
/// reconcile, which is of the DESIRED state, not the active one.
fn cli_entry_is_current(entry: &PolicyErrorEntry, active: Option<&ActiveDeployment>) -> bool {
    let semantic = active.is_some_and(|a| !a.semantic_policies.is_empty());
    let mode = active.and_then(|a| a.jev_mode.as_deref());
    if entry.kind == "daemon" {
        if entry.message == "jev_unconfigured" || entry.message.starts_with("jev_unconfigured:") {
            return match mode {
                Some("observe" | "enforce") => !entry.message.contains(NO_CLOUD_JEV_MODE),
                None => semantic,
                Some(_) => false,
            };
        }
        if entry.id.starts_with("pack:") && entry.message.starts_with("jev_budget") {
            return semantic && mode != Some("off");
        }
        return true;
    }
    let Some(active) = active else {
        return false;
    };
    active
        .policies
        .iter()
        .map(|p| (p.id.as_str(), p.version))
        .chain(
            active
                .semantic_policies
                .iter()
                .map(|p| (p.id.as_str(), p.version)),
        )
        .any(|(id, version)| id == entry.id && entry.version.is_none_or(|v| v == version))
}

/// A daemon error entry for a failed poll or reconcile. The version is looked
/// up in the desired state when the error names a policy it carries.
fn daemon_error(
    message: String,
    policy_id: Option<&str>,
    desired: Option<&DesiredState>,
) -> PolicyErrorEntry {
    let version = policy_id.and_then(|id| {
        desired.and_then(|d| {
            d.policies
                .iter()
                .find(|p| p.id == id)
                .map(|p| p.version)
                .or_else(|| {
                    d.semantic_policies
                        .iter()
                        .find(|p| p.id == id)
                        .map(|p| p.version)
                })
        })
    });
    PolicyErrorEntry {
        // A state-level error names no policy; `desired-state` says which
        // document was refused.
        id: policy_id.unwrap_or("desired-state").to_string(),
        version,
        kind: "daemon".to_string(),
        message,
    }
}

/// Records the daemon's error state after a poll. Errors always overwrite; a
/// clean poll clears an EXISTING state to `[]` but never creates one, so the
/// report stays absent on a machine that never had a problem.
fn record_daemon_errors(store: &PolicyStore, errors: Vec<PolicyErrorEntry>) {
    if errors.is_empty() && store.read_daemon_policy_errors().is_none() {
        return;
    }
    if let Err(err) = store.write_daemon_policy_errors(&errors) {
        eprintln!("[failproofaid] could not record the cloud policy error state: {err}");
    }
}

#[derive(Clone)]
pub struct CloudClient {
    base_url: Url,
    token: String,
    machine_id: String,
    client: Client,
}

/// On-disk enrolment, written by `failproofai config --connect`.
///
/// The credential deliberately does NOT live in the service unit: that file is
/// installed world-readable (0644, `/etc/systemd/system`), so a token there
/// would be readable by every local user and echoed by `systemctl show`.
#[derive(serde::Deserialize)]
struct StoredCredentials {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    url: String,
    #[serde(rename = "machineId")]
    machine_id: String,
    token: String,
}

/// `FAILPROOFAI_CLOUD_CREDENTIALS`, when set — a standalone JSON file, the shape
/// this loader has always read. Mirrors `cloudCredentialPath()` on the TS side.
pub fn credentials_json_override() -> Option<std::path::PathBuf> {
    std::env::var_os("FAILPROOFAI_CLOUD_CREDENTIALS").map(std::path::PathBuf::from)
}

/// `~/.failproofai/credentials.json` — where layout 3 keeps the enrolment.
pub fn credentials_path() -> Option<std::path::PathBuf> {
    if let Some(path) = credentials_json_override() {
        return Some(path);
    }
    crate::paths::failproofai_home()
        .ok()
        .map(|home| home.join("credentials.json"))
}

/// `~/.failproofai/cloud.json` — layout 1. Read only if `credentials.json` is absent.
fn legacy_credentials_path() -> Option<std::path::PathBuf> {
    crate::paths::failproofai_home()
        .ok()
        .map(|home| home.join("cloud.json"))
}

/// Has the operator explicitly put this machine back on OSS?
///
/// `config --disconnect` writes `mode: "oss"` and its own comment states the
/// rule this function exists to make true: "every cloud code path keys off this
/// flag rather than off 'is a token lying around' precisely so that a
/// disconnected machine is provably silent instead of silent-by-happenstance."
/// That was true of the TypeScript CLI and false HERE — the daemon holds the
/// socket and had never read the flag. So a `mode: "oss"` machine whose
/// credential file survived (a restore, a copied home, a reinstall, a partial
/// cleanup, or simply the layout-1 `cloud.json` fallback below) went on polling
/// and shipping while the CLI reported it as disconnected.
///
/// ONLY an explicit `"oss"` vetoes. Absent, unreadable, malformed and any other
/// value all fall through to the credential files, because `mode` postdates the
/// enrolments already in the field: reading "absent" as "oss" would silently
/// disconnect every machine enrolled by an older CLI, which is the same class of
/// silent divergence with the sign flipped. The safe direction here is that a
/// machine only goes quiet when someone said so.
fn disconnected_by_config() -> bool {
    let Ok(home) = crate::paths::failproofai_home() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(home.join("config.json")) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    // `{"mode":{"kind":"oss"}}` — an OBJECT, not a string.
    //
    // This read `mode` as a string and therefore never fired: `as_str()` on an
    // object is `None`, so a machine put back on OSS kept polling exactly as it
    // had before the veto existed. The unit tests passed because their fixtures
    // were written from the same wrong assumption as the code — a test that
    // encodes the bug it is meant to catch is worth less than no test, because
    // it also reports that the case is covered.
    //
    // The shape is `fp-config.ts`'s: `mode: { kind: config.mode }` on write
    // (line 567) and `parsed.mode?.kind` on read (line 423). There is no flat
    // form to fall back to — the TS has never written one.
    root.get("mode")
        .and_then(|m| m.get("kind"))
        .and_then(|k| k.as_str())
        == Some("oss")
}

/// Whether the idle tick removes a Cloud deployment left on disk: only on a
/// machine put back on OSS ([`disconnected_by_config`]) whose cloud policy
/// directory is the DEFAULT one. The cleanup deletes four fixed filenames, and
/// `FAILPROOFAI_CLOUD_POLICY_DIR` can name any directory — a shared one with
/// unrelated files of those names among them — so under an override nothing is
/// removed (review F7).
fn oss_cleanup_applies() -> bool {
    !crate::paths::cloud_managed_policy_dir_overridden() && disconnected_by_config()
}

/// The `cloud` object of `credentials.json`. Snake_case keys, because that is
/// what `fp-config.ts`'s `writeCredentials` emits.
#[derive(serde::Deserialize)]
struct FileCredentials {
    cloud: Option<FileCloud>,
}

#[derive(serde::Deserialize)]
struct FileCloud {
    url: String,
    machine_id: String,
    token: String,
}

/// Whether a URL's host is the local machine, and so unreachable from the
/// network regardless of scheme.
///
/// `localhost` is matched by name rather than resolved: resolution can be
/// pointed elsewhere by `/etc/hosts` or DNS, and a check that a hostile
/// resolver can turn into "yes" is not a check. Every other host must be an
/// IP literal in a loopback range to qualify.
fn host_is_loopback(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    // `host_str` keeps the brackets on an IPv6 literal (`[::1]`), which
    // `IpAddr::from_str` will not accept.
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    bare.parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

/// Where this machine's enrolment resolved to, before any HTTP client is built
/// from it.
///
/// Split from [`CloudClient`] so "is this machine still enrolled?" can be asked
/// right before a poll writes anything (see [`enrolment_withdrawn`]) without
/// building a second client — a blocking `reqwest` client starts its own
/// runtime thread, and the answer needs none of it.
struct Enrolment {
    base_url: String,
    token: String,
    machine_id: String,
}

impl CloudClient {
    /// Environment first, then the credential file.
    ///
    /// Env wins so CI, containers and tests keep working unchanged, and so an
    /// operator who prefers env-only configuration loses nothing.
    pub fn from_env_or_file() -> Result<Option<Self>, String> {
        Self::build(Enrolment::resolve())
    }

    /// The credential-file half alone; see [`Enrolment::from_file`].
    #[cfg(test)]
    pub fn from_file() -> Result<Option<Self>, String> {
        Self::build(Enrolment::from_file())
    }

    fn build(enrolment: Result<Option<Enrolment>, String>) -> Result<Option<Self>, String> {
        enrolment?
            .map(|e| Self::new(&e.base_url, e.token, e.machine_id))
            .transpose()
    }
}

/// True when this machine is no longer enrolled — `config --disconnect` ran, or
/// the credential is simply gone — as opposed to enrolled (or enrolled with an
/// unreadable credential, which keeps its last known-good deployment).
///
/// Asked right before a poll persists anything. A poll can be in flight for
/// seconds (the request, then one fetch per new artifact), and a disconnect
/// that lands in that window used to be undone by the poll's own writes:
/// `desired-state.json` and `active.json` came back, carrying the old org's
/// policies and Jev mode, moments after the CLI removed them.
fn enrolment_withdrawn() -> bool {
    matches!(Enrolment::resolve(), Ok(None))
}

impl Enrolment {
    fn resolve() -> Result<Option<Self>, String> {
        if let Some(enrolment) = Self::from_env()? {
            return Ok(Some(enrolment));
        }
        Self::from_file()
    }

    fn from_env() -> Result<Option<Self>, String> {
        let Some(base_url) = env_value("FAILPROOFAI_CLOUD_URL") else {
            return Ok(None);
        };
        let token = env_value("FAILPROOFAI_CLOUD_TOKEN")
            .ok_or("FAILPROOFAI_CLOUD_TOKEN is required when FAILPROOFAI_CLOUD_URL is set")?;
        let machine_id = env_value("FAILPROOFAI_MACHINE_ID")
            .ok_or("FAILPROOFAI_MACHINE_ID is required when FAILPROOFAI_CLOUD_URL is set")?;
        Ok(Some(Self {
            base_url,
            token,
            machine_id,
        }))
    }

    /// A missing file means "not enrolled" — not an error. A malformed one IS
    /// an error: it was written by us, so bad content means something is wrong
    /// that the operator should see rather than a silently unenrolled machine.
    ///
    /// Two formats, in this order:
    ///
    ///   1. `credentials.json`'s `cloud` object — what layout 3 writes, and
    ///      what `--connect` has produced since. Also the JSON shape when
    ///      `FAILPROOFAI_CLOUD_CREDENTIALS` names a file, which is how the
    ///      override has always worked.
    ///   2. `cloud.json` — layout 1, read ONLY when `credentials.json` is absent, for a
    ///      machine whose daemon upgraded before its CLI ran once to migrate.
    ///      Never preferred: mid-migration both exist and the newer file is current.
    ///
    /// Reading only (1)'s old location is what made cloud-managed policy dead on
    /// arrival in layout 2 — `--connect` reported success, wrote a credential
    /// the daemon never looked at, and the daemon logged "cloud-managed policy
    /// polling disabled" as though the machine had simply never enrolled.
    fn from_file() -> Result<Option<Self>, String> {
        // `mode: "oss"` outranks every credential file below it. Checked HERE
        // rather than at the call site because `from_file` has three exits (the
        // override, `credentials.json`, and the layout-1 fallback) and a veto
        // that guards only some of them is not a veto.
        //
        // Deliberately NOT applied to `from_env()`: `FAILPROOFAI_CLOUD_URL` is
        // an explicit, per-process act by whoever launched the daemon, and the
        // env path exists so CI, containers and tests work with no files at all.
        // Letting a file on disk veto that would break exactly the callers the
        // env path was added for, and an operator who exports the variable has
        // said what they want more recently than the config did.
        if disconnected_by_config() {
            return Ok(None);
        }

        // An explicitly-named file is the whole configuration: if it is absent,
        // this machine is not enrolled. Falling through to the default location
        // would quietly enrol it against a DIFFERENT credential than the one the
        // operator named — the opposite of what naming a file asks for.
        if let Some(path) = credentials_json_override() {
            return match std::fs::read(&path) {
                Ok(bytes) => Self::from_json_bytes(&bytes, &path),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(err) => Err(format!("failed to read {}: {err}", path.display())),
            };
        }

        let Some(path) = credentials_path() else {
            return Ok(None);
        };
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Self::from_legacy_file();
            }
            Err(err) => return Err(format!("failed to read {}: {err}", path.display())),
        };

        let parsed: FileCredentials = serde_json::from_slice(&bytes)
            .map_err(|err| format!("invalid credentials in {}: {err}", path.display()))?;

        // The file exists for the ingest key and the auth session too, so no
        // `cloud` object means "not enrolled for policy" — not a malformed file.
        let Some(cloud) = parsed.cloud else {
            return Ok(None);
        };
        if cloud.token.is_empty() {
            return Err(format!("empty token in {}", path.display()));
        }
        Ok(Some(Self {
            base_url: cloud.url,
            token: cloud.token,
            machine_id: cloud.machine_id,
        }))
    }

    fn from_legacy_file() -> Result<Option<Self>, String> {
        let Some(path) = legacy_credentials_path() else {
            return Ok(None);
        };
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(format!("failed to read {}: {err}", path.display())),
        };
        Self::from_json_bytes(&bytes, &path)
    }

    fn from_json_bytes(bytes: &[u8], path: &std::path::Path) -> Result<Option<Self>, String> {
        let stored: StoredCredentials = serde_json::from_slice(bytes)
            .map_err(|err| format!("invalid credentials in {}: {err}", path.display()))?;
        if stored.schema_version != 1 {
            return Err(format!(
                "unsupported credentials schema {} in {}",
                stored.schema_version,
                path.display()
            ));
        }
        if stored.token.is_empty() {
            return Err(format!("empty token in {}", path.display()));
        }
        Ok(Some(Self {
            base_url: stored.url,
            token: stored.token,
            machine_id: stored.machine_id,
        }))
    }
}

impl CloudClient {
    fn new(base_url: &str, token: String, machine_id: String) -> Result<Self, String> {
        let mut base_url =
            Url::parse(base_url).map_err(|err| format!("invalid FAILPROOFAI_CLOUD_URL: {err}"))?;
        if !matches!(base_url.scheme(), "http" | "https") {
            return Err("FAILPROOFAI_CLOUD_URL must use http or https".to_string());
        }
        // Plain `http` only to a loopback host — the same rule
        // `validateCloudUrl()` enforces in `cloud-enrollment.ts`, which
        // `configure-wizard.ts` already documents as being enforced on both
        // sides. It was not: this checked the scheme and stopped, so an
        // `http://internal-host` accepted here put the org-scoped
        // `policies:pull` bearer token on the wire in clear, on every
        // `spawn_maintenance()` poll — one every 30 seconds, indefinitely.
        //
        // It matters most on exactly the path the TS validator cannot cover:
        // `FAILPROOFAI_CLOUD_URL` takes precedence over the credentials file and
        // is a documented CI/container knob, so it reaches this constructor
        // without passing through the wizard at all.
        //
        // Loopback is judged by what the address IS rather than by a fixed list
        // of spellings (the TS side names `localhost`, `127.0.0.1` and `::1`);
        // the extra addresses this admits — the rest of `127.0.0.0/8` — are
        // loopback by definition and cannot leave the host, so the property
        // being protected is identical.
        if base_url.scheme() == "http" && !host_is_loopback(&base_url) {
            return Err(format!(
                "refusing to send the machine token to {} over plain http. \
                 Use https, or http only for localhost during development.",
                base_url.origin().ascii_serialization()
            ));
        }
        if !base_url.path().ends_with('/') {
            base_url.set_path(&format!("{}/", base_url.path()));
        }
        if machine_id.is_empty() {
            return Err("FAILPROOFAI_MACHINE_ID cannot be empty".to_string());
        }
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|err| {
                format!(
                    "failed to build cloud HTTP client: {}",
                    fpai_collect::error_chain(&err)
                )
            })?;
        Ok(Self {
            base_url,
            token,
            machine_id,
            client,
        })
    }

    /// `applied` is the deployment this machine is ACTUALLY enforcing right now,
    /// read from `active.json`.
    ///
    /// The server has never been able to tell "assigned" from "applied". It
    /// infers delivery by comparing the machine's last poll against the
    /// deployment's `updated_at` — so a machine that polled and then failed to
    /// materialise the artifacts reads as delivered, and the dashboard shows
    /// `applied` for a deployment that is provably not in force. The machine has
    /// always known the true answer and had no way to say it; this is that way.
    ///
    /// It rides the poll that already happens every 30s rather than a new
    /// endpoint or a second connection, so it costs one query parameter and no
    /// extra request. Additive on purpose: a server that does not read the
    /// parameter is unaffected, which is the ordering #590 asks for — the daemon
    /// may ship before the server without a coordinated release.
    ///
    /// `None` when nothing is active yet (never polled successfully, or the
    /// manifest is unreadable). The parameter is then OMITTED rather than sent
    /// as 0: a machine that cannot say what it is enforcing must not be recorded
    /// as enforcing deployment zero, and absent has to stay distinguishable from
    /// "reported nothing" on the far side.
    ///
    /// `policy_errors` is the machine's error report, already encoded as the
    /// compact JSON list (see [`encode_policy_errors`]); `None` omits the
    /// parameter, which the server reads as "leave what you have stored".
    fn poll_desired_state(
        &self,
        applied: Option<u64>,
        policy_errors: Option<&str>,
    ) -> Result<DesiredState, PollFailure> {
        let mut url = self
            .base_url
            .join("enforcement/v1/desired-state")
            .map_err(|err| {
                PollFailure::transport(format!("failed to build desired-state URL: {err}"))
            })?;
        url.query_pairs_mut()
            .append_pair("machineId", &self.machine_id);
        if let Some(deployment) = applied {
            url.query_pairs_mut()
                .append_pair("appliedDeployment", &deployment.to_string());
        }
        // Additive, like `appliedDeployment`: `DesiredQuery` on the server is
        // not `deny_unknown_fields`, so a server that predates it ignores it.
        if let Some(errors) = policy_errors {
            url.query_pairs_mut().append_pair("policyErrors", errors);
        }
        self.client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|err| {
                PollFailure::transport(format!(
                    "desired-state request failed: {}",
                    fpai_collect::error_chain(&err)
                ))
            })?
            .json::<serde_json::Value>()
            .map_err(|err| PollFailure::payload(format!("invalid desired-state response: {err}")))
            .and_then(|raw| {
                // THE VERSION IS CHECKED BEFORE THE FIELDS, which is the whole
                // point of having one. `SUPPORTED_SCHEMA_VERSIONS` accepts 1 as
                // well, and its comment says that is "for files on DISK, never for
                // a server" — but nothing enforced the second half, so this path
                // took a v1 response.
                //
                // Decoding straight into `DesiredState` would also reject a v1
                // payload, since that type has no aliases for the old spelling —
                // but on the WRONG grounds: serde reports "missing field
                // `deployment`", which sends an operator hunting a malformed
                // payload instead of a stale server. Reading the version off an
                // untyped value first means the error names both halves and says
                // which to upgrade.
                let version = raw.get("schemaVersion").and_then(serde_json::Value::as_u64);
                match version {
                    Some(v) if v == u64::from(DESIRED_STATE_SCHEMA_VERSION) => {}
                    Some(v) => {
                        return Err(PollFailure::payload(format!(
                            "server sent desired-state schemaVersion {v} but this daemon \
                             speaks {DESIRED_STATE_SCHEMA_VERSION} — upgrade whichever half is behind"
                        )));
                    }
                    None => {
                        return Err(PollFailure::payload(
                            "desired-state response has no schemaVersion field".to_string(),
                        ));
                    }
                }
                serde_json::from_value::<DesiredState>(raw).map_err(|err| {
                    PollFailure::payload(format!("invalid desired-state response: {err}"))
                })
            })
    }

    fn artifact(&self, policy: &DesiredPolicy) -> Result<Vec<u8>, String> {
        let url = self
            .base_url
            .join(&policy.artifact_url)
            .map_err(|err| format!("invalid artifact URL: {err}"))?;
        if url.origin() != self.base_url.origin() {
            return Err("artifact URL points outside the configured cloud origin".to_string());
        }
        self.client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|err| {
                // An HTTP answer (a 404, a 403) is the server's to see; a
                // request that never got one is not — see
                // `ARTIFACT_TRANSPORT_FAILURE`.
                let chain = fpai_collect::error_chain(&err);
                if err.status().is_some() {
                    format!("artifact request failed: {chain}")
                } else {
                    format!("{ARTIFACT_TRANSPORT_FAILURE}: {chain}")
                }
            })?
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|err| {
                format!("{ARTIFACT_TRANSPORT_FAILURE}: failed to read the response: {err}")
            })
    }
}

/// How an artifact fetch that never got an HTTP answer begins: a refused
/// connection, a timeout, a body cut off mid-read.
///
/// Such a failure is not recorded in the daemon's error state, exactly like a
/// transport failure of the poll itself. Recording it turned a network blip
/// between the desired-state GET and an artifact GET into a policy error that
/// rode the next poll and cleared on the one after — a fleet page flickering
/// "error" for a minute over nothing anyone could act on. The previous
/// deployment stays in force either way, and the next poll retries.
const ARTIFACT_TRANSPORT_FAILURE: &str = "artifact request did not complete";

/// Whether a reconcile error is a transport failure of an artifact fetch.
fn transient_fetch_failure(err: &ReconcileError) -> bool {
    matches!(err, ReconcileError::Fetch { message, .. } if message.starts_with(ARTIFACT_TRANSPORT_FAILURE))
}

/// One maintenance lane that re-resolves enrolment on every tick.
///
/// Enrolment is deliberately NOT read once at startup. `failproofai config
/// --connect` writes a credential file without root, and the service is a
/// SYSTEM unit — so requiring a restart to notice it would put `sudo systemctl
/// restart` back into the flow and undo the reason the credential lives in a
/// file at all. Re-resolving per tick also makes token rotation and
/// `--disconnect` take effect within one interval, with nothing to restart.
///
/// Resolution failures degrade to integrity-only rather than killing the lane:
/// a machine that was pulling policy keeps its last known-good deployment and
/// keeps repairing tampering while its credentials are broken.
///
/// Two intervals, chosen per tick, so both documented knobs keep their meaning
/// now that one lane serves both cases: `FAILPROOFAI_CLOUD_POLICY_POLL_MS` when
/// enrolled, `FAILPROOFAI_CLOUD_POLICY_RECONCILE_MS` when not.
pub fn spawn_maintenance(
    store: PolicyStore,
    shutdown: Arc<AtomicBool>,
    poll_interval: Duration,
    idle_interval: Duration,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut last_state: Option<bool> = None;
        while !shutdown.load(Ordering::Relaxed) {
            let cloud = CloudClient::from_env_or_file();

            // Log only on transition, so a disconnected machine does not print
            // a line every 30 seconds forever.
            let enrolled = matches!(cloud, Ok(Some(_)));
            if last_state != Some(enrolled) {
                eprintln!(
                    "[failproofaid] cloud-managed policy polling {}",
                    if enrolled { "enabled" } else { "disabled" }
                );
                last_state = Some(enrolled);
            }

            maintenance_tick(&store, cloud, &enrolment_withdrawn, &oss_cleanup_applies);
            wait_until_shutdown(
                &shutdown,
                if enrolled {
                    poll_interval
                } else {
                    idle_interval
                },
            );
        }
    })
}

/// One pass of the maintenance lane, given what enrolment resolved to.
///
/// - **Enrolled:** poll, then repair from the cache. The repair runs whether or
///   not the poll reached the server: a poll failure never discards the last
///   known-good deployment, and local tampering is still repaired while the
///   control plane is unreachable.
/// - **Credential unreadable** (`Err`): repair only. The machine was enrolled
///   and still is as far as anyone said; a broken file is not a disconnect.
/// - **Not enrolled** (`Ok(None)`): NOTHING is rebuilt. `repair_active_from_cache`
///   reconstructs `active.json` from `desired-state.json`, which is the right
///   answer to a lost pointer on an enrolled machine and exactly the wrong one
///   after `config --disconnect`: it put the old org's JS policies, Jev checks
///   and Jev mode back within one interval, on a machine whose owner had left.
///   And when the operator explicitly put the machine back on OSS
///   (`mode: "oss"`), any Cloud deployment still on disk — written by a poll
///   that was in flight during the disconnect, or left by an older CLI that did
///   not remove `desired-state.json` — is removed, so a disconnected machine is
///   provably unmanaged rather than unmanaged by timing. Not in a directory
///   `FAILPROOFAI_CLOUD_POLICY_DIR` chose ([`oss_cleanup_applies`]).
///
/// The two predicates are parameters so a test can drive every branch without
/// touching the process's HOME.
fn maintenance_tick(
    store: &PolicyStore,
    cloud: Result<Option<CloudClient>, String>,
    withdrawn: &dyn Fn() -> bool,
    back_on_oss: &dyn Fn() -> bool,
) {
    match cloud {
        Ok(Some(cloud)) => {
            poll_once_guarded(store, &cloud, withdrawn);
            repair(store);
        }
        Err(err) => {
            eprintln!("[failproofaid] cloud enrolment error: {err}");
            repair(store);
        }
        Ok(None) => {
            if back_on_oss() {
                match store.clear_deployment() {
                    Ok(0) => {}
                    Ok(removed) => eprintln!(
                        "[failproofaid] this machine is disconnected from FailproofAI Cloud; \
                         removed {removed} leftover cloud policy file(s)"
                    ),
                    Err(err) => eprintln!(
                        "[failproofaid] could not remove the cloud policy files of a disconnected machine: {err}"
                    ),
                }
            }
        }
    }
}

fn repair(store: &PolicyStore) {
    if let Err(err) = store.repair_active_from_cache() {
        eprintln!("[failproofaid] cloud policy integrity error: {err}");
    }
}

/// One poll and its reconcile. `withdrawn` is asked right before anything is
/// persisted — the reconcile's writes and the daemon's error state — so a
/// disconnect that lands while the request is in flight is not undone by it.
fn poll_once_guarded(store: &PolicyStore, cloud: &CloudClient, withdrawn: &dyn Fn() -> bool) {
    // Read BEFORE the request, so what we report is what was in force when we
    // asked. Reading after would race this poll's own reconcile and could claim
    // a deployment the server is about to be told about anyway — reporting the
    // future rather than the present.
    //
    // An unreadable manifest reports nothing rather than guessing: `read_active`
    // already distinguishes "no deployment" from "cannot tell", and collapsing
    // the second into the first is how a machine ends up recorded as enforcing
    // something it is not.
    let active = match store.read_active() {
        Ok(active) => Some(active),
        Err(err) => {
            eprintln!("[failproofaid] could not read the active deployment to report it: {err}");
            None
        }
    };
    let applied = active
        .as_ref()
        .and_then(|a| a.as_ref().map(|a| a.deployment));
    // Every poll carries the current report once there is one to carry — the
    // previous poll's reconcile outcome plus whatever the CLI last wrote that
    // still describes the deployment in force.
    let report = current_policy_errors(store, active.as_ref().map(Option::as_ref))
        .map(|errors| encode_policy_errors(&errors));
    match cloud.poll_desired_state(applied, report.as_deref()) {
        Ok(desired) => {
            match store.reconcile_unless(
                &desired,
                &|policy: &DesiredPolicy| cloud.artifact(policy),
                withdrawn,
            ) {
                Ok(outcome) => {
                    if outcome.activated || outcome.downloaded > 0 || outcome.repaired > 0 {
                        eprintln!(
                            "[failproofaid] cloud policy deployment {} active (downloaded {}, repaired {})",
                            outcome.deployment, outcome.downloaded, outcome.repaired
                        );
                    }
                    record_daemon_errors(store, Vec::new());
                }
                Err(ReconcileError::Withdrawn) => {
                    // Nothing was written, and nothing is recorded either: an
                    // error state would describe a deployment this machine no
                    // longer has.
                    eprintln!(
                        "[failproofaid] this machine was disconnected while a poll was in flight; \
                         its result was discarded"
                    );
                }
                Err(err) => {
                    eprintln!("[failproofaid] cloud policy reconcile error: {err}");
                    if !transient_fetch_failure(&err) && !withdrawn() {
                        record_daemon_errors(
                            store,
                            vec![daemon_error(
                                err.to_string(),
                                err.policy_id(),
                                Some(&desired),
                            )],
                        );
                    }
                }
            }
        }
        Err(failure) => {
            eprintln!(
                "[failproofaid] cloud policy poll error: {}",
                failure.message
            );
            // A payload this daemon refused is reported; a transport failure is
            // not, and leaves the recorded state as it was.
            if failure.reportable && !withdrawn() {
                record_daemon_errors(store, vec![daemon_error(failure.message, None, None)]);
            }
        }
    }
}

pub fn poll_interval_from_env() -> Duration {
    let milliseconds = env_value("FAILPROOFAI_CLOUD_POLICY_POLL_MS")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_POLL_MS)
        .max(MINIMUM_POLL_MS);
    Duration::from_millis(milliseconds)
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn wait_until_shutdown(shutdown: &AtomicBool, interval: Duration) {
    let deadline = Instant::now() + interval;
    while !shutdown.load(Ordering::Relaxed) && Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        std::thread::sleep(remaining.min(Duration::from_millis(50)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the fixtures construct an effect explicitly.
    use crate::cloud_policies::PolicyEffect;

    impl CloudClient {
        /// The poll without an error report, for the tests that predate it.
        fn desired_state(&self, applied: Option<u64>) -> Result<DesiredState, String> {
            self.poll_desired_state(applied, None)
                .map_err(|failure| failure.message)
        }
    }

    // std::env::set_var is process-global, so these must not interleave with
    // each other or with anything else reading the same variables — including
    // `paths.rs`, which sets the same HOME. One crate-wide lock; see test_env.rs.
    use crate::test_env::lock_env;

    /// Clears the vars it set and removes its scratch directory. Kept as a
    /// guard so a failing assertion cannot leak process-global env into the
    /// next test.
    struct EnvGuard(std::path::PathBuf);
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("FAILPROOFAI_CLOUD_CREDENTIALS");
                std::env::remove_var("FAILPROOFAI_CLOUD_URL");
                std::env::remove_var("FAILPROOFAI_CLOUD_TOKEN");
                std::env::remove_var("FAILPROOFAI_MACHINE_ID");
            }
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    static SCRATCH_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    fn with_credentials_file(contents: Option<&str>) -> EnvGuard {
        let seq = SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("failproofaid-creds-{}-{seq}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cloud.json");
        if let Some(contents) = contents {
            fs::write(&path, contents).unwrap();
        }
        unsafe {
            std::env::set_var("FAILPROOFAI_CLOUD_CREDENTIALS", &path);
            // Point HOME at the scratch dir too.
            //
            // Without this the suite reads the DEVELOPER'S real
            // ~/.failproofai/config.json, and `from_file` consults it now that
            // the `mode` veto works. Five tests here failed the moment the veto
            // started firing — not because the veto was wrong, but because a
            // machine that had run `--disconnect` (or, as here, was simply set
            // up in OSS mode) made them fail while the same commit passed on a
            // machine that had not. A unit test whose result depends on the
            // config of the laptop running it is not testing what it says.
            std::env::set_var("FAILPROOFAI_HOME", &dir);
            std::env::remove_var("FAILPROOFAI_CLOUD_URL");
            std::env::remove_var("FAILPROOFAI_CLOUD_TOKEN");
            std::env::remove_var("FAILPROOFAI_MACHINE_ID");
        }
        EnvGuard(dir)
    }

    const GOOD: &str =
        r#"{"schemaVersion":1,"url":"https://cloud.example","machineId":"m-1","token":"secret"}"#;

    #[test]
    fn no_credentials_file_means_not_enrolled_rather_than_an_error() {
        let _lock = lock_env();
        let _guard = with_credentials_file(None);
        assert!(CloudClient::from_file().unwrap().is_none());
    }

    #[test]
    fn reads_a_valid_credentials_file() {
        let _lock = lock_env();
        let _guard = with_credentials_file(Some(GOOD));
        let client = CloudClient::from_file().unwrap().expect("enrolled");
        assert_eq!(client.machine_id, "m-1");
        assert_eq!(client.token, "secret");
        assert_eq!(client.base_url.host_str(), Some("cloud.example"));
    }

    #[test]
    fn a_malformed_credentials_file_is_an_error_not_a_silent_disconnect() {
        // We wrote this file. Bad content means something is wrong that the
        // operator needs to see — reporting "not enrolled" would leave a
        // machine quietly unmanaged while looking healthy.
        let _lock = lock_env();
        let _guard = with_credentials_file(Some("{ not json"));
        let err = CloudClient::from_file()
            .err()
            .expect("malformed file must error");
        assert!(err.contains("invalid credentials"), "{err}");
    }

    #[test]
    fn rejects_an_unknown_schema_version() {
        let _lock = lock_env();
        let _guard = with_credentials_file(Some(
            r#"{"schemaVersion":99,"url":"https://c.example","machineId":"m","token":"t"}"#,
        ));
        let err = CloudClient::from_file()
            .err()
            .expect("unknown schema must error");
        assert!(err.contains("unsupported credentials schema"), "{err}");
    }

    #[test]
    fn rejects_an_empty_token_and_an_empty_machine_id() {
        let _lock = lock_env();
        {
            let _guard = with_credentials_file(Some(
                r#"{"schemaVersion":1,"url":"https://c.example","machineId":"m","token":""}"#,
            ));
            let err = CloudClient::from_file()
                .err()
                .expect("empty token must error");
            assert!(err.contains("empty token"), "{err}");
        }
        let _guard = with_credentials_file(Some(
            r#"{"schemaVersion":1,"url":"https://c.example","machineId":"","token":"t"}"#,
        ));
        assert!(CloudClient::from_file().is_err());
    }

    #[test]
    fn environment_wins_over_the_credentials_file() {
        // CI, containers and the existing tests configure by env; enrolment
        // must not silently override them.
        let _lock = lock_env();
        let _guard = with_credentials_file(Some(GOOD));
        unsafe {
            std::env::set_var("FAILPROOFAI_CLOUD_URL", "https://env.example");
            std::env::set_var("FAILPROOFAI_CLOUD_TOKEN", "env-token");
            std::env::set_var("FAILPROOFAI_MACHINE_ID", "env-machine");
        }
        let client = CloudClient::from_env_or_file().unwrap().expect("enrolled");
        assert_eq!(client.machine_id, "env-machine");
        assert_eq!(client.token, "env-token");
    }

    #[test]
    fn falls_back_to_the_file_when_only_some_env_vars_are_set() {
        // FAILPROOFAI_CLOUD_URL is the switch: without it, from_env returns
        // None and the file is consulted rather than erroring.
        let _lock = lock_env();
        let _guard = with_credentials_file(Some(GOOD));
        unsafe {
            std::env::set_var("FAILPROOFAI_CLOUD_TOKEN", "stray");
        }
        let client = CloudClient::from_env_or_file().unwrap().expect("enrolled");
        assert_eq!(client.machine_id, "m-1");
    }
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// The wire half of the version boundary, over a real socket.
    ///
    /// `SUPPORTED_SCHEMA_VERSIONS` accepts 1 as well, and its comment says that is
    /// "for files on DISK, never for a server" — but nothing enforced the second
    /// half, so this path took a v1 response. The disk half is now handled by a
    /// dedicated legacy type in `cloud_policies.rs`, which is what lets this end be
    /// strict without costing an upgraded machine its persisted state.
    #[test]
    fn refuses_a_desired_state_response_at_an_older_schema_version() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut discard = [0u8; 1024];
            let _ = stream.read(&mut discard);
            let body = br#"{"schemaVersion":1,"generation":7,"policies":[]}"#;
            let mut response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .into_bytes();
            response.extend_from_slice(body);
            stream.write_all(&response).unwrap();
        });

        let client = CloudClient::new(
            &format!("http://{address}"),
            "token".into(),
            "machine".into(),
        )
        .expect("client");
        let err = client
            .desired_state(None)
            .expect_err("a v1 response must be refused");

        assert!(
            err.contains("schemaVersion 1") && err.contains("speaks 2"),
            "the error must name both versions so the operator knows which half is behind, got: {err}"
        );
        server.join().unwrap();
    }

    /// The machine's own answer has to reach the wire, and "cannot say" has to
    /// stay distinguishable from "deployment 0" once it gets there.
    #[test]
    fn reports_the_applied_deployment_on_the_poll_it_already_makes() {
        for (applied, expected) in [(Some(7_u64), true), (None, false)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let captured = Arc::new(std::sync::Mutex::new(String::new()));
            let sink = captured.clone();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).unwrap();
                *sink.lock().unwrap() = String::from_utf8_lossy(&request[..read]).to_string();
                let body = br#"{"schemaVersion":2,"deployment":7,"policies":[]}"#;
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
            });

            let cloud = CloudClient::new(
                &format!("http://{address}"),
                "test-token".into(),
                "machine-1".into(),
            )
            .unwrap();
            cloud.desired_state(applied).unwrap();
            server.join().unwrap();

            let request = captured.lock().unwrap().clone();
            assert!(
                request.contains("machineId=machine-1"),
                "the existing parameter must survive: {request}"
            );
            if expected {
                assert!(
                    request.contains("appliedDeployment=7"),
                    "the applied deployment must reach the server: {request}"
                );
            } else {
                assert!(
                    !request.contains("appliedDeployment"),
                    "a machine that cannot say what it is enforcing must OMIT the \
                     parameter, not report deployment 0: {request}"
                );
            }
        }
    }

    #[test]
    fn fetches_desired_state_and_artifact_into_the_store() {
        let artifact = b"export default 'managed';\n".to_vec();
        let sha = Sha256::digest(&artifact)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let expected_sha = sha.clone();
        let expected_artifact = artifact.clone();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..read]);
                assert!(
                    request.contains("Authorization: Bearer test-token")
                        || request.contains("authorization: Bearer test-token")
                );
                let body = if request
                    .starts_with("GET /enforcement/v1/desired-state?machineId=machine-1")
                {
                    // schemaVersion 2, matching what AgentEye actually emits. This
                    // said 1 while using the v2 field names — a payload no server
                    // produces — and nothing noticed, because until the version was
                    // pinned here the wire accepted any supported version. That the
                    // fixture was incoherent is itself the evidence the wire half
                    // was untested.
                    format!(r#"{{"schemaVersion":2,"deployment":7,"policies":[{{"id":"guard","version":2,"sha256":"{expected_sha}","artifactUrl":"/enforcement/v1/artifacts/{expected_sha}"}}]}}"#).into_bytes()
                } else {
                    expected_artifact.clone()
                };
                let content_type = if request.contains("desired-state") {
                    "application/json"
                } else {
                    "text/javascript"
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: {}\r\nConnection: close\r\n\r\n", body.len(), content_type).unwrap();
                stream.write_all(&body).unwrap();
            }
        });

        let cloud = CloudClient::new(
            &format!("http://{address}"),
            "test-token".into(),
            "machine-1".into(),
        )
        .unwrap();
        let desired = cloud.desired_state(None).unwrap();
        let root =
            std::env::temp_dir().join(format!("failproofaid-http-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let store = PolicyStore::new(root.clone());
        let outcome = store
            .reconcile(&desired, &|policy: &DesiredPolicy| cloud.artifact(policy))
            .unwrap();
        assert_eq!(outcome.deployment, 7);
        assert_eq!(outcome.downloaded, 1);
        // Layout 3: one content-addressed copy, no `deployments/<n>/` tree. The
        // active manifest is what says where it landed, so assert through it
        // rather than hardcoding a path shape a second time.
        let active = store.read_active().unwrap().unwrap();
        assert_eq!(
            fs::read(root.join(&active.policies[0].path)).unwrap(),
            artifact
        );
        assert!(
            !root.join("deployments").exists(),
            "the per-deployment tree must not be recreated"
        );
        server.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    // ── Cloud Jev policies + the policyErrors report (CONTRACT C4/C5) ───────

    fn error(id: &str, message: &str) -> PolicyErrorEntry {
        PolicyErrorEntry {
            id: id.into(),
            version: Some(1),
            kind: "jev".into(),
            message: message.into(),
        }
    }

    #[test]
    fn the_report_is_compact_json_under_four_kib_encoded_and_truncates_the_list() {
        assert_eq!(encode_policy_errors(&[]), "[]");
        let one = encode_policy_errors(&[error("p", "bad sha")]);
        assert_eq!(
            one,
            r#"[{"id":"p","version":1,"kind":"jev","message":"bad sha"}]"#
        );

        // Far more than fits: the list is cut, the JSON never is.
        let many: Vec<_> = (0..200)
            .map(|i| {
                error(
                    &format!("policy-{i}"),
                    &"é needs encoding & more ".repeat(20),
                )
            })
            .collect();
        let encoded = encode_policy_errors(&many);
        assert!(encoded_len(&encoded) <= MAX_POLICY_ERRORS_ENCODED_BYTES);
        let parsed: Vec<PolicyErrorEntry> =
            serde_json::from_str(&encoded).expect("still a complete JSON array");
        assert!(!parsed.is_empty() && parsed.len() < many.len());
        assert_eq!(parsed[0].id, "policy-0", "truncated from the END");
        assert!(
            parsed[0].message.chars().count() <= MAX_POLICY_ERROR_MESSAGE_CHARS,
            "one long message cannot crowd out the rest"
        );
    }

    #[test]
    fn the_report_is_omitted_until_either_side_has_an_error_state() {
        let root = std::env::temp_dir().join(format!("failproofaid-report-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let store = PolicyStore::new(root.clone());

        assert_eq!(
            current_policy_errors(&store, None),
            None,
            "never had one: omit"
        );
        // A clean poll on such a machine does not create a state either.
        record_daemon_errors(&store, Vec::new());
        assert!(!store.daemon_errors_path().exists());
        assert_eq!(current_policy_errors(&store, None), None);

        record_daemon_errors(&store, vec![daemon_error("bad".into(), Some("p"), None)]);
        assert_eq!(current_policy_errors(&store, None).unwrap().len(), 1);
        // Fixed: the state is now `[]`, which is what clears the server.
        record_daemon_errors(&store, Vec::new());
        assert_eq!(current_policy_errors(&store, None), Some(vec![]));

        fs::write(
            store.cli_errors_path(),
            r#"{"errors":[{"id":"q","version":2,"kind":"both","message":"m"}]}"#,
        )
        .unwrap();
        let merged = current_policy_errors(&store, None).unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].id, "q");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn daemon_errors_name_the_policy_and_its_version_when_they_can() {
        let desired: DesiredState = serde_json::from_str(
            r#"{"schemaVersion":2,"deployment":1,"policies":[],
                "semanticPolicies":[{"id":"j","version":4,"sha256":"aa","artifactUrl":"/a"}]}"#,
        )
        .unwrap();
        let named = daemon_error("m".into(), Some("j"), Some(&desired));
        assert_eq!((named.id.as_str(), named.version), ("j", Some(4)));
        assert_eq!(named.kind, "daemon");
        let state = daemon_error("m".into(), None, None);
        assert_eq!((state.id.as_str(), state.version), ("desired-state", None));
    }

    /// The report reaches the wire as the `policyErrors` parameter, and is
    /// absent when there is nothing to say.
    #[test]
    fn the_poll_carries_policy_errors_when_given() {
        for report in [
            Some(r#"[{"id":"p","version":1,"kind":"jev","message":"x y"}]"#),
            None,
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let captured = Arc::new(std::sync::Mutex::new(String::new()));
            let sink = captured.clone();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 8192];
                let read = stream.read(&mut request).unwrap();
                *sink.lock().unwrap() = String::from_utf8_lossy(&request[..read]).to_string();
                let body = br#"{"schemaVersion":2,"deployment":7,"policies":[]}"#;
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
            });
            let cloud =
                CloudClient::new(&format!("http://{address}"), "t".into(), "machine-1".into())
                    .unwrap();
            cloud.poll_desired_state(Some(7), report).unwrap();
            server.join().unwrap();
            let request = captured.lock().unwrap().clone();
            let first_line = request.lines().next().unwrap_or_default().to_string();
            if report.is_some() {
                assert!(
                    first_line.contains("policyErrors=%5B%7B%22id%22%3A%22p%22"),
                    "URL-encoded compact JSON expected: {first_line}"
                );
                assert!(first_line.contains("appliedDeployment=7"));
            } else {
                assert!(!first_line.contains("policyErrors"), "{first_line}");
            }
        }
    }

    /// A payload the daemon refuses is reportable; a transport failure is not.
    #[test]
    fn only_payload_failures_are_reportable() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let cloud =
            CloudClient::new(&format!("http://127.0.0.1:{port}"), "t".into(), "m".into()).unwrap();
        assert!(!cloud.poll_desired_state(None, None).unwrap_err().reportable);
        assert!(PollFailure::payload("x".into()).reportable);
    }

    /// End to end over HTTP: a `jev` artifact is fetched through the same
    /// same-origin, bearer-authenticated path and lands as `artifacts/<sha>.json`.
    #[test]
    fn fetches_a_semantic_artifact_into_the_store() {
        let decls = br#"[{"name":"acme-x"}]"#.to_vec();
        let sha = Sha256::digest(&decls)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let expected_sha = sha.clone();
        let body_decls = decls.clone();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..read]).to_string();
                assert!(
                    request
                        .to_ascii_lowercase()
                        .contains("authorization: bearer tok")
                );
                let body = if request.contains("desired-state") {
                    format!(r#"{{"schemaVersion":2,"deployment":3,"policies":[],"semanticPolicies":[{{"id":"j","version":1,"sha256":"{expected_sha}","artifactUrl":"/enforcement/v1/artifacts/{expected_sha}"}}],"jevMode":"enforce"}}"#).into_bytes()
                } else {
                    assert!(
                        request
                            .starts_with(&format!("GET /enforcement/v1/artifacts/{expected_sha}"))
                    );
                    body_decls.clone()
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        let cloud =
            CloudClient::new(&format!("http://{address}"), "tok".into(), "m".into()).unwrap();
        let desired = cloud.desired_state(None).unwrap();
        let root =
            std::env::temp_dir().join(format!("failproofaid-jev-http-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let store = PolicyStore::new(root.clone());
        store
            .reconcile(&desired, &|policy: &DesiredPolicy| cloud.artifact(policy))
            .unwrap();
        let active = store.read_active().unwrap().unwrap();
        assert_eq!(active.jev_mode.as_deref(), Some("enforce"));
        assert_eq!(
            active.semantic_policies[0].path,
            format!("artifacts/{sha}.json")
        );
        assert_eq!(
            fs::read(root.join(&active.semantic_policies[0].path)).unwrap(),
            decls
        );
        server.join().unwrap();
        fs::remove_dir_all(root).ok();
    }

    // ── Disconnect sticks (review M2) ────────────────────────────────────────

    use crate::cloud_policies::cloud_jev_tests::{jev_state, serve, temp_store};

    /// A store holding a `both` + `jev` deployment with `jevMode: observe`.
    fn deployed_store(name: &str) -> PolicyStore {
        let store = temp_store(name);
        store.reconcile(&jev_state(12), &serve).unwrap();
        store
    }

    /// Exactly what `config --disconnect` removes
    /// (`clearActiveCloudManagedPolicies` in `cloud-managed-policies.ts`).
    fn disconnect_like_the_cli(store: &PolicyStore) {
        for path in [
            store.desired_state_path(),
            store.active_manifest_path(),
            store.cli_errors_path(),
            store.daemon_errors_path(),
        ] {
            let _ = fs::remove_file(path);
        }
    }

    /// Enrolled, and nothing answers: a port that was bound and released.
    fn offline_client() -> CloudClient {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        CloudClient::new(&format!("http://127.0.0.1:{port}"), "t".into(), "m".into()).unwrap()
    }

    fn no_cloud_state(store: &PolicyStore) -> bool {
        [
            store.desired_state_path(),
            store.active_manifest_path(),
            store.cli_errors_path(),
            store.daemon_errors_path(),
        ]
        .iter()
        .all(|path| !path.exists())
    }

    /// The review's M2 scenario: after `config --disconnect` the old org's
    /// JS policies, Jev checks and Jev mode used to be rebuilt from the cache
    /// within one interval. Now nothing reappears, tick after tick.
    #[test]
    fn a_disconnected_machine_stays_empty_across_maintenance_ticks() {
        let store = deployed_store("disconnect-sticks");
        disconnect_like_the_cli(&store);
        for tick in 0..3 {
            maintenance_tick(&store, Ok(None), &|| true, &|| true);
            assert!(
                no_cloud_state(&store),
                "cloud state reappeared on tick {tick}"
            );
        }
        fs::remove_dir_all(store.root()).ok();
    }

    /// An older CLI removed only `active.json`. Unenrolled, the daemon does not
    /// rebuild it from the leftover snapshot; put back on OSS, it removes the
    /// snapshot too, so nothing ever can.
    #[test]
    fn an_unenrolled_machine_never_rebuilds_from_a_leftover_snapshot() {
        let store = deployed_store("leftover-snapshot");
        fs::remove_file(store.active_manifest_path()).unwrap();

        maintenance_tick(&store, Ok(None), &|| true, &|| false);
        assert!(!store.active_manifest_path().exists());
        assert!(
            store.desired_state_path().exists(),
            "a credential that merely vanished is not an explicit disconnect; nothing is deleted"
        );

        maintenance_tick(&store, Ok(None), &|| true, &|| true);
        assert!(no_cloud_state(&store));
        maintenance_tick(&store, Ok(None), &|| true, &|| true);
        assert!(no_cloud_state(&store));
        fs::remove_dir_all(store.root()).ok();
    }

    /// The other half, which must not regress: an ENROLLED machine that cannot
    /// reach the control plane still rebuilds a lost `active.json` — Jev mode
    /// included — and a transport failure records no error state.
    #[test]
    fn a_connected_machine_that_is_offline_still_repairs() {
        let store = deployed_store("offline-repairs");
        let good = store.read_active().unwrap().unwrap();
        assert_eq!(good.jev_mode.as_deref(), Some("observe"));
        fs::remove_file(store.active_manifest_path()).unwrap();

        maintenance_tick(&store, Ok(Some(offline_client())), &|| false, &|| false);
        assert_eq!(store.read_active().unwrap().unwrap(), good);
        assert!(!store.daemon_errors_path().exists());
        fs::remove_dir_all(store.root()).ok();
    }

    /// A credential file that cannot be read is not a disconnect: the machine
    /// keeps (and repairs) its last known-good deployment.
    #[test]
    fn an_unreadable_credential_still_repairs() {
        let store = deployed_store("broken-credential");
        let good = store.read_active().unwrap().unwrap();
        fs::remove_file(store.active_manifest_path()).unwrap();

        maintenance_tick(
            &store,
            Err("invalid credentials in credentials.json".into()),
            &|| false,
            &|| true,
        );
        assert_eq!(store.read_active().unwrap().unwrap(), good);
        fs::remove_dir_all(store.root()).ok();
    }

    /// A poll in flight when `config --disconnect` runs: the server answers,
    /// every artifact is fetched, and then nothing is written — no snapshot, no
    /// pointer, no error state.
    #[test]
    fn a_disconnect_during_a_poll_discards_its_result() {
        let desired = jev_state(12);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body_state = serde_json::to_vec(&desired).unwrap();
        // Detached: it serves until the test process exits.
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).unwrap_or(0);
                let request = String::from_utf8_lossy(&request[..read]).to_string();
                let body = if request.starts_with("GET /enforcement/v1/desired-state") {
                    body_state.clone()
                } else {
                    let sha = request
                        .split_whitespace()
                        .nth(1)
                        .and_then(|path| path.rsplit('/').next())
                        .unwrap_or_default()
                        .to_string();
                    let probe = DesiredPolicy {
                        id: "x".into(),
                        version: 1,
                        sha256: sha,
                        artifact_url: String::new(),
                        effect: PolicyEffect::Enforce,
                        authority: None,
                        reviewed_by: None,
                    };
                    serve(&probe).unwrap_or_default()
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        let cloud = CloudClient::new(&format!("http://{address}"), "t".into(), "m".into()).unwrap();

        let store = temp_store("disconnect-mid-poll");
        poll_once_guarded(&store, &cloud, &|| true);
        assert!(no_cloud_state(&store));

        // Still enrolled, the same poll applies it.
        poll_once_guarded(&store, &cloud, &|| false);
        assert_eq!(store.read_active().unwrap().unwrap().deployment, 12);
        fs::remove_dir_all(store.root()).ok();
    }

    // ── A stale CLI report is not sent (e2e observation 3) ──────────────────

    fn entry(id: &str, version: Option<u64>, kind: &str, message: &str) -> PolicyErrorEntry {
        PolicyErrorEntry {
            id: id.into(),
            version,
            kind: kind.into(),
            message: message.into(),
        }
    }

    fn write_cli_errors(store: &PolicyStore, errors: &[PolicyErrorEntry]) {
        let file = serde_json::json!({ "errors": errors });
        fs::write(store.cli_errors_path(), serde_json::to_vec(&file).unwrap()).unwrap();
    }

    const NO_MODE_NO_FILE: &str = "jev_unconfigured: FailproofAI Cloud sets no Jev mode for this machine and it has \
         no jev.json, so its FailproofAI Cloud Jev checks are never asked";
    const NO_MODE_LOCAL_OFF: &str = "jev_unconfigured: Jev is off on this machine (jev.json mode off) and FailproofAI \
         Cloud sets no Jev mode, so its FailproofAI Cloud Jev checks are never asked";
    const PACK_DROP: &str = "jev_budget: dropped acme-x (5 chars over)";

    /// `errors.json` is rewritten only when a hook runs, so a Cloud-side fix
    /// used to leave the fleet page showing the old problem until the next
    /// tool call. Entries about a policy no longer deployed, or deployed at
    /// another version, are not sent; the daemon's own entries always are.
    #[test]
    fn cli_errors_about_policies_no_longer_in_force_are_not_reported() {
        // `no-prod-db@3` (both) + `secrets-in-output@1` (jev), Jev mode observe.
        let store = deployed_store("stale-report");
        write_cli_errors(
            &store,
            &[
                entry("no-prod-db", Some(3), "both", "reviewedBy names acme-x"),
                entry("no-prod-db", Some(2), "both", "an older version's problem"),
                entry("secrets-in-output", Some(1), "jev", "dropped: probe #1"),
                entry("secrets-in-output", None, "jev", "no version named"),
                entry("removed-policy", Some(1), "regex", "failed to load"),
                entry("active.json", None, "daemon", "cannot read the manifest"),
                entry("pack:acme/pack", None, "daemon", PACK_DROP),
                entry("jevMode", None, "daemon", "jev_unconfigured"),
                entry("jevMode", None, "daemon", NO_MODE_NO_FILE),
            ],
        );
        store
            .write_daemon_policy_errors(&[entry(
                "removed-policy",
                Some(1),
                "daemon",
                "sha mismatch",
            )])
            .unwrap();

        let active = store.read_active().unwrap();
        let sent = current_policy_errors(&store, Some(active.as_ref())).unwrap();
        let sent: Vec<(&str, Option<u64>, &str)> = sent
            .iter()
            .map(|e| (e.id.as_str(), e.version, e.message.as_str()))
            .collect();
        assert_eq!(
            sent,
            vec![
                // The daemon's own: its last reconcile, of the DESIRED state.
                ("removed-policy", Some(1), "sha mismatch"),
                ("no-prod-db", Some(3), "reviewedBy names acme-x"),
                ("secrets-in-output", Some(1), "dropped: probe #1"),
                ("secrets-in-output", None, "no version named"),
                ("active.json", None, "cannot read the manifest"),
                ("pack:acme/pack", None, PACK_DROP),
                // Cloud sets observe: "no provider for it" is current, and
                // "Cloud sets no Jev mode" is the state before that was set.
                ("jevMode", None, "jev_unconfigured"),
            ]
        );

        // Nothing is deployed any more: only machine-level entries remain.
        let sent = current_policy_errors(&store, Some(None)).unwrap();
        assert_eq!(
            sent.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["removed-policy", "active.json"]
        );

        // The deployment could not be read: "cannot tell" drops nothing.
        assert_eq!(current_policy_errors(&store, None).unwrap().len(), 10);
        fs::remove_dir_all(store.root()).ok();
    }

    /// The Jev entries the CLI reports only in some Jev states — the same
    /// conditions as `recordCloudPolicyErrors` in `src/hooks/handler.ts`.
    #[test]
    fn jev_setup_reports_are_kept_only_while_the_deployment_can_produce_them() {
        let base = deployed_active();
        let with = |semantic: bool, mode: Option<&str>| {
            let mut active = base.clone();
            if !semantic {
                active.semantic_policies.clear();
            }
            active.jev_mode = mode.map(str::to_string);
            active
        };
        let unconfigured = entry("jevMode", None, "daemon", "jev_unconfigured");
        let detail = entry(
            "jevMode",
            None,
            "daemon",
            "jev_unconfigured: jev.json is refused — too open",
        );
        let no_mode = entry("jevMode", None, "daemon", NO_MODE_NO_FILE);
        let local_off = entry("jevMode", None, "daemon", NO_MODE_LOCAL_OFF);
        let pack = entry("pack:acme/pack", None, "daemon", PACK_DROP);
        let unknown_mode = entry(
            "jevMode",
            None,
            "daemon",
            "unknown Jev mode \"loud\" ignored",
        );
        let manifest = entry("active.json", None, "daemon", "EACCES");

        // (semantic checks deployed, Cloud's mode) → [unconfigured, detail,
        // no_mode, local_off, pack] kept?
        let cases: [(bool, Option<&str>, [bool; 5]); 7] = [
            // No Cloud mode and Cloud Jev checks: only the local setup can ask them.
            (true, None, [true, true, true, true, true]),
            // Cloud sets a mode that asks: the "sets no mode" reports are old.
            (true, Some("enforce"), [true, true, false, false, true]),
            (true, Some("observe"), [true, true, false, false, true]),
            // Cloud switched Jev off: nothing about Jev is reported.
            (true, Some("off"), [false, false, false, false, false]),
            // A mode with no Cloud Jev checks still governs the machine's packs.
            (false, Some("enforce"), [true, true, false, false, false]),
            // Neither: the CLI reports no Jev setup problem at all.
            (false, None, [false, false, false, false, false]),
            (false, Some("off"), [false, false, false, false, false]),
        ];
        for (semantic, mode, expected) in cases {
            let active = with(semantic, mode);
            let kept = [&unconfigured, &detail, &no_mode, &local_off, &pack]
                .map(|e| cli_entry_is_current(e, Some(&active)));
            assert_eq!(kept, expected, "semantic {semantic}, mode {mode:?}");
            // Machine-level entries that are not about the Jev state stay.
            assert!(cli_entry_is_current(&unknown_mode, Some(&active)));
            assert!(cli_entry_is_current(&manifest, Some(&active)));
        }
        // No deployment: no Jev state, no policy.
        assert!(!cli_entry_is_current(&unconfigured, None));
        assert!(!cli_entry_is_current(&pack, None));
        assert!(!cli_entry_is_current(
            &entry("no-prod-db", Some(3), "both", "m"),
            None
        ));
        assert!(cli_entry_is_current(&manifest, None));
    }

    /// The deployment of `deployed_store`, without touching disk.
    fn deployed_active() -> ActiveDeployment {
        let store = deployed_store("stale-report-active");
        let active = store.read_active().unwrap().unwrap();
        fs::remove_dir_all(store.root()).ok();
        active
    }

    /// Wired into the poll: what reaches the server is the filtered report.
    #[test]
    fn the_poll_sends_only_the_entries_that_describe_the_active_deployment() {
        let store = deployed_store("stale-report-poll");
        write_cli_errors(
            &store,
            &[
                entry("no-prod-db", Some(3), "both", "current"),
                entry("removed-policy", Some(1), "regex", "stale"),
                entry("jevMode", None, "daemon", NO_MODE_NO_FILE),
            ],
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let captured = Arc::new(std::sync::Mutex::new(String::new()));
        let sink = captured.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 8192];
            let read = stream.read(&mut request).unwrap();
            *sink.lock().unwrap() = String::from_utf8_lossy(&request[..read]).to_string();
            // The same deployment, so the reconcile has nothing to fetch.
            let body = serde_json::to_vec(&jev_state(12)).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        });
        let cloud = CloudClient::new(&format!("http://{address}"), "t".into(), "m".into()).unwrap();
        poll_once_guarded(&store, &cloud, &|| false);
        server.join().unwrap();

        let request = captured.lock().unwrap().clone();
        let target = request
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_string();
        let url = Url::parse(&format!("http://x.invalid{target}")).unwrap();
        let report = url
            .query_pairs()
            .find(|(key, _)| key == "policyErrors")
            .map(|(_, value)| value.to_string())
            .expect("the report is sent");
        let report: Vec<PolicyErrorEntry> = serde_json::from_str(&report).unwrap();
        assert_eq!(
            report,
            vec![entry("no-prod-db", Some(3), "both", "current")]
        );
        fs::remove_dir_all(store.root()).ok();
    }

    // ── Review n1: a fetch that never got an answer is not an error state ───

    #[test]
    fn an_artifact_fetch_that_never_got_an_answer_is_not_recorded() {
        let request = jev_state(1).policies[0].clone();
        let message = offline_client().artifact(&request).unwrap_err();
        assert!(message.starts_with(ARTIFACT_TRANSPORT_FAILURE), "{message}");
        assert!(transient_fetch_failure(&ReconcileError::Fetch {
            policy_id: "no-prod-db".into(),
            message,
        }));

        // An HTTP answer is the server's to see, and stays reported.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            write!(
                stream,
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let cloud = CloudClient::new(&format!("http://{address}"), "t".into(), "m".into()).unwrap();
        let message = cloud.artifact(&request).unwrap_err();
        server.join().unwrap();
        assert!(message.starts_with("artifact request failed"), "{message}");
        assert!(!transient_fetch_failure(&ReconcileError::Fetch {
            policy_id: "no-prod-db".into(),
            message,
        }));
        assert!(!transient_fetch_failure(&ReconcileError::NoVerifiedCopy {
            policy_id: "no-prod-db".into(),
        }));
    }

    // ── C9.5: no local paths on the wire ────────────────────────────────────

    /// The same cases as `cloud-policy-errors` in the CLI's vitest suite
    /// (`redactLocalPaths`), so the two copies of the rule cannot drift.
    #[test]
    fn policy_error_messages_carry_no_local_paths() {
        let home = Some("/home/alice");
        for (input, expected) in [
            (
                "path missing: /home/alice/.failproofai/policies/cloud-policies/artifacts/ab.mjs",
                "path missing: ~/.failproofai/policies/cloud-policies/artifacts/ab.mjs",
            ),
            (
                "Cannot find module '/tmp/fp-load-1/x.mjs' imported from /opt/app/y.mjs",
                "Cannot find module 'x.mjs' imported from y.mjs",
            ),
            (
                "jev.json is too open (chmod 600 /home/alice/.failproofai/jev.json)",
                "jev.json is too open (chmod 600 ~/.failproofai/jev.json)",
            ),
            (
                "/home/alice2/notes.txt is not home",
                "notes.txt is not home",
            ),
            ("home is /home/alice", "home is ~"),
            ("dir=/var/lib/fp/, done", "dir=fp, done"),
            (
                "GET https://cloud.example/enforcement/v1/artifacts/ab failed; a/b stays",
                "GET https://cloud.example/enforcement/v1/artifacts/ab failed; a/b stays",
            ),
            ("the root / itself", "the root / itself"),
            // After `:` too (review F6), but never a URL's `//host`.
            (
                "import failed: file:///tmp/fp-load-1/x.mjs not found",
                "import failed: file:x.mjs not found",
            ),
            ("open:/etc/fp/x failed", "open:x failed"),
            (
                "at file:///home/alice/.failproofai/x.mjs:3",
                "at file://~/.failproofai/x.mjs:3",
            ),
            (
                "see http://localhost:8080/a/b and ssh://git@host/r",
                "see http://localhost:8080/a/b and ssh://git@host/r",
            ),
            ("a bare scheme:// stays", "a bare scheme:// stays"),
        ] {
            assert_eq!(redact_local_paths(input, home), expected, "{input}");
            // Applied twice (CLI, then daemon): the second pass changes nothing.
            assert_eq!(redact_local_paths(expected, home), expected, "{input}");
        }
        assert_eq!(redact_local_paths("/home/alice/x", None), "x");

        let encoded =
            encode_policy_errors(&[error("guard", "path missing: /var/lib/fp/artifacts/ab.mjs")]);
        assert!(encoded.contains("path missing: ab.mjs"), "{encoded}");
        assert!(!encoded.contains("/var/lib"), "{encoded}");
    }

    #[test]
    fn rejects_cross_origin_artifacts_before_sending_the_token() {
        let cloud =
            CloudClient::new("https://cloud.example", "secret".into(), "machine".into()).unwrap();
        let policy = DesiredPolicy {
            id: "guard".into(),
            version: 1,
            sha256: "0".repeat(64),
            artifact_url: "https://evil.example/artifact".into(),
            effect: PolicyEffect::Enforce,
            authority: None,
            reviewed_by: None,
        };
        assert!(cloud.artifact(&policy).unwrap_err().contains("outside"));
    }

    /// A failed poll names its cause. reqwest's own message is only "error
    /// sending request for url"; a refused connection, a DNS failure and an
    /// untrusted certificate all read the same until the source chain is kept.
    #[test]
    fn a_failed_poll_names_the_underlying_cause() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let cloud = CloudClient::new(
            &format!("http://127.0.0.1:{port}"),
            "secret".into(),
            "machine".into(),
        )
        .unwrap();
        let err = cloud.desired_state(None).unwrap_err();
        assert!(err.contains("Connection refused"), "{err}");
    }

    /// Plain http may not carry the machine token off the host.
    ///
    /// `new()` checked only that the scheme was http OR https, so
    /// `http://internal-agenteye.example` was accepted and `spawn_maintenance()`
    /// then put the org-scoped `policies:pull` bearer on the wire in clear every
    /// 30 seconds. `validateCloudUrl()` in `cloud-enrollment.ts` has always
    /// blocked this, and `configure-wizard.ts` documents the daemon as enforcing
    /// the same rule — this is what makes that true.
    #[test]
    fn plain_http_may_not_leave_the_local_machine() {
        for url in [
            "http://internal-agenteye.example",
            "http://10.0.0.5:8080",
            "http://be.failproof.ai",
            // Not loopback merely because the name contains it.
            "http://localhost.evil.example",
        ] {
            let Err(err) = CloudClient::new(url, "secret".into(), "machine".into()) else {
                panic!("{url} must be refused over plain http");
            };
            assert!(
                err.contains("plain http"),
                "expected a transport refusal for {url}, got: {err}"
            );
        }

        // Loopback over http stays allowed — it is how local development and
        // the e2e harness point the daemon at a test server.
        for url in [
            "http://localhost:3000",
            "http://127.0.0.1:8080",
            "http://[::1]:8080",
        ] {
            CloudClient::new(url, "secret".into(), "machine".into())
                .unwrap_or_else(|err| panic!("{url} should be allowed, got: {err}"));
        }

        // https is unrestricted, loopback or not.
        CloudClient::new("https://be.failproof.ai", "secret".into(), "machine".into()).unwrap();
    }

    // ── Layout 3: the enrolment lives in credentials.json ────────────────────
    //
    // These cover the bug that made cloud-managed policy dead on arrival:
    // `--connect` wrote `credentials.json`'s `cloud` object, this loader read
    // `cloud.json`, and the daemon logged "cloud-managed policy polling
    // disabled" — indistinguishable from a machine that had never enrolled.

    /// A FAILPROOFAI_HOME containing the given files. Clears the JSON override
    /// so the default (credentials.json) path is what gets exercised.
    fn with_home(files: &[(&str, &str)]) -> EnvGuard {
        let seq = SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("failproofaid-home-{}-{seq}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for (name, contents) in files {
            fs::write(dir.join(name), contents).unwrap();
        }
        unsafe {
            std::env::remove_var("FAILPROOFAI_CLOUD_CREDENTIALS");
            std::env::remove_var("FAILPROOFAI_CLOUD_URL");
            std::env::remove_var("FAILPROOFAI_CLOUD_TOKEN");
            std::env::remove_var("FAILPROOFAI_MACHINE_ID");
            std::env::set_var("FAILPROOFAI_HOME", &dir);
        }
        EnvGuard(dir)
    }

    const FILE_CREDS: &str =
        r#"{"cloud":{"url":"https://cloud.example","machine_id":"m-json","token":"json-secret"}}"#;

    #[test]
    fn reads_the_cloud_object_of_credentials_json() {
        let _lock = lock_env();
        let _guard = with_home(&[("credentials.json", FILE_CREDS)]);
        let client = CloudClient::from_file().unwrap().expect("enrolled");
        assert_eq!(client.machine_id, "m-json");
        assert_eq!(client.token, "json-secret");
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn a_credentials_file_with_no_cloud_object_is_not_enrolled_rather_than_malformed() {
        // credentials.json also holds the ingest key and the auth session, so an
        // events-only machine has a perfectly valid file and no `[cloud]`.
        // Treating that as corrupt would fail a machine that is working exactly
        // as configured.
        let _lock = lock_env();
        let _guard = with_home(&[(
            "credentials.json",
            r#"{"ingest":{"url":"https://cloud.example/v1/events","key":"k"}}"#,
        )]);
        assert!(CloudClient::from_file().unwrap().is_none());
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn falls_back_to_layout_1_cloud_json_when_credentials_json_is_absent() {
        // A machine whose daemon upgraded before its CLI ran once to migrate.
        let _lock = lock_env();
        let _guard = with_home(&[("cloud.json", GOOD)]);
        let client = CloudClient::from_file().unwrap().expect("enrolled");
        assert_eq!(client.machine_id, "m-1");
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn mode_oss_vetoes_a_surviving_credentials_file() {
        // The reported bug: switch back to OSS, and the machine keeps talking to
        // the cloud because the credential outlived the decision to leave.
        let _lock = lock_env();
        let _guard = with_home(&[
            ("credentials.json", FILE_CREDS),
            ("config.json", r#"{"mode":{"kind":"oss"}}"#),
        ]);
        assert!(CloudClient::from_file().unwrap().is_none());
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn mode_oss_vetoes_the_layout_1_fallback_too() {
        // The fallback is the easiest of the three exits to leave unguarded, and
        // the one most likely to be the file that survived a cleanup.
        let _lock = lock_env();
        let _guard = with_home(&[
            ("cloud.json", GOOD),
            ("config.json", r#"{"mode":{"kind":"oss"}}"#),
        ]);
        assert!(CloudClient::from_file().unwrap().is_none());
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    /// The OSS cleanup deletes four fixed filenames, so it runs only in the
    /// DEFAULT cloud policy directory: an operator's `FAILPROOFAI_CLOUD_POLICY_DIR`
    /// may be shared with unrelated files of those names (review F7).
    #[test]
    fn the_oss_cleanup_never_runs_in_an_overridden_policy_dir() {
        struct DirOverride;
        impl Drop for DirOverride {
            fn drop(&mut self) {
                unsafe { std::env::remove_var(crate::paths::CLOUD_POLICY_DIR_ENV) };
            }
        }
        let _lock = lock_env();
        let _guard = with_home(&[("config.json", r#"{"mode":{"kind":"oss"}}"#)]);
        let _override = DirOverride;
        let store = deployed_store("oss-cleanup-override");
        let names = [
            store.desired_state_path(),
            store.active_manifest_path(),
            store.cli_errors_path(),
            store.daemon_errors_path(),
        ];
        fs::write(store.cli_errors_path(), r#"{"errors":[]}"#).unwrap();
        fs::write(store.daemon_errors_path(), r#"{"errors":[]}"#).unwrap();
        assert!(names.iter().all(|path| path.exists()));

        unsafe { std::env::set_var(crate::paths::CLOUD_POLICY_DIR_ENV, store.root()) };
        assert!(!oss_cleanup_applies());
        maintenance_tick(&store, Ok(None), &|| true, &oss_cleanup_applies);
        assert!(
            names.iter().all(|path| path.exists()),
            "nothing is removed from an overridden directory"
        );

        // The default directory: the cleanup applies, as before.
        unsafe { std::env::remove_var(crate::paths::CLOUD_POLICY_DIR_ENV) };
        assert!(oss_cleanup_applies());
        maintenance_tick(&store, Ok(None), &|| true, &oss_cleanup_applies);
        assert!(no_cloud_state(&store));
        fs::remove_dir_all(store.root()).ok();
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn mode_cloud_still_enrols() {
        let _lock = lock_env();
        let _guard = with_home(&[
            ("credentials.json", FILE_CREDS),
            ("config.json", r#"{"mode":{"kind":"cloud"}}"#),
        ]);
        let client = CloudClient::from_file().unwrap().expect("enrolled");
        assert_eq!(client.machine_id, "m-json");
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn an_absent_or_unreadable_mode_does_not_disconnect_anyone() {
        // `mode` postdates the enrolments already in the field. Reading absent,
        // malformed or unexpected as "oss" would silently disconnect every
        // machine enrolled by an older CLI — the same silent divergence this
        // veto exists to close, with the sign flipped.
        let _lock = lock_env();
        for config in [
            None,
            Some(r#"{}"#),
            Some(r#"{ not json"#),
            Some(r#"{"mode":"OSS"}"#),
            Some(r#"{"mode":true}"#),
            // The shape this function USED to read. The TS has never written a
            // flat string — `fp-config.ts` writes `mode: { kind }` — so a bare
            // string is malformed for this schema and must not veto. Kept as a
            // fixture because it is precisely what the original fixtures said,
            // which is how the veto shipped never firing.
            Some(r#"{"mode":"oss"}"#),
            // Nested but not the value we act on.
            Some(r#"{"mode":{"kind":"cloud"}}"#),
            Some(r#"{"mode":{}}"#),
        ] {
            let mut files = vec![("credentials.json", FILE_CREDS)];
            if let Some(c) = config {
                files.push(("config.json", c));
            }
            let _guard = with_home(&files);
            assert!(
                CloudClient::from_file().unwrap().is_some(),
                "config {config:?} must not disconnect a machine nobody disconnected",
            );
        }
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn env_configuration_outranks_mode_oss() {
        // `FAILPROOFAI_CLOUD_URL` is an explicit act by whoever launched the
        // daemon, and the env path exists so CI/containers work with no files.
        // A file on disk must not veto it.
        let _lock = lock_env();
        let _guard = with_home(&[("config.json", r#"{"mode":{"kind":"oss"}}"#)]);
        unsafe {
            std::env::set_var("FAILPROOFAI_CLOUD_URL", "https://cloud.example");
            std::env::set_var("FAILPROOFAI_CLOUD_TOKEN", "t");
            std::env::set_var("FAILPROOFAI_MACHINE_ID", "m-env");
        }
        let client = CloudClient::from_env_or_file().unwrap().expect("enrolled");
        assert_eq!(client.machine_id, "m-env");
        unsafe {
            std::env::remove_var("FAILPROOFAI_CLOUD_URL");
            std::env::remove_var("FAILPROOFAI_CLOUD_TOKEN");
            std::env::remove_var("FAILPROOFAI_MACHINE_ID");
            std::env::remove_var("FAILPROOFAI_HOME");
        }
    }

    #[test]
    fn prefers_credentials_json_when_both_exist() {
        // Mid-migration both are on disk, and credentials.json is the current one.
        let _lock = lock_env();
        let _guard = with_home(&[("credentials.json", FILE_CREDS), ("cloud.json", GOOD)]);
        let client = CloudClient::from_file().unwrap().expect("enrolled");
        assert_eq!(client.machine_id, "m-json");
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn an_empty_home_is_not_enrolled() {
        let _lock = lock_env();
        let _guard = with_home(&[]);
        assert!(CloudClient::from_file().unwrap().is_none());
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn malformed_credentials_are_an_error_rather_than_a_silently_unenrolled_machine() {
        let _lock = lock_env();
        let _guard = with_home(&[("credentials.json", "{ not json")]);
        let err = match CloudClient::from_file() {
            Err(err) => err,
            Ok(_) => panic!("malformed credentials.json must not read as enrolled"),
        };
        assert!(err.contains("invalid"), "{err}");
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn a_named_override_that_is_missing_never_falls_back_to_the_default() {
        // Naming a file says "use THIS credential". Silently enrolling against
        // the one in the home directory instead would point the machine at a
        // different org than the operator asked for.
        let _lock = lock_env();
        let guard = with_home(&[("credentials.json", FILE_CREDS)]);
        unsafe {
            std::env::set_var("FAILPROOFAI_CLOUD_CREDENTIALS", guard.0.join("absent.json"));
        }
        assert!(CloudClient::from_file().unwrap().is_none());
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }
}
