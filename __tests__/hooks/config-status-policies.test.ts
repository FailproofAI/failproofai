import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Installed packs are digest-verified on read, so a fixture would have to be a
// real signed artifact; the manifest reader is stubbed instead and everything
// else — config merge, convention files — is read from a throwaway home.
vi.mock("../../src/hooks/pack-manifest", () => ({
  readInstalledPacks: vi.fn(() => ({ packs: [], errors: [] })),
  hasInstalledRegexPacks: vi.fn(() => false),
}));
vi.mock("../../src/hooks/cloud-managed-policies", () => ({
  readActiveCloudManagedPolicies: vi.fn(() => []),
}));

import { summarizePolicySources } from "../../src/hooks/config-status";
import { hasInstalledRegexPacks, readInstalledPacks } from "../../src/hooks/pack-manifest";
import { readActiveCloudManagedPolicies } from "../../src/hooks/cloud-managed-policies";

let dir: string;
let project: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fpai-status-policies-"));
  for (const key of ["HOME", "FAILPROOFAI_HOME"]) saved[key] = process.env[key];
  process.env.HOME = join(dir, "home");
  process.env.FAILPROOFAI_HOME = join(dir, "home", ".failproofai");
  mkdirSync(process.env.FAILPROOFAI_HOME, { recursive: true });
  project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  vi.mocked(readInstalledPacks).mockReturnValue({ packs: [], errors: [] } as never);
  vi.mocked(hasInstalledRegexPacks).mockReturnValue(false);
  vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([]);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const pack = (id: string, version: string, names: string[], over: Record<string, unknown> = {}) => ({
  id,
  version,
  source: id,
  path: "/x",
  sha256: "0",
  effect: "enforce",
  policies: names.map((name) => ({ name, description: name })),
  enabled: null,
  clis: null,
  ...over,
});

const writeGlobalConfig = (body: unknown) =>
  writeFileSync(join(process.env.FAILPROOFAI_HOME!, "policies-config.json"), JSON.stringify(body));

describe("summarizePolicySources", () => {
  it("counts what is on in each enforcing pack, minus what was switched off after install", () => {
    vi.mocked(readInstalledPacks).mockReturnValue({
      packs: [
        pack("FailproofAI/policies", "06b802b1c2d3", ["a", "b", "c", "d"], { enabled: ["a", "b", "c"] }),
        pack("acme/guards", "a1b2c3d4e5f6", ["x", "y"]),
        pack("acme/trial", "f00", ["t1", "t2"], { effect: "observe" }),
        pack("acme/empty", "e00", ["z"], { enabled: [] }),
      ],
      errors: [],
    } as never);
    writeGlobalConfig({ disabledCustomPolicies: ["pack:FailproofAI/policies@06b802b1c2d3:b"] });
    expect(summarizePolicySources(project)).toEqual({
      packOn: 4, // a, c from ours; x, y from acme
      firstPack: "FailproofAI/policies@06b802b1c2d3",
      morePacks: 1,
      cloudOn: 0,
      observing: 2,
      customFiles: 0,
      legacy: 0,
      refusedPacks: 0,
      packsInstalled: 4,
      anyPack: "FailproofAI/policies@06b802b1c2d3",
    });
  });

  it("names the first pack that has something on, not merely the first installed", () => {
    vi.mocked(readInstalledPacks).mockReturnValue({
      packs: [pack("acme/off", "1", ["p"], { enabled: [] }), pack("acme/on", "2", ["q"])],
      errors: [],
    } as never);
    const summary = summarizePolicySources(project);
    expect(summary.firstPack).toBe("acme/on@2");
    expect(summary.anyPack).toBe("acme/off@1");
    expect(summary.morePacks).toBe(0);
  });

  it("counts the refusals that deny, as `failproofai policies` does", () => {
    vi.mocked(readInstalledPacks).mockReturnValue({
      packs: [],
      errors: [
        { id: "acme/broken", reason: "digest mismatch", effect: "enforce" },
        { id: "acme/unknown-effect", reason: "unreadable" },
        // Neither of these has anything to fail closed on.
        { id: "acme/trial", reason: "digest mismatch", effect: "observe" },
        { id: "acme/jev-only", reason: "digest mismatch", effect: "enforce", semanticOnly: true },
      ],
    } as never);
    expect(summarizePolicySources(project).refusedPacks).toBe(2);
  });

  it("counts cloud-managed policies by effect", () => {
    vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([
      { id: "c1", effect: "enforce" },
      { id: "c2", effect: "enforce" },
      { id: "c3", effect: "observe" },
    ] as never);
    expect(summarizePolicySources(project)).toMatchObject({ cloudOn: 2, observing: 1 });
  });

  it("counts custom policy files and convention files, once each", () => {
    writeGlobalConfig({ customPoliciesPaths: ["/somewhere/mine.mjs"] });
    mkdirSync(join(project, ".failproofai", "policies"), { recursive: true });
    writeFileSync(join(project, ".failproofai", "policies", "team-policies.mjs"), "");
    writeFileSync(join(project, ".failproofai", "policies", "not-a-convention.mjs"), "");
    mkdirSync(join(process.env.FAILPROOFAI_HOME!, "policies"), { recursive: true });
    writeFileSync(join(process.env.FAILPROOFAI_HOME!, "policies", "my-policies.ts"), "");
    expect(summarizePolicySources(project).customFiles).toBe(3);
  });

  it("does not count the global convention folder twice when run from home", () => {
    mkdirSync(join(process.env.FAILPROOFAI_HOME!, "policies"), { recursive: true });
    writeFileSync(join(process.env.FAILPROOFAI_HOME!, "policies", "my-policies.ts"), "");
    expect(summarizePolicySources(process.env.HOME).customFiles).toBe(1);
  });

  it("counts builtins the pre-pack migration shim still runs, only while no regex pack exists", () => {
    writeGlobalConfig({ enabledPolicies: ["block-sudo", "block-env-files"] });
    expect(summarizePolicySources(project).legacy).toBe(2);
    vi.mocked(hasInstalledRegexPacks).mockReturnValue(true);
    expect(summarizePolicySources(project).legacy).toBe(0);
  });

  it("survives an unreadable pack manifest or deployment", () => {
    vi.mocked(readInstalledPacks).mockImplementation(() => {
      throw new Error("boom");
    });
    vi.mocked(readActiveCloudManagedPolicies).mockImplementation(() => {
      throw new Error("bad manifest");
    });
    expect(summarizePolicySources(project)).toMatchObject({ packOn: 0, cloudOn: 0, packsInstalled: 0 });
  });
});
