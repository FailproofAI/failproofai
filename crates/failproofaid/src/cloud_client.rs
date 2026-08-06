use crate::cloud_policies::{DesiredPolicy, DesiredState, PolicyStore};
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

/// `~/.failproofai/credentials.toml` — where layout 2 keeps the enrolment.
pub fn credentials_path() -> Option<std::path::PathBuf> {
    if let Some(path) = credentials_json_override() {
        return Some(path);
    }
    crate::paths::failproofai_home()
        .ok()
        .map(|home| home.join("credentials.toml"))
}

/// `~/.failproofai/cloud.json` — layout 1. Read only if the TOML is absent.
fn legacy_credentials_path() -> Option<std::path::PathBuf> {
    crate::paths::failproofai_home()
        .ok()
        .map(|home| home.join("cloud.json"))
}

/// The `[cloud]` table of `credentials.toml`. Snake_case keys, because that is
/// what `fp-config.ts`'s `writeCredentials` emits.
#[derive(serde::Deserialize)]
struct TomlCredentials {
    cloud: Option<TomlCloud>,
}

#[derive(serde::Deserialize)]
struct TomlCloud {
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
    ///   1. `credentials.toml`'s `[cloud]` table — what layout 2 writes, and
    ///      what `--connect` has produced since. Also the JSON shape when
    ///      `FAILPROOFAI_CLOUD_CREDENTIALS` names a file, which is how the
    ///      override has always worked.
    ///   2. `cloud.json` — layout 1, read ONLY when the TOML is absent, for a
    ///      machine whose daemon upgraded before its CLI ran once to migrate.
    ///      Never preferred: mid-migration both exist and the TOML is current.
    ///
    /// Reading only (1)'s old location is what made cloud-managed policy dead on
    /// arrival in layout 2 — `--connect` reported success, wrote a credential
    /// the daemon never looked at, and the daemon logged "cloud-managed policy
    /// polling disabled" as though the machine had simply never enrolled.
    pub fn from_file() -> Result<Option<Self>, String> {
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

        let parsed: TomlCredentials = toml::from_str(
            std::str::from_utf8(&bytes)
                .map_err(|err| format!("{} is not valid UTF-8: {err}", path.display()))?,
        )
        .map_err(|err| format!("invalid credentials in {}: {err}", path.display()))?;

        // The file exists for the ingest key and the auth session too, so no
        // `[cloud]` table means "not enrolled for policy" — not a malformed file.
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

    pub fn desired_state(&self) -> Result<DesiredState, String> {
        let mut url = self
            .base_url
            .join("enforcement/v1/desired-state")
            .map_err(|err| format!("failed to build desired-state URL: {err}"))?;
        url.query_pairs_mut()
            .append_pair("machineId", &self.machine_id);
        self.client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|err| format!("desired-state request failed: {err}"))?
            .json()
            .map_err(|err| format!("invalid desired-state response: {err}"))
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
/// a machine that was pulling policy keeps its last known-good generation and
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
            // discard the last known-good generation, and local tampering is
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
    match cloud.desired_state() {
        Ok(desired) => {
            match store.reconcile(&desired, &|policy: &DesiredPolicy| cloud.artifact(policy)) {
                Ok(outcome)
                    if outcome.activated || outcome.downloaded > 0 || outcome.repaired > 0 =>
                {
                    eprintln!(
                        "[failproofaid] cloud policy generation {} active (downloaded {}, repaired {})",
                        outcome.generation, outcome.downloaded, outcome.repaired
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
    // each other or with anything else reading the same variables.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_credentials_file(None);
        assert!(CloudClient::from_file().unwrap().is_none());
    }

    #[test]
    fn reads_a_valid_credentials_file() {
        let _lock = ENV_LOCK.lock().unwrap();
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
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_credentials_file(Some("{ not json"));
        let err = CloudClient::from_file()
            .err()
            .expect("malformed file must error");
        assert!(err.contains("invalid credentials"), "{err}");
    }

    #[test]
    fn rejects_an_unknown_schema_version() {
        let _lock = ENV_LOCK.lock().unwrap();
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
        let _lock = ENV_LOCK.lock().unwrap();
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
        let _lock = ENV_LOCK.lock().unwrap();
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
        let _lock = ENV_LOCK.lock().unwrap();
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

    #[test]
    fn fetches_desired_state_and_artifact_into_the_store() {
        let artifact = b"export default 'managed';\n".to_vec();
        let sha = format!("{:x}", Sha256::digest(&artifact));
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
                    format!(r#"{{"schemaVersion":1,"generation":7,"policies":[{{"id":"guard","revision":2,"sha256":"{expected_sha}","artifactUrl":"/enforcement/v1/artifacts/{expected_sha}"}}]}}"#).into_bytes()
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
        let desired = cloud.desired_state().unwrap();
        let root =
            std::env::temp_dir().join(format!("failproofaid-http-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let store = PolicyStore::new(root.clone());
        let outcome = store
            .reconcile(&desired, &|policy: &DesiredPolicy| cloud.artifact(policy))
            .unwrap();
        assert_eq!(outcome.generation, 7);
        assert_eq!(outcome.downloaded, 1);
        assert_eq!(
            fs::read(root.join("generations/7/guard.mjs")).unwrap(),
            artifact
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
            revision: 1,
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

    // ── Layout 2: the enrolment lives in credentials.toml ────────────────────
    //
    // These cover the bug that made cloud-managed policy dead on arrival:
    // `--connect` wrote `credentials.toml`'s `[cloud]` table, this loader read
    // `cloud.json`, and the daemon logged "cloud-managed policy polling
    // disabled" — indistinguishable from a machine that had never enrolled.

    /// A FAILPROOFAI_HOME containing the given files. Clears the JSON override
    /// so the default (TOML) path is what gets exercised.
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

    const TOML_CREDS: &str = "[cloud]\nurl = \"https://cloud.example\"\nmachine_id = \"m-toml\"\ntoken = \"toml-secret\"\n";

    #[test]
    fn reads_the_cloud_table_of_credentials_toml() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_home(&[("credentials.toml", TOML_CREDS)]);
        let client = CloudClient::from_file().unwrap().expect("enrolled");
        assert_eq!(client.machine_id, "m-toml");
        assert_eq!(client.token, "toml-secret");
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn a_credentials_file_with_no_cloud_table_is_not_enrolled_rather_than_malformed() {
        // credentials.toml also holds the ingest key and the auth session, so an
        // events-only machine has a perfectly valid file and no `[cloud]`.
        // Treating that as corrupt would fail a machine that is working exactly
        // as configured.
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_home(&[(
            "credentials.toml",
            "[ingest]\nurl = \"https://cloud.example/v1/events\"\nkey = \"k\"\n",
        )]);
        assert!(CloudClient::from_file().unwrap().is_none());
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn falls_back_to_layout_1_cloud_json_when_the_toml_is_absent() {
        // A machine whose daemon upgraded before its CLI ran once to migrate.
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_home(&[("cloud.json", GOOD)]);
        let client = CloudClient::from_file().unwrap().expect("enrolled");
        assert_eq!(client.machine_id, "m-1");
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn prefers_the_toml_when_both_exist() {
        // Mid-migration both are on disk, and the TOML is the current one.
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_home(&[("credentials.toml", TOML_CREDS), ("cloud.json", GOOD)]);
        let client = CloudClient::from_file().unwrap().expect("enrolled");
        assert_eq!(client.machine_id, "m-toml");
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn an_empty_home_is_not_enrolled() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_home(&[]);
        assert!(CloudClient::from_file().unwrap().is_none());
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn a_malformed_toml_is_an_error_rather_than_a_silently_unenrolled_machine() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_home(&[("credentials.toml", "[cloud]\nurl = ")]);
        let err = match CloudClient::from_file() {
            Err(err) => err,
            Ok(_) => panic!("a malformed credentials.toml must not read as enrolled"),
        };
        assert!(err.contains("invalid"), "{err}");
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }

    #[test]
    fn a_named_override_that_is_missing_never_falls_back_to_the_default() {
        // Naming a file says "use THIS credential". Silently enrolling against
        // the one in the home directory instead would point the machine at a
        // different org than the operator asked for.
        let _lock = ENV_LOCK.lock().unwrap();
        let guard = with_home(&[("credentials.toml", TOML_CREDS)]);
        unsafe {
            std::env::set_var("FAILPROOFAI_CLOUD_CREDENTIALS", guard.0.join("absent.json"));
        }
        assert!(CloudClient::from_file().unwrap().is_none());
        unsafe { std::env::remove_var("FAILPROOFAI_HOME") };
    }
}
