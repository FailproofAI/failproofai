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
  it("ships 10 X and 10 LinkedIn templates", () => {
    expect(X_TEMPLATES).toHaveLength(10);
    expect(LI_TEMPLATES).toHaveLength(10);
  });

  it("every template carries score, archetype, the npx command, and no bare site URL", () => {
    for (const t of [...X_TEMPLATES, ...LI_TEMPLATES]) {
      const out = t(ctx);
      expect(out).toContain("72");
      expect(out).toContain("the cowboy");
      expect(out).toContain("npx -y failproofai audit");
      expect(out).not.toContain("befailproof.ai");
      expect(out.length).toBeGreaterThan(40);
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

  it("X copy is emoji-forward; LinkedIn copy is emoji-free", () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    expect(X_TEMPLATES.every((t) => emoji.test(t(ctx)))).toBe(true);
    for (const t of LI_TEMPLATES) {
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
