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

/// Where the cloud credential lives — the same two rules the TS side applies in
/// `cloudCredentialPath()`, so the pair cannot drift.
///
/// Layout 2 moved this out of `~/.failproofai/cloud.json` and into the `[cloud]`
/// table of `credentials.toml`, alongside every other token. Reading the old
/// path was leaving the daemon with **no enrolment at all** on a layout-2 home:
/// it polled for cloud policy, found no credential, and reported itself as
/// simply not connected while the CLI showed a perfectly good connection.
///
/// The legacy path is deliberately NOT tried as a fallback. Layout 2 chose
/// wipe-and-re-setup over migration (see `legacy` in src/hooks/fp-home.ts —
/// "Nothing reads data from these paths"), so an old `cloud.json` on disk is
/// something the reset is expected to delete, not a credential still in force.
pub fn credentials_path() -> Option<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("FAILPROOFAI_CLOUD_CREDENTIALS") {
        return Some(std::path::PathBuf::from(path));
    }
    crate::paths::failproofai_home()
        .ok()
        .map(|home| home.join(CREDENTIALS_FILE))
}

const CREDENTIALS_FILE: &str = "credentials.toml";

/// True when the credential is coming from the JSON override rather than the
/// TOML. Mirrors the TS `usingJsonOverride()`: the env var still names a
/// standalone JSON file, because CI and container setups already use it that way
/// and it predates the consolidation.
fn using_json_override() -> bool {
    std::env::var_os("FAILPROOFAI_CLOUD_CREDENTIALS").is_some()
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
    pub fn from_file() -> Result<Option<Self>, String> {
        let Some(path) = credentials_path() else {
            return Ok(None);
        };
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(format!("failed to read {}: {err}", path.display())),
        };
        if using_json_override() {
            return Self::from_json_bytes(&bytes, &path);
        }
        let text = String::from_utf8(bytes)
            .map_err(|_| format!("{} is not valid UTF-8", path.display()))?;
        Self::from_credentials_toml(&text, &path)
    }

    /// The standalone JSON file named by `FAILPROOFAI_CLOUD_CREDENTIALS`.
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

    /// The `[cloud]` table of layout 2's `credentials.toml`.
    ///
    /// An absent or incomplete table reads as "not enrolled for policy" rather
    /// than as an error, exactly as the TS reader treats it: the same file also
    /// carries `[ingest]` and `[auth]`, so a machine reporting to the dashboard
    /// but not pulling policy is an ordinary, supported half-state — not damage.
    /// Only TOML that will not parse at all is an error, because we wrote it.
    fn from_credentials_toml(text: &str, path: &std::path::Path) -> Result<Option<Self>, String> {
        let doc: toml::Value = toml::from_str(text)
            .map_err(|err| format!("invalid credentials in {}: {err}", path.display()))?;
        let Some(cloud) = doc.get("cloud") else {
            return Ok(None);
        };
        let field = |name: &str| cloud.get(name).and_then(|v| v.as_str()).unwrap_or("");
        let (url, machine_id, token) = (field("url"), field("machine_id"), field("token"));
        if url.is_empty() || token.is_empty() || machine_id.is_empty() {
            return Ok(None);
        }
        Self::new(url, token.to_string(), machine_id.to_string()).map(Some)
    }

    fn new(base_url: &str, token: String, machine_id: String) -> Result<Self, String> {
        let mut base_url =
            Url::parse(base_url).map_err(|err| format!("invalid FAILPROOFAI_CLOUD_URL: {err}"))?;
        if !matches!(base_url.scheme(), "http" | "https") {
            return Err("FAILPROOFAI_CLOUD_URL must use http or https".to_string());
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
                std::env::remove_var("FAILPROOFAI_HOME");
            }
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A layout-2 home: `FAILPROOFAI_HOME` pointing at a scratch dir holding a
    /// `credentials.toml`, with the JSON override explicitly UNSET so the
    /// default path is what gets exercised.
    fn with_home_credentials(contents: Option<&str>) -> EnvGuard {
        let seq = SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("failproofaid-home-{}-{seq}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        if let Some(contents) = contents {
            fs::write(dir.join(CREDENTIALS_FILE), contents).unwrap();
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

    const TOML_GOOD: &str = "[cloud]\nurl = \"https://cloud.example\"\n\
         machine_id = \"m-1\"\nmachine_label = \"Chetan's laptop\"\ntoken = \"secret\"\n";

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

    // ── layout 2: credentials.toml [cloud] ───────────────────────────────────

    #[test]
    fn reads_the_cloud_table_from_a_layout_2_credentials_file() {
        // THE REGRESSION. Layout 2 moved the credential into credentials.toml,
        // and this reader was still looking for ~/.failproofai/cloud.json — so
        // an enrolled machine's daemon found nothing, quietly polled no policy,
        // and reported itself unconnected while the CLI showed a live
        // connection.
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_home_credentials(Some(TOML_GOOD));
        let client = CloudClient::from_file()
            .unwrap()
            .expect("should be enrolled");
        assert_eq!(client.machine_id, "m-1");
    }

    #[test]
    fn a_credentials_file_with_no_cloud_table_is_not_enrolled_rather_than_an_error() {
        // The same file carries [ingest] and [auth]. Reporting to the dashboard
        // without pulling policy is an ordinary half-state, not damage.
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_home_credentials(Some("[ingest]\nurl = \"https://x\"\nkey = \"k\"\n"));
        assert!(CloudClient::from_file().unwrap().is_none());
    }

    #[test]
    fn an_incomplete_cloud_table_reads_as_not_enrolled() {
        // Mirrors the TS reader, which requires url, machine_id and token before
        // it will call a machine connected. Drifting from it is what produced
        // the bug above.
        let _lock = ENV_LOCK.lock().unwrap();
        for partial in [
            "[cloud]\nurl = \"https://x\"\n",
            "[cloud]\nurl = \"https://x\"\nmachine_id = \"m\"\n",
            "[cloud]\nurl = \"\"\nmachine_id = \"m\"\ntoken = \"t\"\n",
            "[cloud]\nurl = \"https://x\"\nmachine_id = \"m\"\ntoken = \"\"\n",
        ] {
            let _guard = with_home_credentials(Some(partial));
            assert!(
                CloudClient::from_file().unwrap().is_none(),
                "should not be enrolled: {partial}"
            );
        }
    }

    #[test]
    fn malformed_toml_is_an_error_not_a_silent_disconnect() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_home_credentials(Some("[cloud\nurl = "));
        assert!(CloudClient::from_file().is_err());
    }

    #[test]
    fn no_credentials_toml_at_all_means_not_enrolled() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_home_credentials(None);
        assert!(CloudClient::from_file().unwrap().is_none());
    }

    #[test]
    fn a_leftover_layout_1_cloud_json_is_ignored() {
        // Layout 2 chose wipe-and-re-setup over migration, so an old cloud.json
        // is something the reset deletes — not a credential still in force.
        // Honouring it here would resurrect an enrolment the CLI considers gone.
        let _lock = ENV_LOCK.lock().unwrap();
        let guard = with_home_credentials(None);
        fs::write(guard.0.join("cloud.json"), GOOD).unwrap();
        assert!(CloudClient::from_file().unwrap().is_none());
    }

    #[test]
    fn the_json_override_still_reads_json() {
        // CI and containers point FAILPROOFAI_CLOUD_CREDENTIALS at a standalone
        // JSON file; that predates the consolidation and must keep working.
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = with_credentials_file(Some(GOOD));
        let client = CloudClient::from_file()
            .unwrap()
            .expect("should be enrolled");
        assert_eq!(client.machine_id, "m-1");
    }
}
