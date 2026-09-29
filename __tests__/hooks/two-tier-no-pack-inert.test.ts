// @vitest-environment node
/**
 * No pack, no Jev: a machine that CONFIGURED Jev — a valid BYOK `jev.json` in
 * enforce mode — but installed no pack declaring Jev checks must answer every
 * hook exactly as a machine that never configured Jev, and must never reach
 * the network for it.
 *
 * The npm package ships no Jev checks. They reach a machine only through
 * `failproofai policies add FailproofAI/jev-policies`, so until then there is
 * nothing to ask: no request (not even the injection or task probes), no intent
 * capture, and no reviewer, so every `reviewable` policy resolves hard.
 *
 * The reference is the same unconfigured golden `two-tier-unconfigured-
 * equivalence.test.ts` compares against, over the same corpus: every builtin
 * enabled through the migration shim, real tool calls on every CLI. The last
 * test installs the pack and shows the same call now does reach Jev, so the
 * silence above is the pack's absence and not something else switching Jev off.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Golden } from "./two-tier/corpus";
import { enterSandbox, runHandlerCorpus, type CorpusSandbox } from "./two-tier/runner";
import { installJevPoliciesPack } from "../fixtures/jev-policies";

const golden = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/two-tier/unconfigured-golden.json"), "utf8"),
) as Golden;

const CORPUS_TIMEOUT_MS = 30_000;

let sandbox: CorpusSandbox;
const realFetch = globalThis.fetch;
let requests: string[] = [];

beforeAll(() => {
  sandbox = enterSandbox();
  const fpHome = process.env.FAILPROOFAI_HOME!;
  // jev.json is read only from an owner-only directory.
  chmodSync(fpHome, 0o700);
  // A real, loadable BYOK config in ENFORCE mode — the strongest opt-in there is.
  writeFileSync(
    join(fpHome, "jev.json"),
    JSON.stringify({ provider: "typesafe", apiKey: "ts-test-key-not-real-0123456789", mode: "enforce" }),
    { mode: 0o600 },
  );
});
afterAll(() => {
  sandbox.restore();
});

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (url: unknown) => {
    requests.push(String(url));
    throw new Error("no network in this test");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Jev configured, no pack declaring Jev checks", () => {
  it("the config really is a usable, enforcing Jev config (or the rest proves nothing)", async () => {
    const { loadJevConfig } = await import("../../src/hooks/semantic/jev-config");
    expect(loadJevConfig()).toMatchObject({ provider: "typesafe", mode: "enforce" });
  });

  it("has no Jev checks and no reviewers", async () => {
    const { effectiveReviewerNames, forgetEffectiveReviewerNames, jevChecksInstalled } = await import(
      "../../src/hooks/effective-reviewers"
    );
    const { resolveSemanticPolicies } = await import("../../src/hooks/semantic/pack-policies");
    forgetEffectiveReviewerNames();
    expect(effectiveReviewerNames().size).toBe(0);
    expect(jevChecksInstalled()).toBe(false);
    expect(resolveSemanticPolicies()).toEqual([]);
  });

  it(
    "evaluateHookEvent: every hook is byte-identical to a machine with no jev.json, and nothing is sent",
    async () => {
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
      expect(requests).toEqual([]);
    },
    CORPUS_TIMEOUT_MS,
  );

  it("installing FailproofAI/jev-policies is what makes the same call reach Jev", async () => {
    const { evaluateHookEvent } = await import("../../src/hooks/handler");
    const payload = JSON.stringify({
      session_id: "no-pack-inert",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf ./build" },
      cwd: sandbox.root,
    });

    await evaluateHookEvent("PreToolUse", "claude", payload, { awaitTelemetryFlush: false });
    expect(requests).toEqual([]);

    installJevPoliciesPack(process.env.FAILPROOFAI_PACK_DIR!);
    await evaluateHookEvent("PreToolUse", "claude", payload, { awaitTelemetryFlush: false });
    expect(requests.length).toBeGreaterThan(0);
  });
});
