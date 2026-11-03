// @vitest-environment node
/**
 * Whitespace in the Jev field validators is what JavaScript's `\s` and
 * `trim()` call whitespace. The collector (`is_js_whitespace` in
 * crates/fpai-collect/src/sources/hooks/transform.rs) re-validates every row
 * with the same rule, and `whitespace_is_what_javascript_calls_whitespace` in
 * crates/fpai-collect/tests/hooks_jev.rs runs these exact cases there.
 *
 * The two code points where a naive port differs: U+FEFF (the byte-order
 * mark) is whitespace to JavaScript and not to Rust's `char::is_whitespace`;
 * U+0085 (NEL, a C1 control) is the other way round.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isJevPolicyName, normalizeJevFallbackReason, sanitizeJevActivity } from "../../src/hooks/jev-activity";

const BOM = "﻿";
const NEL = "\u0085";

describe("Jev field whitespace (parity with the collector)", () => {
  it("a reason code is found behind or in front of a byte-order mark, not a NEL", () => {
    expect(normalizeJevFallbackReason(`${BOM}timeout`)).toBe("timeout");
    expect(normalizeJevFallbackReason(`timeout${BOM}`)).toBe("timeout");
    expect(normalizeJevFallbackReason(`timeout${BOM}: rm -rf x`)).toBe("timeout");
    expect(normalizeJevFallbackReason(BOM)).toBeUndefined();
    expect(normalizeJevFallbackReason(`${NEL}timeout`)).toBe("other");
  });

  it("a byte-order mark is whitespace in a cleared name; a NEL is a control character", () => {
    expect(isJevPolicyName(`a${BOM}b`)).toBe(false);
    expect(isJevPolicyName(`custom/a${BOM}b`)).toBe(true);
    expect(isJevPolicyName(`a${NEL}b`)).toBe(false);
    expect(
      sanitizeJevActivity({ evaluator: "jev", jevCleared: [`a${BOM}b`, `custom/a${BOM}b`, `a${NEL}b`] }).jevCleared,
    ).toEqual([`custom/a${BOM}b`]);
  });

  it("a model id is trimmed of byte-order marks, not of NELs", () => {
    const model = (id: string) => sanitizeJevActivity({ evaluator: "jev", jevModel: id }).jevModel;
    expect(model(`${BOM}jev-1.13.0${BOM}`)).toBe("jev-1.13.0");
    expect(model(`${NEL}jev-1.13.0`)).toBeUndefined();
    expect(model(`jev-1.13.0${NEL}`)).toBeUndefined();
  });

  it("the collector's twin runs the same cases", () => {
    const rust = readFileSync(join(__dirname, "..", "..", "crates", "fpai-collect", "tests", "hooks_jev.rs"), "utf-8");
    expect(rust).toContain("fn whitespace_is_what_javascript_calls_whitespace()");
    const transform = readFileSync(
      join(__dirname, "..", "..", "crates", "fpai-collect", "src", "sources", "hooks", "transform.rs"),
      "utf-8",
    );
    expect(transform).toContain("fn is_js_whitespace(c: char) -> bool");
  });
});
