// @vitest-environment node
/**
 * Managing ONE policy of an installed pack from the CLI.
 *
 * Until this existed a pack could be installed and then not managed at all:
 * every name went through a validator whose set is the compiled builtins, so
 * `failproofai policies --uninstall block-big-refund` answered "Unknown policy
 * name" and listed 39 names that were not the one the user meant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARTIFACT = "export const hooks = [];\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

let home: string;
let project: string;
let packRoot: string;
let saved: Record<string, string | undefined>;

function pack(id: string, policies: string[], over: Record<string, unknown> = {}) {
  return {
    id,
    version: "1.2.0",
    source: `github:${id}@v1.2.0`,
    entry: `artifacts/${DIGEST}.mjs`,
    sha256: DIGEST,
    policies: policies.map((name) => ({
      name,
      description: `does ${name}`,
      category: "Finance",
      defaultEnabled: true,
      match: {},
    })),
    ...over,
  };
}

function install(...packs: unknown[]): void {
  writeFileSync(join(packRoot, "installed.json"), JSON.stringify({ schemaVersion: 1, packs }));
}

const installed = () =>
  JSON.parse(readFileSync(join(packRoot, "installed.json"), "utf8")) as {
    packs: Array<{ id: string; enabled?: string[] }>;
  };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-toggle-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-toggle-proj-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-toggle-packs-"));
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  writeFileSync(join(packRoot, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  saved = {
    FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
    FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
  };
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of [home, project, packRoot]) rmSync(dir, { recursive: true, force: true });
});

describe("turning a pack policy off", () => {
  it("records it in the pack's selection, not as a version-keyed disable", async () => {
    install(pack("acme/finance", ["block-big-refund", "require-note"]));
    const { removeHooks } = await import("@/src/hooks/manager");
    await removeHooks(["block-big-refund"], "user", project);
    const [entry] = installed().packs;
    // The selection outlives an upgrade; a `pack:<id>@<version>:<name>` key does
    // not, which is why it is not the lever.
    expect(entry.enabled).toEqual(["require-note"]);
  });

  it("does NOT fall through and rip out every hook", async () => {
    // The stripped name list is empty at that point, which is the branch that
    // removes failproofai from every CLI.
    install(pack("acme/finance", ["block-big-refund"]));
    const { removeHooks } = await import("@/src/hooks/manager");
    const settings = join(project, ".claude", "settings.json");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [] }] } }));
    await removeHooks(["block-big-refund"], "project", project);
    expect(existsSync(settings)).toBe(true);
    expect(JSON.parse(readFileSync(settings, "utf8")).hooks).toBeDefined();
  });
});

describe("turning a pack policy back on", () => {
  it("restores it and clears a disable written from the dashboard", async () => {
    install(pack("acme/finance", ["block-big-refund", "require-note"], { enabled: ["require-note"] }));
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({
        enabledPolicies: [],
        disabledCustomPolicies: ["pack:acme/finance@1.2.0:block-big-refund"],
      }),
    );
    const { installHooks } = await import("@/src/hooks/manager");
    await installHooks(["block-big-refund"], "user", project, false, undefined, undefined, false, []);
    const [entry] = installed().packs;
    expect(entry.enabled).toContain("block-big-refund");
    const config = JSON.parse(readFileSync(join(home, "policies-config.json"), "utf8"));
    // Two switches for one policy: leaving the second set would report the
    // policy enabled while it stayed off.
    expect(config.disabledCustomPolicies ?? []).not.toContain(
      "pack:acme/finance@1.2.0:block-big-refund",
    );
  });
});

describe("resolving the name", () => {
  it("refuses a name two packs both declare, and spells out the qualified form", async () => {
    install(pack("acme/finance", ["block-big-refund"]), pack("other/pack", ["block-big-refund"]));
    const { removeHooks } = await import("@/src/hooks/manager");
    await expect(removeHooks(["block-big-refund"], "user", project)).rejects.toThrow(
      /acme\/finance:block-big-refund/,
    );
  });

  it("takes the qualified form", async () => {
    install(pack("acme/finance", ["block-big-refund"]), pack("other/pack", ["block-big-refund"]));
    const { removeHooks } = await import("@/src/hooks/manager");
    await removeHooks(["other/pack:block-big-refund"], "user", project);
    const byId = Object.fromEntries(installed().packs.map((p) => [p.id, p.enabled]));
    expect(byId["other/pack"]).toEqual([]);
    expect(byId["acme/finance"]).toBeUndefined();
  });

  it("resolves a bare name to the PACK, because that is where the switch is", async () => {
    // The order used to favour the compiled set. That made `policy remove
    // block-sudo` edit `enabledPolicies` — a list that stopped deciding
    // anything when this build stopped registering builtins — so the command
    // reported success while the policy kept denying.
    install(pack("acme/finance", ["block-sudo"]));
    const { removeHooks } = await import("@/src/hooks/manager");
    await removeHooks(["block-sudo"], "user", project);
    const [entry] = installed().packs;
    expect(entry.enabled).toEqual([]);
  });

  it("still rejects an unknown name, and now names the pack's policies too", async () => {
    install(pack("acme/finance", ["block-big-refund"]));
    const { removeHooks } = await import("@/src/hooks/manager");
    await expect(removeHooks(["not-a-policy"], "user", project)).rejects.toThrow(
      /acme\/finance:block-big-refund/,
    );
  });
});
