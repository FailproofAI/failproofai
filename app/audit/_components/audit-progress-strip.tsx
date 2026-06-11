"use client";

/**
 * Fixed banner pinned to the top of the viewport during a re-audit run —
 * but only once the in-flow `TopAuditBar` has scrolled out of view. The bar
 * itself owns the at-top display of the scanning/failed states (inline, on
 * its decay gauge), so this strip is the *scroll echo*: it surfaces the same
 * status for users who've scrolled deep into the long report.
 *
 * Gating on scroll is what kills the old "two stacked status bands at the
 * top" look — at the top there is exactly one band (the bar); past it,
 * exactly one band (this strip). `position: fixed` (not sticky) means
 * mounting it mid-scroll never reflows the document, so there's no content
 * jump when a run starts.
 *
 * Visual vocabulary matches the page:
 *   - pink hard-offset border (echoes `.share-btn:hover`),
 *   - mono lowercase,
 *   - thin pulse on the right edge driven by a CSS keyframe so we don't
 *     fake progress precision we don't have.
 *
 * Reuses the existing `RerunError.kind` discrimination to render a red
 * error strip with kind-specific copy when a run dies. `ERROR_COPY` is
 * exported so the bar's inline failed state uses the exact same copy.
 */
import React, { useEffect, useRef, useState } from "react";
import type { RerunError } from "./rerun-button";

export type RerunStatus =
  | { kind: "idle" }
  | { kind: "running"; startedAt: number }
  | { kind: "failed"; reason: RerunError["kind"]; failedAt: number };

interface Props {
  status: RerunStatus;
  /** Lets the user dismiss the red error strip without re-trying. */
  onDismiss: () => void;
}

export const ERROR_COPY: Record<RerunError["kind"], string> = {
  timeout: "audit took too long — try again",
  network: "network hiccup — check your connection",
  post_failed: "audit failed to start — try again",
};

export function formatElapsed(ms: number): string {
  if (ms < 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const mm = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const ss = (totalSeconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export function AuditProgressStrip({ status, onDismiss }: Props) {
  // Tick once a second only while running. setInterval is cheaper than
  // requestAnimationFrame for a one-second display update.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status.kind !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status.kind]);

  // Only surface once the in-flow `TopAuditBar` has scrolled fully above the
  // viewport — until then the bar itself is showing this exact status on its
  // gauge, and a second fixed band would just double it. Measured against the
  // live bar element so it's robust to the bar wrapping to two rows on narrow
  // viewports (no magic scroll offset).
  const [pastBar, setPastBar] = useState(false);
  const barRef = useRef<Element | null>(null);
  useEffect(() => {
    if (status.kind === "idle") return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      let bar = barRef.current;
      if (!bar || !bar.isConnected) {
        bar = document.querySelector(".top-audit-bar");
        barRef.current = bar;
      }
      // Bar's bottom edge at/above the viewport top ⇒ it's scrolled away.
      // Fallback (no bar in tree) trips the strip once past a small offset.
      const barBottom = bar ? bar.getBoundingClientRect().bottom : 64 - window.scrollY;
      setPastBar(barBottom <= 0);
    };
    const onScroll = () => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [status.kind]);

  if (status.kind === "idle" || !pastBar) return null;

  if (status.kind === "running") {
    const elapsed = Math.max(0, now - status.startedAt);
    return (
      <div className="audit-progress-strip" role="status" aria-live="polite">
        <div className="audit-progress-strip__inner">
          <span className="audit-progress-strip__label">
            <span className="audit-progress-strip__spinner" aria-hidden="true" />
            re-auditing your sessions
          </span>
          <span className="audit-progress-strip__elapsed">
            {formatElapsed(elapsed)}
          </span>
        </div>
        <div className="audit-progress-strip__pulse" aria-hidden="true" />
      </div>
    );
  }

  // kind === "failed"
  return (
    <div
      className="audit-progress-strip audit-progress-strip--failed"
      role="alert"
    >
      <div className="audit-progress-strip__inner">
        <span className="audit-progress-strip__label">
          <span className="audit-progress-strip__x" aria-hidden="true">×</span>
          {ERROR_COPY[status.reason]}
        </span>
        <button
          type="button"
          className="audit-progress-strip__dismiss"
          onClick={onDismiss}
          aria-label="dismiss"
        >
          [ dismiss ]
        </button>
      </div>
    </div>
  );
}
