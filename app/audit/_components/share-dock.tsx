"use client";

/**
 * Floating share dock — always-visible bottom-right panel on the /audit
 * dashboard. Three buttons (X, LinkedIn, download) that all share the
 * `.share-btn` styling used by the inline buttons in `identity-section`,
 * so the visual rhythm carries between surfaces.
 *
 * Capture flow:
 *   1. Dock click → ref'd `.archetype-frame` is captured to a PNG blob
 *      via html2canvas.
 *   2. `copyOrDownloadCard` writes the blob to the clipboard if the
 *      browser supports it, falling back to a download. The user gets a
 *      toast telling them what to do next.
 *   3. For shares, the X / LinkedIn intent window opens with the
 *      templated text.
 *
 * UX:
 *   - Collapses to a single 48px pink FAB via a header caret. Preference
 *     persists across page navigations within a session.
 *   - Slide-in animation on mount (respects prefers-reduced-motion).
 *   - Hidden on viewports < 760px (mobile) — the inline buttons are
 *     already visible there and a floating dock would cover content.
 *   - Hidden until the archetype hero has actually mounted (frameRef
 *     resolves to a node). On the empty / running states we render
 *     nothing.
 */
import React, { useEffect, useState } from "react";
import { type ArchetypeKey, pickArchetypeVariant } from "@/src/audit/archetypes";
import { type Grade } from "@/src/audit/scoring";
import { copyOrDownloadCard, downloadCard, shareCardNative, shareCardToastMessage } from "@/lib/share-card";
import { toast } from "@/app/components/toast";
import { usePostHog } from "@/contexts/PostHogContext";
import { X_TEMPLATES, LI_TEMPLATES, pickTemplate, type ShareCtx } from "./share-templates";

const SITE_URL = "https://befailproof.ai";
const X_INTENT = (text: string) =>
  `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
const LI_INTENT = (text: string) =>
  `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SITE_URL)}&summary=${encodeURIComponent(text)}`;

const COLLAPSED_KEY = "failproofai:audit:share-dock-collapsed";

interface Props {
  /** Ref to the `.archetype-frame` to capture. Same node `identity-section`
   *  forwards into IdentitySection's `frameRef`. */
  frameRef: React.RefObject<HTMLDivElement | null>;
  archetypeKey: ArchetypeKey;
  /** Seed for deterministic archetype-variant copy. Same as IdentitySection's
   *  `seed` prop — usually the inferred project name. */
  seed: string;
  score: number;
  grade: Grade;
  missing: number;
}

export function ShareDock({ frameRef, archetypeKey, seed, score, grade, missing }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState<null | "x" | "linkedin" | "download">(null);
  const { capture } = usePostHog();
  const archetype = pickArchetypeVariant(archetypeKey, seed);
  const archetypeDisplayName = archetype.name;

  // Restore collapsed preference from sessionStorage on first mount.
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && window.sessionStorage.getItem(COLLAPSED_KEY) === "1") {
        setCollapsed(true);
      }
    } catch { /* private mode, etc. — fall through to default */ }
  }, []);

  const toggle = (next: boolean) => {
    setCollapsed(next);
    try { window.sessionStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
    capture("audit_share_dock_toggled", { collapsed: next });
  };

  const captureCardBlob = async (): Promise<Blob | null> => {
    const node = frameRef.current;
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

  const filenameFor = (channel: "x" | "linkedin" | "download") =>
    `failproofai-${channel}-${grade.toLowerCase()}-${score}.png`;

  const handleShare = async (channel: "x" | "linkedin" | "download") => {
    if (busy) return;
    setBusy(channel);
    capture("audit_card_share_clicked", {
      channel: channel === "download" ? "download" : channel,
      source: "dock",
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
          source: "dock",
        });
        toast(shareCardToastMessage("failed"));
        return;
      }

      // Dedicated "save audit-card" button: always download, never clipboard.
      if (channel === "download") {
        const ok = downloadCard(blob, filenameFor(channel));
        const method = ok ? "download" : "failed";
        capture("audit_card_capture_completed", {
          trigger: "download",
          status: ok ? "success" : "error",
          image_method: method,
          source: "dock",
        });
        toast(shareCardToastMessage(method));
        return;
      }

      // X / LinkedIn share: try the native share sheet with file first
      // (one-tap "image attached" on iOS / Android / recent Safari / recent
      // Chrome). Fall back to clipboard + opening the intent URL when the
      // native share sheet isn't available or the user dismissed it.
      const shareCtx: ShareCtx = {
        score,
        arch: archetypeDisplayName.toLowerCase(),
        grade,
        missing,
      };
      // One of five tone-matched templates (quirky for X, professional for
      // LinkedIn), chosen deterministically from the behaviour-fingerprint
      // seed so the copy fits this run and stays stable on re-share.
      const shareText = channel === "x"
        ? pickTemplate(X_TEMPLATES, seed, shareCtx)
        : pickTemplate(LI_TEMPLATES, seed, shareCtx);
      const native = await shareCardNative(blob, filenameFor(channel), shareText);
      if (native) {
        capture("audit_card_capture_completed", {
          trigger: `share_${channel}`,
          status: "success",
          image_method: "native",
          source: "dock",
        });
        toast(shareCardToastMessage("native"));
        return;
      }

      const fallbackMethod = await copyOrDownloadCard(blob, filenameFor(channel));
      capture("audit_card_capture_completed", {
        trigger: `share_${channel}`,
        status: "success",
        image_method: fallbackMethod,
        source: "dock",
      });
      toast(shareCardToastMessage(fallbackMethod));
      const intent = channel === "x"
        ? X_INTENT(shareText)
        : LI_INTENT(shareText);
      globalThis.open(intent, "_blank", "noopener,noreferrer");
    } finally {
      setBusy(null);
    }
  };

  // Render the collapsed FAB. Single pink-tile pulse that re-expands the dock.
  if (collapsed) {
    return (
      <button
        type="button"
        className="share-dock-fab"
        aria-label="Expand share dock"
        onClick={() => toggle(false)}
      >
        <span aria-hidden="true">𝕏</span>
      </button>
    );
  }

  return (
    <aside
      className="share-dock"
      aria-label="Share your audit"
      data-busy={busy ? "true" : undefined}
    >
      <header className="share-dock-head">
        <span className="share-dock-eyebrow"><span aria-hidden="true">━━</span>share your audit</span>
        <button
          type="button"
          className="share-dock-caret"
          onClick={() => toggle(true)}
          aria-label="Collapse share dock"
        >
          <span aria-hidden="true">▾</span>
        </button>
      </header>
      <div className="share-dock-stack">
        <button
          type="button"
          className="share-btn share-btn--x"
          onClick={() => handleShare("x")}
          disabled={busy !== null}
        >
          <span className="share-btn-mark share-btn-mark--x" aria-hidden="true">𝕏</span>
          <span className="share-btn-body">
            <span className="share-btn-eyebrow">share on</span>
            <span className="share-btn-label">{busy === "x" ? "rendering…" : "X · Twitter"}</span>
          </span>
          <span className="share-btn-arrow" aria-hidden="true">→</span>
        </button>
        <button
          type="button"
          className="share-btn share-btn--li"
          onClick={() => handleShare("linkedin")}
          disabled={busy !== null}
        >
          <span className="share-btn-mark share-btn-mark--li" aria-hidden="true">in</span>
          <span className="share-btn-body">
            <span className="share-btn-eyebrow">share on</span>
            <span className="share-btn-label">{busy === "linkedin" ? "rendering…" : "LinkedIn"}</span>
          </span>
          <span className="share-btn-arrow" aria-hidden="true">→</span>
        </button>
        <button
          type="button"
          className="share-btn share-btn--dl"
          onClick={() => handleShare("download")}
          disabled={busy !== null}
        >
          <span className="share-btn-mark share-btn-mark--dl" aria-hidden="true">↓</span>
          <span className="share-btn-body">
            <span className="share-btn-eyebrow">save</span>
            <span className="share-btn-label">{busy === "download" ? "rendering…" : "audit-card"}</span>
          </span>
          <span className="share-btn-arrow" aria-hidden="true">↓</span>
        </button>
      </div>
      <footer className="share-dock-foot">
        <span aria-hidden="true">▮▮</span>image auto-attaches via paste
      </footer>
    </aside>
  );
}

ShareDock.displayName = "ShareDock";
