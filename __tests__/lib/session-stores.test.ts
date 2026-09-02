// @vitest-environment node
/**
 * The session-store table must cover every integration.
 *
 * This guards a bug that shipped: the session page resolved a session by walking
 * a TWELVE-level nested if/else of `getCachedXSessionLog` calls, whose innermost
 * `else` set "Session log file not found." while `cli` still held its default of
 * `"claude"`. Four integrations — grok, qwen, ori, cline — were added without
 * anyone extending that pyramid, so every one of their sessions rendered with a
 * CLAUDE CODE badge, pointed at a Claude transcript that did not exist, and
 * showed an empty log. The store was never consulted at all.
 *
 * Nothing failed loudly, because a missing branch in an if/else chain is not a
 * type error and not a runtime error — it is just an `else`.
 *
 * The chain is now a table, and this asserts the table is complete. `claude` is
 * excluded on purpose: it is the primary path the page tries first, not a
 * fallback store.
 */
import { describe, it, expect } from "vitest";
import { EXTERNAL_SESSION_STORES } from "@/lib/session-stores";
import { INTEGRATION_TYPES } from "@/src/hooks/types";

describe("external session stores", () => {
  it("covers every integration except claude", () => {
    const covered = EXTERNAL_SESSION_STORES.map((s) => s.cli).sort();
    const expected = INTEGRATION_TYPES.filter((c) => c !== "claude").sort();
    expect(covered).toEqual([...expected]);
  });

  it("lists each store exactly once", () => {
    const ids = EXTERNAL_SESSION_STORES.map((s) => s.cli);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every store a loader and a human label", () => {
    for (const s of EXTERNAL_SESSION_STORES) {
      expect(typeof s.load, `${s.cli} needs a loader`).toBe("function");
      expect(s.label.length, `${s.cli} needs a label`).toBeGreaterThan(0);
    }
  });

  it("labels match the dashboard registry, so the badge and the header agree", async () => {
    // A session page that says "Ori" beside a badge reading something else is
    // the kind of mismatch nobody notices until a screenshot.
    const { getCliLabel } = await import("@/lib/cli-registry");
    for (const s of EXTERNAL_SESSION_STORES) {
      expect(s.label, `${s.cli} label`).toBe(getCliLabel(s.cli));
    }
  });
});
