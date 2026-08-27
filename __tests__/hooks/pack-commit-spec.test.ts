// @vitest-environment node
/**
 * `failproofai policies add owner/repo@<sha>` — installing a pack by the git
 * commit it was published from.
 *
 * Driven against a real HTTP server rather than a mocked `fetch`, for the same
 * reason `pack-store.test.ts` is: the interesting assertions are about WHICH
 * URLs are requested and which are not, and a mock that returns whatever it is
 * asked for cannot prove that an ordinary install still discovers nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { addPack, resolveSpecTag, resolveTagForCommit } from "@/src/hooks/pack-store";

/** Two commits sharing a 7-character prefix — the collision git itself refuses. */
const COMMIT_A = "a1b2c3d4444444444444444444444444444444d1";
const COMMIT_B = "a1b2c3d5555555555555555555555555555555d2";
const COMMIT_LONE = "9f8e7d6c000000000000000000000000000000aa";

const ENTRY = `
  import { customPolicies, deny } from "failproofai";
  customPolicies.add({ name: "block-big-refund", description: "d",
    match: { events: ["PreToolUse"] }, fn: async () => deny("no") });
`;
const POLICY = {
  name: "block-big-refund",
  description: "Block refunds above the approved limit",
  category: "Finance",
  defaultEnabled: true,
  match: { events: ["PreToolUse"] },
};

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** The body shape `publish` writes, and therefore the one `--releases` reads. */
function body(id: string, version: string, commit?: string): string {
  return `${id}@${version}\n\n1 policies, 1 on by default\n${commit ? `commit ${commit}\n` : ""}`;
}

let server: Server;
let root: string;
let requested: string[];
let releases: Array<{ tag_name: string; body: string }>;
let apiStatus: number;
/** The release whose assets the download half of the server will serve. */
let servedTag: string;
let assets: Record<string, string>;
const saved: Record<string, string | undefined> = {};

const SPEC = { owner: "acme", repo: "finance", tag: null } as const;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "fpai-pack-commit-"));
  for (const key of [
    "FAILPROOFAI_PACK_DIR",
    "FAILPROOFAI_PACK_BASE_URL",
    "FAILPROOFAI_GITHUB_API",
    "FAILPROOFAI_NO_DOWNLOAD",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.FAILPROOFAI_PACK_DIR = root;

  apiStatus = 200;
  releases = [
    { tag_name: "2026.08.26", body: body("acme/finance", "2026.08.26", COMMIT_LONE) },
    { tag_name: "2026.08.20", body: body("acme/finance", "2026.08.20") },
  ];
  servedTag = "2026.08.26";
  const manifest = JSON.stringify({ id: "acme/finance", version: "2026.08.26", policies: [POLICY] });
  assets = {
    "failproofai-pack.json": manifest,
    "failproofai-pack.mjs": ENTRY,
    SHA256SUMS: `${sha(manifest)}  failproofai-pack.json\n${sha(ENTRY)}  failproofai-pack.mjs\n`,
  };

  // One server wearing both hats: the API origin the commit lookup asks, and
  // the release origin every asset is CONSTRUCTED against. Keeping them on one
  // process is what lets a test assert that an ordinary install touched the
  // second and never the first.
  requested = [];
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requested.push(url);
    if (url.startsWith("/repos/acme/finance/releases")) {
      if (apiStatus !== 200) {
        res.writeHead(apiStatus).end("boom");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(releases));
      return;
    }
    const m = url.match(/^\/acme\/finance\/releases\/download\/([^/]+)\/([^/]+)$/);
    const asset = m && m[1] === servedTag ? assets[m[2]] : undefined;
    if (asset === undefined) {
      res.writeHead(404).end("no such asset");
      return;
    }
    res.writeHead(200).end(asset);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.FAILPROOFAI_PACK_BASE_URL = base;
  process.env.FAILPROOFAI_GITHUB_API = base;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("resolving a commit to a release tag", () => {
  it("resolves a full commit that exactly one release claims", async () => {
    expect(await resolveTagForCommit(SPEC, COMMIT_LONE)).toBe("2026.08.26");
    expect(await resolveSpecTag({ ...SPEC, tag: COMMIT_LONE })).toBe("2026.08.26");
  });

  it("resolves an abbreviated commit by prefix, the way git log prints one", async () => {
    expect(await resolveSpecTag({ ...SPEC, tag: COMMIT_LONE.slice(0, 7) })).toBe("2026.08.26");
    expect(await resolveSpecTag({ ...SPEC, tag: COMMIT_LONE.slice(0, 12) })).toBe("2026.08.26");
  });

  it("refuses an ambiguous prefix and names every candidate, rather than picking one", async () => {
    releases = [
      { tag_name: "2026.08.26", body: body("acme/finance", "2026.08.26", COMMIT_A) },
      { tag_name: "2026.08.25", body: body("acme/finance", "2026.08.25", COMMIT_B) },
    ];
    // A 7-character prefix colliding is exactly why git refuses to resolve one.
    // The message has to carry enough to type the next command from.
    await expect(resolveSpecTag({ ...SPEC, tag: "a1b2c3d" })).rejects.toThrow(/matches 2 releases/);
    const err = String(await resolveSpecTag({ ...SPEC, tag: "a1b2c3d" }).catch((e: Error) => e));
    for (const named of ["2026.08.26", "2026.08.25", COMMIT_A, COMMIT_B]) {
      expect(err).toContain(named);
    }
    // One more character separates them again.
    expect(await resolveSpecTag({ ...SPEC, tag: "a1b2c3d5" })).toBe("2026.08.25");
  });

  it("falls through to a literal tag when no release claims that commit", async () => {
    // A repository may genuinely have a tag named `abc1234`, and failing on a
    // tag that exists would be a regression for somebody who never asked for
    // commit resolution.
    expect(await resolveSpecTag({ ...SPEC, tag: "abc1234" })).toBe("abc1234");
    expect(await resolveTagForCommit(SPEC, "abc1234")).toBeNull();
  });

  it("never asks the API for a tag that is not a hex string", async () => {
    expect(await resolveSpecTag({ ...SPEC, tag: "v1.2.0" })).toBe("v1.2.0");
    // 6 characters is below what git abbreviates to, and `deadbeefs` is not hex.
    expect(await resolveSpecTag({ ...SPEC, tag: "abc123" })).toBe("abc123");
    expect(await resolveSpecTag({ ...SPEC, tag: "deadbeefs" })).toBe("deadbeefs");
    expect(requested).toEqual([]);
  });

  it("reports the commit when the lookup itself could not run", async () => {
    apiStatus = 500;
    // Not a silent fall-through to a literal tag: that would 404 on an asset
    // URL built from a commit and report a missing SHA256SUMS instead.
    await expect(resolveSpecTag({ ...SPEC, tag: COMMIT_LONE })).rejects.toThrow(
      new RegExp(`could not resolve commit ${COMMIT_LONE}`),
    );
    await expect(resolveSpecTag({ ...SPEC, tag: COMMIT_LONE })).rejects.toThrow(/500/);
  });
});

describe("addPack owner/repo@<sha>", () => {
  it("installs the release that commit was published from, and records its TAG", async () => {
    const result = await addPack(`acme/finance@${COMMIT_LONE.slice(0, 7)}`);
    expect(result.tag).toBe("2026.08.26");
    expect(result.version).toBe("2026.08.26");
    // A commit selects WHICH release; it is not what the machine records as the
    // source, because the source has to name something a URL can be built from.
    expect(result.source).toBe("github:acme/finance@2026.08.26");
    expect(result.resolvedFromLatest).toBe(false);
    const record = JSON.parse(readFileSync(join(root, "installed.json"), "utf8")).packs[0];
    expect(record.source).toBe("github:acme/finance@2026.08.26");
    expect(record.sha256).toBe(sha(ENTRY));
    // Verification is untouched: the assets were fetched from the resolved tag,
    // through the ordinary constructed-URL path.
    expect(requested).toContain("/acme/finance/releases/download/2026.08.26/SHA256SUMS");
  });

  it("leaves an ordinary install discovering nothing", async () => {
    await addPack("acme/finance@2026.08.26");
    expect(requested.some((u) => u.startsWith("/repos/"))).toBe(false);
  });
});
