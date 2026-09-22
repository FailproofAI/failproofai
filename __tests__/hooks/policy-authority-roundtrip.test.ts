// @vitest-environment node
/**
 * Authority round trips: from where each kind of policy DECLARES it, through
 * the real loader and the real handler registration block, into the registry
 * the evaluator reads.
 *
 * - catalog → build-policy-pack manifest → `policies add` → loader → registry
 * - a third-party pack's manifest → loader → registry
 * - a cloud assignment in active.json → loader → registry
 * - the user's own policy files → loader → registry
 *
 * Unit tests of each piece cannot catch the failure that matters here, which is
 * a field that is correct at its source and silently absent by the time it is
 * registered — every policy then reads as `hard`, which is safe, looks fine, and
 * is not what anybody decided.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { POLICY_CATALOG } from "@/src/hooks/policy-catalog";
import { resolvePolicyAuthority } from "@/src/hooks/policy-authority";
import type { RegisteredPolicy } from "@/src/hooks/policy-types";

const REPO = resolve(__dirname, "../..");
const ENV_KEYS = [
  "FAILPROOFAI_HOME",
  "FAILPROOFAI_PACK_DIR",
  "FAILPROOFAI_CLOUD_POLICY_DIR",
  "FAILPROOFAI_PACK_BASE_URL",
] as const;

let home: string;
let project: string;
let packRoot: string;
let cloudRoot: string;
let saved: Record<string, string | undefined>;
let stderr: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-authority-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-authority-project-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-authority-packs-"));
  cloudRoot = mkdtempSync(join(tmpdir(), "fpai-authority-cloud-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  process.env.FAILPROOFAI_CLOUD_POLICY_DIR = cloudRoot;
  delete process.env.FAILPROOFAI_PACK_BASE_URL;
  writeConfig({ enabledPolicies: [] });
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of [home, project, packRoot, cloudRoot]) rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(home, "policies-config.json"), JSON.stringify(config));
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Run one real hook event and return what it registered, by name. */
async function registeredAfterOneEvent(): Promise<Map<string, RegisteredPolicy>> {
  const { evaluateHookEvent } = await import("@/src/hooks/handler");
  await evaluateHookEvent(
    "PreToolUse",
    "claude",
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      session_id: "authority-roundtrip",
      cwd: project,
    }),
  );
  const { getAllPolicies } = await import("@/src/hooks/policy-registry");
  return new Map(getAllPolicies().map((p) => [p.name, p]));
}

const warnings = () => stderr.join("");

/** A registered policy's authority fields, and nothing else. */
const authorityOf = (p: RegisteredPolicy | undefined) =>
  p === undefined
    ? undefined
    : { authority: p.authority, ...(p.reviewedBy ? { reviewedBy: p.reviewedBy } : {}) };

describe("catalog → build-policy-pack → policies add → loader → registry", () => {
  let packDir: string;
  let server: Server;
  let manifest: { id: string; version: string; policies: Array<Record<string, unknown>> };

  beforeAll(async () => {
    packDir = mkdtempSync(join(tmpdir(), "fpai-authority-built-pack-"));
    execFileSync("bun", ["scripts/build-policy-pack.mjs", "--out", packDir], {
      cwd: REPO,
      stdio: ["pipe", "pipe", "pipe"],
    });
    manifest = JSON.parse(readFileSync(join(packDir, "failproofai-pack.json"), "utf8"));
    const assets: Record<string, Buffer> = {};
    for (const a of ["failproofai-pack.json", "failproofai-pack.mjs", "SHA256SUMS"]) {
      assets[a] = readFileSync(join(packDir, a));
    }
    server = createServer((req, res) => {
      const m = (req.url ?? "").match(/^\/FailproofAI\/policies\/releases\/download\/([^/]+)\/([^/]+)$/);
      const body = m ? assets[m[2]] : undefined;
      if (!body) {
        res.writeHead(404).end("no such asset");
        return;
      }
      res.writeHead(200).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(packDir, { recursive: true, force: true });
  });

  it("emits a resolved authority for every policy in the manifest", () => {
    const expected = POLICY_CATALOG.filter((p) => !p.alwaysOn).map((p) => ({
      name: p.name,
      ...resolvePolicyAuthority(p),
    }));
    expect(
      manifest.policies.map((p) => ({
        name: p.name,
        authority: p.authority,
        ...(p.reviewedBy ? { reviewedBy: p.reviewedBy } : {}),
      })),
    ).toEqual(expected);
    expect(manifest.policies.filter((p) => p.authority === "reviewable")).toHaveLength(7);
  });

  it("passes the same fields to customPolicies.add in the entry, so a rebuilt manifest agrees", async () => {
    const { loadAllCustomHooks } = await import("@/src/hooks/custom-hooks-loader");
    const { hooks } = await loadAllCustomHooks([join(packDir, "failproofai-pack.mjs")], {
      sessionCwd: project,
      customPoliciesEnabled: false,
    });
    const byName = new Map(hooks.map((h) => [h.name, h]));
    for (const p of manifest.policies) {
      const hook = byName.get(p.name as string)!;
      expect(resolvePolicyAuthority(hook), p.name as string).toEqual(
        resolvePolicyAuthority(p as never),
      );
    }
  });

  it("registers every pack policy with the authority its catalog entry declares", async () => {
    process.env.FAILPROOFAI_PACK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { addPack } = await import("@/src/hooks/pack-store");
    await addPack(`github:FailproofAI/policies@v${manifest.version}`, { all: true });

    // The install path parses and records the manifest; the fields survive it.
    const { readInstalledPacks } = await import("@/src/hooks/pack-manifest");
    const { packs, errors } = readInstalledPacks();
    expect(errors).toEqual([]);
    const installed = packs[0].policies.find((p) => p.name === "protect-env-vars")!;
    expect(installed.authority).toBe("reviewable");
    expect(installed.reviewedBy).toEqual(["env-secrets-dump", "secret-exposure"]);

    const registered = await registeredAfterOneEvent();
    const prefix = `pack/${manifest.id}@${manifest.version}/`;
    for (const entry of POLICY_CATALOG) {
      if (entry.alwaysOn) continue;
      const r = registered.get(prefix + entry.name);
      expect(r, `${entry.name} was not registered`).toBeDefined();
      const { downgraded: _d, ...expected } = resolvePolicyAuthority(entry);
      expect(authorityOf(r), entry.name).toEqual(expected);
    }
    // The guard packs may not carry still ships compiled in, and stays hard.
    expect(authorityOf(registered.get("failproofai/block-failproofai-commands"))).toEqual({ authority: "hard" });
    const reviewable = [...registered.values()].filter((p) => p.authority === "reviewable").map((p) => p.name);
    expect(reviewable.sort()).toEqual(
      [
        "block-env-files", "block-read-outside-cwd", "block-work-on-main", "protect-env-vars",
        "warn-destructive-sql", "warn-git-amend", "warn-global-package-install",
      ].map((n) => prefix + n),
    );
    expect(warnings()).not.toMatch(/asks to be reviewable/);
  });
});

describe("a third-party pack: its manifest decides, and only for its own policies", () => {
  const ARTIFACT = `
    import { customPolicies, allow } from "failproofai";
    const ok = async () => allow();
    // The code's own claims below must NOT decide anything for a pack.
    customPolicies.add({ name: "block-prod-deploy", description: "d", match: { events: ["PreToolUse"] },
      authority: "hard", fn: ok });
    customPolicies.add({ name: "code-claims-reviewable", description: "d", match: { events: ["PreToolUse"] },
      authority: "reviewable", reviewedBy: ["secret-exposure"], fn: ok });
    customPolicies.add({ name: "names-unknown-check", description: "d", match: { events: ["PreToolUse"] }, fn: ok });
    customPolicies.add({ name: "garbled", description: "d", match: { events: ["PreToolUse"] }, fn: ok });
    customPolicies.add({ name: "undeclared", description: "d", match: { events: ["PreToolUse"] },
      authority: "reviewable", reviewedBy: ["secret-exposure"], fn: ok });
  `;
  const entry = (name: string, extra: Record<string, unknown> = {}) => ({
    name, description: "d", category: "Ops", defaultEnabled: true, match: { events: ["PreToolUse"] }, ...extra,
  });

  function installPack(): void {
    const digest = sha(ARTIFACT);
    mkdirSync(join(packRoot, "artifacts"), { recursive: true });
    writeFileSync(join(packRoot, "artifacts", `${digest}.mjs`), ARTIFACT);
    writeFileSync(
      join(packRoot, "installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        packs: [{
          id: "acme/ops", version: "1.0.0", source: "github:acme/ops@v1.0.0",
          entry: `artifacts/${digest}.mjs`, sha256: digest,
          policies: [
            entry("block-prod-deploy", { authority: "reviewable", reviewedBy: ["production-infra-change"] }),
            entry("code-claims-reviewable"),
            entry("names-unknown-check", { authority: "reviewable", reviewedBy: ["prod-deploy-v2"] }),
            entry("garbled", { authority: "yes please", reviewedBy: "production-infra-change" }),
          ],
        }],
      }),
    );
  }

  it("registers the manifest's declaration, never the artifact's", async () => {
    installPack();
    const registered = await registeredAfterOneEvent();
    const at = (n: string) => authorityOf(registered.get(`pack/acme/ops@1.0.0/${n}`));

    // Manifest says reviewable; the code saying hard changes nothing.
    expect(at("block-prod-deploy")).toEqual({ authority: "reviewable", reviewedBy: ["production-infra-change"] });
    // The code says reviewable; the manifest is silent, so it is hard.
    expect(at("code-claims-reviewable")).toEqual({ authority: "hard" });
    // Registered by the artifact, absent from the manifest: hard.
    expect(at("undeclared")).toEqual({ authority: "hard" });
  });

  it("makes an invalid declaration hard without refusing the pack", async () => {
    installPack();
    const { readInstalledPacks } = await import("@/src/hooks/pack-manifest");
    const { packs, errors } = readInstalledPacks();
    expect(errors).toEqual([]);
    const garbled = packs[0].policies.find((p) => p.name === "garbled")!;
    expect("authority" in garbled).toBe(false);
    expect("reviewedBy" in garbled).toBe(false);

    const registered = await registeredAfterOneEvent();
    expect(authorityOf(registered.get("pack/acme/ops@1.0.0/garbled"))).toEqual({ authority: "hard" });
    expect(authorityOf(registered.get("pack/acme/ops@1.0.0/names-unknown-check"))).toEqual({ authority: "hard" });
    expect(warnings()).toMatch(
      /pack\/acme\/ops@1\.0\.0\/names-unknown-check asks to be reviewable, but reviewedBy names "prod-deploy-v2"/,
    );
    // The pack still enforces: nothing about it failed closed.
    expect(registered.has("pack/failproofai-pack-unavailable")).toBe(false);
  });

  it("cannot make anything outside its own prefix reviewable", async () => {
    installPack();
    const registered = await registeredAfterOneEvent();
    const reviewable = [...registered.values()].filter((p) => p.authority === "reviewable");
    expect(reviewable.length).toBeGreaterThan(0);
    for (const p of reviewable) expect(p.name.startsWith("pack/acme/ops@1.0.0/"), p.name).toBe(true);
    expect(authorityOf(registered.get("failproofai/block-failproofai-commands"))).toEqual({ authority: "hard" });
  });
});

describe("a cloud assignment → registry", () => {
  /** Write one content-addressed artifact per policy and an active.json naming them. */
  function deploy(policies: Array<{ id: string; source: string; extra?: Record<string, unknown> }>): void {
    mkdirSync(join(cloudRoot, "artifacts"), { recursive: true });
    writeFileSync(
      join(cloudRoot, "active.json"),
      JSON.stringify({
        schemaVersion: 2,
        deployment: 7,
        policies: policies.map(({ id, source, extra }) => {
          const digest = sha(source);
          writeFileSync(join(cloudRoot, "artifacts", `${digest}.mjs`), source);
          return { id, version: 3, sha256: digest, path: `artifacts/${digest}.mjs`, ...extra };
        }),
      }),
    );
  }
  const hookSource = (name: string, claim = "") => `
    import { customPolicies, allow } from "failproofai";
    customPolicies.add({ name: ${JSON.stringify(name)}, description: "d", match: { events: ["PreToolUse"] },
      ${claim} fn: async () => allow() });
  `;

  it("takes authority from the assignment, is hard by default, and ignores the artifact's own claim", async () => {
    deploy([
      {
        id: "org-db-guard",
        source: hookSource("db-guard"),
        extra: { authority: "reviewable", reviewedBy: ["database-destruction"] },
      },
      {
        id: "org-plain",
        source: hookSource("plain", `authority: "reviewable", reviewedBy: ["secret-exposure"],`),
      },
    ]);
    const registered = await registeredAfterOneEvent();
    expect(authorityOf(registered.get("cloud/org-db-guard@3/db-guard"))).toEqual({
      authority: "reviewable",
      reviewedBy: ["database-destruction"],
    });
    // Central enforcement is not weakened by default, nor by the code itself.
    expect(authorityOf(registered.get("cloud/org-plain@3/plain"))).toEqual({ authority: "hard" });
  });

  it("makes a malformed assignment hard without refusing the deployment", async () => {
    deploy([
      { id: "org-bad", source: hookSource("bad"), extra: { authority: "sometimes", reviewedBy: [42] } },
      { id: "org-empty", source: hookSource("empty"), extra: { authority: "reviewable", reviewedBy: [] } },
    ]);
    const registered = await registeredAfterOneEvent();
    // Both still registered — the deployment was not thrown away over an
    // optional field — and both hard.
    expect(authorityOf(registered.get("cloud/org-bad@3/bad"))).toEqual({ authority: "hard" });
    expect(authorityOf(registered.get("cloud/org-empty@3/empty"))).toEqual({ authority: "hard" });
    expect(warnings()).not.toMatch(/cloud-managed policies could NOT be loaded/);
  });
});

describe("the user's own policy files → registry", () => {
  const FILE = `
    import { customPolicies, allow } from "failproofai";
    const ok = async () => allow();
    customPolicies.add({ name: "outside-reads", description: "d", match: { events: ["PreToolUse"] },
      authority: "reviewable", reviewedBy: ["read-outside-workspace"], fn: ok });
    customPolicies.add({ name: "typo", description: "d", match: { events: ["PreToolUse"] },
      authority: "reviewable", reviewedBy: ["read-outside-workspce"], fn: ok });
    customPolicies.add({ name: "silent", description: "d", match: { events: ["PreToolUse"] }, fn: ok });
  `;
  const CONVENTION = `
    import { customPolicies, allow } from "failproofai";
    customPolicies.add({ name: "global-installs", description: "d", match: { events: ["PreToolUse"] },
      authority: "reviewable", reviewedBy: ["system-modification", "system-modification"],
      fn: async () => allow() });
  `;

  it("honours the hook's own declaration, and makes anything unclear hard", async () => {
    const explicit = join(project, "team-rules.mjs");
    writeFileSync(explicit, FILE);
    mkdirSync(join(project, ".failproofai", "policies"), { recursive: true });
    writeFileSync(join(project, ".failproofai", "policies", "infra-policies.mjs"), CONVENTION);
    writeConfig({ enabledPolicies: [], customPoliciesPaths: [explicit] });

    const registered = await registeredAfterOneEvent();
    expect(authorityOf(registered.get("custom/outside-reads"))).toEqual({
      authority: "reviewable",
      reviewedBy: ["read-outside-workspace"],
    });
    expect(authorityOf(registered.get("custom/typo"))).toEqual({ authority: "hard" });
    expect(authorityOf(registered.get("custom/silent"))).toEqual({ authority: "hard" });
    expect(authorityOf(registered.get(".failproofai-project/global-installs"))).toEqual({
      authority: "reviewable",
      reviewedBy: ["system-modification"],
    });
    // The author is told why their claim was refused, and nobody else is warned.
    expect(warnings()).toMatch(/custom\/typo asks to be reviewable, but reviewedBy names "read-outside-workspce"/);
    expect(warnings()).not.toMatch(/custom\/silent asks/);
  });
});

describe("failproofai publish → manifest", () => {
  const ENTRY = `
    import { customPolicies, allow } from "failproofai";
    const ok = async () => allow();
    customPolicies.add({ name: "block-prod-deploy", description: "d", match: { events: ["PreToolUse"] },
      authority: "reviewable", reviewedBy: ["production-infra-change"], fn: ok });
    customPolicies.add({ name: "garbled", description: "d", match: { events: ["PreToolUse"] },
      authority: "maybe", reviewedBy: [1], fn: ok });
    customPolicies.add({ name: "silent", description: "d", match: { events: ["PreToolUse"] }, fn: ok });
  `;

  it("copies a registration's authority into the manifest a machine reads it from", async () => {
    const entry = join(project, "policies.mjs");
    writeFileSync(entry, ENTRY);
    const out = join(project, "dist-pack");
    const { runPackCommand } = await import("@/src/hooks/pack-cli");
    const r = await runPackCommand(["build", entry, "--id", "acme/support", "--version", "1.0.0", "--out", out]);
    expect(r.exitCode).toBe(0);

    const built = JSON.parse(readFileSync(join(out, "failproofai-pack.json"), "utf8")) as {
      policies: Array<Record<string, unknown>>;
    };
    const byName = new Map(built.policies.map((p) => [p.name, p]));
    expect(byName.get("block-prod-deploy")).toMatchObject({
      authority: "reviewable",
      reviewedBy: ["production-infra-change"],
    });
    // Malformed fields are not published, so no machine ever reads them.
    expect("authority" in byName.get("garbled")!).toBe(false);
    expect("reviewedBy" in byName.get("garbled")!).toBe(false);
    // Absent stays absent: nothing is invented for a policy that said nothing.
    expect("authority" in byName.get("silent")!).toBe(false);
  });
});
