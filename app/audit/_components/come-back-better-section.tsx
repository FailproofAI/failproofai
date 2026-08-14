"use client";

/**
 * Section 05 — SPREAD THE AUDIT.
 *
 * One job: get someone else to run this on their own machine. The scheduled-
 * audit controls used to live here too and have moved to `/settings`, reachable
 * from the gear in the header — they are machine configuration, and this is the
 * end of a report. Mixing "here is what your agent did" with "here is how to
 * configure a background service" made the last thing you read before leaving
 * the page a settings form.
 *
 * The AuthDialog is still here because inviting needs a sender identity to Cc.
 * It is now the ONLY thing on this section that opens it, which is what makes
 * the resume unambiguous — the bug this section used to have was a shared
 * dialog whose success handler assumed which control had opened it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePostHog } from "@/contexts/PostHogContext";
import { AuthDialog, type AuthedUser } from "./auth-dialog";
import { InviteDialog } from "./invite-dialog";

interface Props {
  /** Current audit score (0–100), forwarded into the invite email body. */
  score?: number;
}

const PERKS_PERK = "wanna know how your friends' agents score?";

const INVITE_AUTH_COPY = {
  headline: "Oops! Login required",
  subhead: "What's your email?",
} as const;

export function ComeBackBetterSection({ score }: Props) {
  const { capture } = usePostHog();
  const [signedIn, setSignedIn] = useState<{ id: string; email: string } | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const shownRef = useRef(false);

  useEffect(() => {
    // Cancellation guard rather than a bare fire-and-forget: the probe outlives
    // a fast unmount otherwise, and setting state on a gone component is the
    // kind of warning people learn to scroll past.
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          authenticated?: boolean;
          user?: { id: string; email: string };
        };
        if (!cancelled) setSignedIn(body.authenticated && body.user ? body.user : null);
      } catch {
        // Leave whatever we last knew. A failed probe is not evidence of a
        // signed-out user, and downgrading on one would prompt for a login the
        // person already completed.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    capture("audit_share_section_shown", { signed_in: signedIn !== null });
  }, [capture, signedIn]);

  const handleInvite = useCallback(() => {
    capture("audit_perks_invite_clicked", { signed_in: signedIn !== null });
    // Unauthed users sign in first, so the invite has a sender to Cc.
    if (!signedIn) {
      setAuthOpen(true);
      return;
    }
    setInviteOpen(true);
  }, [capture, signedIn]);

  const handleAuthed = useCallback(
    async (user: AuthedUser) => {
      setSignedIn(user);
      setAuthOpen(false);
      capture("audit_auth_completed", { source: "share_section" });
      // Resume the one thing that could have opened the dialog.
      setInviteOpen(true);
    },
    [capture],
  );

  return (
    <section className="audit-sec" data-screen-label="05 Spread the audit">
      <div className="audit-sec-head">
        <div className="audit-sec-eyebrow">
          <span className="ix">05</span> share
        </div>
      </div>
      <h2 className="audit-sec-title">spread the audit</h2>

      <div className="cbb-card share-card">
        <div className="cbb-card-title">Share with friends</div>
        <div className="cbb-card-sub">{PERKS_PERK}</div>
        <button type="button" className="invite-btn" onClick={handleInvite}>
          invite a friend
        </button>
        <div className="cbb-foot">
          {"// invites are sent from failproof.ai, Cc'd to you, with a link to run their own audit."}
        </div>
      </div>

      <InviteDialog
        open={inviteOpen}
        source="come_back_better_section"
        score={score}
        onClose={() => setInviteOpen(false)}
        onUnauthorized={() => {
          // Session expired between the probe and the submit. Bounce through
          // the dialog; success reopens the invite, since that is the only
          // thing it can be resuming.
          setInviteOpen(false);
          setSignedIn(null);
          setAuthOpen(true);
        }}
      />

      <AuthDialog
        open={authOpen}
        source="share_section"
        headline={INVITE_AUTH_COPY.headline}
        subhead={INVITE_AUTH_COPY.subhead}
        onClose={() => setAuthOpen(false)}
        onAuthed={(u) => void handleAuthed(u)}
      />
    </section>
  );
}
