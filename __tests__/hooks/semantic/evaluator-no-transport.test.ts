// @vitest-environment node
/**
 * `evaluateSemantic` reaches Jev only through the transport its caller hands
 * it. There is no fallback that goes looking for credentials on disk: the
 * product path always passes the BYOK config's transport (`jev-review.ts`),
 * and a machine without a `jev.json` must never reach Jev at all — even when
 * it happens to hold credentials for a Jev provider elsewhere, as a developer
 * machine with `~/.config/typesafe/` does.
 *
 * The credentials here are fake, built at runtime, in a throwaway HOME.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { evaluateSemantic } from "../../../src/hooks/semantic/evaluator";
import type { SemanticInput } from "../../../src/hooks/semantic/types";

const ENV = ["HOME", "FAILPROOFAI_HOME", "FAILPROOFAI_JEV_CONFIG_DIR", "TYPESAFE_API_KEY"];
const saved: Record<string, string | undefined> = {};
let root: string;
let fetchSpy: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "fpai-no-transport-"));
  const home = join(root, "home");
  const creds = join(home, ".config", "typesafe");
  mkdirSync(creds, { recursive: true });
  // Fake credentials, in every shape the old on-disk lookup read.
  writeFileSync(join(creds, "cloudflare_token"), randomBytes(20).toString("hex"), { mode: 0o600 });
  writeFileSync(join(creds, "cloudflare.json"), JSON.stringify({ accountId: randomBytes(16).toString("hex") }), { mode: 0o600 });
  writeFileSync(join(creds, "api_key"), randomBytes(20).toString("hex"), { mode: 0o600 });
  process.env.HOME = home;
  process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  process.env.FAILPROOFAI_JEV_CONFIG_DIR = creds;
  process.env.TYPESAFE_API_KEY = randomBytes(20).toString("hex");
  fetchSpy = vi.fn(async () => {
    throw new Error("no network in this test");
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const DELETION: SemanticInput = {
  eventType: "PreToolUse",
  toolName: "Bash",
  toolInput: { command: "rm -rf build" },
  cwd: "/work/project",
  userSaid: ["tidy the build folder"],
  agentLastMessage: null,
};

describe("evaluateSemantic without a transport", () => {
  it.each([
    ["v0 (default)", {}],
    ["v1, as the product asks", { intent: "v1" as const }],
  ])("%s: degraded('no-transport'), and nothing is sent anywhere", async (_label, opts) => {
    const outcome = await evaluateSemantic(DELETION, opts);
    expect(outcome.status).toBe("degraded");
    expect(outcome).toMatchObject({ status: "degraded", reason: "no-transport" });
    expect(outcome.questionCount).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
