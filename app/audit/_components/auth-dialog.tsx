"use client";

/**
 * Auth dialog — modal overlay shown when an unauthenticated user clicks
 * a cadence button to set a reminder. Two-step flow:
 *
 *   1. Email entry  → POST /api/auth/login-request
 *   2. OTP entry    → POST /api/auth/login-verify
 *
 * Calm chrome to match the rest of /audit: 1px borders, plain
 * lowercase copy, no corner crosshair frame. The dialog never sees
 * the refresh token — the dashboard's API route writes it to
 * ~/.failproofai/auth.json.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { usePostHog } from "@/contexts/PostHogContext";
import { fetchWithTimeout, isAbortError } from "@/lib/fetch-with-timeout";

export interface AuthedUser {
  id: string;
  email: string;
}

interface Props {
  open: boolean;
  /** Optional title. Defaults to "where to route the reminder?". */
  headline?: string;
  /** Optional subtitle shown under the title on the email step. Defaults to
   *  "we'll send a one-time code to confirm." */
  subhead?: string;
  onClose: () => void;
  /** Fired after successful verify. Caller decides what to do next. */
  onAuthed: (user: AuthedUser) => void;
  /** Telemetry tag identifying which CTA opened the dialog. */
  source?: string;
}

type Step =
  | { kind: "email"; error: string | null }
  | { kind: "code"; email: string; error: string | null; expiresIn: number; resendIn: number }
  | { kind: "done"; user: AuthedUser };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function describeFetchError(err: unknown): string {
  if (isAbortError(err)) {
    return "request timed out. check your network and try again.";
  }
  const message = err instanceof Error ? err.message : String(err);
  return `network error: ${message}`;
}

export function AuthDialog({
  open,
  headline = "where to route the reminder?",
  subhead = "we'll send a one-time code to confirm.",
  onClose,
  onAuthed,
  source = "unknown",
}: Props): React.ReactElement | null {
  const { capture } = usePostHog();
  const [step, setStep] = useState<Step>({ kind: "email", error: null });
  const [busy, setBusy] = useState(false);
  const succeededRef = useRef(false);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setStep({ kind: "email", error: null });
      setBusy(false);
      succeededRef.current = false;
      capture("audit_auth_dialog_opened", { source });
    }
  }, [capture, open, source]);

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (wasOpenRef.current && !succeededRef.current) {
      capture("audit_auth_dialog_dismissed", {
        source,
        step: step.kind,
      });
    }
    wasOpenRef.current = false;
  }, [capture, open, source, step.kind]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      if (step.kind === "email") emailInputRef.current?.focus();
      else if (step.kind === "code") codeInputRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [open, step.kind]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const resendActive = step.kind === "code" && step.resendIn > 0;
  useEffect(() => {
    if (!resendActive) return;
    const id = setInterval(() => {
      setStep((s) =>
        s.kind === "code" ? { ...s, resendIn: Math.max(0, s.resendIn - 1) } : s,
      );
    }, 1000);
    return () => clearInterval(id);
  }, [resendActive]);

  const requestCode = useCallback(
    async (email: string, opts: { isResend?: boolean } = {}): Promise<void> => {
      const { isResend = false } = opts;
      const setError = (msg: string) => {
        if (isResend) {
          setStep((s) => (s.kind === "code" ? { ...s, error: msg } : s));
        } else {
          setStep({ kind: "email", error: msg });
        }
      };
      setBusy(true);
      try {
        const res = await fetchWithTimeout("/api/auth/login-request", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          code?: string;
          message?: string;
          expires_in?: number;
          resend_available_in?: number;
          retry_after_secs?: number;
        };
        if (!res.ok) {
          let msg = body.message ?? "could not send code.";
          if (body.code === "rate_limited" && body.retry_after_secs !== undefined) {
            msg = `too many tries. wait ${body.retry_after_secs}s and try again.`;
          } else if (body.code === "upstream_unreachable") {
            msg = "api-server unreachable. check your network.";
          }
          setError(msg);
          return;
        }
        setStep({
          kind: "code",
          email,
          error: null,
          expiresIn: body.expires_in ?? 600,
          resendIn: body.resend_available_in ?? 30,
        });
      } catch (err) {
        setError(describeFetchError(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const verifyCode = useCallback(
    async (email: string, code: string): Promise<void> => {
      setBusy(true);
      try {
        const res = await fetchWithTimeout("/api/auth/login-verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, code }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          authenticated?: boolean;
          user?: AuthedUser;
          code?: string;
          message?: string;
        };
        if (!res.ok || !body.authenticated || !body.user) {
          let msg = body.message ?? "invalid code.";
          if (body.code === "invalid_code") msg = "wrong code, or it expired. try again.";
          setStep((s) =>
            s.kind === "code" ? { ...s, error: msg } : s,
          );
          return;
        }
        succeededRef.current = true;
        capture("audit_auth_dialog_succeeded", { source });
        setStep({ kind: "done", user: body.user });
        onAuthed(body.user);
      } catch (err) {
        const msg = describeFetchError(err);
        setStep((s) =>
          s.kind === "code" ? { ...s, error: msg } : s,
        );
      } finally {
        setBusy(false);
      }
    },
    [capture, onAuthed, source],
  );

  const onEmailSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (busy || step.kind !== "email") return;
      const fd = new FormData(e.currentTarget);
      const email = String(fd.get("email") ?? "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) {
        setStep({ kind: "email", error: "that doesn't look like an email." });
        return;
      }
      await requestCode(email);
    },
    [busy, step, requestCode],
  );

  const onCodeSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (busy || step.kind !== "code") return;
      const fd = new FormData(e.currentTarget);
      const code = String(fd.get("code") ?? "").trim();
      if (code.length < 4 || code.length > 12) {
        setStep((s) =>
          s.kind === "code" ? { ...s, error: "code is 4–12 characters." } : s,
        );
        return;
      }
      await verifyCode(step.email, code);
    },
    [busy, step, verifyCode],
  );

  const onResend = useCallback(async () => {
    if (step.kind !== "code" || step.resendIn > 0 || busy) return;
    await requestCode(step.email, { isResend: true });
  }, [step, busy, requestCode]);

  if (!open) return null;

  return (
    <div
      className="auth-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-dialog-title"
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

        <h2 id="auth-dialog-title" className="auth-headline">
          {headline}
        </h2>

        {step.kind === "email" && (
          <>
            <p className="auth-sub">{subhead}</p>
            <form onSubmit={onEmailSubmit} className="auth-form">
              <input
                ref={emailInputRef}
                id="auth-dialog-email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                spellCheck={false}
                placeholder="you@yourdomain.com"
                disabled={busy}
                className="auth-input"
                required
              />
              {step.error && <div className="auth-error">{step.error}</div>}
              <div className="auth-actions">
                <button type="submit" className="auth-btn primary" disabled={busy}>
                  {busy ? "sending…" : "send code"}
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
          </>
        )}

        {step.kind === "code" && (
          <>
            <p className="auth-sub">
              code sent to <span className="auth-email">{step.email}</span>.
              expires in {Math.ceil(step.expiresIn / 60)} min.
            </p>
            <form onSubmit={onCodeSubmit} className="auth-form">
              <input
                ref={codeInputRef}
                id="auth-dialog-code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                spellCheck={false}
                placeholder="123456"
                disabled={busy}
                className="auth-input auth-input-code"
                maxLength={12}
                required
              />
              {step.error && <div className="auth-error">{step.error}</div>}
              <div className="auth-actions">
                <button type="submit" className="auth-btn primary" disabled={busy}>
                  {busy ? "verifying…" : "verify"}
                </button>
                <button
                  type="button"
                  className="auth-btn"
                  onClick={onResend}
                  disabled={busy || step.resendIn > 0}
                >
                  {step.resendIn > 0
                    ? `resend in ${step.resendIn}s`
                    : "resend code"}
                </button>
              </div>
              <button
                type="button"
                className="auth-back"
                onClick={() => setStep({ kind: "email", error: null })}
                disabled={busy}
              >
                ← use a different email
              </button>
            </form>
          </>
        )}

        {step.kind === "done" && (
          <>
            <p className="auth-sub">
              <span className="auth-ok">✓</span> signed in as{" "}
              <span className="auth-email">{step.user.email}</span>.
            </p>
            <div className="auth-actions">
              <button type="button" className="auth-btn primary" onClick={onClose}>
                continue
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
