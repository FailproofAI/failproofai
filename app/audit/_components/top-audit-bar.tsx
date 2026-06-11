"use client";

/**
 * Top-of-page re-audit affordance — a thin instrument band directly above
 * the IdentitySection, the first thing the eye lands on after the page
 * background.
 *
 * Its signature is the **decay gauge**: a segmented meter that visualises how
 * much of the 7-day cache TTL remains. It drains left→right as the audit ages
 * and shifts green → amber → pink near expiry. One graphic carries both
 * "time since" and "time until", so there's no redundant `last audit audited
 * 12h ago` word-doubling and no separate amber "expires in 14h" chip.
 *
 * The band is the single status surface at the top of the page: it folds the
 * in-flight (scanning) and failed states inline, on the same gauge, instead of
 * stacking a second banner above itself. The sticky `AuditProgressStrip` only
 * takes over once this band has scrolled out of view.
 *
 * Resolved visual states (`data-state`):
 *   fresh    — audited <1h ago, gauge full + green
 *   aging    — audited hours/days ago, gauge draining, still green
 *   soon     — within 24h of the TTL boundary, gauge near-empty + amber
 *   expired  — aged past 7d, gauge spent + pink
 *   empty    — never audited, gauge unlit placeholder
 *   scanning — re-audit in flight, gauge runs an indeterminate fill sweep
 *   failed   — re-audit died, gauge frozen + inline error + dismiss
 *
 * The re-audit button surfaces the behaviour change: clicking it clears the
 * cache and runs a genuinely fresh scan (`clears cache · fresh scan`).
 */
import React, { useEffect, useState } from "react";
import {
  ERROR_COPY,
  formatElapsed,
  type RerunStatus,
} from "./audit-progress-strip";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const TTL_MS = 7 * DAY_MS;
const EXPIRY_NOTE_THRESHOLD_MS = DAY_MS;

/** Cell count of the decay gauge. 24 reads as a crisp segmented meter at the
 *  band's clamp()'d width without becoming visual noise. */
export const GAUGE_SEGMENTS = 24;

export type TopAuditBarMode = "cached" | "expired" | "empty";

/** The single resolved visual the band renders. */
type Visual = "fresh" | "aging" | "soon" | "expired" | "empty" | "scanning" | "failed";

export interface TopAuditBarProps {
  mode: TopAuditBarMode;
  /** ISO timestamp from the dashboard cache (or the expired-meta probe).
   *  Required for "cached" and "expired"; ignored for "empty". */
  cachedAt: string | null;
  /** True while a re-audit is in flight (from any trigger). Drives the
   *  scanning display even when `rerunStatus` is idle (the empty-state
   *  first-run path drives `isRunning` directly, not `rerunStatus`). */
  isRunning: boolean;
  /** Lifted re-audit lifecycle — adds the elapsed readout while scanning and
   *  the inline error copy + dismiss when a run fails. */
  rerunStatus: RerunStatus;
  onRerun: () => void;
  /** Clears a failed run's inline error without retrying. */
  onDismiss: () => void;
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

/** Two-unit "valid for" readout shown beside the gauge in the healthy states,
 *  e.g. `6d 23h` or `21h 40m`. Distinct from `timeUntilExpiry` (single unit,
 *  used for the urgent "expires in 12h" copy). */
export function freshnessRemainingLong(now: number, cachedAtMs: number): string {
  const remaining = Math.max(0, cachedAtMs + TTL_MS - now);
  const d = Math.floor(remaining / DAY_MS);
  const h = Math.floor((remaining % DAY_MS) / HOUR_MS);
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h`;
  const m = Math.floor((remaining % HOUR_MS) / 60_000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Lit-cell count for the gauge: a fraction of `GAUGE_SEGMENTS` proportional
 *  to TTL remaining. At least one cell stays lit while any time remains, so
 *  the meter never reads as fully spent until it actually is. */
export function freshnessLitCells(remainingMs: number | null): number {
  if (remainingMs === null || remainingMs <= 0) return 0;
  const pct = Math.min(1, remainingMs / TTL_MS);
  return Math.min(GAUGE_SEGMENTS, Math.max(1, Math.round(pct * GAUGE_SEGMENTS)));
}

export function TopAuditBar({
  mode,
  cachedAt,
  isRunning,
  rerunStatus,
  onRerun,
  onDismiss,
}: TopAuditBarProps) {
  // Re-render once a minute so the relative-time strings stay current without
  // a full page poll. Cheap — one state bump per minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const scanning = isRunning || rerunStatus.kind === "running";

  // Faster 1s tick, but only while a run is in flight, for the elapsed clock.
  // `elapsedNow` seeds to the current time on mount, so `elapsedNow - startedAt`
  // is already accurate when mounting mid-run; when a run starts later the
  // interval corrects it within a second (the clock reads 00:00 → 00:01…).
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => setElapsedNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [scanning]);

  const cachedAtMs = cachedAt ? new Date(cachedAt).getTime() : null;
  const validCachedAt = cachedAtMs !== null && !Number.isNaN(cachedAtMs);
  const remainingMs = validCachedAt ? cachedAtMs! + TTL_MS - now : null;
  const ageMs = validCachedAt ? Math.max(0, now - cachedAtMs!) : null;

  // Resolve the single visual. Failure wins (the user must see why a re-audit
  // died), then in-flight, then freshness derived from the cache age.
  let visual: Visual;
  if (rerunStatus.kind === "failed") {
    visual = "failed";
  } else if (scanning) {
    visual = "scanning";
  } else if (mode === "empty") {
    visual = "empty";
  } else if (mode === "expired" || (remainingMs !== null && remainingMs <= 0)) {
    visual = "expired";
  } else if (remainingMs !== null && remainingMs <= EXPIRY_NOTE_THRESHOLD_MS) {
    visual = "soon";
  } else if (ageMs !== null && ageMs < HOUR_MS) {
    visual = "fresh";
  } else {
    visual = "aging";
  }

  // Gauge lit-cell color grade. "aging" shares the green "fresh" grade — only
  // the eyebrow/rail accent differentiates the two.
  const grade = visual === "aging" ? "fresh" : visual;
  const litCount =
    visual === "fresh" || visual === "aging" || visual === "soon" || visual === "failed"
      ? freshnessLitCells(remainingMs)
      : 0;
  const pctRemaining =
    remainingMs !== null ? Math.round(Math.max(0, Math.min(1, remainingMs / TTL_MS)) * 100) : 0;

  const isMeter = visual === "fresh" || visual === "aging" || visual === "soon" || visual === "expired";

  // ── copy per visual ──────────────────────────────────────────────────
  // The elapsed clock is driven by the lifted `rerunStatus.startedAt`, so it
  // shows for re-audits from the top bar / return-section. The empty-state
  // first run drives `isRunning` only (no `rerunStatus`) and renders the
  // full-page RunProgress as its primary indicator, so the bar shows the
  // "scanning" label there without a redundant second clock.
  const elapsed =
    rerunStatus.kind === "running" ? formatElapsed(Math.max(0, elapsedNow - rerunStatus.startedAt)) : null;

  let eyebrow: React.ReactNode;
  let status: React.ReactNode;
  switch (visual) {
    case "fresh":
    case "aging":
      eyebrow = (
        <>last audit <b>{validCachedAt ? relativeTimeAgo(now, cachedAtMs!) : "recently"}</b></>
      );
      status = validCachedAt ? (
        <>valid <b>{freshnessRemainingLong(now, cachedAtMs!)}</b></>
      ) : (
        <>cached</>
      );
      break;
    case "soon":
      eyebrow = (
        <>last audit <b>{validCachedAt ? relativeTimeAgo(now, cachedAtMs!) : "recently"}</b></>
      );
      status = (
        <>expires in <b>{validCachedAt ? timeUntilExpiry(now, cachedAtMs!) : "<1d"}</b></>
      );
      break;
    case "expired":
      eyebrow = <b>audit expired</b>;
      status = <>aged past 7d — run a fresh scan</>;
      break;
    case "empty":
      eyebrow = <b>no audit yet</b>;
      status = <>run one to meet your archetype</>;
      break;
    case "scanning":
      eyebrow = <b>scanning</b>;
      // The elapsed clock is aria-hidden so the polite live region announces
      // "re-auditing your sessions" once, not a new value every second.
      status = (
        <>
          re-auditing your sessions{elapsed ? <> <b aria-hidden="true">{elapsed}</b></> : null}
          <span className="top-audit-bar__cursor" aria-hidden="true" />
        </>
      );
      break;
    case "failed":
      eyebrow = <b>scan failed</b>;
      status = <>{ERROR_COPY[rerunStatus.kind === "failed" ? rerunStatus.reason : "post_failed"]}</>;
      break;
  }

  // ── button per visual ────────────────────────────────────────────────
  const buttonLabel =
    visual === "scanning" ? "[ scanning… ]"
    : visual === "failed" ? "[ retry ]"
    : visual === "empty" ? "[ run audit ]"
    : "[ re-audit ]";
  const buttonSub =
    visual === "empty" ? "first scan · ~30s"
    : visual === "soon" ? "refresh before it lapses"
    : visual === "scanning" ? "fresh scan in progress"
    : "clears cache · fresh scan";
  const buttonPrimary = visual === "soon" || visual === "expired" || visual === "empty" || visual === "failed";

  const meterAria = isMeter
    ? {
        role: "meter" as const,
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": pctRemaining,
        "aria-label": `audit freshness: ${pctRemaining}% of the 7-day window remaining`,
      }
    : { "aria-hidden": true };

  return (
    <div className="top-audit-bar" data-state={visual} role="region" aria-label="audit status">
      <div className="top-audit-bar__lead">
        <span className="top-audit-bar__eyebrow">{eyebrow}</span>

        <div className="top-audit-bar__gauge" data-grade={grade} {...meterAria}>
          {Array.from({ length: GAUGE_SEGMENTS }).map((_, i) => {
            const lit = i < litCount;
            const edge = i === litCount - 1;
            return (
              <span
                key={i}
                className={
                  "top-audit-bar__cell"
                  + (lit ? " top-audit-bar__cell--lit" : "")
                  + (edge ? " top-audit-bar__cell--edge" : "")
                }
                aria-hidden="true"
              />
            );
          })}
          {visual === "scanning" && <span className="top-audit-bar__sweep" aria-hidden="true" />}
        </div>

        <span className="top-audit-bar__status" aria-live="polite">
          {status}
        </span>
      </div>

      <div className="top-audit-bar__action">
        {visual === "failed" && (
          <button
            type="button"
            className="top-audit-bar__dismiss"
            onClick={onDismiss}
            aria-label="dismiss error"
          >
            [ × ]
          </button>
        )}
        <button
          type="button"
          className="top-audit-bar__btn"
          data-variant={buttonPrimary ? "primary" : "default"}
          data-state={visual === "scanning" ? "scanning" : "idle"}
          onClick={onRerun}
          disabled={visual === "scanning"}
        >
          <span className="top-audit-bar__btn-main">
            {visual === "scanning" && <span className="top-audit-bar__spinner" aria-hidden="true" />}
            {buttonLabel}
          </span>
          <span className="top-audit-bar__btn-sub">{buttonSub}</span>
        </button>
      </div>
    </div>
  );
}
