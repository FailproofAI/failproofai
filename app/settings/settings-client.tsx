"use client";

/**
 * /settings client — two sections (scheduled audit, email reports) plus the
 * degraded states that are most of the real screens: daemon not installed /
 * stopped / unsupported, no scan ever run, a scan running now, a last run that
 * failed, signed out, and not cloud-enrolled. Each is shown explicitly, because
 * a missing control reads as a bug.
 *
 * Visual conventions are the site chrome's, matched to /policies: the brutalist
 * `.report`/`.section`/`.panel`/`.btn` classes from globals.css, the same
 * emerald switch /policies uses (PolicyToggle), inline `var(--…)` colours, and
 * the shared `toast()`. No new design language, colour, or component library.
 *
 * All writes go through server actions that call `updateConfig` /
 * `runEmailReports*` — never a raw file write — so the CLI and dashboard cannot
 * diverge. The parity mapping is documented on each action module.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { getScheduledAuditAction, type ScheduledAuditView } from "@/app/actions/get-scheduled-audit";
import { setAutoAuditAction, setAuditIntervalAction } from "@/app/actions/update-scheduled-audit";
import { getEmailReportsAction, type EmailReportsView } from "@/app/actions/get-email-reports";
import { setEmailReportsAction } from "@/app/actions/update-email-reports";
import { triggerRun, RerunError } from "@/app/audit/_components/rerun-button";
import { AuthDialog } from "@/app/audit/_components/auth-dialog";
import { toast } from "@/app/components/toast";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { formatRelativeTime } from "@/lib/format-duration";

// ── formatting helpers ───────────────────────────────────────────────────────

function fmtAbsolute(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 6d" / "in 3h" / "in 12m" / "now". formatRelativeTime only speaks past. */
function fmtFuture(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  if (diff < 3_600_000) return `in ${Math.max(1, Math.floor(diff / 60_000))}m`;
  if (diff < 86_400_000) return `in ${Math.floor(diff / 3_600_000)}h`;
  return `in ${Math.floor(diff / 86_400_000)}d`;
}

// ── shared primitives (match /policies) ──────────────────────────────────────

/** The exact switch /policies uses — copied shape, not a new control. */
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
      onClick={onChange}
      disabled={disabled}
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
        enabled ? "bg-emerald-500" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${
          enabled ? "translate-x-3.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

type PillTone = "ok" | "warn" | "bad" | "muted";
const PILL_TONE: Record<PillTone, { fg: string; bg: string; bd: string }> = {
  ok: { fg: "var(--accent-green)", bg: "rgba(102,209,181,0.10)", bd: "rgba(102,209,181,0.30)" },
  warn: { fg: "var(--amber)", bg: "rgba(232,196,106,0.10)", bd: "rgba(232,196,106,0.30)" },
  bad: { fg: "var(--accent-pink)", bg: "rgba(228,88,124,0.10)", bd: "rgba(228,88,124,0.30)" },
  muted: { fg: "var(--ink-2)", bg: "transparent", bd: "var(--line-2)" },
};

function Pill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  const t = PILL_TONE[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 9px",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        letterSpacing: "0.04em",
        color: t.fg,
        background: t.bg,
        border: `1px solid ${t.bd}`,
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}

const SECTION_TITLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: "-0.01em",
  color: "var(--ink)",
  margin: "0 0 4px",
};
const BODY: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--ink-2)",
  lineHeight: 1.65,
  margin: 0,
};
const MUTED: React.CSSProperties = { ...BODY, color: "var(--dim)", fontSize: 12 };
const CODE: React.CSSProperties = { color: "var(--ink)", fontVariantLigatures: "none" };

/** A monospace inline command the user can copy by eye. */
function Cmd({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        color: "var(--accent-green)",
        background: "var(--bg-2)",
        border: "1px solid var(--line-2)",
        padding: "1px 6px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </code>
  );
}

// ── scheduled audit section ──────────────────────────────────────────────────

function ScheduledAuditSection({
  view,
  onReload,
}: {
  view: ScheduledAuditView;
  onReload: () => Promise<void>;
}) {
  const [auto, setAuto] = useState(view.auto);
  const [interval, setIntervalDays] = useState(view.intervalDays);
  const [savingAuto, setSavingAuto] = useState(false);
  const [savingInterval, setSavingInterval] = useState(false);
  const [running, setRunning] = useState(false);
  const [runningNow, setRunningNow] = useState(false);

  // Keep local state honest if a background reload brought new server truth
  // (e.g. someone toggled via CLI, or the interval clamp changed the value).
  useEffect(() => setAuto(view.auto), [view.auto]);
  useEffect(() => setIntervalDays(view.intervalDays), [view.intervalDays]);

  // Reflect a scan already in flight (started here or from /audit) so the button
  // and status line don't claim the machine is idle when it isn't.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout("/api/audit/status", { cache: "no-store" });
        if (res.ok && !cancelled) {
          const s = (await res.json()) as { running?: boolean };
          setRunning(Boolean(s.running));
        }
      } catch {
        /* status is best-effort; a missing poll just means we assume idle */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const daemonInactive = view.daemon !== "running";
  const daemonUnsupported = view.daemon === "unsupported-platform";

  const onToggleAuto = useCallback(async () => {
    const next = !auto;
    setAuto(next); // optimistic
    setSavingAuto(true);
    try {
      const res = await setAutoAuditAction(next);
      setAuto(res.auto);
      toast(res.auto ? "Scheduled scanning on." : "Scheduled scanning off.");
      await onReload();
    } catch {
      setAuto(!next); // revert
      toast("Could not save that.");
    } finally {
      setSavingAuto(false);
    }
  }, [auto, onReload]);

  const commitInterval = useCallback(
    async (raw: number) => {
      setSavingInterval(true);
      try {
        // The config owns the 1..90 clamp; we reflect whatever it stored.
        const res = await setAuditIntervalAction(raw);
        setIntervalDays(res.intervalDays);
        toast(`Scanning every ${res.intervalDays} day${res.intervalDays === 1 ? "" : "s"}.`);
      } catch {
        setIntervalDays(view.intervalDays);
        toast("Could not save that.");
      } finally {
        setSavingInterval(false);
      }
    },
    [view.intervalDays],
  );

  const onRunNow = useCallback(async () => {
    if (runningNow || running) return;
    setRunningNow(true);
    setRunning(true);
    try {
      await triggerRun({ cli: [], since: "all", noCache: false });
      toast("Audit complete.");
      await onReload();
    } catch (err) {
      const msg =
        err instanceof RerunError && err.kind === "timeout"
          ? "The scan is taking a while — it will finish in the background."
          : "The scan could not be completed.";
      toast(msg);
    } finally {
      setRunningNow(false);
      setRunning(false);
    }
  }, [runningNow, running, onReload]);

  const sched = view.schedule;
  const lastExitBad =
    sched?.lastExitCode != null && sched.lastExitCode !== 0 && sched.lastExitCode !== 75;

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h3 style={SECTION_TITLE}>Scheduled audit</h3>
          <p style={MUTED}>Scan this machine on a timer, in the background.</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {view.daemon === "running" && <Pill tone="ok">daemon running</Pill>}
          {view.daemon === "stopped" && <Pill tone="warn">daemon stopped</Pill>}
          {view.daemon === "not-installed" && <Pill tone="warn">daemon not installed</Pill>}
          {view.daemon === "unsupported-platform" && <Pill tone="muted">daemon unavailable</Pill>}
        </div>
      </div>

      {/* Enable toggle + the plain statement about what the scan reads. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginTop: 18 }}>
        <div style={{ marginTop: 2 }}>
          <Toggle
            enabled={auto}
            onChange={onToggleAuto}
            disabled={savingAuto || daemonUnsupported}
            label={auto ? "Turn off scheduled scanning" : "Turn on scheduled scanning"}
          />
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ ...BODY, color: "var(--ink)" }}>
            {auto ? "Scanning this machine on a schedule." : "Scan this machine on a schedule."}
          </p>
          <p style={{ ...BODY, marginTop: 6 }}>
            The scan reads the <span style={CODE}>contents</span> of every session transcript on
            disk across all installed agent CLIs — your prompts, the files they read and wrote,
            and command output. It runs entirely on this machine. Nothing is sent anywhere unless
            you also turn on emailed reports below.
          </p>
        </div>
      </div>

      {/* Interval. The number bounds mirror the config's own 1..90 clamp as a UX
          hint; the config remains the authority and we reflect what it stored. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
        <label htmlFor="scan-interval" style={{ ...BODY }}>
          Scan every
        </label>
        <input
          id="scan-interval"
          type="number"
          min={1}
          max={90}
          step={1}
          value={interval}
          disabled={savingInterval || daemonUnsupported}
          onChange={(e) => setIntervalDays(Number(e.target.value))}
          onBlur={(e) => {
            const v = Number(e.target.value);
            // A cleared/garbage field must not persist NaN — snap back to the
            // stored value and let the config keep owning the real bounds.
            if (!Number.isFinite(v)) {
              setIntervalDays(view.intervalDays);
              return;
            }
            if (v !== view.intervalDays) void commitInterval(v);
          }}
          style={{
            width: 64,
            padding: "6px 8px",
            background: "var(--bg)",
            border: "1px solid var(--line-2)",
            color: "var(--ink)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            textAlign: "center",
          }}
        />
        <span style={BODY}>day{interval === 1 ? "" : "s"}.</span>
        <span style={MUTED}>1–90; the config keeps it in range.</span>
      </div>

      {/* Last run / next due — read from the daemon-written schedule file. */}
      <div
        style={{
          marginTop: 18,
          paddingTop: 16,
          borderTop: "1px dashed var(--line)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {running && (
          <p style={{ ...BODY, color: "var(--accent-green)" }}>A scan is running now…</p>
        )}

        {/* Last run */}
        {sched?.lastRunAtMs != null ? (
          <p style={BODY}>
            Last scheduled scan:{" "}
            <span style={CODE}>{fmtAbsolute(sched.lastRunAtMs)}</span>{" "}
            <span style={MUTED}>({formatRelativeTime(sched.lastRunAtMs)})</span>
          </p>
        ) : view.lastResultAt ? (
          <p style={BODY}>
            Last audit result:{" "}
            <span style={CODE}>{fmtAbsolute(new Date(view.lastResultAt).getTime())}</span>{" "}
            <span style={MUTED}>(no scheduled scan has run yet)</span>
          </p>
        ) : (
          <p style={BODY}>No scan has run yet.</p>
        )}

        {/* Next due */}
        {auto ? (
          sched?.nextDueAtMs != null ? (
            <p style={BODY}>
              Next scan due:{" "}
              <span style={CODE}>{fmtAbsolute(sched.nextDueAtMs)}</span>{" "}
              <span style={MUTED}>({fmtFuture(sched.nextDueAtMs)})</span>
            </p>
          ) : (
            <p style={BODY}>
              Next scan:{" "}
              <span style={MUTED}>the daemon will schedule it shortly.</span>
            </p>
          )
        ) : (
          <p style={MUTED}>Scheduled scanning is off — no scan is scheduled.</p>
        )}

        {lastExitBad && (
          <p style={{ ...BODY, color: "var(--amber)" }}>
            The last scheduled scan exited with code {sched?.lastExitCode}. It will retry on the
            next tick.
          </p>
        )}
        {sched?.schemaAhead && (
          <p style={MUTED}>
            A newer daemon wrote this schedule; some fields may not be shown.
          </p>
        )}
      </div>

      {/* Degraded daemon guidance — say plainly why "on" may still not run. */}
      {auto && daemonInactive && (
        <p style={{ ...BODY, color: "var(--amber)", marginTop: 14 }}>
          {daemonUnsupported ? (
            <>The background daemon isn&apos;t available on this platform, so scheduled scans
            can&apos;t run here. You can still run one now, and use the audit page.</>
          ) : view.daemon === "not-installed" ? (
            <>Scheduled scanning is on, but the background service isn&apos;t installed, so nothing
            will run on the timer yet. Install it with <Cmd>failproofai config</Cmd>.</>
          ) : (
            <>Scheduled scanning is on, but the background service is stopped, so nothing will run
            until it starts. Reinstall or repair it with <Cmd>failproofai config</Cmd>.</>
          )}
        </p>
      )}

      {/* Run now — reuses the existing /api/audit/run route via triggerRun. */}
      <div style={{ marginTop: 18 }}>
        <button
          type="button"
          className="btn"
          onClick={onRunNow}
          disabled={runningNow || running}
        >
          {runningNow || running ? "[ scanning… ]" : "[ run a scan now ]"}
        </button>
      </div>
    </div>
  );
}

// ── email reports section ────────────────────────────────────────────────────

function EmailReportsSection({
  view,
  onReload,
}: {
  view: EmailReportsView;
  onReload: () => Promise<void>;
}) {
  const [reportsOn, setReportsOn] = useState(view.reportsOn);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string[] | null>(null);
  const [authOpen, setAuthOpen] = useState(false);

  useEffect(() => setReportsOn(view.reportsOn), [view.reportsOn]);

  const onToggle = useCallback(async () => {
    const next = !reportsOn;
    setReportsOn(next); // optimistic
    setSaving(true);
    setRefusal(null);
    try {
      // Delegates to runEmailReportsOn/OffCommand — the same rules the CLI uses.
      const res = await setEmailReportsAction(next);
      if (res.exitCode === 0) {
        toast(next ? "Emailed reports on." : "Emailed reports off.");
        await onReload();
      } else {
        // A refusal (e.g. a race that lost enrolment, or no verified address).
        // Show the command's own explanation verbatim rather than a generic error.
        setReportsOn(!next);
        setRefusal(res.lines);
      }
    } catch {
      setReportsOn(!next);
      toast("Could not save that.");
    } finally {
      setSaving(false);
    }
  }, [reportsOn, onReload]);

  const onAuthed = useCallback(async () => {
    setAuthOpen(false);
    await onReload(); // now signed in — re-derive which control to show
  }, [onReload]);

  const verifiedMismatch =
    view.verifiedFor && view.signedInEmail && view.verifiedFor !== view.signedInEmail;

  return (
    <div className="panel" style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h3 style={SECTION_TITLE}>Email reports</h3>
          <p style={MUTED}>Get emailed when a scheduled scan finds something harmful.</p>
        </div>
        <div>
          {!view.cloudEnrolled ? (
            <Pill tone="muted">not connected</Pill>
          ) : reportsOn ? (
            <Pill tone="ok">on</Pill>
          ) : (
            <Pill tone="muted">off</Pill>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        {/* State 1: not cloud-enrolled — email is impossible. Say why, plainly. */}
        {!view.cloudEnrolled ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={BODY}>
              Emailed reports need a connection to Failproof Cloud. The report is rendered and sent
              by the cloud from a summary this machine uploads — without an enrolment there is no
              organisation to scope it to and no verified address to send to, and a local-only
              machine naming its own recipient would be an open mail relay. So there is no offline
              version of this.
            </p>
            <p style={MUTED}>
              Connect this machine, then come back:{" "}
              <Cmd>failproofai config --connect &lt;url&gt; --token &lt;key&gt;</Cmd>
            </p>
          </div>
        ) : !view.signedInEmail ? (
          /* State 2: enrolled but signed out — lead into the EXISTING login flow. */
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={BODY}>
              Reports go to the address you verify by one-time code — never a second address typed
              here. Sign in to route them to your verified email.
            </p>
            <div>
              <button type="button" className="btn btn-primary" onClick={() => setAuthOpen(true)}>
                [ sign in ]
              </button>
            </div>
          </div>
        ) : (
          /* State 3: enrolled + signed in — the real control. */
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ marginTop: 2 }}>
                <Toggle
                  enabled={reportsOn}
                  onChange={onToggle}
                  disabled={saving}
                  label={reportsOn ? "Turn off emailed reports" : "Turn on emailed reports"}
                />
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ ...BODY, color: "var(--ink)" }}>
                  {reportsOn ? "Emailing harmful findings" : "Email me harmful findings"}, agreed
                  under <span style={{ color: "var(--accent-pink)" }}>{view.verifiedFor ?? view.signedInEmail}</span>.
                </p>
                <p style={{ ...BODY, marginTop: 6 }}>
                  A scan uploads counts only — rule ids, hit counts, how many projects each fired
                  in, and timestamps. Never a file path, a command, a prompt, or anything from a
                  transcript. Recipients are resolved by the server from your organisation, so this
                  address is a record of consent, not a target.
                </p>
                <p style={{ ...BODY, marginTop: 6 }}>
                  You are emailed <span style={CODE}>only</span> when a scan finds something harmful
                  still getting through. A clean week is silent — that&apos;s expected, not a
                  breakage.
                </p>
              </div>
            </div>

            {refusal && (
              <div
                style={{
                  border: "1px solid var(--accent-pink)",
                  borderLeftWidth: 3,
                  background: "var(--accent-pink-bg)",
                  padding: "10px 12px",
                }}
              >
                {refusal.map((line, i) => (
                  <p key={i} style={{ ...BODY, color: line ? "var(--ink)" : undefined, margin: 0, minHeight: line ? undefined : 8 }}>
                    {line}
                  </p>
                ))}
              </div>
            )}

            {!view.autoAuditOn && (
              <p style={{ ...BODY, color: "var(--amber)" }}>
                Scheduled scanning is off, so no scan is produced to report. Turn it on above.
              </p>
            )}
            {verifiedMismatch && (
              <p style={{ ...BODY, color: "var(--amber)" }}>
                Signed in as {view.signedInEmail}, which isn&apos;t who opted in ({view.verifiedFor}
                ). Toggle off and on again to re-confirm under this address.
              </p>
            )}
          </div>
        )}

        {/* The exact CLI status text, surfaced so the two stay legibly in sync. */}
        {view.statusLines.length > 0 && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed var(--line)" }}>
            {view.statusLines.map((line, i) => (
              <p key={i} style={MUTED}>
                {line}
              </p>
            ))}
          </div>
        )}
      </div>

      <AuthDialog
        open={authOpen}
        headline="sign in to route reports"
        subhead="we'll send a one-time code to your email to confirm."
        source="settings_email_reports"
        onClose={() => setAuthOpen(false)}
        onAuthed={onAuthed}
      />
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function SettingsClient() {
  const [scheduled, setScheduled] = useState<ScheduledAuditView | null>(null);
  const [email, setEmail] = useState<EmailReportsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    const [s, e] = await Promise.all([getScheduledAuditAction(), getEmailReportsAction()]);
    if (!mounted.current) return;
    setScheduled(s);
    setEmail(e);
  }, []);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        await reload();
      } catch {
        if (mounted.current) setError(true);
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  return (
    <main className="report">
      <section className="section" data-screen-label="settings">
        <h2
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: "var(--ink)",
            margin: "0 0 8px",
          }}
        >
          Settings
        </h2>
        <p style={{ ...BODY, maxWidth: 720, margin: "0 0 24px" }}>
          Machine-level controls for scheduled scanning and emailed reports.
        </p>

        {loading ? (
          <p style={MUTED}>Loading…</p>
        ) : error || !scheduled || !email ? (
          <p style={{ ...BODY, color: "var(--accent-pink)" }}>
            Could not load settings. Refresh to try again.
          </p>
        ) : (
          <>
            <ScheduledAuditSection view={scheduled} onReload={reload} />
            <EmailReportsSection view={email} onReload={reload} />
          </>
        )}
      </section>
    </main>
  );
}
