// @vitest-environment node
/**
 * The Jev activity fields are written by TypeScript (`hook-activity-store.ts`)
 * and shipped by Rust (`crates/fpai-collect/src/sources/hooks/transform.rs`).
 * Nothing links the two at build time: a key renamed on one side is valid JSON
 * the other side silently ignores, and a reason prefix trusted on one side but
 * not the other makes the two disagree about what counts as free text. This
 * reads the Rust source and holds them together.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  JEV_ACTIVITY_KEYS,
  JEV_CLEARED_MAX,
  JEV_FREE_TEXT_PREFIXES,
  JEV_REASON_MAX_CHARS,
} from "../../src/hooks/jev-activity";

const RUST = readFileSync(
  join(__dirname, "..", "..", "crates", "fpai-collect", "src", "sources", "hooks", "transform.rs"),
  "utf-8",
);

describe("Jev activity fields: TypeScript and the collector agree", () => {
  it("the collector reads every Jev key the store writes", () => {
    for (const key of JEV_ACTIVITY_KEYS) {
      const renamed = RUST.includes(`rename = "${key}"`);
      // A key that is already snake-case-identical needs no rename.
      const plain = new RegExp(`pub ${key}: Option<`).test(RUST);
      expect(renamed || plain, `transform.rs does not read "${key}"`).toBe(true);
    }
  });

  it("the free-text reason prefixes are the same list", () => {
    const rustPairs = new Map(
      [...RUST.matchAll(/^\s*\("([a-z0-9-]+)", "([a-z0-9-]+)"\),\s*$/gm)].map((m) => [m[1], m[2]] as const),
    );
    expect(rustPairs.size).toBeGreaterThan(0);
    expect([...rustPairs.entries()].sort()).toEqual([...JEV_FREE_TEXT_PREFIXES.entries()].sort());
  });

  it("the bounds are the same", () => {
    expect(RUST).toContain(`pub const JEV_REASON_MAX_CHARS: usize = ${JEV_REASON_MAX_CHARS};`);
    expect(RUST).toContain(`pub const JEV_CLEARED_MAX: usize = ${JEV_CLEARED_MAX};`);
  });
});
