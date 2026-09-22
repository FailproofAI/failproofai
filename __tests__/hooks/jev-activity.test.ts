// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  JEV_ACTIVITY_KEYS,
  JEV_CLEARED_MAX,
  describeJevActivity,
  hasJevActivity,
  normalizeJevFallbackReason,
  sanitizeJevActivity,
} from "../../src/hooks/jev-activity";
import type { HookActivityEntry } from "../../src/hooks/hook-activity-store";

function entry(overrides: Partial<HookActivityEntry> = {}): HookActivityEntry {
  return {
    timestamp: 1_000,
    eventType: "PreToolUse",
    toolName: "Bash",
    policyName: null,
    decision: "allow",
    reason: null,
    durationMs: 40,
    ...overrides,
  };
}

describe("normalizeJevFallbackReason", () => {
  it("keeps reason codes as they are", () => {
    for (const code of [
      "timeout",
      "network",
      "http-429",
      "http-503",
      "out-of-credits",
      "model-mismatch",
      "rate-limited",
      "truncated",
      "malformed",
      "no-api-key",
      "request-too-large",
      "cloudflare-error",
    ]) {
      expect(normalizeJevFallbackReason(code)).toBe(code);
    }
  });

  it("lowercases and trims a code", () => {
    expect(normalizeJevFallbackReason("  Timeout ")).toBe("timeout");
    expect(normalizeJevFallbackReason("HTTP-429")).toBe("http-429");
  });

  it("reduces free text behind a known prefix to that prefix's code", () => {
    // The evaluator's own free-text reasons: `prepare: <message>`, `error: <message>`.
    expect(normalizeJevFallbackReason("prepare: Unexpected token } in JSON at position 12")).toBe("prepare-error");
    expect(normalizeJevFallbackReason("error: fetch failed")).toBe("error");
    expect(normalizeJevFallbackReason("http-500: upstream returned an error")).toBe("http-500");
    expect(normalizeJevFallbackReason("model-mismatch (got jev-2.0.0)")).toBe("model-mismatch");
    expect(normalizeJevFallbackReason("timeout: 1500 ms")).toBe("timeout");
  });

  it("never keeps free text: anything else becomes `other`", () => {
    // A leading word that is not a known prefix may be the command's own first word.
    expect(normalizeJevFallbackReason("rm: cannot remove '/home/u/x'")).toBe("other");
    expect(normalizeJevFallbackReason("Jev did not answer in time")).toBe("other");
    expect(normalizeJevFallbackReason("a".repeat(41))).toBe("other");
    expect(normalizeJevFallbackReason("under_score")).toBe("other");
  });

  it("returns undefined for nothing", () => {
    expect(normalizeJevFallbackReason(undefined)).toBeUndefined();
    expect(normalizeJevFallbackReason("   ")).toBeUndefined();
    expect(normalizeJevFallbackReason(42)).toBeUndefined();
  });
});

describe("sanitizeJevActivity", () => {
  it("returns an entry with no Jev fields as the very same object", () => {
    // The unconfigured path must reach disk exactly as the handler built it.
    const e = entry();
    expect(sanitizeJevActivity(e)).toBe(e);
  });

  it("keeps every valid field", () => {
    const e = entry({
      evaluator: "jev",
      jevDecision: "instruct",
      jevCleared: ["block-env-files", "protect-env-vars"],
      jevLatencyMs: 38,
      jevModel: "typesafe/jev-1.13-20260917",
      jevMode: "enforce",
    });
    expect(sanitizeJevActivity(e)).toEqual(e);
  });

  it("drops values outside each field's closed set, field by field", () => {
    const out = sanitizeJevActivity(
      entry({
        evaluator: "llm" as never,
        jevDecision: "maybe" as never,
        jevMode: "yolo" as never,
        jevModel: "jev 1.13 (latest)",
        jevLatencyMs: Number.NaN,
      }),
    );
    for (const k of ["evaluator", "jevDecision", "jevMode", "jevModel", "jevLatencyMs"] as const) {
      expect(out).not.toHaveProperty(k);
    }
    // The non-Jev part is untouched.
    expect(out.durationMs).toBe(40);
    expect(out.decision).toBe("allow");
  });

  it("rounds latency and rejects negatives", () => {
    expect(sanitizeJevActivity(entry({ evaluator: "jev", jevLatencyMs: 37.6 })).jevLatencyMs).toBe(38);
    expect(sanitizeJevActivity(entry({ evaluator: "jev", jevLatencyMs: -1 }))).not.toHaveProperty("jevLatencyMs");
  });

  it("keeps only name-shaped, distinct cleared policies, bounded", () => {
    const out = sanitizeJevActivity(
      entry({
        evaluator: "jev",
        jevCleared: ["block-env-files", "block-env-files", "two words", "", 7 as never, "pack/acme/fin@1.2.0/no-curl"],
      }),
    );
    expect(out.jevCleared).toEqual(["block-env-files", "pack/acme/fin@1.2.0/no-curl"]);
    const many = sanitizeJevActivity(
      entry({ evaluator: "jev", jevCleared: Array.from({ length: 500 }, (_, i) => `custom/p${i}`) }),
    );
    expect(many.jevCleared).toHaveLength(JEV_CLEARED_MAX);
  });

  it("keeps an empty cleared list: Jev answered and cleared nothing", () => {
    expect(sanitizeJevActivity(entry({ evaluator: "jev", jevCleared: [] })).jevCleared).toEqual([]);
  });

  it("drops a cleared value that is not a list", () => {
    expect(sanitizeJevActivity(entry({ evaluator: "jev", jevCleared: "block-env-files" as never }))).not.toHaveProperty(
      "jevCleared",
    );
  });

  it("normalizes the fallback reason", () => {
    const out = sanitizeJevActivity(entry({ evaluator: "jev-fallback", jevFallbackReason: "error: socket hang up" }));
    expect(out.jevFallbackReason).toBe("error");
  });

  it("does not mutate its input", () => {
    const e = entry({ evaluator: "jev-fallback", jevFallbackReason: "prepare: boom" });
    sanitizeJevActivity(e);
    expect(e.jevFallbackReason).toBe("prepare: boom");
  });

  it("lists exactly the seven contract fields", () => {
    expect([...JEV_ACTIVITY_KEYS].sort()).toEqual(
      ["evaluator", "jevCleared", "jevDecision", "jevFallbackReason", "jevLatencyMs", "jevMode", "jevModel"].sort(),
    );
  });
});

describe("hasJevActivity", () => {
  it("is true only for a known evaluator", () => {
    expect(hasJevActivity(entry())).toBe(false);
    expect(hasJevActivity(entry({ evaluator: "jev" }))).toBe(true);
    expect(hasJevActivity(entry({ evaluator: "jev-fallback" }))).toBe(true);
    expect(hasJevActivity(entry({ jevDecision: "deny" }))).toBe(false);
  });
});

describe("describeJevActivity", () => {
  it("is null when Jev was not involved", () => {
    expect(describeJevActivity(entry())).toBeNull();
  });

  it("describes an answered call with a clear", () => {
    expect(
      describeJevActivity(
        entry({
          evaluator: "jev",
          jevMode: "enforce",
          jevDecision: "allow",
          jevCleared: ["block-read-outside-cwd"],
          jevLatencyMs: 38,
          jevModel: "jev-1.13.0",
        }),
      ),
    ).toEqual(["Jev verdict: allow", "cleared block-read-outside-cwd", "38 ms", "jev-1.13.0"]);
  });

  it("says shadow mode enforced the regex result", () => {
    const facts = describeJevActivity(
      entry({ evaluator: "jev", jevMode: "shadow", jevDecision: "allow", jevCleared: ["block-env-files"] }),
    );
    expect(facts).toEqual([
      "Jev verdict: allow",
      "would have cleared block-env-files",
      "shadow mode: the regex result was enforced",
    ]);
  });

  it("describes a fallback by its reason code only", () => {
    const facts = describeJevActivity(
      entry({ evaluator: "jev-fallback", jevMode: "enforce", jevFallbackReason: "prepare: rm -rf failed", jevLatencyMs: 3 }),
    );
    expect(facts).toEqual(["Jev unavailable: prepare-error", "the regex policies decided alone", "3 ms"]);
    expect(JSON.stringify(facts)).not.toContain("rm -rf");
  });
});
