// @vitest-environment node
/**
 * `failproofai pack build` — the publishing half of the lane.
 *
 * The contract a third-party pack must satisfy was only discoverable by reading
 * pack-manifest.ts and this repo's own build script, so a stranger reverse-
 * engineered a manifest, a checksum file and an asset naming convention and
 * found out they got it wrong when somebody else's `pack add` refused it.
 *
 * The round-trip test at the bottom is the point: what `build` writes is fed to
 * the real `addPack` over a real HTTP release layout. If the publishing and
 * consuming contracts ever drift apart, that test fails.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { runPackCommand } from "@/src/hooks/pack-cli";
import { addPack } from "@/src/hooks/pack-store";
import { readInstalledPacks } from "@/src/hooks/pack-manifest";

const ENTRY = `
  import { customPolicies, deny } from "failproofai";
  customPolicies.add({
    name: "block-big-refund",
    description: "Block refunds above the approved limit",
    category: "Finance",
    defaultEnabled: true,
    match: { events: ["PreToolUse"] },
    fn: async () => deny("no"),
  });
  customPolicies.add({
    name: "require-note",
    description: "Require a note",
    match: { events: ["PreToolUse"] },
    fn: async () => ({ decision: "allow" }),
  });
`;

let work: string;
let packRoot: string;
let saved: Record<string, string | undefined>;

const write = (name: string, body: string) => {
  const p = join(work, name);
  writeFileSync(p, body, "utf8");
  return p;
};

const manifestOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "failproofai-pack.json"), "utf8")) as {
    id: string;
    version: string;
    effect: string;
    policies: Array<{ name: string; category: string; defaultEnabled: boolean }>;
  };

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "fpai-build-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-build-packs-"));
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  saved = {
    FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
    FAILPROOFAI_PACK_BASE_URL: process.env.FAILPROOFAI_PACK_BASE_URL,
  };
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of [work, packRoot]) rmSync(dir, { recursive: true, force: true });
});

describe("pack build", () => {
  it("writes the three assets a release needs, with matching checksums", async () => {
    const entry = write("policies.mjs", ENTRY);
    const out = join(work, "dist-pack");
    const r = await runPackCommand(["build", entry, "--id", "acme/support", "--version", "1.0.0", "--out", out]);
    expect(r.exitCode).toBe(0);

    for (const asset of ["failproofai-pack.json", "failproofai-pack.mjs", "SHA256SUMS"]) {
      expect(existsSync(join(out, asset))).toBe(true);
    }
    // The checksums must describe the bytes actually written, because that is
    // what the consumer re-verifies before it will import anything.
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n");
    for (const line of sums) {
      const [digest, name] = line.split(/\s+/);
      const actual = createHash("sha256").update(readFileSync(join(out, name))).digest("hex");
      expect(actual).toBe(digest);
    }
  });

  it("reads category and defaultEnabled off the registration, and defaults defaultEnabled to off", async () => {
    const entry = write("policies.mjs", ENTRY);
    const out = join(work, "dist-pack");
    await runPackCommand(["build", entry, "--id", "acme/support", "--version", "1.0.0", "--out", out]);
    const manifest = manifestOf(out);
    const byName = Object.fromEntries(manifest.policies.map((p) => [p.name, p]));
    expect(byName["block-big-refund"].category).toBe("Finance");
    expect(byName["block-big-refund"].defaultEnabled).toBe(true);
    // Not declared: switching on a stranger's every policy unattended is the
    // installer opinion this lane already refused once.
    expect(byName["require-note"].defaultEnabled).toBe(false);
    expect(byName["require-note"].category).toBe("General");
  });

  it("refuses an entry that imports local files, because only the entry is digest-pinned", async () => {
    write("helper.mjs", "export const x = 1;\n");
    const entry = write("policies.mjs", `import { x } from "./helper.mjs";\n${ENTRY}`);
    const r = await runPackCommand(["build", entry, "--id", "acme/support", "--version", "1.0.0", "--out", join(work, "o")]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/only the entry file is digest-pinned/);
  });

  it("refuses an entry that registers nothing, and says what one looks like", async () => {
    const entry = write("empty.mjs", "export const nothing = 1;\n");
    const r = await runPackCommand(["build", entry, "--id", "acme/support", "--version", "1.0.0", "--out", join(work, "o")]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/customPolicies\.add/);
  });

  it("refuses an id that is not publisher/name, before writing anything", async () => {
    const entry = write("policies.mjs", ENTRY);
    const out = join(work, "dist-pack");
    const r = await runPackCommand(["build", entry, "--id", "support", "--version", "1.0.0", "--out", out]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it("names the entry and the flags when called with nothing", async () => {
    const r = await runPackCommand(["build"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/--id <publisher\/name>/);
  });
});

describe("round trip — what build writes, add installs", () => {
  let server: Server;
  let assets: Record<string, string>;

  beforeEach(async () => {
    assets = {};
    server = createServer((req, res) => {
      const m = (req.url ?? "").match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/);
      const body = m ? assets[m[4]] : undefined;
      if (body === undefined) {
        res.writeHead(404).end("no such asset");
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.FAILPROOFAI_PACK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("installs a built pack through the real add path", async () => {
    const entry = write("policies.mjs", ENTRY);
    const out = join(work, "dist-pack");
    const built = await runPackCommand(["build", entry, "--id", "acme/support", "--version", "1.0.0", "--out", out]);
    expect(built.exitCode).toBe(0);

    // Serve exactly the files build produced, under the release layout.
    for (const asset of ["failproofai-pack.json", "failproofai-pack.mjs", "SHA256SUMS"]) {
      assets[asset] = readFileSync(join(out, asset), "utf8");
    }

    const result = await addPack("github:acme/support@1.0.0");
    expect(result.id).toBe("acme/support");
    expect(result.version).toBe("1.0.0");
    // The pack's own defaults, which build derived from the registrations.
    expect(result.enabled).toEqual(["block-big-refund"]);

    const { packs, errors } = readInstalledPacks();
    expect(errors).toEqual([]);
    expect(packs[0].policies.map((p) => p.name)).toEqual(["block-big-refund", "require-note"]);
  });
});

describe("a pack that would brick the machine is refused, not installed", () => {
  let server: Server;
  let assets: Record<string, string>;

  const publish = (manifest: unknown, artifact: string) => {
    const manifestText = JSON.stringify(manifest, null, 2) + "\n";
    const sha = (b: string) => createHash("sha256").update(b).digest("hex");
    assets["failproofai-pack.json"] = manifestText;
    assets["failproofai-pack.mjs"] = artifact;
    assets["SHA256SUMS"] =
      `${sha(manifestText)}  failproofai-pack.json\n${sha(artifact)}  failproofai-pack.mjs\n`;
  };

  const policy = (name: string) => ({
    name,
    description: `does ${name}`,
    category: "Ops",
    defaultEnabled: true,
    match: { events: ["PreToolUse"] },
  });

  beforeEach(async () => {
    assets = {};
    server = createServer((req, res) => {
      const m = (req.url ?? "").match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/);
      const body = m ? assets[m[4]] : undefined;
      if (body === undefined) {
        res.writeHead(404).end("no such asset");
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.FAILPROOFAI_PACK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("refuses an artifact that does not even parse", async () => {
    // It used to install at exit 0 and then deny every tool call on the machine.
    publish(
      { id: "acme/ops", version: "1.0.0", policies: [policy("block-prod-deploy")] },
      'import { customPolicies } from "failproofai";\ncustomPolicies.add({ name: "block-prod-deploy",',
    );
    await expect(addPack("github:acme/ops@1.0.0")).rejects.toThrow(/could not be loaded/);
    expect(readInstalledPacks().packs).toEqual([]);
  });

  it("refuses a manifest that declares a policy the artifact never registers", async () => {
    // The exact slip a publisher hand-maintaining two files makes — and the
    // fail-closed guard turns it into a machine-wide deny.
    publish(
      { id: "acme/ops", version: "1.0.0", policies: [policy("block-prod-deploy"), policy("block-db-drop")] },
      'import { customPolicies } from "failproofai";\n' +
        'customPolicies.add({ name: "block-prod-deploy", description: "d", match: { events: ["PreToolUse"] }, fn: async () => ({ decision: "allow" }) });',
    );
    await expect(addPack("github:acme/ops@1.0.0")).rejects.toThrow(/does not register it/);
    expect(readInstalledPacks().packs).toEqual([]);
  });

  it("refuses an artifact that registers a policy the manifest never declared", async () => {
    publish(
      { id: "acme/ops", version: "1.0.0", policies: [policy("block-prod-deploy")] },
      'import { customPolicies } from "failproofai";\n' +
        'customPolicies.add({ name: "block-prod-deploy", description: "d", match: { events: ["PreToolUse"] }, fn: async () => ({ decision: "allow" }) });\n' +
        'customPolicies.add({ name: "sneaky", description: "d", match: { events: ["PreToolUse"] }, fn: async () => ({ decision: "allow" }) });',
    );
    await expect(addPack("github:acme/ops@1.0.0")).rejects.toThrow(/undeclared sneaky/);
  });

  it("refuses to let a second source take over an installed pack's id", async () => {
    const good =
      'import { customPolicies } from "failproofai";\n' +
      'customPolicies.add({ name: "block-prod-deploy", description: "d", match: { events: ["PreToolUse"] }, fn: async () => ({ decision: "allow" }) });';
    publish({ id: "acme/ops", version: "1.0.0", policies: [policy("block-prod-deploy")] }, good);
    await addPack("github:acme/ops@1.0.0");
    // Same id, different repository — the hijack.
    publish({ id: "acme/ops", version: "9.9.9", policies: [policy("block-prod-deploy")] }, good);
    await expect(addPack("github:evil/ops@9.9.9")).rejects.toThrow(/already installed from/);
    expect(readInstalledPacks().packs[0].version).toBe("1.0.0");
  });
});
