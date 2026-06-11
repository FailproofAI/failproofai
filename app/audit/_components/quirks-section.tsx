"use client";

/**
 * Section 03 — QUIRKS. "what to improve."
 *
 * 4-column table: when · what slipped (+ policy that would've caught it) ·
 * severity pill · recurrence. Each row corresponds to a triggered
 * detector. No per-finding card chrome, no 4-quad body, no corner
 * crosshairs — evidence and fix live in section 04 (How to improve).
 */
import React from "react";
import type { FindingCard } from "@/src/audit/findings";

interface Props {
  findings: FindingCard[];
}

type Severity = "low" | "medium" | "high";

/** Heuristic severity from occurrence count — until the audit pipeline
 *  carries a real severity field. Tuned so a single occurrence reads as
 *  low and >5 reads as high. */
function severityFromCount(count: number): Severity {
  if (count >= 6) return "high";
  if (count >= 2) return "medium";
  return "low";
}

function recurrenceLabel(count: number): string {
  if (count <= 1) return "new";
  if (count < 10) return `${count}× seen`;
  return "recurring";
}

export function QuirksSection({ findings }: Props) {
  if (findings.length === 0) return null;

  return (
    <section className="audit-sec" data-screen-label="03 Quirks">
      <div className="audit-sec-head">
        <span className="audit-sec-eyebrow">
          <span className="ix">03</span>{"// quirks"}
        </span>
        <span className="audit-sec-meta">{findings.length} slipped through</span>
      </div>
      <h2 className="audit-sec-title">what to improve</h2>

      <div className="quirks-table">
        <div className="quirks-thead">
          <span>when</span>
          <span>what slipped</span>
          <span>severity</span>
          <span>seen</span>
        </div>
        {findings.map((f) => {
          const sev = severityFromCount(f.count);
          return (
            <div key={f.sourceSlug} className="quirks-row">
              <span className="q-when">{f.lastSeen}</span>
              <span className="q-what">
                <span className="q-title">{f.title}</span>
                <span className="q-policy">
                  would&apos;ve been caught by:{" "}
                  <code>{f.policy}</code>
                </span>
              </span>
              <span className={`q-pill q-pill-${sev}`}>{sev}</span>
              <span className="q-recur">{recurrenceLabel(f.count)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
