// @vitest-environment node
/**
 * A machine with no `jev.json` does not LOAD the two-tier evaluator's config
 * module, rather than loading it and being told there is nothing to read.
 *
 * `two-tier-single-engine.test.ts` pins the static half of this — every
 * `semantic/` import in `handler.ts` is type-only or dynamic — which keeps the
 * modules off an unconfigured machine's import graph but not off its hot path:
 * the dynamic import still ran on every gate event, because it sat in front of
 * the `loadJevConfig()` call that was going to return null. The opt-in is one
 * file, its absence is answerable with one stat, and the unconfigured path is
 * every customer's path on day one — so the stat comes first (`readJevConfig`).
 *
 * The mock factory here is the probe: vitest runs it the first time anything
 * imports that specifier, so an untouched flag means the module was never
 * imported at all. Both phases live in one test because the module registry is
 * per FILE, not per test: once phase 2 has loaded it, nothing can unload it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seen = vi.hoisted(() => ({ jevConfigModule: false }));
vi.mock("../../src/hooks/semantic/jev-config", async (importOriginal) => {
  seen.jevConfigModule = true;
  return await importOriginal<typeof import("../../src/hooks/semantic/jev-config")>();
});

import { evaluateHookEvent } from "../../src/hooks/handler";
import { _resetForTest } from "../../src/hooks/hook-activity-store";

const ENV = ["HOME", "FAILPROOFAI_HOME", "FAILPROOFAI_EVALUATOR", "CLAUDE_PROJECT_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let root: string;
let fpHome: string;
let project: string;

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "fpai-two-tier-load-"));
  fpHome = join(root, "home", ".failproofai");
  project = join(root, "home", "project");
  mkdirSync(fpHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(fpHome, "policies-config.json"), JSON.stringify({ enabledPolicies: ["block-sudo"] }));
  process.env.HOME = join(root, "home");
  process.env.FAILPROOFAI_HOME = fpHome;
  delete process.env.FAILPROOFAI_EVALUATOR;
  delete process.env.CLAUDE_PROJECT_DIR;
  _resetForTest(join(root, "activity"));
});

afterEach(() => {
  _resetForTest();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const run = (event: string, payload: Record<string, unknown>) =>
  evaluateHookEvent(event, "claude", JSON.stringify({ session_id: "s1", cwd: project, hook_event_name: event, ...payload }), {
    awaitTelemetryFlush: false,
  });

describe("the unconfigured hot path never loads the Jev config module", () => {
  it("loads it only once a jev.json is there", async () => {
    // Both callers: the gate event that would start a review, and the prompt
    // event that would record the human's intent for one.
    const gate = await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "sudo rm -rf /" } });
    await run("UserPromptSubmit", { prompt: "clean the build" });
    expect(seen.jevConfigModule).toBe(false);
    // And the regex tier answered as it always did.
    expect(gate.evaluation?.decision).toBe("deny");

    // The one file that opts the machine in. Its contents do not matter here:
    // `{}` is not a config the real loader accepts, so Jev stays off — what
    // changes is that the question is now worth asking, and asking it means
    // loading the module that knows how.
    writeFileSync(join(fpHome, "jev.json"), "{}");
    await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "sudo rm -rf /" } });
    expect(seen.jevConfigModule).toBe(true);
  });
});
