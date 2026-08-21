// @vitest-environment node
/**
 * The pack manifest reader, exercised against real files with real digests.
 *
 * Every assertion here is about a REFUSAL. The reader's whole job is to decide
 * what may be imported, so a test that only proves the happy path proves the
 * least interesting half.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let root: string;
let prevEnv: string | undefined;

const ARTIFACT = "export const hooks = [];\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

/** A minimal valid pack policy — the shape a publisher serializes. */
const POLICY = {
  name: "block-refunds-over-limit",
  description: "Block refunds above the approved limit",
  category: "Finance",
  defaultEnabled: true,
  match: { events: ["PreToolUse"] },
};

function writeManifest(packs: unknown[], schemaVersion: unknown = 1): void {
  writeFileSync(join(root, "installed.json"), JSON.stringify({ schemaVersion, packs }));
}

function pack(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme/finance",
    version: "1.2.0",
    source: "github:acme/finance@v1.2.0",
    entry: `artifacts/${DIGEST}.mjs`,
    sha256: DIGEST,
    policies: [POLICY],
    ...over,
  };
}

async function read() {
  const mod = await import("../../src/hooks/pack-manifest");
  return mod.readInstalledPacks();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-packs-"));
  mkdirSync(join(root, "artifacts"), { recursive: true });
  writeFileSync(join(root, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  prevEnv = process.env.FAILPROOFAI_PACK_DIR;
  process.env.FAILPROOFAI_PACK_DIR = root;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.FAILPROOFAI_PACK_DIR;
  else process.env.FAILPROOFAI_PACK_DIR = prevEnv;
  rmSync(root, { recursive: true, force: true });
});

describe("readInstalledPacks", () => {
  it("returns nothing, and no error, when no pack was ever installed", async () => {
    // The overwhelmingly common case. It must not look like a failure.
    await expect(read()).resolves.toEqual({ packs: [], errors: [] });
  });

  it("resolves a valid pack and verifies its digest", async () => {
    writeManifest([pack()]);
    const { packs, errors } = await read();
    expect(errors).toEqual([]);
    expect(packs).toHaveLength(1);
    expect(packs[0].id).toBe("acme/finance");
    expect(packs[0].effect).toBe("enforce");
    expect(packs[0].policies.map((p) => p.name)).toEqual(["block-refunds-over-limit"]);
    expect(packs[0].path).toBe(resolve(root, "artifacts", `${DIGEST}.mjs`));
  });

  it("honours an explicit observe effect and refuses an unknown one", async () => {
    writeManifest([pack({ effect: "observe" })]);
    expect((await read()).packs[0].effect).toBe("observe");

    writeManifest([pack({ effect: "audit" })]);
    const { packs, errors } = await read();
    expect(packs).toEqual([]);
    expect(errors[0].reason).toContain("unknown effect");
  });

  describe("refusals", () => {
    it("refuses a tampered artifact WITHOUT taking other packs down with it", async () => {
      // The per-pack granularity that separates this from the cloud reader. One
      // bad third-party pack must not switch off every other pack on the machine.
      const other = "export const hooks = [1];\n";
      const otherDigest = createHash("sha256").update(other).digest("hex");
      writeFileSync(join(root, "artifacts", `${otherDigest}.mjs`), other);
      writeManifest([
        pack(),
        pack({ id: "good/pack", entry: `artifacts/${otherDigest}.mjs`, sha256: otherDigest }),
      ]);
      // Tamper with the FIRST pack's bytes after the manifest recorded its hash.
      writeFileSync(join(root, "artifacts", `${DIGEST}.mjs`), "export const hooks = [99];\n");

      const { packs, errors } = await read();
      expect(packs.map((p) => p.id)).toEqual(["good/pack"]);
      expect(errors).toHaveLength(1);
      expect(errors[0].id).toBe("acme/finance");
      expect(errors[0].reason).toContain("failed integrity verification");
    });

    it("refuses an entry path that escapes the pack root", async () => {
      writeManifest([pack({ entry: "../../../etc/passwd" })]);
      const { packs, errors } = await read();
      expect(packs).toEqual([]);
      expect(errors[0].reason).toMatch(/escapes its root|unsafe managed policy path/);
    });

    it("refuses an absolute entry path", async () => {
      writeManifest([pack({ entry: "/etc/passwd" })]);
      expect((await read()).errors[0].reason).toContain("unsafe managed policy path");
    });

    it("refuses a pack that declares alwaysOn", async () => {
      // alwaysOn means "cannot be disabled or paused". A downloaded file granting
      // itself that would be enforcement no local command can switch off.
      writeManifest([pack({ policies: [{ ...POLICY, alwaysOn: true }] })]);
      const { packs, errors } = await read();
      expect(packs).toEqual([]);
      expect(errors[0].reason).toContain("alwaysOn");
    });

    it("refuses a policy name containing a slash", async () => {
      // The namespace-hijack guard. `normalizePolicyName` passes a name with `/`
      // through untouched and `registerPolicy` replaces by canonical name, so
      // this exact string would otherwise overwrite the compiled builtin.
      writeManifest([pack({ policies: [{ ...POLICY, name: "failproofai/block-sudo" }] })]);
      const { packs, errors } = await read();
      expect(packs).toEqual([]);
      expect(errors[0].reason).toContain("unsafe name");
    });

    it("refuses a duplicate pack id", async () => {
      writeManifest([pack(), pack()]);
      const { packs, errors } = await read();
      expect(packs).toHaveLength(1);
      expect(errors[0].reason).toContain("duplicate pack id");
    });

    it("refuses a pack declaring the same policy twice", async () => {
      writeManifest([pack({ policies: [POLICY, POLICY] })]);
      expect((await read()).errors[0].reason).toContain("twice");
    });

    it("refuses an unsafe pack id", async () => {
      writeManifest([pack({ id: "../../evil" })]);
      expect((await read()).errors[0].reason).toContain("unsafe pack id");
    });

    it("refuses a policy missing required catalog fields", async () => {
      for (const missing of ["description", "category", "defaultEnabled", "match"]) {
        const p: Record<string, unknown> = { ...POLICY };
        delete p[missing];
        writeManifest([pack({ policies: [p] })]);
        const { errors } = await read();
        expect(errors[0].reason, missing).toContain(missing);
      }
    });
  });

  describe("manifest-level failures never throw", () => {
    it("records unreadable JSON as an error", async () => {
      writeFileSync(join(root, "installed.json"), "not json");
      const { packs, errors } = await read();
      expect(packs).toEqual([]);
      expect(errors[0].reason).toContain("unreadable pack manifest");
    });

    it("records an unsupported schema version as an error", async () => {
      writeManifest([pack()], 99);
      expect((await read()).errors[0].reason).toContain("unsupported pack manifest schema");
    });

    it("records a non-array packs field as an error", async () => {
      writeFileSync(join(root, "installed.json"), JSON.stringify({ schemaVersion: 1, packs: {} }));
      expect((await read()).errors[0].reason).toContain("not an array");
    });
  });
});
