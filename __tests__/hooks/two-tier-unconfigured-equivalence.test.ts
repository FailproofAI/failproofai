// @vitest-environment node
/**
 * With no Jev config, the two-tier build must answer every hook EXACTLY as
 * the build before it did: same exit code, same stdout, same stderr, same
 * evaluation summary, same persisted activity row (key order included).
 *
 * The reference is a golden file recorded from commit b766a940 — main plus
 * the T0 port, before the evaluation path changed — over two corpora (see
 * `two-tier/corpus.ts`): every per-CLI response shape through
 * `evaluatePolicies`, and real tool calls through `evaluateHookEvent` with
 * every builtin enabled. A difference here is a behaviour change for every
 * customer who never configured Jev, which is all of them on day one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CORPUS_BUILTINS, type Golden } from "./two-tier/corpus";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import { enterSandbox, runEvaluatorMatrix, runHandlerCorpus, type CorpusSandbox } from "./two-tier/runner";

const golden = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/two-tier/unconfigured-golden.json"), "utf8"),
) as Golden;

let sandbox: CorpusSandbox;
beforeAll(() => {
  sandbox = enterSandbox();
});
afterAll(() => {
  sandbox.restore();
});

describe("unconfigured equivalence (no jev.json)", () => {
  it("records a meaningful corpus", () => {
    expect(Object.keys(golden.evaluator).length).toBe(1536);
    expect(Object.keys(golden.handler).length).toBe(552);
    // The corpus must actually exercise every decision, or equality proves little.
    const outs = golden.outputs.join("\n");
    for (const needle of ['"decision":"deny"', '"decision":"instruct"', '"decision":"allow"', "MANDATORY ACTION REQUIRED"]) {
      expect(outs).toContain(needle);
    }
  });

  it("still enables real builtins: every pinned name exists in the catalog", () => {
    const names = new Set(BUILTIN_POLICIES.map((p) => p.name));
    expect(CORPUS_BUILTINS.filter((n) => !names.has(n))).toEqual([]);
    expect(CORPUS_BUILTINS).toHaveLength(39);
  });

  it("evaluatePolicies: every CLI × event × allow/instruct/deny combination is byte-identical", async () => {
    const mismatches: string[] = [];
    let seen = 0;
    await runEvaluatorMatrix((id, value) => {
      seen++;
      const want = golden.outputs[golden.evaluator[id]];
      const got = JSON.stringify(value);
      if (got !== want) mismatches.push(`${id}\n  want ${want}\n  got  ${got}`);
    });
    expect(seen).toBe(Object.keys(golden.evaluator).length);
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it("evaluateHookEvent: real tool calls on all 12 CLIs, with every builtin enabled, are byte-identical", async () => {
    const mismatches: string[] = [];
    let seen = 0;
    await runHandlerCorpus((id, value) => {
      seen++;
      const want = golden.handler[id];
      const gotOut = JSON.stringify(value.out);
      if (!want) {
        mismatches.push(`${id}: not in the golden`);
        return;
      }
      if (gotOut !== golden.outputs[want.out]) {
        mismatches.push(`${id}\n  want ${golden.outputs[want.out]}\n  got  ${gotOut}`);
      }
      if (value.activity !== want.activity) {
        mismatches.push(`${id}: activity row differs (want digest ${want.activity}); got ${JSON.stringify(value.activityRow)}`);
      }
    }, sandbox);
    expect(seen).toBe(Object.keys(golden.handler).length);
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});
