// @vitest-environment node
/**
 * The generated temporary tree, and why it must not accumulate.
 *
 * `rewriteFileTree` writes beside the user's sources — the only place a
 * rewritten relative import still resolves. That was harmless while the
 * generated name was fixed (`.__failproofai_tmp__.mjs`): an abnormally
 * terminated hook left at most one stale file per source, and the next load
 * overwrote it. The name now carries a pid and a sequence number (needed
 * because Bun ignores a query-string cache buster, so a warm worker would
 * otherwise reuse the first module forever), which means every kill — a CLI
 * hook timeout, a Ctrl-C — leaks one uniquely-named file permanently, beside
 * the user's policies and inside the installed package's `dist/`.
 *
 * Separate from `loader-utils.test.ts` because that file mocks `fs/promises`
 * wholesale, and these assertions are about real files on a real disk.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TMP_SUFFIX, isTmpArtifact, sweepStaleTmpArtifacts } from "../../src/hooks/loader-utils";
import { findSkippedPolicyFiles } from "../../src/hooks/custom-hooks-loader";

describe("generated temporary files", () => {
  it("recognises its own generated files whatever the pid and sequence", () => {
    expect(isTmpArtifact(`my-policies.mjs${TMP_SUFFIX}`)).toBe(true);
    expect(isTmpArtifact("my-policies.mjs.__failproofai_tmp__.12345.7.mjs")).toBe(true);
    // …and never a file the user wrote.
    expect(isTmpArtifact("my-policies.mjs")).toBe(false);
    expect(isTmpArtifact("block-foo.mjs")).toBe(false);
    expect(isTmpArtifact("failproofai_tmp.mjs")).toBe(false);
  });

  it("is never reported back to the user as a policy file that will not load", () => {
    // `findSkippedPolicyFiles` matches any loadable extension that misses the
    // `*policies.{js,mjs,ts}` convention — which every generated file does. So
    // each leftover became a warning accusing the user of misnaming a file
    // failproofai wrote itself.
    const dir = mkdtempSync(join(tmpdir(), "fpai-skipped-"));
    writeFileSync(join(dir, "block-foo.mjs"), "");
    writeFileSync(join(dir, "my-policies.mjs.__failproofai_tmp__.123.1.mjs"), "");
    writeFileSync(join(dir, "my-policies.mjs"), "");

    // Only the genuinely misnamed user file.
    expect(findSkippedPolicyFiles(dir)).toEqual(["block-foo.mjs"]);

    rmSync(dir, { recursive: true, force: true });
  });

  it("sweeps stale leftovers but never a tree another load is still importing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fpai-sweep-"));
    const stale = join(dir, "a-policies.mjs.__failproofai_tmp__.999.1.mjs");
    const fresh = join(dir, "b-policies.mjs.__failproofai_tmp__.1000.1.mjs");
    const authored = join(dir, "a-policies.mjs");
    for (const f of [stale, fresh, authored]) writeFileSync(f, "export default 1;\n");

    const now = Date.now();
    // The stale one predates any load that could still be running. The fresh
    // one may belong to a process mid-`import()` right now, and deleting it
    // would break a load that was going to succeed.
    const old = new Date(now - 10 * 60_000);
    utimesSync(stale, old, old);

    expect(await sweepStaleTmpArtifacts(dir, now)).toBe(1);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(authored)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("does not throw on a directory it cannot read", async () => {
    // Runs on the hook path; tidying up is never worth failing an evaluation.
    await expect(sweepStaleTmpArtifacts(join(tmpdir(), "fpai-does-not-exist"))).resolves.toBe(0);
  });
});
