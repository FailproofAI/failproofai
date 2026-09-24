// @vitest-environment node
/**
 * The /settings Jev panel's read action says what Jev may CLEAR.
 *
 * Same failure as `__tests__/hooks/jev-cli-status-reviewable.test.ts`, on the
 * other surface: a pack published before this release declares no `authority`,
 * so every policy is `hard`, so the half of the two-tier evaluator that clears
 * a verdict cannot fire — and the panel's other rows all look healthy. The
 * dashboard has to say it in the same words the CLI does, which is why both
 * take the sentence from `policy-reviewability.ts` rather than writing their
 * own.
 *
 * Isolated the way the survey demands: a throwaway home, pack root and cloud
 * root, and a cwd with no `.failproofai/` above it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getJevSettingsAction } from "../../app/actions/get-jev-config";
import { POLICY_CATALOG } from "../../src/hooks/policy-catalog";
import { RETAKE_PACK_COMMAND } from "../../src/hooks/policy-reviewability";

/** A token no provider issued. Nothing here should ever send it anywhere. */
const TOKEN = "jevtoken-0123456789-3f2a";
/** A pack may not carry the always-on guard. */
const PACKABLE = POLICY_CATALOG.filter((p) => !p.alwaysOn);

const ENV_KEYS = ["FAILPROOFAI_HOME", "FAILPROOFAI_PACK_DIR", "FAILPROOFAI_CLOUD_POLICY_DIR", "FAILPROOFAI_JEV_API_KEY"] as const;

let home: string;
let project: string;
let packRoot: string;
let saved: Record<string, string | undefined>;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-panel-authcount-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-panel-authcount-project-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-panel-authcount-packs-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  process.env.FAILPROOFAI_CLOUD_POLICY_DIR = join(home, "cloud");
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
  for (const dir of [home, project, packRoot]) rmSync(dir, { recursive: true, force: true });
});

const fpHome = () => process.env.FAILPROOFAI_HOME as string;

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(fpHome(), "policies-config.json"), JSON.stringify(config));
}

/** Jev on, at the permissions the loader requires. Never a real endpoint. */
function turnJevOn(): void {
  const path = join(fpHome(), "jev.json");
  writeFileSync(path, JSON.stringify({ provider: "typesafe", apiKey: TOKEN }), { mode: 0o600 });
  chmodSync(path, 0o600);
}

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

/** A pre-release pack's entries: the policies, without the two authority fields. */
function unmarkedPackPolicies(): Array<Record<string, unknown>> {
  return PACKABLE.map((p) => {
    const { authority: _a, reviewedBy: _r, ...rest } = p;
    return rest as unknown as Record<string, unknown>;
  });
}

describe("getJevSettingsAction — what Jev may clear", () => {
  it("says nothing about authority while Jev is off", async () => {
    writeConfig({ enabledPolicies: POLICY_CATALOG.map((p) => p.name) });
    const view = await getJevSettingsAction();
    expect(view.status).toBe("absent");
    expect(view.on).toBe(false);
    expect(view.reviewable).toBeNull();
    expect(JSON.stringify(view)).not.toContain(RETAKE_PACK_COMMAND);
  });

  it("reports zero of N, with the cause and the remedy, for an unmarked pack", async () => {
    writeConfig({ enabledPolicies: [] });
    installPack(unmarkedPackPolicies());
    turnJevOn();

    const view = await getJevSettingsAction();
    expect(view.on).toBe(true);
    // The pack's policies plus the always-on guard compiled into this build.
    expect(view.reviewable).toMatchObject({ enabled: PACKABLE.length + 1, reviewable: 0 });
    expect(view.reviewable?.summary).toBe(`0 of ${PACKABLE.length + 1} enabled policies are reviewable.`);
    expect(view.reviewable?.problem).toContain("it can never clear one");
    expect(view.reviewable?.problem).toContain(RETAKE_PACK_COMMAND);
    // The one rule this module lives by still holds for the new field.
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it("reports the seven reviewable builtins and no problem", async () => {
    writeConfig({ enabledPolicies: POLICY_CATALOG.map((p) => p.name) });
    turnJevOn();

    const view = await getJevSettingsAction();
    expect(view.reviewable).toEqual({
      enabled: POLICY_CATALOG.length,
      reviewable: 15,
      summary:
        `15 of ${POLICY_CATALOG.length} enabled policies are reviewable: ` +
        "Jev may clear a deny or an instruction from those, and from no others.",
      problem: null,
    });
  });

  it("stays silent for a file the loader refused, where nothing can be cleared anyway", async () => {
    writeConfig({ enabledPolicies: POLICY_CATALOG.map((p) => p.name) });
    const path = join(fpHome(), "jev.json");
    writeFileSync(path, JSON.stringify({ provider: "nope" }), { mode: 0o600 });
    const view = await getJevSettingsAction();
    expect(view.status).toBe("refused");
    expect(view.reviewable).toBeNull();
  });
});
