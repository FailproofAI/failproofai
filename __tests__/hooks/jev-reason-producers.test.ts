// @vitest-environment node
/**
 * Every fallback reason a producer writes is a known code.
 *
 * The code list (`JEV_REASON_CODES`) is closed on purpose: any reason it does
 * not name is stored and shipped as `other`. So a producer that starts writing
 * a new reason loses it — to `jev status`, PostHog and the collector — unless
 * the list grows with it. A hand-typed list of "what the producers write"
 * cannot notice that; this test reads the producers' source instead and fails
 * on the first reason literal the list does not cover.
 *
 * Producers: the Jev client and throttle (`JevError` codes), the evaluator
 * (`degraded(...)` reasons), the two-tier review and the handler's start-up
 * guard (`{ kind: "fallback", reason }`). Every `.ts` file under
 * src/hooks/semantic/ is read, plus the handler and the policy evaluator, so a
 * new producer file there is covered without editing this test.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { JEV_REASON_CODES, JEV_REASON_OTHER, normalizeJevFallbackReason } from "../../src/hooks/jev-activity";

const ROOT = join(__dirname, "..", "..");
const SEMANTIC = join(ROOT, "src", "hooks", "semantic");

function producerFiles(): string[] {
  const files = readdirSync(SEMANTIC)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(SEMANTIC, f));
  for (const f of ["handler.ts", "policy-evaluator.ts"]) {
    const p = join(ROOT, "src", "hooks", f);
    if (existsSync(p)) files.push(p);
  }
  return files;
}

/** A string, template or quoted literal's leading code: `"timeout"`, `` `http-${…}` ``, `` `error: ${…}` ``. */
const LIT = String.raw`["'\x60]([a-z0-9]+(?:-[a-z0-9]*)*)`;
const PATTERNS: RegExp[] = [
  // new JevError("code", …) / JevError("code") in a doc comment
  new RegExp(String.raw`JevError\(\s*` + LIT, "g"),
  // degraded("code") / degraded(`code: …`)
  new RegExp(String.raw`\bdegraded\(\s*` + LIT, "g"),
  // { status: "degraded", reason: `code: …` }
  new RegExp(String.raw`status:\s*"degraded",\s*reason:\s*` + LIT, "g"),
  // { kind: "fallback", reason: "code", … }
  new RegExp(String.raw`kind:\s*"fallback",\s*reason:\s*` + LIT, "g"),
  // err instanceof JevError ? err.code : "code"   /   … ? code : "code"
  new RegExp(String.raw`\?\s*(?:err\.)?code\s*:\s*` + LIT, "g"),
];

/** Every reason literal in `src`, as written (a template's static head, e.g. `http-`). */
function reasonLiterals(src: string): Set<string> {
  const out = new Set<string>();
  for (const re of PATTERNS) for (const m of src.matchAll(re)) out.add(m[1]);
  return out;
}

/** What a literal is stored as: an `http-` template head stands for any status. */
function stored(literal: string): string | undefined {
  return normalizeJevFallbackReason(literal.endsWith("-") ? `${literal}503` : literal);
}

describe("the reason extractor", () => {
  it("finds each shape a producer uses", () => {
    const sample = [
      `throw new JevError("out-of-credits", "HTTP 402");`,
      "throw new JevError(`http-${res.status}`, `HTTP ${res.status}`);",
      `throw new JevError(\n      "rate-limited",\n      "budget spent",\n    );`,
      `return degraded("request-too-large");`,
      "return degraded(`error: ${err}`);",
      "return { status: \"degraded\", reason: `prepare: ${msg}`, latencyMs: 1 };",
      // The two-tier handler's guard when the Jev review cannot even start:
      `review: Promise.resolve({ kind: "fallback", reason: "unavailable", latencyMs: null, model: null, decision: null }),`,
      `const reason = err instanceof JevError ? err.code : "config";`,
      `return /^[a-z]+$/.test(code) ? code : "error";`,
    ].join("\n");
    expect([...reasonLiterals(sample)].sort()).toEqual(
      ["config", "error", "http-", "out-of-credits", "prepare", "rate-limited", "request-too-large", "unavailable"].sort(),
    );
  });

  it("reads real producers on this tree", () => {
    // A sanity floor, so a broken pattern cannot pass by finding nothing: the
    // client and the evaluator have written these since the semantic core landed.
    const found = new Set<string>();
    for (const f of producerFiles()) for (const r of reasonLiterals(readFileSync(f, "utf-8"))) found.add(r);
    for (const code of ["timeout", "network", "malformed", "config", "model-mismatch", "request-too-large", "prepare", "error"]) {
      expect(found.has(code), `extractor found no "${code}" in the producers`).toBe(true);
    }
  });
});

describe("every reason the producers write", () => {
  it("is stored as a known code, never as `other`", () => {
    const lost: string[] = [];
    for (const file of producerFiles()) {
      for (const literal of reasonLiterals(readFileSync(file, "utf-8"))) {
        const code = stored(literal);
        if (code === undefined || code === JEV_REASON_OTHER) lost.push(`${literal} (${file.slice(ROOT.length + 1)})`);
      }
    }
    expect(lost, "add these to JEV_REASON_CODES here and in transform.rs").toEqual([]);
  });

  it("includes the handler's `unavailable` (the Jev review could not start)", () => {
    expect(JEV_REASON_CODES.has("unavailable")).toBe(true);
    expect(normalizeJevFallbackReason("unavailable")).toBe("unavailable");
  });
});
