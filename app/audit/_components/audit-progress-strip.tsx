"use client";

/**
 * Sticky banner pinned to the top of the viewport during a re-audit run.
 * Lifted from the bottom `[ scanning… ]` button so the user has a clear,
 * persistent signal that work is in progress regardless of scroll
 * position.
 *
 * Visual vocabulary matches the page:
 *   - pink hard-offset left border (echoes `.share-btn:hover`),
 *   - mono lowercase,
 *   - thin pulse on the right edge driven by a CSS keyframe so we don't
 *     fake progress precision we don't have.
 *
 * Reuses the existing `RerunError.kind` discrimination to render a red
 * error strip with kind-specific copy when a run dies.
 */
import React, { useEffect, useState } from "react";
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

const ERROR_COPY: Record<RerunError["kind"], string> = {
  timeout: "audit took too long — try again",
  network: "network hiccup — check your connection",
  post_failed: "audit failed — try again",
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

  if (status.kind === "idle") return null;

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
