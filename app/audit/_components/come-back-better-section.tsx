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
import { useCallback, useEffect, useRef, useState } from "react";
import { usePostHog } from "@/contexts/PostHogContext";
import { isAbortError } from "@/lib/fetch-with-timeout";
import { AuthDialog, type AuthedUser } from "./auth-dialog";
import { InviteDialog } from "./invite-dialog";

interface Props {
  isRunning: boolean;
  onRerun: () => void;
  /** Current audit score (0–100), forwarded into the invite email body. */
  score?: number;
}

const DEFAULT_REMINDER_DAYS = 7;
const REMINDER_OPTIONS = [3, 7, 14, 30] as const;
type Cadence = typeof REMINDER_OPTIONS[number];

const PERKS_PERK = "wanna know how your friends' agents score?";

// The AuthDialog is shared by the reminder and invite CTAs. The reminder path
// keeps the dialog's default copy; the invite path swaps in login-required
// copy. Content only — the auth flow is identical for both.
const INVITE_AUTH_COPY = {
  headline: "Oops! Login required",
  subhead: "What's your email?",
} as const;

/**
 * What the user was trying to do when the AuthDialog opened.
 *
 * `null` means the dialog is closed. Every other value is a thing to RESUME
 * once auth succeeds — which is the point: the dialog is shared, so the only
 * safe way for it to finish is to be told what it was opened for.
 */
type PendingAction =
  | null
  /** Set a reminder at the cadence the user clicked. */
  | { kind: "reminder"; cadence: Cadence }
  /** Open the invite dialog. */
  | { kind: "invite" };

/** The dialog's copy for a given intent. Derived, never stored separately. */
function authCopyFor(action: PendingAction): { headline?: string; subhead?: string } {
  return action?.kind === "invite" ? INVITE_AUTH_COPY : {};
}

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

export function ComeBackBetterSection({ isRunning, onRerun, score }: Props) {
  const { capture } = usePostHog();
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ kind: "unknown" });
  const [reminder, setReminder] = useState<Reminder | null>(null);
  const [cadence, setCadence] = useState<Cadence>(DEFAULT_REMINDER_DAYS);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [reminderBusy, setReminderBusy] = useState(false);
  /**
   * WHICH CTA opened the AuthDialog, and therefore what to do once it succeeds.
   *
   * This used to be tracked only as `authCopy` — the headline and subhead to
   * show — while `handleAuthed` unconditionally called `persistReminder`. So the
   * dialog knew which button had been pressed for the purpose of its own COPY
   * and not for the purpose of its own EFFECT, and the invite path did the
   * reminder path's work: a user who clicked "invite a friend", read "Oops!
   * Login required", and signed in got a 7-day reminder they never asked for,
   * and no invite dialog. Their actual intent was dropped on the floor.
   *
   * Modelling the intent instead of the copy is what stops that recurring. The
   * copy is now DERIVED from it, so the two cannot disagree, and adding a third
   * CTA means adding a case here rather than remembering to branch in a handler
   * that has no idea it is shared.
   */
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const ctaShownRef = useRef(false);
  const lastRefreshAtRef = useRef(0);

  const refreshStatus = useCallback(async () => {
    lastRefreshAtRef.current = Date.now();
    // Preserve current UI state on transient failures (5xx, network blips).
    // Downgrading to anon on every error would clear a valid reminder mid-
    // session on a single failed poll, forcing an unnecessary auth prompt.
    // Only fall through to anon on the very first probe (still "unknown")
    // so the cadence buttons unlock even if the server is unreachable.
    const fallbackToAnonOnError = () => {
      setAuthStatus((prev) => (prev.kind === "unknown" ? { kind: "anon" } : prev));
    };
    try {
      const res = await fetch("/api/auth/status", { cache: "no-store" });
      if (!res.ok) {
        fallbackToAnonOnError();
        return;
      }
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
      fallbackToAnonOnError();
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
        setPendingAction({ kind: "reminder", cadence: next });
        setDialogOpen(true);
      }
    },
    [authStatus, capture, persistReminder, reminder],
  );

  /**
   * Resume whatever the user was doing before they were asked to sign in.
   *
   * Reads `pendingAction` rather than assuming. Assuming is what it did before,
   * and because the reminder CTA happened to be written first, "assume" meant
   * "set a reminder" for every caller — including the invite button, which
   * wanted something else entirely and got nothing.
   *
   * The cadence is carried IN the action rather than read from `cadence` state,
   * so the reminder that lands is the one whose button was actually pressed,
   * even if something re-rendered in between.
   */
  const handleAuthed = useCallback(
    async (user: AuthedUser) => {
      setAuthStatus({ kind: "authed", user });
      const action = pendingAction;
      capture("audit_auth_completed", {
        source: "come_back_better_section",
        pending_action: action?.kind ?? "none",
      });
      setPendingAction(null);

      if (action?.kind === "reminder") {
        const saved = await persistReminder(action.cadence);
        if (saved) setReminder(saved);
        return;
      }
      if (action?.kind === "invite") {
        setInviteDialogOpen(true);
      }
      // No pending action: the dialog was dismissed and reopened, or opened by
      // something that wants nothing but the sign-in. Doing nothing is correct
      // — it is the case the old code had no way to express.
    },
    [capture, pendingAction, persistReminder],
  );

  const handleInvite = useCallback(() => {
    capture("audit_perks_invite_clicked", {
      source: "come_back_better_section",
      auth_state: authStatus.kind,
    });
    // Unauthed users go through the AuthDialog first so we have a sender
    // identity to Cc on the invite email — and `pendingAction` is what brings
    // them back HERE afterwards instead of somewhere else.
    if (authStatus.kind !== "authed") {
      setPendingAction({ kind: "invite" });
      setDialogOpen(true);
      return;
    }
    setInviteDialogOpen(true);
  }, [authStatus.kind, capture]);

  const handleRerunInline = useCallback(() => {
    if (isRunning) return;
    onRerun();
  }, [isRunning, onRerun]);

  const days = reminder ? daysUntil(reminder.next_audit_at) : 0;

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
          <div className="cbb-card-title">Share with friends</div>
          <div className="cbb-card-sub">{PERKS_PERK}</div>
          <button type="button" className="invite-btn" onClick={handleInvite}>
            invite a friend
          </button>
          <div className="cbb-foot">
            {"// invites are sent from failproof.ai, Cc'd to you, with a link to run their own audit."}
          </div>
        </div>
      </div>

      <InviteDialog
        open={inviteDialogOpen}
        source="come_back_better_section"
        score={score}
        onClose={() => setInviteDialogOpen(false)}
        onUnauthorized={() => {
          // Session expired between probe and submit — flip back to anon and
          // bounce through the AuthDialog so the user re-auths. Still the invite
          // intent, so re-authing reopens THIS dialog rather than dropping them
          // back on the page having achieved nothing.
          setAuthStatus({ kind: "anon" });
          setReminder(null);
          setPendingAction({ kind: "invite" });
          setDialogOpen(true);
        }}
      />

      <AuthDialog
        open={dialogOpen}
        source="return_section"
        headline={authCopyFor(pendingAction).headline}
        subhead={authCopyFor(pendingAction).subhead}
        onClose={() => {
          // Dismissing is abandoning the intent. Leaving it set would make the
          // NEXT sign-in — from any other CTA — resume something the user
          // walked away from.
          setPendingAction(null);
          setDialogOpen(false);
        }}
        onAuthed={(u) => {
          setDialogOpen(false);
          void handleAuthed(u);
        }}
      />
    </section>
  );
}
