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
  addPack, removePack, parsePackSpec, packAssetUrl, formatPackSpec, digestFor, fetchPackPreview,
  packTagMatchesVersion,
} from "@/src/hooks/pack-store";
import { readInstalledPacks } from "@/src/hooks/pack-manifest";

// Registers all three declared policies. `addPack` imports the artifact and
// refuses any pack whose registrations do not match its manifest, so a fixture
// that declared three and registered one IS the broken pack that check exists
// to catch — it cannot also stand in for a healthy one.
const ENTRY = `
  import { customPolicies, deny } from "failproofai";
  customPolicies.add({ name: "block-big-refund", description: "d",
    match: { events: ["PreToolUse"] }, fn: async () => deny("no") });
  customPolicies.add({ name: "require-approval-note", description: "d",
    match: { events: ["PreToolUse"] }, fn: async () => ({ decision: "allow" }) });
  customPolicies.add({ name: "audit-log-writes", description: "d",
    match: { events: ["PostToolUse"] }, fn: async () => ({ decision: "allow" }) });
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
/** Every path the client asked for, so a test can assert what it did NOT ask for. */
let requested: string[];
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
  requested = [];
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requested.push(url);
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

describe("packTagMatchesVersion", () => {
  it("accepts both spellings of the same release", () => {
    // `pack build` tells publishers to tag `<version>`; this repo's own releases
    // are tagged `v<version>`. Both are the same release said two ways, so
    // refusing either would fail installs that are perfectly coherent.
    expect(packTagMatchesVersion("1.2.0", "1.2.0")).toBe(true);
    expect(packTagMatchesVersion("v1.2.0", "1.2.0")).toBe(true);
  });

  it("accepts a prefixed tag on its last segment", () => {
    // `parsePackSpec` deliberately supports slashed tags, and PACK_VERSION_RE
    // forbids `/` — so a whole-string comparison would make the monorepo shape
    // uninstallable rather than merely unusual.
    expect(packTagMatchesVersion("release/2.1", "2.1")).toBe(true);
    expect(packTagMatchesVersion("packs/finance/v1.2.0", "1.2.0")).toBe(true);
    expect(packTagMatchesVersion("release/2.1", "1.0.0")).toBe(false);
  });

  it("refuses everything else, including a near miss", () => {
    expect(packTagMatchesVersion("v2.0.0", "1.2.0")).toBe(false);
    expect(packTagMatchesVersion("v1.2", "1.2.0")).toBe(false);
    // Not a leading `v` but a name that merely starts with one — the allowance
    // is for the convention, not for any prefix at all.
    expect(packTagMatchesVersion("version-1.2.0", "1.2.0")).toBe(false);
  });
});

describe("an empty selection is an answer, not a missing one", () => {
  /**
   * Reported from a real install: the picker highlights the publisher's
   * defaults, you untick every one of them, press enter — and it installs the
   * defaults anyway.
   *
   * `resolveSelection` tested `opts.only.length` to decide whether a selection
   * had been made, so `{only: []}` — "install it, enable none of it" — was
   * indistinguishable from passing no flags at all, and fell through to the
   * branch that takes the publisher's defaults. The user got the exact opposite
   * of what they chose, announced as "the pack's defaults". Presence of the key
   * is the signal now, never its length.
   */
  it("enables nothing when nothing was picked, and does NOT fall back to defaults", async () => {
    const result = await addPack("github:acme/finance@v1.2.0", { only: [] });
    expect(result.enabled).toEqual([]);
    expect(result.selection).toBe("selected");
    // The pack is still installed — the artifact is on disk and every policy is
    // listed, just switched off. "Enable none" is not "install nothing".
    expect(result.available.length).toBeGreaterThan(0);
  });

  it("writes the empty set to disk, so a reinstall does not resurrect the defaults", async () => {
    await addPack("github:acme/finance@v1.2.0", { only: [] });
    const record = installed().packs[0];
    // `enabled: []` and `enabled: undefined` mean opposite things — none, and
    // all. An empty array must survive the round trip as an array.
    expect(record.enabled).toEqual([]);
    expect(record.enabled).not.toBeUndefined();
  });

  it("still takes the defaults when no selection was expressed at all", async () => {
    // The other half of the distinction: no flags is not an empty selection.
    const result = await addPack("github:acme/finance@v1.2.0");
    expect(result.selection).toBe("defaults");
    expect(result.enabled.length).toBeGreaterThan(0);
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

    it("names the prerelease case when no redirect comes back", async () => {
      // GitHub issues the `releases/latest` redirect only for a published,
      // non-prerelease release, so "no releases at all" is the LESS likely cause
      // for a publisher hitting this: their newest release is a prerelease or a
      // draft. Saying only "could not resolve" sent them looking for a release
      // that is sitting right there.
      latestTag = null;
      await expect(addPack("acme/finance")).rejects.toThrow(/prerelease or a draft/);
      await expect(addPack("acme/finance")).rejects.toThrow(/Name a tag explicitly/);
    });
  });

  describe("a release tag that disagrees with its manifest version", () => {
    it("accepts the tag spelled without the leading v", async () => {
      // The tag builds the URL and the version is read from the manifest; both
      // spellings of the same release have to keep installing.
      const result = await addPack("github:acme/finance@1.2.0");
      expect(result.version).toBe("1.2.0");
      expect(installed().packs[0].source).toBe("github:acme/finance@1.2.0");
    });

    it("refuses a tag whose manifest declares a different version", async () => {
      // The bug this catches: nothing compared the two, so a release tagged
      // v1.2.0 carrying a manifest that still said 2.0.0 installed cleanly and
      // recorded a version that names no release of that repository.
      release({ version: "2.0.0" });
      const err = await addPack("github:acme/finance@v1.2.0").catch((e: Error) => e);
      // Both values named, and what to do about it.
      expect(String(err)).toMatch(/v1\.2\.0/);
      expect(String(err)).toMatch(/2\.0\.0/);
      expect(String(err)).toMatch(/re-tag the release|--version/);
      expect(existsSync(join(root, "installed.json"))).toBe(false);
      // Refused before a byte is written, so the machine is exactly as it was.
      expect(existsSync(join(root, "artifacts"))).toBe(false);
    });

    it("refuses on the resolved-from-latest path too, and says the release itself is wrong", async () => {
      // Nobody typed this tag, so the disagreement is the publisher's alone —
      // and it would land in installed.json just as silently.
      latestTag = "v3.0.0";
      const err = await addPack("acme/finance").catch((e: Error) => e);
      expect(String(err)).toMatch(/newest release of acme\/finance/);
      expect(String(err)).toMatch(/v3\.0\.0/);
      expect(String(err)).toMatch(/1\.2\.0/);
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
  // Returns the id it REMOVED rather than a boolean, so the caller can report
  // the name the machine holds instead of echoing back whatever was typed —
  // `remove FAILPROOFAI/POLICIES` succeeding and repeating that back teaches a
  // spelling nothing else in the product uses. `null` where it used to be
  // false. Matching itself is covered in pack-selection-merge.test.ts.
  it("deactivates a pack and leaves its artifact on disk", async () => {
    const { artifact } = await addPack("github:acme/finance@v1.2.0");
    expect(removePack("acme/finance")).toBe("acme/finance");
    expect(installed().packs).toEqual([]);
    expect(readInstalledPacks().packs).toEqual([]);
    // Content-addressed and inert once nothing points at it, so keeping it makes
    // a re-add offline-safe.
    expect(existsSync(artifact)).toBe(true);
  });

  it("reports nothing removed for a pack that was never installed", async () => {
    await addPack("github:acme/finance@v1.2.0");
    expect(removePack("other/pack")).toBeNull();
    expect(installed().packs).toHaveLength(1);
  });
});


describe("fetchPackPreview — reading a pack without installing it", () => {
  it("lists what the pack contains, tag resolved and pinned", async () => {
    const preview = await fetchPackPreview("acme/finance");
    expect(preview.id).toBe("acme/finance");
    expect(preview.version).toBe("1.2.0");
    expect(preview.resolvedFromLatest).toBe(true);
    expect(preview.source).toBe("github:acme/finance@v1.2.0");
    expect(preview.policies.map((p) => p.name)).toEqual([
      "block-big-refund",
      "require-approval-note",
      "audit-log-writes",
    ]);
    // The publisher's own opinion travels with it, which is what a reader is
    // deciding about.
    expect(preview.policies.filter((p) => p.defaultEnabled)).toHaveLength(1);
  });

  it("NEVER downloads the entry artifact — looking at a pack must not run it", async () => {
    await fetchPackPreview("acme/finance@v1.2.0");
    expect(requested.some((u) => u.endsWith("failproofai-pack.json"))).toBe(true);
    expect(requested.some((u) => u.endsWith("SHA256SUMS"))).toBe(true);
    // The one that matters: the executable half is never even fetched, so a
    // preview cannot execute a line of somebody else's code.
    expect(requested.some((u) => u.endsWith("failproofai-pack.mjs"))).toBe(false);
  });

  it("installs nothing", async () => {
    await fetchPackPreview("acme/finance@v1.2.0");
    expect(readInstalledPacks().packs).toEqual([]);
  });

  it("still verifies the manifest against the release's checksums", async () => {
    assets["failproofai-pack.json"] = assets["failproofai-pack.json"].replace("1.2.0", "9.9.9");
    await expect(fetchPackPreview("acme/finance@v1.2.0")).rejects.toThrow(/integrity/i);
  });

  it("refuses to fetch when downloads are turned off", async () => {
    process.env.FAILPROOFAI_NO_DOWNLOAD = "1";
    await expect(fetchPackPreview("acme/finance@v1.2.0")).rejects.toThrow(/NO_DOWNLOAD/);
  });

  it("reports a source that resolves to nothing", async () => {
    await expect(fetchPackPreview("nobody/nothing@v1.0.0")).rejects.toThrow();
  });
});
