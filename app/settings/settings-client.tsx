"use client";

/**
 * /settings — scheduled audits for this machine.
 *
 * ## The design
 *
 * The subject is not a preferences form, it is a **control panel for a service
 * running on your box**. So the page is built from what that service actually
 * has: a state (running or not), a timer with a position on it, and an identity
 * it reports under. Everything is drawn from the app's existing tokens — the
 * charcoal stack, pink for the control that acts, mint for the thing that is
 * alive — and from chrome that already exists (`.report`, `.section`, `.panel`
 * with its corner brackets, `.btn-press` with the hard pixel offset). Nothing
 * new was invented where something was already there.
 *
 * **The signature is the schedule tape.** A scan on a timer has exactly one
 * fact worth seeing at a glance and no number can express it: where you are
 * between the last scan and the next. So it is drawn — a monospace rule with a
 * mint span for elapsed, a pink marker for now, and the two ends labelled.
 * It encodes something true about the content rather than decorating it, which
 * is the only reason to draw anything.
 *
 * Everything else is deliberately quiet. One accent, one drawn element, and the
 * rest is type and space.
 *
 * ## One switch, not two
 *
 * Scheduling and mailing are the same decision — the reason to put a scan on a
 * timer is to be told what it found. So there is one toggle, it requires a
 * sign-in, and "signed out with the timer on" is a real state the panel names
 * rather than a contradiction it prevents.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getScheduledAuditAction,
  type ScheduledAuditView,
} from "@/app/actions/get-scheduled-audit";
import {
  setAutoAuditAction,
  setAuditIntervalAction,
} from "@/app/actions/update-scheduled-audit";
import { triggerRun, RerunError } from "@/app/audit/_components/rerun-button";
import { AuthDialog, type AuthedUser } from "@/app/audit/_components/auth-dialog";
import { toast } from "@/app/components/toast";
import { formatRelativeTime } from "@/lib/format-duration";
import "./settings.css";

const MIN_INTERVAL_DAYS = 1;
const MAX_INTERVAL_DAYS = 90;

function fmtAbsolute(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "6d 4h" / "3h" / "12m" / "now". `formatRelativeTime` only speaks past. */
function fmtUntil(ms: number, now: number): string {
  const diff = ms - now;
  if (diff <= 0) return "now";
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return `${h}h`;
  return `${Math.max(1, Math.floor(diff / 60_000))}m`;
}

/**
 * The schedule tape — where this machine is between two scans.
 *
 * Drawn rather than stated because the fact is a POSITION, and a position is
 * the one thing a number cannot show at a glance. The filled span is elapsed,
 * the marker is now, the ends are the two scans.
 *
 * Renders nothing without both ends: a machine that has never run a scheduled
 * scan has no interval to be inside, and an empty rail claiming otherwise would
 * be decoration.
 */
function ScheduleTape({
  lastRunAtMs,
  nextDueAtMs,
  now,
}: {
  lastRunAtMs: number | null;
  nextDueAtMs: number | null;
  /** Stamped by the parent on load and on every focus refresh. Passed in
   *  rather than read here so this component stays pure during render — and so
   *  the marker moves when the page is refocused, which is the only moment
   *  anyone is looking at it. */
  now: number;
}) {
  if (lastRunAtMs == null || nextDueAtMs == null || nextDueAtMs <= lastRunAtMs) return null;
  const pct = Math.min(100, Math.max(0, ((now - lastRunAtMs) / (nextDueAtMs - lastRunAtMs)) * 100));

  return (
    <div className="tape" aria-hidden="true">
      <div className="tape-rail">
        <div className="tape-fill" style={{ width: `${pct}%` }} />
        <div className="tape-now" style={{ left: `${pct}%` }} />
      </div>
      <div className="tape-ends">
        <span>last scan · {fmtAbsolute(lastRunAtMs)}</span>
        <span className="tape-next">next · {fmtUntil(nextDueAtMs, now)}</span>
      </div>
    </div>
  );
}

function Toggle({
  enabled,
  onChange,
  disabled,
  label,
}: {
  enabled: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className="sw"
      data-on={enabled ? "true" : "false"}
    >
      <span className="sw-knob" />
    </button>
  );
}

export default function SettingsClient({ initial }: { initial: ScheduledAuditView | null }) {
  // Seeded from the server render, so the first paint already tells the truth
  // about whether scheduled audits are on. See the note in `page.tsx`.
  const [view, setView] = useState<ScheduledAuditView | null>(initial);
  const [auto, setAuto] = useState(initial?.auto ?? false);
  const [intervalDays, setIntervalDays] = useState(initial?.intervalDays ?? 7);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [loadError, setLoadError] = useState(initial === null);
  /**
   * When the view was last read. Drives the tape's marker; see ScheduleTape.
   *
   * Zero until the client has run, deliberately: `Date.now()` on the server and
   * `Date.now()` in the browser are different clocks, and seeding this from the
   * server render would put the marker at a position the client then corrects —
   * a hydration mismatch on the one element whose whole point is a position.
   * The tape appears on the first client pass instead.
   */
  const [nowMs, setNowMs] = useState(0);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const next = await getScheduledAuditAction();
      if (!mounted.current) return;
      setView(next);
      setAuto(next.auto);
      setIntervalDays(next.intervalDays);
      setNowMs(Date.now());
      setLoadError(false);
    } catch {
      if (mounted.current && !view) setLoadError(true);
      // An existing view is LEFT ALONE on a failed refresh: it describes real
      // machine state, and blanking it would report something less true than
      // what is already on screen.
    }
    // `view` is deliberately not a dep — including it would rebuild this on
    // every load and re-fire the focus listener below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Still refreshes on mount even though the server seeded us: it stamps
    // `nowMs` for the tape, and it picks up anything that changed between the
    // server render and the browser getting here.
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  /**
   * Re-read when the tab regains focus.
   *
   * The CLI writes the same `config.json` through the same `updateConfig`, so
   * the two can never disagree on disk — but a page left open while somebody
   * ran `failproofai audit --schedule 7` in a terminal would keep showing the
   * old toggle. Refreshing on focus picks that up the moment you look at it,
   * without a timer firing on a page that is usually idle.
   */
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [reload]);

  const signedIn = view?.signedInAs ?? null;
  const daemonRunning = view?.daemon === "running";
  const daemonUnsupported = view?.daemon === "unsupported-platform";
  const sched = view?.schedule ?? null;
  const lastExitBad =
    sched?.lastExitCode != null && sched.lastExitCode !== 0 && sched.lastExitCode !== 75;

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      const res = await setAutoAuditAction(true);
      setAuto(res.auto);
      toast("scheduled audits on.");
      await reload();
    } catch {
      setAuto(false);
      toast("could not turn that on.");
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const onToggle = useCallback(async () => {
    if (auto) {
      setBusy(true);
      try {
        const res = await setAutoAuditAction(false);
        setAuto(res.auto);
        toast("scheduled audits off.");
        await reload();
      } catch {
        toast("could not turn that off.");
      } finally {
        setBusy(false);
      }
      return;
    }
    // Turning it on needs somewhere to send the digest.
    if (!signedIn) {
      setAuthOpen(true);
      return;
    }
    await enable();
  }, [auto, enable, reload, signedIn]);

  const commitInterval = useCallback(
    async (raw: number) => {
      setBusy(true);
      try {
        const res = await setAuditIntervalAction(raw);
        // The action's return IS the authoritative value — it re-reads through
        // `readConfig`, so it already carries the 1..90 clamp. No reload after:
        // it would re-fetch the same number, and the schedule it would also
        // re-read has not changed yet either, since the daemon recomputes the
        // next due time on its own tick rather than when the interval is saved.
        setIntervalDays(res.intervalDays);
        toast(`scanning every ${res.intervalDays} day${res.intervalDays === 1 ? "" : "s"}.`);
      } catch {
        setIntervalDays(view?.intervalDays ?? 7);
        toast("could not save that.");
      } finally {
        setBusy(false);
      }
    },
    [view?.intervalDays],
  );

  const onSignOut = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      toast("signed out. scans continue; digests pause.");
      await reload();
    } catch {
      toast("could not sign out.");
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const onRunNow = useCallback(async () => {
    if (running) return;
    setRunning(true);
    try {
      await triggerRun({ cli: [], since: "all", noCache: false });
      toast("scan complete.");
      await reload();
    } catch (err) {
      toast(
        err instanceof RerunError && err.kind === "timeout"
          ? "the scan is taking a while — it will finish in the background."
          : "the scan could not be completed.",
      );
    } finally {
      setRunning(false);
    }
  }, [reload, running]);

  const onAuthed = useCallback(
    async (_user: AuthedUser) => {
      setAuthOpen(false);
      await reload();
      await enable();
    },
    [enable, reload],
  );

  return (
    <main className="report">
      <section className="section set-sec">
        <div className="set-mast">
          <div className="set-eyebrow">━━ this machine ━━</div>
          <h1 className="set-title">settings</h1>
          <p className="set-lede">
            what failproof does on its own, while you are not looking.
          </p>
        </div>

        <div className="panel set-panel">
          <div className="set-head">
            <div>
              <h2 className="set-card-title">scheduled audit</h2>
              <p className="set-card-sub">
                scan every session transcript on this machine, on a timer, and
                email you when it finds something harmful.
              </p>
            </div>
            {view && (
              <span className={`set-pill${daemonRunning ? " on" : ""}`}>
                {daemonRunning
                  ? "DAEMON RUNNING"
                  : daemonUnsupported
                    ? "UNSUPPORTED"
                    : view.daemon === "not-installed"
                      ? "NOT INSTALLED"
                      : "DAEMON STOPPED"}
              </span>
            )}
          </div>

          {loadError ? (
            <p className="set-warn">
              could not read this machine&apos;s settings. check that the
              dashboard can reach <code>~/.failproofai/config.json</code>.
            </p>
          ) : (
            <>
              <div className="set-row set-row-main">
                <Toggle
                  enabled={auto}
                  disabled={busy || view === null}
                  onChange={() => void onToggle()}
                  label={auto ? "turn off scheduled audits" : "turn on scheduled audits"}
                />
                <div className="set-row-copy">
                  <span className="set-strong">
                    {auto ? "scanning on a schedule." : "scan on a schedule."}
                  </span>
                  <span className="set-dim">
                    {auto
                      ? "you'll get an email only when a scan finds something."
                      : "off. nothing runs and nothing is sent."}
                  </span>
                </div>
              </div>

              <div className="set-row set-row-interval">
                <span className="set-dim">scan every</span>
                <input
                  type="number"
                  className="set-num"
                  min={MIN_INTERVAL_DAYS}
                  max={MAX_INTERVAL_DAYS}
                  value={intervalDays}
                  disabled={busy || view === null}
                  aria-label="days between scheduled scans"
                  onChange={(e) => setIntervalDays(Number(e.target.value))}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) {
                      setIntervalDays(view?.intervalDays ?? 7);
                      return;
                    }
                    if (v !== view?.intervalDays) void commitInterval(v);
                  }}
                />
                <span className="set-dim">days</span>
                <span className="set-hint">
                  {MIN_INTERVAL_DAYS}&ndash;{MAX_INTERVAL_DAYS}
                </span>
              </div>

              {auto && nowMs > 0 && (
                <ScheduleTape
                  lastRunAtMs={sched?.lastRunAtMs ?? null}
                  nextDueAtMs={sched?.nextDueAtMs ?? null}
                  now={nowMs}
                />
              )}

              <div className="set-rule" />

              <div className="set-row set-row-identity">
                {signedIn ? (
                  <>
                    <span className="set-dim">reports go to</span>
                    <span className="set-email">{signedIn.email}</span>
                    <button
                      type="button"
                      className="set-link"
                      disabled={busy}
                      onClick={() => void onSignOut()}
                    >
                      sign out
                    </button>
                  </>
                ) : auto ? (
                  <span className="set-warn">
                    signed out — scans continue, digests are paused. sign in to
                    resume them.
                  </span>
                ) : (
                  <span className="set-dim">
                    turning this on asks for an email, so there is somewhere to
                    send the report.
                  </span>
                )}
              </div>

              {auto && view && !daemonRunning && (
                <p className="set-warn">
                  {daemonUnsupported
                    ? "the background service isn't available on this platform, so scheduled scans can't run here. you can still run one now."
                    : view.daemon === "not-installed"
                      ? "the background service isn't installed, so nothing will run on the timer. install it with `failproofai config`."
                      : "the background service is stopped, so nothing will run until it starts. repair it with `failproofai config`."}
                </p>
              )}

              <div className="set-foot">
                <div className="set-facts">
                  <span>
                    last result{" "}
                    <span className="set-strong">
                      {view?.lastResultAt ? fmtAbsolute(Date.parse(view.lastResultAt)) : "none yet"}
                    </span>
                  </span>
                  {sched?.lastRunAtMs != null && (
                    <span>
                      last scheduled scan{" "}
                      <span className="set-strong">{formatRelativeTime(sched.lastRunAtMs)}</span>
                      {lastExitBad && <span className="set-warn-inline"> · exit {sched.lastExitCode}</span>}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-press"
                  disabled={running}
                  onClick={() => void onRunNow()}
                >
                  {running ? "[ scanning… ]" : "[ run a scan now ]"}
                </button>
              </div>
            </>
          )}
        </div>

        <p className="set-note">
          {"// the scan reads the contents of every session transcript on disk — your prompts, the files your agents read and wrote, and command output. it runs entirely on this machine. when a scan finds something harmful, counts and redacted examples are sent so the digest can be written; the transcripts never leave."}
        </p>
      </section>

      <AuthDialog
        open={authOpen}
        source="settings_scheduled_audit"
        headline="where should the report go?"
        subhead="we'll send a one-time code to confirm."
        onClose={() => setAuthOpen(false)}
        onAuthed={(u) => void onAuthed(u)}
      />
    </main>
  );
}
