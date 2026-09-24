// @vitest-environment node
/**
 * The install path, for the half of a pack that is not a regex policy.
 *
 * This file exists because of the gap it closes. Everything downstream of it —
 * the resolver, the replacement rule, the reviewer set — reads `installed.json`,
 * and `installed.json` is written from what `fetchPack` returns. `fetchPack`
 * parsed `id`, `version`, `effect`, `commit` and `policies` and nothing else, so a
 * real `policies add` fetched a pack's `semantic` array, verified it against the
 * release's own digest, and then dropped it on the floor. Every unit test of the
 * feature passed, because every one of them wrote the record directly. On a real
 * machine the Jev half simply never arrived.
 *
 * So these tests install over a real HTTP release layout with real digests, and
 * then read the record back through the real manifest reader, because that
 * roundtrip is the thing that was broken.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { addPack, fetchPackPreview } from "@/src/hooks/pack-store";
import { MAX_SEMANTIC_POLICIES_PER_PACK, packSemantic, readInstalledPacks } from "@/src/hooks/pack-manifest";
import { semanticPoliciesFromPacks } from "@/src/hooks/semantic/pack-policies";
import { SEMANTIC_POLICIES } from "@/src/hooks/semantic/policies";
import { forgetEffectiveReviewerNames } from "@/src/hooks/effective-reviewers";
import { version as packageVersion } from "../../package.json";

/** Registers the one regex policy the manifest declares, and one semantic policy. */
const ENTRY = `
  import { customPolicies, semanticPolicies, deny } from "failproofai";
  customPolicies.add({ name: "block-big-refund", description: "d",
    match: { events: ["PreToolUse"] }, fn: async () => deny("no") });
  semanticPolicies.add({
    name: "pack-destructive-deletion",
    title: "Deleted something irreplaceable",
    appliesTo: ["shell"],
    mode: "deny",
    userCanOverride: true,
    probes: [{ id: "destroys", instructions: "It permanently deletes existing data." }],
    guidance: "Confirm the exact paths first.",
  });
`;

/** A regex policy that names the pack's OWN semantic check as its reviewer. */
const POLICY = {
  name: "block-big-refund",
  description: "Block refunds above the approved limit",
  category: "Finance",
  defaultEnabled: true,
  match: { events: ["PreToolUse"] },
  authority: "reviewable",
  reviewedBy: ["pack-destructive-deletion"],
};

const SEMANTIC = {
  name: "pack-destructive-deletion",
  title: "Deleted something irreplaceable",
  appliesTo: ["shell"],
  mode: "deny",
  userCanOverride: true,
  precondition: "has_paths",
  probes: [{ id: "destroys", instructions: "It permanently deletes existing data." }],
  guidance: "Confirm the exact paths first.",
};

let server: Server;
let root: string;
let saved: Record<string, string | undefined>;
let assets: Record<string, string>;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function release(over: Record<string, unknown> = {}, entry: string = ENTRY): void {
  const manifest = JSON.stringify({
    id: "acme/finance",
    version: "1.2.0",
    policies: [POLICY],
    ...over,
  });
  assets = {
    "failproofai-pack.json": manifest,
    "failproofai-pack.mjs": entry,
    SHA256SUMS: `${sha(manifest)}  failproofai-pack.json\n${sha(entry)}  failproofai-pack.mjs\n`,
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "fpai-pack-store-semantic-"));
  saved = {
    FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
    FAILPROOFAI_PACK_BASE_URL: process.env.FAILPROOFAI_PACK_BASE_URL,
    FAILPROOFAI_NO_DOWNLOAD: process.env.FAILPROOFAI_NO_DOWNLOAD,
  };
  delete process.env.FAILPROOFAI_NO_DOWNLOAD;
  process.env.FAILPROOFAI_PACK_DIR = root;
  release();
  server = createServer((req, res) => {
    const m = (req.url ?? "").match(/^\/acme\/finance\/releases\/download\/[^/]+\/([^/]+)$/);
    const body = m ? assets[m[1]] : undefined;
    if (body === undefined) {
      res.writeHead(404).end("no such asset");
      return;
    }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.FAILPROOFAI_PACK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  forgetEffectiveReviewerNames();
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
  forgetEffectiveReviewerNames();
});

const add = () => addPack("acme/finance@v1.2.0", { all: true });

describe("installing a pack that declares semantic policies", () => {
  it("writes them into installed.json, so the resolver can see them", async () => {
    release({ semantic: [SEMANTIC] });
    const result = await add();
    expect(result.semantic).toBe(1);

    const { packs, errors, warnings } = readInstalledPacks();
    expect(errors).toEqual([]);
    expect(warnings).toBeUndefined();
    expect(packSemantic(packs[0]).map((s) => s.name)).toEqual(["pack-destructive-deletion"]);
    // And the whole point: the machine now asks the PACK's question set.
    const resolved = semanticPoliciesFromPacks(packs);
    expect(resolved.fromPack).toBe(true);
    expect(resolved.policies.map((p) => p.name)).toEqual(["pack-destructive-deletion"]);
    expect(resolved.policies[0].precondition).toBeTypeOf("function");
  });

  it("makes the pack's own reviewedBy resolve, which is what the mark is for", async () => {
    release({ semantic: [SEMANTIC] });
    await add();
    const { packs } = readInstalledPacks();
    expect(packs[0].policies[0].reviewedBy).toEqual(["pack-destructive-deletion"]);
  });

  it("omits the key when the pack declares none, so it cannot read as an empty set", async () => {
    await add();
    // On DISK: no key at all. An empty array would still read as "this pack
    // declares semantic entries", and the replacement rule would then have it
    // replace this build's set with nothing. (The READER normalizes absence to
    // `[]`, which is why this asserts the record rather than the parsed pack.)
    const record = JSON.parse(readFileSync(join(root, "installed.json"), "utf8")) as {
      packs: Array<Record<string, unknown>>;
    };
    expect("semantic" in record.packs[0]).toBe(false);
    // And this build's own question set stays in play.
    expect(semanticPoliciesFromPacks(readInstalledPacks().packs).policies).toBe(SEMANTIC_POLICIES);
  });

  it("refuses a malformed semantic entry before writing anything", async () => {
    // Refused here rather than dropped, because nothing is installed yet: the
    // loader drops instead, since by then refusing the pack denies every tool
    // call its regex policies cover.
    release({ semantic: [{ ...SEMANTIC, userCanOverride: undefined }] });
    await expect(add()).rejects.toThrow(/missing userCanOverride/);
    expect(readInstalledPacks().packs).toEqual([]);
  });

  it("refuses an over-cap semantic list rather than installing a silent subset", async () => {
    const many = Array.from({ length: MAX_SEMANTIC_POLICIES_PER_PACK + 1 }, (_, i) => ({
      ...SEMANTIC,
      name: `check-${i}`,
    }));
    release({ semantic: many });
    await expect(add()).rejects.toThrow(new RegExp(`over the cap of ${MAX_SEMANTIC_POLICIES_PER_PACK}`));
  });

  it("refuses a semantic name the pack declares twice", async () => {
    release({ semantic: [SEMANTIC, SEMANTIC] });
    await expect(add()).rejects.toThrow(/declares semantic policy pack-destructive-deletion twice/);
  });

  it("installs a pack that carries ONLY semantic policies", async () => {
    // A legitimate pack: the regex floor may already be somebody else's, and the
    // two halves version independently.
    const entry = ENTRY.replace(/customPolicies\.add\([^;]*\);/, "");
    release({ policies: [], semantic: [SEMANTIC] }, entry);
    const result = await add();
    expect(result.available).toEqual([]);
    expect(result.semantic).toBe(1);
    const { packs, errors } = readInstalledPacks();
    expect(errors).toEqual([]);
    expect(packs[0].policies).toEqual([]);
    expect(packSemantic(packs[0])).toHaveLength(1);
  });

  it("still refuses a pack that carries neither", async () => {
    release({ policies: [] }, "export const nothing = 1;\n");
    await expect(add()).rejects.toThrow(/declares no policies/);
  });
});

describe("minCliVersion at add time", () => {
  it("refuses a pack this CLI is too old for, before writing anything", async () => {
    // Refusing at ADD is a message somebody can act on. Refusing only at READ is
    // a machine that denies every tool call until someone works out why.
    release({ minCliVersion: "99.0.0", semantic: [SEMANTIC] });
    await expect(add()).rejects.toThrow(/needs failproofai 99\.0\.0 or newer/);
    await expect(add()).rejects.toThrow(/npm i -g failproofai && failproofai update/);
    expect(readInstalledPacks().packs).toEqual([]);
  });

  it("records a minimum it satisfies, so the reader re-checks it later", async () => {
    release({ minCliVersion: packageVersion });
    await add();
    expect(readInstalledPacks().packs[0].minCliVersion).toBe(packageVersion);
  });

  it("installs, and ignores, a minimum nobody can compare", async () => {
    // A publisher's typo in a version string must not stop anyone installing.
    release({ minCliVersion: "v1" });
    await add();
    const { packs, errors } = readInstalledPacks();
    expect(errors).toEqual([]);
    expect(packs[0].minCliVersion).toBeUndefined();
  });
});

describe("the preview shows both halves", () => {
  it("carries the semantic entries and the minimum, without downloading the artifact", async () => {
    release({ semantic: [SEMANTIC], minCliVersion: packageVersion });
    const preview = await fetchPackPreview("acme/finance@v1.2.0");
    expect(preview.semantic.map((s) => s.name)).toEqual(["pack-destructive-deletion"]);
    expect(preview.minCliVersion).toBe(packageVersion);
  });

  it("previews a semantic-only pack rather than calling it empty", async () => {
    release({ policies: [], semantic: [SEMANTIC] });
    const preview = await fetchPackPreview("acme/finance@v1.2.0");
    expect(preview.policies).toEqual([]);
    expect(preview.semantic).toHaveLength(1);
  });

  it("refuses to preview a pack this CLI is too old for", async () => {
    release({ minCliVersion: "99.0.0" });
    await expect(fetchPackPreview("acme/finance@v1.2.0")).rejects.toThrow(/or newer/);
  });
});
