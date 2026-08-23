// @vitest-environment node
/**
 * `pack add`, driven against a real HTTP server serving a real release layout.
 *
 * The interesting assertions are the refusals, and specifically WHEN they
 * happen: a pack that could never load must be refused while nothing has been
 * written, not installed cleanly and then found broken on the next tool call.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import {
  addPack, removePack, parsePackSpec, packAssetUrl, formatPackSpec, digestFor,
} from "@/src/hooks/pack-store";
import { readInstalledPacks } from "@/src/hooks/pack-manifest";

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
// Deliberately mixed: two categories, and only ONE defaultEnabled — so a test
// that confuses "the pack's defaults" with "everything" cannot pass.
const POLICY_2 = { ...POLICY, name: "require-approval-note", defaultEnabled: false };
const POLICY_3 = {
  name: "audit-log-writes", description: "Log every write",
  category: "Audit Trail", defaultEnabled: false, match: { events: ["PostToolUse"] },
};

let server: Server;
let root: string;
let prevPackDir: string | undefined;
let prevBase: string | undefined;
let prevNoDownload: string | undefined;

/** Mutable per-test release contents. */
let assets: Record<string, string>;
let responseHeaders: Record<string, Record<string, string>>;
/** What `releases/latest` redirects to, or null for a repo with no releases. */
let latestTag: string | null;

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Build a well-formed release: manifest, entry, and matching SHA256SUMS. */
function release(over: { policies?: unknown[]; id?: string; version?: string; effect?: unknown } = {}): void {
  const manifest = JSON.stringify({
    id: over.id ?? "acme/finance",
    version: over.version ?? "1.2.0",
    policies: over.policies ?? [POLICY, POLICY_2, POLICY_3],
    ...(over.effect !== undefined ? { effect: over.effect } : {}),
  });
  assets = {
    "failproofai-pack.json": manifest,
    "failproofai-pack.mjs": ENTRY,
    SHA256SUMS:
      `${sha(manifest)}  failproofai-pack.json\n` +
      `${sha(ENTRY)}  failproofai-pack.mjs\n`,
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "fpai-pack-store-"));
  prevPackDir = process.env.FAILPROOFAI_PACK_DIR;
  prevBase = process.env.FAILPROOFAI_PACK_BASE_URL;
  prevNoDownload = process.env.FAILPROOFAI_NO_DOWNLOAD;
  delete process.env.FAILPROOFAI_NO_DOWNLOAD;
  process.env.FAILPROOFAI_PACK_DIR = root;
  latestTag = "v1.2.0";
  responseHeaders = {};
  release();

  // Serves ONLY the real release path, so a wrong owner/repo/tag 404s the way
  // GitHub would — which also makes these tests prove the URL is constructed
  // correctly rather than merely that some asset was fetched.
  server = createServer((req, res) => {
    const url = req.url ?? "";
    // `releases/latest` is a REDIRECT on github.com, not an API call — which is
    // how a tagless source resolves without a second origin or a rate limit.
    if (url === "/acme/finance/releases/latest") {
      if (latestTag === null) {
        res.writeHead(404).end("no releases");
        return;
      }
      res.writeHead(302, { location: `/acme/finance/releases/tag/${latestTag}` }).end();
      return;
    }
    const m = url.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/);
    const assetName = m?.[4];
    const body = m && m[1] === "acme" && m[2] === "finance" && assetName ? assets[assetName] : undefined;
    if (body === undefined) {
      res.writeHead(404).end("no such asset");
      return;
    }
    res.writeHead(200, responseHeaders[assetName!] ?? {}).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.FAILPROOFAI_PACK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of Object.entries({
    FAILPROOFAI_PACK_DIR: prevPackDir,
    FAILPROOFAI_PACK_BASE_URL: prevBase,
    FAILPROOFAI_NO_DOWNLOAD: prevNoDownload,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

const installed = () => JSON.parse(readFileSync(join(root, "installed.json"), "utf8"));

describe("parsePackSpec", () => {
  it("accepts the scheme and the bare form", () => {
    expect(parsePackSpec("github:acme/finance@v1.2.0")).toEqual({ owner: "acme", repo: "finance", tag: "v1.2.0" });
    expect(parsePackSpec("acme/finance@v1.2.0")).toEqual({ owner: "acme", repo: "finance", tag: "v1.2.0" });
  });

  it("leaves the tag null when none was named, rather than guessing one", () => {
    // Resolved to a CONCRETE tag at add time and pinned there. The rule that
    // matters was never "the user must type a tag" — it is that what the machine
    // RECORDS names one release, so a reinstall cannot drift.
    expect(parsePackSpec("github:acme/finance").tag).toBeNull();
    expect(parsePackSpec("acme/finance").tag).toBeNull();
  });

  it("accepts the URLs a person actually copies out of a browser", () => {
    expect(parsePackSpec("https://github.com/acme/finance/releases/tag/v1.2.0"))
      .toEqual({ owner: "acme", repo: "finance", tag: "v1.2.0" });
    expect(parsePackSpec("https://github.com/acme/finance/releases/download/v1.2.0/failproofai-pack.mjs"))
      .toEqual({ owner: "acme", repo: "finance", tag: "v1.2.0" });
    expect(parsePackSpec("https://github.com/acme/finance")).toEqual({ owner: "acme", repo: "finance", tag: null });
    expect(parsePackSpec("github.com/acme/finance/releases/latest"))
      .toEqual({ owner: "acme", repo: "finance", tag: null });
    // A tag containing slashes survives both URL shapes.
    expect(parsePackSpec("https://github.com/acme/finance/releases/tag/release/2.1").tag).toBe("release/2.1");
  });

  it("refuses owner/repo/tag that could reshape the URL", () => {
    expect(() => parsePackSpec("github:../evil/x@v1")).toThrow(/unsafe owner/);
    expect(() => parsePackSpec("github:acme/../x@v1")).toThrow(/unsafe repo/);
    expect(() => parsePackSpec("github:acme/finance@../../etc")).toThrow(/unsafe tag/);
    expect(() => parsePackSpec("https://github.com/../evil/x/releases/tag/v1")).toThrow(/unsafe owner/);
  });

  it("builds the asset URL by construction, never discovery", () => {
    const spec = parsePackSpec("github:acme/finance@v1.2.0") as { owner: string; repo: string; tag: string };
    expect(packAssetUrl(spec, "SHA256SUMS")).toBe(
      `${process.env.FAILPROOFAI_PACK_BASE_URL}/acme/finance/releases/download/v1.2.0/SHA256SUMS`,
    );
    expect(formatPackSpec(spec)).toBe("github:acme/finance@v1.2.0");
  });
});

describe("digestFor", () => {
  it("returns null rather than passing when the asset has no line", () => {
    expect(digestFor(`${"a".repeat(64)}  other.mjs\n`, "failproofai-pack.mjs")).toBeNull();
  });
});

describe("addPack", () => {
  it("fetches, verifies and activates a pack", async () => {
    const result = await addPack("github:acme/finance@v1.2.0");
    expect(result.id).toBe("acme/finance");
    expect(result.available).toEqual(["block-big-refund", "require-approval-note", "audit-log-writes"]);
    // The pack's OWN defaults, not everything it contains.
    expect(result.enabled).toEqual(["block-big-refund"]);
    expect(result.selection).toBe("defaults");

    const file = installed();
    expect(file.schemaVersion).toBe(1);
    expect(file.packs).toHaveLength(1);
    expect(file.packs[0].source).toBe("github:acme/finance@v1.2.0");
    expect(file.packs[0].sha256).toBe(sha(ENTRY));
    expect(file.packs[0].entry).toBe(`artifacts/${sha(ENTRY)}.mjs`);
    // And the reader accepts what the writer produced.
    const { packs, errors } = readInstalledPacks();
    expect(errors).toEqual([]);
    expect(packs[0].id).toBe("acme/finance");
  });

  describe("a source with no tag", () => {
    it("resolves the newest release and PINS the concrete tag", async () => {
      const result = await addPack("acme/finance");
      expect(result.resolvedFromLatest).toBe(true);
      expect(result.tag).toBe("v1.2.0");
      // The recorded source names one release, not "whatever is newest" — so a
      // reinstall from this record cannot drift to a different version.
      expect(installed().packs[0].source).toBe("github:acme/finance@v1.2.0");
    });

    it("resolves a bare github.com URL the same way", async () => {
      const result = await addPack("https://github.com/acme/finance");
      expect(result.tag).toBe("v1.2.0");
      expect(installed().packs[0].source).toBe("github:acme/finance@v1.2.0");
    });

    it("does not claim resolution when the tag was typed", async () => {
      const result = await addPack("github:acme/finance@v1.2.0");
      expect(result.resolvedFromLatest).toBe(false);
    });

    it("fails clearly when the repository has no releases", async () => {
      latestTag = null;
      await expect(addPack("acme/finance")).rejects.toThrow(/could not resolve the newest release/);
      expect(existsSync(join(root, "installed.json"))).toBe(false);
    });
  });

  it("takes only the selected policies", async () => {
    const result = await addPack("github:acme/finance@v1.2.0", { only: ["require-approval-note"] });
    expect(result.enabled).toEqual(["require-approval-note"]);
    expect(installed().packs[0].enabled).toEqual(["require-approval-note"]);
    expect(readInstalledPacks().packs[0].enabled).toEqual(["require-approval-note"]);
  });

  describe("how much of the pack you get", () => {
    it("installs the pack's defaults, NOT everything, when no flag is given", async () => {
      // A pack carries an opinion about which of its policies are safe to switch
      // on unattended — for the builtins that is 10 of 38. Enabling all of them
      // overrode that opinion with one nobody held, switching on things like
      // block-kubectl that are off by default precisely because they interrupt
      // legitimate work.
      const result = await addPack("github:acme/finance@v1.2.0");
      expect(result.enabled).toEqual(["block-big-refund"]);
      expect(result.selection).toBe("defaults");
    });

    it("--all takes everything", async () => {
      const result = await addPack("github:acme/finance@v1.2.0", { all: true });
      expect(result.enabled).toEqual(["block-big-refund", "require-approval-note", "audit-log-writes"]);
      expect(result.selection).toBe("all");
      // null means "the whole pack", so a later version's new policies are
      // included rather than frozen to the names that existed at install time.
      expect(installed().packs[0].enabled).toBeUndefined();
    });

    it("--category takes whole categories, by slug", async () => {
      const result = await addPack("github:acme/finance@v1.2.0", { categories: ["finance"] });
      expect(result.enabled).toEqual(["block-big-refund", "require-approval-note"]);
      const audit = await addPack("github:acme/finance@v1.2.0", { categories: ["audit-trail"] });
      expect(audit.enabled).toEqual(["audit-log-writes"]);
    });

    it("--category and --only union rather than fight", async () => {
      const result = await addPack("github:acme/finance@v1.2.0", {
        categories: ["audit-trail"], only: ["block-big-refund"],
      });
      // Kept in the pack's declared order, not the order the flags named them.
      expect(result.enabled).toEqual(["block-big-refund", "audit-log-writes"]);
    });

    it("names the real categories when given one that does not exist", async () => {
      await expect(addPack("github:acme/finance@v1.2.0", { categories: ["nonsense"] }))
        .rejects.toThrow(/no such category: nonsense .*finance, audit-trail/);
      expect(existsSync(join(root, "installed.json"))).toBe(false);
    });

    it("reports the categories a pack offers, for --category", async () => {
      const result = await addPack("github:acme/finance@v1.2.0");
      expect(result.categories).toEqual(["finance", "audit-trail"]);
    });
  });

  it("refuses a selection the pack does not contain", async () => {
    await expect(addPack("github:acme/finance@v1.2.0", { only: ["nope"] })).rejects.toThrow(/does not contain nope/);
    expect(existsSync(join(root, "installed.json"))).toBe(false);
  });

  it("carries a selection forward across an upgrade", async () => {
    // Upgrading a pack must not quietly switch on the policies someone chose to
    // leave off.
    await addPack("github:acme/finance@v1.2.0", { only: ["require-approval-note"] });
    release({ version: "1.3.0" });
    const result = await addPack("github:acme/finance@v1.3.0");
    expect(result.enabled).toEqual(["require-approval-note"]);
    expect(installed().packs).toHaveLength(1);
    expect(installed().packs[0].version).toBe("1.3.0");
  });

  describe("refuses BEFORE writing anything", () => {
    const wroteNothing = () => expect(existsSync(join(root, "installed.json"))).toBe(false);

    it("when the artifact does not match SHA256SUMS", async () => {
      assets["failproofai-pack.mjs"] = ENTRY + "\n// tampered\n";
      await expect(addPack("github:acme/finance@v1.2.0")).rejects.toThrow(/failed integrity verification/);
      wroteNothing();
    });

    it("when SHA256SUMS has no line for the artifact", async () => {
      assets.SHA256SUMS = `${sha(assets["failproofai-pack.json"])}  failproofai-pack.json\n`;
      await expect(addPack("github:acme/finance@v1.2.0")).rejects.toThrow(/no entry for failproofai-pack.mjs/);
      wroteNothing();
    });

    it("when a policy declares alwaysOn", async () => {
      release({ policies: [{ ...POLICY, alwaysOn: true }] });
      await expect(addPack("github:acme/finance@v1.2.0")).rejects.toThrow(/alwaysOn/);
      wroteNothing();
    });

    it("when a policy name would reach the builtin namespace", async () => {
      release({ policies: [{ ...POLICY, name: "failproofai/block-sudo" }] });
      await expect(addPack("github:acme/finance@v1.2.0")).rejects.toThrow(/unsafe name/);
      wroteNothing();
    });

    it.each([
      [{ id: "acme/finance/extra" }, /unsafe pack id/],
      [{ version: "release/1" }, /invalid version/],
      [{ effect: "audit" }, /unknown effect/],
    ])("when manifest identity is loader-invalid: %j", async (over, message) => {
      release(over);
      await expect(addPack("github:acme/finance@v1.2.0")).rejects.toThrow(message);
      wroteNothing();
    });

    it("when Content-Length declares an oversized response", async () => {
      responseHeaders.SHA256SUMS = { "content-length": String(8 * 1024 * 1024 + 1) };
      await expect(addPack("github:acme/finance@v1.2.0")).rejects.toThrow(/declares .* over the .* limit/);
      wroteNothing();
    });

    it("when a chunked response crosses the size limit", async () => {
      assets.SHA256SUMS = "x".repeat(8 * 1024 * 1024 + 1);
      responseHeaders.SHA256SUMS = { "transfer-encoding": "chunked" };
      await expect(addPack("github:acme/finance@v1.2.0")).rejects.toThrow(/over the .* byte limit/);
      wroteNothing();
    });

    it("when the release is missing entirely", async () => {
      await expect(addPack("github:acme/nothing@v9")).rejects.toThrow(/404/);
      wroteNothing();
    });

    it("when downloads are disabled", async () => {
      process.env.FAILPROOFAI_NO_DOWNLOAD = "1";
      await expect(addPack("github:acme/finance@v1.2.0")).rejects.toThrow(/FAILPROOFAI_NO_DOWNLOAD/);
      wroteNothing();
    });
  });
});

describe("removePack", () => {
  it("deactivates a pack and leaves its artifact on disk", async () => {
    const { artifact } = await addPack("github:acme/finance@v1.2.0");
    expect(removePack("acme/finance")).toBe(true);
    expect(installed().packs).toEqual([]);
    expect(readInstalledPacks().packs).toEqual([]);
    // Content-addressed and inert once nothing points at it, so keeping it makes
    // a re-add offline-safe.
    expect(existsSync(artifact)).toBe(true);
  });

  it("reports false for a pack that was never installed", async () => {
    await addPack("github:acme/finance@v1.2.0");
    expect(removePack("other/pack")).toBe(false);
    expect(installed().packs).toHaveLength(1);
  });
});
