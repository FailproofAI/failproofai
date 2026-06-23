"use client";

/**
 * Section 01 — AUDIT POSTER. The single-screen shareable above-the-fold
 * artifact. Replaces the old IdentitySection + ScoreSection + ShareDock
 * triumvirate.
 *
 * Layout (inside the PNG capture region):
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  ▣ failproof_ai · audit       № 01 of 08 · audited <date>   │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │                                                             │
 *   │   <score>/100    the optimist            ▓░▓░▓░▓░           │
 *   │   <rank>         pace · conviction · forgetful  ░▓░▓░▓░▓    │
 *   │                  // only N% of agents are this archetype   │
 *   │                                                             │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │                                  audit yours → failproof.ai │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Outside the capture region: three share buttons + scroll hint.
 */
import React, { forwardRef, useMemo, useState } from "react";
import { pickArchetypeVariant, type ArchetypeKey } from "@/src/audit/archetypes";
import { type Grade } from "@/src/audit/scoring";
import { getArchetypeRarityPct } from "@/src/audit/social-proof";
import { copyOrDownloadCard, downloadCard, shareCardNative, shareCardToastMessage } from "@/lib/share-card";
import { toast } from "@/app/components/toast";
import { usePostHog } from "@/contexts/PostHogContext";
import { Sigil } from "./sigil";
import { X_TEMPLATES, LI_TEMPLATES, pickTemplate, type ShareCtx } from "./share-templates";

const X_INTENT = (text: string) =>
  `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
// LinkedIn deprecated the share-offsite `summary` / `title` params, so they no
// longer pre-fill the post composer (it only scrapes OG tags from the URL). The
// feed route with `shareActive=true` + `text=` opens "start a post" with our
// text pre-filled — and the share templates already embed the befailproof.ai
// link inside that text.
const LI_INTENT = (text: string) =>
  `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`;

interface Props {
  archetypeKey: ArchetypeKey;
  /** Stable seed for variant selection (project name is the natural fit). */
  seed: string;
  score: number;
  grade: Grade;
  /** Count of unenabled prescribed policies — passed to the share-text
   *  templates, not rendered on the poster itself. */
  missing: number;
  /** Audit timestamp (ISO string from cache). Rendered as ISO date in the
   *  top-right meta. UTC to keep the poster timezone-stable across shares. */
  auditedAt: string;
}

export const AuditPoster = forwardRef<HTMLDivElement, Props>(function AuditPoster(
  { archetypeKey, seed, score, grade, missing, auditedAt }: Props,
  posterRef,
) {
  const archetype = useMemo(
    () => pickArchetypeVariant(archetypeKey, seed),
    [archetypeKey, seed],
  );
  const rarityPct = getArchetypeRarityPct(archetypeKey);
  const indexLabel = String(archetype.index).padStart(2, "0");
  const auditedDate = useMemo(() => formatAuditedDate(auditedAt), [auditedAt]);

  const { capture } = usePostHog();
  const [busy, setBusy] = useState<null | "x" | "linkedin" | "download">(null);

  const captureCardBlob = async (): Promise<Blob | null> => {
    const node = (posterRef as React.MutableRefObject<HTMLDivElement | null>)?.current;
    if (!node) return null;
    // Capture via html-to-image instead of html2canvas. The former
    // serializes the DOM into an SVG <foreignObject> and rasterizes
    // it through the browser's native rendering engine — so dashed
    // borders, the SVG logo, gradients, and font metrics render
    // exactly as they do on screen. html2canvas reimplements CSS
    // in JS and was producing broken dashes and a stray pink square
    // on the logo's mask.
    if (typeof document !== "undefined" && document.fonts?.ready) await document.fonts.ready;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    // Clone the poster into an off-screen container with a fixed width
    // so html-to-image captures a self-contained subtree. The live
    // .poster sits inside a flex column (.poster-section's flex: 1)
    // and uses margin: 0 auto for centering — capturing it directly
    // inherits that parent context, which shifts content within an
    // oversized canvas. The clone has no such context.
    const liveRect = node.getBoundingClientRect();
    const captureWidth = Math.round(liveRect.width);
    const captureHeight = Math.round(liveRect.height);

    const wrapper = document.createElement("div");
    wrapper.style.cssText = [
      "position: fixed",
      "left: -10000px",
      "top: 0",
      `width: ${captureWidth}px`,
      `height: ${captureHeight}px`,
      "padding: 0",
      "margin: 0",
      "background: var(--bg)",
      "z-index: -1",
      "pointer-events: none",
    ].join(";");

    const clone = node.cloneNode(true) as HTMLElement;
    clone.style.cssText += [
      "",
      `width: ${captureWidth}px`,
      `height: ${captureHeight}px`,
      "max-width: none",
      "min-width: 0",
      "flex: 0 0 auto",
      "margin: 0",
    ].join(";");

    wrapper.appendChild(clone);
    document.body.appendChild(wrapper);

    try {
      const { toBlob } = await import("html-to-image");
      return await toBlob(clone, {
        backgroundColor: "#0e0e11",
        pixelRatio: 2,
        cacheBust: true,
        width: captureWidth,
        height: captureHeight,
      });
    } finally {
      wrapper.remove();
    }
  };

  const filenameFor = (channel: "x" | "linkedin" | "download") =>
    `failproofai-${channel}-${grade.toLowerCase()}-${score}.png`;

  const handleShare = async (channel: "x" | "linkedin" | "download") => {
    if (busy) return;
    setBusy(channel);
    capture("audit_card_share_clicked", {
      channel,
      source: "poster",
      score,
      grade,
      missing_policies: missing,
    });
    try {
      const blob = await captureCardBlob().catch(() => null);
      if (!blob) {
        capture("audit_card_capture_completed", {
          trigger: channel === "download" ? "download" : `share_${channel}`,
          status: "error",
          image_method: "failed",
          source: "poster",
        });
        toast(shareCardToastMessage("failed"));
        return;
      }

      if (channel === "download") {
        const ok = downloadCard(blob, filenameFor(channel));
        const method = ok ? "download" : "failed";
        capture("audit_card_capture_completed", {
          trigger: "download",
          status: ok ? "success" : "error",
          image_method: method,
          source: "poster",
        });
        toast(shareCardToastMessage(method));
        return;
      }

      const shareCtx: ShareCtx = {
        score,
        arch: archetype.name.toLowerCase(),
        grade,
        missing,
      };
      const shareText = channel === "x"
        ? pickTemplate(X_TEMPLATES, seed, shareCtx)
        : pickTemplate(LI_TEMPLATES, seed, shareCtx);
      const native = await shareCardNative(blob, filenameFor(channel), shareText);
      if (native) {
        capture("audit_card_capture_completed", {
          trigger: `share_${channel}`,
          status: "success",
          image_method: "native",
          source: "poster",
        });
        toast(shareCardToastMessage("native"));
        return;
      }

      const fallbackMethod = await copyOrDownloadCard(blob, filenameFor(channel));
      capture("audit_card_capture_completed", {
        trigger: `share_${channel}`,
        status: fallbackMethod === "failed" ? "error" : "success",
        image_method: fallbackMethod,
        source: "poster",
      });
      toast(shareCardToastMessage(fallbackMethod));
      const intent = channel === "x" ? X_INTENT(shareText) : LI_INTENT(shareText);
      globalThis.open(intent, "_blank", "noopener,noreferrer");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="poster-section" data-screen-label="01 Poster">
      <div className="poster" ref={posterRef}>
        <header className="poster-head">
          <span className="poster-wordmark">
            <img
              src="/logo.svg"
              alt="failproof_ai"
              className="poster-logo"
            />
            <span className="poster-sep">·</span> audit
          </span>
          <span className="poster-meta">
            <span className="poster-ix">№ {indexLabel}</span>
            <span className="of"> of 08</span>
            <span className="poster-sep"> · </span>
            audited {auditedDate}
          </span>
        </header>

        <div className="poster-body">
          {/* Sigil — visual anchor at the top of the centered stack */}
          <div className="poster-sigil">
            <Sigil archetypeKey={archetypeKey} />
          </div>

          {/* Persona block — name + keywords + rarity, centered */}
          <div className="poster-persona">
            <h1 className="persona-name">{archetype.name}</h1>
            <div className="persona-keywords">
              {archetype.keywords.map((k, i) => (
                <React.Fragment key={k}>
                  <span className={`kw kw-${i}`}>{k}</span>
                  {i < archetype.keywords.length - 1 && (
                    <span className="kw-sep">·</span>
                  )}
                </React.Fragment>
              ))}
            </div>
            {typeof rarityPct === "number" && (
              <div className="persona-rarity">
                <span className="lbl">{"// only"}</span>{" "}
                <span className="pct">{rarityPct}%</span>{" "}
                <span className="lbl">of agents are this archetype</span>
              </div>
            )}
          </div>

          {/* Score block — heroic number, centered in the card */}
          <div className="poster-score">
            <span className="score-n">{score}</span>
            <span className="score-of">/100</span>
          </div>
        </div>

        <footer className="poster-foot">
          <span className="poster-brand">befailproof.ai</span>
          <span className="poster-cta">
            audit yours <span className="arrow">→</span>{" "}
            <span className="cta-cmd">npx -y failproofai audit</span>
          </span>
        </footer>
      </div>

      <div className="poster-share-row">
        <button
          type="button"
          className="poster-share-btn"
          onClick={() => handleShare("x")}
          disabled={busy !== null}
        >
          <span className="mark" aria-hidden="true">𝕏</span>
          {busy === "x" ? "rendering…" : "post your archetype"}
        </button>
        <button
          type="button"
          className="poster-share-btn"
          onClick={() => handleShare("linkedin")}
          disabled={busy !== null}
        >
          <span className="mark" aria-hidden="true">in</span>
          {busy === "linkedin" ? "rendering…" : "share on linkedin"}
        </button>
        <button
          type="button"
          className="poster-share-btn"
          onClick={() => handleShare("download")}
          disabled={busy !== null}
        >
          <span className="mark" aria-hidden="true">↓</span>
          {busy === "download" ? "rendering…" : "download poster"}
        </button>
      </div>

      <div className="poster-scroll-hint" aria-hidden="true">
        scroll for full report <span className="arrow">↓</span>
      </div>
    </section>
  );
});

/** UTC ISO date (YYYY-MM-DD) so the poster's date stays timezone-stable
 *  across the geographies it gets shared into. */
function formatAuditedDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch {
    return iso;
  }
}
