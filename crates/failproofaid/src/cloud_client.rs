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

impl CloudClient {
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

pub fn spawn_cloud_manager(
    store: PolicyStore,
    cloud: CloudClient,
    shutdown: Arc<AtomicBool>,
    interval: Duration,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        while !shutdown.load(Ordering::Relaxed) {
            match cloud.desired_state() {
                Ok(desired) => match store
                    .reconcile(&desired, &|policy: &DesiredPolicy| cloud.artifact(policy))
                {
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
                },
                Err(err) => eprintln!("[failproofaid] cloud policy poll error: {err}"),
            }

            // Poll failures never discard the last known-good generation, and
            // local tampering is still repaired while the cloud is offline.
            if let Err(err) = store.repair_active_from_cache() {
                eprintln!("[failproofaid] cloud policy integrity error: {err}");
            }
            wait_until_shutdown(&shutdown, interval);
        }
    })
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
        };
        assert!(cloud.artifact(&policy).unwrap_err().contains("outside"));
    }
}
