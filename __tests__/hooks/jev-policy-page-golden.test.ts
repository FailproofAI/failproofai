// @vitest-environment node
/**
 * The collector's golden rows for the policy page's Jev data (contract §5):
 * a Jev-decided enforce row attributed `policySource: "jev"`, and shadow rows
 * whose `observed` list carries Jev's "would have".
 *
 * `crates/fpai-collect/tests/hooks_jev.rs` reads the golden file this test
 * keeps byte-identical to what the store writes, and checks those rows ship
 * individually — never folded into an allow aggregate, where the "would have"
 * and the attribution would both disappear.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _resetForTest, persistHookActivity } from "../../src/hooks/hook-activity-store";
import { JEV_POLICY_PAGE_ROWS } from "../fixtures/jev-policy-page-rows";

const GOLDEN = join(__dirname, "..", "..", "crates", "fpai-collect", "tests", "fixtures", "hook-activity-jev-policy-page.jsonl");

describe("the collector's policy-page golden rows", () => {
  it("are exactly what the store writes", () => {
    // If the store's output changes, regenerate the golden file from
    // __tests__/fixtures/jev-policy-page-rows.ts (persist each row, copy
    // current.jsonl) and re-run the Rust tests.
    const dir = mkdtempSync(join(tmpdir(), "jev-golden-pp-"));
    try {
      _resetForTest(dir);
      for (const r of JEV_POLICY_PAGE_ROWS) persistHookActivity(r);
      const written = readFileSync(join(dir, "current.jsonl"), "utf-8");
      expect(written).toBe(readFileSync(GOLDEN, "utf-8"));
    } finally {
      _resetForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carry the fields the server reads, in the shapes it reads them", () => {
    const [decided, wouldDeny, wouldWarn] = JEV_POLICY_PAGE_ROWS;
    expect(decided).toMatchObject({ policySource: "jev", policyName: "semantic/destructive-deletion", jevMode: "enforce" });
    expect(decided.observed).toBeUndefined();
    for (const row of [wouldDeny, wouldWarn]) {
      expect(row.decision).toBe("allow");
      expect(row.policySource).toBeUndefined();
      expect(row.jevMode).toBe("shadow");
      expect(row.observed).toHaveLength(1);
      const [o] = row.observed!;
      expect(o.policyId).toMatch(/^semantic\/[a-z0-9-]+$/);
      expect(o.decision).toBe(row.jevDecision);
      expect(o.version).toBe(row.jevModel);
    }
  });
});
