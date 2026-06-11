"use client";

/**
 * Section 02 — STRENGTHS. "what it's great at." Calm row list:
 * ✓ glyph · headline + sub · right-aligned metric. No card chrome,
 * no hover backgrounds, no checkmark backdrop.
 */
import React from "react";
import type { Strength } from "@/src/audit/strengths";

interface Props {
  strengths: Strength[];
}

export function StrengthsSection({ strengths }: Props) {
  if (strengths.length === 0) return null;

  return (
    <section className="audit-sec" data-screen-label="02 Strengths">
      <div className="audit-sec-head">
        <span className="audit-sec-eyebrow">
          <span className="ix">02</span>{"// strengths"}
        </span>
        <span className="audit-sec-meta">{strengths.length} standouts</span>
      </div>
      <h2 className="audit-sec-title">what it&apos;s great at</h2>

      <div className="strength-list">
        {strengths.map((s, i) => (
          <div key={i} className="strength-row">
            <span className="strength-check" aria-hidden="true">✓</span>
            <span className="strength-body">
              <span className="strength-headline">{s.headline}</span>
              <span className="strength-detail">{s.detail}</span>
            </span>
            <span className="strength-metric">
              {s.metric}
              {s.unit && <span className="unit">{s.unit}</span>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
