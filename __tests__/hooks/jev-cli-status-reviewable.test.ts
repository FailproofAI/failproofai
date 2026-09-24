// @vitest-environment node
/**
 * `failproofai jev status` says how much of the policy set Jev may clear.
 *
 * The failure this covers is a beta user's whole experience of the feature: Jev
 * on, answering, falling back at 0%, clearing nothing — for ever — because the
 * pack their policies came from was published before this release and carries no
 * `authority` marks. Every other line of `status` looks healthy in that state,
 * and `warnAuthority` is silent by design (nothing asked to be reviewable, so
 * nothing was refused). `status` is where a person looks; it has to say it.
 *
 * Driven in-process against a throwaway FAILPROOFAI_HOME, pack root and cloud
 * root, from a cwd with no `.failproofai/` above it — the survey reads the
 * machine, so the machine has to be the temporary one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJevCommand, type JevCliDeps, type JevCliResult } from "../../src/hooks/jev-cli";
import { POLICY_CATALOG } from "../../src/hooks/policy-catalog";
import { RETAKE_PACK_COMMAND } from "../../src/hooks/policy-reviewability";
import { JEV_API_KEY_ENV } from "../../src/hooks/semantic/jev-config";

const KEY = ["cli", "reviewable", "0123456789abcdef"].join("-");
const RENDER = { render: { cols: 100, color: false } } satisfies JevCliDeps;
const withKey = (key: string): JevCliDeps => ({ ...RENDER, stdinIsTTY: false, readStdin: async () => `${key}\n` });
const text = (r: JevCliResult) => `${r.lines.join("\n")}\n${r.json ?? ""}`.replace(/\s+/g, " ");

/** A pack may not carry the always-on guard, so it is never one of these. */
const PACKABLE = POLICY_CATALOG.filter((p) => !p.alwaysOn);

const ENV_KEYS = ["FAILPROOFAI_HOME", "FAILPROOFAI_PACK_DIR", "FAILPROOFAI_CLOUD_POLICY_DIR", JEV_API_KEY_ENV, "FAILPROOFAI_EVALUATOR"] as const;

let home: string;
let project: string;
let packRoot: string;
let cloudRoot: string;
let saved: Record<string, string | undefined>;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-jev-authcount-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-jev-authcount-project-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-jev-authcount-packs-"));
  cloudRoot = mkdtempSync(join(tmpdir(), "fpai-jev-authcount-cloud-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  process.env.FAILPROOFAI_CLOUD_POLICY_DIR = cloudRoot;
  mkdirSync(process.env.FAILPROOFAI_HOME, { recursive: true, mode: 0o700 });
  cwd = process.cwd();
  process.chdir(project);
});

afterEach(() => {
  process.chdir(cwd);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of [home, project, packRoot, cloudRoot]) rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(process.env.FAILPROOFAI_HOME as string, "policies-config.json"), JSON.stringify(config));
}

/** An installed pack, written the way the loader verifies it. */
function installPack(policies: Array<Record<string, unknown>>): void {
  const artifact = "// a pack artifact this test never executes\n";
  const digest = createHash("sha256").update(artifact).digest("hex");
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  writeFileSync(join(packRoot, "artifacts", `${digest}.mjs`), artifact);
  writeFileSync(
    join(packRoot, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: [
        {
          id: "FailproofAI/policies",
          version: "0.9.0",
          source: "github:FailproofAI/policies@v0.9.0",
          entry: `artifacts/${digest}.mjs`,
          sha256: digest,
          policies,
        },
      ],
    }),
  );
}

/** The same policies a pre-release pack shipped: no `authority`, no `reviewedBy`. */
function unmarkedPackPolicies(): Array<Record<string, unknown>> {
  return PACKABLE.map((p) => {
    const { authority: _a, reviewedBy: _r, ...rest } = p;
    return rest as unknown as Record<string, unknown>;
  });
}

async function turnJevOn(): Promise<void> {
  const r = await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
  expect(r.exitCode).toBe(0);
}

describe("failproofai jev status — what Jev may clear", () => {
  it("says nothing new on a machine that never configured Jev", async () => {
    writeConfig({ enabledPolicies: POLICY_CATALOG.map((p) => p.name) });
    const r = await runJevCommand(["status"], RENDER);
    expect(r.exitCode).toBe(0);
    const out = text(r);
    expect(out).toContain("Jev is off");
    expect(out).not.toContain("reviewable");
    expect(out).not.toContain(RETAKE_PACK_COMMAND);

    const j = JSON.parse((await runJevCommand(["status", "--json"], RENDER)).json as string);
    expect(j.status).toBe("absent");
    expect("reviewablePolicies" in j).toBe(false);
  });

  it("counts zero and names the remedy when the pack carries no authority marks", async () => {
    writeConfig({ enabledPolicies: [] });
    installPack(unmarkedPackPolicies());
    await turnJevOn();

    const r = await runJevCommand(["status"], RENDER);
    expect(r.exitCode).toBe(0);
    const out = text(r);
    expect(out).not.toContain(KEY);
    // The pack's policies plus the always-on guard that ships compiled in.
    expect(out).toContain(`0 of ${PACKABLE.length + 1} enabled policies are reviewable.`);
    expect(out).toContain("it can never clear one");
    expect(out).toContain("published before this release carries no such marks");
    expect(out).toContain(RETAKE_PACK_COMMAND);
  });

  it("carries the same counts and the same reason in --json", async () => {
    writeConfig({ enabledPolicies: [] });
    installPack(unmarkedPackPolicies());
    await turnJevOn();

    const r = await runJevCommand(["status", "--json"], RENDER);
    expect(r.exitCode).toBe(0);
    expect(r.json).not.toContain(KEY);
    const j = JSON.parse(r.json as string);
    expect(j.reviewablePolicies).toMatchObject({
      enabled: PACKABLE.length + 1,
      reviewable: 0,
      customPolicyFiles: 0,
    });
    expect(j.reviewablePolicies.problem).toContain(RETAKE_PACK_COMMAND);
  });

  it("reports the seven Jev may clear, and complains about nothing, on this build's builtins", async () => {
    writeConfig({ enabledPolicies: POLICY_CATALOG.map((p) => p.name) });
    await turnJevOn();

    const r = await runJevCommand(["status"], RENDER);
    const out = text(r);
    expect(out).toContain(`6 of ${POLICY_CATALOG.length} enabled policies are reviewable`);
    expect(out).toContain("Jev may clear a deny or an instruction from those, and from no others.");
    expect(out).not.toContain(RETAKE_PACK_COMMAND);

    const j = JSON.parse((await runJevCommand(["status", "--json"], RENDER)).json as string);
    expect(j.reviewablePolicies).toEqual({
      enabled: POLICY_CATALOG.length,
      reviewable: 6,
      customPolicyFiles: 0,
      problem: null,
    });
  });

  it("says nothing about authority for a config the loader refused", async () => {
    writeConfig({ enabledPolicies: POLICY_CATALOG.map((p) => p.name) });
    writeFileSync(join(process.env.FAILPROOFAI_HOME as string, "jev.json"), JSON.stringify({ provider: "nope" }), { mode: 0o600 });
    const r = await runJevCommand(["status"], RENDER);
    // Hooks run the regex policies whatever any policy's authority says, so a
    // count here would answer a question this machine cannot ask yet.
    expect(r.exitCode).toBe(1);
    expect(text(r)).not.toContain("are reviewable");
  });
});
