//! Daemon log upload to FailproofAI Cloud — only when something is wrong.
//!
//! A healthy daemon logs a line for almost every hook, so its log is shipped
//! nowhere: `~/.failproofai/logs/daemon.log` keeps all of it, on the machine.
//! Cloud gets three things, each bounded (crates/PROTOCOL.md, "Machine logs"):
//!
//! - **errors** — one entry per DISTINCT warning or error (digits folded, so a
//!   loop of the same failure is one entry with a count), at most every
//!   [`ERRORS_EVERY`], only when there is one.
//! - **incident** — the last [`INCIDENT_WINDOW`] of INFO-and-up lines around an
//!   ERROR (a lane panic, a crashed worker, refused uploads), or the tail of the
//!   previous run's log when that run ended without a clean shutdown (a power
//!   loss, a kernel panic, a crash loop). At most one per [`INCIDENT_GAP`].
//! - **requested** — the tail of `daemon.log`, when an operator asked Cloud for
//!   this machine's logs (`logRequest` on the desired-state poll).
//!
//! Capture is a third writer on the log subscriber ([`Capture`]), so nothing
//! here sits on the hook path: a line is parsed into a bounded ring, and every
//! request happens later on the cloud maintenance lane. Shipping is OFF until
//! [`init`] runs, which only `main` does — tests that log never upload.
//!
//! Nothing a hook evaluates is logged by the daemon, and the upload scrubs the
//! home directory to `~` and the machine token to `[redacted]` regardless.
//! `FAILPROOFAI_NO_LOG_UPLOAD=1` turns uploading off.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Value, json};
use tracing::{Level, Metadata};
use tracing_subscriber::fmt::MakeWriter;

/// Lines older than this leave the ring.
pub const INCIDENT_WINDOW: Duration = Duration::from_secs(5 * 60);
/// Minimum gap between two incident uploads, across restarts too.
pub const INCIDENT_GAP: Duration = Duration::from_secs(15 * 60);
/// Incidents per rolling day, per process.
const INCIDENTS_PER_DAY: usize = 10;
/// How long an incident waits before it is sent, so the lines that follow the
/// error (the restart, the retry) are in it.
const INCIDENT_SETTLE: Duration = Duration::from_secs(10);
/// An incident that could not be delivered for this long is dropped.
const INCIDENT_GIVE_UP: Duration = Duration::from_secs(30 * 60);
pub const ERRORS_EVERY: Duration = Duration::from_secs(5 * 60);
/// When Cloud answers 404 (a server without the route), ask again after this.
const GONE_FOR: Duration = Duration::from_secs(24 * 60 * 60);

const RING_MAX: usize = 2000;
const DISTINCT_ERRORS_MAX: usize = 500;
pub const MAX_ENTRIES: usize = 2000;
pub const MAX_MESSAGE_BYTES: usize = 2048;
const MAX_TRIGGER_BYTES: usize = 200;
/// Under the server's 256 KiB body limit, with room for the envelope.
pub const MAX_BODY_BYTES: usize = 240 * 1024;
/// How much of `daemon.log` a requested or unclean-restart upload reads.
const TAIL_BYTES: u64 = 192 * 1024;

const MARKER: &str = "daemon.running";
const INCIDENT_STAMP: &str = ".incident-sent";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub ts: String,
    pub level: String,
    pub target: String,
    pub message: String,
    pub count: u64,
    pub last_ts: Option<String>,
}

impl Entry {
    /// The wire form. Cloud refuses a whole upload over one bad entry, so every
    /// field is made valid here rather than trusted: a line read back from a
    /// file may have no timestamp (`fallback_ts`, the previous line's) and no
    /// module path for a target.
    fn to_json(&self, scrub: &Scrub, fallback_ts: &str) -> Value {
        let ts = if looks_like_rfc3339(&self.ts) {
            self.ts.as_str()
        } else {
            fallback_ts
        };
        let message = scrub.apply(&self.message);
        let mut v = json!({
            "ts": ts,
            "level": wire_level(&self.level),
            "target": wire_target(&self.target),
            "message": truncate(&message, MAX_MESSAGE_BYTES),
            "count": self.count.max(1),
        });
        if let Some(last) = self
            .last_ts
            .as_deref()
            .filter(|l| looks_like_rfc3339(l) && *l >= ts)
        {
            v["lastTs"] = json!(last);
        }
        v
    }
}

fn looks_like_rfc3339(ts: &str) -> bool {
    let b = ts.as_bytes();
    b.len() >= 20
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[..4].iter().all(u8::is_ascii_digit)
}

fn wire_level(level: &str) -> &'static str {
    match level {
        "ERROR" => "ERROR",
        "WARN" => "WARN",
        "INFO" => "INFO",
        _ => "DEBUG",
    }
}

/// `[A-Za-z0-9_:./-]`, 1–256 chars (the server's rule).
fn wire_target(target: &str) -> String {
    let clean: String = target
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-' | '/'))
        .take(256)
        .collect();
    if clean.is_empty() {
        "failproofaid".to_string()
    } else {
        clean
    }
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

struct Captured {
    entry: Entry,
    at: Instant,
}

struct Incident {
    trigger: String,
    at: Instant,
    /// Set when the entries come from somewhere other than the ring (the
    /// previous run's log); the ring is read at send time otherwise.
    entries: Option<Vec<Entry>>,
}

#[derive(Default)]
struct State {
    enabled: bool,
    log_path: Option<PathBuf>,
    stamp_path: Option<PathBuf>,
    ring: VecDeque<Captured>,
    errors: HashMap<String, Entry>,
    /// Insertion order of `errors`, so the oldest distinct error is reported
    /// first and the map's iteration order never decides what is cut.
    error_order: Vec<String>,
    errors_overflow: u64,
    last_errors_sent: Option<Instant>,
    incident: Option<Incident>,
    incidents_sent: VecDeque<Instant>,
    last_incident: Option<Instant>,
    requested: Option<String>,
    answered: Option<String>,
    paused_until: Option<Instant>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State::default()));

fn state() -> MutexGuard<'static, State> {
    // A panic while the lock was held must not stop logging.
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The log writer that feeds the ring. Add it to the subscriber's writer with
/// `MakeWriterExt::and`; it keeps INFO and up.
#[derive(Clone, Copy, Default)]
pub struct Capture;

pub struct LineSink {
    level: Option<Level>,
    target: String,
    buf: Vec<u8>,
}

impl Write for LineSink {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.level.is_some() && self.buf.len() < 64 * 1024 {
            self.buf.extend_from_slice(bytes);
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for LineSink {
    fn drop(&mut self) {
        if let Some(level) = self.level
            && !self.buf.is_empty()
        {
            let line = String::from_utf8_lossy(&self.buf);
            record(level, &self.target, &line, Instant::now());
        }
    }
}

impl<'a> MakeWriter<'a> for Capture {
    type Writer = LineSink;
    fn make_writer(&'a self) -> LineSink {
        LineSink {
            level: None,
            target: String::new(),
            buf: Vec::new(),
        }
    }
    fn make_writer_for(&'a self, meta: &Metadata<'_>) -> LineSink {
        // tracing orders verbosity upward: ERROR < WARN < INFO < DEBUG.
        let keep = *meta.level() <= Level::INFO;
        LineSink {
            level: keep.then(|| *meta.level()),
            target: meta.target().to_string(),
            buf: Vec::new(),
        }
    }
}

/// One formatted line → an entry. The default fmt layout is
/// `<ts>  <LEVEL> [spans: ]<target>: <message>`; anything else is kept whole.
pub fn parse_line(line: &str, level: Option<&str>, target: Option<&str>) -> Entry {
    let line = line.trim_end_matches(['\n', '\r']);
    let mut rest = line;
    let mut ts = String::new();
    let mut parsed_level = None;
    if let Some((first, after)) = line.split_once(' ')
        && first.len() >= 20
        && first.as_bytes()[4] == b'-'
        && first.contains('T')
    {
        ts = first.to_string();
        let after = after.trim_start();
        if let Some((lvl, tail)) = after.split_once(' ')
            && matches!(lvl, "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE")
        {
            parsed_level = Some(lvl.to_string());
            rest = tail.trim_start();
        } else {
            rest = after;
        }
    }
    let mut found_target = target.map(str::to_string).unwrap_or_default();
    let message = match target {
        Some(t) => match rest.find(&format!("{t}: ")) {
            Some(at) => &rest[at + t.len() + 2..],
            None => rest,
        },
        // A line read back from a file: `target: message` when the head looks
        // like a module path.
        None => match rest.split_once(": ") {
            Some((head, tail))
                if !head.is_empty()
                    && head
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':')) =>
            {
                found_target = head.to_string();
                tail
            }
            _ => rest,
        },
    };
    Entry {
        ts,
        level: level
            .map(str::to_string)
            .or(parsed_level)
            .unwrap_or_else(|| "INFO".to_string()),
        target: found_target,
        message: truncate(message, MAX_MESSAGE_BYTES).to_string(),
        count: 1,
        last_ts: None,
    }
}

fn truncate(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Same failure, different numbers → same fingerprint. Every word holding a
/// digit folds to `#`, so hex request ids, batch file names and durations do
/// not make one repeated failure look like many.
pub fn fingerprint(target: &str, message: &str) -> String {
    let mut out = String::with_capacity(target.len() + message.len() + 1);
    out.push_str(target);
    out.push('|');
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        if word.chars().any(|c| c.is_ascii_digit()) {
            out.push('#');
        } else {
            out.push_str(word);
        }
        word.clear();
    };
    for c in message.chars() {
        if c.is_alphanumeric() || matches!(c, '_' | '-') {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
            out.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

fn record(level: Level, target: &str, line: &str, now: Instant) {
    let entry = parse_line(line, Some(level.as_str()), Some(target));
    // Child output stays in daemon.log only (see `is_child_output`).
    if is_child_output(&entry.message) {
        return;
    }
    // This module's own failures never trigger an upload of themselves.
    let own = target.starts_with(module_path!());
    let mut st = state();
    while st.ring.len() >= RING_MAX
        || st
            .ring
            .front()
            .is_some_and(|c| now.duration_since(c.at) > INCIDENT_WINDOW)
    {
        st.ring.pop_front();
    }
    if level <= Level::WARN && !own {
        let key = fingerprint(&entry.target, &entry.message);
        if let Some(existing) = st.errors.get_mut(&key) {
            existing.count += 1;
            existing.last_ts = Some(entry.ts.clone());
        } else if st.errors.len() < DISTINCT_ERRORS_MAX {
            st.error_order.push(key.clone());
            st.errors.insert(key, entry.clone());
        } else {
            st.errors_overflow += 1;
        }
    }
    if level == Level::ERROR && !own {
        let trigger = truncate(&entry.message, MAX_TRIGGER_BYTES).to_string();
        maybe_open_incident(&mut st, trigger, None, now);
    }
    st.ring.push_back(Captured { entry, at: now });
}

fn maybe_open_incident(st: &mut State, trigger: String, entries: Option<Vec<Entry>>, now: Instant) {
    if st.incident.is_some() {
        return;
    }
    if st
        .last_incident
        .is_some_and(|at| now.duration_since(at) < INCIDENT_GAP)
    {
        return;
    }
    while st
        .incidents_sent
        .front()
        .is_some_and(|at| now.duration_since(*at) > Duration::from_secs(24 * 60 * 60))
    {
        st.incidents_sent.pop_front();
    }
    if st.incidents_sent.len() >= INCIDENTS_PER_DAY {
        return;
    }
    if st
        .stamp_path
        .as_deref()
        .and_then(|p| fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|at| SystemTime::now().duration_since(at).ok())
        .is_some_and(|age| age < INCIDENT_GAP)
    {
        return;
    }
    st.incident = Some(Incident {
        trigger,
        at: now,
        entries,
    });
}

/// Read the last `max` bytes of a file, from its first complete line.
fn tail(path: &Path, end: Option<u64>, max: u64) -> Option<String> {
    use std::os::unix::fs::OpenOptionsExt;
    // Never blocks and never follows a link: a FIFO or a symlink planted at
    // the log path must not stall startup (this runs before the socket is
    // bound, and every hook is denied until it is) or read another file.
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    let meta = file.metadata().ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    let len = meta.len();
    let end = end.map_or(len, |e| e.min(len));
    let start = end.saturating_sub(max);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = vec![0u8; usize::try_from(end - start).ok()?];
    file.read_exact(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    Some(if start > 0 {
        text.split_once('\n')
            .map(|(_, r)| r.to_string())
            .unwrap_or_default()
    } else {
        text
    })
}

/// A line the daemon relays from a child process (the worker, the scheduled
/// audit). Its text is whatever that process printed — a custom policy's own
/// diagnostics, a tool command — so it never goes up automatically: only an
/// operator's request includes it, and then redacted like every line.
fn is_child_output(message: &str) -> bool {
    [
        "worker stdout:",
        "worker stderr:",
        "audit stdout:",
        "audit stderr:",
    ]
    .iter()
    .any(|prefix| message.starts_with(prefix))
}

fn entries_from_text(text: &str, with_child_output: bool) -> Vec<Entry> {
    let mut out: Vec<Entry> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| parse_line(l, None, None))
        .filter(|e| with_child_output || !is_child_output(&e.message))
        .collect();
    if out.len() > MAX_ENTRIES {
        out.drain(..out.len() - MAX_ENTRIES);
    }
    out
}

/// Owner-only, like `daemon.log` beside it, and never through whatever is
/// at `path` now: written to a fresh temporary file and renamed over it. A
/// FIFO there would block an open for writing (before the socket is bound,
/// so every hook goes without a verdict), and a symlink would redirect it.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let Some(name) = path.file_name() else {
        return Err(std::io::Error::other("no file name"));
    };
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".{}.tmp", std::process::id()));
    let tmp = path.with_file_name(tmp_name);
    let _ = fs::remove_file(&tmp);
    let written = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)?;
        file.write_all(bytes)?;
        fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

/// Size of `daemon.log` before this process writes to it. Call before the log
/// subscriber is installed; pass the result to [`init`].
pub fn log_len_before_start(log_path: &Path) -> Option<u64> {
    fs::metadata(log_path).ok().map(|m| m.len())
}

/// Turn shipping on. Called once by `main`, AFTER the singleton lock is held:
/// only the daemon that owns the machine may read the run marker, or a second
/// invocation would read the live daemon's marker as an unclean exit.
///
/// `prior_len` is [`log_len_before_start`]: the previous run's lines end there.
pub fn init(logs_dir: &Path, prior_len: Option<u64>) {
    let log_path = logs_dir.join("daemon.log");
    let marker = logs_dir.join(MARKER);
    let stamp = logs_dir.join(INCIDENT_STAMP);
    let unclean = marker.exists();
    {
        let mut st = state();
        st.enabled =
            std::env::var_os("FAILPROOFAI_NO_LOG_UPLOAD").is_none_or(|v| v.is_empty() || v == "0");
        st.log_path = Some(log_path.clone());
        st.stamp_path = Some(stamp);
    }
    // Nothing is read when uploads are off: the previous run's lines would
    // only ever be read to send them.
    if unclean && state().enabled {
        // The previous run's lines: daemon.log up to where it was before this
        // start, or the rotated file when opening rotated it away.
        let text = match prior_len {
            Some(len) if fs::metadata(&log_path).is_ok_and(|m| m.len() >= len) => {
                tail(&log_path, Some(len), TAIL_BYTES)
            }
            _ => tail(&logs_dir.join("daemon.log.1"), None, TAIL_BYTES),
        };
        let entries = text
            .as_deref()
            .map(|t| entries_from_text(t, false))
            .unwrap_or_default();
        let mut st = state();
        maybe_open_incident(
            &mut st,
            "the previous daemon run ended without a clean shutdown".to_string(),
            Some(entries),
            Instant::now(),
        );
    }
    let _ = write_private(&marker, std::process::id().to_string().as_bytes());
}

/// The daemon stopped on purpose (a signal): the next start is not an incident.
pub fn mark_clean_shutdown(logs_dir: &Path) {
    let _ = fs::remove_file(logs_dir.join(MARKER));
}

/// The desired-state poll carried `logRequest.id`.
pub fn note_request(id: &str) {
    let id = truncate(id, 128);
    if id.is_empty() {
        return;
    }
    let mut st = state();
    if st.answered.as_deref() != Some(id) && st.requested.as_deref() != Some(id) {
        st.requested = Some(id.to_string());
    }
}

/// What a POST to `machine-logs` came back with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PostOutcome {
    Stored,
    /// 429: wait before the next upload.
    RetryAfter(Duration),
    /// 404: this server has no such route.
    Gone,
    /// 413 / 422 / other 4xx: this body will never be accepted.
    Refused,
    /// Network or 5xx: try again next tick.
    Failed,
}

/// Replaces the home directory and the token in uploaded text.
pub struct Scrub {
    home: Option<String>,
    token: Option<String>,
}

impl Scrub {
    pub fn new(home: Option<String>, token: Option<String>) -> Self {
        Self {
            home: home.filter(|h| h.len() > 1),
            token: token.filter(|t| t.len() >= 8),
        }
    }
    fn apply(&self, text: &str) -> String {
        // The collector's secret patterns first (keys, bearer headers, env
        // assignments), the same rules session events get, then the machine's
        // own token and home directory.
        let mut out = fpai_collect::redact::scrub_str(text)
            .map_or_else(|| text.to_string(), |(scrubbed, _)| scrubbed);
        if let Some(t) = &self.token {
            out = out.replace(t.as_str(), "[redacted]");
        }
        if let Some(h) = &self.home {
            out = out.replace(h.as_str(), "~");
        }
        out
    }
}

enum Kind {
    Requested(String),
    Incident,
    /// What the roll-up carried: each entry's count, and the overflow count.
    /// Only that is acknowledged, so a warning logged while the upload was in
    /// flight stays for the next one.
    Errors(Vec<(String, u64)>, u64),
}

fn wire_entries(entries: &[Entry], scrub: &Scrub) -> Vec<Value> {
    // An undated first line takes the first dated one's time, else now.
    let mut last = entries
        .iter()
        .map(|e| e.ts.as_str())
        .find(|ts| looks_like_rfc3339(ts))
        .map_or_else(now_rfc3339, str::to_string);
    entries
        .iter()
        .map(|e| {
            let v = e.to_json(scrub, &last);
            if let Some(ts) = v["ts"].as_str() {
                last = ts.to_string();
            }
            v
        })
        .collect()
}

/// Build the body, keeping the NEWEST entries that fit.
pub fn body(
    machine_id: &str,
    kind: &str,
    trigger: Option<&str>,
    request_id: Option<&str>,
    entries: &[Entry],
    scrub: &Scrub,
) -> Value {
    body_from(machine_id, kind, trigger, request_id, entries, scrub).0
}

/// [`body`], and the index of the first entry it kept: `entries[start..]` is
/// exactly what the body carries. The error roll-up acknowledges only those,
/// so the older ones dropped to fit stay pending for the next roll-up instead
/// of being counted as delivered.
fn body_from(
    machine_id: &str,
    kind: &str,
    trigger: Option<&str>,
    request_id: Option<&str>,
    entries: &[Entry],
    scrub: &Scrub,
) -> (Value, usize) {
    let mut start = entries.len().saturating_sub(MAX_ENTRIES);
    loop {
        let mut v = json!({
            "machineId": machine_id,
            "daemonVersion": env!("CARGO_PKG_VERSION"),
            "kind": kind,
            "entries": wire_entries(&entries[start..], scrub),
        });
        if let Some(t) = trigger {
            v["trigger"] = json!(scrub.apply(t));
        }
        if let Some(r) = request_id {
            v["requestId"] = json!(r);
        }
        let size = serde_json::to_vec(&v).map_or(usize::MAX, |b| b.len());
        if size <= MAX_BODY_BYTES || start >= entries.len() {
            return (v, start);
        }
        // Drop the oldest quarter of what is left, at least one entry.
        start += ((entries.len() - start) / 4).max(1);
    }
}

/// One upload per call, the most useful first: an operator's request, then an
/// incident, then the error roll-up. Called by the cloud maintenance lane after
/// its poll; `post` sends one body.
pub fn ship(machine_id: &str, scrub: &Scrub, post: &dyn Fn(&Value) -> PostOutcome) {
    ship_at(machine_id, scrub, post, Instant::now());
}

fn ship_at(machine_id: &str, scrub: &Scrub, post: &dyn Fn(&Value) -> PostOutcome, now: Instant) {
    let (kind, value) = {
        let mut st = state();
        if !st.enabled || st.paused_until.is_some_and(|until| now < until) {
            return;
        }
        st.paused_until = None;
        if st
            .incident
            .as_ref()
            .is_some_and(|i| now.duration_since(i.at) > INCIDENT_GIVE_UP)
        {
            st.incident = None;
        }
        if let Some(id) = st.requested.clone() {
            let text = st
                .log_path
                .as_deref()
                .and_then(|p| tail(p, None, TAIL_BYTES));
            let entries = match text {
                Some(t) => entries_from_text(&t, true),
                None => st.ring.iter().map(|c| c.entry.clone()).collect(),
            };
            let v = body(machine_id, "requested", None, Some(&id), &entries, scrub);
            (Kind::Requested(id), v)
        } else if let Some(incident) = st
            .incident
            .as_ref()
            .filter(|i| i.entries.is_some() || now.duration_since(i.at) >= INCIDENT_SETTLE)
        {
            let entries: Vec<Entry> = match &incident.entries {
                Some(e) => e.clone(),
                None => st.ring.iter().map(|c| c.entry.clone()).collect(),
            };
            let v = body(
                machine_id,
                "incident",
                Some(&incident.trigger),
                None,
                &entries,
                scrub,
            );
            (Kind::Incident, v)
        } else if (!st.errors.is_empty() || st.errors_overflow > 0)
            && st
                .last_errors_sent
                .is_none_or(|at| now.duration_since(at) >= ERRORS_EVERY)
        {
            let mut entries: Vec<Entry> = st
                .error_order
                .iter()
                .filter_map(|k| st.errors.get(k).cloned())
                .collect();
            if st.errors_overflow > 0 {
                entries.push(Entry {
                    ts: entries.last().map(|e| e.ts.clone()).unwrap_or_default(),
                    level: "WARN".to_string(),
                    target: module_path!().to_string(),
                    message: format!(
                        "{} more warnings or errors were not itemised (over {DISTINCT_ERRORS_MAX} distinct)",
                        st.errors_overflow
                    ),
                    count: st.errors_overflow,
                    last_ts: None,
                });
            }
            let (value, start) = body_from(machine_id, "errors", None, None, &entries, scrub);
            // `entries` is the itemised errors in `error_order`, then the
            // overflow line; the body carries `entries[start..]`. Acknowledge
            // only those: an error dropped to fit was never delivered.
            let sent: Vec<(String, u64)> = st
                .error_order
                .iter()
                .filter_map(|k| st.errors.get(k).map(|e| (k.clone(), e.count)))
                .skip(start)
                .collect();
            let overflow_sent = if start < entries.len() {
                st.errors_overflow
            } else {
                0
            };
            (Kind::Errors(sent, overflow_sent), value)
        } else {
            return;
        }
    };

    // The lock is NOT held across the request: logging must never wait on it.
    let outcome = post(&value);
    let mut st = state();
    let done = match outcome {
        PostOutcome::Stored | PostOutcome::Refused => true,
        PostOutcome::RetryAfter(wait) => {
            st.paused_until = Some(now + wait.min(GONE_FOR));
            false
        }
        PostOutcome::Gone => {
            st.paused_until = Some(now + GONE_FOR);
            false
        }
        PostOutcome::Failed => false,
    };
    if !done {
        return;
    }
    match kind {
        Kind::Requested(id) => {
            st.requested = None;
            st.answered = Some(id);
        }
        Kind::Incident => {
            st.incident = None;
            st.last_incident = Some(now);
            st.incidents_sent.push_back(now);
            if let Some(stamp) = st.stamp_path.clone() {
                // Content that changes each time, so the mtime the gap is
                // measured from always moves (an empty rewrite may not).
                let sent = SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                let _ = write_private(&stamp, sent.to_string().as_bytes());
            }
        }
        Kind::Errors(sent, overflow) => {
            for (key, count) in sent {
                let left = st.errors.get_mut(&key).map(|e| {
                    e.count = e.count.saturating_sub(count);
                    e.count
                });
                if left == Some(0) {
                    st.errors.remove(&key);
                }
            }
            let State {
                errors,
                error_order,
                ..
            } = &mut *st;
            error_order.retain(|k| errors.contains_key(k));
            st.errors_overflow = st.errors_overflow.saturating_sub(overflow);
            st.last_errors_sent = Some(now);
        }
    }
}

#[cfg(test)]
pub(crate) fn reset_for_test(enabled: bool) {
    let mut st = state();
    *st = State::default();
    st.enabled = enabled;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    // The module keeps one process-wide state; serialise the tests that use it.
    static LOCK: Mutex<()> = Mutex::new(());

    fn line(level: &str, target: &str, msg: &str) -> String {
        format!("2026-11-18T13:18:37.676211Z {level:>5} {target}: {msg}\n")
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fpai-logship-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn scrub() -> Scrub {
        Scrub::new(Some("/home/alice".into()), Some("secret-token-123".into()))
    }

    fn collect(at: Instant) -> Vec<Value> {
        let sent = RefCell::new(Vec::new());
        ship_at(
            "m-1",
            &scrub(),
            &|v| {
                sent.borrow_mut().push(v.clone());
                PostOutcome::Stored
            },
            at,
        );
        sent.into_inner()
    }

    #[test]
    fn parses_the_fmt_layout() {
        let e = parse_line(
            "2026-11-18T13:18:37.676211Z  WARN fpai_collect::sources::openclaw::sqlite: could not process db=x\n",
            None,
            None,
        );
        assert_eq!(e.ts, "2026-11-18T13:18:37.676211Z");
        assert_eq!(e.level, "WARN");
        assert_eq!(e.target, "fpai_collect::sources::openclaw::sqlite");
        assert_eq!(e.message, "could not process db=x");

        let raw = parse_line("[failproofaid] worker stderr: boom", None, None);
        assert_eq!(raw.level, "INFO");
        assert_eq!(raw.message, "[failproofaid] worker stderr: boom");
    }

    #[test]
    fn repeated_errors_fold_into_one_entry_with_a_count() {
        let _g = LOCK.lock().unwrap();
        reset_for_test(true);
        let t0 = Instant::now();
        for n in 0..50 {
            record(
                Level::WARN,
                "fpai_collect::uploader",
                &line(
                    "WARN",
                    "fpai_collect::uploader",
                    &format!("upload failed after {n} ms"),
                ),
                t0,
            );
        }
        record(Level::WARN, "x", &line("WARN", "x", "other"), t0);
        let sent = collect(t0);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["kind"], "errors");
        let entries = sent[0]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["count"], 50);
        assert_eq!(entries[1]["message"], "other");
        // Nothing new: nothing sent, and the roll-up waits its interval.
        assert!(collect(t0 + Duration::from_secs(1)).is_empty());
        record(Level::WARN, "x", &line("WARN", "x", "again"), t0);
        assert!(collect(t0 + Duration::from_secs(60)).is_empty());
        assert_eq!(collect(t0 + ERRORS_EVERY).len(), 1);
    }

    #[test]
    fn errors_dropped_to_fit_a_body_stay_pending_for_the_next_roll_up() {
        let _g = LOCK.lock().unwrap();
        reset_for_test(true);
        let t0 = Instant::now();
        // 180 distinct long warnings: more than one body holds. Letters, not
        // digits, so the fingerprint keeps them apart.
        let name = |i: usize| {
            let mut n = String::new();
            let mut i = i + 1;
            while i > 0 {
                n.push((b'a' + ((i - 1) % 26) as u8) as char);
                i = (i - 1) / 26;
            }
            format!("{n} {}", "x".repeat(1900))
        };
        for i in 0..180 {
            record(Level::WARN, "x", &line("WARN", "x", &name(i)), t0);
        }
        let mut delivered = std::collections::BTreeSet::new();
        let mut uploads = 0;
        let mut at = t0;
        while uploads < 10 {
            let batch = collect(at);
            if batch.is_empty() {
                break;
            }
            uploads += 1;
            for b in &batch {
                assert!(serde_json::to_vec(b).unwrap().len() <= MAX_BODY_BYTES);
                for e in b["entries"].as_array().unwrap() {
                    delivered.insert(e["message"].as_str().unwrap().to_string());
                }
            }
            at += ERRORS_EVERY;
        }
        assert!(uploads >= 2, "180 long warnings need more than one body");
        let expected: std::collections::BTreeSet<String> = (0..180)
            .map(|i| truncate(&name(i), MAX_MESSAGE_BYTES).to_string())
            .collect();
        assert_eq!(
            delivered.len(),
            180,
            "every warning delivered, none acknowledged unsent"
        );
        assert_eq!(delivered, expected);
        assert!(collect(at).is_empty(), "all acknowledged once delivered");
    }

    #[test]
    fn a_warning_logged_during_the_upload_is_kept_for_the_next_one() {
        let _g = LOCK.lock().unwrap();
        reset_for_test(true);
        let t0 = Instant::now();
        record(Level::WARN, "x", &line("WARN", "x", "retry 1"), t0);
        record(Level::WARN, "x", &line("WARN", "x", "seen once"), t0);
        let sent = RefCell::new(Vec::new());
        ship_at(
            "m-1",
            &scrub(),
            &|v| {
                sent.borrow_mut().push(v.clone());
                // Logged while the request is in flight (the lock is free):
                // the same warning again, and new ones.
                for _ in 0..5 {
                    record(Level::WARN, "x", &line("WARN", "x", "retry 2"), t0);
                }
                record(Level::WARN, "x", &line("WARN", "x", "brand new"), t0);
                PostOutcome::Stored
            },
            t0,
        );
        let first = sent.into_inner();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["entries"].as_array().unwrap().len(), 2);
        let next = collect(t0 + ERRORS_EVERY);
        assert_eq!(next.len(), 1);
        let entries = next[0]["entries"].as_array().unwrap();
        let by_msg: Vec<(String, u64)> = entries
            .iter()
            .map(|e| {
                (
                    e["message"].as_str().unwrap().to_string(),
                    e["count"].as_u64().unwrap(),
                )
            })
            .collect();
        // "retry N" folds to one fingerprint: 1 was sent, 5 arrived after.
        assert_eq!(
            by_msg,
            vec![("retry 1".to_string(), 5), ("brand new".to_string(), 1)]
        );
        // Everything acknowledged now.
        assert!(collect(t0 + ERRORS_EVERY * 2).is_empty());
    }

    #[test]
    fn info_alone_never_uploads() {
        let _g = LOCK.lock().unwrap();
        reset_for_test(true);
        let t0 = Instant::now();
        for _ in 0..100 {
            record(Level::INFO, "a", &line("INFO", "a", "hook ok"), t0);
        }
        assert!(collect(t0 + Duration::from_secs(3600)).is_empty());
    }

    #[test]
    fn an_error_sends_one_incident_with_context_after_it_settles() {
        let _g = LOCK.lock().unwrap();
        reset_for_test(true);
        let t0 = Instant::now();
        record(Level::INFO, "a", &line("INFO", "a", "before"), t0);
        record(
            Level::ERROR,
            "failproofaid",
            &line(
                "ERROR",
                "failproofaid",
                "cloud policy sync panicked; starting it again in 5s",
            ),
            t0,
        );
        // Not before it settles; the error roll-up goes first meanwhile.
        let early = collect(t0);
        assert_eq!(early.len(), 1);
        assert_eq!(early[0]["kind"], "errors");
        record(
            Level::INFO,
            "a",
            &line("INFO", "a", "after"),
            t0 + Duration::from_secs(2),
        );
        let sent = collect(t0 + INCIDENT_SETTLE);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["kind"], "incident");
        assert_eq!(
            sent[0]["trigger"],
            "cloud policy sync panicked; starting it again in 5s"
        );
        let msgs: Vec<_> = sent[0]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["message"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(msgs.first().map(String::as_str), Some("before"));
        assert_eq!(msgs.last().map(String::as_str), Some("after"));
        // A second error inside the gap opens no second incident.
        record(
            Level::ERROR,
            "failproofaid",
            &line("ERROR", "failproofaid", "again"),
            t0 + Duration::from_secs(20),
        );
        let later = collect(t0 + Duration::from_secs(60));
        assert!(later.iter().all(|v| v["kind"] != "incident"));
    }

    #[test]
    fn scrubs_home_and_token() {
        let _g = LOCK.lock().unwrap();
        reset_for_test(true);
        let t0 = Instant::now();
        record(
            Level::WARN,
            "a",
            &line(
                "WARN",
                "a",
                "bad /home/alice/.failproofai key secret-token-123",
            ),
            t0,
        );
        let sent = collect(t0);
        assert_eq!(
            sent[0]["entries"][0]["message"],
            "bad ~/.failproofai key [redacted]"
        );
    }

    #[test]
    fn refused_and_gone_and_retry() {
        let _g = LOCK.lock().unwrap();
        reset_for_test(true);
        let t0 = Instant::now();
        record(Level::WARN, "a", &line("WARN", "a", "w"), t0);
        ship_at("m", &scrub(), &|_| PostOutcome::Gone, t0);
        let calls = RefCell::new(0);
        ship_at(
            "m",
            &scrub(),
            &|_| {
                *calls.borrow_mut() += 1;
                PostOutcome::Stored
            },
            t0 + Duration::from_secs(3600),
        );
        assert_eq!(*calls.borrow(), 0, "a 404 pauses uploads for a day");
        ship_at("m", &scrub(), &|_| PostOutcome::Failed, t0 + GONE_FOR);
        // A failed send keeps the roll-up for the next tick.
        assert_eq!(collect(t0 + GONE_FOR + Duration::from_secs(30)).len(), 1);
    }

    #[test]
    fn disabled_never_posts() {
        let _g = LOCK.lock().unwrap();
        reset_for_test(false);
        let t0 = Instant::now();
        record(Level::ERROR, "a", &line("ERROR", "a", "e"), t0);
        assert!(collect(t0 + Duration::from_secs(3600)).is_empty());
    }

    #[test]
    fn a_request_sends_the_log_tail_once() {
        let _g = LOCK.lock().unwrap();
        reset_for_test(true);
        let dir = temp_dir("request");
        let log = dir.join("daemon.log");
        fs::write(&log, line("INFO", "a", "one") + &line("WARN", "b", "two")).unwrap();
        state().log_path = Some(log);
        note_request("req-1");
        let sent = collect(Instant::now());
        assert_eq!(sent[0]["kind"], "requested");
        assert_eq!(sent[0]["requestId"], "req-1");
        assert_eq!(sent[0]["entries"].as_array().unwrap().len(), 2);
        // The same id again (the next poll, before Cloud marked it) is not resent.
        note_request("req-1");
        assert!(
            collect(Instant::now())
                .iter()
                .all(|v| v["kind"] != "requested")
        );
    }

    #[test]
    fn an_unclean_previous_run_is_an_incident_from_its_own_log() {
        let _g = LOCK.lock().unwrap();
        reset_for_test(true);
        let dir = temp_dir("unclean");
        let prev = line("INFO", "a", "old run") + &line("ERROR", "a", "last words");
        fs::write(dir.as_path().join("daemon.log"), &prev).unwrap();
        fs::write(dir.as_path().join(MARKER), "1").unwrap();
        let prior = log_len_before_start(&dir.as_path().join("daemon.log"));
        // This run's first line lands after the previous run's end.
        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(dir.as_path().join("daemon.log"))
            .unwrap();
        f.write_all(line("INFO", "a", "new run").as_bytes())
            .unwrap();
        init(dir.as_path(), prior);
        assert!(dir.as_path().join(MARKER).exists());
        let sent = collect(Instant::now());
        assert_eq!(sent[0]["kind"], "incident");
        let msgs: Vec<_> = sent[0]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["message"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(msgs, ["old run", "last words"]);
        // Sent: the stamp stops a crash loop from re-sending on every start.
        assert!(dir.as_path().join(INCIDENT_STAMP).exists());
        mark_clean_shutdown(dir.as_path());
        assert!(!dir.as_path().join(MARKER).exists());

        // A clean previous run is no incident.
        reset_for_test(true);
        init(dir.as_path(), prior);
        assert!(
            collect(Instant::now())
                .iter()
                .all(|v| v["kind"] != "incident")
        );
    }

    #[test]
    fn body_stays_under_the_limit() {
        let big = "x".repeat(MAX_MESSAGE_BYTES);
        let entries: Vec<Entry> = (0..1000)
            .map(|n| Entry {
                ts: format!("2026-11-18T13:{:02}:{:02}.000000Z", n / 60 % 60, n % 60),
                level: "INFO".into(),
                target: "t".into(),
                message: big.clone(),
                count: 1,
                last_ts: None,
            })
            .collect();
        let v = body("m", "incident", Some("t"), None, &entries, &scrub());
        assert!(serde_json::to_vec(&v).unwrap().len() <= MAX_BODY_BYTES);
        // The newest entries are the ones kept.
        assert_eq!(
            v["entries"].as_array().unwrap().last().unwrap()["ts"],
            "2026-11-18T13:16:39.000000Z"
        );
    }

    #[test]
    fn every_entry_is_valid_on_the_wire() {
        let text = "[failproofaid] worker stderr: boom\n".to_string()
            + &line("INFO", "a::b", "dated")
            + "  at Module._load (node:internal)\n"
            + "2026-11-18T13:18:40.000000Z TRACE x: verbose\n";
        let entries = entries_from_text(&text, true);
        let long = Scrub::new(None, Some("tok12345".into()));
        let mut e = entries.clone();
        e.push(Entry {
            ts: "".into(),
            level: "WARN".into(),
            target: "bad target!".into(),
            message: "tok12345".repeat(300),
            count: 0,
            last_ts: Some("x".into()),
        });
        let v = body("m", "requested", None, Some("r"), &e, &long);
        for entry in v["entries"].as_array().unwrap() {
            let ts = entry["ts"].as_str().unwrap();
            assert!(looks_like_rfc3339(ts), "{entry}");
            let target = entry["target"].as_str().unwrap();
            assert!(
                !target.is_empty()
                    && target
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_:./-".contains(c)),
                "{entry}"
            );
            assert!(["ERROR", "WARN", "INFO", "DEBUG"].contains(&entry["level"].as_str().unwrap()));
            assert!(entry["message"].as_str().unwrap().len() <= MAX_MESSAGE_BYTES);
            assert!(entry["count"].as_u64().unwrap() >= 1);
            assert!(entry.get("lastTs").is_none());
        }
        // The undated first line borrows the first dated line's time.
        assert_eq!(v["entries"][0]["ts"], "2026-11-18T13:18:37.676211Z");
    }

    /// A custom policy printed a tool command holding a credential: it must
    /// never ride an automatic upload, and a requested one gets it redacted.
    #[test]
    fn child_output_stays_out_of_automatic_uploads_and_secrets_are_redacted() {
        let _g = LOCK.lock().unwrap();
        reset_for_test(true);
        let t0 = Instant::now();
        let secret = "curl -H 'Authorization: Bearer sk-live-0123456789abcdefABCDEF' https://x";
        record(
            Level::WARN,
            "failproofaid::worker",
            &line(
                "WARN",
                "failproofaid::worker",
                &format!("worker stderr: {secret}"),
            ),
            t0,
        );
        record(
            Level::ERROR,
            "failproofaid::audit_lane",
            &line(
                "ERROR",
                "failproofaid::audit_lane",
                &format!("audit stdout: {secret}"),
            ),
            t0,
        );
        record(
            Level::WARN,
            "a",
            &line("WARN", "a", &format!("daemon saw {secret}")),
            t0,
        );
        let sent = collect(t0 + INCIDENT_SETTLE);
        let all = serde_json::to_string(&sent).unwrap();
        assert!(!all.contains("sk-live-0123456789abcdefABCDEF"), "{all}");
        assert!(
            !all.contains("worker stderr"),
            "child output is not uploaded automatically: {all}"
        );
        assert!(
            sent.iter().all(|v| v["kind"] != "incident"),
            "a child's ERROR line opens no incident"
        );
        assert_eq!(sent[0]["entries"].as_array().unwrap().len(), 1);

        // Requested: the operator asked, so child output is included, redacted.
        let dir = temp_dir("child");
        let log = dir.join("daemon.log");
        fs::write(
            &log,
            line(
                "INFO",
                "failproofaid::worker",
                &format!("worker stderr: {secret}"),
            ),
        )
        .unwrap();
        state().log_path = Some(log);
        note_request("req-child");
        let sent = collect(Instant::now());
        let req = sent.iter().find(|v| v["kind"] == "requested").unwrap();
        let msg = req["entries"][0]["message"].as_str().unwrap();
        assert!(msg.starts_with("worker stderr: "), "{msg}");
        assert!(!msg.contains("sk-live-0123456789abcdefABCDEF"), "{msg}");
    }

    /// A FIFO at daemon.log after an unclean exit must not stall startup,
    /// with uploads on or off.
    #[test]
    fn a_fifo_at_the_log_path_never_blocks_init() {
        let _g = LOCK.lock().unwrap();
        for disabled in [false, true] {
            reset_for_test(true);
            let dir = temp_dir(if disabled { "fifo-off" } else { "fifo-on" });
            let log = dir.join("daemon.log");
            let c = std::ffi::CString::new(log.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            fs::write(dir.join(MARKER), "1").unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            let d = dir.clone();
            std::thread::spawn(move || {
                // SAFETY: test-only; the env is read once inside `init`.
                if disabled {
                    unsafe { std::env::set_var("FAILPROOFAI_NO_LOG_UPLOAD", "1") };
                }
                init(&d, Some(10));
                if disabled {
                    unsafe { std::env::remove_var("FAILPROOFAI_NO_LOG_UPLOAD") };
                }
                let _ = tx.send(());
            });
            assert!(
                rx.recv_timeout(Duration::from_secs(3)).is_ok(),
                "init blocked on a FIFO (uploads disabled: {disabled})"
            );
            assert!(
                tail(&log, None, TAIL_BYTES).is_none(),
                "a FIFO is not a log"
            );
        }
    }

    #[test]
    fn fingerprint_folds_numbers() {
        assert_eq!(
            fingerprint("t", "took 123 ms, 4 tries"),
            fingerprint("t", "took 9 ms, 77 tries")
        );
        assert_ne!(fingerprint("t", "a"), fingerprint("u", "a"));
        // Seen live: one retry warning per attempt, each with its own ids.
        assert_eq!(
            fingerprint(
                "u",
                "upload attempt failed; retrying file=~/s/hooks-activity-1795026411334556154-0.jsonl request_id=607541f010e04a7b8b9fed"
            ),
            fingerprint(
                "u",
                "upload attempt failed; retrying file=~/s/claude-03d689e9-35ed-48-1795026415345336098-0.jsonl request_id=6c47e6ba69784"
            )
        );
        assert_ne!(
            fingerprint("u", "upload failed"),
            fingerprint("u", "parking a batch")
        );
    }
}
