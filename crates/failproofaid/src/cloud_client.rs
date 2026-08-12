use crate::cloud_policies::{
    DESIRED_STATE_SCHEMA_VERSION, DesiredPolicy, DesiredState, PolicyStore,
};
use reqwest::Url;
use reqwest::blocking::Client;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const DEFAULT_POLL_MS: u64 = 30_000;
const MINIMUM_POLL_MS: u64 = 100;

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

impl CloudClient {
    /// Environment first, then the credential file.
    ///
    /// Env wins so CI, containers and tests keep working unchanged, and so an
    /// operator who prefers env-only configuration loses nothing.
    pub fn from_env_or_file() -> Result<Option<Self>, String> {
        if let Some(client) = Self::from_env()? {
            return Ok(Some(client));
        }
        Self::from_file()
    }

    pub fn from_env() -> Result<Option<Self>, String> {
        let Some(base_url) = env_value("FAILPROOFAI_CLOUD_URL") else {
            return Ok(None);
        };
        let token = env_value("FAILPROOFAI_CLOUD_TOKEN")
            .ok_or("FAILPROOFAI_CLOUD_TOKEN is required when FAILPROOFAI_CLOUD_URL is set")?;
        let machine_id = env_value("FAILPROOFAI_MACHINE_ID")
            .ok_or("FAILPROOFAI_MACHINE_ID is required when FAILPROOFAI_CLOUD_URL is set")?;
        Self::new(&base_url, token, machine_id).map(Some)
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
    pub fn from_file() -> Result<Option<Self>, String> {
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
        Self::new(&cloud.url, cloud.token, cloud.machine_id).map(Some)
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
        Self::new(&stored.url, stored.token, stored.machine_id).map(Some)
    }

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
            .map_err(|err| format!("failed to build cloud HTTP client: {err}"))?;
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
    pub fn desired_state(&self, applied: Option<u64>) -> Result<DesiredState, String> {
        let mut url = self
            .base_url
            .join("enforcement/v1/desired-state")
            .map_err(|err| format!("failed to build desired-state URL: {err}"))?;
        url.query_pairs_mut()
            .append_pair("machineId", &self.machine_id);
        if let Some(deployment) = applied {
            url.query_pairs_mut()
                .append_pair("appliedDeployment", &deployment.to_string());
        }
        self.client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|err| format!("desired-state request failed: {err}"))?
            .json::<serde_json::Value>()
            .map_err(|err| format!("invalid desired-state response: {err}"))
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
                        return Err(format!(
                            "server sent desired-state schemaVersion {v} but this daemon \
                             speaks {DESIRED_STATE_SCHEMA_VERSION} — upgrade whichever half is behind"
                        ));
                    }
                    None => {
                        return Err(
                            "desired-state response has no schemaVersion field".to_string()
                        );
                    }
                }
                serde_json::from_value::<DesiredState>(raw)
                    .map_err(|err| format!("invalid desired-state response: {err}"))
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
            .map_err(|err| format!("artifact request failed: {err}"))?
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|err| format!("failed to read artifact response: {err}"))
    }
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
            let cloud = match CloudClient::from_env_or_file() {
                Ok(client) => client,
                Err(err) => {
                    eprintln!("[failproofaid] cloud enrolment error: {err}");
                    None
                }
            };

            // Log only on transition, so a disconnected machine does not print
            // a line every 30 seconds forever.
            let enrolled = cloud.is_some();
            if last_state != Some(enrolled) {
                eprintln!(
                    "[failproofaid] cloud-managed policy polling {}",
                    if enrolled { "enabled" } else { "disabled" }
                );
                last_state = Some(enrolled);
            }

            if let Some(cloud) = cloud.as_ref() {
                poll_once(&store, cloud);
            }

            // Runs whether or not cloud is reachable: poll failures never
            // discard the last known-good deployment, and local tampering is
            // still repaired while the cloud is offline or unconfigured.
            if let Err(err) = store.repair_active_from_cache() {
                eprintln!("[failproofaid] cloud policy integrity error: {err}");
            }
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

fn poll_once(store: &PolicyStore, cloud: &CloudClient) {
    // Read BEFORE the request, so what we report is what was in force when we
    // asked. Reading after would race this poll's own reconcile and could claim
    // a deployment the server is about to be told about anyway — reporting the
    // future rather than the present.
    //
    // An unreadable manifest reports nothing rather than guessing: `read_active`
    // already distinguishes "no deployment" from "cannot tell", and collapsing
    // the second into the first is how a machine ends up recorded as enforcing
    // something it is not.
    let applied = match store.read_active() {
        Ok(active) => active.map(|a| a.deployment),
        Err(err) => {
            eprintln!("[failproofaid] could not read the active deployment to report it: {err}");
            None
        }
    };
    match cloud.desired_state(applied) {
        Ok(desired) => {
            match store.reconcile(&desired, &|policy: &DesiredPolicy| cloud.artifact(policy)) {
                Ok(outcome)
                    if outcome.activated || outcome.downloaded > 0 || outcome.repaired > 0 =>
                {
                    eprintln!(
                        "[failproofaid] cloud policy deployment {} active (downloaded {}, repaired {})",
                        outcome.deployment, outcome.downloaded, outcome.repaired
                    );
                }
                Ok(_) => {}
                Err(err) => eprintln!("[failproofaid] cloud policy reconcile error: {err}"),
            }
        }
        Err(err) => eprintln!("[failproofaid] cloud policy poll error: {err}"),
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
        };
        assert!(cloud.artifact(&policy).unwrap_err().contains("outside"));
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
