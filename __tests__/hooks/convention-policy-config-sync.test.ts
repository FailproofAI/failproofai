// @vitest-environment node
//
// `policies-config.json` recorded enabled builtins and an explicit
// `customPoliciesPath`, but nothing at all for policies dropped into
// `.failproofai/policies/` — so a user who installed four convention policies
// saw an empty-looking config and reasonably concluded discovery was broken.
//
// `failproofai policies` now mirrors what it lists into the config. The mirror
// is descriptive only: enforcement still discovers from the filesystem, so
// these tests also pin that a stale or absent record never gates a policy.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listHooks } from "@/src/hooks/manager";
import { syncConventionPolicies } from "@/src/hooks/hooks-config";

function policySource(hookName: string): string {
  return `
    import { customPolicies, allow } from "failproofai";
    customPolicies.add({
      name: ${JSON.stringify(hookName)},
      description: "test policy",
      match: { events: ["PreToolUse"] },
      fn: async () => allow(),
    });
  `;
}

describe("convention policies are mirrored into policies-config.json", () => {
  let home: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const configPath = () => join(home, ".failproofai", "policies-config.json");
  const readConfig = () => JSON.parse(readFileSync(configPath(), "utf8"));

  function seed(files: Record<string, string>) {
    const dir = join(home, ".failproofai", "policies");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body, "utf8");
    }
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fp-sync-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("records each discovered file and the hooks it registered", async () => {
    seed({ "team-policies.mjs": policySource("team-rule") });
    writeFileSync(configPath(), JSON.stringify({ enabledPolicies: [] }), "utf8");

    await listHooks(home);

    expect(readConfig().conventionPolicies).toEqual([
      { file: "team-policies.mjs", hooks: ["team-rule"] },
    ]);
  });

  it("preserves the keys that were already there", async () => {
    seed({ "team-policies.mjs": policySource("team-rule") });
    writeFileSync(
      configPath(),
      JSON.stringify({ enabledPolicies: ["warn-schema-alteration"], policyParams: { foo: { a: 1 } } }),
      "utf8",
    );

    await listHooks(home);

    const config = readConfig();
    expect(config.enabledPolicies).toEqual(["warn-schema-alteration"]);
    expect(config.policyParams).toEqual({ foo: { a: 1 } });
    expect(config.conventionPolicies).toHaveLength(1);
  });

  it("drops a file from the record once it is deleted", async () => {
    seed({
      "team-policies.mjs": policySource("team-rule"),
      "extra-policies.mjs": policySource("extra-rule"),
    });
    writeFileSync(configPath(), JSON.stringify({ enabledPolicies: [] }), "utf8");
    await listHooks(home);
    expect(readConfig().conventionPolicies).toHaveLength(2);

    rmSync(join(home, ".failproofai", "policies", "extra-policies.mjs"));
    await listHooks(home);

    // Wholesale replace, not merge — a stale entry would claim a policy is
    // installed when the file is gone.
    expect(readConfig().conventionPolicies).toEqual([
      { file: "team-policies.mjs", hooks: ["team-rule"] },
    ]);
  });

  it("does not rewrite the file when nothing changed", async () => {
    seed({ "team-policies.mjs": policySource("team-rule") });
    writeFileSync(configPath(), JSON.stringify({ enabledPolicies: [] }), "utf8");
    await listHooks(home);
    const firstWrite = statSync(configPath()).mtimeMs;

    await new Promise((r) => setTimeout(r, 10));
    await listHooks(home);

    expect(statSync(configPath()).mtimeMs).toBe(firstWrite);
  });

  it("does not create a config file just to record an empty list", () => {
    const empty = mkdtempSync(join(tmpdir(), "fp-sync-empty-"));
    try {
      const wrote = syncConventionPolicies([], "project", empty);
      expect(wrote).toBe(false);
      expect(existsSync(join(empty, ".failproofai", "policies-config.json"))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("removes the key entirely when the last policy file goes away", async () => {
    seed({ "team-policies.mjs": policySource("team-rule") });
    writeFileSync(configPath(), JSON.stringify({ enabledPolicies: [] }), "utf8");
    await listHooks(home);
    expect(readConfig().conventionPolicies).toBeDefined();

    rmSync(join(home, ".failproofai", "policies", "team-policies.mjs"));
    await listHooks(home);

    expect("conventionPolicies" in readConfig()).toBe(false);
  });

  // `.failproofai/policies-config.json` is routinely committed — this repo
  // tracks its own — so persisting the record at project scope would make a
  // plain `failproofai policies` dirty the working tree and put a spurious diff
  // in front of every contributor. A read command must not do that.
  it("never writes the record into a project config", async () => {
    const project = mkdtempSync(join(tmpdir(), "fp-proj-"));
    try {
      const dir = join(project, ".failproofai", "policies");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "proj-policies.mjs"), policySource("proj-rule"), "utf8");
      const projConfig = join(project, ".failproofai", "policies-config.json");
      const original = JSON.stringify({ enabledPolicies: ["block-sudo"] }, null, 2) + "\n";
      writeFileSync(projConfig, original, "utf8");

      await listHooks(project);

      expect(readFileSync(projConfig, "utf8")).toBe(original);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  // DATA LOSS GUARD. `readScopedHooksConfig` fails soft, returning
  // {enabledPolicies: []} when the file will not parse — right for the hook
  // path, fatal here. Writing that default back destroys everything the user
  // had. One stray comma in a hand-edited config plus a `failproofai policies`
  // run used to wipe every enabled policy, from a read-only command.
  it("never overwrites a config file that does not parse", async () => {
    seed({ "team-policies.mjs": policySource("team-rule") });
    const malformed = '{\n  "enabledPolicies": ["block-sudo"],\n  OOPS\n}\n';
    writeFileSync(configPath(), malformed, "utf8");

    await listHooks(home);

    expect(readFileSync(configPath(), "utf8")).toBe(malformed);
  });

  it("reports not-written for an unparseable config", () => {
    const dir = mkdtempSync(join(tmpdir(), "fp-bad-"));
    try {
      mkdirSync(join(dir, ".failproofai"), { recursive: true });
      writeFileSync(join(dir, ".failproofai", "policies-config.json"), "{ nope", "utf8");
      const wrote = syncConventionPolicies(
        [{ file: "x-policies.mjs", hooks: ["x"] }],
        "project",
        dir,
      );
      expect(wrote).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
