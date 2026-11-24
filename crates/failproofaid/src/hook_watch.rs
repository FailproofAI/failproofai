//! Says so, as an ERROR in `daemon.log`, when hook data stops reaching Cloud
//! while the rest of the collector keeps working.
//!
//! Hook data takes its own route. The worker answers each hook and writes an
//! activity row; the `hook-activity` source turns rows into events and spools
//! them as `hooks-*.jsonl` batches; the uploader sends those with every other
//! source's batches. Transcripts take a different route to the same uploader.
//! So the collector can look healthy, transcripts arriving and delivery
//! green, while not one policy check reaches Cloud: the activity store is
//! unwritable, the source reads the wrong directory, or Cloud refuses the hook
//! batches alone. Nothing on the machine said so.
//!
//! Every [`CHECK_EVERY`] this compares three things against the last check:
//!
//! - **Collected.** Hook calls the socket server answered ([`note_answered`])
//!   against events the `hook-activity` source produced. Calls answered in two
//!   checks running, with no events from the source in either, is
//!   [`Problem::NotCollected`]. Two, so one slow poll is not an alarm.
//! - **Delivered.** A `hooks-*` batch waiting in the spool for longer than
//!   [`STALE_AFTER`] while the uploader has delivered something within it is
//!   [`Problem::NotDelivered`]: delivery works, hook batches are not going.
//! - **Refused.** More `hooks-*` batches parked in `failed/` than at the last
//!   check is [`Problem::Refused`].
//! - **Hooked.** Per agent: tool calls its transcripts show it making now
//!   (`live_tool_calls` in collector health, counted at the spool, so a
//!   backfill re-reading last week does not count) against hook calls that
//!   agent made. Tool calls across two checks running with no hook call from
//!   it in either is [`Problem::NotHooked`]: the agent is working, its
//!   sessions are being collected, and its hooks are not firing. That is how a
//!   config whose schema changed under it, a plugin that failed to load or a
//!   project with hooks turned off looks from here, and every one of those
//!   tool calls ran unchecked.
//!
//! Each is logged at ERROR when it starts and again every [`REPEAT_EVERY`]
//! while it lasts, so logship's error roll-up carries it to Cloud, and at INFO
//! once when it clears. Health probes are not hook calls and are not counted.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How often the counters are compared.
pub const CHECK_EVERY: Duration = Duration::from_secs(5 * 60);
/// How long a hook batch may wait in the spool while other batches deliver.
pub const STALE_AFTER: Duration = Duration::from_secs(15 * 60);
/// How often a problem that persists is logged again.
pub const REPEAT_EVERY: Duration = Duration::from_secs(60 * 60);
/// Fewer answered calls than this in a check are not evidence of anything.
const MIN_ANSWERED: u64 = 5;
/// Fewer live tool calls than this across two checks prove no hook is missing.
const MIN_TOOL_CALLS: u64 = 3;

/// Hook calls the socket server answered with a verdict, since start.
static ANSWERED: AtomicU64 = AtomicU64::new(0);
/// The same, per agent (the request's `cli` / `integration`).
static ANSWERED_BY: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());

/// Count one answered hook call from `agent`. Not a health probe: the worker
/// writes no activity row for one, so counting it would report a gap that is
/// not there.
pub fn note_answered(agent: &str, stdin: &str) {
    if stdin.contains("failproofai-health-probe") {
        return;
    }
    ANSWERED.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut by) = ANSWERED_BY.lock() {
        *by.entry(agent.to_string()).or_default() += 1;
    }
}

/// One agent's counters, both since start.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentCounts {
    /// Live tool calls its transcripts showed.
    pub tool_calls: u64,
    /// Hook calls it made that the daemon answered.
    pub answered: u64,
}

/// What one check reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Sample {
    /// Unix seconds.
    pub now: u64,
    /// Hook calls answered since start.
    pub answered: u64,
    /// Events the `hook-activity` source produced since it started.
    pub hook_events: u64,
    /// The source's last poll error, if its last poll failed.
    pub hook_error: Option<String>,
    /// Unix seconds of the last upload Cloud accepted; 0 for none.
    pub delivered_at: u64,
    /// `hooks-*` batches waiting in the spool, and the oldest one's age.
    pub waiting: usize,
    pub oldest_waiting_secs: u64,
    /// `hooks-*` batches parked in `failed/`.
    pub parked: usize,
    /// Per traced agent.
    pub agents: BTreeMap<String, AgentCounts>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Kind {
    NotCollected,
    NotDelivered,
    Refused,
    NotHooked(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    NotCollected {
        answered: u64,
        minutes: u64,
        error: Option<String>,
    },
    NotDelivered {
        waiting: usize,
        minutes: u64,
    },
    Refused {
        new: usize,
        parked: usize,
    },
    NotHooked {
        agent: String,
        tool_calls: u64,
        minutes: u64,
    },
}

impl Problem {
    pub fn kind(&self) -> Kind {
        match self {
            Problem::NotCollected { .. } => Kind::NotCollected,
            Problem::NotDelivered { .. } => Kind::NotDelivered,
            Problem::Refused { .. } => Kind::Refused,
            Problem::NotHooked { agent, .. } => Kind::NotHooked(agent.clone()),
        }
    }

    /// The `daemon.log` line.
    pub fn line(&self) -> String {
        match self {
            Problem::NotCollected {
                answered,
                minutes,
                error,
            } => {
                let mut line = format!(
                    "hook checks are not reaching Cloud: {answered} hook calls answered in the last \
                     {minutes} minutes, none recorded by the hook activity source"
                );
                if let Some(error) = error {
                    line.push_str(&format!(" (last error: {error})"));
                }
                line
            }
            Problem::NotDelivered { waiting, minutes } => format!(
                "hook checks are not reaching Cloud: {waiting} hook batches have waited \
                 {minutes} minutes while other events deliver"
            ),
            Problem::Refused { new, parked } => format!(
                "hook checks are not reaching Cloud: Cloud refused {new} hook batches \
                 ({parked} parked in failed/)"
            ),
            Problem::NotHooked {
                agent,
                tool_calls,
                minutes,
            } => format!(
                "{agent}: {tool_calls} tool calls in the last {minutes} minutes and none reached \
                 failproofai's hooks, so they ran unchecked: its hooks are not installed or not firing"
            ),
        }
    }
}

/// What a check decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Log at ERROR.
    Raise(Problem),
    /// Was raised, is over: log at INFO.
    Cleared(Kind),
}

/// The state between checks.
#[derive(Debug, Default)]
pub struct Watch {
    prev: Option<Sample>,
    /// Checks running in which calls were answered and the source produced nothing.
    quiet_checks: u32,
    /// Answered calls across those checks.
    quiet_answered: u64,
    /// When each active problem was last logged (Unix seconds).
    raised: Vec<(Kind, u64)>,
    /// Each agent's (tool calls, answered) in the previous check.
    last_agent_deltas: BTreeMap<String, (u64, u64)>,
}

impl Watch {
    pub fn check(&mut self, s: Sample) -> Vec<Verdict> {
        let Some(prev) = self.prev.replace(s.clone()) else {
            return Vec::new(); // the first check is the baseline
        };
        let mut found: Vec<Problem> = Vec::new();

        let answered = s.answered.saturating_sub(prev.answered);
        let produced = s.hook_events.saturating_sub(prev.hook_events);
        if produced > 0 || answered < MIN_ANSWERED {
            self.quiet_checks = 0;
            self.quiet_answered = 0;
        } else {
            self.quiet_checks += 1;
            self.quiet_answered += answered;
        }
        if self.quiet_checks >= 2 {
            found.push(Problem::NotCollected {
                answered: self.quiet_answered,
                minutes: u64::from(self.quiet_checks) * CHECK_EVERY.as_secs() / 60,
                error: s.hook_error.clone(),
            });
        }

        let others_deliver =
            s.delivered_at > 0 && s.now.saturating_sub(s.delivered_at) < STALE_AFTER.as_secs();
        if s.waiting > 0 && s.oldest_waiting_secs >= STALE_AFTER.as_secs() && others_deliver {
            found.push(Problem::NotDelivered {
                waiting: s.waiting,
                minutes: s.oldest_waiting_secs / 60,
            });
        }

        let mut deltas = BTreeMap::new();
        for (agent, now) in &s.agents {
            let before = prev.agents.get(agent).copied().unwrap_or_default();
            let tools = now.tool_calls.saturating_sub(before.tool_calls);
            let answered = now.answered.saturating_sub(before.answered);
            let (prev_tools, prev_answered) =
                self.last_agent_deltas.get(agent).copied().unwrap_or((0, 0));
            // Two checks, so a tool call spooled just before its hook is
            // counted (hooks fire before the call, transcripts after) cannot
            // look like a missing hook.
            if self.last_agent_deltas.contains_key(agent)
                && tools > 0
                && tools + prev_tools >= MIN_TOOL_CALLS
                && answered + prev_answered == 0
            {
                found.push(Problem::NotHooked {
                    agent: agent.clone(),
                    tool_calls: tools + prev_tools,
                    minutes: 2 * CHECK_EVERY.as_secs() / 60,
                });
            }
            deltas.insert(agent.clone(), (tools, answered));
        }
        self.last_agent_deltas = deltas;

        let refused = s.parked > prev.parked;
        if refused {
            found.push(Problem::Refused {
                new: s.parked - prev.parked,
                parked: s.parked,
            });
        }

        let mut out = Vec::new();
        // Cleared only on evidence that it is fixed, never because it was not
        // found again: falling traffic stops a problem being detected without
        // fixing it. A refusal is an event, not a state, so it never clears.
        let now_kinds: Vec<Kind> = found.iter().map(Problem::kind).collect();
        let stuck = s.waiting > 0 && s.oldest_waiting_secs >= STALE_AFTER.as_secs();
        let deltas = &self.last_agent_deltas;
        self.raised.retain(|(kind, _)| {
            let fixed = !now_kinds.contains(kind)
                && match kind {
                    // The hook activity source produced events.
                    Kind::NotCollected => produced > 0,
                    // The stuck hook batch is gone.
                    Kind::NotDelivered => !stuck,
                    // A hook call from that agent was answered.
                    Kind::NotHooked(agent) => deltas.get(agent).is_some_and(|(_, a)| *a > 0),
                    Kind::Refused => false,
                };
            if fixed {
                out.push(Verdict::Cleared(kind.clone()));
            }
            !fixed
        });
        for problem in found {
            let kind = problem.kind();
            match self.raised.iter_mut().find(|(k, _)| *k == kind) {
                Some((_, at))
                    if kind != Kind::Refused
                        && s.now.saturating_sub(*at) < REPEAT_EVERY.as_secs() => {}
                Some((_, at)) => {
                    *at = s.now;
                    out.push(Verdict::Raise(problem));
                }
                None => {
                    self.raised.push((kind, s.now));
                    out.push(Verdict::Raise(problem));
                }
            }
        }
        out
    }
}

/// `hooks-*` batch files in `dir`, and the oldest one's age in seconds.
fn hook_batches(dir: &Path, now: SystemTime) -> (usize, u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut count = 0;
    let mut oldest = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("hooks-") && name.contains(".jsonl")) {
            continue;
        }
        count += 1;
        let age = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .map_or(0, |d| d.as_secs());
        oldest = oldest.max(age);
    }
    (count, oldest)
}

fn sample(health: &fpai_collect::Health, spool_dir: &Path, failed_dir: &Path) -> Sample {
    let snapshot = health.snapshot();
    let hooks = snapshot.sources.get("hooks");
    let now = SystemTime::now();
    let (waiting, oldest_waiting_secs) = hook_batches(spool_dir, now);
    // Only finished batches wait: a `.tmp` is still being written.
    let (parked, _) = hook_batches(failed_dir, now);
    let mut agents: BTreeMap<String, AgentCounts> = BTreeMap::new();
    for (source, h) in &snapshot.sources {
        // `hermes:<label>` and the like: the source before the colon names it.
        let base = source.split(':').next().unwrap_or(source);
        if let Some(crate::agents::Owner::Agent(agent)) = crate::agents::owner_of(base) {
            agents.entry(agent.to_string()).or_default().tool_calls += h.live_tool_calls;
        }
    }
    if let Ok(by) = ANSWERED_BY.lock() {
        for (agent, counts) in agents.iter_mut() {
            counts.answered = by.get(agent).copied().unwrap_or(0);
        }
    }
    Sample {
        now: now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()),
        answered: ANSWERED.load(Ordering::Relaxed),
        hook_events: hooks.map_or(0, |h| h.events),
        hook_error: hooks.and_then(|h| h.last_error.clone()),
        delivered_at: snapshot.delivery.map_or(0, |d| d.last_ok_ts),
        waiting,
        oldest_waiting_secs,
        parked,
        agents,
    }
}

/// The watch, as a collector task. Started only when hook collection is on.
pub async fn run(
    health: Arc<fpai_collect::Health>,
    spool_dir: PathBuf,
    failed_dir: PathBuf,
    sd: fpai_collect::supervisor::Shutdown,
) -> Result<(), fpai_collect::supervisor::TaskError> {
    let mut watch = Watch::default();
    // Tests only: a shorter pause between checks, like the collector's
    // FAILPROOFAI_COLLECTOR_CONFIG_POLL_MS. The minutes in each line still
    // assume CHECK_EVERY.
    let every = std::env::var("FAILPROOFAI_HOOK_WATCH_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map_or(CHECK_EVERY, Duration::from_millis);
    loop {
        for verdict in watch.check(sample(&health, &spool_dir, &failed_dir)) {
            match verdict {
                Verdict::Raise(problem) => tracing::error!("{}", problem.line()),
                Verdict::Cleared(Kind::NotCollected) => {
                    tracing::info!("hook checks are being recorded again")
                }
                Verdict::Cleared(Kind::NotDelivered) => {
                    tracing::info!("hook checks are being delivered again")
                }
                Verdict::Cleared(Kind::NotHooked(agent)) => {
                    tracing::info!("{agent}: tool calls are reaching failproofai's hooks again")
                }
                Verdict::Cleared(Kind::Refused) => {}
            }
        }
        if !sd.sleep(every).await {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_800_000_000;
    const STEP: u64 = 300;

    fn at(n: u64) -> Sample {
        Sample {
            now: T0 + n * STEP,
            delivered_at: T0 + n * STEP - 10,
            ..Sample::default()
        }
    }

    fn raised(v: &[Verdict]) -> Vec<Kind> {
        v.iter()
            .filter_map(|v| match v {
                Verdict::Raise(p) => Some(p.kind()),
                Verdict::Cleared(_) => None,
            })
            .collect()
    }

    #[test]
    fn calls_answered_with_nothing_recorded_for_two_checks_is_an_error() {
        let mut w = Watch::default();
        assert!(w.check(at(0)).is_empty(), "baseline");
        let one = w.check(Sample {
            answered: 20,
            ..at(1)
        });
        assert!(one.is_empty(), "one quiet check is not enough: {one:?}");
        let two = w.check(Sample {
            answered: 40,
            ..at(2)
        });
        assert_eq!(
            two,
            vec![Verdict::Raise(Problem::NotCollected {
                answered: 40,
                minutes: 10,
                error: None
            })]
        );
        assert_eq!(
            Problem::NotCollected {
                answered: 40,
                minutes: 10,
                error: Some("permission denied".into())
            }
            .line(),
            "hook checks are not reaching Cloud: 40 hook calls answered in the last 10 minutes, \
             none recorded by the hook activity source (last error: permission denied)"
        );
    }

    #[test]
    fn events_from_the_source_or_too_few_calls_are_not_an_error() {
        let mut w = Watch::default();
        w.check(at(0));
        // Calls answered and events produced: healthy.
        assert!(
            w.check(Sample {
                answered: 20,
                hook_events: 15,
                ..at(1)
            })
            .is_empty()
        );
        assert!(
            w.check(Sample {
                answered: 40,
                hook_events: 30,
                ..at(2)
            })
            .is_empty()
        );
        // A machine where hardly anything runs proves nothing either way.
        assert!(
            w.check(Sample {
                answered: 42,
                hook_events: 30,
                ..at(3)
            })
            .is_empty()
        );
        assert!(
            w.check(Sample {
                answered: 44,
                hook_events: 30,
                ..at(4)
            })
            .is_empty()
        );
    }

    #[test]
    fn a_persisting_problem_is_repeated_hourly_and_its_end_is_logged_once() {
        let mut w = Watch::default();
        w.check(at(0));
        w.check(Sample {
            answered: 10,
            ..at(1)
        });
        assert_eq!(
            raised(&w.check(Sample {
                answered: 20,
                ..at(2)
            })),
            vec![Kind::NotCollected]
        );
        // Still broken, inside the hour: quiet.
        for n in 3..14 {
            assert!(
                w.check(Sample {
                    answered: 10 * n,
                    ..at(n)
                })
                .is_empty(),
                "check {n}"
            );
        }
        // An hour after it was raised: once more.
        assert_eq!(
            raised(&w.check(Sample {
                answered: 140,
                ..at(14)
            })),
            vec![Kind::NotCollected]
        );
        // Events again: cleared, once.
        assert_eq!(
            w.check(Sample {
                answered: 150,
                hook_events: 5,
                ..at(15)
            }),
            vec![Verdict::Cleared(Kind::NotCollected)]
        );
        assert!(
            w.check(Sample {
                answered: 160,
                hook_events: 10,
                ..at(16)
            })
            .is_empty()
        );
    }

    #[test]
    fn a_hook_batch_stuck_while_other_batches_deliver_is_an_error() {
        let mut w = Watch::default();
        w.check(at(0));
        let stuck = Sample {
            waiting: 3,
            oldest_waiting_secs: 16 * 60,
            ..at(1)
        };
        assert_eq!(
            w.check(stuck.clone()),
            vec![Verdict::Raise(Problem::NotDelivered {
                waiting: 3,
                minutes: 16
            })]
        );
        assert_eq!(
            Problem::NotDelivered {
                waiting: 3,
                minutes: 16
            }
            .line(),
            "hook checks are not reaching Cloud: 3 hook batches have waited 16 minutes \
             while other events deliver"
        );
        // Drained: cleared.
        assert_eq!(w.check(at(2)), vec![Verdict::Cleared(Kind::NotDelivered)]);
    }

    #[test]
    fn a_stuck_hook_batch_during_an_outage_is_not_a_hook_problem() {
        let mut w = Watch::default();
        w.check(at(0));
        // Nothing delivered for an hour: everything is stuck, which status
        // already reports. Not a hook-route problem.
        let outage = Sample {
            waiting: 3,
            oldest_waiting_secs: 60 * 60,
            delivered_at: T0 - 3600,
            ..at(1)
        };
        assert!(w.check(outage).is_empty());
        // A young batch is just waiting its turn.
        assert!(
            w.check(Sample {
                waiting: 1,
                oldest_waiting_secs: 60,
                ..at(2)
            })
            .is_empty()
        );
    }

    #[test]
    fn every_newly_refused_hook_batch_is_an_error_and_old_ones_are_not_repeated() {
        let mut w = Watch::default();
        w.check(Sample { parked: 1, ..at(0) });
        assert!(
            w.check(Sample { parked: 1, ..at(1) }).is_empty(),
            "already parked at start"
        );
        assert_eq!(
            w.check(Sample { parked: 3, ..at(2) }),
            vec![Verdict::Raise(Problem::Refused { new: 2, parked: 3 })]
        );
        assert!(w.check(Sample { parked: 3, ..at(3) }).is_empty());
        assert_eq!(
            raised(&w.check(Sample { parked: 4, ..at(4) })),
            vec![Kind::Refused]
        );
    }

    #[test]
    fn hook_batches_are_counted_by_their_prefix_and_aged_by_mtime() {
        let dir = std::env::temp_dir().join(format!("fpai-hook-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "hooks-a-1-0.jsonl",
            "hooks-a-1-1.a3.jsonl.poison",
            "hooks-a-1-2.tmp",
            "claude-a-1-0.jsonl",
        ] {
            std::fs::write(dir.join(name), "{}\n").unwrap();
        }
        let later = SystemTime::now() + Duration::from_secs(120);
        let (count, oldest) = hook_batches(&dir, later);
        assert_eq!(
            count, 2,
            "only hooks-* .jsonl batches, parked ones included"
        );
        assert!((119..=125).contains(&oldest), "{oldest}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn agent(tool_calls: u64, answered: u64) -> AgentCounts {
        AgentCounts {
            tool_calls,
            answered,
        }
    }

    fn with(n: u64, agents: &[(&str, AgentCounts)]) -> Sample {
        Sample {
            agents: agents.iter().map(|(a, c)| (a.to_string(), *c)).collect(),
            ..at(n)
        }
    }

    #[test]
    fn an_agent_working_with_no_hook_calls_for_two_checks_is_an_error() {
        let mut w = Watch::default();
        w.check(with(0, &[("codex", agent(0, 0)), ("claude", agent(0, 0))]));
        // Claude is hooked; codex makes tool calls and no hook calls.
        assert!(
            w.check(with(1, &[("codex", agent(2, 0)), ("claude", agent(4, 9))]))
                .is_empty()
        );
        let v = w.check(with(2, &[("codex", agent(5, 0)), ("claude", agent(8, 20))]));
        assert_eq!(
            v,
            vec![Verdict::Raise(Problem::NotHooked {
                agent: "codex".into(),
                tool_calls: 5,
                minutes: 10
            })]
        );
        assert_eq!(
            Problem::NotHooked {
                agent: "codex".into(),
                tool_calls: 5,
                minutes: 10
            }
            .line(),
            "codex: 5 tool calls in the last 10 minutes and none reached failproofai's hooks, \
             so they ran unchecked: its hooks are not installed or not firing"
        );
        // A hook call from it again clears it, once.
        assert_eq!(
            w.check(with(3, &[("codex", agent(6, 1)), ("claude", agent(9, 22))])),
            vec![Verdict::Cleared(Kind::NotHooked("codex".into()))]
        );
    }

    #[test]
    fn too_few_tool_calls_or_one_hook_call_in_two_checks_is_not_an_error() {
        let mut w = Watch::default();
        w.check(with(0, &[("pi", agent(0, 0))]));
        // Two tool calls in ten minutes prove nothing.
        assert!(w.check(with(1, &[("pi", agent(1, 0))])).is_empty());
        assert!(w.check(with(2, &[("pi", agent(2, 0))])).is_empty());
        // A hook call in the earlier check covers a transcript that lags it.
        assert!(w.check(with(3, &[("pi", agent(2, 3))])).is_empty());
        assert!(w.check(with(4, &[("pi", agent(9, 3))])).is_empty());
    }

    #[test]
    fn a_backfill_with_no_live_tool_calls_never_raises() {
        // A fresh install re-reads a week of sessions: thousands of events, no
        // live tool calls, no hook calls. `live_tool_calls` stays 0.
        let mut w = Watch::default();
        for n in 0..6 {
            assert!(
                w.check(with(n, &[("claude", agent(0, 0))])).is_empty(),
                "check {n}"
            );
        }
    }

    #[test]
    fn an_unhooked_agent_that_goes_quiet_stays_raised_until_it_is_hooked() {
        let mut w = Watch::default();
        w.check(with(0, &[("goose", agent(0, 0))]));
        w.check(with(1, &[("goose", agent(3, 0))]));
        assert_eq!(
            raised(&w.check(with(2, &[("goose", agent(6, 0))]))),
            vec![Kind::NotHooked("goose".into())]
        );
        // Quiet: not cleared, not repeated.
        assert!(w.check(with(3, &[("goose", agent(6, 0))])).is_empty());
        assert!(w.check(with(4, &[("goose", agent(6, 0))])).is_empty());
    }

    #[test]
    fn live_tool_calls_are_recent_tool_use_events_only() {
        use fpai_collect::health::is_live_tool_call;
        let now = 1_800_000_000_i64;
        let ts = |secs: i64| {
            time::OffsetDateTime::from_unix_timestamp(secs)
                .unwrap()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap()
        };
        let ev = |t: &str, at: i64| serde_json::json!({"type": t, "timestamp": ts(at)});
        assert!(is_live_tool_call(&ev("tool_use", now - 60), now));
        assert!(
            is_live_tool_call(&ev("tool_use", now + 30), now),
            "small clock skew"
        );
        assert!(
            !is_live_tool_call(&ev("tool_use", now - 16 * 60), now),
            "a backfill's past"
        );
        assert!(!is_live_tool_call(&ev("tool_result", now - 60), now));
        assert!(!is_live_tool_call(
            &serde_json::json!({"type": "tool_use"}),
            now
        ));
    }

    #[test]
    fn falling_traffic_is_not_recovery_only_evidence_is() {
        // The reviewer's case: four unhooked tool calls raise it; later one
        // more unhooked call (below the threshold) must not "recover" it.
        let mut w = Watch::default();
        w.check(with(0, &[("pi", agent(0, 0))]));
        w.check(with(1, &[("pi", agent(2, 0))]));
        assert_eq!(
            raised(&w.check(with(2, &[("pi", agent(4, 0))]))),
            vec![Kind::NotHooked("pi".into())]
        );
        assert!(w.check(with(3, &[("pi", agent(4, 0))])).is_empty());
        assert!(
            w.check(with(4, &[("pi", agent(5, 0))])).is_empty(),
            "one unhooked call is not recovery"
        );
        // A hook call is.
        assert_eq!(
            w.check(with(5, &[("pi", agent(6, 1))])),
            vec![Verdict::Cleared(Kind::NotHooked("pi".into()))]
        );

        // Nothing recorded: fewer answered calls is not recovery; events are.
        let mut w = Watch::default();
        w.check(at(0));
        w.check(Sample {
            answered: 10,
            ..at(1)
        });
        assert_eq!(
            raised(&w.check(Sample {
                answered: 20,
                ..at(2)
            })),
            vec![Kind::NotCollected]
        );
        assert!(
            w.check(Sample {
                answered: 21,
                ..at(3)
            })
            .is_empty(),
            "quieter is not recovery"
        );
        assert_eq!(
            w.check(Sample {
                answered: 22,
                hook_events: 1,
                ..at(4)
            }),
            vec![Verdict::Cleared(Kind::NotCollected)]
        );

        // Stuck batch: an outage hides the condition, it does not clear it.
        let mut w = Watch::default();
        w.check(at(0));
        let stuck = Sample {
            waiting: 2,
            oldest_waiting_secs: 20 * 60,
            ..at(1)
        };
        assert_eq!(raised(&w.check(stuck.clone())), vec![Kind::NotDelivered]);
        let outage = Sample {
            delivered_at: T0 - 3600,
            oldest_waiting_secs: 25 * 60,
            ..stuck.clone()
        };
        assert!(
            w.check(Sample {
                now: T0 + 2 * STEP,
                ..outage
            })
            .is_empty(),
            "still stuck"
        );
        assert_eq!(w.check(at(3)), vec![Verdict::Cleared(Kind::NotDelivered)]);
    }

    #[test]
    fn health_probes_are_not_counted_as_hook_calls() {
        let before = ANSWERED.load(Ordering::Relaxed);
        note_answered(
            "claude",
            r#"{"hook_event_name":"SessionStart","source":"failproofai-health-probe"}"#,
        );
        assert_eq!(ANSWERED.load(Ordering::Relaxed), before);
        note_answered(
            "claude",
            r#"{"hook_event_name":"PreToolUse","tool_name":"Bash"}"#,
        );
        assert!(ANSWERED.load(Ordering::Relaxed) > before);
    }
}
