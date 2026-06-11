"use client";

/**
 * Section 05 — COME BACK BETTER. "build the habit."
 *
 * Two side-by-side cards:
 *
 *  • Reminder — set a reminder cadence (3d / 7d / 14d / 30d). The cadence
 *    selection persists through /api/auth/reminder. Anon users get the
 *    AuthDialog first; authed-with-existing-reminder users see the next
 *    audit date and can reset.
 *
 *  • Unlock perks — share with N friends to unlock pro features for a
 *    month. UI only — invite tracking + entitlement is a follow-up; the
 *    button opens the same X share intent the poster uses.
 *
 * Re-audit moves out of this section: a small inline "or re-audit now"
 * link sits under the reminder card so the affordance survives without
 * dominating the layout.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { usePostHog } from "@/contexts/PostHogContext";
import { isAbortError } from "@/lib/fetch-with-timeout";
import { AuthDialog, type AuthedUser } from "./auth-dialog";

interface Props {
  isRunning: boolean;
  onRerun: () => void;
}

const DEFAULT_REMINDER_DAYS = 7;
const REMINDER_OPTIONS = [3, 7, 14, 30] as const;
type Cadence = typeof REMINDER_OPTIONS[number];

const PERKS_TARGET = 3;
const PERKS_PERK = "share with 3 friends → unlock pro features for a month.";
const PERKS_INVITE_URL =
  "https://x.com/intent/tweet?text=" +
  encodeURIComponent("just got my agent audited at failproof.ai — it's free, takes 30s. you should run yours too 👀");

type AuthStatus =
  | { kind: "unknown" }
  | { kind: "anon" }
  | { kind: "authed"; user: { id: string; email: string } };

interface Reminder {
  next_audit_at: number;
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

// Mock: invite count is UI state until the backend tracking lands. Per
// the spec the user is seeding the data — for now the count is 0 and
// the button just opens a share intent.
const SEED_INVITE_COUNT = 0;

export function ComeBackBetterSection({ isRunning, onRerun }: Props) {
  const { capture } = usePostHog();
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ kind: "unknown" });
  const [reminder, setReminder] = useState<Reminder | null>(null);
  const [cadence, setCadence] = useState<Cadence>(DEFAULT_REMINDER_DAYS);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [inviteCount] = useState<number>(SEED_INVITE_COUNT);
  const ctaShownRef = useRef(false);
  const lastRefreshAtRef = useRef(0);

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

  useEffect(() => {
    if (ctaShownRef.current) return;
    if (authStatus.kind === "unknown") return;
    ctaShownRef.current = true;
    capture("audit_reminder_cta_shown", {
      auth_state: authStatus.kind,
      has_existing_reminder: reminder !== null,
      source: "come_back_better_section",
    });
  }, [authStatus, capture, reminder]);

  const persistReminder = useCallback(
    async (inDays: number): Promise<Reminder | null> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        setReminderBusy(true);
        const res = await fetch("/api/auth/reminder", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ in_days: inDays }),
          signal: controller.signal,
        });
        if (!res.ok) {
          if (res.status === 401) {
            setAuthStatus({ kind: "anon" });
            setReminder(null);
          }
          capture("audit_reminder_saved", {
            status: `http_${res.status}`,
            source: "come_back_better_section",
            cadence_days: inDays,
          });
          return null;
        }
        const body = (await res.json()) as { reminder?: Reminder };
        capture("audit_reminder_saved", {
          status: body.reminder ? "success" : "empty",
          source: "come_back_better_section",
          cadence_days: inDays,
        });
        return body.reminder ?? null;
      } catch (err) {
        const kind = isAbortError(err) ? "timeout" : "error";
        capture("audit_reminder_saved", {
          status: kind,
          source: "come_back_better_section",
          cadence_days: inDays,
        });
        return null;
      } finally {
        clearTimeout(timer);
        setReminderBusy(false);
      }
    },
    [capture],
  );

  const handleCadenceClick = useCallback(
    async (next: Cadence) => {
      setCadence(next);
      capture("audit_reminder_cta_clicked", {
        auth_state: authStatus.kind,
        has_existing_reminder: reminder !== null,
        cadence_days: next,
        source: "come_back_better_section",
      });
      if (authStatus.kind === "authed") {
        const saved = await persistReminder(next);
        if (saved) setReminder(saved);
        return;
      }
      if (authStatus.kind === "anon") {
        setDialogOpen(true);
      }
    },
    [authStatus, capture, persistReminder, reminder],
  );

  const handleAuthed = useCallback(
    async (user: AuthedUser) => {
      setAuthStatus({ kind: "authed", user });
      capture("audit_auth_completed", {
        source: "come_back_better_section",
      });
      const saved = await persistReminder(cadence);
      if (saved) setReminder(saved);
    },
    [cadence, capture, persistReminder],
  );

  const handleInvite = useCallback(() => {
    capture("audit_perks_invite_clicked", {
      invite_count: inviteCount,
      target: PERKS_TARGET,
      source: "come_back_better_section",
    });
    globalThis.open(PERKS_INVITE_URL, "_blank", "noopener,noreferrer");
  }, [capture, inviteCount]);

  const handleRerunInline = useCallback(() => {
    if (isRunning) return;
    onRerun();
  }, [isRunning, onRerun]);

  const days = reminder ? daysUntil(reminder.next_audit_at) : 0;
  const remaining = Math.max(0, PERKS_TARGET - inviteCount);
  const progressPct = Math.min(
    100,
    Math.round((inviteCount / PERKS_TARGET) * 100),
  );

  return (
    <section className="audit-sec" data-screen-label="05 Come back better">
      <div className="audit-sec-head">
        <span className="audit-sec-eyebrow">
          <span className="ix">05</span>{"// come back better"}
        </span>
      </div>
      <h2 className="audit-sec-title">build the habit</h2>

      <div className="cbb-grid">
        {/* Reminder card */}
        <div className="cbb-card">
          <div className="cbb-card-title">set a reminder</div>
          <div className="cbb-card-sub">
            {reminder
              ? `next audit set for ${formatNextAudit(reminder.next_audit_at)} · in ${days} day${days === 1 ? "" : "s"}.`
              : "we'll nudge you when your next audit is due. pick the cadence:"}
          </div>
          <div className="cadence-row">
            {REMINDER_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                className={`cadence-btn${cadence === d ? " on" : ""}`}
                disabled={reminderBusy || authStatus.kind === "unknown"}
                onClick={() => void handleCadenceClick(d)}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            type="button"
            className="cbb-link"
            disabled={isRunning}
            onClick={handleRerunInline}
          >
            {isRunning ? "scanning…" : "or re-audit now →"}
          </button>
        </div>

        {/* Perks card */}
        <div className="cbb-card">
          <div className="cbb-card-title">unlock failproof perks</div>
          <div className="cbb-card-sub">{PERKS_PERK}</div>
          <div className="perks-progress" aria-hidden="true">
            <span style={{ width: `${progressPct}%` }} />
          </div>
          <div className="perks-meta">
            <strong>
              {inviteCount} of {PERKS_TARGET}
            </strong>{" "}
            invited · {remaining} to go
          </div>
          <button type="button" className="invite-btn" onClick={handleInvite}>
            invite a friend
          </button>
          <div className="cbb-foot">
            {"// invites are tracked by signup — they have to run an audit too."}
          </div>
        </div>
      </div>

      <AuthDialog
        open={dialogOpen}
        source="return_section"
        onClose={() => setDialogOpen(false)}
        onAuthed={(u) => {
          setDialogOpen(false);
          void handleAuthed(u);
        }}
      />
    </section>
  );
}
