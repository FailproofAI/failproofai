// @vitest-environment node
/**
 * Installing and managing a pack from the LOCAL DASHBOARD.
 *
 * The dashboard could show builtins, custom files, convention files and Cloud
 * policies, and knew nothing about packs — so a pack could be installed from the
 * CLI and then be invisible and unmanageable in the UI, and there was no way to
 * get one without a terminal.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import {
  addPackWebAction,
  removePackWebAction,
  togglePackPolicyAction,
} from "@/app/actions/pack-actions";
import { getHooksConfigAction } from "@/app/actions/get-hooks-config";

const ENTRY = `
  import { customPolicies } from "failproofai";
  customPolicies.add({ name: "block-prod-deploy", description: "d",
    match: { events: ["PreToolUse"] }, fn: async () => ({ decision: "allow" }) });
  customPolicies.add({ name: "warn-restart", description: "d",
    match: { events: ["PreToolUse"] }, fn: async () => ({ decision: "allow" }) });
`;

const policy = (name: string, defaultEnabled: boolean) => ({
  name, description: `does ${name}`, category: "Ops", defaultEnabled,
  match: { events: ["PreToolUse"] },
});

let home: string;
let project: string;
let packRoot: string;
let server: Server;
let assets: Record<string, string>;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "fpai-dash-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-dash-proj-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-dash-packs-"));
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  saved = {
    FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
    FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
    FAILPROOFAI_PACK_BASE_URL: process.env.FAILPROOFAI_PACK_BASE_URL,
  };
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;

  const manifest = JSON.stringify({
    id: "acme/ops",
    version: "1.0.0",
    policies: [policy("block-prod-deploy", true), policy("warn-restart", false)],
  }, null, 2) + "\n";
  const sha = (b: string) => createHash("sha256").update(b).digest("hex");
  assets = {
    "failproofai-pack.json": manifest,
    "failproofai-pack.mjs": ENTRY,
    SHA256SUMS: `${sha(manifest)}  failproofai-pack.json\n${sha(ENTRY)}  failproofai-pack.mjs\n`,
  };
  server = createServer((req, res) => {
    const m = (req.url ?? "").match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/);
    const body = m ? assets[m[4]] : undefined;
    if (body === undefined) { res.writeHead(404).end("no"); return; }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.FAILPROOFAI_PACK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of [home, project, packRoot]) rmSync(dir, { recursive: true, force: true });
});

const selection = () =>
  (JSON.parse(readFileSync(join(packRoot, "installed.json"), "utf8")) as {
    packs: Array<{ enabled?: string[] }>;
  }).packs[0].enabled;

describe("installing a pack from the dashboard", () => {
  it("installs by the name a person typed, taking the pack's own defaults", async () => {
    const result = await addPackWebAction("github:acme/ops@1.0.0");
    expect(result.ok).toBe(true);
    expect(result.id).toBe("acme/ops");
    expect(result.enabled).toEqual(["block-prod-deploy"]);
  });

  it("hands back the refusal's own words instead of throwing at the UI", async () => {
    // A UI that renders "something went wrong" for a pack whose manifest and
    // artifact disagree tells the user nothing they can act on.
    assets["failproofai-pack.mjs"] = "export const nothing = 1;\n";
    const sha = (b: string) => createHash("sha256").update(b).digest("hex");
    assets.SHA256SUMS =
      `${sha(assets["failproofai-pack.json"])}  failproofai-pack.json\n` +
      `${sha(assets["failproofai-pack.mjs"])}  failproofai-pack.mjs\n`;
    const result = await addPackWebAction("github:acme/ops@1.0.0");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not register/);
  });

  it("refuses an empty source without reaching the network", async () => {
    const result = await addPackWebAction("   ");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Enter a pack source/);
  });
});

describe("the dashboard payload", () => {
  it("lists an installed pack and which of its policies are on", async () => {
    await addPackWebAction("github:acme/ops@1.0.0");
    const config = await getHooksConfigAction();
    const pack = config.packs.find((p) => p.id === "acme/ops");
    expect(pack).toBeDefined();
    expect(pack!.version).toBe("1.0.0");
    const byName = Object.fromEntries(pack!.policies.map((p) => [p.name, p.enabled]));
    expect(byName["block-prod-deploy"]).toBe(true);
    expect(byName["warn-restart"]).toBe(false);
  });
});

describe("a pack policy an enabled builtin already holds", () => {
  it("is marked as shadowed, so the UI cannot claim enforcement it is not doing", async () => {
    // Both register under different keys and only the builtin runs. A row
    // showing a toggle set to ON for the pack's copy reports enforcement that
    // is not happening — the one thing this product must never do.
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({ enabledPolicies: ["block-prod-deploy"] }),
    );
    await addPackWebAction("github:acme/ops@1.0.0");
    const config = await getHooksConfigAction();
    const pack = config.packs.find((p) => p.id === "acme/ops");
    const byName = Object.fromEntries(pack!.policies.map((p) => [p.name, p.shadowedByBuiltin]));
    expect(byName["block-prod-deploy"]).toBe(true);
    expect(byName["warn-restart"]).toBeUndefined();
  });
});

describe("toggling one policy of a pack", () => {
  it("writes the pack's selection — the lever that survives an upgrade", async () => {
    await addPackWebAction("github:acme/ops@1.0.0");
    expect(await togglePackPolicyAction("acme/ops", "warn-restart", true)).toMatchObject({ ok: true });
    expect(selection()).toEqual(["block-prod-deploy", "warn-restart"]);
    expect(await togglePackPolicyAction("acme/ops", "block-prod-deploy", false)).toMatchObject({ ok: true });
    expect(selection()).toEqual(["warn-restart"]);
  });

  it("clears a version-keyed disable when switching a policy back on", async () => {
    // The dashboard used to write only that key. Leaving it set would report the
    // policy enabled while it stayed off.
    await addPackWebAction("github:acme/ops@1.0.0");
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({
        enabledPolicies: [],
        disabledCustomPolicies: ["pack:acme/ops@1.0.0:warn-restart"],
      }),
    );
    await togglePackPolicyAction("acme/ops", "warn-restart", true);
    const config = JSON.parse(readFileSync(join(home, "policies-config.json"), "utf8"));
    expect(config.disabledCustomPolicies ?? []).not.toContain("pack:acme/ops@1.0.0:warn-restart");
  });

  it("names a pack it cannot find rather than failing silently", async () => {
    await addPackWebAction("github:acme/ops@1.0.0");
    const result = await togglePackPolicyAction("nope/nope", "x", true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no installed pack with id nope\/nope/i);
  });

  it("says so when nothing is installed at all", async () => {
    const result = await togglePackPolicyAction("acme/ops", "warn-restart", true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no packs are installed/i);
  });

  it("refuses a policy the pack does not declare", async () => {
    await addPackWebAction("github:acme/ops@1.0.0");
    const result = await togglePackPolicyAction("acme/ops", "not-a-policy", true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/declares no policy named/i);
  });
});

describe("removing a pack", () => {
  it("removes it, and says so when there was nothing to remove", async () => {
    await addPackWebAction("github:acme/ops@1.0.0");
    expect(await removePackWebAction("acme/ops")).toMatchObject({ ok: true });
    const config = await getHooksConfigAction();
    expect(config.packs).toEqual([]);
    expect(await removePackWebAction("acme/ops")).toMatchObject({ ok: false });
  });
});
