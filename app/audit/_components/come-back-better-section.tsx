"use client";

/**
 * Section 05 — COME BACK BETTER. "build the habit."
 *
 * Two panels, side by side:
 *
 *  • **Scheduled audit** — everything this machine does on a timer. The scan
 *    switch, how often, whether a scan that finds something mails you, who it
 *    would mail, and a way to run one now.
 *  • **Share with friends** — the invite.
 *
 * ## Why this absorbed /settings
 *
 * The scheduled-audit controls lived on their own page, which meant the two
 * questions a person has after reading their audit — "can this happen
 * automatically" and "will it tell me" — were answered somewhere they had no
 * reason to go. The controls now sit under the report they act on. `/settings`
 * is gone rather than redirected: it held nothing else.
 *
 * ## Two switches, deliberately
 *
 * `auto` scans this machine on a timer and needs no account. `emailEnabled`
 * sends a digest when a scan finds something harmful, and needs a sign-in.
 * Collapsing them into one would make scheduled scanning require an account,
 * and `audit --help` promises the scan "runs fully offline — no account or
 * network required". Keeping them apart is what keeps that true.
 *
 * ## The dialog is shared, so intent is explicit
 *
 * Both the email switch and the invite button can open the same `AuthDialog`.
 * `pendingAction` records WHICH, so signing in resumes the thing that was asked
 * for. It used to be tracked only as the dialog's copy while the success
 * handler always set a reminder, which is how signing in to send an invite
 * scheduled a reminder instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePostHog } from "@/contexts/PostHogContext";
import {
  getScheduledAuditAction,
  type ScheduledAuditView,
} from "@/app/actions/get-scheduled-audit";
import {
  setAutoAuditAction,
  setAuditEmailAction,
  setAuditIntervalAction,
} from "@/app/actions/update-scheduled-audit";
import { toast } from "@/app/components/toast";
import { formatRelativeTime } from "@/lib/format-duration";
import { AuthDialog, type AuthedUser } from "./auth-dialog";
import { InviteDialog } from "./invite-dialog";

interface Props {
  isRunning: boolean;
  onRerun: () => void;
  /** Current audit score (0–100), forwarded into the invite email body. */
  score?: number;
}

const PERKS_PERK = "wanna know how your friends' agents score?";

/**
 * Copy for the shared AuthDialog, DERIVED from the pending intent rather than
 * stored beside it — so the words and the effect cannot disagree.
 */
type PendingAction = null | { kind: "invite" } | { kind: "email-optin" };

function authCopyFor(action: PendingAction): { headline?: string; subhead?: string } {
  if (action?.kind === "invite") {
    return { headline: "Oops! Login required", subhead: "What's your email?" };
  }
  if (action?.kind === "email-optin") {
    return {
      headline: "where should the report go?",
      subhead: "we'll send a one-time code to confirm.",
    };
  }
  return {};
}

const MIN_INTERVAL_DAYS = 1;
const MAX_INTERVAL_DAYS = 90;

function fmtAbsolute(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 6d" / "in 3h" / "now". `formatRelativeTime` only speaks past. */
function fmtFuture(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  if (diff < 3_600_000) return `in ${Math.max(1, Math.floor(diff / 60_000))}m`;
  if (diff < 86_400_000) return `in ${Math.floor(diff / 3_600_000)}h`;
  return `in ${Math.floor(diff / 86_400_000)}d`;
}

/** The switch /policies uses. Copied shape, not a new control. */
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
      className="cbb-toggle"
      data-on={enabled ? "true" : "false"}
    >
      <span className="cbb-toggle-knob" />
    </button>
  );
}

export function ComeBackBetterSection({ isRunning, onRerun, score }: Props) {
  const { capture } = usePostHog();

  const [view, setView] = useState<ScheduledAuditView | null>(null);
  const [auto, setAuto] = useState(false);
  const [intervalDays, setIntervalDays] = useState(7);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const ctaShownRef = useRef(false);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const next = await getScheduledAuditAction();
      if (!mounted.current) return;
      setView(next);
      setAuto(next.auto);
      setIntervalDays(next.intervalDays);
      setEmailEnabled(next.emailEnabled);
    } catch {
      // Leave whatever is on screen. A failed refresh must not blank controls
      // that are describing real machine state.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  useEffect(() => {
    if (ctaShownRef.current || !view) return;
    ctaShownRef.current = true;
    capture("audit_return_section_shown", {
      auto: view.auto,
      email_enabled: view.emailEnabled,
      signed_in: view.signedInAs !== null,
      daemon: view.daemon,
    });
  }, [capture, view]);

  const signedIn = view?.signedInAs ?? null;
  const loading = view === null;

  // ── scheduled scanning ─────────────────────────────────────────────────────

  const onToggleAuto = useCallback(async () => {
    const next = !auto;
    setAuto(next); // optimistic
    setBusy(true);
    try {
      const res = await setAutoAuditAction(next);
      setAuto(res.auto);
      capture("audit_auto_toggled", { enabled: res.auto });
      toast(res.auto ? "scanning this machine on a schedule." : "scheduled scanning off.");
      await reload();
    } catch {
      setAuto(!next); // revert
      toast("could not save that.");
    } finally {
      setBusy(false);
    }
  }, [auto, capture, reload]);

  const commitInterval = useCallback(
    async (raw: number) => {
      setBusy(true);
      try {
        // The config owns the 1..90 clamp; reflect whatever it stored rather
        // than a second copy of the bounds that can drift.
        const res = await setAuditIntervalAction(raw);
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

  // ── emailed reports ────────────────────────────────────────────────────────

  const enableEmail = useCallback(async () => {
    setBusy(true);
    try {
      const res = await setAuditEmailAction(true);
      setEmailEnabled(res.emailEnabled);
      capture("audit_email_reports_toggled", { enabled: true });
      toast("we'll email you when a scan finds something.");
      await reload();
    } catch {
      setEmailEnabled(false);
      toast("could not turn that on.");
    } finally {
      setBusy(false);
    }
  }, [capture, reload]);

  const onToggleEmail = useCallback(async () => {
    if (emailEnabled) {
      setBusy(true);
      try {
        const res = await setAuditEmailAction(false);
        setEmailEnabled(res.emailEnabled);
        capture("audit_email_reports_toggled", { enabled: false });
        toast("emailed reports off.");
        await reload();
      } catch {
        toast("could not turn that off.");
      } finally {
        setBusy(false);
      }
      return;
    }
    // Turning it ON needs somewhere to send to. Sign in first, then resume —
    // the server action refuses an anonymous enable rather than storing a
    // switch that reads as on and does nothing.
    if (!signedIn) {
      setPendingAction({ kind: "email-optin" });
      setDialogOpen(true);
      return;
    }
    await enableEmail();
  }, [capture, emailEnabled, enableEmail, reload, signedIn]);

  const onSignOut = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      // Signing out takes emailed reports with it. Leaving the switch on would
      // leave a machine that scans, finds something, and has nothing to send it
      // with — visible only by noticing that no email ever arrives.
      await setAuditEmailAction(false).catch(() => {});
      toast("signed out.");
      await reload();
    } catch {
      toast("could not sign out.");
    } finally {
      setBusy(false);
    }
  }, [reload]);

  // ── invite ─────────────────────────────────────────────────────────────────

  const handleInvite = useCallback(() => {
    capture("audit_perks_invite_clicked", { signed_in: signedIn !== null });
    // Unauthed users sign in first so the invite has a sender to Cc — and
    // `pendingAction` is what brings them back HERE afterwards.
    if (!signedIn) {
      setPendingAction({ kind: "invite" });
      setDialogOpen(true);
      return;
    }
    setInviteDialogOpen(true);
  }, [capture, signedIn]);

  /** Resume whatever the user was doing before they were asked to sign in. */
  const handleAuthed = useCallback(
    async (user: AuthedUser) => {
      const action = pendingAction;
      capture("audit_auth_completed", { pending_action: action?.kind ?? "none" });
      setPendingAction(null);
      await reload();

      if (action?.kind === "invite") {
        setInviteDialogOpen(true);
        return;
      }
      if (action?.kind === "email-optin") {
        await enableEmail();
      }
      // No pending action: the dialog was dismissed and reopened, or opened for
      // the sign-in alone. Doing nothing is correct.
      void user;
    },
    [capture, enableEmail, pendingAction, reload],
  );

  // ── derived status ─────────────────────────────────────────────────────────

  const daemonRunning = view?.daemon === "running";
  const daemonUnsupported = view?.daemon === "unsupported-platform";
  const sched = view?.schedule ?? null;
  const lastExitBad =
    sched?.lastExitCode != null && sched.lastExitCode !== 0 && sched.lastExitCode !== 75;

  return (
    <section className="audit-sec" data-screen-label="05 Come back better">
      <div className="audit-sec-head">
        <div className="audit-sec-eyebrow">
          <span className="ix">05</span> come back better
        </div>
      </div>
      <h2 className="audit-sec-title">build the habit</h2>

      <div className="cbb-grid">
        {/* ── Scheduled audit ── */}
        <div className="cbb-card cbb-card-primary">
          <div className="cbb-card-head">
            <div>
              <div className="cbb-card-title">Scheduled audit</div>
              <div className="cbb-card-sub">scan this machine on a timer, in the background.</div>
            </div>
            {view && (
              <span className={`cbb-pill${daemonRunning ? " on" : ""}`}>
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

          <div className="cbb-row">
            <Toggle
              enabled={auto}
              disabled={busy || loading}
              onChange={() => void onToggleAuto()}
              label={auto ? "turn off scheduled scanning" : "turn on scheduled scanning"}
            />
            <span>{auto ? "scanning this machine on a schedule." : "scan this machine on a schedule."}</span>
          </div>

          <div className="cbb-row cbb-row-interval">
            <span className="cbb-muted">scan every</span>
            <input
              id="scan-interval"
              type="number"
              className="cbb-num"
              min={MIN_INTERVAL_DAYS}
              max={MAX_INTERVAL_DAYS}
              value={intervalDays}
              disabled={busy || loading}
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
            <span className="cbb-muted">days.</span>
            <span className="cbb-hint">
              {MIN_INTERVAL_DAYS}&ndash;{MAX_INTERVAL_DAYS}
            </span>
          </div>

          <div className="cbb-row">
            <Toggle
              enabled={emailEnabled}
              disabled={busy || loading}
              onChange={() => void onToggleEmail()}
              label={emailEnabled ? "turn off emailed reports" : "turn on emailed reports"}
            />
            <span>email me when a scan finds something harmful.</span>
          </div>

          {signedIn ? (
            <div className="cbb-identity">
              <span className="cbb-muted">signed in as</span>{" "}
              <span className="cbb-email">{signedIn.email}</span>
              <button
                type="button"
                className="cbb-link cbb-link-inline"
                disabled={busy}
                onClick={() => void onSignOut()}
              >
                sign out
              </button>
            </div>
          ) : (
            emailEnabled && (
              // The state the reporter surfaces as "signed out": the switch is
              // on, the scans keep running, and nothing can be sent.
              <div className="cbb-warn">
                emailed reports are on but this machine is signed out — sign in to resume them.
              </div>
            )
          )}

          {auto && view && !daemonRunning && (
            <div className="cbb-warn">
              {daemonUnsupported
                ? "the background daemon isn't available on this platform, so scheduled scans can't run here."
                : view.daemon === "not-installed"
                  ? "scheduled scanning is on, but the background service isn't installed. run `failproofai config`."
                  : "scheduled scanning is on, but the background service is stopped. run `failproofai config`."}
            </div>
          )}

          <div className="cbb-foot-block">
            <div className="cbb-muted">
              last audit result:{" "}
              {view?.lastResultAt ? (
                <span className="cbb-strong">{fmtAbsolute(view.lastResultAt)}</span>
              ) : (
                <span className="cbb-hint">none yet</span>
              )}
            </div>
            {auto && sched?.nextDueAtMs != null && (
              <div className="cbb-muted">
                next scheduled scan:{" "}
                <span className="cbb-strong">{fmtFuture(sched.nextDueAtMs)}</span>
              </div>
            )}
            {sched?.lastRunAtMs != null && (
              <div className="cbb-muted">
                last scheduled scan:{" "}
                <span className="cbb-strong">{formatRelativeTime(sched.lastRunAtMs)}</span>
                {lastExitBad && <span className="cbb-warn-inline"> (exit {sched.lastExitCode})</span>}
              </div>
            )}
            <button
              type="button"
              className="cbb-run-btn"
              disabled={isRunning}
              onClick={() => {
                if (!isRunning) onRerun();
              }}
            >
              {isRunning ? "[ scanning… ]" : "[ run a scan now ]"}
            </button>
          </div>
        </div>

        {/* ── Share ── */}
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

      <div className="cbb-note">
        {"// the scan reads every session transcript on disk across all installed agent CLIs. runs entirely on this machine — nothing is sent anywhere unless emailed reports are on, and then only counts and redacted examples."}
      </div>

      <InviteDialog
        open={inviteDialogOpen}
        source="come_back_better_section"
        score={score}
        onClose={() => setInviteDialogOpen(false)}
        onUnauthorized={() => {
          // Session expired between probe and submit. Still the invite intent,
          // so re-authing reopens THIS dialog rather than dropping them back on
          // the page having achieved nothing.
          setInviteDialogOpen(false);
          setPendingAction({ kind: "invite" });
          setDialogOpen(true);
          void reload();
        }}
      />

      <AuthDialog
        open={dialogOpen}
        source="return_section"
        headline={authCopyFor(pendingAction).headline}
        subhead={authCopyFor(pendingAction).subhead}
        onClose={() => {
          // Dismissing abandons the intent. Leaving it set would make the NEXT
          // sign-in, from any CTA, resume something the user walked away from.
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
