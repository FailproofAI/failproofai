"use client";

/**
 * Top-of-page re-audit affordance. Renders as a thin strip directly above
 * the IdentitySection — the first thing the eye lands on after the page
 * background. Mirrors `.arch-mast`'s dashed-bottom-border vocabulary so
 * the bar reads as a sibling band rather than a new component family.
 *
 * Three rendered states:
 *
 *   - "cached"  — shows `audited 3d ago` + a green pulse if fresh, an
 *                 amber `expires in 14h — re-audit to refresh` chip when
 *                 inside the last 24h of the 7-day window, and the
 *                 `[ re-audit ]` action on the right.
 *   - "expired" — collapses to a single banner: `your audit expired —
 *                 re-audit to refresh`, same action on the right.
 *   - "empty"   — `no audit yet`, action on the right. Mirrors the
 *                 existing empty-state CTA so the page never reads as
 *                 dead at first glance.
 *
 * Action button reuses `.share-btn` for visual continuity with the
 * existing `[ re-audit now ]` at the bottom of the report (return-section).
 */
import React, { useEffect, useState } from "react";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const TTL_MS = 7 * DAY_MS;
const EXPIRY_NOTE_THRESHOLD_MS = DAY_MS;

export type TopAuditBarMode = "cached" | "expired" | "empty";

export interface TopAuditBarProps {
  mode: TopAuditBarMode;
  /** ISO timestamp from the dashboard cache (or the expired-meta probe).
   *  Required for "cached" and "expired"; ignored for "empty". */
  cachedAt: string | null;
  /** True while a re-audit is in flight. Disables the button and swaps
   *  the label to `[ scanning… ]`. */
  isRunning: boolean;
  onRerun: () => void;
}

export function relativeTimeAgo(now: number, then: number): string {
  const ageMs = Math.max(0, now - then);
  if (ageMs < 90_000) return "just now";
  if (ageMs < 60 * 60_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < DAY_MS) return `${Math.round(ageMs / HOUR_MS)}h ago`;
  return `${Math.round(ageMs / DAY_MS)}d ago`;
}

export function timeUntilExpiry(now: number, cachedAtMs: number): string {
  const remainingMs = Math.max(0, cachedAtMs + TTL_MS - now);
  if (remainingMs < 60_000) return "<1m";
  if (remainingMs < 60 * 60_000) return `${Math.round(remainingMs / 60_000)}m`;
  if (remainingMs < DAY_MS) return `${Math.round(remainingMs / HOUR_MS)}h`;
  return `${Math.round(remainingMs / DAY_MS)}d`;
}

export function TopAuditBar({ mode, cachedAt, isRunning, onRerun }: TopAuditBarProps) {
  // Re-render once a minute so the relative-time string stays current
  // without forcing a full page poll. Cheap — one state bump per minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const cachedAtMs = cachedAt ? new Date(cachedAt).getTime() : null;
  const validCachedAt = cachedAtMs !== null && !Number.isNaN(cachedAtMs);
  const ageMs = validCachedAt ? now - cachedAtMs : null;
  const remainingMs = validCachedAt ? cachedAtMs + TTL_MS - now : null;
  const expiringSoon =
    mode === "cached"
    && remainingMs !== null
    && remainingMs <= EXPIRY_NOTE_THRESHOLD_MS
    && remainingMs > 0;

  const buttonLabel = isRunning ? "[ scanning… ]" : "[ re-audit ]";

  // The bar is a single horizontal band: left = status, center = optional
  // amber note (only when expiring soon), right = action button. On narrow
  // viewports it wraps to two rows.
  return (
    <div
      className={
        "top-audit-bar"
        + (mode === "expired" ? " top-audit-bar--expired" : "")
        + (mode === "empty" ? " top-audit-bar--empty" : "")
      }
      role="region"
      aria-label="audit status"
    >
      <div className="top-audit-bar__left">
        {mode === "cached" && validCachedAt && ageMs !== null && (
          <>
            <span className="top-audit-bar__label">
              <span className="top-audit-bar__glyph">━━</span> last audit
            </span>
            <span
              className={
                "top-audit-bar__time"
                + (ageMs < HOUR_MS ? " top-audit-bar__time--fresh" : "")
              }
            >
              <span className="top-audit-bar__dot" aria-hidden="true" />
              audited {relativeTimeAgo(now, cachedAtMs!)}
            </span>
          </>
        )}
        {mode === "expired" && (
          <>
            <span className="top-audit-bar__label top-audit-bar__label--warn">
              <span className="top-audit-bar__glyph">━━</span> audit expired
            </span>
            <span className="top-audit-bar__expired-copy">
              your audit aged past 7d — re-audit to refresh
            </span>
          </>
        )}
        {mode === "empty" && (
          <>
            <span className="top-audit-bar__label">
              <span className="top-audit-bar__glyph">━━</span> no audit yet
            </span>
            <span className="top-audit-bar__time">
              run one to see your archetype
            </span>
          </>
        )}
      </div>

      {expiringSoon && remainingMs !== null && (
        <div className="top-audit-bar__center" aria-live="polite">
          <span className="top-audit-bar__amber-dot" aria-hidden="true" />
          expires in {timeUntilExpiry(now, cachedAtMs!)} — re-audit to refresh
        </div>
      )}

      <div className="top-audit-bar__right">
        <button
          type="button"
          className="share-btn top-audit-bar__btn"
          onClick={onRerun}
          disabled={isRunning}
          data-state={isRunning ? "scanning" : "idle"}
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}
