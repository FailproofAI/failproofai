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
 *
 * It is still byte-identical, and that is now a slightly narrower claim than
 * it reads. `block-read-outside-cwd`'s path extractor DID change in #833: a
 * run of slashes with nothing else (`//`, a line-comment marker) is no longer
 * read as the filesystem root, and a match can no longer start on the second
 * slash of a protocol separator (`http://host/x` no longer yields `/host/x`).
 * That is a real, user-visible change for a machine with no Jev configured.
 *
 * Three corpus strings are read differently by the new extractor —
 * `bash:curl-pipe-sh`, `bash:aws` and `post:conn`'s output — and none of them
 * changes a verdict: the first two are not read-like commands, so
 * `blockReadOutsideCwd` returns before extracting anything, and the third is a
 * tool response, which the extractor never sees. So the recording still holds,
 * and `__tests__/hooks/block-read-outside-cwd.test.ts` is where that change is
 * pinned — not here. Do not read this file's silence as coverage of it.
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

/**
 * The two corpus tests make ~1,500 and ~550 real evaluations in one `it`:
 * about 1–3 s on a quiet machine, and past vitest's 5 s default under a
 * parallel full suite. A timeout there is not a difference, and it leaves the
 * corpus loop writing into a sandbox `afterAll` already removed.
 */
const CORPUS_TIMEOUT_MS = 30_000;

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
  }, CORPUS_TIMEOUT_MS);

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
  }, CORPUS_TIMEOUT_MS);
});
