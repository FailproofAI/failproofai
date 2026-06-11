"use client";

/**
 * Two-mode empty state for /audit, styled to the audit pixel-craft system:
 *
 *   - "no-cache" — first time the user visits /audit. CTA to run.
 *   - "zero-sessions" — ran a scan but no transcripts were found. Likely the
 *     user hasn't installed hooks for any CLI yet.
 *
 * Both modes use the shared `.panel` chrome with pink corner brackets, a
 * green section eyebrow, a Bitcount Prop Single display headline, and a
 * sharp `.btn-press` action button. Sized so it occupies the same vertical
 * space as the loaded dashboard does on its hero — no more cramped popover.
 */
import React from "react";
import { triggerRun } from "./rerun-button";
import { usePostHog } from "@/contexts/PostHogContext";

interface Props {
  mode: "no-cache" | "zero-sessions";
  running: boolean;
  onStarted: () => void;
  onCompleted: () => Promise<void> | void;
}

export function EmptyState({ mode, running, onStarted, onCompleted }: Props) {
  const { capture } = usePostHog();
  const handleRun = async () => {
    capture("audit_first_run_clicked", {
      source: "empty_state",
      mode,
    });
    onStarted();
    try {
      // since:"all" — scan the user's entire session history, not a window.
      await triggerRun({ cli: [], since: "all" });
    } catch (err) {
      // A failed first run falls back to the empty state via onCompleted's
      // refetch (no cache was written). Swallow here so it doesn't surface as
      // an unhandled promise rejection on the click handler.
      console.error("audit first run failed:", err);
    } finally {
      await onCompleted();
    }
  };

  if (mode === "no-cache") {
    return (
      <section className="section empty-section" data-screen-label="00 Empty">
        <div className="section-mast">
          <div className="section-label">
            <span className="glyph">━━</span> audit{" "}
            <span style={{ color: "var(--dim)" }}>·</span> first run
          </div>
          <div className="section-meta">
            <span style={{ color: "var(--dim)" }}>○</span> no cache yet
          </div>
        </div>
        <h2 className="section-h">scan and see.</h2>

        <div className="panel empty-panel">
          <div className="empty-glyph" aria-hidden="true">
            <div className="empty-glyph-grid">
              {Array.from({ length: 36 }).map((_, i) => {
                // Form the word "GO" inside an 8x6 grid using a sparse hard-coded
                // mask. Pure decoration — the grid layout sells the pixel-craft.
                const on = ["1", "5", "8", "10", "13", "17", "20", "23", "25", "30", "32"].includes(String(i));
                return <span key={i} className={"px" + (on ? " on" : "")} />;
              })}
            </div>
            <div className="empty-glyph-label">▮▮ no audit data yet</div>
          </div>

          <h3 className="empty-headline">run your first audit.</h3>
          <p className="empty-sub">
            we&apos;ll walk every transcript across your installed CLIs — Claude Code,
            Codex, Copilot, Cursor, OpenCode, Pi, Gemini — and count every wasteful
            or risky action. you&apos;ll get a tier, a score, and a punch-list.
          </p>

          <div className="empty-actions">
            <button
              type="button"
              className="btn btn-primary btn-press empty-cta"
              onClick={handleRun}
              disabled={running}
            >
              {running ? "[ scanning… ]" : "[ run audit ]"}
            </button>
            <span className="empty-meta">
              scans all sessions · all installed CLIs · may take a while
            </span>
          </div>
        </div>
      </section>
    );
  }

  // mode === "zero-sessions"
  return (
    <section className="section empty-section" data-screen-label="00 Empty">
      <div className="section-mast">
        <div className="section-label">
          <span className="glyph">━━</span> audit{" "}
          <span style={{ color: "var(--dim)" }}>·</span> zero transcripts
        </div>
        <div className="section-meta">
          <span style={{ color: "var(--amber)" }}>●</span> hooks not installed
        </div>
      </div>
      <h2 className="section-h">nothing to read.</h2>

      <div className="panel empty-panel">
        <div className="empty-glyph" aria-hidden="true">
          <div className="empty-glyph-grid">
            {Array.from({ length: 36 }).map((_, i) => {
              const on = ["2", "4", "9", "11", "16", "18", "23", "25", "27", "30", "33"].includes(String(i));
              return <span key={i} className={"px" + (on ? " on" : "")} />;
            })}
          </div>
          <div className="empty-glyph-label">▮▮ no sessions found</div>
        </div>

        <h3 className="empty-headline">install hooks first.</h3>
        <p className="empty-sub">
          failproofai couldn&apos;t find any transcripts to scan on this machine.
          install the hooks for at least one CLI and come back.
        </p>

        <div className="empty-actions">
          <a
            href="https://docs.befailproof.ai/getting-started"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary btn-press empty-cta"
            onClick={() => {
              capture("audit_install_guide_clicked", {
                source: "empty_state",
                mode,
              });
            }}
          >
            [ install guide → ]
          </a>
          <span className="empty-meta">
            takes about 30 seconds · one command per CLI
          </span>
        </div>
      </div>
    </section>
  );
}
