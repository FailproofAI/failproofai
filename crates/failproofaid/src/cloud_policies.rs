//! Local desired-state store for cloud-managed JavaScript policies.
//!
//! Cloud transport deliberately does not live here. A caller supplies an
//! [`ArtifactFetcher`], while this module owns the security-sensitive local
//! transaction: validate the manifest, verify SHA-256, write immutable cache
//! objects, materialize a complete deployment, then switch `active.json`
//! atomically. The hook hot path never downloads or partially activates policy.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// What this daemon WRITES, and what the server emits today.
///
/// 2, because the v1 payload named these fields `generation` and `revision`
/// and neither appears any more. Same endpoint, same version number, different
/// shape is precisely what a schema version exists to prevent — see the note at
/// the emit site in AgentEye's `enforcement.rs`.
pub const DESIRED_STATE_SCHEMA_VERSION: u32 = 2;

/// What this daemon ACCEPTS when reading.
///
/// 1 is here for files on DISK, never for a server: a machine that ran an
/// earlier beta has a `desired-state.json` and an `active.json` written at
/// version 1, and both structs carry `deny_unknown_fields`, so refusing the
/// version would make the daemon unable to read its own persisted state — it
/// would silently stop enforcing cloud policy until a poll re-materialised
/// everything. The field aliases on `ActiveDeployment` exist for the same
/// files and the same reason.
pub const SUPPORTED_SCHEMA_VERSIONS: &[u32] = &[1, DESIRED_STATE_SCHEMA_VERSION];
const MANAGED_FILE_MODE: u32 = 0o600;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// NOT `deny_unknown_fields`, deliberately, unlike the locally-authored
/// manifest below. This is parsed from a SERVER response, and daemons update on
/// their own schedule — so strictness here means the first field cloud adds
/// makes every older daemon reject desired-state and silently stop pulling,
/// stranding fleets on whatever deployment they happened to hold. Strictness
/// belongs on files we write ourselves, not on a remote payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesiredState {
    pub schema_version: u32,
    pub deployment: u64,
    pub policies: Vec<DesiredPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesiredPolicy {
    pub id: String,
    pub version: u64,
    pub sha256: String,
    /// Opaque locator interpreted only by the cloud transport implementation.
    pub artifact_url: String,
    /// Defaults to `enforce` so a server that predates observe mode, or omits
    /// the field, keeps behaving exactly as before. The safe default is the
    /// one that keeps enforcing.
    #[serde(default)]
    pub effect: PolicyEffect,
}

/// What an assignment does when it matches.
///
/// `observe` is the design's observe-before-enforce step: the policy is
/// downloaded, verified and EVALUATED exactly like any other, but its verdict
/// never changes what the agent is allowed to do. It exists so a rollout can be
/// measured on real traffic before it can break anyone's work.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum PolicyEffect {
    #[default]
    Enforce,
    Observe,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveDeployment {
    pub schema_version: u32,
    /// `generation` is what every daemon before the rename wrote here.
    ///
    /// The alias is load-bearing rather than tidy: this struct carries
    /// `deny_unknown_fields`, so without it an upgraded daemon fails to parse
    /// its OWN `active.json` on three counts at once — `generation` unrecognised,
    /// `deployment` missing, and the same again for every policy's `revision`.
    /// A machine would silently lose the deployment it was enforcing until a
    /// poll succeeded, which on a fail-closed machine is the gap this whole
    /// subsystem exists to prevent.
    #[serde(alias = "generation")]
    pub deployment: u64,
    pub policies: Vec<ActivePolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivePolicy {
    pub id: String,
    /// `revision` is the pre-rename spelling. See `ActiveDeployment::deployment`.
    #[serde(alias = "revision")]
    pub version: u64,
    pub sha256: String,
    /// Relative to the cloud-managed root. Never supplied by the server.
    pub path: String,
    /// Carried through from the desired state so the evaluator does not have to
    /// re-consult cloud to know whether a policy may act.
    #[serde(default)]
    pub effect: PolicyEffect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileOutcome {
    pub deployment: u64,
    pub downloaded: usize,
    pub repaired: usize,
    pub activated: bool,
}

#[derive(Debug)]
pub enum ReconcileError {
    Io(io::Error),
    Json(serde_json::Error),
    InvalidDesiredState(String),
    HashMismatch {
        policy_id: String,
        expected: String,
        actual: String,
    },
    Fetch {
        policy_id: String,
        message: String,
    },
    NoVerifiedCopy {
        policy_id: String,
    },
}

impl std::fmt::Display for ReconcileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(f, "cloud policy I/O error: {err}"),
            Self::Json(err) => write!(f, "cloud policy JSON error: {err}"),
            Self::InvalidDesiredState(message) => {
                write!(f, "invalid cloud desired state: {message}")
            }
            Self::HashMismatch {
                policy_id,
                expected,
                actual,
            } => write!(
                f,
                "cloud policy {policy_id} hash mismatch: expected {expected}, got {actual}"
            ),
            Self::Fetch { policy_id, message } => {
                write!(f, "failed to fetch cloud policy {policy_id}: {message}")
            }
            Self::NoVerifiedCopy { policy_id } => write!(
                f,
                "cloud policy {policy_id} has no verified artifact or deployment copy"
            ),
        }
    }
}

impl std::error::Error for ReconcileError {}

impl From<io::Error> for ReconcileError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for ReconcileError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

/// Transport boundary. Production cloud HTTP and tests both implement this;
/// fetched bytes are untrusted until the reconciler verifies their digest.
pub trait ArtifactFetcher {
    fn fetch(&self, policy: &DesiredPolicy) -> Result<Vec<u8>, String>;
}

impl<F> ArtifactFetcher for F
where
    F: Fn(&DesiredPolicy) -> Result<Vec<u8>, String>,
{
    fn fetch(&self, policy: &DesiredPolicy) -> Result<Vec<u8>, String> {
        self(policy)
    }
}

#[derive(Debug, Clone)]
pub struct PolicyStore {
    root: PathBuf,
    /// Highest deployment this process has seen the SERVER offer.
    ///
    /// The rollback guard used to compare against `active.json`'s deployment.
    /// That file is a derived local pointer owned by the user — which this
    /// module's own comment says — so on the product's stated threat model (a
    /// rogue agent running as the user) it was an attacker-controlled veto over
    /// the control plane: write a high number, and every real deployment is
    /// refused for good. Combined with corrupting the artifacts it points at,
    /// the machine cannot repair locally, cannot accept the server, and fails
    /// closed on every tool call — a permanent denial of service costing one
    /// file write.
    ///
    /// Anchoring on what the server said instead keeps the guard where it
    /// actually means something (a replayed or out-of-order response inside one
    /// session, which is the realistic transport failure) and gives up only
    /// cross-restart rollback protection — which is already carried by TLS, a
    /// bearer token and SHA-256 pinning of every artifact. Tampering now costs
    /// an attacker nothing more than a delay until the next poll.
    ///
    /// `Arc` rather than a bare atomic because `PolicyStore` is `Clone` and the
    /// maintenance lane holds its own handle: a per-clone counter would reset
    /// the floor to zero for whichever clone happened to be asked, quietly
    /// removing the guard it exists to provide.
    server_high_water: Arc<AtomicU64>,
}

impl PolicyStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            server_high_water: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn active_manifest_path(&self) -> PathBuf {
        self.root.join("active.json")
    }

    pub fn desired_state_path(&self) -> PathBuf {
        self.root.join("desired-state.json")
    }

    pub fn read_active(&self) -> Result<Option<ActiveDeployment>, ReconcileError> {
        let path = self.active_manifest_path();
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(path)?;
        Ok(Some(serde_json::from_slice(&bytes)?))
    }

    pub fn read_desired(&self) -> Result<Option<DesiredState>, ReconcileError> {
        let path = self.desired_state_path();
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(path)?;
        let desired: DesiredState = serde_json::from_slice(&bytes)?;
        validate_desired_state(&desired)?;
        Ok(Some(desired))
    }

    /// Installs a complete desired deployment. Any error before the final
    /// `active.json` rename leaves the previous deployment authoritative.
    pub fn reconcile(
        &self,
        desired: &DesiredState,
        fetcher: &impl ArtifactFetcher,
    ) -> Result<ReconcileOutcome, ReconcileError> {
        validate_desired_state(desired)?;
        // active.json is a derived local pointer, not authority. If it was
        // truncated or otherwise corrupted, rebuild it from desired state
        // instead of making the corruption permanent. Non-JSON I/O failures
        // still surface.
        let previous = match self.read_active() {
            Ok(active) => active,
            Err(ReconcileError::Json(_)) => None,
            Err(err) => return Err(err),
        };
        // Rollback guard, anchored on what the SERVER has said this session —
        // never on the local pointer. See `server_high_water`.
        let floor = self.server_high_water.load(Ordering::Relaxed);
        if desired.deployment < floor {
            return Err(ReconcileError::InvalidDesiredState(format!(
                "deployment rollback from {} to {} is not allowed",
                floor, desired.deployment
            )));
        }
        // Recorded before the work below so a mid-reconcile failure cannot let
        // an immediately-following lower deployment through.
        self.server_high_water
            .fetch_max(desired.deployment, Ordering::Relaxed);

        // A local pointer AHEAD of the server is not authority, but it is worth
        // saying out loud: it means either a restored/re-registered control
        // plane, or that something edited this machine's state.
        if let Some(active) = &previous
            && active.deployment > desired.deployment
        {
            eprintln!(
                "[failproofaid] local active deployment {} is ahead of the server's {}; \
                 taking the server's state (the local pointer is not authority)",
                active.deployment, desired.deployment
            );
        }

        // ONE copy of every policy, addressed by its own hash.
        //
        // Layout 2 kept two: `artifacts/<sha>` plus a per-deployment copy under
        // `deployments/<n>/<id>.mjs`. The second copy bought two things, and
        // neither survives contact with content addressing:
        //
        //   • Staging. A deployment was materialised whole under its own number
        //     before `active.json` pointed at it, so a half-downloaded set could
        //     not go live. But an artifact path CONTAINS its hash, so a new
        //     deployment only ever writes new files — it cannot disturb the ones
        //     the current `active.json` names. Nothing needs staging away from a
        //     live set it is structurally incapable of touching.
        //
        //   • Mutual repair. A tampered artifact was rebuilt from the deployment
        //     copy and vice versa. That is a cache repairing a cache; the server
        //     is the authority, the hash is known, and a re-fetch is both simpler
        //     and correct even when BOTH copies are bad — the case the old scheme
        //     could not recover from at all.
        //
        // `active.json` is still the single atomic activation point, and the flip
        // is still last.
        fs::create_dir_all(self.root.join("artifacts"))?;

        let mut downloaded = 0;
        let mut repaired = 0;
        let mut active_policies = Vec::with_capacity(desired.policies.len());

        for policy in &desired.policies {
            let artifact_path = self.artifact_path(&policy.sha256);

            if !file_matches_hash(&artifact_path, &policy.sha256)? {
                // Present-but-wrong and absent are different events, and the
                // metric is worth keeping honest: one means somebody or
                // something modified a verified file, the other is a first
                // download.
                let existed = artifact_path.exists();
                let bytes = fetcher
                    .fetch(policy)
                    .map_err(|message| ReconcileError::Fetch {
                        policy_id: policy.id.clone(),
                        message,
                    })?;
                verify_bytes(policy, &bytes)?;
                write_atomic(&artifact_path, &bytes)?;
                if existed {
                    repaired += 1;
                } else {
                    downloaded += 1;
                }
            }

            let deployment_path = artifact_path;

            let relative_path = deployment_path
                .strip_prefix(&self.root)
                .map_err(|_| {
                    ReconcileError::InvalidDesiredState(
                        "deployment path escaped policy root".into(),
                    )
                })?
                .to_string_lossy()
                .into_owned();
            active_policies.push(ActivePolicy {
                id: policy.id.clone(),
                version: policy.version,
                effect: policy.effect,
                sha256: policy.sha256.clone(),
                path: relative_path,
            });
        }

        let active = ActiveDeployment {
            schema_version: DESIRED_STATE_SCHEMA_VERSION,
            deployment: desired.deployment,
            policies: active_policies,
        };
        let manifest_bytes = serde_json::to_vec_pretty(&active)?;
        // The per-deployment `manifest.json` is gone with `deployments/<n>/`. It
        // duplicated `active.json` for a directory that no longer exists, and a
        // second copy of the pointer is a second thing that can disagree.

        // Persist the cloud snapshot before switching active.json. A crash in
        // between is recoverable: the maintenance loop reconstructs the active
        // pointer from this snapshot and the artifacts already verified on disk.
        write_atomic(
            &self.desired_state_path(),
            &serde_json::to_vec_pretty(desired)?,
        )?;

        let activated = previous.as_ref() != Some(&active);
        if activated {
            write_atomic(&self.active_manifest_path(), &manifest_bytes)?;
        }

        // AFTER the flip, never before. A machine upgrading from layout 2 has a
        // `deployments/` tree whose files the OLD `active.json` still named; once
        // the new pointer is live nothing reads it, and leaving it behind means
        // carrying a full copy of every policy set the machine has ever had.
        //
        // Best-effort: a directory we cannot remove is dead weight, not a reason
        // to fail a reconcile that has already succeeded.
        let legacy_deployments = self.root.join("deployments");
        if activated && legacy_deployments.exists() {
            match fs::remove_dir_all(&legacy_deployments) {
                Ok(()) => tracing::info!("removed the layout-2 deployments/ tree"),
                Err(err) => tracing::warn!(?err, "could not remove the layout-2 deployments/ tree"),
            }
        }

        Ok(ReconcileOutcome {
            deployment: desired.deployment,
            downloaded,
            repaired,
            activated,
        })
    }

    /// Verifies every artifact the active deployment names, and reports what it
    /// cannot fix.
    ///
    /// WHAT THIS LOST WHEN `deployments/<n>/` WENT AWAY, stated plainly because
    /// it is a real capability and not an implementation detail: layout 2 kept
    /// two copies of every policy, so a tampered one could be rebuilt from the
    /// other WITHOUT the network. There is one copy now, and a corrupt copy has
    /// no local source of truth — the fix is a re-fetch, which needs the server.
    ///
    /// What is NOT lost is the safety property. The hook path verifies each
    /// artifact's digest before importing it, so a tampered file is refused, not
    /// executed. The cost is availability: on a machine that cannot reach the
    /// control plane, that one policy stops enforcing until it can, and this
    /// function's error is what says so. For a tool whose job is refusing
    /// dangerous things, failing closed and loudly beats self-healing quietly.
    ///
    /// active.json is left unchanged either way, so the worker keeps its last
    /// known-good decision set.
    pub fn repair_active_from_cache(&self) -> Result<usize, ReconcileError> {
        // A corrupted `desired-state.json` must not disable repair.
        //
        // `self.read_desired()?` propagated any parse error straight out,
        // short-circuiting before the `active.json`-driven branch below — the
        // one that rebuilds a tampered `deployments/<n>/<id>.mjs` from the
        // still-valid, content-addressed `artifacts/<sha>.mjs` copy. So one bad
        // byte in a file this branch does not even need permanently disabled
        // deployment-copy self-healing, and per `CLOUD_POLICIES.md` the only
        // thing that rewrites it is a successful cloud poll — which never
        // happens on an unenrolled or unreachable machine.
        //
        // `reconcile()` already tolerates exactly this for `active.json`
        // (`Err(ReconcileError::Json(_)) => None`); the two are now symmetric.
        let desired = match self.read_desired() {
            Ok(desired) => desired,
            Err(ReconcileError::Json(err)) => {
                tracing::warn!(
                    %err,
                    "desired-state.json is unreadable; repairing from active.json alone"
                );
                None
            }
            Err(err) => return Err(err),
        };
        if let Some(desired) = desired {
            let outcome = self.reconcile(&desired, &|policy: &DesiredPolicy| {
                Err(format!(
                    "no verified cached bytes remain for {}; cloud refetch required",
                    policy.id
                ))
            })?;
            return Ok(outcome.repaired + usize::from(outcome.activated));
        }

        let Some(active) = self.read_active()? else {
            return Ok(0);
        };
        if !SUPPORTED_SCHEMA_VERSIONS.contains(&active.schema_version) {
            return Err(ReconcileError::InvalidDesiredState(format!(
                "unsupported active schema version {} (supported: {:?})",
                active.schema_version, SUPPORTED_SCHEMA_VERSIONS
            )));
        }

        let mut repaired = 0;
        for policy in &active.policies {
            validate_policy_identity(&policy.id)?;
            validate_sha256(&policy.sha256)?;
            let deployment_path = safe_join_relative(&self.root, &policy.path)?;
            let artifact_path = self.artifact_path(&policy.sha256);
            let artifact_valid = file_matches_hash(&artifact_path, &policy.sha256)?;
            let deployment_valid = file_matches_hash(&deployment_path, &policy.sha256)?;

            match (artifact_valid, deployment_valid) {
                (true, true) => {}
                (true, false) => {
                    write_atomic(&deployment_path, &fs::read(&artifact_path)?)?;
                    repaired += 1;
                }
                (false, true) => {
                    write_atomic(&artifact_path, &fs::read(&deployment_path)?)?;
                    repaired += 1;
                }
                (false, false) => {
                    return Err(ReconcileError::NoVerifiedCopy {
                        policy_id: policy.id.clone(),
                    });
                }
            }
        }
        Ok(repaired)
    }

    fn artifact_path(&self, sha256: &str) -> PathBuf {
        self.root.join("artifacts").join(format!("{sha256}.mjs"))
    }
}

/// Starts the maintenance-lane integrity loop. It performs one pass
/// immediately, then periodically, and wakes in short slices so daemon
/// shutdown never waits for the full reconciliation interval.
pub fn spawn_integrity_monitor(
    store: PolicyStore,
    shutdown: Arc<AtomicBool>,
    interval: Duration,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        while !shutdown.load(Ordering::Relaxed) {
            match store.repair_active_from_cache() {
                Ok(0) => {}
                Ok(repaired) => {
                    eprintln!("[failproofaid] repaired {repaired} cloud-managed policy artifact(s)")
                }
                Err(err) => eprintln!("[failproofaid] cloud policy integrity error: {err}"),
            }

            let deadline = Instant::now() + interval;
            while !shutdown.load(Ordering::Relaxed) && Instant::now() < deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                std::thread::sleep(remaining.min(Duration::from_millis(50)));
            }
        }
    })
}

fn validate_desired_state(desired: &DesiredState) -> Result<(), ReconcileError> {
    if !SUPPORTED_SCHEMA_VERSIONS.contains(&desired.schema_version) {
        return Err(ReconcileError::InvalidDesiredState(format!(
            "unsupported schema version {} (supported: {:?})",
            desired.schema_version, SUPPORTED_SCHEMA_VERSIONS
        )));
    }
    let mut ids = HashSet::new();
    for policy in &desired.policies {
        validate_policy_identity(&policy.id)?;
        validate_sha256(&policy.sha256)?;
        if policy.artifact_url.trim().is_empty() {
            return Err(ReconcileError::InvalidDesiredState(format!(
                "policy {} has an empty artifactUrl",
                policy.id
            )));
        }
        if !ids.insert(policy.id.as_str()) {
            return Err(ReconcileError::InvalidDesiredState(format!(
                "duplicate policy id {}",
                policy.id
            )));
        }
    }
    Ok(())
}

fn validate_policy_identity(id: &str) -> Result<(), ReconcileError> {
    let valid = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && id != "."
        && id != "..";
    if !valid {
        return Err(ReconcileError::InvalidDesiredState(format!(
            "unsafe policy id {id:?}"
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), ReconcileError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(ReconcileError::InvalidDesiredState(format!(
            "invalid lowercase SHA-256 digest {value:?}"
        )));
    }
    Ok(())
}

fn safe_join_relative(root: &Path, relative: &str) -> Result<PathBuf, ReconcileError> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(ReconcileError::InvalidDesiredState(format!(
            "unsafe active policy path {relative:?}"
        )));
    }
    Ok(root.join(path))
}

fn verify_bytes(policy: &DesiredPolicy, bytes: &[u8]) -> Result<(), ReconcileError> {
    let actual = sha256_hex(bytes);
    if actual != policy.sha256 {
        return Err(ReconcileError::HashMismatch {
            policy_id: policy.id.clone(),
            expected: policy.sha256.clone(),
            actual,
        });
    }
    Ok(())
}

fn file_matches_hash(path: &Path, expected: &str) -> Result<bool, ReconcileError> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err.into()),
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()) == expected)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ReconcileError> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("managed policy path has no parent"))?;
    fs::create_dir_all(parent)?;
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("managed-policy");
    let temp = parent.join(format!(".{file_name}.tmp-{}-{counter}", std::process::id()));

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    file.set_permissions(fs::Permissions::from_mode(MANAGED_FILE_MODE))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desired_state_tolerates_fields_this_daemon_does_not_know() {
        // Daemons update on their own schedule. If this struct rejected unknown
        // fields, the first thing cloud added would make every older daemon
        // fail to parse desired-state and silently stop pulling — a fleet
        // stranded on whatever deployment it happened to hold, with no error
        // anyone would look for.
        let json = r#"{"schemaVersion":1,"deployment":4,"policies":[
            {"id":"guard","version":2,"sha256":"aa","artifactUrl":"/a","effect":"observe",
             "someFutureField":{"nested":true}}
        ],"anotherFutureField":42}"#;
        let parsed: DesiredState = serde_json::from_str(json).expect("must parse");
        assert_eq!(parsed.deployment, 4);
        assert_eq!(parsed.policies[0].effect, PolicyEffect::Observe);
    }

    #[test]
    fn a_policy_with_no_effect_enforces() {
        // The default has to be the one that keeps enforcing: a server that
        // predates observe mode must not silently downgrade a fleet to
        // observation.
        let json = r#"{"schemaVersion":1,"deployment":1,"policies":[
            {"id":"g","version":1,"sha256":"aa","artifactUrl":"/a"}]}"#;
        let parsed: DesiredState = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.policies[0].effect, PolicyEffect::Enforce);
    }

    #[test]
    fn an_unreadable_effect_is_rejected_rather_than_guessed() {
        // Guessing would mean choosing between enforcing something cloud did
        // not ask to enforce, or observing something it wanted enforced. Both
        // are worse than refusing the deployment.
        let json = r#"{"schemaVersion":1,"deployment":1,"policies":[
            {"id":"g","version":1,"sha256":"aa","artifactUrl":"/a","effect":"maybe"}]}"#;
        assert!(serde_json::from_str::<DesiredState>(json).is_err());
    }

    #[test]
    fn the_active_manifest_records_the_effect_it_activated() {
        // active.json is what the evaluator reads. If the effect were not
        // carried here, an observe-mode policy would enforce the moment the
        // daemon restarted and re-read its own manifest.
        let manifest = ActiveDeployment {
            schema_version: 1,
            deployment: 9,
            policies: vec![ActivePolicy {
                id: "g".into(),
                version: 1,
                sha256: "aa".into(),
                path: "deployments/9/g.mjs".into(),
                effect: PolicyEffect::Observe,
            }],
        };
        let round_tripped: ActiveDeployment =
            serde_json::from_str(&serde_json::to_string(&manifest).unwrap()).unwrap();
        assert_eq!(round_tripped.policies[0].effect, PolicyEffect::Observe);
        assert!(
            serde_json::to_string(&manifest)
                .unwrap()
                .contains("\"effect\":\"observe\"")
        );
    }
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_store(name: &str) -> PolicyStore {
        let root = std::env::temp_dir().join(format!(
            "failproofaid-cloud-policy-{name}-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        PolicyStore::new(root)
    }

    fn desired(deployment: u64, id: &str, bytes: &[u8]) -> DesiredState {
        DesiredState {
            schema_version: DESIRED_STATE_SCHEMA_VERSION,
            deployment,
            policies: vec![DesiredPolicy {
                id: id.to_string(),
                version: deployment,
                sha256: sha256_hex(bytes),
                artifact_url: format!("https://cloud.invalid/{id}/{deployment}"),
                effect: PolicyEffect::Enforce,
            }],
        }
    }

    #[test]
    fn activates_a_complete_verified_deployment() {
        let store = temp_store("activate");
        let bytes = b"export default 'cloud policy';\n";
        let state = desired(7, "block-secrets", bytes);
        let fetches = AtomicUsize::new(0);
        let outcome = store
            .reconcile(&state, &|_: &DesiredPolicy| {
                fetches.fetch_add(1, Ordering::Relaxed);
                Ok(bytes.to_vec())
            })
            .unwrap();

        assert_eq!(outcome.downloaded, 1);
        assert!(outcome.activated);
        assert_eq!(fetches.load(Ordering::Relaxed), 1);
        let active = store.read_active().unwrap().unwrap();
        assert_eq!(active.deployment, 7);
        assert_eq!(active.policies[0].id, "block-secrets");
        let active_path = store.root().join(&active.policies[0].path);
        assert_eq!(fs::read(active_path).unwrap(), bytes);
        fs::remove_dir_all(store.root()).ok();
    }

    #[test]
    fn a_bad_download_never_replaces_last_known_good() {
        let store = temp_store("bad-download");
        let good = b"export default 'good';\n";
        store
            .reconcile(&desired(1, "guard", good), &|_: &DesiredPolicy| {
                Ok(good.to_vec())
            })
            .unwrap();
        let before = fs::read(store.active_manifest_path()).unwrap();

        let next = desired(2, "guard", b"export default 'expected';\n");
        let err = store
            .reconcile(
                &next,
                &|_: &DesiredPolicy| Ok(b"tampered download".to_vec()),
            )
            .unwrap_err();
        assert!(matches!(err, ReconcileError::HashMismatch { .. }));
        assert_eq!(fs::read(store.active_manifest_path()).unwrap(), before);
        assert_eq!(store.read_active().unwrap().unwrap().deployment, 1);
        fs::remove_dir_all(store.root()).ok();
    }

    #[test]
    fn a_tampered_artifact_is_reported_rather_than_silently_repaired() {
        // Layout 2 kept a second copy under `deployments/<n>/` and rebuilt one
        // from the other offline. There is one copy now, so a corrupt artifact
        // has no local source of truth and the honest outcome is an error the
        // caller logs — both callers already treat it as an integrity error.
        //
        // The safety property is unchanged: the hook path verifies the digest
        // before importing, so the tampered bytes are refused rather than run.
        let store = temp_store("tampered-artifact");
        let bytes = b"export default 'verified';\n";
        let state = desired(4, "guard", bytes);
        store
            .reconcile(&state, &|_: &DesiredPolicy| Ok(bytes.to_vec()))
            .unwrap();
        let artifact_path = store.artifact_path(&state.policies[0].sha256);
        fs::write(&artifact_path, b"tampered").unwrap();

        let err = store
            .repair_active_from_cache()
            .expect_err("a corrupt artifact with no second copy cannot be repaired locally");
        assert!(
            format!("{err}").contains("refetch"),
            "the error must say a re-fetch is required, got: {err}"
        );
        // active.json is untouched, so the worker keeps its last known-good set.
        assert!(store.read_active().unwrap().is_some());
        fs::remove_dir_all(store.root()).ok();
    }

    #[test]
    fn a_real_poll_refetches_what_local_repair_cannot() {
        // The other half of the same contract: the fix exists, it just needs the
        // server. With a working fetcher the tampered artifact is replaced and
        // counted as a repair rather than a first download.
        let store = temp_store("refetch-tampered");
        let bytes = b"export default 'verified';\n";
        let state = desired(4, "guard", bytes);
        store
            .reconcile(&state, &|_: &DesiredPolicy| Ok(bytes.to_vec()))
            .unwrap();
        let artifact_path = store.artifact_path(&state.policies[0].sha256);
        fs::write(&artifact_path, b"tampered").unwrap();

        let outcome = store
            .reconcile(&state, &|_: &DesiredPolicy| Ok(bytes.to_vec()))
            .unwrap();

        assert_eq!(outcome.repaired, 1, "present-but-wrong counts as a repair");
        assert_eq!(outcome.downloaded, 0, "not a first download");
        assert_eq!(fs::read(artifact_path).unwrap(), bytes);
        fs::remove_dir_all(store.root()).ok();
    }

    #[test]
    fn repairs_a_removed_or_rewritten_active_manifest_from_desired_state() {
        let store = temp_store("repair-active");
        let bytes = b"export default 'verified';\n";
        store
            .reconcile(&desired(11, "guard", bytes), &|_: &DesiredPolicy| {
                Ok(bytes.to_vec())
            })
            .unwrap();

        fs::write(
            store.active_manifest_path(),
            br#"{"schemaVersion":1,"deployment":11,"policies":[]}"#,
        )
        .unwrap();
        assert_eq!(store.repair_active_from_cache().unwrap(), 1);
        assert_eq!(store.read_active().unwrap().unwrap().policies.len(), 1);

        fs::write(store.active_manifest_path(), b"not-json").unwrap();
        assert_eq!(store.repair_active_from_cache().unwrap(), 1);
        assert_eq!(
            store.read_active().unwrap().unwrap().policies[0].id,
            "guard"
        );
        fs::remove_dir_all(store.root()).ok();
    }

    #[test]
    fn rejects_traversal_duplicate_ids_and_deployment_rollback() {
        let store = temp_store("validation");
        let bytes = b"policy";
        let mut traversal = desired(1, "../escape", bytes);
        assert!(matches!(
            store.reconcile(&traversal, &|_: &DesiredPolicy| Ok(bytes.to_vec())),
            Err(ReconcileError::InvalidDesiredState(_))
        ));

        traversal.policies[0].id = "guard".to_string();
        traversal.policies.push(traversal.policies[0].clone());
        assert!(matches!(
            store.reconcile(&traversal, &|_: &DesiredPolicy| Ok(bytes.to_vec())),
            Err(ReconcileError::InvalidDesiredState(_))
        ));

        store
            .reconcile(&desired(9, "guard", bytes), &|_: &DesiredPolicy| {
                Ok(bytes.to_vec())
            })
            .unwrap();
        assert!(matches!(
            store.reconcile(&desired(8, "guard", bytes), &|_: &DesiredPolicy| Ok(
                bytes.to_vec()
            )),
            Err(ReconcileError::InvalidDesiredState(_))
        ));
        fs::remove_dir_all(store.root()).ok();
    }

    /// A tampered local deployment must not be able to veto the control plane.
    ///
    /// The guard used to compare against `active.json`, a 0600 file owned by
    /// the very user the product's threat model treats as compromised. Writing
    /// one large number there made every subsequent real deployment fail
    /// validation for good; corrupt the artifacts it points at as well and the
    /// machine can neither repair locally nor accept the server, and fails
    /// closed on every tool call. A permanent denial of service for one file
    /// write.
    #[test]
    fn a_tampered_local_deployment_cannot_permanently_veto_the_server() {
        let store = temp_store("tampered-deployment");
        let bytes = b"policy";

        store
            .reconcile(&desired(5, "guard", bytes), &|_: &DesiredPolicy| {
                Ok(bytes.to_vec())
            })
            .unwrap();

        // The attack: one edit to a user-owned file.
        let manifest = store.active_manifest_path();
        let raw = fs::read_to_string(&manifest).unwrap();
        let mut active: serde_json::Value = serde_json::from_str(&raw).unwrap();
        active["deployment"] = serde_json::json!(u64::MAX);
        fs::write(&manifest, serde_json::to_vec(&active).unwrap()).unwrap();

        // A fresh process, as after any restart. It must take the server's
        // state rather than treating the local number as authority.
        let restarted = PolicyStore::new(store.root().to_path_buf());
        let outcome = restarted
            .reconcile(&desired(6, "guard", bytes), &|_: &DesiredPolicy| {
                Ok(bytes.to_vec())
            })
            .expect("the server's state must win over a local pointer");
        assert!(outcome.activated);
        assert_eq!(restarted.read_active().unwrap().unwrap().deployment, 6);

        // And replay protection still holds WITHIN the session, which is the
        // transport failure the guard actually exists for.
        assert!(matches!(
            restarted.reconcile(&desired(5, "guard", bytes), &|_: &DesiredPolicy| Ok(
                bytes.to_vec()
            )),
            Err(ReconcileError::InvalidDesiredState(_))
        ));

        fs::remove_dir_all(store.root()).ok();
    }

    #[test]
    fn the_background_monitor_detects_tampering_without_touching_the_hook_path() {
        // The monitor's job changed with the flattening. It used to REPAIR a
        // tampered copy from the other one; with a single content-addressed copy
        // it DETECTS and reports, and the fix comes from the next cloud poll.
        //
        // What it must still never do is disturb the hook path: `active.json` is
        // left exactly as it was, so the worker keeps enforcing its last
        // known-good set while the corruption is reported.
        let store = temp_store("monitor");
        let bytes = b"export default 'verified';\n";
        store
            .reconcile(&desired(10, "guard", bytes), &|_: &DesiredPolicy| {
                Ok(bytes.to_vec())
            })
            .unwrap();
        let active_before = store.read_active().unwrap().unwrap();
        let artifact = store.root().join(&active_before.policies[0].path);
        fs::write(&artifact, b"tampered").unwrap();

        let shutdown = Arc::new(AtomicBool::new(false));
        let handle =
            spawn_integrity_monitor(store.clone(), shutdown.clone(), Duration::from_millis(10));
        std::thread::sleep(Duration::from_millis(60));
        shutdown.store(true, Ordering::Relaxed);
        handle.join().unwrap();

        // Still tampered — the monitor cannot fix this alone any more — but the
        // pointer the worker reads is untouched.
        assert_eq!(fs::read(&artifact).unwrap(), b"tampered");
        assert_eq!(store.read_active().unwrap().unwrap(), active_before);
        fs::remove_dir_all(store.root()).ok();
    }
}

#[cfg(test)]
mod pre_rename_state_tests {
    use super::*;

    /// Byte-exact `active.json` written by a daemon before the
    /// generation→deployment / revision→version rename, captured from a live
    /// machine rather than hand-written.
    const PRE_RENAME_ACTIVE: &str = r#"{
  "schemaVersion": 1,
  "generation": 1,
  "policies": [
    {
      "id": "e2e-block-curl",
      "revision": 1,
      "sha256": "732c6e780e183a15259688d858e4ec0db20c7dd13352601c73db5540122e2c30",
      "path": "generations/1/e2e-block-curl.mjs",
      "effect": "enforce"
    }
  ]
}"#;

    /// The upgrade case. `ActiveDeployment` carries `deny_unknown_fields`, so
    /// without the aliases this fails on three counts at once: `generation`
    /// unrecognised, `deployment` missing, and `revision`/`version` likewise per
    /// policy. The machine would lose the deployment it was already enforcing
    /// until a poll succeeded — on a fail-closed machine, exactly the gap this
    /// subsystem exists to close.
    #[test]
    fn active_json_written_before_the_rename_still_parses() {
        let parsed: ActiveDeployment = serde_json::from_str(PRE_RENAME_ACTIVE)
            .expect("a pre-rename active.json must still be readable after an upgrade");
        assert_eq!(parsed.schema_version, 1);
        assert_eq!(parsed.deployment, 1);
        assert_eq!(parsed.policies.len(), 1);
        assert_eq!(parsed.policies[0].version, 1);
        assert_eq!(parsed.policies[0].id, "e2e-block-curl");
        assert_eq!(parsed.policies[0].effect, PolicyEffect::Enforce);
    }

    /// The WIRE deliberately does NOT accept the old spelling.
    ///
    /// The alias was there and was removed on purpose: AgentEye#559 emits only
    /// the new names and bumped the payload to `schemaVersion: 2`, so an alias
    /// here would be dead code guarding a case no server can produce — and a
    /// silently-tolerated old field is how two sides drift back apart. If a
    /// payload ever arrives with `generation`/`revision`, it is either a stale
    /// server or something forged, and both should fail loudly.
    ///
    /// This is the exact opposite choice from `ActiveDeployment` above, and the
    /// difference is *who wrote the bytes*: the wire comes from a server we
    /// version in lockstep, `active.json` comes from a daemon that may be older
    /// than the one now reading it.
    #[test]
    fn the_wire_does_not_accept_the_pre_rename_spelling() {
        let err = serde_json::from_str::<DesiredState>(
            r#"{"schemaVersion":1,"generation":184,
                "policies":[{"id":"p","revision":7,"sha256":"a",
                             "artifactUrl":"/enforcement/v1/artifacts/a"}]}"#,
        )
        .expect_err("the old wire spelling must be refused, not silently accepted");
        assert!(
            err.to_string().contains("missing field"),
            "expected a missing-field error, got: {err}"
        );
    }

    /// Both schema versions are readable, and only from disk does 1 arise.
    #[test]
    fn both_schema_versions_are_accepted() {
        assert!(
            SUPPORTED_SCHEMA_VERSIONS.contains(&1),
            "a beta daemon's files are v1"
        );
        assert!(
            SUPPORTED_SCHEMA_VERSIONS.contains(&DESIRED_STATE_SCHEMA_VERSION),
            "what we write must be readable"
        );
        assert_eq!(DESIRED_STATE_SCHEMA_VERSION, 2, "the server emits 2");

        // The version the server actually sends must validate.
        let desired: DesiredState = serde_json::from_str(
            r#"{"schemaVersion":2,"deployment":1,
                "policies":[{"id":"p","version":1,
                  "sha256":"439735423d5d532041bccbbc62cafefacd2253d3a7c71ff99d6473b38acda0ee",
                  "artifactUrl":"/enforcement/v1/artifacts/x","effect":"enforce"}]}"#,
        )
        .expect("schemaVersion 2 is what AgentEye emits");
        validate_desired_state(&desired).expect("v2 desired state must validate");

        // ...and an unknown one is still refused.
        let bad = DesiredState {
            schema_version: 99,
            ..desired
        };
        assert!(
            validate_desired_state(&bad).is_err(),
            "an unknown version must be refused"
        );
    }

    /// The new spelling is what we WRITE, and must keep round-tripping — an
    /// alias that quietly became the canonical name would be its own bug.
    #[test]
    fn the_current_spelling_round_trips() {
        let state = ActiveDeployment {
            schema_version: 1,
            deployment: 9,
            policies: vec![ActivePolicy {
                id: "p".into(),
                version: 3,
                sha256: "a".into(),
                path: "deployments/9/p.mjs".into(),
                effect: PolicyEffect::Observe,
            }],
        };
        let text = serde_json::to_string(&state).unwrap();
        assert!(
            text.contains("\"deployment\":9"),
            "must serialize the NEW name: {text}"
        );
        assert!(
            text.contains("\"version\":3"),
            "must serialize the NEW name: {text}"
        );
        assert_eq!(
            serde_json::from_str::<ActiveDeployment>(&text).unwrap(),
            state
        );
    }
}
