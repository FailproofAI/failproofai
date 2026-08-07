// @vitest-environment node
//
// Regression test for the load-time integrity re-verification that closes the
// TOCTOU between hashing a cloud-managed policy file and importing it. Uses REAL
// temp files (not the fs mock the sibling loader-utils.test.ts installs) because
// the whole point is that the bytes on disk at read-for-import time are the ones
// checked.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { rewriteFileTree } from "../../src/hooks/loader-utils";

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");

describe("rewriteFileTree entry integrity re-verification", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  async function scratch() {
    const d = await mkdtemp(join(tmpdir(), "toctou-"));
    dirs.push(d);
    return d;
  }

  it("passes when the file still matches the pinned digest, and the rewritten entry derives from those bytes", async () => {
    const dir = await scratch();
    const entry = join(dir, "policy.mjs");
    const source = "export const x = 1;\n";
    await writeFile(entry, source, "utf-8");

    const tmp = await rewriteFileTree(entry, null, null, ".tmp.mjs", sha(source));
    expect(tmp.length).toBeGreaterThan(0);
    // The temp file that actually gets imported carries the verified content.
    expect(await readFile(entry + ".tmp.mjs", "utf-8")).toContain("export const x = 1");
  });

  it("refuses when the file was swapped after the digest was pinned — the exact TOCTOU an attacker exploits", async () => {
    const dir = await scratch();
    const entry = join(dir, "policy.mjs");
    // The digest is pinned to the genuine, verified bytes...
    const pinned = sha("export const good = 1;\n");
    // ...but a same-user attacker has since replaced the file on disk.
    await writeFile(entry, "throw new Error('pwned');\n", "utf-8");

    await expect(rewriteFileTree(entry, null, null, ".tmp.mjs", pinned)).rejects.toThrow(
      /integrity re-verification/,
    );
  });

  it("does not verify when no digest is passed — ordinary (non-cloud) custom policies are unaffected", async () => {
    const dir = await scratch();
    const entry = join(dir, "policy.mjs");
    await writeFile(entry, "export const y = 2;\n", "utf-8");

    const tmp = await rewriteFileTree(entry, null, null, ".tmp.mjs");
    expect(tmp.length).toBeGreaterThan(0);
  });
});
