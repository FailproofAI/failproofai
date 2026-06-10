"use client";

/**
 * Section 06 — NEXT AUDIT / "come back better." Re-audit loop CTA.
 *
 * Behavior matrix:
 *   - unknown (probe in flight)  → buttons disabled
 *   - anon (no session)          → [ set a reminder ] opens AuthDialog,
 *                                  on success we flip to the authed panel
 *                                  below and persist the 7-day reminder.
 *   - authed (any)               → consolidated status panel: "signed in as
 *                                  …" + either the persisted "next audit in
 *                                  X days" line OR a "no reminder set yet"
 *                                  line with an inline [ set a reminder ]
 *                                  button. The reminder persists across
 *                                  reloads via ~/.failproofai/next-audit.json
 *                                  — same as the CLI's auth.json.
 *
 * Also exposes [ re-audit now ] next to [ install policies ] so the user
 * can trigger a fresh scan inline without leaving the page. The button
 * fires POST /api/audit/run (same backend the empty-state CTA uses).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AuditResult } from "@/src/audit/types";
import { usePostHog } from "@/contexts/PostHogContext";
import { isAbortError } from "@/lib/fetch-with-timeout";
import { AuthDialog, type AuthedUser } from "./auth-dialog";

interface Props {
  result: AuditResult;
  /** Lifted by AuditDashboard so the bottom button and the top-of-page
   *  re-audit bar share state — only one rerun at a time. */
  isRunning: boolean;
  /** Lifted handler. Drives the sticky progress strip + soft refresh. */
  onRerun: () => void;
}

const BULK_INSTALL_CMD = "failproofai policies --install";
const DEFAULT_REMINDER_DAYS = 7;

type AuthStatus =
  | { kind: "unknown" }
  | { kind: "anon" }
  | { kind: "authed"; user: { id: string; email: string } };

interface Reminder {
  next_audit_at: number; // unix seconds
  user_email: string;
  set_at: number;
}

function daysUntil(unixSecs: number): number {
  const nowSecs = Math.floor(Date.now() / 1000);
  return Math.max(0, Math.ceil((unixSecs - nowSecs) / 86400));
}

function formatNextAudit(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function ReturnSection({ result, isRunning, onRerun }: Props) {
  const { capture } = usePostHog();
  const hasUnenabled = result.results.some(
    (r) => r.source === "builtin" && !r.enabledInConfig && r.hits > 0,
  );

  const [copied, setCopied] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ kind: "unknown" });
  const [reminder, setReminder] = useState<Reminder | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reminderBusy, setReminderBusy] = useState(false);
  const ctaShownRef = useRef(false);
  /** Throttle gate for focus/visibility-triggered refreshStatus calls —
   *  rapid alt-tabbing would otherwise hit /api/auth/status (two disk
   *  reads each) once per event. */
  const lastRefreshAtRef = useRef(0);

  // Probe /api/auth/status on mount — also returns the persisted reminder
  // when one exists and belongs to the active session.
  const refreshStatus = useCallback(async () => {
    lastRefreshAtRef.current = Date.now();
    try {
      const res = await fetch("/api/auth/status", { cache: "no-store" });
      const body = (await res.json()) as {
        authenticated?: boolean;
        user?: { id: string; email: string };
        reminder?: Reminder | null;
      };
      if (body.authenticated && body.user) {
        setAuthStatus({ kind: "authed", user: body.user });
        setReminder(body.reminder ?? null);
      } else {
        setAuthStatus({ kind: "anon" });
        setReminder(null);
      }
    } catch {
      setAuthStatus({ kind: "anon" });
      setReminder(null);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    // Re-probe whenever the tab regains focus or visibility — picks up
    // CLI `failproofai auth login` / `logout` and api-server restarts
    // without the user having to hit reload manually. Throttled to 5s so
    // rapid alt-tabbing (a focus + a visibility event for one switch)
    // doesn't double-fire.
    const REFRESH_MIN_INTERVAL_MS = 5_000;
    const maybeRefresh = () => {
      if (Date.now() - lastRefreshAtRef.current < REFRESH_MIN_INTERVAL_MS) return;
      void refreshStatus();
    };
    const onFocus = () => maybeRefresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") maybeRefresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshStatus]);

  // Fire-once "user saw the reminder CTA" event so we can compute the
  // funnel shown → clicked → auth → saved. We wait until the auth probe
  // finishes — before that the buttons are disabled and the CTA isn't
  // really "shown".
  useEffect(() => {
    if (ctaShownRef.current) return;
    if (authStatus.kind === "unknown") return;
    ctaShownRef.current = true;
    capture("audit_reminder_cta_shown", {
      auth_state: authStatus.kind,
      has_existing_reminder: reminder !== null,
      source: "return_section",
    });
  }, [authStatus, capture, reminder]);

  const persistReminder = useCallback(async (): Promise<Reminder | null> => {
    // 10s ceiling so a hung route can't permanently disable the CTA.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      setReminderBusy(true);
      const res = await fetch("/api/auth/reminder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ in_days: DEFAULT_REMINDER_DAYS }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // A 401 here means our local "authed" view of the world is out of
        // date — the server-side session was revoked or expired between the
        // status probe and this write. Flip back to anon so the user can
        // re-authenticate instead of leaving them on a panel whose actions
        // silently no-op.
        if (res.status === 401) {
          setAuthStatus({ kind: "anon" });
          setReminder(null);
        }
        capture("audit_reminder_saved", {
          status: `http_${res.status}`,
          source: "return_section",
        });
        return null;
      }
      const body = (await res.json()) as { reminder?: Reminder };
      capture("audit_reminder_saved", {
        status: body.reminder ? "success" : "empty",
        source: "return_section",
      });
      return body.reminder ?? null;
    } catch (err) {
      const kind = isAbortError(err) ? "timeout" : "error";
      capture("audit_reminder_saved", {
        status: kind,
        source: "return_section",
      });
      return null;
    } finally {
      clearTimeout(timer);
      setReminderBusy(false);
    }
  }, [capture]);

  const handleInstall = async () => {
    capture("audit_install_policies_clicked", {
      source: "return_section",
    });
    try {
      await navigator.clipboard.writeText(BULK_INSTALL_CMD);
      setCopied(true);
      capture("audit_copy_clicked", {
        source: "return_section_install_policies",
        item_type: "bulk_install_command",
      });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const handleSetReminder = useCallback(async () => {
    if (authStatus.kind === "unknown") return;
    capture("audit_reminder_cta_clicked", {
      auth_state: authStatus.kind,
      has_existing_reminder: reminder !== null,
      source: "return_section",
    });
    if (authStatus.kind === "authed") {
      const next = await persistReminder();
      if (next) setReminder(next);
      return;
    }
    setDialogOpen(true);
  }, [authStatus, capture, persistReminder, reminder]);

  const handleAuthed = useCallback(
    async (user: AuthedUser) => {
      setAuthStatus({ kind: "authed", user });
      capture("audit_auth_completed", {
        source: "return_section",
      });
      // The dialog opened because the user wanted a reminder → persist
      // immediately, no second click required.
      const next = await persistReminder();
      if (next) setReminder(next);
    },
    [capture, persistReminder],
  );

  // Re-audit is now lifted into AuditDashboard so the top-of-page bar and
  // this bottom button share state — concurrent clicks are impossible and
  // success path soft-refreshes the report rather than reloading the page.
  // PostHog `source: "return_section"` capture happens inside the lifted
  // handler via the `source` argument it receives.
  const handleRerun = useCallback(() => {
    if (isRunning) return;
    onRerun();
  }, [isRunning, onRerun]);

  const authed = authStatus.kind === "authed";
  const hasReminder = authed && reminder !== null;
  const days = reminder ? daysUntil(reminder.next_audit_at) : 0;
  const authedEmail =
    authStatus.kind === "authed" ? authStatus.user.email : "";

  return (
    <section className="section" data-screen-label="06 Next audit">
      <div className="section-mast">
        <div className="section-label">
          <span className="glyph">━━</span> next audit{" "}
          <span style={{ color: "var(--dim)" }}>·</span> improvement
        </div>
        <div className="section-meta">
          <span className="g">●</span> recommended in 7d
        </div>
      </div>
      <h2 className="section-h">come back better.</h2>

      <div className="return-hook">
        <div className="label">━━ the loop</div>
        <h3>re-audit in 7 days.</h3>
        <p>
          after the prescribed policies have been live for a week, we&apos;ll show
          your before/after score and which detectors went quiet.
        </p>
        <p style={{ marginTop: 16, color: "var(--dim)" }}>
          most agents move from C to B in one session. some make it in a day.
        </p>

        {/* Once authed, the section stays in the consolidated status panel —
            with the reminder line if one is set, or a "no reminder yet" line
            + inline [ set a reminder ] button otherwise. The anonymous CTA
            layout only shows for genuinely-unauthed sessions. The action
            buttons ([ set a reminder ] / [ re-audit now ] / [ install
            policies ]) are identical in both branches — extracted into
            <ReturnActions> below to keep them in sync. */}
        {authed ? (
          <div className="return-status">
            {hasReminder && reminder ? (
              <div className="rs-row rs-row-primary">
                <span className="rs-dot rs-dot-pink" aria-hidden="true" />
                <span>
                  next audit set for{" "}
                  <span className="rs-strong">{formatNextAudit(reminder.next_audit_at)}</span>
                  {" "}<span style={{ color: "var(--dim)" }}>·</span>{" "}
                  <span className="rs-strong">in {days} day{days === 1 ? "" : "s"}</span>
                </span>
              </div>
            ) : (
              <div className="rs-row rs-row-primary">
                <span className="rs-dot rs-dot-pink" aria-hidden="true" />
                <span>
                  <span className="rs-strong">no reminder set yet</span>
                  {" "}<span style={{ color: "var(--dim)" }}>·</span>{" "}
                  recommended in {DEFAULT_REMINDER_DAYS} days
                </span>
              </div>
            )}
            <div className="rs-row">
              <span className="rs-dot rs-dot-green" aria-hidden="true" />
              <span>
                signed in as <span className="rs-email">{authedEmail}</span>
              </span>
            </div>
            <ReturnActions
              style={{ marginTop: 18 }}
              showSetReminder={!hasReminder}
              setReminderDisabled={reminderBusy}
              reminderBusy={reminderBusy}
              rerunBusy={isRunning}
              hasUnenabled={hasUnenabled}
              copied={copied}
              onSetReminder={handleSetReminder}
              onRerun={handleRerun}
              onInstall={handleInstall}
            />
          </div>
        ) : (
          <ReturnActions
            showSetReminder
            setReminderDisabled={authStatus.kind === "unknown" || reminderBusy}
            reminderBusy={reminderBusy}
            rerunBusy={isRunning}
            hasUnenabled={hasUnenabled}
            copied={copied}
            onSetReminder={handleSetReminder}
            onRerun={handleRerun}
            onInstall={handleInstall}
          />
        )}
      </div>

      <AuthDialog
        open={dialogOpen}
        source="return_section"
        headline="oops — you are unknown."
        reason="verify yourself to get the re-audit reminder."
        onClose={() => setDialogOpen(false)}
        onAuthed={(u) => {
          setDialogOpen(false);
          void handleAuthed(u);
        }}
      />
    </section>
  );
}

interface ReturnActionsProps {
  /** Whether to render the `[ set a reminder ]` button. False when the
   *  user already has a reminder set (the authed-with-reminder case
   *  shows the panel meta instead). */
  showSetReminder: boolean;
  setReminderDisabled: boolean;
  reminderBusy: boolean;
  rerunBusy: boolean;
  hasUnenabled: boolean;
  copied: boolean;
  onSetReminder: () => void;
  onRerun: () => void;
  onInstall: () => void;
  style?: React.CSSProperties;
}

/** Action button strip shared by the authed and anon branches. Extracted
 *  to keep the three buttons in sync — the prior inline copies had
 *  already drifted on margin-top styling. */
function ReturnActions(props: ReturnActionsProps): React.ReactElement {
  const {
    showSetReminder,
    setReminderDisabled,
    reminderBusy,
    rerunBusy,
    hasUnenabled,
    copied,
    onSetReminder,
    onRerun,
    onInstall,
    style,
  } = props;
  return (
    <div className="return-actions" style={style}>
      {showSetReminder && (
        <button
          type="button"
          className="share-btn"
          onClick={onSetReminder}
          disabled={setReminderDisabled}
        >
          {reminderBusy ? "[ saving… ]" : "[ set a reminder ]"}
        </button>
      )}
      <button
        type="button"
        className="share-btn alt"
        onClick={onRerun}
        disabled={rerunBusy}
      >
        {rerunBusy ? "[ scanning… ]" : "[ re-audit now ]"}
      </button>
      {hasUnenabled && (
        <button type="button" className="share-btn alt" onClick={onInstall}>
          {copied ? "[ ✓ copied — paste in your shell ]" : "[ install policies ]"}
        </button>
      )}
    </div>
  );
}
