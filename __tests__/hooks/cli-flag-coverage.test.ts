// @vitest-environment node
/**
 * `bin/failproofai.mjs` keeps its own hand-written lists of accepted `--cli`
 * values, and they drift silently.
 *
 * Two of them were already wrong for `ori` when this test was written, and the
 * failure modes are not symmetric:
 *
 *   • The three `VALID_CLIS` sets REJECT an unlisted CLI outright — loud, so a
 *     human notices immediately (`Missing value(s) for --cli`).
 *   • The `--hook` guard FALLS BACK TO `"claude"` for anything unlisted. That
 *     one is silent: the hook runs, policies evaluate, activity is recorded,
 *     and the verdict is emitted in CLAUDE's wire shape to a CLI that cannot
 *     parse it. Installed, running, costing latency, enforcing nothing — the
 *     exact failure this repo has already shipped once, when our Claude hooks
 *     ran inert inside grok.
 *
 * Reading the source is deliberate. These lists cannot import INTEGRATION_TYPES
 * (bin/ is plain JS that node must parse before any bundling), so the only way
 * to keep them honest is to check the text against the source of truth.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INTEGRATION_TYPES } from "@/src/hooks/types";

const BIN = readFileSync(resolve(process.cwd(), "bin/failproofai.mjs"), "utf8");

describe("bin/failproofai.mjs --cli lists cover every integration", () => {
  it("INSTALLABLE_CLIS lists every integration", () => {
    // The three `--cli` validators all read this one array, so it is the single
    // place a new integration has to be added for `policies --install --cli <x>`
    // to stop rejecting it.
    const m = BIN.match(/const INSTALLABLE_CLIS = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const listed = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect([...listed].sort()).toEqual([...INTEGRATION_TYPES].sort());
  });

  it("every VALID_CLIS set is built from INSTALLABLE_CLIS, not a second hand-written list", () => {
    // A literal here would drift from the array above the moment a CLI is added
    // — which is exactly how grok and qwen ended up rejected by `--install`.
    const literals = [...BIN.matchAll(/const VALID_CLIS = new Set\((\[[^\]]*\])\)/g)];
    expect(literals.map((m) => m[1])).toEqual([]);
  });

  it("the --hook guard lists every integration, so none silently becomes claude", () => {
    // The guard is a chain of `cliArg === "<name>"` comparisons ending in a
    // `: "claude"` fallback. A CLI missing from the chain does not error — it
    // is quietly evaluated and answered as Claude.
    const guard = BIN.slice(0, BIN.indexOf('? cliArg\n      : "claude"'));
    const listed = new Set([...guard.matchAll(/cliArg === "([^"]+)"/g)].map((m) => m[1]));
    const missing = INTEGRATION_TYPES.filter((c) => c !== "claude" && !listed.has(c));
    expect(missing).toEqual([]);
  });
});
