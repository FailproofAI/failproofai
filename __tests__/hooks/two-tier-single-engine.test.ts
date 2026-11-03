/**
 * "No second policy engine is reachable on daemon-configured machines beyond
 * what exists today" (CLAUDE.md, "Enforcement routes through the daemon").
 *
 * Jev is not a new evaluator entry point. It runs inside `evaluateHookEvent`
 * and nowhere else, so it is reached exactly where the regex engine already
 * was: the daemon's warm worker on a configured machine, and the in-process
 * `handleHookEvent` path only where `daemonConfigured` is false. On a
 * configured machine the CLI process itself calls `evaluateHookEvent` only on
 * the fail-closed `forceDecision` path — which never starts Jev (asserted
 * behaviourally in `two-tier-handler.test.ts`).
 *
 * This file pins the static half: who may import the semantic modules.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

const SHIPPED = [...sources(join(ROOT, "src")), ...sources(join(ROOT, "bin")), ...sources(join(ROOT, "lib"))];
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

/** Files whose source imports `specifier` (a path suffix), statically or dynamically. */
function importers(suffix: string): string[] {
  const re = new RegExp(`(?:from\\s+|import\\()\\s*["'][^"']*${suffix.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`);
  return SHIPPED.filter((p) => re.test(readFileSync(p, "utf8"))).map(rel).sort();
}

describe("the semantic evaluator has exactly one way in", () => {
  it("only the handler loads the Jev review", () => {
    expect(importers("semantic/jev-review")).toEqual(["src/hooks/handler.ts"]);
  });

  it("no hook-path module calls the semantic evaluator except through the Jev review", () => {
    // A CLI diagnostic (e.g. `failproofai jev test`) may use the semantic
    // modules; what matters is that nothing on the hook path does.
    const hookPath = [
      "src/hooks/handler.ts",
      "src/hooks/policy-evaluator.ts",
      "src/hooks/worker-server.ts",
      "src/hooks/daemon-client.ts",
      "bin/failproofai.mjs",
      "bin/failproofai-worker.mjs",
    ];
    // "/evaluator" matches `./evaluator` and `./semantic/evaluator`, never `./policy-evaluator`.
    const direct = importers("/evaluator");
    for (const file of hookPath) expect(direct).not.toContain(file);
    expect(direct).toContain("src/hooks/semantic/jev-review.ts");
  });

  it("the handler loads every semantic runtime module lazily, never at import time", () => {
    const handler = readFileSync(join(ROOT, "src/hooks/handler.ts"), "utf8");
    // Static imports from semantic/ are type-only: an unconfigured machine
    // never evaluates a line of the semantic evaluator.
    const staticSemantic = [...handler.matchAll(/^import (type )?[^;]*from "\.\/semantic\/[^"]+";/gm)];
    expect(staticSemantic.length).toBeGreaterThan(0);
    for (const m of staticSemantic) expect(m[1]).toBe("type ");
    for (const mod of ["jev-review", "jev-config", "intent"]) {
      expect(handler).toContain(`await import("./semantic/${mod}")`);
    }
  });

  it("only the policy evaluator runs the combine rules", () => {
    expect(importers("semantic/combine").filter((p) => !p.startsWith("src/hooks/semantic/"))).toEqual([
      // handler.ts imports it for the TYPE of the review handle only.
      "src/hooks/handler.ts",
      "src/hooks/policy-evaluator.ts",
    ]);
    expect(readFileSync(join(ROOT, "src/hooks/handler.ts"), "utf8")).toMatch(
      /import type \{ TwoTierReview \} from "\.\/semantic\/combine";/,
    );
  });

  it("the handler starts a review in exactly one place, inside evaluateHookEvent", () => {
    const handler = readFileSync(join(ROOT, "src/hooks/handler.ts"), "utf8");
    const calls = [...handler.matchAll(/\bstartTwoTier\(/g)];
    // The definition and one call.
    expect(calls).toHaveLength(2);
    const body = handler.slice(handler.indexOf("export async function evaluateHookEvent("));
    expect(body.indexOf("startTwoTier(")).toBeGreaterThan(0);
    expect(body.indexOf("startTwoTier(")).toBeLessThan(body.indexOf("export async function handleHookEvent("));
  });

  it("the daemon client and the fail-closed path never touch it", () => {
    for (const file of ["src/hooks/daemon-client.ts", "bin/failproofai.mjs", "src/hooks/worker-server.ts"]) {
      expect(readFileSync(join(ROOT, file), "utf8")).not.toMatch(/semantic\//);
    }
    // The warm worker reaches it only through the one shared entry point.
    expect(readFileSync(join(ROOT, "src/hooks/worker-server.ts"), "utf8")).toMatch(
      /import \{ evaluateHookEvent \} from "\.\/handler";/,
    );
  });
});
