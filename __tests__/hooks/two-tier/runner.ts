/**
 * Runs the unconfigured-equivalence corpus (see `corpus.ts`) against whatever
 * build is checked out. Shared by the golden generator and the equivalence
 * test so both measure exactly the same thing.
 *
 * Everything that could read or write a real machine's state is pointed at a
 * throwaway directory first: HOME (transcript discovery for codex / copilot /
 * cursor / pi / factory / antigravity reads under it), FAILPROOFAI_HOME (config,
 * activity store, cloud policies) and FAILPROOFAI_PACK_DIR (installed packs).
 * No `jev.json` is ever written — this is the unconfigured path by construction.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMetadata } from "../../../src/hooks/types";
import {
  EVALUATOR_SCENARIOS,
  MATRIX_CLIS,
  MATRIX_EVENTS,
  comparableHandlerOutcome,
  type ComparableHandlerOutcome,
  handlerCorpus,
  matrixPayload,
} from "./corpus";

type Add = (id: string, value: unknown) => void;
type AddHandler = (id: string, value: ComparableHandlerOutcome) => void;

const ENV_KEYS = ["HOME", "FAILPROOFAI_HOME", "FAILPROOFAI_PACK_DIR", "FAILPROOFAI_TELEMETRY_DISABLED", "FAILPROOFAI_EVALUATOR"] as const;

export interface CorpusSandbox {
  root: string;
  restore(): void;
}

export function enterSandbox(): CorpusSandbox {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const root = mkdtempSync(join(tmpdir(), "fpai-two-tier-golden-"));
  const home = join(root, "home");
  const fpHome = join(home, ".failproofai");
  const packs = join(root, "packs");
  mkdirSync(fpHome, { recursive: true });
  mkdirSync(packs, { recursive: true });
  process.env.HOME = home;
  process.env.FAILPROOFAI_HOME = fpHome;
  process.env.FAILPROOFAI_PACK_DIR = packs;
  process.env.FAILPROOFAI_TELEMETRY_DISABLED = "1";
  delete process.env.FAILPROOFAI_EVALUATOR;
  return {
    root,
    restore() {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function runEvaluatorMatrix(add: Add): Promise<void> {
  const { clearPolicies, registerPolicy } = await import("../../../src/hooks/policy-registry");
  const { evaluatePolicies } = await import("../../../src/hooks/policy-evaluator");
  for (const scenario of EVALUATOR_SCENARIOS) {
    for (const cli of MATRIX_CLIS) {
      for (const event of MATRIX_EVENTS) {
        clearPolicies();
        for (const p of scenario.policies) {
          registerPolicy(
            p.name,
            `synthetic ${p.name}`,
            async () => {
              if (p.decision === "throw") throw new Error("synthetic failure");
              return { decision: p.decision, ...(p.reason ? { reason: p.reason } : {}) };
            },
            { events: [event] },
            p.priority ?? 0,
          );
        }
        const session: SessionMetadata = { sessionId: "matrix-session", cli, cwd: "/nonexistent-fpai-golden/project" };
        const result = await evaluatePolicies(event, matrixPayload(event), session, {
          enabledPolicies: [],
          ...(scenario.policyParams ? { policyParams: scenario.policyParams } : {}),
        });
        add(`${scenario.id}|${cli}|${event}`, result);
      }
    }
  }
  clearPolicies();
}

export async function runHandlerCorpus(add: AddHandler, sandbox: CorpusSandbox): Promise<void> {
  const { BUILTIN_POLICIES } = await import("../../../src/hooks/builtin-policies");
  const fpHome = process.env.FAILPROOFAI_HOME!;
  writeFileSync(
    join(fpHome, "policies-config.json"),
    JSON.stringify({ enabledPolicies: BUILTIN_POLICIES.map((p) => p.name) }),
  );
  const { evaluateHookEvent } = await import("../../../src/hooks/handler");
  const store = await import("../../../src/hooks/hook-activity-store");
  const { clearGitBranchCache } = await import("../../../src/hooks/builtin-policies");
  let n = 0;
  try {
    for (const cli of MATRIX_CLIS) {
      for (const c of handlerCorpus()) {
        clearGitBranchCache();
        // A fresh store per case, so the rows read back are exactly this case's.
        store._resetForTest(join(sandbox.root, "activity", String(n++)));
        const outcome = await evaluateHookEvent(c.event, cli, JSON.stringify(c.payload), { awaitTelemetryFlush: false });
        const rows = store.getAllHookActivityEntries();
        const row = rows.length === 1 ? (rows[0] as unknown as Record<string, unknown>) : null;
        add(`${c.id}|${cli}`, comparableHandlerOutcome(outcome as never, row));
      }
    }
  } finally {
    store._resetForTest();
  }
}
