"use client";

/**
 * Invite dialog — modal that takes a comma/newline-separated list of friend
 * emails and POSTs them to /api/audit/invite. The api-server composes the
 * actual invite email (Cc'ing the sender) using the same email infrastructure
 * that backs the OTP flow.
 *
 * Anonymous users get bounced through the AuthDialog by the caller; this
 * component assumes the session is already established.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePostHog } from "@/contexts/PostHogContext";
import { toast } from "@/app/components/toast";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Source tag for PostHog so we can split "invited from come-back-better"
   *  from any future entry points. */
  source: string;
  /** Called when the proxy returns 401 (session expired between probe and
   *  submit). The parent should re-open the AuthDialog so the user can
   *  re-authenticate; without this, a 401 dead-ends with an inline error. */
  onUnauthorized?: () => void;
  /** Sender's audit score (0–100), forwarded to the api-server so the invite
   *  body can show "mine came out at N/100". Omitted → score-free copy. */
  score?: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 10;

function parseEmails(input: string): { valid: string[]; invalid: string[] } {
  const tokens = input
    .split(/[\s,;]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (EMAIL_RE.test(t)) valid.push(t);
    else invalid.push(t);
  }
  return { valid, invalid };
}

export function InviteDialog({ open, onClose, source, onUnauthorized, score }: Props): React.ReactElement | null {
  const { capture } = usePostHog();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      setValue("");
      setBusy(false);
      setError(null);
      capture("audit_invite_dialog_opened", { source });
    }
  }, [capture, open, source]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const { valid, invalid } = useMemo(() => parseEmails(value), [value]);

  const submit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (busy) return;
      if (valid.length === 0) {
        setError("add at least one valid email address.");
        return;
      }
      if (valid.length > MAX_RECIPIENTS) {
        setError(`up to ${MAX_RECIPIENTS} emails at a time. send the rest in a follow-up.`);
        return;
      }
      setBusy(true);
      setError(null);
      capture("audit_invite_submitted", {
        source,
        recipient_count: valid.length,
        had_invalid: invalid.length > 0,
      });
      try {
        const res = await fetch("/api/audit/invite", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: valid, score }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          sent?: string[];
          failed?: string[];
          code?: string;
          message?: string;
        };
        if (res.status === 401) {
          // Session expired between probe and submit — route back through auth.
          // Without this, repeated submits would dead-end with the same 401.
          if (onUnauthorized) {
            onClose();
            onUnauthorized();
          } else {
            setError("session expired. please sign in again.");
          }
          return;
        }
        if (!res.ok) {
          const msg = body.message ?? "couldn't send invites.";
          setError(msg);
          return;
        }
        const sent = body.sent?.length ?? 0;
        const failed = body.failed?.length ?? 0;
        toast(
          failed > 0
            ? `📨 sent ${sent}, ${failed} bounced — copy the bounce and try again.`
            : `📨 sent ${sent} ${sent === 1 ? "invite" : "invites"}. thanks for spreading the word.`,
        );
        onClose();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(`network error: ${message}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, valid, invalid, capture, source, onClose, onUnauthorized, score],
  );

  if (!open) return null;

  return (
    <div
      className="auth-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-dialog-title"
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="auth-dialog">
        <button
          type="button"
          className="auth-close"
          onClick={onClose}
          disabled={busy}
          aria-label="close"
        >
          ×
        </button>

        <h2 id="invite-dialog-title" className="auth-headline">
          invite friends to audit theirs
        </h2>
        <p className="auth-sub">
          paste emails separated by commas, spaces, or newlines. you&apos;ll be Cc&apos;d on every invite so they know it&apos;s from you.
        </p>

        <form onSubmit={submit} className="auth-form">
          <textarea
            ref={inputRef}
            name="emails"
            placeholder="alice@x.com, bob@y.com&#10;carol@z.com"
            disabled={busy}
            className="auth-input invite-textarea"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={4}
            required
          />
          <div className="invite-summary">
            {valid.length > 0 && (
              <span className="invite-valid">{valid.length} valid</span>
            )}
            {invalid.length > 0 && (
              <span className="invite-invalid">
                {invalid.length} invalid: {invalid.slice(0, 3).join(", ")}
                {invalid.length > 3 ? `, +${invalid.length - 3} more` : ""}
              </span>
            )}
            {valid.length > MAX_RECIPIENTS && (
              <span className="invite-invalid">
                only {MAX_RECIPIENTS} per send — first {MAX_RECIPIENTS} will go.
              </span>
            )}
          </div>
          {error && <div className="auth-error">{error}</div>}
          <div className="auth-actions">
            <button
              type="submit"
              className="auth-btn primary"
              disabled={busy || valid.length === 0}
            >
              {busy ? "sending…" : `send ${valid.length || ""} invite${valid.length === 1 ? "" : "s"}`.trim()}
            </button>
            <button
              type="button"
              className="auth-btn"
              onClick={onClose}
              disabled={busy}
            >
              cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
