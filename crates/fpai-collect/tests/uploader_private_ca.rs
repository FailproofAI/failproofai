//! The daemon trusts a private CA that the machine trusts.
//!
//! A self-hosted FailproofAI Cloud, or any origin reached through a
//! TLS-inspecting proxy, is signed by a CA that sits in the OS trust store but
//! not in the Mozilla bundle compiled into the binary. With the bundle alone,
//! every upload failed `UnknownIssuer` and every batch was parked, while the
//! node CLI, which does read the system store, reported the machine connected.
//!
//! One test, in a file of its own, because it sets `SSL_CERT_FILE`, which is
//! process-global. rustls-native-certs reads that file in place of the platform
//! store, so it stands in for `update-ca-certificates` without touching the
//! host. The fixtures are a throwaway CA and a `localhost` leaf it signed; the
//! key exists only for this test.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use fpai_collect::{UploadError, Uploader};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::rustls::pki_types::pem::PemObject;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/private-ca")
        .join(name)
}

/// An HTTPS ingest endpoint signed by the test CA that acks every batch.
/// Returns its port and a count of requests that completed a handshake.
async fn serve() -> (u16, Arc<AtomicUsize>) {
    let cert = CertificateDer::from_pem_file(fixture("localhost.crt")).unwrap();
    let key = PrivateKeyDer::from_pem_file(fixture("localhost.key")).unwrap();
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));

    let counter = hits.clone();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let (acceptor, counter) = (acceptor.clone(), counter.clone());
            tokio::spawn(async move {
                // A refused handshake is the control case doing its job.
                let Ok(mut tls) = acceptor.accept(tcp).await else {
                    return;
                };
                if read_request(&mut tls).await.is_err() {
                    return;
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let body = r#"{"accepted":1,"skipped":0}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                     content-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = tls.write_all(resp.as_bytes()).await;
                let _ = tls.shutdown().await;
            });
        }
    });
    (port, hits)
}

/// Read one HTTP/1.1 request: the headers, then `content-length` bytes of body.
async fn read_request<S: AsyncRead + Unpin>(s: &mut S) -> io::Result<()> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_ascii_lowercase();
    let len: usize = head
        .lines()
        .find_map(|l| l.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    while buf.len() < header_end + len {
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(())
}

fn uploader(url: &str, failed: &Path) -> Uploader {
    Uploader::new(url.to_string(), "test-key".into(), failed.to_path_buf())
        .unwrap()
        .with_retry_base(Duration::from_millis(1))
}

#[tokio::test]
async fn a_private_ca_in_the_system_trust_store_is_trusted_for_uploads() {
    let (port, hits) = serve().await;
    let url = format!("https://localhost:{port}/v1/events");
    let dir = std::env::temp_dir().join(format!("fpai-private-ca-{}", std::process::id()));
    let (spool, failed) = (dir.join("spool"), dir.join("failed"));
    std::fs::create_dir_all(&spool).unwrap();

    // (a) Control: an empty system store. The bundled roots alone do not know
    // this CA, so the handshake must fail; otherwise (b) passes for the wrong
    // reason.
    //
    // SAFETY: the only test in this binary, so nothing reads the environment
    // concurrently.
    unsafe {
        std::env::remove_var("SSL_CERT_DIR");
        std::env::set_var("SSL_CERT_FILE", "/dev/null");
    }
    let batch = spool.join("hooks-a-1-0.jsonl");
    std::fs::write(&batch, "{\"type\":\"tool_use\"}\n").unwrap();
    let err = uploader(&url, &failed)
        .upload_file(&batch)
        .await
        .unwrap_err();
    assert!(matches!(err, UploadError::Network { .. }), "{err}");
    assert_eq!(hits.load(Ordering::SeqCst), 0);

    // (b) The CA is in the system store, as `update-ca-certificates` would put
    // it. The client is built after the change because roots load at build.
    unsafe {
        std::env::set_var("SSL_CERT_FILE", fixture("ca.crt"));
    }
    let batch = spool.join("hooks-a-2-0.jsonl");
    std::fs::write(&batch, "{\"type\":\"tool_use\"}\n").unwrap();
    uploader(&url, &failed)
        .upload_file(&batch)
        .await
        .expect("a CA in the system trust store must be trusted");
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert!(
        !batch.exists(),
        "a delivered batch is deleted from the spool"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
