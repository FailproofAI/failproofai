// @vitest-environment node
/**
 * The facts the launch screen states, read from a throwaway home: which agents
 * are traced, which policies are on, and how the cloud connection stands.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTEGRATION_TYPES } from "../../src/hooks/types";
import { getIntegration } from "../../src/hooks/integrations";
import { failedDir } from "../../src/hooks/fp-home";
import { updateConfig, writeCredentials } from "../../src/hooks/fp-config";
import {
  gatherLaunchFacts,
  readLaunchCloud,
  readLaunchPolicies,
  readTracedAgentNames,
} from "../../scripts/launch-facts";

const ARTIFACT = "export const hooks = [];\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

let home: string;
let project: string;
let packRoot: string;
const AMBIENT = [
  "FAILPROOFAI_HOME",
  "FAILPROOFAI_PACK_DIR",
  "FAILPROOFAI_CLOUD_URL",
  "FAILPROOFAI_CLOUD_CREDENTIALS",
] as const;
let saved: Record<string, string | undefined>;

function wireClaude(): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "npx -y failproofai --hook PreToolUse", __failproofai_hook__: true }] },
        ],
      },
    }),
  );
}

function installPack(over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(packRoot, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: [
        {
          id: "acme/finance",
          version: "1.2.0",
          source: "github:acme/finance@v1.2.0",
          entry: `artifacts/${DIGEST}.mjs`,
          sha256: DIGEST,
          policies: [
            { name: "block-big-refund", description: "Block big refunds", category: "Finance", defaultEnabled: true, match: {} },
            { name: "require-note", description: "Require a note", category: "Finance", defaultEnabled: true, match: {} },
          ],
          ...over,
        },
      ],
    }),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-launch-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-launch-proj-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-launch-packs-"));
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  writeFileSync(join(packRoot, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  saved = Object.fromEntries(AMBIENT.map((key) => [key, process.env[key]]));
  for (const key of AMBIENT) delete process.env[key];
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  // Agent settings resolve from the OS home, not FAILPROOFAI_HOME.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, project, packRoot]) rmSync(dir, { recursive: true, force: true });
});

describe("gatherLaunchFacts", () => {
  it("states an untouched machine plainly, and warns that nothing enforces", () => {
    expect(gatherLaunchFacts(project)).toEqual({
      policies: "none on",
      agents: "none traced",
      cloud: "Not connected",
      notEnforcing: true,
    });
  });

  it("states a wired machine with a pack on, and does not warn", () => {
    wireClaude();
    installPack();
    expect(gatherLaunchFacts(project)).toEqual({
      policies: "2 on from acme/finance@1.2.0",
      agents: "1 traced: Claude Code",
      cloud: "Not connected",
      notEnforcing: false,
    });
  });
});

describe("readTracedAgentNames", () => {
  it("lists the agents hooked at user scope when no selection was saved", () => {
    wireClaude();
    expect(readTracedAgentNames(project)).toEqual(["Claude Code"]);
  });

  it("prefers the saved selection, in the canonical order, by display name", () => {
    wireClaude();
    updateConfig({ agents: { selected: ["goose", "codex", "not-an-agent"], seen: [] } });
    expect(readTracedAgentNames(project)).toEqual(["OpenAI Codex", "Goose"]);
  });

  it("an empty saved selection traces nothing, whatever is hooked", () => {
    wireClaude();
    updateConfig({ agents: { selected: [], seen: ["claude"] } });
    expect(readTracedAgentNames(project)).toEqual([]);
  });

  it("never asks the agents whether they are installed (that spawns `which`)", () => {
    const spies = INTEGRATION_TYPES.map((id) => vi.spyOn(getIntegration(id), "detectInstalled"));
    wireClaude();
    readTracedAgentNames(project);
    gatherLaunchFacts(project);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("readLaunchPolicies", () => {
  it("counts a pack's policies that are on", () => {
    installPack();
    expect(readLaunchPolicies(project)).toEqual({
      sources: [{ label: "acme/finance@1.2.0", count: 2, pack: true }],
      customFiles: false,
    });
  });

  it("subtracts a policy switched off after install, as the enforcing check does", () => {
    installPack();
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({ enabledPolicies: [], disabledCustomPolicies: ["pack:acme/finance@1.2.0:require-note"] }),
    );
    expect(readLaunchPolicies(project).sources).toEqual([{ label: "acme/finance@1.2.0", count: 1, pack: true }]);
  });

  it("leaves out a pack with everything off", () => {
    installPack({ enabled: [] });
    expect(readLaunchPolicies(project).sources).toEqual([]);
  });

  it("notices convention policy files without importing them", () => {
    mkdirSync(join(project, ".failproofai", "policies"), { recursive: true });
    writeFileSync(join(project, ".failproofai", "policies", "team-policies.mjs"), "throw new Error('must not be imported');\n");
    expect(readLaunchPolicies(project).customFiles).toBe(true);
  });
});

describe("readLaunchCloud", () => {
  const cloud = { url: "https://app.befailproof.ai", machineId: "m-1", token: "fp_test_token" };
  const ingest = { url: "https://app.befailproof.ai/v1/events", key: "fp_test_token" };

  it("is not connected with no credential", () => {
    expect(readLaunchCloud()).toEqual({ kind: "none" });
  });

  it("lets the environment win, as config --status does", () => {
    writeCredentials({ cloud, ingest });
    process.env.FAILPROOFAI_CLOUD_URL = "https://cloud.example.test";
    expect(readLaunchCloud()).toEqual({ kind: "environment", url: "https://cloud.example.test" });
  });

  it("names the org recorded at connect time", () => {
    writeCredentials({ cloud, ingest, org: { id: "org_1", slug: "acme", name: "Acme" } });
    expect(readLaunchCloud()).toEqual({
      kind: "connected",
      org: "Acme",
      host: "app.befailproof.ai",
      pulling: true,
      sending: true,
      refused: null,
    });
  });

  it("falls back to the host for a reporting-only key with no org", () => {
    writeCredentials({ ingest });
    expect(readLaunchCloud()).toEqual({
      kind: "connected",
      org: null,
      host: "app.befailproof.ai",
      pulling: false,
      sending: true,
      refused: null,
    });
  });

  it("reads the collector's refused batches over the credential file", () => {
    writeCredentials({ cloud, ingest, org: { slug: "acme" } });
    mkdirSync(failedDir(), { recursive: true });
    writeFileSync(join(failedDir(), "claude-2026-10-11-0.a3.c401.jsonl"), "{}\n");
    const summary = readLaunchCloud();
    expect(summary).toMatchObject({ kind: "connected", org: "acme", refused: { codes: [401], credential: true } });
  });
});
