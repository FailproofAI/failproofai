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
  it("ships 5 X and 5 LinkedIn templates", () => {
    expect(X_TEMPLATES).toHaveLength(5);
    expect(LI_TEMPLATES).toHaveLength(5);
  });

  it("every template is personalised with score, grade, archetype and the site URL", () => {
    for (const t of [...X_TEMPLATES, ...LI_TEMPLATES]) {
      const out = t(ctx);
      expect(out).toContain("72");
      expect(out).toContain("the cowboy");
      expect(out).toMatch(/\bB\b/);
      expect(out).toContain("befailproof.ai");
      expect(out.length).toBeGreaterThan(40);
    }
  });

  it("handles the clean run (missing = 0) without dangling 'policies' phrasing", () => {
    for (const t of [...X_TEMPLATES, ...LI_TEMPLATES]) {
      const out = t(cleanCtx);
      expect(out).not.toMatch(/\b0 (policy|policies)\b/);
    }
  });

  it("X copy is quirky (emoji), LinkedIn copy is longer-form and professional", () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    const xHasEmoji = X_TEMPLATES.some((t) => emoji.test(t(ctx)));
    expect(xHasEmoji).toBe(true);
    // LinkedIn copy carries no emoji and reads longer.
    for (const t of LI_TEMPLATES) {
      const out = t(ctx);
      expect(emoji.test(out)).toBe(false);
      expect(out.length).toBeGreaterThan(140);
    }
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
