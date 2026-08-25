// @vitest-environment node
//
// This replaces `bundled-pack.test.ts`, which covered an install path that has
// been removed on purpose.
//
// The package used to carry `policy-pack/` — our policies as a real,
// digest-verified pack — so `policies add core` worked with no network at all.
// It no longer does. A pack that ships inside the binary is a policy set chosen
// for the user and written to their disk before they asked for it, and it gave
// our own policies a delivery route no third-party pack could use, which is the
// opposite of what this whole lane exists to make possible.
//
// So `core` is now a SPELLING of a GitHub source. These tests pin that: the
// short name resolves to CORE_SOURCE, nothing installs from disk, and the one
// surviving reader of a vendored directory is the audit — which falls back to
// the compiled implementations when there isn't one.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CORE_ALIASES, CORE_SOURCE } from "../../src/hooks/pack-store";

const pkgRoot = resolve(__dirname, "..", "..");

describe("`core` is a spelling of a GitHub source", () => {
  it("points at the repository the policies are released from", () => {
    expect(CORE_SOURCE).toBe("FailproofAI/policies");
    // No slash-free special case beyond the aliases themselves: `CORE_SOURCE`
    // has to be something `parsePackSpec` accepts, or the short name resolves
    // to a source nothing can fetch.
    expect(CORE_SOURCE).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
  });

  it("keeps every short spelling anyone has been told to type", () => {
    for (const alias of ["core", "failproofai", "official"]) {
      expect(CORE_ALIASES.has(alias)).toBe(true);
    }
  });

  it("offers no way to install our policies from disk", async () => {
    // The export is gone, not merely unused. A second delivery path that only
    // our own pack can take is the thing being removed, so its absence is the
    // property worth pinning — a re-added helper would pass every other test.
    const store = await import("../../src/hooks/pack-store");
    expect("installBundledPack" in store).toBe(false);
  });
});

describe("the published package carries no policies", () => {
  it("does not ship policy-pack/ in the tarball", () => {
    const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as {
      files: string[];
      scripts: Record<string, string>;
    };
    expect(pkg.files).not.toContain("policy-pack/");
    // The whole point: an `npm install` puts no policy on anybody's disk.
    expect(pkg.files.some((f) => f.includes("policy-pack"))).toBe(false);
  });

  it("does not build one as part of `bun run build`", () => {
    const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).not.toContain("build:pack");
    // The script itself SURVIVES — publishing the core pack to its release
    // still needs it. It is just no longer part of shipping the CLI.
    expect(pkg.scripts["build:pack"]).toBeTruthy();
  });
});
