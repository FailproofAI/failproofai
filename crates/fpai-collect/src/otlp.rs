//! Opaque OTLP/HTTP relay. No translation, decompression or event-uploader reuse.
//! Each batch is a JSON metadata line followed by the exact request bytes.
//! SDK exporters publish the same format; only atomic .jsonl files are read.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::post;
use serde::{Deserialize, Serialize};

use crate::config::{Ingest, OtlpSettings};
use crate::supervisor::{Shutdown, TaskError, TaskSpec};
use crate::uploader::{ParkedName, new_request_id};

pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const PATHS: [&str; 3] = ["/v1/traces", "/v1/logs", "/v1/metrics"];

#[derive(Debug, Serialize, Deserialize)]
pub struct Metadata {
    pub path: String,
    pub content_type: String,
    pub encoding: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct RelayHealth {
    relay: String,
    last_upload: Option<String>,
}

struct Relay {
    spool: PathBuf,
    failed: PathBuf,
    health_file: PathBuf,
    health: Mutex<RelayHealth>,
    client: reqwest::Client,
    origin: String,
    key: String,
    receiving: tokio::sync::Semaphore,
}

impl Relay {
    fn new(home: &Path, ingest: &Ingest) -> Result<Self, TaskError> {
        let url = reqwest::Url::parse(&ingest.url).map_err(|e| TaskError(e.to_string()))?;
        let origin = url.origin().ascii_serialization();
        let health_file = home.join("state/otlp-health.json");
        let mut health = fs::read(&health_file)
            .ok()
            .and_then(|b| serde_json::from_slice::<RelayHealth>(&b).ok())
            .unwrap_or_default();
        health.relay = "off".to_string();
        Ok(Self {
            spool: home.join("state/spool-otlp"),
            // Nested under failed, isolated from the NDJSON events sweeper.
            failed: home.join("state/failed/otlp"),
            health_file,
            health: Mutex::new(health),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| TaskError(e.to_string()))?,
            origin,
            key: ingest.key.clone(),
            receiving: tokio::sync::Semaphore::new(16),
        })
    }

    fn report(&self, relay: Option<&str>, upload: Option<String>) {
        let Ok(mut health) = self.health.lock() else {
            return;
        };
        if let Some(relay) = relay {
            health.relay = relay.to_string();
        }
        if let Some(upload) = upload {
            health.last_upload = Some(upload);
        }
        if let Ok(bytes) = serde_json::to_vec(&*health) {
            let _ = atomic_write(&self.health_file, &bytes);
        }
    }

    async fn deliver(&self, path: &Path, sd: &Shutdown) {
        let bytes = match tokio::fs::read(path).await {
            Ok(bytes) => bytes,
            Err(_) => return,
        };
        let Some(split) = bytes.iter().position(|b| *b == b'\n') else {
            self.park(path, None).await;
            return;
        };
        let metadata: Metadata = match serde_json::from_slice(&bytes[..split]) {
            Ok(metadata) => metadata,
            Err(_) => {
                self.park(path, None).await;
                return;
            }
        };
        if !PATHS.contains(&metadata.path.as_str()) || bytes.len() - split - 1 > MAX_BODY_BYTES {
            self.park(path, Some(400)).await;
            return;
        }
        let body = &bytes[split + 1..];
        let mut status = None;
        for attempt in 0..5 {
            if sd.is_set() {
                return;
            }
            let mut request = self
                .client
                .post(format!("{}{}", self.origin, metadata.path))
                .bearer_auth(&self.key)
                .header("Content-Type", &metadata.content_type)
                .body(body.to_vec());
            if let Some(encoding) = &metadata.encoding {
                request = request.header("Content-Encoding", encoding);
            }
            let response = request.send().await;
            let mut delay = Duration::from_secs(1 << attempt);
            match response {
                Ok(response) => {
                    let code = response.status().as_u16();
                    status = Some(code);
                    if code == 200 {
                        let content_type = response
                            .headers()
                            .get("content-type")
                            .and_then(|h| h.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        // Bound response size too; an ingest proxy need not be trusted.
                        let mut response = response;
                        let mut result = Vec::new();
                        while let Ok(Some(chunk)) = response.chunk().await {
                            if result.len() + chunk.len() > 64 * 1024 {
                                break;
                            }
                            result.extend_from_slice(&chunk);
                        }
                        let rejected = rejected_count(&result, &content_type);
                        if rejected > 0 {
                            tracing::warn!(rejected, signal = %metadata.path, "OTLP partial_success delivered");
                        }
                        self.report(None, Some(format!("200 delivered; rejected={rejected}")));
                        let _ = tokio::fs::remove_file(path).await;
                        return;
                    }
                    self.report(None, Some(format!("{code} parked")));
                    if !matches!(code, 429 | 502 | 503 | 504) {
                        break;
                    }
                    delay = retry_after(response.headers()).unwrap_or(delay);
                }
                Err(_) => self.report(None, Some("network error; retained".to_string())),
            }
            if attempt < 4 && !sd.sleep(delay).await {
                return;
            }
        }
        self.park(path, status).await;
    }

    async fn park(&self, path: &Path, status: Option<u16>) {
        if tokio::fs::create_dir_all(&self.failed).await.is_err() {
            return;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            return;
        };
        let mut parked = ParkedName::parse(name);
        parked.attempt += 1;
        parked.client_status = status.filter(|c| (400..500).contains(c) && *c != 429);
        parked.poison = parked.attempt >= 3;
        let target = self.failed.join(parked.render());
        if tokio::fs::rename(path, target).await.is_ok() {
            let _ = File::open(&self.failed).and_then(|f| f.sync_all());
        }
    }
}

fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let value = headers.get("retry-after")?.to_str().ok()?;
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    Some(
        httpdate::parse_http_date(value)
            .ok()?
            .duration_since(SystemTime::now())
            .unwrap_or_default(),
    )
}

fn varint(bytes: &[u8], cursor: &mut usize) -> Option<u64> {
    let mut value = 0;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*cursor)?;
        *cursor += 1;
        value |= u64::from(byte & 127) << shift;
        if byte & 128 == 0 {
            return Some(value);
        }
    }
    None
}

/// Export response field 1 is partial_success; its field 1 is rejected count.
/// Only response metadata is read — payload translation belongs to Cloud.
fn rejected_count(bytes: &[u8], content_type: &str) -> u64 {
    if content_type.contains("json") || bytes.first() == Some(&b'{') {
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
            return 0;
        };
        let partial = value
            .get("partialSuccess")
            .or_else(|| value.get("partial_success"));
        return partial
            .and_then(|p| {
                [
                    "rejectedSpans",
                    "rejectedLogRecords",
                    "rejectedDataPoints",
                    "rejected_spans",
                    "rejected_log_records",
                    "rejected_data_points",
                ]
                .iter()
                .find_map(|key| {
                    p.get(key)
                        .and_then(|n| n.as_u64().or_else(|| n.as_str()?.parse().ok()))
                })
            })
            .unwrap_or(0);
    }
    let mut cursor = 0;
    if varint(bytes, &mut cursor) != Some(10) {
        return 0;
    }
    let Some(length) = varint(bytes, &mut cursor) else {
        return 0;
    };
    let Some(end) = cursor.checked_add(length as usize) else {
        return 0;
    };
    let Some(partial) = bytes.get(cursor..end) else {
        return 0;
    };
    cursor = 0;
    if varint(partial, &mut cursor) != Some(8) {
        return 0;
    }
    varint(partial, &mut cursor).unwrap_or(0)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("missing directory"))?;
    fs::create_dir_all(dir)?;
    let temp = dir.join(format!(".{}.tmp", new_request_id()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        File::open(dir)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

pub fn spool_request(spool: &Path, metadata: &Metadata, body: &[u8]) -> io::Result<PathBuf> {
    if !PATHS.contains(&metadata.path.as_str()) || body.len() > MAX_BODY_BYTES {
        return Err(io::Error::other("invalid OTLP path or body size"));
    }
    let mut bytes = serde_json::to_vec(metadata)?;
    bytes.push(b'\n');
    bytes.extend_from_slice(body);
    let path = spool.join(format!("otlp-{}.jsonl", new_request_id()));
    atomic_write(&path, &bytes)?;
    Ok(path)
}

async fn receive(State(relay): State<Arc<Relay>>, request: Request) -> Response {
    let Ok(_permit) = relay.receiving.try_acquire() else {
        return Response::builder().status(503).body(Body::empty()).unwrap();
    };
    let path = request.uri().path().to_string();
    let content_type = request
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("application/x-protobuf")
        .to_string();
    if !matches!(
        content_type.split(';').next(),
        Some("application/json" | "application/x-protobuf" | "application/protobuf")
    ) {
        return Response::builder().status(415).body(Body::empty()).unwrap();
    }
    let encoding = request
        .headers()
        .get("content-encoding")
        .and_then(|h| h.to_str().ok())
        .map(str::to_string);
    let is_json = content_type.contains("json");
    let body = match tokio::time::timeout(
        Duration::from_secs(30),
        to_bytes(request.into_body(), MAX_BODY_BYTES),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => {
            return Response::builder()
                .status(StatusCode::PAYLOAD_TOO_LARGE)
                .body(Body::empty())
                .unwrap();
        }
        Err(_) => {
            return Response::builder()
                .status(StatusCode::REQUEST_TIMEOUT)
                .body(Body::empty())
                .unwrap();
        }
    };
    let spool = relay.spool.clone();
    let metadata = Metadata {
        path,
        content_type,
        encoding,
    };
    match tokio::task::spawn_blocking(move || spool_request(&spool, &metadata, &body)).await {
        Ok(Ok(_)) => Response::builder()
            .status(200)
            .header(
                "Content-Type",
                if is_json {
                    "application/json"
                } else {
                    "application/x-protobuf"
                },
            )
            .body(Body::from(if is_json {
                b"{}".as_slice()
            } else {
                b"".as_slice()
            }))
            .unwrap(),
        _ => Response::builder().status(503).body(Body::empty()).unwrap(),
    }
}

async fn listen(relay: Arc<Relay>, port: u16, sd: Shutdown) -> Result<(), TaskError> {
    // Binding an IPv4 address, never a configurable host, makes loopback-only
    // structural: no config or environment variable can expose the listener.
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = match tokio::net::TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(err) => {
            tracing::warn!(port, %err, "OTLP relay off: loopback port unavailable; daemon continues");
            relay.report(Some("port_busy"), None);
            return Ok(()); // Clean exit: supervisor does not restart/log repeatedly.
        }
    };
    relay.report(Some("listening"), None);
    let app = Router::new()
        .route("/v1/traces", post(receive))
        .route("/v1/logs", post(receive))
        .route("/v1/metrics", post(receive))
        .with_state(relay.clone());
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async move { while sd.sleep(Duration::from_millis(100)).await {} })
        .await;
    relay.report(Some("off"), None);
    result.map_err(|e| TaskError(e.to_string()))
}

async fn deliver_loop(relay: Arc<Relay>, sd: Shutdown) -> Result<(), TaskError> {
    let mut last_failed = tokio::time::Instant::now();
    while !sd.is_set() {
        for directory in [&relay.spool, &relay.failed] {
            if directory == &relay.failed && last_failed.elapsed() < Duration::from_secs(3600) {
                continue;
            }
            if directory == &relay.failed {
                last_failed = tokio::time::Instant::now();
            }
            let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
                continue;
            };
            let mut delivered = 0;
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with("otlp-") || !name.ends_with(".jsonl") {
                    continue;
                }
                if entry.file_type().await.is_ok_and(|t| t.is_file()) {
                    relay.deliver(&entry.path(), &sd).await;
                    delivered += 1;
                    if delivered >= 32 || sd.is_set() {
                        break;
                    }
                }
            }
        }
        if !sd.sleep(Duration::from_millis(250)).await {
            break;
        }
    }
    Ok(())
}

pub fn tasks(home: PathBuf, ingest: Ingest, settings: &OtlpSettings) -> Vec<TaskSpec> {
    let relay = match Relay::new(&home, &ingest) {
        Ok(relay) => Arc::new(relay),
        Err(err) => {
            tracing::warn!(%err, "OTLP relay disabled");
            return Vec::new();
        }
    };
    let delivery = relay.clone();
    let port = settings.port;
    // SDK exporters opt in by publishing raw OTLP batches. Delivery needs no
    // TCP listener; an untouched machine has no batches and sends nothing.
    let mut tasks = vec![TaskSpec::new("otlp-delivery", move |sd| {
        deliver_loop(delivery.clone(), sd)
    })];
    if settings.enabled {
        tasks.push(TaskSpec::new("otlp-relay", move |sd| {
            listen(relay.clone(), port, sd)
        }));
    }
    tasks
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{header, method, path},
    };

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fpai-otlp-{}", new_request_id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn shutdown() -> Shutdown {
        Shutdown::for_test(Arc::new(AtomicBool::new(false)))
    }
    fn batch(relay: &Relay, body: &[u8]) -> PathBuf {
        spool_request(
            &relay.spool,
            &Metadata {
                path: "/v1/logs".into(),
                content_type: "application/json".into(),
                encoding: Some("gzip".into()),
            },
            body,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn durable_opaque_forward_and_partial_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/logs"))
            .and(header("authorization", "Bearer test"))
            .and(header("content-type", "application/json"))
            .and(header("content-encoding", "gzip"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({"partialSuccess":{"rejectedLogRecords":"2"}}),
                ),
            )
            .expect(1)
            .mount(&server)
            .await;
        let home = temp();
        let relay = Relay::new(
            &home,
            &Ingest {
                url: format!("{}/v1/events", server.uri()),
                key: "test".into(),
            },
        )
        .unwrap();
        let body = b"\x1f\x8b\x00opaque-gzip";
        let file = batch(&relay, body);
        let stored = fs::read(&file).unwrap();
        assert!(stored.ends_with(body));
        relay.deliver(&file, &shutdown()).await;
        assert!(!file.exists());
        assert_eq!(server.received_requests().await.unwrap()[0].body, body);
        assert!(
            fs::read_to_string(&relay.health_file)
                .unwrap()
                .contains("rejected=2")
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[tokio::test]
    async fn retries_503_retry_after_then_delivers() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(503).insert_header("Retry-After", "1"))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let home = temp();
        let relay = Relay::new(
            &home,
            &Ingest {
                url: server.uri(),
                key: "test".into(),
            },
        )
        .unwrap();
        let file = batch(&relay, b"{}");
        let start = tokio::time::Instant::now();
        relay.deliver(&file, &shutdown()).await;
        assert!(start.elapsed() >= Duration::from_secs(1));
        assert!(!file.exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[tokio::test]
    async fn parks_400_and_404_without_retry_or_loss() {
        for code in [400, 404] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(code))
                .expect(1)
                .mount(&server)
                .await;
            let home = temp();
            let relay = Relay::new(
                &home,
                &Ingest {
                    url: server.uri(),
                    key: "test".into(),
                },
            )
            .unwrap();
            let file = batch(&relay, b"unchanged");
            let original = fs::read(&file).unwrap();
            relay.deliver(&file, &shutdown()).await;
            assert!(!file.exists());
            let parked = fs::read_dir(&relay.failed)
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            assert!(
                parked
                    .to_str()
                    .unwrap()
                    .contains(&format!(".a1.c{code}.jsonl"))
            );
            assert_eq!(fs::read(&parked).unwrap(), original);
            fs::remove_dir_all(home).unwrap();
        }
    }

    #[tokio::test]
    async fn busy_port_exits_cleanly_without_supervisor_failure() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let home = temp();
        let relay = Arc::new(
            Relay::new(
                &home,
                &Ingest {
                    url: "http://127.0.0.1:1".into(),
                    key: "test".into(),
                },
            )
            .unwrap(),
        );
        assert!(listen(relay.clone(), port, shutdown()).await.is_ok());
        assert!(
            fs::read_to_string(&relay.health_file)
                .unwrap()
                .contains("port_busy")
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[tokio::test]
    async fn loopback_receiver_limits_and_acknowledges_only_durable_batches() {
        let home = temp();
        let relay = Arc::new(
            Relay::new(
                &home,
                &Ingest {
                    url: "http://127.0.0.1:1".into(),
                    key: "test".into(),
                },
            )
            .unwrap(),
        );
        let reserved = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let flag = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn(listen(
            relay.clone(),
            port,
            Shutdown::for_test(flag.clone()),
        ));
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{port}/v1/traces");
        let mut response = None;
        for _ in 0..30 {
            match client
                .post(&url)
                .header("Content-Type", "application/x-protobuf")
                .body(vec![0, 255, 1])
                .send()
                .await
            {
                Ok(r) => {
                    response = Some(r);
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
        assert_eq!(response.unwrap().status(), 200);
        let stored = fs::read_dir(&relay.spool)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(fs::read(stored).unwrap().ends_with(&[0, 255, 1]));
        assert_eq!(
            client
                .post(url)
                .body(vec![0; MAX_BODY_BYTES + 1])
                .send()
                .await
                .unwrap()
                .status(),
            413
        );
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
        task.await.unwrap().unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn protobuf_partial_success_and_retry_dates() {
        assert_eq!(rejected_count(&[10, 2, 8, 3], "application/x-protobuf"), 3);
        assert_eq!(rejected_count(&[], "application/x-protobuf"), 0);
        let mut headers = HeaderMap::new();
        headers.insert(
            "retry-after",
            httpdate::fmt_http_date(SystemTime::now() + Duration::from_secs(10))
                .parse()
                .unwrap(),
        );
        assert!(retry_after(&headers).unwrap() >= Duration::from_secs(8));
    }

    #[test]
    fn per_agent_overrides_and_relay_are_opt_in() {
        let settings: crate::config::Settings = serde_json::from_value(serde_json::json!({
            "sessions": true, "agents": { "claude": { "sessions": false }, "codex": {} }
        }))
        .unwrap();
        assert!(!settings.sessions_for("claude"));
        assert!(!settings.sessions_for("claude-subagent"));
        assert!(settings.sessions_for("codex"));
        assert!(!settings.otlp.enabled);
        assert_eq!(settings.otlp.port, 4318);
    }
}
