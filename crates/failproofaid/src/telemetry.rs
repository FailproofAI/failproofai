//! Product telemetry for the daemon itself: a buffered PostHog lane on its own
//! thread.
//!
//! Everything that moved into failproofaid went dark. Collection, cloud policy
//! pull, worker supervision and the fail-closed enforcement path all report
//! nothing, so the one component whose failure denies every tool call on a
//! machine is the one component we cannot see. This lane closes that, under the
//! same doctrine every other lane here follows — its own thread, the shared
//! shutdown flag, `catch_unwind` per tick, every error swallowed.
//!
//! # What it must never do
//!
//! The daemon fails closed: `daemon-client.ts` turns an unreachable or slow
//! daemon into a DENY across all 12 agent CLIs. So [`record`] is a bounded
//! push onto an in-memory ring and nothing else — no I/O, no network, no
//! allocation the caller waits on beyond one small `Vec`. It is called from
//! [`crate::worker::Worker::ensure_started`], which is ON the hook path. The
//! HTTP POST happens only on this lane's own thread, and the ring lock is
//! always released before a request starts, so a black-holing corporate proxy
//! can stall the lane for its whole timeout without a hook call ever noticing.
//!
//! There is deliberately **no per-hook-call event**. The existing code never
//! sends an `allow`, and awaiting `hook_policy_triggered` on the deny path once
//! cost ~700ms and blew the 150ms fail-closed budget (hence
//! `awaitTelemetryFlush: false` in `worker-server.ts`). Hook volume, if it is
//! ever wanted, belongs in atomic counters and a periodic rollup — not here.
//!
//! # Privacy envelope
//!
//! Low-cardinality enums, booleans and counts only. Deliberately excluded, and
//! this is the list to check a new property against: **no file path** (not the
//! home, not a transcript, not a policy file), **no command string** (the
//! worker command, the CLI command and anything a user's policy ran), **no
//! policy id or source**, **no prompt, tool input or transcript text**, **no
//! URL** (the cloud origin identifies the customer's deployment), **no token**,
//! **no error message** (`io::Error` renders paths and hostnames — errors are
//! reported as an enum, and the detail stays in the service log where the
//! operator can already see it).
//!
//! Two identifying fields ride deliberately, both already collected elsewhere:
//! the enrolled `machine_id` and the OS user, which together are the identity
//! the collector stamps on every event (a username is unique only within a
//! machine). They are what make a report address a profile on a machine rather
//! than a machine.
//!
//! # The off-switch is checked before anything is buffered
//!
//! `[telemetry] enabled` in `config.toml` plus `FAILPROOFAI_TELEMETRY_DISABLED`,
//! resolved to the MORE RESTRICTIVE of the two, exactly as `lib/telemetry-enabled.ts`
//! does for the four TypeScript dispatchers. The file is the one that matters
//! here: this is a system-scope service unit whose environment carries
//! essentially nothing, so a shell export is structurally incapable of reaching
//! it. It is re-read every tick and never memoised for the life of the process
//! — an opt-out a long-lived daemon keeps ignoring until it restarts is an
//! opt-out that does not hold, and that memoisation was already rejected once
//! in this codebase for exactly that reason. When a tick sees it switched off,
//! the ring is cleared as well as closed, so nothing buffered before the switch
//! is sent afterwards.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

/// Mirrors `POSTHOG_API_KEY` in `src/posthog-key.ts`. Write-only, safe to
/// commit. Rust cannot import that module, so `__tests__/hooks/daemon-telemetry.test.ts`
/// reads both files and fails if they drift — a rotated key changed in one place
/// and not the other leaves a daemon reporting perfectly into a project nobody
/// looks at.
const POSTHOG_API_KEY: &str = "phc_Ac1Ww1GqKc0z1SyrRWbmatEeQdlOQIsDEEdP8l8JRgX";

/// Mirrors `POSTHOG_PRODUCT` in the same file.
const POSTHOG_PRODUCT: &str = "failproofai-oss";

const POSTHOG_HOST: &str = "https://us.i.posthog.com";

/// A FIFTH `$lib`, distinct from `failproofai` (the Next.js server),
/// `failproofai-hooks` (the CLI and hook binary), `failproofai-web` and
/// `failproofai-install`. Distinct because "which component reported this" is
/// the first question asked of any of these events, and a daemon event that
/// claimed to be a hook event would be indistinguishable from one.
const LIB: &str = "failproofai-daemon";

/// How often the lane wakes to re-read the opt-out, poll counters and flush.
///
/// A minute is long for a lifecycle stream that emits a handful of events per
/// daemon lifetime, and that is the point: it bounds how often a machine with
/// no network talks to a proxy that will not answer. `FAILPROOFAI_TELEMETRY_FLUSH_MS`
/// shortens it for tests.
const FLUSH_INTERVAL: Duration = Duration::from_secs(60);
const MINIMUM_FLUSH_MS: u64 = 50;

/// Events held in memory before a flush.
///
/// Sized for the lifecycle stream it carries — a start, a stop, a worker
/// restart, the odd collector fault — with two orders of magnitude of headroom,
/// so reaching it means something is emitting in a loop and the right answer is
/// to drop rather than to grow. A ring that can grow is a memory leak in a
/// process that must not fail.
const RING_CAPACITY: usize = 128;

/// Send attempts for one batch before it is dropped.
///
/// Weak on purpose. Telemetry loss is acceptable; a daemon retrying forever
/// against a corporate proxy that answers 407 to everything is not, and neither
/// is a ring that never drains because its head cannot be delivered.
const MAX_SEND_ATTEMPTS: u32 = 3;

// ── The buffer ───────────────────────────────────────────────────────────────

struct Event {
    name: &'static str,
    props: Map<String, Value>,
    at_ms: i64,
    attempts: u32,
}

struct Lane {
    ring: Mutex<VecDeque<Event>>,
    /// The resolved opt-out, refreshed every tick. Read by [`record`] so a
    /// disabled machine never even buffers; re-resolved from disk before every
    /// send so the atomic can never be the only thing standing between a
    /// switched-off machine and a request.
    enabled: AtomicBool,
    /// Reported once, then counted. A machine dropping telemetry is worth one
    /// line in the service log and no more.
    dropped: AtomicU64,
    warned_dropped: AtomicBool,
    /// Resolved once by the lane thread and reused by the shutdown flush, which
    /// runs after that thread has exited.
    identity: Mutex<Option<Identity>>,
}

static LANE: OnceLock<Arc<Lane>> = OnceLock::new();

/// The collector's own counters, published by `spawn_collector_manager` once it
/// has actually started a collector.
///
/// A pull, not a push: the design rule for this feature is that no telemetry
/// code enters `crates/fpai-collect`. The counters it already keeps for the
/// health record are enough to see a task restarting in a loop, and polling
/// them here keeps the collector unaware that anything is watching.
static COLLECTOR_METRICS: OnceLock<Arc<fpai_collect::SupervisorMetrics>> = OnceLock::new();

pub fn set_collector_metrics(metrics: Arc<fpai_collect::SupervisorMetrics>) {
    let _ = COLLECTOR_METRICS.set(metrics);
}

/// Buffer one event. Never blocks on I/O, never fails, never panics.
///
/// A no-op until [`spawn`] has installed the lane, and a no-op whenever the
/// opt-out says so — checked here rather than only at send time so a
/// switched-off machine holds nothing in memory either.
pub fn record(name: &'static str, props: Value) {
    let Some(lane) = LANE.get() else {
        return;
    };
    if !lane.enabled.load(Ordering::Relaxed) {
        return;
    }
    let props = match props {
        Value::Object(map) => map,
        // A non-object would serialise into a `properties` PostHog rejects for
        // the whole batch, taking the other events with it.
        _ => Map::new(),
    };
    lane.push(Event {
        name,
        props,
        at_ms: now_ms(),
        attempts: 0,
    });
}

impl Lane {
    fn push(&self, event: Event) {
        // `unwrap_or_else(into_inner)` rather than `unwrap`: nothing
        // user-supplied runs under this lock so a poisoned mutex is close to
        // impossible, but this is reached from the hook path and a panic here
        // would deny a tool call over a telemetry event.
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        if ring.len() >= RING_CAPACITY {
            // Oldest out, not newest refused: the interesting events in an
            // overflow are the recent ones, and the head is what a failing send
            // is stuck on.
            ring.pop_front();
            self.dropped.fetch_add(1, Ordering::Relaxed);
            if !self.warned_dropped.swap(true, Ordering::Relaxed) {
                eprintln!("[failproofaid] telemetry buffer is full; dropping the oldest events");
            }
        }
        ring.push_back(event);
    }

    /// Take everything currently buffered. The lock is released before the
    /// caller does any I/O — the whole reason a hook call can never wait on a
    /// telemetry request.
    fn drain(&self) -> Vec<Event> {
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        ring.drain(..).collect()
    }

    /// Put a failed batch back at the head, still bounded.
    fn requeue(&self, batch: Vec<Event>) {
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        for event in batch.into_iter().rev() {
            if ring.len() >= RING_CAPACITY {
                ring.pop_back();
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
            ring.push_front(event);
        }
    }

    fn clear(&self) {
        self.ring.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

// ── Configuration and the opt-out ────────────────────────────────────────────

struct FileConfig {
    telemetry_enabled: bool,
    machine_id: Option<String>,
}

/// `[telemetry]` and `[collector].machine_id` out of `config.toml`, in one read.
///
/// Mirrors `readConfig` in `src/hooks/fp-config.ts` value for value: only an
/// explicit `enabled = false` switches telemetry off, and an absent, unreadable
/// or unparseable file resolves to the shipped default (on) rather than to a
/// third answer. That is the opposite direction from the audit lane's reader,
/// which resolves the same uncertainty to OFF — the asymmetry is deliberate and
/// matches the two switches: one guards reading every transcript on the disk,
/// this one guards a handful of counts.
fn load_file_config(home: &Path) -> FileConfig {
    let default = FileConfig {
        telemetry_enabled: true,
        machine_id: None,
    };
    let Ok(text) = std::fs::read_to_string(home.join("config.toml")) else {
        return default;
    };
    // `toml::from_str`, NOT `text.parse::<toml::Value>()` — `FromStr for Value`
    // parses a single VALUE and rejects a whole document at its first table
    // header. It compiles and never errors visibly; the audit lane shipped that
    // bug once and it made every table on every machine read as absent.
    let Ok(root) = toml::from_str::<toml::Value>(&text) else {
        return default;
    };
    FileConfig {
        telemetry_enabled: root.get("telemetry").and_then(|t| t.get("enabled"))
            != Some(&toml::Value::Boolean(false)),
        machine_id: root
            .get("collector")
            .and_then(|c| c.get("machine_id"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty()),
    }
}

/// The env half of the gate. Kept byte-identical to the TypeScript check
/// (`=== "1"`) so the two halves of one product cannot disagree about what the
/// variable means.
fn disabled_by_env() -> bool {
    std::env::var("FAILPROOFAI_TELEMETRY_DISABLED").as_deref() == Ok("1")
}

/// The more restrictive of environment and file. Either says stop, and we stop;
/// the environment can never re-enable something the file switched off.
fn telemetry_allowed(config: &FileConfig) -> bool {
    !disabled_by_env() && config.telemetry_enabled
}

// ── Identity ─────────────────────────────────────────────────────────────────

/// Which rung of the ladder produced `distinct_id`, reported on every event.
///
/// Without it a person split is invisible: the same machine reporting under two
/// ids looks exactly like two machines, and there is nothing in the data to say
/// which of the two is the CLI's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IdSource {
    /// The id the CLI itself resolved, read from `state/telemetry-id`. The only
    /// rung that is correct by construction rather than by agreement.
    Cli,
    /// Recomputed from the platform machine id with the CLI's own formula.
    Machine,
    /// Minted here and persisted, because neither of the above was available.
    Generated,
    /// Minted here and NOT persistable. Every restart is a new person; the
    /// label is what stops that being mistaken for a fleet.
    Ephemeral,
}

impl IdSource {
    fn as_str(self) -> &'static str {
        match self {
            IdSource::Cli => "cli",
            IdSource::Machine => "machine",
            IdSource::Generated => "generated",
            IdSource::Ephemeral => "ephemeral",
        }
    }
}

#[derive(Debug, Clone)]
struct Identity {
    distinct_id: String,
    source: IdSource,
    os_user: Option<String>,
}

/// The namespace `lib/telemetry-id.ts` HMACs with. Changing it on either side
/// renames every machine in PostHog.
const ID_NAMESPACE: &[u8] = b"failproofai-telemetry-v1";

/// Resolve who this daemon is, once.
///
/// **Tier 2 of `lib/telemetry-id.ts` is deliberately NOT reproduced.** That tier
/// hashes `os.arch()` and `os.cpus()[0].model`, which are Node-formatted — Node
/// says `x64` where Rust says `x86_64`, and the CPU model string is assembled by
/// libuv. A near-miss there does not fail; it silently files every machine under
/// two different PostHog persons, and nothing in the data says so. What IS
/// reproduced is tier 1, which hashes the raw platform machine id and has no
/// Node in it at all — so on any machine with an `/etc/machine-id` or an
/// `IOPlatformUUID`, the daemon and the CLI land on the same person without
/// having to agree on a file.
fn resolve_identity(home: &Path, platform_machine_id: Option<String>) -> Identity {
    let os_user = crate::current_os_user();

    if let Some(id) = read_cli_id(&crate::paths::telemetry_id_path(home)) {
        return Identity {
            distinct_id: id,
            source: IdSource::Cli,
            os_user,
        };
    }
    if let Some(raw) = platform_machine_id {
        return Identity {
            distinct_id: hash_to_id(raw.as_bytes()),
            source: IdSource::Machine,
            os_user,
        };
    }
    let (distinct_id, source) = generated_id(home);
    Identity {
        distinct_id,
        source,
        os_user,
    }
}

/// The daemon's own fallback id. Not in `paths.rs`: nothing outside this module
/// reads or writes it, and the rule there is that a path with one party is
/// derived where it is used rather than mirrored into a file whose whole
/// purpose is agreement between two.
fn generated_id_path(home: &Path) -> PathBuf {
    home.join("state").join("daemon-telemetry-id")
}

/// Read the CLI's id, rejecting anything that is not plausibly one.
///
/// A truncated or garbage file would otherwise become a permanent, wrong person
/// id — worse than falling through to a rung that can be recomputed. The shape
/// check is deliberately loose (the CLI's tier 3 is a UUID, its tiers 1 and 2
/// are 64 hex characters) and only excludes what could not have been written by
/// `getInstanceId`.
fn read_cli_id(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let id = raw.trim();
    if id.is_empty() || id.len() > 128 {
        return None;
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    Some(id.to_string())
}

/// Mint an id and keep it, so a machine that reaches this rung is still ONE
/// person across restarts. A home that cannot be written degrades to
/// [`IdSource::Ephemeral`] rather than to no telemetry at all.
fn generated_id(home: &Path) -> (String, IdSource) {
    let path = generated_id_path(home);
    if let Some(existing) = read_cli_id(&path) {
        return (existing, IdSource::Generated);
    }
    let minted = random_hex();
    match write_private(&path, minted.as_bytes()) {
        Ok(()) => (minted, IdSource::Generated),
        Err(_) => (minted, IdSource::Ephemeral),
    }
}

/// 16 random bytes as hex, from the OS.
///
/// Falls back to the clock and the pid, which is weak but only has to be unique
/// across the machines that reach this branch at all — and a colliding id is a
/// merged person, not a correctness or security failure.
fn random_hex() -> String {
    // `read_exact` on an open handle, NEVER `fs::read`: /dev/urandom is an
    // endless stream, so read-the-whole-file does not return — it allocates
    // until the OOM killer arrives. Caught by this module's own tests, which
    // sat at 60 seconds and then took a SIGKILL.
    let mut bytes = [0u8; 16];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut bytes))
        .is_ok()
    {
        return to_hex(&bytes);
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    to_hex(&sha256(format!("{nanos}:{}", std::process::id()).as_bytes())[..16])
}

/// Persist atomically (tmp → fsync → rename) at owner-only permissions, the
/// same way `audit_lane::save_state` does for its own file under `state/`.
///
/// Direct truncate-and-write would be wrong in different ways for each of the
/// two files this writes. A torn `daemon-telemetry-id` is the worse one: a
/// truncated hex string still passes [`read_cli_id`]'s shape check, so the
/// daemon would adopt half an id as a permanent person and every event from
/// that machine would file under it — which is precisely why `getInstanceId()`
/// on the TypeScript side writes the CLI's copy through a rename too. A torn
/// `daemon-run.json` is milder but still lossy: the next start reads it as
/// `unknown` and loses the one signal here worth alerting on, whether the
/// previous run crashed.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // A fixed `.tmp` sibling rather than a pid-suffixed one: `lock::acquire`
    // guarantees a single daemon per home, so unlike the CLI's copy of this
    // write there is no second writer to collide with.
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    write_owner_only(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(unix)]
fn write_owner_only(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

#[cfg(not(unix))]
fn write_owner_only(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

/// The raw platform machine id, by the same route `getPlatformMachineId()` in
/// `lib/telemetry-id.ts` takes — the same files on Linux, the same `ioreg` key
/// on macOS — because the whole value of this rung is producing the identical
/// input to the identical hash.
fn platform_machine_id() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(raw) = std::fs::read_to_string(path) {
                let id = raw.trim();
                if !id.is_empty() {
                    return Some(id.to_string());
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        // Deliberately not a regex: `"IOPlatformUUID" = "<uuid>"`, and the only
        // thing that matters is extracting the same bytes Node's match does.
        let line = text.lines().find(|l| l.contains("\"IOPlatformUUID\""))?;
        let value = line.split('=').nth(1)?.trim();
        let uuid = value.trim_matches('"').trim();
        if !uuid.is_empty() {
            return Some(uuid.to_string());
        }
    }
    None
}

/// `hashToId` from `lib/telemetry-id.ts`: HMAC-SHA256 under the shared
/// namespace, lowercase hex.
fn hash_to_id(raw: &[u8]) -> String {
    to_hex(&hmac_sha256(ID_NAMESPACE, raw))
}

/// HMAC-SHA256 (RFC 2104), spelled out rather than pulled in.
///
/// `sha2` is already a dependency of this crate; `hmac` is not, and adding a
/// crate to a binary that cross-compiles to four targets to gain twenty lines
/// is a worse trade than writing them. Pinned by an RFC 4231 vector AND by a
/// value produced by the Node `crypto.createHmac` call this must agree with, so
/// a subtle mistake here fails a test rather than quietly splitting every
/// machine into two PostHog persons.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut padded = [0u8; BLOCK];
    if key.len() > BLOCK {
        padded[..32].copy_from_slice(&sha256(key));
    } else {
        padded[..key.len()].copy_from_slice(key);
    }
    let mut inner_key = [0x36u8; BLOCK];
    let mut outer_key = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        inner_key[i] ^= padded[i];
        outer_key[i] ^= padded[i];
    }
    let mut inner = Vec::with_capacity(BLOCK + message.len());
    inner.extend_from_slice(&inner_key);
    inner.extend_from_slice(message);
    let inner_digest = sha256(&inner);
    let mut outer = Vec::with_capacity(BLOCK + 32);
    outer.extend_from_slice(&outer_key);
    outer.extend_from_slice(&inner_digest);
    sha256(&outer)
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── The batch ────────────────────────────────────────────────────────────────

/// Node's spelling of the architecture, not Rust's.
///
/// The same warning that governs the identity ladder applies to a plain
/// property: `x86_64` and `x64` are the same machines under two names, and a
/// breakdown by architecture that splits them reads as two populations. The
/// value is only ever compared against what the four TypeScript dispatchers
/// send, so it is theirs that decides the spelling.
fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// Node's spelling of the platform, not Rust's — for exactly the reason
/// [`node_arch`] exists.
///
/// `std::env::consts::OS` says `macos` where `os.platform()` says `darwin`, and
/// `manager.ts` / `install-check.ts` send the Node value on every install and
/// setup event. Sent raw, half of the four release legs would report a second
/// name for a population the other dispatchers already file under `darwin`, and
/// a breakdown by platform would show two — which is the same silent split the
/// identity ladder is built to avoid, arrived at through a property nobody
/// thinks of as an identifier.
/// Takes the name rather than reading `std::env::consts::OS` itself, because
/// the branch that matters is the one this test runner cannot reach: CI and
/// every developer here are on Linux, where the mapping is the identity, so a
/// function that resolved its own input would be asserted only on the case that
/// was never wrong.
fn node_platform(os: &str) -> &str {
    match os {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn build_batch(
    api_key: &str,
    identity: &Identity,
    machine_id: Option<&str>,
    events: &[Event],
) -> Value {
    let batch: Vec<Value> = events
        .iter()
        .map(|event| {
            let mut props = event.props.clone();
            props.insert("$lib".into(), json!(LIB));
            props.insert("$lib_version".into(), json!(env!("CARGO_PKG_VERSION")));
            props.insert(
                "failproofai_version".into(),
                json!(env!("CARGO_PKG_VERSION")),
            );
            props.insert("product".into(), json!(POSTHOG_PRODUCT));
            props.insert("id_source".into(), json!(identity.source.as_str()));
            props.insert(
                "platform".into(),
                json!(node_platform(std::env::consts::OS)),
            );
            props.insert("arch".into(), json!(node_arch()));
            if let Some(user) = identity.os_user.as_deref() {
                props.insert("os_user".into(), json!(user));
            }
            if let Some(machine_id) = machine_id {
                props.insert("machine_id".into(), json!(machine_id));
            }
            let mut entry = Map::new();
            entry.insert("event".into(), json!(event.name));
            entry.insert("distinct_id".into(), json!(identity.distinct_id));
            entry.insert("properties".into(), Value::Object(props));
            // Stamped when the event happened, not when the batch left: an event
            // buffered across a flush interval (or across a whole daemon
            // lifetime, for `daemon_started`) would otherwise arrive dated by
            // its delivery, and `daemon_started`/`daemon_stopped` in one batch
            // would land at the same instant with no order between them.
            if let Some(ts) = rfc3339(event.at_ms) {
                entry.insert("timestamp".into(), json!(ts));
            }
            Value::Object(entry)
        })
        .collect();
    json!({ "api_key": api_key, "batch": batch })
}

fn rfc3339(at_ms: i64) -> Option<String> {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::from_unix_timestamp_nanos(at_ms as i128 * 1_000_000)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

fn posthog_host() -> String {
    std::env::var("FAILPROOFAI_POSTHOG_HOST")
        .ok()
        .map(|h| h.trim_end_matches('/').to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| POSTHOG_HOST.to_string())
}

/// PostHog's `/batch/`, not `/capture/`: this lane accumulates several events
/// between flushes and one request for all of them is the difference between a
/// stopping daemon making one call and making five.
fn batch_url() -> String {
    format!("{}/batch/", posthog_host())
}

fn posthog_api_key() -> String {
    std::env::var("FAILPROOFAI_POSTHOG_KEY")
        .ok()
        .filter(|k| !k.is_empty())
        .unwrap_or_else(|| POSTHOG_API_KEY.to_string())
}

// ── The lane ─────────────────────────────────────────────────────────────────

struct Runner {
    client: reqwest::blocking::Client,
    identity: Option<Identity>,
    /// The collector counters as of the previous poll. `None` until the
    /// collector has published any, and the FIRST observation is only recorded
    /// — a collector's initial `starts` is one per task, and reporting that as
    /// restarts would make every healthy daemon look like it was crash-looping.
    last_collector: Option<(usize, usize, usize)>,
}

/// Start the telemetry lane.
///
/// Installs the buffer synchronously — so an event recorded a microsecond later
/// by the worker warm-up is not dropped for want of a lane — and resolves the
/// opt-out once here, before returning, so the very first [`record`] is already
/// gated. Everything expensive (identity, which may run `ioreg`, and every HTTP
/// request) happens on the thread.
/// Returns `None` when the OS refused the thread — telemetry is the most
/// expendable thing in this process, so it must never be the reason a
/// fail-closed daemon does not start. See `audit_lane::spawn` for the full
/// reasoning; it applies identically here.
pub fn spawn(shutdown: Arc<AtomicBool>) -> Option<JoinHandle<()>> {
    let home = crate::paths::failproofai_home().ok();
    let enabled = home
        .as_deref()
        .map(|home| telemetry_allowed(&load_file_config(home)))
        // No resolvable home means no config file to consult and no place to
        // keep an id. Silence is the safe reading of "we cannot tell".
        .unwrap_or(false);

    let lane = Arc::new(Lane {
        ring: Mutex::new(VecDeque::with_capacity(16)),
        enabled: AtomicBool::new(enabled),
        dropped: AtomicU64::new(0),
        warned_dropped: AtomicBool::new(false),
        identity: Mutex::new(None),
    });
    // `set` fails only if a lane is already installed, which happens when the
    // unit tests run two in one process. The first one wins and the rest are
    // no-ops rather than a panic in a daemon.
    let _ = LANE.set(lane.clone());

    let interval = flush_interval();
    std::thread::Builder::new()
        .name("fpai-telemetry".to_string())
        .spawn(move || {
            let Some(home) = home else { return };
            let mut runner = Runner {
                client: match build_client(Duration::from_secs(5), Duration::from_secs(15)) {
                    Some(client) => client,
                    // Without a client there is nothing this thread can do, and
                    // leaving the gate open would buffer forever.
                    None => {
                        lane.enabled.store(false, Ordering::Relaxed);
                        lane.clear();
                        return;
                    }
                },
                identity: None,
                last_collector: None,
            };
            while !shutdown.load(Ordering::Relaxed) {
                // A panic must not end the lane. It would not end the process
                // today (`panic = "unwind"`), but it would stop every later
                // event silently, which is indistinguishable from a machine
                // that opted out.
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    runner.tick(&lane, &home)
                }))
                .is_err()
                {
                    eprintln!("[failproofaid] telemetry lane panicked; continuing next tick");
                }
                wait_until_shutdown(&shutdown, interval);
            }
        })
        .inspect_err(|err| {
            eprintln!(
                "[failproofaid] could not start the telemetry lane: {err}; this run reports nothing"
            );
        })
        .ok()
}

impl Runner {
    fn tick(&mut self, lane: &Lane, home: &Path) {
        let config = load_file_config(home);
        let allowed = telemetry_allowed(&config);
        lane.enabled.store(allowed, Ordering::Relaxed);
        if !allowed {
            // Cleared, not merely closed: an event buffered a second before the
            // switch was flipped must not be delivered a minute after it.
            lane.clear();
            // The collector baseline goes with it. These counters are monotonic
            // and polled as a DELTA, so keeping the last reading across an
            // opt-out window would make the first tick after the switch came
            // back on report every failure and restart that happened while the
            // machine was told not to report. Dropping it restores the
            // first-observation-is-only-recorded rule below, which costs one
            // interval of collector history and reports nothing from the window.
            self.last_collector = None;
            return;
        }

        if self.identity.is_none() {
            let identity = resolve_identity(home, platform_machine_id());
            *lane.identity.lock().unwrap_or_else(|e| e.into_inner()) = Some(identity.clone());
            self.identity = Some(identity);
        }

        self.poll_collector();

        let Some(identity) = self.identity.clone() else {
            return;
        };
        send_pending(
            lane,
            &self.client,
            &batch_url(),
            &posthog_api_key(),
            &identity,
            config.machine_id.as_deref(),
        );
    }

    /// Turn the collector's monotonic counters into an event when, and only
    /// when, one of them moved.
    fn poll_collector(&mut self) {
        let Some(metrics) = COLLECTOR_METRICS.get() else {
            return;
        };
        let now = (
            metrics.failures.load(Ordering::Relaxed),
            metrics.panics.load(Ordering::Relaxed),
            metrics.starts.load(Ordering::Relaxed),
        );
        let Some(previous) = self.last_collector.replace(now) else {
            return;
        };
        let deltas = (
            now.0.saturating_sub(previous.0),
            now.1.saturating_sub(previous.1),
            now.2.saturating_sub(previous.2),
        );
        if deltas == (0, 0, 0) {
            return;
        }
        record(
            "daemon_collector_task_failed",
            json!({
                "failures": deltas.0,
                "panics": deltas.1,
                "restarts": deltas.2,
            }),
        );
    }
}

/// Drain, send, and put back what did not land.
///
/// The endpoint and key are parameters rather than read here, so the transport
/// can be exercised against a real HTTP server without mutating process-global
/// environment under a parallel test harness.
fn send_pending(
    lane: &Lane,
    client: &reqwest::blocking::Client,
    url: &str,
    api_key: &str,
    identity: &Identity,
    machine_id: Option<&str>,
) {
    let mut batch = lane.drain();
    if batch.is_empty() {
        return;
    }
    let body = build_batch(api_key, identity, machine_id, &batch);
    let delivered = client
        .post(url)
        .json(&body)
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false);
    if delivered {
        return;
    }
    batch.retain_mut(|event| {
        event.attempts += 1;
        event.attempts < MAX_SEND_ATTEMPTS
    });
    if batch.is_empty() {
        // One line, at the point the events are actually lost, rather than one
        // per failed attempt: a machine with no route to PostHog would otherwise
        // print a line a minute forever.
        eprintln!("[failproofaid] telemetry could not be delivered; dropping this batch");
        return;
    }
    lane.requeue(batch);
}

fn build_client(connect: Duration, total: Duration) -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .connect_timeout(connect)
        .timeout(total)
        .build()
        .ok()
}

fn flush_interval() -> Duration {
    std::env::var("FAILPROOFAI_TELEMETRY_FLUSH_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|ms| Duration::from_millis(ms.max(MINIMUM_FLUSH_MS)))
        .unwrap_or(FLUSH_INTERVAL)
}

fn wait_until_shutdown(shutdown: &AtomicBool, interval: Duration) {
    let deadline = Instant::now() + interval;
    while !shutdown.load(Ordering::Relaxed) && Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        std::thread::sleep(remaining.min(Duration::from_millis(50)));
    }
}

// ── Lifecycle events ─────────────────────────────────────────────────────────

/// How the previous run of this daemon ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviousExit {
    /// No record at all — this home has never run a daemon that kept one.
    FirstStart,
    /// The previous run wrote its stop marker.
    Clean,
    /// A marker exists saying a run started and never recorded finishing: a
    /// crash, a SIGKILL, or a machine that lost power. The one thing here worth
    /// alerting on, and it is invisible from anywhere else — systemd restarts
    /// the unit and the next log line looks like an ordinary start.
    Unclean,
    /// A marker that could not be read or understood.
    Unknown,
}

impl PreviousExit {
    fn as_str(self) -> &'static str {
        match self {
            PreviousExit::FirstStart => "first_start",
            PreviousExit::Clean => "clean",
            PreviousExit::Unclean => "unclean",
            PreviousExit::Unknown => "unknown",
        }
    }
}

/// `state/daemon-run.json`. Not in `paths.rs` for the same reason as
/// [`generated_id_path`]: one writer, one reader, both in this module.
#[derive(serde::Serialize, serde::Deserialize)]
struct RunMarker {
    schema: u32,
    started_at_ms: i64,
    /// False from the moment the daemon starts; set true only by an orderly
    /// shutdown. Absence of the flip is what makes a crash detectable at all.
    clean_exit: bool,
    #[serde(default)]
    stopped_at_ms: Option<i64>,
}

const RUN_MARKER_SCHEMA: u32 = 1;

fn run_marker_path(home: &Path) -> PathBuf {
    home.join("state").join("daemon-run.json")
}

fn read_previous_exit(path: &Path) -> (PreviousExit, Option<i64>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (PreviousExit::FirstStart, None);
    };
    match serde_json::from_str::<RunMarker>(&text) {
        Ok(marker) if marker.schema != RUN_MARKER_SCHEMA => (PreviousExit::Unknown, None),
        Ok(marker) if marker.clean_exit => {
            let uptime = marker
                .stopped_at_ms
                .map(|stopped| (stopped - marker.started_at_ms).max(0) / 1000);
            (PreviousExit::Clean, uptime)
        }
        Ok(_) => (PreviousExit::Unclean, None),
        Err(_) => (PreviousExit::Unknown, None),
    }
}

/// Record `daemon_started`, and leave behind the marker that lets the NEXT
/// start say whether this one ended properly.
///
/// Returns the start instant so the stop event can report an uptime measured
/// monotonically — the one number here that must not be computed from a wall
/// clock an NTP correction can move underneath it.
pub fn record_started() -> Instant {
    let started = Instant::now();
    let Ok(home) = crate::paths::failproofai_home() else {
        return started;
    };
    let path = run_marker_path(&home);
    let (previous, previous_uptime) = read_previous_exit(&path);
    // No `daemon_version` here: `build_batch` already stamps the binary's
    // version onto EVERY event as `$lib_version`, so a second copy on this one
    // would be a property that can disagree with itself.
    let mut props = json!({ "previous_exit": previous.as_str() });
    if let Some(seconds) = previous_uptime
        && let Some(map) = props.as_object_mut()
    {
        map.insert("previous_uptime_seconds".into(), json!(seconds));
    }
    record("daemon_started", props);

    // Best effort. A home that cannot hold the marker costs the NEXT start its
    // `previous_exit`, which is why that reads as `first_start` rather than as
    // a crash — reporting an unwritable state directory as a crash loop would
    // be the noisiest possible way to be wrong.
    let marker = RunMarker {
        schema: RUN_MARKER_SCHEMA,
        started_at_ms: now_ms(),
        clean_exit: false,
        stopped_at_ms: None,
    };
    if let Ok(body) = serde_json::to_string(&marker) {
        let _ = write_private(&path, body.as_bytes());
    }
    started
}

/// Record `daemon_stopped` and mark the run clean.
///
/// The marker is written even when telemetry is off: it is how the next start
/// tells a crash from a `systemctl stop`, and that is worth knowing regardless
/// of whether anything is being reported.
pub fn record_stopped(reason: &'static str, started: Instant) {
    record(
        "daemon_stopped",
        json!({
            "reason": reason,
            "uptime_seconds": started.elapsed().as_secs(),
        }),
    );
    let Ok(home) = crate::paths::failproofai_home() else {
        return;
    };
    let path = run_marker_path(&home);
    let started_at_ms = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<RunMarker>(&text).ok())
        .map(|marker| marker.started_at_ms)
        .unwrap_or_else(now_ms);
    let marker = RunMarker {
        schema: RUN_MARKER_SCHEMA,
        started_at_ms,
        clean_exit: true,
        stopped_at_ms: Some(now_ms()),
    };
    if let Ok(body) = serde_json::to_string(&marker) {
        let _ = write_private(&path, body.as_bytes());
    }
}

/// One last send, on the way out.
///
/// Called after the lane thread has joined, so nothing contends with it. It uses
/// a client with much shorter timeouts than the lane's and makes exactly ONE
/// attempt: `systemctl stop` waits on this, and an upgrade that restarts the
/// service pays it every time — a black-holing proxy must cost a stopping
/// daemon a couple of seconds, not the lane's fifteen.
pub fn shutdown_flush() {
    let Some(lane) = LANE.get() else {
        return;
    };
    if !lane.enabled.load(Ordering::Relaxed) {
        lane.clear();
        return;
    }
    // Re-resolved from disk rather than trusted from the atomic: the gate is
    // the one thing here that must be answered by the file at the moment of
    // sending, not by a value cached up to a tick ago.
    let Ok(home) = crate::paths::failproofai_home() else {
        return;
    };
    let config = load_file_config(&home);
    if !telemetry_allowed(&config) {
        lane.clear();
        return;
    }
    let identity = lane
        .identity
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        // A daemon that stopped before the lane's first tick still has a
        // `daemon_started` worth delivering.
        .unwrap_or_else(|| resolve_identity(&home, platform_machine_id()));
    let Some(client) = build_client(Duration::from_secs(2), Duration::from_secs(3)) else {
        return;
    };
    let batch = lane.drain();
    if batch.is_empty() {
        return;
    }
    let body = build_batch(
        &posthog_api_key(),
        &identity,
        config.machine_id.as_deref(),
        &batch,
    );
    let _ = client.post(batch_url()).json(&body).send();
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fpai-telemetry-{}-{name}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn event(name: &'static str) -> Event {
        Event {
            name,
            props: Map::new(),
            at_ms: 1_754_000_000_000,
            attempts: 0,
        }
    }

    fn identity() -> Identity {
        Identity {
            distinct_id: "abc123".into(),
            source: IdSource::Cli,
            os_user: Some("chetan".into()),
        }
    }

    // ── the hash the CLI already uses ────────────────────────────────────────

    #[test]
    fn hmac_sha256_matches_the_rfc_4231_vector() {
        // Test case 2: key "Jefe", data "what do ya want for nothing?".
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            to_hex(&mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn hash_to_id_matches_what_node_produces_for_the_same_input() {
        // Produced by the exact call in lib/telemetry-id.ts:
        //   crypto.createHmac("sha256", "failproofai-telemetry-v1")
        //         .update("d0f8e4a2c1b34e6789ab0123456789cd").digest("hex")
        // This is the whole point of reproducing tier 1 in Rust. If it drifts,
        // every machine with an /etc/machine-id files itself under two
        // different PostHog persons and nothing in the data says so.
        assert_eq!(
            hash_to_id(b"d0f8e4a2c1b34e6789ab0123456789cd"),
            "c9473de2f8cdf2fce81b0cd9f2bc24e277325cca7e1e5d75cf771ab968c54ff8"
        );
    }

    // ── the identity ladder ──────────────────────────────────────────────────

    #[test]
    fn prefers_the_id_the_cli_already_resolved() {
        let home = scratch("id-cli");
        std::fs::create_dir_all(home.join("state")).unwrap();
        std::fs::write(crate::paths::telemetry_id_path(&home), "  cafebabe0123  \n").unwrap();
        // Even with a platform id available: agreeing with the CLI's own answer
        // beats recomputing one that might have come from a different tier.
        let id = resolve_identity(&home, Some("machine-1".into()));
        assert_eq!(id.distinct_id, "cafebabe0123");
        assert_eq!(id.source, IdSource::Cli);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn falls_back_to_the_platform_machine_id_hashed_the_cli_way() {
        let home = scratch("id-machine");
        let id = resolve_identity(&home, Some("d0f8e4a2c1b34e6789ab0123456789cd".into()));
        assert_eq!(id.source, IdSource::Machine);
        assert_eq!(
            id.distinct_id,
            hash_to_id(b"d0f8e4a2c1b34e6789ab0123456789cd")
        );
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_garbage_telemetry_id_file_is_ignored_rather_than_becoming_a_person() {
        let home = scratch("id-garbage");
        std::fs::create_dir_all(home.join("state")).unwrap();
        // A truncated write, a stray newline-only file, and something that is
        // plainly not an id. Adopting any of them would pin this machine to a
        // wrong person id permanently, where falling through recomputes one.
        for junk in ["", "   \n", "not an id: /home/chetan", &"x".repeat(200)] {
            std::fs::write(crate::paths::telemetry_id_path(&home), junk).unwrap();
            let id = resolve_identity(&home, Some("machine-1".into()));
            assert_eq!(id.source, IdSource::Machine, "should reject {junk:?}");
        }
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn mints_and_keeps_an_id_when_neither_is_available() {
        let home = scratch("id-generated");
        let first = resolve_identity(&home, None);
        assert_eq!(first.source, IdSource::Generated);
        assert_eq!(first.distinct_id.len(), 32);
        // The point of persisting it: a daemon that restarts is still ONE
        // person, not one per restart.
        let second = resolve_identity(&home, None);
        assert_eq!(second.distinct_id, first.distinct_id);
        assert_eq!(second.source, IdSource::Generated);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(generated_id_path(&home))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn an_unwritable_home_degrades_to_ephemeral_rather_than_to_silence() {
        // A read-only state directory: still reports, but says plainly that the
        // id will not survive a restart, so a fleet count can be corrected.
        let home = scratch("id-ephemeral");
        let state = home.join("state");
        std::fs::create_dir_all(&state).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o500)).unwrap();
            let id = resolve_identity(&home, None);
            assert_eq!(id.source, IdSource::Ephemeral);
            assert!(!id.distinct_id.is_empty());
            std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::remove_dir_all(&home).ok();
    }

    // ── the opt-out ──────────────────────────────────────────────────────────

    #[test]
    fn only_an_explicit_false_switches_telemetry_off() {
        // Mirrors `telemetry.enabled !== false` in fp-config.ts. A default
        // install writes no [telemetry] block at all, so "absent" has to mean
        // on or the shipped default would be unreachable.
        let home = scratch("gate-file");
        let cases = [
            ("", true),
            ("[telemetry]\nenabled = true\n", true),
            ("[mode]\nkind = \"oss\"\n", true),
            ("[telemetry]\nenabled = false\n", false),
            // Malformed: resolves to the default rather than inventing a third
            // answer, exactly as readConfig's catch does.
            ("[telemetry\nenabled = ", true),
        ];
        for (body, expected) in cases {
            std::fs::write(home.join("config.toml"), body).unwrap();
            assert_eq!(
                load_file_config(&home).telemetry_enabled,
                expected,
                "for config {body:?}"
            );
        }
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn the_machine_id_rides_from_the_collector_block() {
        let home = scratch("gate-machine");
        std::fs::write(
            home.join("config.toml"),
            "[collector]\nmachine_id = \"m-42\"\n",
        )
        .unwrap();
        assert_eq!(load_file_config(&home).machine_id.as_deref(), Some("m-42"));
        std::fs::write(home.join("config.toml"), "[collector]\nmachine_id = \"\"\n").unwrap();
        assert_eq!(load_file_config(&home).machine_id, None);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn the_gate_takes_the_more_restrictive_of_the_two_sources() {
        // The file can never be overridden by the environment; that direction is
        // what makes it an opt-out rather than a suggestion. (The env half is
        // exercised against a real process in tests/telemetry_e2e.rs — reading
        // it here would mean mutating process-global state under a test harness
        // that runs in parallel.)
        let on = FileConfig {
            telemetry_enabled: true,
            machine_id: None,
        };
        let off = FileConfig {
            telemetry_enabled: false,
            machine_id: None,
        };
        assert!(telemetry_allowed(&on) || disabled_by_env());
        assert!(!telemetry_allowed(&off));
    }

    // ── the batch ────────────────────────────────────────────────────────────

    #[test]
    fn a_batch_carries_one_entry_per_event_with_the_daemon_lib() {
        let mut first = event("daemon_started");
        first.props.insert("previous_exit".into(), json!("unclean"));
        let batch = build_batch(
            "phc_test",
            &identity(),
            Some("m-1"),
            &[first, event("daemon_stopped")],
        );
        assert_eq!(batch["api_key"], json!("phc_test"));
        let entries = batch["batch"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["event"], json!("daemon_started"));
        assert_eq!(entries[0]["distinct_id"], json!("abc123"));
        // The timestamp is the event's own, not the batch's — otherwise a start
        // and a stop delivered together arrive indistinguishable in time.
        assert!(
            entries[0]["timestamp"]
                .as_str()
                .unwrap()
                .starts_with("2025-07-31T22:13:20"),
            "got {}",
            entries[0]["timestamp"]
        );
        let props = &entries[0]["properties"];
        assert_eq!(props["$lib"], json!("failproofai-daemon"));
        assert_eq!(props["product"], json!("failproofai-oss"));
        assert_eq!(props["id_source"], json!("cli"));
        assert_eq!(props["machine_id"], json!("m-1"));
        assert_eq!(props["os_user"], json!("chetan"));
        assert_eq!(props["previous_exit"], json!("unclean"));
        // Node's spelling, not Rust's: `x86_64` and `x64` are the same machines
        // under two names and a breakdown that splits them reads as two
        // populations.
        assert!(matches!(
            props["arch"].as_str().unwrap(),
            "x64" | "arm64" | "arm" | "ia32"
        ));
        // And the same for the platform, which is the half that is easy to miss
        // because nobody thinks of it as an identifier: Rust says `macos` where
        // `os.platform()` — what manager.ts and install-check.ts send — says
        // `darwin`, so half the release legs would file under a second name.
        assert!(
            matches!(props["platform"].as_str().unwrap(), "darwin" | "linux"),
            "got {}, which is not what the TypeScript dispatchers send",
            props["platform"]
        );
        // The second event carries the super-properties too, not just the first.
        assert_eq!(
            entries[1]["properties"]["$lib"],
            json!("failproofai-daemon")
        );
    }

    #[test]
    fn the_platform_is_reported_under_the_name_the_other_dispatchers_use() {
        // The macOS row is the whole point and the one this runner cannot reach
        // by building the batch: `std::env::consts::OS` is `macos`, `manager.ts`
        // and `install-check.ts` send `os.platform()`, which is `darwin`, and
        // two of the four release legs are macOS. Sent raw it does not fail —
        // it splits one population into two names in every breakdown, the same
        // silent split the identity ladder exists to avoid, reached through a
        // property nobody thinks of as an identifier.
        assert_eq!(node_platform("macos"), "darwin");
        assert_eq!(node_platform("windows"), "win32");
        // Linux agrees already, and an OS neither side has a name for is passed
        // through rather than guessed at.
        assert_eq!(node_platform("linux"), "linux");
        assert_eq!(node_platform("freebsd"), "freebsd");
    }

    #[test]
    fn the_batch_carries_nothing_that_is_not_an_enum_or_a_count() {
        // The privacy envelope, as a test rather than a promise: every property
        // this module can emit is listed here, so adding one that carries a
        // path, a command or a URL fails until it is looked at deliberately.
        let allowed = [
            "$lib",
            "$lib_version",
            "failproofai_version",
            "product",
            "id_source",
            "platform",
            "arch",
            "os_user",
            "machine_id",
            "previous_exit",
            "previous_uptime_seconds",
            "reason",
            "uptime_seconds",
            "outcome",
            "startup_ms",
            "failures",
            "panics",
            "restarts",
            "generation",
            "generation_changed",
            "downloaded",
            "repaired",
        ];
        let mut sample = event("daemon_worker_spawned");
        for key in ["reason", "outcome", "startup_ms"] {
            sample.props.insert(key.into(), json!("x"));
        }
        let batch = build_batch("k", &identity(), Some("m-1"), &[sample]);
        for key in batch["batch"][0]["properties"].as_object().unwrap().keys() {
            assert!(allowed.contains(&key.as_str()), "unvetted property: {key}");
        }
    }

    // ── the buffer ───────────────────────────────────────────────────────────

    fn bare_lane() -> Lane {
        Lane {
            ring: Mutex::new(VecDeque::new()),
            enabled: AtomicBool::new(true),
            dropped: AtomicU64::new(0),
            warned_dropped: AtomicBool::new(false),
            identity: Mutex::new(None),
        }
    }

    #[test]
    fn the_ring_is_bounded_and_keeps_the_newest() {
        // An unbounded buffer in a process that must not fail is a memory leak
        // with a long fuse: the lane is reachable from the hook path, so an
        // event storm has to cost bytes rather than the machine.
        let lane = bare_lane();
        for _ in 0..RING_CAPACITY {
            lane.push(event("filler"));
        }
        lane.push(event("newest"));
        let ring = lane.ring.lock().unwrap();
        assert_eq!(ring.len(), RING_CAPACITY);
        // Oldest out, newest kept — the failing head is what a stuck send is
        // holding, and the recent events are the ones worth having.
        assert_eq!(ring.back().unwrap().name, "newest");
        assert_eq!(lane.dropped.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn a_requeued_batch_goes_back_at_the_head_and_stays_bounded() {
        let lane = bare_lane();
        lane.ring
            .lock()
            .unwrap()
            .push_back(event("already-buffered"));
        lane.requeue(vec![event("failed-a"), event("failed-b")]);
        let ring = lane.ring.lock().unwrap();
        // Order preserved: the batch that failed is still the oldest.
        assert_eq!(ring[0].name, "failed-a");
        assert_eq!(ring[1].name, "failed-b");
        assert_eq!(ring[2].name, "already-buffered");
        drop(ring);

        lane.requeue((0..RING_CAPACITY * 2).map(|_| event("flood")).collect());
        assert_eq!(lane.ring.lock().unwrap().len(), RING_CAPACITY);
    }

    // ── the tick's own gate ──────────────────────────────────────────────────

    #[test]
    fn a_tick_that_sees_the_switch_off_forgets_the_collector_baseline_too() {
        // The collector counters are monotonic and reported as a DELTA against
        // the previous reading. Clearing the ring but keeping that reading would
        // mean the first tick after the opt-out came back on reported every
        // failure and restart that happened WHILE the machine was told not to
        // report — the buffered-event bug one level down, in a field nobody
        // looks at as buffered state.
        let home = scratch("tick-gate");
        std::fs::write(home.join("config.toml"), "[telemetry]\nenabled = false\n").unwrap();
        let lane = bare_lane();
        lane.push(event("daemon_started"));
        let mut runner = Runner {
            client: build_client(Duration::from_millis(50), Duration::from_millis(50)).unwrap(),
            identity: None,
            last_collector: Some((7, 1, 9)),
        };

        runner.tick(&lane, &home);

        assert!(!lane.enabled.load(Ordering::Relaxed));
        assert!(
            lane.ring.lock().unwrap().is_empty(),
            "the ring must be cleared"
        );
        assert_eq!(
            runner.last_collector, None,
            "the next enabled tick must re-baseline rather than report the opt-out window"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    // ── persistence ──────────────────────────────────────────────────────────

    #[test]
    fn a_write_that_fails_leaves_the_previous_value_intact() {
        // The reason this goes tmp → rename like `audit_lane::save_state`, and
        // the assertion that actually distinguishes it from a truncate in place:
        // a write that does not complete must not destroy what was there.
        //
        // A truncating open needs write permission on the FILE, not on its
        // directory, so against a read-only `state/` it succeeds and overwrites;
        // creating a sibling `.tmp` needs the directory and fails, leaving the
        // old bytes where they were. That is the difference between a daemon
        // that keeps its identity across a bad write and one that adopts half an
        // id — a truncated hex string still passes `read_cli_id`'s shape check,
        // so it would become this machine's permanent, wrong person id.
        let home = scratch("atomic-write");
        let path = generated_id_path(&home);
        write_private(&path, b"0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(
            read_cli_id(&path).as_deref(),
            Some("0123456789abcdef0123456789abcdef")
        );
        let staged: Vec<_> = std::fs::read_dir(home.join("state"))
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name()))
            .filter(|n| n.to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(staged.is_empty(), "left a staging file behind: {staged:?}");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);

            // Root ignores the permission bits, so it cannot observe this.
            // SAFETY: getuid reads this process's credentials and cannot fail.
            if unsafe { libc::getuid() } != 0 {
                let state = home.join("state");
                std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o500)).unwrap();
                assert!(
                    write_private(&path, b"ffffffffffffffffffffffffffffffff").is_err(),
                    "the premise: this write has to fail"
                );
                assert_eq!(
                    read_cli_id(&path).as_deref(),
                    Some("0123456789abcdef0123456789abcdef"),
                    "a failed write destroyed the id it was replacing"
                );
                std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        std::fs::remove_dir_all(&home).ok();
    }

    // ── the transport, against a real HTTP server ────────────────────────────

    /// wiremock is async and everything on this lane is blocking, so the runtime
    /// is stood up explicitly and every blocking call is made from OUTSIDE it —
    /// `reqwest::blocking` panics if it is driven from a thread already inside a
    /// tokio runtime.
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn posts_one_batch_that_a_real_server_can_parse() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let rt = runtime();
        let server = rt.block_on(MockServer::start());
        rt.block_on(
            Mock::given(method("POST"))
                .and(path("/batch/"))
                .respond_with(ResponseTemplate::new(200))
                .mount(&server),
        );

        let lane = bare_lane();
        lane.push(event("daemon_started"));
        lane.push(event("daemon_worker_spawned"));
        let client = build_client(Duration::from_secs(2), Duration::from_secs(5)).unwrap();
        send_pending(
            &lane,
            &client,
            &format!("{}/batch/", server.uri()),
            "phc_test",
            &identity(),
            Some("m-1"),
        );

        // Delivered means drained: a batch the server accepted must not be
        // sitting in the ring waiting to be sent a second time.
        assert!(lane.ring.lock().unwrap().is_empty());

        let requests = rt.block_on(server.received_requests()).unwrap();
        assert_eq!(requests.len(), 1, "one batch, not one request per event");
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["api_key"], json!("phc_test"));
        let entries = body["batch"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["event"], json!("daemon_started"));
        assert_eq!(
            entries[1]["properties"]["$lib"],
            json!("failproofai-daemon")
        );
        assert_eq!(
            requests[0].headers.get("content-type").unwrap(),
            "application/json"
        );
    }

    #[test]
    fn a_server_that_refuses_the_batch_retries_weakly_and_then_drops_it() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let rt = runtime();
        let server = rt.block_on(MockServer::start());
        rt.block_on(
            Mock::given(method("POST"))
                .and(path("/batch/"))
                .respond_with(ResponseTemplate::new(500))
                .mount(&server),
        );

        let lane = bare_lane();
        lane.push(event("daemon_started"));
        let client = build_client(Duration::from_secs(2), Duration::from_secs(5)).unwrap();
        let url = format!("{}/batch/", server.uri());
        for _ in 0..MAX_SEND_ATTEMPTS {
            send_pending(&lane, &client, &url, "k", &identity(), None);
        }
        // Dropped, not retried forever: a ring whose head can never be delivered
        // would never drain, and telemetry loss is the acceptable failure here.
        assert!(lane.ring.lock().unwrap().is_empty());
        assert_eq!(
            rt.block_on(server.received_requests()).unwrap().len(),
            MAX_SEND_ATTEMPTS as usize
        );
    }

    #[test]
    fn an_endpoint_that_never_answers_neither_blocks_nor_panics() {
        // A closed port stands in for the black-holing proxy: what matters is
        // that the lane comes back, on its own, well inside its own timeout —
        // this daemon fails closed, and a lane that wedged holding the ring lock
        // would be a hook call waiting on a telemetry request.
        let lane = bare_lane();
        lane.push(event("daemon_started"));
        let client = build_client(Duration::from_millis(200), Duration::from_millis(500)).unwrap();
        let began = Instant::now();
        send_pending(
            &lane,
            &client,
            // Reserved by RFC 5737 for documentation; nothing routes there.
            "http://192.0.2.1:9/batch/",
            "k",
            &identity(),
            None,
        );
        assert!(began.elapsed() < Duration::from_secs(5), "the send hung");
        // Kept for one more try rather than dropped on the first failure.
        assert_eq!(lane.ring.lock().unwrap().len(), 1);
    }

    // ── the run marker ───────────────────────────────────────────────────────

    #[test]
    fn a_missing_marker_reads_as_a_first_start_not_as_a_crash() {
        // The direction matters: an unwritable state directory would otherwise
        // report every single start as a crash, which is the noisiest available
        // way to be wrong about the one signal here worth alerting on.
        let home = scratch("marker-absent");
        assert_eq!(
            read_previous_exit(&run_marker_path(&home)).0,
            PreviousExit::FirstStart
        );
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_marker_left_unflipped_is_the_crash_signal() {
        let home = scratch("marker-crash");
        let path = run_marker_path(&home);
        // Exactly what record_started leaves behind, and exactly what survives a
        // SIGKILL, an OOM kill or a power cut.
        write_private(
            &path,
            br#"{"schema":1,"started_at_ms":1000,"clean_exit":false}"#,
        )
        .unwrap();
        assert_eq!(read_previous_exit(&path), (PreviousExit::Unclean, None));

        write_private(
            &path,
            br#"{"schema":1,"started_at_ms":1000,"clean_exit":true,"stopped_at_ms":61000}"#,
        )
        .unwrap();
        assert_eq!(read_previous_exit(&path), (PreviousExit::Clean, Some(60)));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_corrupt_or_future_marker_is_unknown_rather_than_a_crash() {
        let home = scratch("marker-corrupt");
        let path = run_marker_path(&home);
        write_private(&path, b"{ not json").unwrap();
        assert_eq!(read_previous_exit(&path).0, PreviousExit::Unknown);
        write_private(
            &path,
            br#"{"schema":9,"started_at_ms":1,"clean_exit":false}"#,
        )
        .unwrap();
        assert_eq!(read_previous_exit(&path).0, PreviousExit::Unknown);
        std::fs::remove_dir_all(&home).ok();
    }
}
