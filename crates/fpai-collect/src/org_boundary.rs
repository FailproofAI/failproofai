//! Recording and delivery isolation between cloud organisations.
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::{CollectorConfig, OrgBoundary};

pub fn timestamp_ms(event: &Value) -> Option<i64> {
    let ts = event.get("timestamp")?;
    if let Some(number) = ts.as_i64() {
        return Some(if number.unsigned_abs() < 100_000_000_000 {
            number.saturating_mul(1000)
        } else {
            number
        });
    }
    let parsed =
        time::OffsetDateTime::parse(ts.as_str()?, &time::format_description::well_known::Rfc3339)
            .ok()?;
    i64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok()
}

pub fn mtime_ms(path: &Path) -> Option<i64> {
    let elapsed = fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?;
    i64::try_from(elapsed.as_millis()).ok()
}

pub fn allowed(event: &Value, since: Option<u64>, fallback_ms: Option<i64>) -> bool {
    since.is_none_or(|since| {
        timestamp_ms(event)
            .or(fallback_ms)
            .is_some_and(|ts| ts >= 0 && ts as u64 >= since)
    })
}

pub fn archive_dir(state: &Path, old: Option<&OrgBoundary>) -> PathBuf {
    let id = old.and_then(|b| b.id.as_deref()).unwrap_or("unknown");
    let safe = if id.len() <= 128
        && !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        id.to_string()
    } else {
        Sha256::digest(id.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    };
    state.join("previous-org").join(safe)
}

/// Must run with the old collector stopped and flushed, before the new one
/// starts. Persisting the applied boundary also covers switches while stopped.
pub fn prepare(cfg: &CollectorConfig) -> io::Result<u64> {
    let state = cfg
        .own_spool_dir
        .parent()
        .ok_or_else(|| io::Error::other("spool has no state root"))?;
    let marker = state.join("collector-org.json");
    let old: Option<OrgBoundary> = match fs::read(&marker) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    if old == cfg.boundary {
        return Ok(0);
    }
    // A disconnect does not change which org owns undelivered queues. Keep
    // the last applied boundary so a later reconnect can archive by old id.
    if cfg.boundary.is_none() {
        return Ok(0);
    }
    let mut count = 0;
    if cfg.boundary.is_some() {
        let archive = archive_dir(state, old.as_ref());
        // The OTLP relay keeps its own queue and delivers it with the same
        // ingest key, so it belongs to the old org exactly like the events
        // spool. Its failed dir nests inside `failed`; it is archived under its
        // own label and skipped when `failed` is walked.
        let otlp_spool = crate::otlp::spool_dir(state);
        let otlp_failed = crate::otlp::failed_dir(state);
        let sources = [
            (&otlp_spool, "spool-otlp"),
            (&otlp_failed, "failed-otlp"),
            (&cfg.own_spool_dir, "spool"),
            (&cfg.failed_dir, "failed"),
        ];
        for (source, label) in sources {
            let entries = match fs::read_dir(source) {
                Ok(entries) => entries,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            let destination = archive.join(label);
            fs::create_dir_all(&destination)?;
            for entry in entries {
                let entry = entry?;
                if entry.path() == otlp_failed || entry.path() == otlp_spool {
                    continue;
                }
                let mut target = destination.join(entry.file_name());
                // Preserve collisions across repeated visits to the same org.
                if target.exists() {
                    let epoch = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos();
                    target = destination
                        .join(format!("{}.{epoch}", entry.file_name().to_string_lossy()));
                }
                fs::rename(entry.path(), target)?;
                count += 1;
            }
        }
    }
    fs::create_dir_all(state)?;
    let temp = state.join(format!("collector-org.{}.tmp", std::process::id()));
    fs::write(
        &temp,
        serde_json::to_vec(&cfg.boundary).map_err(io::Error::other)?,
    )?;
    fs::rename(temp, marker)?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn timestamp_formats_and_mtime_fallback_obey_the_boundary() {
        let since = 1_792_022_400_000; // October 15, 2026 00:00 UTC
        for event in [
            json!({"timestamp":"2026-10-14T23:59:59.999999Z"}),
            json!({"timestamp":since - 1}),
            json!({"timestamp":1_792_022_399_i64}),
        ] {
            assert!(!allowed(&event, Some(since), Some(since as i64 + 1)));
        }
        assert!(allowed(
            &json!({"timestamp":"2026-10-15T00:00:00Z"}),
            Some(since),
            None
        ));
        assert!(allowed(&json!({}), Some(since), Some(since as i64)));
        assert!(!allowed(&json!({}), Some(since), Some(since as i64 - 1)));
        assert!(!allowed(&json!({}), Some(since), None));
        assert!(allowed(&json!({}), None, None));
        assert_eq!(
            timestamp_ms(&json!({"timestamp":"2026-10-15T02:00:00+02:00"})),
            Some(since as i64)
        );
    }

    #[test]
    fn a_boundary_change_archives_spool_failed_poison_tmp_and_otlp_without_overwriting() {
        let home = std::env::temp_dir().join(format!(
            "fp-org-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&home).unwrap();
        let mut cfg = crate::config::load(&home).unwrap();
        cfg.boundary = Some(OrgBoundary {
            id: Some("A".into()),
            since: 100,
        });
        assert_eq!(prepare(&cfg).unwrap(), 0);
        fs::create_dir_all(&cfg.own_spool_dir).unwrap();
        fs::create_dir_all(&cfg.failed_dir).unwrap();
        fs::write(cfg.own_spool_dir.join("old.jsonl"), "old").unwrap();
        fs::write(cfg.failed_dir.join("old.c401.jsonl"), "refused").unwrap();
        fs::write(cfg.failed_dir.join("old.jsonl.poison"), "poison").unwrap();
        fs::write(cfg.own_spool_dir.join("old.tmp"), "partial").unwrap();
        let state = home.join("state");
        fs::create_dir_all(crate::otlp::spool_dir(&state)).unwrap();
        fs::create_dir_all(crate::otlp::failed_dir(&state)).unwrap();
        fs::write(
            crate::otlp::spool_dir(&state).join("otlp-old.jsonl"),
            "otlp",
        )
        .unwrap();
        fs::write(
            crate::otlp::failed_dir(&state).join("otlp-old.a1.c401.jsonl"),
            "otlp refused",
        )
        .unwrap();
        cfg.boundary = Some(OrgBoundary {
            id: Some("B".into()),
            since: 200,
        });
        assert_eq!(prepare(&cfg).unwrap(), 6);
        let archive = home.join("state/previous-org/A");
        assert_eq!(
            fs::read_to_string(archive.join("spool/old.jsonl")).unwrap(),
            "old"
        );
        assert!(archive.join("failed/old.c401.jsonl").exists());
        assert!(archive.join("failed/old.jsonl.poison").exists());
        assert!(!cfg.own_spool_dir.join("old.jsonl").exists());
        // The OTLP relay's queue is the old org's too, under its own labels.
        assert_eq!(
            fs::read_to_string(archive.join("spool-otlp/otlp-old.jsonl")).unwrap(),
            "otlp"
        );
        assert!(archive.join("failed-otlp/otlp-old.a1.c401.jsonl").exists());
        assert!(!archive.join("failed/otlp").exists());
        assert_eq!(
            fs::read_dir(crate::otlp::spool_dir(&state))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(
            fs::read_dir(crate::otlp::failed_dir(&state))
                .unwrap()
                .count(),
            0
        );
        // Same boundary on restart leaves the current org's queue in place.
        fs::write(cfg.own_spool_dir.join("new.jsonl"), "new").unwrap();
        assert_eq!(prepare(&cfg).unwrap(), 0);
        assert!(cfg.own_spool_dir.join("new.jsonl").exists());
        // A -> B -> A -> B must preserve both visits' undelivered batches.
        cfg.boundary = Some(OrgBoundary {
            id: Some("A".into()),
            since: 300,
        });
        prepare(&cfg).unwrap();
        fs::write(cfg.own_spool_dir.join("old.jsonl"), "second").unwrap();
        cfg.boundary = Some(OrgBoundary {
            id: Some("B".into()),
            since: 400,
        });
        prepare(&cfg).unwrap();
        assert_eq!(
            fs::read_to_string(archive.join("spool/old.jsonl")).unwrap(),
            "old"
        );
        assert_eq!(fs::read_dir(archive.join("spool")).unwrap().count(), 3);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn unsafe_org_ids_cannot_escape_state() {
        let old = OrgBoundary {
            id: Some("../../elsewhere".into()),
            since: 1,
        };
        let dir = archive_dir(Path::new("/state"), Some(&old));
        assert!(dir.starts_with("/state/previous-org"));
        assert_eq!(dir.file_name().unwrap().len(), 64);
    }
}
