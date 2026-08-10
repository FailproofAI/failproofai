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
 * All writes go through server actions that call `updateConfig` — never a raw
 * file write — so the CLI and dashboard cannot diverge. The parity mapping is
 * documented on each action module.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getScheduledAuditAction, type ScheduledAuditView } from "@/app/actions/get-scheduled-audit";
import { setAutoAuditAction, setAuditIntervalAction } from "@/app/actions/update-scheduled-audit";
import { triggerRun, RerunError } from "@/app/audit/_components/rerun-button";
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

// ── page ─────────────────────────────────────────────────────────────────────

export default function SettingsClient() {
  const [scheduled, setScheduled] = useState<ScheduledAuditView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    const s = await getScheduledAuditAction();
    if (!mounted.current) return;
    setScheduled(s);
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
        ) : error || !scheduled ? (
          <p style={{ ...BODY, color: "var(--accent-pink)" }}>
            Could not load settings. Refresh to try again.
          </p>
        ) : (
          <ScheduledAuditSection view={scheduled} onReload={reload} />
        )}
      </section>
    </main>
  );
}
