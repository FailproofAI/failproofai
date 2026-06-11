"use client";

/**
 * Fake-progress UI shown while /api/audit/run is in flight. runAudit() does
 * not emit granular progress events, so we animate through 4 plausible
 * stages on a fixed 4s interval. The user sees motion + a clear "this is
 * still working" signal.
 *
 * Real runs take up to 30 seconds. The 4 stages would otherwise march
 * straight to 4/4 and 100% well before the run actually resolves, so we:
 *   - hold on the last stage in a "finishing up" label
 *   - cap the visual bar at 90% until the parent unmounts this component
 *
 * Visual: audit pixel-craft. A `.panel` with pink corner brackets, a
 * scanline-style spinner header, a stack of stages with green "✓" /
 * pink "▮▮" / dim "○" markers, and a marquee progress bar at the bottom
 * filling pink-on-dark as the run advances.
 */
import React, { useEffect, useState } from "react";

const STAGES = [
  { label: "discovering transcripts", detail: "walking ~/.claude, ~/.codex, ~/.cursor, …" },
  { label: "parsing session logs",   detail: "reading JSONL + sqlite session stores" },
  { label: "running policy checks",  detail: "replaying through 30 builtin policies" },
  { label: "aggregating results",    detail: "counting hits, ranking by frequency" },
];

const STAGE_DURATION_MS = 4000;
/** Visual cap until the actual run resolves. The component is unmounted
 *  by the parent on completion — there is no "hit 100%" frame from here. */
const MAX_DISPLAY_PROGRESS = 0.9;

export function RunProgress() {
  const [stage, setStage] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const stageTimer = setInterval(() => {
      setStage((s) => Math.min(s + 1, STAGES.length - 1));
    }, STAGE_DURATION_MS);
    const tickTimer = setInterval(() => setTick((t) => (t + 1) % 4), 350);
    return () => {
      clearInterval(stageTimer);
      clearInterval(tickTimer);
    };
  }, []);

  const dots = ".".repeat(tick + 1);
  const onLastStage = stage === STAGES.length - 1;
  const barRatio = Math.min(MAX_DISPLAY_PROGRESS, ((stage + 1) / STAGES.length) * MAX_DISPLAY_PROGRESS);
  const barPercent = Math.round(barRatio * 100);

  return (
    <section className="section running-section" data-screen-label="00 Running">
      <div className="section-mast">
        <div className="section-label">
          <span className="glyph">━━</span> audit{" "}
          <span style={{ color: "var(--dim)" }}>·</span> in progress
        </div>
        <div className="section-meta">
          <span style={{ color: "var(--accent-pink)" }}>●</span> scanning
        </div>
      </div>
      <h2 className="section-h">scanning sessions{dots}</h2>

      <div className="panel running-panel">
        <div className="running-header">
          <span className="running-prompt">$</span>
          <span className="running-cmd">failproofai audit</span>
          <span className="running-cursor" aria-hidden="true">▮</span>
        </div>

        <ul className="running-stages">
          {STAGES.map((s, i) => {
            const done = i < stage;
            const active = i === stage;
            return (
              <li
                key={i}
                className={"running-stage" + (done ? " done" : active ? " active" : " queued")}
              >
                <span className="running-marker" aria-hidden="true">
                  {done ? "✓" : active ? "▮▮" : "○"}
                </span>
                <div className="running-stage-body">
                  <div className="running-stage-label">{s.label}</div>
                  {active && (
                    <div className="running-stage-detail">
                      {onLastStage ? "finishing up…" : s.detail}
                    </div>
                  )}
                </div>
                {active && (
                  <span className="running-stage-spin" aria-hidden="true">
                    {["⠋", "⠙", "⠹", "⠸"][tick]}
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        <div className="running-bar-label">
          <span>progress</span>
          <span style={{ color: "var(--dim)" }}>{barPercent}%</span>
        </div>
        <div className="running-bar-track">
          <div
            className="running-bar-fill"
            style={{ width: `${barPercent}%` }}
          />
        </div>

        <p className="running-foot">
          this can take a while depending on how much session history you have.
        </p>
      </div>
    </section>
  );
}
