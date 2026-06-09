"use client";

/**
 * Section 01 — IDENTITY. The hero. Big archetype name with hard-offset
 * stamp shadow, sigil to the right, keywords strip, "common in / primary
 * risk" meta grid, and the closing one-liner.
 *
 * Layout uses the ported `.archetype-frame` / `.arch-mast` / `.arch-body`
 * classes from audit-styles.css. Data sources from `src/audit/archetypes.ts`.
 *
 * The variant copy (tagline / keywords / common / risk / closing) is
 * picked deterministically from a multi-variant catalog using the `seed`
 * prop — typically the inferred project name. Same seed → same persona
 * blurb across renders; different seeds → different copy. So two users
 * who both land on "the optimist" see different language for it.
 *
 * Exposes a `frameRef` forwarded onto the `.archetype-frame` element so
 * the ShowOff "make poster" action can capture it via html2canvas.
 */
import React, { forwardRef, useMemo, useState } from "react";
import { ARCHETYPES, pickArchetypeVariant, type ArchetypeKey } from "@/src/audit/archetypes";
import { type Grade } from "@/src/audit/scoring";
import { usePostHog } from "@/contexts/PostHogContext";
import { Sigil } from "./sigil";
import {
  X_TEMPLATES,
  LI_TEMPLATES,
  pickTemplate,
  type ShareCtx,
} from "./share-templates";

const SITE_URL = "https://failproof.ai";
const X_INTENT = (text: string) =>
  `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
const LI_INTENT = (text: string) =>
  `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SITE_URL)}&summary=${encodeURIComponent(text)}`;


interface Props {
  archetypeKey: ArchetypeKey;
  secondaryKey: ArchetypeKey;
  toolCalls: number;
  sessions: number;
  /** "30d", "7d", etc. shown in the target line; "all time" otherwise. */
  window: string;
  /** Stable seed for variant selection (project name is the natural fit). */
  seed: string;
  score: number;
  grade: Grade;
  missing: number;
}

export const IdentitySection = forwardRef<HTMLDivElement, Props>(function IdentitySection(
  { archetypeKey, secondaryKey, toolCalls, sessions, window, seed, score, grade, missing }: Props,
  frameRef,
) {
  // `pickArchetypeVariant` re-hashes the seed string via djb2 + 4 mix
  // passes per axis. Deterministic over (archetypeKey, seed) so memoize
  // — the share buttons toggle `downloadState` which rerenders us 4×.
  const archetype = useMemo(
    () => pickArchetypeVariant(archetypeKey, seed),
    [archetypeKey, seed],
  );
  const secondary = secondaryKey !== archetypeKey ? ARCHETYPES[secondaryKey] : null;
  const { capture } = usePostHog();
  const [downloadState, setDownloadState] = useState<"idle" | "busy" | "done" | "error">("idle");

  const cardFilename = () => `failproofai-identity-${grade.toLowerCase()}-${score}.png`;

  /** Render the identity frame to a PNG blob (no side effects). */
  const captureCardBlob = async (): Promise<Blob | null> => {
    const node = typeof frameRef === "function" ? null : frameRef?.current;
    if (!node) return null;
    node.classList.add("capturing");
    try {
      if (typeof document !== "undefined" && document.fonts?.ready) await document.fonts.ready;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(node, {
        backgroundColor: "#0e0e11",
        scale: 2,
        logging: false,
        useCORS: true,
      });
      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => resolve(blob), "image/png");
      });
    } finally {
      node.classList.remove("capturing");
    }
  };

  const triggerDownload = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = cardFilename();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  /**
   * Share the post text together with the audit card. X / LinkedIn web
   * composers can't accept a programmatically-attached image, so:
   *   • where the browser supports file sharing (mobile + some desktop), use
   *     the native share sheet — the card image IS attached to the post; else
   *   • download the card (so the user can drag it in) AND open the platform's
   *     web composer with the text pre-filled.
   * Returns which path was taken (for telemetry).
   */
  const shareWithCard = async (text: string, intentUrl: string): Promise<"native" | "fallback"> => {
    const blob = await captureCardBlob().catch(() => null);
    const file = blob ? new File([blob], cardFilename(), { type: "image/png" }) : null;
    const nav = typeof navigator !== "undefined"
      ? (navigator as Navigator & { canShare?: (d?: ShareData) => boolean })
      : undefined;
    if (file && nav?.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], text });
        return "native";
      } catch {
        /* user cancelled or the share failed → fall through to the web intent */
      }
    }
    if (blob) triggerDownload(blob);
    globalThis.open(intentUrl, "_blank", "noopener,noreferrer");
    return "fallback";
  };

  const handleDownload = async () => {
    if (downloadState === "busy") return;
    capture("audit_card_download_clicked", { score, grade, missing_policies: missing });
    setDownloadState("busy");
    try {
      const blob = await captureCardBlob();
      if (blob) triggerDownload(blob);
      capture("audit_card_capture_completed", {
        trigger: "download",
        status: blob ? "success" : "no_frame",
      });
      setDownloadState("done");
      setTimeout(() => setDownloadState("idle"), 2000);
    } catch {
      capture("audit_card_capture_completed", { trigger: "download", status: "error" });
      setDownloadState("error");
      setTimeout(() => setDownloadState("idle"), 2000);
    }
  };

  const shareCtx: ShareCtx = { score, arch: archetype.name.toLowerCase(), grade, missing };

  const handleShareX = async () => {
    const text = pickTemplate(X_TEMPLATES, seed, shareCtx);
    capture("audit_card_share_clicked", { channel: "x", score, grade, missing_policies: missing });
    const mode = await shareWithCard(text, X_INTENT(text)).catch(() => "fallback" as const);
    capture("audit_card_capture_completed", {
      trigger: "share_x",
      status: mode === "native" ? "native_share" : "success",
    });
  };

  const handleShareLI = async () => {
    const text = pickTemplate(LI_TEMPLATES, seed, shareCtx);
    capture("audit_card_share_clicked", { channel: "linkedin", score, grade, missing_policies: missing });
    const mode = await shareWithCard(text, LI_INTENT(text)).catch(() => "fallback" as const);
    capture("audit_card_capture_completed", {
      trigger: "share_linkedin",
      status: mode === "native" ? "native_share" : "success",
    });
  };

  return (
    <section className="identity" data-screen-label="01 Identity">
      <div className="archetype-frame" ref={frameRef}>
        <span className="corner tl">┌ identity</span>
        <span className="corner tr">v1.0 ┐</span>
        <span className="corner bl">└ № {archetype.index} / 08</span>
        <span className="corner br">archetype ┘</span>

        <div className="arch-mast">
          <div className="arch-mast-left">
            <div className="arch-eyebrow">
              ━━ identity <span className="ix">·</span> your agent&apos;s archetype
            </div>
            <div className="arch-target">
              detected from{" "}
              <span style={{ color: "var(--ink)" }}>{toolCalls.toLocaleString()}</span>
              {" "}tool calls
              <span className="slash">/</span>
              <span style={{ color: "var(--ink)" }}>{sessions}</span>
              {" "}sessions
              <span className="slash">/</span>
              <span style={{ color: "var(--ink)" }}>{window}</span>
              <span className="live">
                <span className="dot-live"></span>live
              </span>
            </div>
          </div>
          <div className="arch-counter">
            <div>
              № {archetype.index}<span className="of"> of 08</span>
            </div>
            <div style={{ color: "var(--ink-2)", marginTop: 4 }}>archetype</div>
          </div>
        </div>

        <div className="arch-body">
          <div>
            <h1 className="arch-name">{archetype.name}</h1>
            <p className="arch-tagline">{archetype.tagline}</p>

            {secondary && (
              <div className="arch-secondary">
                <span className="with">with</span>
                <span className="name">{secondary.name.replace("the ", "")}</span>
                <span className="with">tendencies</span>
              </div>
            )}

            <div className="arch-keywords">
              {archetype.keywords.map((k, i) => (
                <React.Fragment key={k}>
                  <span className="kw">{k}</span>
                  {i < archetype.keywords.length - 1 && (
                    <span className="kw-sep">·</span>
                  )}
                </React.Fragment>
              ))}
            </div>

            <div className="arch-meta-grid">
              <div className="arch-meta-item">
                <span className="label">common in</span>
                <span className="body">{archetype.common}</span>
              </div>
              <div className="arch-meta-item">
                <span className="label p">primary risk</span>
                <span className="body">{archetype.risk}</span>
              </div>
            </div>

            <div className="arch-closing">— {archetype.closing}</div>
          </div>

          <Sigil archetypeKey={archetypeKey} />
        </div>

        <div className="identity-share-btns">
          <button type="button" className="identity-share-btn" onClick={handleShareX}>
            <span className="isb-glyph" aria-hidden="true">x</span>
            <span className="isb-text">share on x</span>
          </button>
          <button type="button" className="identity-share-btn" onClick={handleShareLI}>
            <span className="isb-glyph" aria-hidden="true">in</span>
            <span className="isb-text">share on linkedin</span>
          </button>
          <button
            type="button"
            className="identity-share-btn"
            onClick={handleDownload}
            disabled={downloadState === "busy"}
          >
            <span className="isb-glyph" aria-hidden="true">↓</span>
            <span className="isb-text">
              {downloadState === "busy" ? "rendering…"
                : downloadState === "done" ? "downloaded ✓"
                : downloadState === "error" ? "render failed"
                : "download audit-card"}
            </span>
          </button>
        </div>
      </div>
    </section>
  );
});
