//! Backfill requests: what the CLI asks for in
//! `~/.failproofai/state/backfill-request.json`, and the cursor rewind and
//! first-sight windows that carry it out.
//!
//! Two commands write the file, and they want different things:
//!
//! * `failproofai backfill` (`kind: "user"`, or no `kind` at all, which is how
//!   every CLI before this wrote it) re-sends history the collector has already
//!   read past: forget the cursors of files modified at or after `sinceMs`, and
//!   widen the first-sight window to match.
//! * `failproofai config` (`kind: "added"`) is re-adding agents. Those may carry
//!   cursors from before they were deselected, and resuming them would ship
//!   whatever was written while nobody asked for it. So every one of their
//!   cursors is forgotten and the window is the default seven days: the agent
//!   behaves exactly like one traced for the first time.
//!
//! `agents` scopes either kind; without it a request reaches every SELECTED
//! agent, or every agent when there is no selection — which is how a request
//! from an older CLI is read.
//!
//! The pure decisions live here and are unit-tested; `main.rs` owns the timing
//! (a request is applied with no collector running) and the I/O around it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fpai_collect::AgentSelection;
use fpai_collect::cursor::CursorStore;

use crate::agents::{self, Owner};

/// How many days of history a source reads on FIRST sight of a file, unless a
/// request said otherwise. A machine holds hundreds of megabytes of transcripts,
/// and shipping all of it on first start is not a reasonable default.
pub const DEFAULT_WINDOW_DAYS: u64 = 7;

/// How long an `added` request stays actionable.
///
/// `config` writes one in the same run that adds the agents, against a daemon it
/// has just made sure is running, so a legitimate request is drained within
/// seconds. One that is older was written somewhere collection was not running —
/// an open-source machine — and acting on it at some later connect would rewind
/// agents on the strength of a choice made long ago, under a window that no
/// longer means what it did. A `user` request has no such bound: the CLI tells a
/// person whose daemon is stopped that the request "will be honoured" when it
/// starts.
pub const ADDED_REQUEST_MAX_AGE: Duration = Duration::from_secs(10 * 60);

/// The one agent whose nested cursor stores are not all extra paths: each Hermes
/// PROFILE is a database of its own, at `hermes/<profile>/`.
const HERMES: &str = "hermes";

/// What a request asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `failproofai backfill`: forget the cursors of files modified at or after
    /// `since`.
    User { since: SystemTime },
    /// `failproofai config` added these agents: forget every cursor they have.
    Added,
}

impl Kind {
    pub fn label(&self) -> &'static str {
        match self {
            Kind::User { .. } => "user",
            Kind::Added => "added",
        }
    }
}

/// A request that is valid and still actionable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub kind: Kind,
    /// The agents named, as written. `None` means every selected agent, or every
    /// agent when there is no selection.
    pub agents: Option<Vec<String>>,
}

/// Why a request was dropped without being acted on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Discarded {
    /// Not a request this daemon can act on; the reason says why.
    Unusable(String),
    /// An `added` request older than [`ADDED_REQUEST_MAX_AGE`].
    Stale { age: Duration },
}

impl std::fmt::Display for Discarded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Discarded::Unusable(why) => write!(f, "{why}"),
            Discarded::Stale { age } => write!(
                f,
                "it is an `added` request written {} minute(s) ago, and `failproofai config` \
                 writes those for the run that adds the agents; one this old was left where \
                 nothing was collecting, so it is dropped rather than replayed",
                age.as_secs() / 60
            ),
        }
    }
}

/// Read one request file's contents.
///
/// `now` is passed rather than read so the age check is testable.
pub fn parse(raw: &str, now: SystemTime) -> Result<Request, Discarded> {
    use serde_json::Value;

    let doc: Value = serde_json::from_str(raw)
        .map_err(|e| Discarded::Unusable(format!("it is not valid JSON: {e}")))?;
    let Some(obj) = doc.as_object() else {
        return Err(Discarded::Unusable("it is not a JSON object".into()));
    };

    let agents = match obj.get("agents") {
        None | Some(Value::Null) => None,
        // Dropped silently rather than refused, the way the selection itself is
        // read: a non-string can name no agent either way.
        Some(Value::Array(items)) => Some(distinct_names(items)),
        // Refused, NOT read as "absent": absent widens the request to every
        // selected agent, which is the opposite of what a list was meant to do.
        Some(_) => {
            return Err(Discarded::Unusable(
                "its `agents` value is not a list of agent ids".into(),
            ));
        }
    };

    let kind = match obj.get("kind") {
        // Every CLI before `kind` existed wrote a user request.
        None | Some(Value::Null) => "user",
        Some(Value::String(kind)) => kind.as_str(),
        Some(other) => {
            return Err(Discarded::Unusable(format!(
                "its kind {other} is not a string"
            )));
        }
    };
    let kind = match kind {
        "user" => match epoch_ms(obj.get("sinceMs")) {
            Some(since) => Kind::User { since },
            None => {
                return Err(Discarded::Unusable(
                    "it names no `sinceMs`, so there is no window to re-send".into(),
                ));
            }
        },
        "added" => {
            let Some(written) = epoch_ms(obj.get("requestedAtMs")) else {
                return Err(Discarded::Unusable(
                    "it is an `added` request with no `requestedAtMs`, so its age cannot be \
                     checked"
                        .into(),
                ));
            };
            // A timestamp ahead of this clock reads as written just now.
            let age = now.duration_since(written).unwrap_or(Duration::ZERO);
            if age > ADDED_REQUEST_MAX_AGE {
                return Err(Discarded::Stale { age });
            }
            Kind::Added
        }
        // Guessing would mean replaying a request with semantics this daemon has
        // never heard of — a newer CLI's, most likely.
        other => {
            return Err(Discarded::Unusable(format!(
                "its kind {other:?} is not one this daemon knows"
            )));
        }
    };

    Ok(Request { kind, agents })
}

/// Epoch milliseconds as a time. JavaScript writes them as plain integers; a
/// float is accepted too, since `JSON.stringify` is not the only possible writer.
fn epoch_ms(value: Option<&serde_json::Value>) -> Option<SystemTime> {
    let value = value?;
    let ms = value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f as u64)
    })?;
    Some(UNIX_EPOCH + Duration::from_millis(ms))
}

/// Strings only, blank ones dropped, repeats collapsed, order kept.
fn distinct_names(items: &[serde_json::Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in items.iter().filter_map(serde_json::Value::as_str) {
        if !name.trim().is_empty() && !out.iter().any(|kept| kept == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// Which agents a request reaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    /// Known agents, in table order.
    pub agents: Vec<&'static str>,
    /// Names the request gave that have no collector source. Ignored, and
    /// reported by the caller.
    pub unknown: Vec<String>,
    /// No `agents` in the request and no selection on the machine: the request
    /// means everything, as every request did before either existed. Only then
    /// does a rewind reach a top-level cursor directory this daemon does not
    /// recognise; a scoped request cannot say whose that directory is.
    pub unscoped: bool,
}

pub fn scope(request: &Request, selection: &AgentSelection) -> Scope {
    let known = agents::known_agents();
    match (&request.agents, &selection.selected) {
        // Named agents are taken as named, NOT intersected with the selection.
        // `config` writes its `added` request BEFORE it writes the selection that
        // ticks those agents — so the request cannot land after the agents
        // already resumed their stale cursors — which means that when it is read,
        // the agents it names are usually not selected yet. Filtering them out
        // would turn every re-add into a no-op.
        (Some(named), _) => Scope {
            agents: known
                .iter()
                .copied()
                .filter(|agent| named.iter().any(|n| n == agent))
                .collect(),
            unknown: named
                .iter()
                .filter(|n| !known.contains(&n.as_str()))
                .cloned()
                .collect(),
            unscoped: false,
        },
        // Unknown names in the selection are the collector's to report; it does
        // so on every build.
        (None, Some(selected)) => Scope {
            agents: known
                .iter()
                .copied()
                .filter(|agent| selected.iter().any(|s| s == agent))
                .collect(),
            unknown: Vec::new(),
            unscoped: false,
        },
        (None, None) => Scope {
            agents: known,
            unknown: Vec::new(),
            unscoped: true,
        },
    }
}

/// What one rewind changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Rewound {
    /// Cursors forgotten, across every store.
    pub cursors: usize,
    /// Stores that lost at least one cursor.
    pub stores: usize,
}

/// Forget cursors under `root` (`~/.failproofai/cursors`) as `kind` asks, for
/// the agents in `scope`.
///
/// * `User`: cursors of files modified at or after `since`, in each named
///   agent's top-level stores AND its nested extra-path stores
///   (`<source>/<label>/`). Hermes profile stores are left alone: a SQLite
///   cursor is one watermark for a whole database, so forgetting it re-sends the
///   database entire, not the window that was asked for. Which nested Hermes
///   stores are extra paths rather than profiles is `hermes_extra_labels`; any
///   other one is treated as a profile. The shared `hooks` store is rewound too.
/// * `Added`: every cursor of each named agent — top-level, extra-path and
///   Hermes profile stores alike. `hooks` is not touched: it is no agent's, and
///   rewinding it would re-send every CLI's decisions to re-add one.
///
/// A store is rewritten only when something was forgotten. Safe by construction
/// rather than by luck: re-reading is the documented recovery path for a damaged
/// store, and redaction is deterministic, so a re-shipped event hashes identically
/// and collapses into the row already on the server.
pub fn rewind(
    root: &Path,
    kind: Kind,
    scope: &Scope,
    hermes_extra_labels: &BTreeSet<String>,
) -> Rewound {
    let mut done = Rewound::default();
    let Ok(entries) = std::fs::read_dir(root) else {
        // No cursors yet means nothing has been shipped, so the next start reads
        // everything from the beginning anyway.
        return done;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        match agents::owner_of(&name) {
            Some(Owner::Shared) => {
                if matches!(kind, Kind::User { .. }) {
                    forget(&dir, kind, &mut done);
                }
            }
            Some(Owner::Agent(agent)) => {
                if !scope.agents.contains(&agent) {
                    continue;
                }
                forget(&dir, kind, &mut done);
                for nested in subdirectories(&dir) {
                    let profile_store = agent == HERMES
                        && !nested
                            .file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| hermes_extra_labels.contains(n));
                    if profile_store && matches!(kind, Kind::User { .. }) {
                        continue;
                    }
                    forget(&nested, kind, &mut done);
                }
            }
            // Left by another daemon version. Only a request that means
            // everything reaches it — top level only, exactly as before.
            None => {
                if scope.unscoped && matches!(kind, Kind::User { .. }) {
                    forget(&dir, kind, &mut done);
                }
            }
        }
    }
    done
}

fn subdirectories(dir: &Path) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    out.sort();
    out
}

fn forget(dir: &Path, kind: Kind, done: &mut Rewound) {
    let mut store = CursorStore::load(dir.to_path_buf());
    let n = match kind {
        Kind::User { since } => store.forget_modified_since(since),
        Kind::Added => store.forget_all(),
    };
    if n == 0 {
        return;
    }
    if let Err(err) = store.save() {
        tracing::warn!(dir = ?dir, ?err, "could not persist a rewound cursor store");
        return;
    }
    done.cursors += n;
    done.stores += 1;
}

/// The first-sight window each agent's file sources honour.
///
/// Per agent, where it used to be one process-wide value that any backfill set
/// and nothing reset. That leaked in two directions: `backfill --agents claude
/// --since 6m` also handed six months to every other source, whose
/// never-cursored files are re-tested on every poll; and an agent added after
/// any backfill inherited that backfill's window instead of seven days.
///
/// An agent keeps its window until a later request for THAT agent replaces it.
/// The collector reads a copy when it builds its tasks and each task keeps the
/// value it was built with, so a supervised restart cannot pick up a window that
/// was set for a different deployment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Windows {
    /// Agents with a non-default window. Absent means [`DEFAULT_WINDOW_DAYS`].
    days: BTreeMap<&'static str, u64>,
}

impl Windows {
    pub const fn new() -> Self {
        Windows {
            days: BTreeMap::new(),
        }
    }

    pub fn days_for(&self, agent: &str) -> u64 {
        self.days.get(agent).copied().unwrap_or(DEFAULT_WINDOW_DAYS)
    }

    /// Record what `kind` asks for, for `agents` only. Returns the window set.
    pub fn apply(&mut self, kind: Kind, agents: &[&'static str], now: SystemTime) -> u64 {
        match kind {
            Kind::User { since } => {
                let days = user_window_days(since, now);
                for agent in agents {
                    self.days.insert(agent, days);
                }
                days
            }
            Kind::Added => {
                for agent in agents {
                    self.days.remove(agent);
                }
                DEFAULT_WINDOW_DAYS
            }
        }
    }
}

/// The window a `user` request needs: every day back to `since`, plus one so a
/// file modified on the boundary day is inside it. Widening it is what makes the
/// rewind deliver: a forgotten cursor's file is a first discovery again, and a
/// file older than the window is refused without a cursor — so a backfill that
/// asked for thirty days would otherwise quietly deliver seven.
///
/// A `since` in the future reads as now, one day, rather than a window of zero
/// days that would refuse every file.
pub fn user_window_days(since: SystemTime, now: SystemTime) -> u64 {
    now.duration_since(since)
        .unwrap_or(Duration::ZERO)
        .as_secs()
        / 86_400
        + 1
}

/// The process's windows. Lives as long as the daemon, as the single value it
/// replaces did; a restart is back to the default for everyone.
static WINDOWS: Mutex<Windows> = Mutex::new(Windows::new());

/// A copy of the current windows, for one collector build.
pub fn current_windows() -> Windows {
    WINDOWS.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Apply a request to the process's windows. Returns the window set.
pub fn record_window(kind: Kind, agents: &[&'static str], now: SystemTime) -> u64 {
    WINDOWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .apply(kind, agents, now)
}

/// Take the request at `path`, if there is one.
///
/// Removed BEFORE it is acted on, valid or not. A backfill that panics mid-rewind
/// must not be retried on the next tick — the cursors it already forgot would be
/// forgotten again, and a machine could sit re-shipping its whole history in a
/// loop. An unusable request is deleted rather than retried for the same reason:
/// it cannot be acted on, and leaving it would repeat the same failure on every
/// tick forever. Losing a request costs one re-run of a command; looping does not
/// stop.
pub fn take(path: &Path, now: SystemTime) -> Option<Request> {
    let raw = std::fs::read_to_string(path).ok()?;
    let _ = std::fs::remove_file(path);
    match parse(&raw, now) {
        Ok(request) => Some(request),
        Err(why @ Discarded::Stale { .. }) => {
            tracing::warn!(reason = %why, "dropping a stale backfill request");
            None
        }
        Err(why) => {
            tracing::warn!(reason = %why, "discarding an unusable backfill request");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fpai_collect::cursor::FileCursor;
    use std::path::PathBuf;

    const DAY: Duration = Duration::from_secs(86_400);

    fn ms(t: SystemTime) -> u64 {
        t.duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "failproofaid-backfill-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn selection(ids: Option<&[&str]>) -> AgentSelection {
        AgentSelection {
            selected: ids.map(|ids| ids.iter().map(|s| s.to_string()).collect()),
            unusable: false,
        }
    }

    // ── parsing ─────────────────────────────────────────────────────────────

    #[test]
    fn a_request_from_an_older_cli_is_a_user_request_for_everything_selected() {
        let now = SystemTime::now();
        let since = now - 30 * DAY;
        let raw = format!(r#"{{"sinceMs":{},"requestedAtMs":{}}}"#, ms(since), ms(now));
        let request = parse(&raw, now).unwrap();
        // Millisecond precision on the way through the file.
        let since = UNIX_EPOCH + Duration::from_millis(ms(since));
        assert_eq!(request.kind, Kind::User { since });
        assert_eq!(request.agents, None);
    }

    #[test]
    fn a_scoped_added_request_parses() {
        let now = SystemTime::now();
        let raw = format!(
            r#"{{"sinceMs":{},"requestedAtMs":{},"agents":["goose","claude"],"kind":"added"}}"#,
            ms(now - 7 * DAY),
            ms(now)
        );
        let request = parse(&raw, now).unwrap();
        assert_eq!(request.kind, Kind::Added);
        assert_eq!(
            request.agents,
            Some(vec!["goose".to_string(), "claude".to_string()])
        );
    }

    #[test]
    fn a_stale_added_request_is_dropped_and_a_stale_user_request_is_honoured() {
        let now = SystemTime::now();
        let eleven_minutes_ago = now - Duration::from_secs(11 * 60);
        let added = format!(
            r#"{{"sinceMs":{},"requestedAtMs":{},"agents":["hermes"],"kind":"added"}}"#,
            ms(eleven_minutes_ago - 7 * DAY),
            ms(eleven_minutes_ago)
        );
        assert!(matches!(parse(&added, now), Err(Discarded::Stale { .. })));

        // A month-old `failproofai backfill`, waiting out a stopped daemon: the
        // CLI promised it "will be honoured", so its age is no reason to drop it.
        let a_month_ago = now - 30 * DAY;
        let user = format!(
            r#"{{"sinceMs":{},"requestedAtMs":{},"kind":"user"}}"#,
            ms(a_month_ago - 30 * DAY),
            ms(a_month_ago)
        );
        assert!(matches!(parse(&user, now).unwrap().kind, Kind::User { .. }));

        // ...and a fresh `added` request is acted on.
        let nine_minutes_ago = now - Duration::from_secs(9 * 60);
        let fresh = format!(
            r#"{{"sinceMs":0,"requestedAtMs":{},"agents":["hermes"],"kind":"added"}}"#,
            ms(nine_minutes_ago)
        );
        assert_eq!(parse(&fresh, now).unwrap().kind, Kind::Added);
    }

    #[test]
    fn an_added_request_with_no_timestamp_cannot_prove_it_is_fresh() {
        let raw = r#"{"sinceMs":0,"agents":["codex"],"kind":"added"}"#;
        assert!(matches!(
            parse(raw, SystemTime::now()),
            Err(Discarded::Unusable(_))
        ));
    }

    #[test]
    fn requests_this_daemon_cannot_act_on_are_refused_rather_than_guessed_at() {
        let now = SystemTime::now();
        for raw in [
            "{not json",
            "[1,2]",
            // A newer CLI's kind: its semantics are unknown here.
            r#"{"sinceMs":1,"requestedAtMs":1,"kind":"rewrite"}"#,
            r#"{"sinceMs":1,"requestedAtMs":1,"kind":7}"#,
            // A string is not a list; reading it as "absent" would widen the
            // request to every agent.
            r#"{"sinceMs":1,"requestedAtMs":1,"agents":"claude"}"#,
            // A user request without a window.
            r#"{"requestedAtMs":1,"kind":"user"}"#,
        ] {
            assert!(
                matches!(parse(raw, now), Err(Discarded::Unusable(_))),
                "accepted {raw}"
            );
        }
    }

    #[test]
    fn agent_names_are_read_the_way_the_selection_is() {
        let raw = r#"{"sinceMs":1,"agents":["claude",5,"","claude","codex"]}"#;
        assert_eq!(
            parse(raw, SystemTime::now()).unwrap().agents,
            Some(vec!["claude".to_string(), "codex".to_string()])
        );
    }

    #[test]
    fn taking_a_request_removes_it_whether_or_not_it_is_acted_on() {
        let dir = scratch("take");
        let path = dir.join("backfill-request.json");
        let now = SystemTime::now();

        std::fs::write(&path, format!(r#"{{"sinceMs":{}}}"#, ms(now - DAY))).unwrap();
        assert!(take(&path, now).is_some());
        assert!(!path.exists(), "an honoured request must not be replayed");

        let old = now - Duration::from_secs(3600);
        std::fs::write(
            &path,
            format!(r#"{{"requestedAtMs":{},"kind":"added"}}"#, ms(old)),
        )
        .unwrap();
        assert!(
            take(&path, now).is_none(),
            "a stale added request is dropped"
        );
        assert!(!path.exists(), "a dropped request must not be retried");

        assert!(take(&path, now).is_none(), "no file, no request");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── scope ───────────────────────────────────────────────────────────────

    #[test]
    fn a_request_without_agents_reaches_the_selected_agents_only() {
        let request = Request {
            kind: Kind::Added,
            agents: None,
        };
        let s = scope(&request, &selection(Some(&["hermes", "claude", "claud"])));
        assert_eq!(s.agents, ["claude", "hermes"], "known agents, table order");
        assert!(!s.unscoped);

        let everything = scope(&request, &selection(None));
        assert_eq!(everything.agents, agents::known_agents());
        assert!(everything.unscoped);
    }

    #[test]
    fn named_agents_win_over_the_selection_and_unknown_names_are_reported() {
        let request = Request {
            kind: Kind::Added,
            agents: Some(vec!["codex".into(), "codx".into()]),
        };
        let s = scope(&request, &selection(Some(&["claude"])));
        assert_eq!(s.agents, ["codex"]);
        assert_eq!(s.unknown, ["codx"]);
        assert!(!s.unscoped);
    }

    // ── windows ─────────────────────────────────────────────────────────────

    #[test]
    fn every_agent_starts_on_the_default_window() {
        let w = Windows::new();
        for agent in agents::known_agents() {
            assert_eq!(w.days_for(agent), DEFAULT_WINDOW_DAYS);
        }
    }

    #[test]
    fn a_scoped_user_backfill_does_not_widen_another_agents_window() {
        let now = SystemTime::now();
        let mut w = Windows::new();
        let days = w.apply(
            Kind::User {
                since: now - 180 * DAY,
            },
            &["claude"],
            now,
        );
        assert_eq!(days, 181);
        assert_eq!(w.days_for("claude"), 181);
        // The leak this replaces: one process-wide value gave codex six months
        // of its never-cursored files too.
        assert_eq!(w.days_for("codex"), DEFAULT_WINDOW_DAYS);
        assert_eq!(w.days_for("hermes"), DEFAULT_WINDOW_DAYS);
    }

    #[test]
    fn an_agent_added_after_a_30_day_backfill_still_gets_7_days() {
        let now = SystemTime::now();
        let mut w = Windows::new();
        // `failproofai backfill --since 30d` with no selection: every agent.
        w.apply(
            Kind::User {
                since: now - 30 * DAY,
            },
            &agents::known_agents(),
            now,
        );
        assert_eq!(w.days_for("goose"), 31);

        // Later, `config` re-adds goose: it must behave like a new agent, not
        // inherit the backfill's month.
        assert_eq!(w.apply(Kind::Added, &["goose"], now), DEFAULT_WINDOW_DAYS);
        assert_eq!(w.days_for("goose"), DEFAULT_WINDOW_DAYS);
        // ...and only goose: an agent keeps its window until a request for IT
        // replaces it.
        assert_eq!(w.days_for("claude"), 31);

        // An agent that was never named by any request is on the default.
        let mut fresh = Windows::new();
        fresh.apply(
            Kind::User {
                since: now - 30 * DAY,
            },
            &["claude"],
            now,
        );
        assert_eq!(fresh.days_for("goose"), DEFAULT_WINDOW_DAYS);
    }

    #[test]
    fn the_user_window_covers_back_to_since_plus_the_boundary_day() {
        let now = SystemTime::now();
        assert_eq!(user_window_days(now - 30 * DAY, now), 31);
        assert_eq!(user_window_days(now - Duration::from_secs(60), now), 1);
        assert_eq!(
            user_window_days(now + DAY, now),
            1,
            "a future since is a one-day window, not a zero-day one"
        );
    }

    // ── rewind ──────────────────────────────────────────────────────────────

    /// A session file whose mtime is `age` ago.
    fn file_aged(dir: &Path, name: &str, age: Duration) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "x").unwrap();
        let f = std::fs::File::options().write(true).open(&path).unwrap();
        f.set_modified(SystemTime::now() - age).unwrap();
        path
    }

    /// A cursor store at `dir` holding one cursor per file.
    fn store(dir: &Path, files: &[&Path]) {
        let mut s = CursorStore::load(dir.to_path_buf());
        for (i, f) in files.iter().enumerate() {
            s.set(FileCursor {
                path: f.to_path_buf(),
                dev: 1,
                inode: i as u64 + 1,
                offset: 1,
                size_seen: 1,
                ..Default::default()
            });
        }
        s.save().unwrap();
    }

    fn count(dir: &Path) -> usize {
        CursorStore::load(dir.to_path_buf()).len()
    }

    /// Every kind of store the collector writes, each holding one cursor for a
    /// file touched an hour ago and one for a file untouched for 60 days.
    struct Layout {
        root: PathBuf,
        files: PathBuf,
    }

    impl Layout {
        const STORES: &[&str] = &[
            "claude",
            "claude/work",
            "claude-subagent",
            "claude-subagent/work",
            "codex",
            "codex/box",
            "openclaw",
            "openclaw-sqlite",
            "openclaw-sqlite/lab",
            // Hermes has no top-level store: the root database is `-hermes`, a
            // named profile `prod`, and `team` is a configured extra path.
            "hermes/-hermes",
            "hermes/prod",
            "hermes/team",
            "hooks",
            // Left by another daemon version.
            "some-future-source",
        ];

        fn new(name: &str) -> Self {
            let base = scratch(name);
            let root = base.join("cursors");
            let files = base.join("files");
            std::fs::create_dir_all(&files).unwrap();
            for (i, rel) in Self::STORES.iter().enumerate() {
                let fresh = file_aged(&files, &format!("fresh-{i}"), Duration::from_secs(3600));
                let old = file_aged(&files, &format!("old-{i}"), 60 * DAY);
                store(&root.join(rel), &[&fresh, &old]);
            }
            Layout { root, files }
        }

        fn count(&self, rel: &str) -> usize {
            count(&self.root.join(rel))
        }
    }

    impl Drop for Layout {
        fn drop(&mut self) {
            if let Some(base) = self.files.parent() {
                std::fs::remove_dir_all(base).ok();
            }
        }
    }

    fn hermes_extras() -> BTreeSet<String> {
        BTreeSet::from(["team".to_string()])
    }

    #[test]
    fn a_user_rewind_follows_the_table_into_nested_stores_but_not_hermes_profiles() {
        let layout = Layout::new("user");
        let since = SystemTime::now() - DAY;
        let request = Request {
            kind: Kind::User { since },
            agents: Some(vec!["claude".into(), "openclaw".into(), "hermes".into()]),
        };
        let s = scope(&request, &selection(None));
        let done = rewind(&layout.root, request.kind, &s, &hermes_extras());

        // `claude` reaches `claude-subagent`; `openclaw` reaches
        // `openclaw-sqlite` — and each one's extra-path store, which the
        // top-level-only rewind never reached. Only the fresh file's cursor goes.
        for rewound in [
            "claude",
            "claude/work",
            "claude-subagent",
            "claude-subagent/work",
            "openclaw",
            "openclaw-sqlite",
            "openclaw-sqlite/lab",
            "hermes/team",
        ] {
            assert_eq!(layout.count(rewound), 1, "{rewound} was not rewound");
        }
        // A profile cursor is one watermark for a whole database; forgetting it
        // re-sends all of it, not the window. User requests leave profiles be.
        assert_eq!(layout.count("hermes/-hermes"), 2);
        assert_eq!(layout.count("hermes/prod"), 2);
        // The shared hook store goes with every user request, as it always has.
        assert_eq!(layout.count("hooks"), 1);
        // Not named.
        assert_eq!(layout.count("codex"), 2);
        assert_eq!(layout.count("codex/box"), 2);
        // A scoped request cannot say whose an unrecognised directory is.
        assert_eq!(layout.count("some-future-source"), 2);

        assert_eq!(done.stores, 9);
        assert_eq!(done.cursors, 9);
    }

    #[test]
    fn an_unscoped_user_rewind_still_reaches_what_it_always_did() {
        let layout = Layout::new("unscoped");
        let request = Request {
            kind: Kind::User {
                since: SystemTime::now() - DAY,
            },
            agents: None,
        };
        let s = scope(&request, &selection(None));
        assert!(s.unscoped);
        rewind(&layout.root, request.kind, &s, &hermes_extras());

        assert_eq!(layout.count("codex"), 1);
        assert_eq!(layout.count("codex/box"), 1);
        assert_eq!(layout.count("hooks"), 1);
        // Everything, as before scoping existed — top level only.
        assert_eq!(layout.count("some-future-source"), 1);
        // Still never a profile.
        assert_eq!(layout.count("hermes/prod"), 2);
    }

    #[test]
    fn a_request_with_no_agents_and_no_kind_rewinds_the_selected_agents() {
        let layout = Layout::new("legacy");
        let now = SystemTime::now();
        let raw = format!(
            r#"{{"sinceMs":{},"requestedAtMs":{}}}"#,
            ms(now - DAY),
            ms(now)
        );
        let request = parse(&raw, now).unwrap();
        let s = scope(&request, &selection(Some(&["claude", "hermes"])));
        rewind(&layout.root, request.kind, &s, &hermes_extras());

        assert_eq!(layout.count("claude"), 1);
        assert_eq!(layout.count("claude-subagent/work"), 1);
        assert_eq!(layout.count("hermes/team"), 1);
        assert_eq!(layout.count("hooks"), 1);
        // Not selected, so not reached — even though the request named nothing.
        assert_eq!(layout.count("codex"), 2);
        assert_eq!(layout.count("openclaw-sqlite"), 2);
        assert_eq!(layout.count("some-future-source"), 2);

        // And only the selected agents' windows move.
        let mut w = Windows::new();
        w.apply(request.kind, &s.agents, now);
        assert_eq!(w.days_for("claude"), 2);
        assert_eq!(w.days_for("hermes"), 2);
        assert_eq!(w.days_for("codex"), DEFAULT_WINDOW_DAYS);
    }

    #[test]
    fn an_added_request_forgets_every_cursor_of_its_agents_and_leaves_hooks_alone() {
        let layout = Layout::new("added");
        let request = Request {
            kind: Kind::Added,
            agents: Some(vec!["hermes".into(), "codex".into()]),
        };
        let s = scope(&request, &selection(Some(&["claude", "codex", "hermes"])));
        let done = rewind(&layout.root, request.kind, &s, &hermes_extras());

        // Old files too: a cursor last advanced before any window still resumes
        // mid-file, shipping what was written while the agent was not traced.
        for forgotten in [
            "codex",
            "codex/box",
            "hermes/-hermes",
            "hermes/prod",
            "hermes/team",
        ] {
            assert_eq!(layout.count(forgotten), 0, "{forgotten} kept a cursor");
        }
        assert_eq!(
            layout.count("hooks"),
            2,
            "re-adding agents re-sends no decisions"
        );
        assert_eq!(layout.count("claude"), 2);
        assert_eq!(layout.count("openclaw-sqlite/lab"), 2);
        assert_eq!(layout.count("some-future-source"), 2);
        assert_eq!(done.stores, 5);
        assert_eq!(done.cursors, 10);

        let mut w = Windows::new();
        w.apply(
            Kind::User {
                since: SystemTime::now() - 90 * DAY,
            },
            &s.agents,
            SystemTime::now(),
        );
        assert_eq!(
            w.apply(request.kind, &s.agents, SystemTime::now()),
            DEFAULT_WINDOW_DAYS
        );
        assert_eq!(w.days_for("hermes"), DEFAULT_WINDOW_DAYS);
        assert_eq!(w.days_for("codex"), DEFAULT_WINDOW_DAYS);
    }

    #[test]
    fn a_rewind_of_an_empty_or_missing_root_changes_nothing() {
        let base = scratch("missing");
        let request = Request {
            kind: Kind::Added,
            agents: None,
        };
        let s = scope(&request, &selection(None));
        assert_eq!(
            rewind(&base.join("cursors"), request.kind, &s, &BTreeSet::new()),
            Rewound::default()
        );
        std::fs::remove_dir_all(&base).ok();
    }
}
