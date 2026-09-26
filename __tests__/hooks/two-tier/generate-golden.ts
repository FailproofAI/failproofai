/**
 * Regenerates `__tests__/fixtures/two-tier/unconfigured-golden.json`.
 *
 * Run it ONLY on a build whose evaluation path is the one being preserved —
 * it was run once, on commit b766a940, before the two-tier wiring existed.
 * Running it on the two-tier build would record the new behaviour as the
 * reference and prove nothing.
 *
 *   bun __tests__/hooks/two-tier/generate-golden.ts <label>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GoldenBuilder } from "./corpus";
import { enterSandbox, runEvaluatorMatrix, runHandlerCorpus } from "./runner";

export const GOLDEN_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/two-tier/unconfigured-golden.json");

async function main(): Promise<void> {
  const label = process.argv[2];
  if (!label) throw new Error("usage: generate-golden.ts <label of the build being recorded>");
  const sandbox = enterSandbox();
  try {
    const builder = new GoldenBuilder(label);
    await runEvaluatorMatrix((id, v) => builder.addEvaluator(id, v));
    await runHandlerCorpus((id, v) => builder.addHandler(id, v), sandbox);
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
    writeFileSync(GOLDEN_PATH, JSON.stringify(builder.golden, null, 1) + "\n");
    const g = builder.golden;
    console.log(
      `evaluator cases: ${Object.keys(g.evaluator).length}, handler cases: ${Object.keys(g.handler).length}, distinct outputs: ${g.outputs.length}`,
    );
  } finally {
    sandbox.restore();
  }
}

await main();
