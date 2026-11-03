// @vitest-environment node
/**
 * Fallback reasons are stored and shipped as one of a closed list of codes.
 *
 * Code-SHAPED is not enough: a short kebab-case word (`curl`,
 * `secret-project`) could be the first word of the judged command, so only
 * the codes the Jev client, evaluator, throttle and combine rules produce are
 * kept, and the collector (`transform.rs`) keeps the same list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  JEV_FREE_TEXT_PREFIXES,
  JEV_REASON_CODES,
  JEV_REASON_OTHER,
  normalizeJevFallbackReason,
  sanitizeJevActivity,
} from "../../src/hooks/jev-activity";

const RUST = readFileSync(
  join(__dirname, "..", "..", "crates", "fpai-collect", "src", "sources", "hooks", "transform.rs"),
  "utf-8",
);

describe("normalizeJevFallbackReason: only known codes", () => {
  it("keeps every known code, bare or in front of free text", () => {
    for (const code of JEV_REASON_CODES) {
      expect(normalizeJevFallbackReason(code)).toBe(code);
      expect(normalizeJevFallbackReason(`${code}: details that stay local`)).toBe(code);
    }
    expect(normalizeJevFallbackReason("http-418")).toBe("http-418");
  });

  it("maps a short kebab-case word that is not a known code to `other`", () => {
    for (const word of ["curl", "zebra-archive", "secret-project", "rm", "payroll-2026", "constructor", "__proto__"]) {
      expect(normalizeJevFallbackReason(word), word).toBe(JEV_REASON_OTHER);
    }
    expect(normalizeJevFallbackReason("http-4290")).toBe(JEV_REASON_OTHER);
    expect(normalizeJevFallbackReason("curl: (7) failed to connect")).toBe(JEV_REASON_OTHER);
  });

  it("stores a prepare failure under one name, however it arrives", () => {
    // The evaluator writes `prepare: <message>`; the combine rules cut that to
    // a bare `prepare`. Stats must not show one failure under two names.
    expect(normalizeJevFallbackReason("prepare")).toBe("prepare-error");
    expect(normalizeJevFallbackReason("prepare: Unexpected token")).toBe("prepare-error");
    expect(sanitizeJevActivity({ evaluator: "jev-fallback", jevFallbackReason: "prepare" }).jevFallbackReason).toBe(
      "prepare-error",
    );
  });

  it("covers every code the producers write", () => {
    // JevError codes (jev-client), the evaluator's own degraded reasons, the
    // throttle's, and the combine rules' (`truncated`, `error`, `prepare`).
    for (const code of [
      "timeout",
      "network",
      "malformed",
      "config",
      "cloudflare-error",
      "cloudflare-incomplete",
      "model-mismatch",
      "out-of-credits",
      "upstream-error",
      "request-too-large",
      "no-api-key",
      "no-transport",
      "aborted",
      "rate-limited",
      "truncated",
      "error",
      "http-429",
      "http-503",
    ]) {
      expect(normalizeJevFallbackReason(code), code).toBe(code);
    }
  });

  it("renames through the prefix list only into known codes", () => {
    for (const code of JEV_FREE_TEXT_PREFIXES.values()) expect(JEV_REASON_CODES.has(code), code).toBe(true);
  });
});

describe("the collector keeps the same code list", () => {
  it("JEV_REASON_CODES in transform.rs is the same set", () => {
    const body = /pub const JEV_REASON_CODES: &\[&str\] = &\[([\s\S]*?)\];/.exec(RUST)?.[1];
    expect(body, "transform.rs has no JEV_REASON_CODES").toBeDefined();
    const rust = [...body!.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
    expect(rust).toEqual([...JEV_REASON_CODES].sort());
  });
});
