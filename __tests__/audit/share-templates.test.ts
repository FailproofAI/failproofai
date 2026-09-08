// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  X_TEMPLATES,
  LI_TEMPLATES,
  pickTemplate,
  type ShareCtx,
} from "../../app/audit/_components/share-templates";

const ctx: ShareCtx = { score: 72, arch: "the cowboy", grade: "B", missing: 3 };
const cleanCtx: ShareCtx = { score: 96, arch: "the precision builder", grade: "S", missing: 0 };

describe("share templates", () => {
  // Nine, not ten, since the score was switched off: one template per channel
  // had the number as its entire premise ("my agent scored X/100, think yours
  // can beat it?") and there was nothing left of it once the number went, so
  // both are commented out in place rather than reworded. The other eighteen
  // lost a subordinate clause and survive.
  it("ships 9 X and 9 LinkedIn templates", () => {
    expect(X_TEMPLATES).toHaveLength(9);
    expect(LI_TEMPLATES).toHaveLength(9);
  });

  it("every template ends on the npx CTA, references score or archetype, and embeds no URL", () => {
    for (const t of [...X_TEMPLATES, ...LI_TEMPLATES]) {
      const out = t(ctx);
      // Anchored: the CTA must *terminate* the copy (matches the test name),
      // not merely appear somewhere in it.
      expect(out.trimEnd()).toMatch(/npx -y failproofai audit · @[^\n]+$/);
      // No URLs anywhere — a link would trigger a preview card and swallow the
      // pasted image. (Catches befailproof.ai and any http(s) link.)
      expect(out).not.toContain("befailproof.ai");
      expect(out).not.toMatch(/https?:\/\//);
      // Each template surfaces the score and/or the archetype (a couple lean
      // on just one).
      expect(out.includes("72") || out.includes("the cowboy")).toBe(true);
      expect(out.length).toBeGreaterThan(40);
    }
  });

  // Inverted by the score being switched off. This used to require the score on
  // >=15 of 20; it now requires it on NONE, which is the assertion that keeps
  // the switch honest — a template that quietly reintroduces `${score}` would
  // render `undefined/100` on the shared card, since nothing upstream computes
  // it any more. Restoring the score means restoring the old bound here too.
  it("references the archetype on every template and the score on none", () => {
    const all = [...X_TEMPLATES, ...LI_TEMPLATES];
    const withScore = all.filter((t) => t(ctx).includes("72"));
    const withArch = all.filter((t) => t(ctx).includes("the cowboy"));
    expect(withScore).toHaveLength(0);
    expect(withArch).toHaveLength(all.length);
  });

  it("never renders `undefined` when no score is supplied", () => {
    // The dashboard stops passing score/grade entirely, so the templates are
    // called with neither. Any surviving interpolation would show up here.
    const scoreless: ShareCtx = { arch: "the cowboy", missing: 3 };
    for (const t of [...X_TEMPLATES, ...LI_TEMPLATES]) {
      expect(t(scoreless)).not.toContain("undefined");
    }
  });

  it("tags the channel's handle (@failproofai on X, @Failproof AI on LinkedIn)", () => {
    for (const t of X_TEMPLATES) expect(t(ctx)).toContain("@failproofai");
    for (const t of LI_TEMPLATES) expect(t(ctx)).toContain("@Failproof AI");
  });

  it("does not surface the grade tier in copy (sounds bad at the low end)", () => {
    const lowCtx: ShareCtx = { score: 41, arch: "the optimist", grade: "D", missing: 5 };
    for (const t of [...X_TEMPLATES, ...LI_TEMPLATES]) {
      const out = t(lowCtx);
      expect(out).not.toMatch(/\bD tier\b/i);
      expect(out).not.toMatch(/\(D\)/i);
    }
  });

  it("handles the clean run (missing = 0) without dangling 'policies' phrasing", () => {
    for (const t of [...X_TEMPLATES, ...LI_TEMPLATES]) {
      const out = t(cleanCtx);
      expect(out).not.toMatch(/\b0 (policy|policies)\b/);
    }
  });

  it("all copy is emoji-free (clean, professional tone on both channels)", () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const t of [...X_TEMPLATES, ...LI_TEMPLATES]) {
      expect(emoji.test(t(ctx))).toBe(false);
    }
  });

  it("pickTemplate appends the clipboard paste hint", () => {
    expect(pickTemplate(X_TEMPLATES, "proj|12345", ctx)).toContain("paste it into the post");
    expect(pickTemplate(LI_TEMPLATES, "proj|12345", ctx)).toContain("paste it into the post");
  });

  it("pickTemplate is deterministic for a given seed", () => {
    expect(pickTemplate(X_TEMPLATES, "proj|12345", ctx)).toBe(
      pickTemplate(X_TEMPLATES, "proj|12345", ctx),
    );
  });

  it("pickTemplate spreads across templates for different seeds", () => {
    const picks = new Set(
      Array.from({ length: 40 }, (_, i) => pickTemplate(X_TEMPLATES, `seed-${i}`, ctx)),
    );
    expect(picks.size).toBeGreaterThan(1);
  });
});
