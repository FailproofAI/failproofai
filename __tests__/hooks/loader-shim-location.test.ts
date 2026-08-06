// @vitest-environment node
//
// The ESM shim used to be written beside the installed package's `dist/index.js`.
// That directory belongs to whoever installed failproofai, and on a system-wide
// install (`sudo npm i -g`, a container image, a shared build host, a CI runner)
// it is root-owned — so every NON-ROOT user running a hook failed with EACCES,
// the policy never loaded, and the hook exited 0.
//
// The shape of that failure is why this test exists rather than a comment:
// builtin policies kept firing while cloud-managed and custom policies silently
// stopped, so the machine looked protected — denies appeared, the dashboard
// showed activity — while the organisation's actual policy did nothing. It
// failed OPEN, and the only signal was one line on stderr.
//
// These use the REAL filesystem. A mocked `fs` would happily "write" to a
// root-owned path and prove nothing about the bug.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { randomUUID } from "crypto";

import { createEsmShim, TMP_SUFFIX } from "../../src/hooks/loader-utils";

let home: string;
let pkg: string;
const originalHome = process.env.FAILPROOFAI_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-shim-home-"));
  pkg = mkdtempSync(join(tmpdir(), "fpai-shim-pkg-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = originalHome;
  // Restore write permission before cleanup, or rmSync cannot descend.
  for (const d of [join(pkg, "dist"), pkg]) {
    try {
      chmodSync(d, 0o755);
    } catch {
      /* absent or already writable */
    }
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(pkg, { recursive: true, force: true });
});

describe("hooks/loader-utils — ESM shim location", () => {
  it("writes the shim into the user's own state dir, never into the package", async () => {
    const distDir = join(pkg, "dist");
    mkdirSync(distDir, { recursive: true });
    const distIndex = join(distDir, "index.js");

    const { shimPath } = await createEsmShim(distIndex, `file://${distIndex}`, TMP_SUFFIX);

    expect(shimPath.startsWith(resolve(home) + sep)).toBe(true);
    expect(shimPath).toContain(join("state", "shims"));
    // The specific regression: nothing may be written next to dist/index.js.
    expect(shimPath.startsWith(distDir)).toBe(false);
    expect(existsSync(shimPath)).toBe(true);
  });

  it("succeeds when the package directory is NOT writable — the actual bug", async () => {
    // Exactly the system-wide-install shape: the package tree exists and is
    // readable, but the user running the hook cannot write to it.
    const distDir = join(pkg, "dist");
    mkdirSync(distDir, { recursive: true });
    const distIndex = join(distDir, "index.js");
    // The dist DIRECTORY is what must be unwritable — that is where the old
    // code tried to write. Making only its parent read-only proves nothing.
    chmodSync(distDir, 0o555);

    const { shimPath, shimUrl } = await createEsmShim(distIndex, `file://${distIndex}`, TMP_SUFFIX);

    expect(existsSync(shimPath)).toBe(true);
    expect(shimUrl.startsWith("file://")).toBe(true);
    // And it re-exports from the absolute dist URL, so its own location is free.
    expect(readFileSync(shimPath, "utf-8")).toContain(distIndex);
  });

  it("keeps the shim path normalisable, so the module cache still hits", async () => {
    // `fingerprintTemporaryTree` hashes temp paths after replacing the
    // per-invocation suffix (pid + load sequence) with the constant TMP_SUFFIX.
    // A shim name that did not carry that suffix — a random uuid, say — would
    // differ on every load, miss the cache every time, and put a cold module
    // load on the hottest path in the product.
    const distIndex = join(pkg, "dist-index.js");
    const a = await createEsmShim(distIndex, `file://${distIndex}`, `${TMP_SUFFIX}.111.1.mjs`);
    const b = await createEsmShim(distIndex, `file://${distIndex}`, `${TMP_SUFFIX}.222.7.mjs`);

    expect(a.shimPath).not.toBe(b.shimPath); // concurrent processes must not collide
    expect(a.shimPath.replaceAll(`${TMP_SUFFIX}.111.1.mjs`, TMP_SUFFIX)).toBe(
      b.shimPath.replaceAll(`${TMP_SUFFIX}.222.7.mjs`, TMP_SUFFIX),
    );
  });

  it("falls back to the OS temp dir when the home cannot hold a shim", async () => {
    // A REGULAR FILE as a path component: mkdir then fails ENOTDIR on every
    // platform. (A NUL byte does not work here — assigning it to process.env
    // truncates the value, so the primary path quietly succeeds and the test
    // asserts nothing about the branch it is named for.)
    const notADir = join(pkg, "regular-file");
    writeFileSync(notADir, "x");
    process.env.FAILPROOFAI_HOME = join(notADir, "sub");
    const distIndex = join(pkg, "dist-index.js");

    const { shimPath } = await createEsmShim(distIndex, `file://${distIndex}`, `${TMP_SUFFIX}.9.9.${randomUUID()}.mjs`);

    expect(shimPath.startsWith(resolve(tmpdir()))).toBe(true);
    expect(existsSync(shimPath)).toBe(true);
    expect(readFileSync(shimPath, "utf-8")).toContain("export const deny");
    rmSync(shimPath, { force: true });
  });

  it.skipIf(process.getuid?.() === 0)(
    "recovers when state/shims already exists but is NOT writable",
    async () => {
      // The shape a container bakes in: an entrypoint runs the CLI as root,
      // which creates state/shims, then the image drops to a non-root USER.
      // mkdir(recursive) RESOLVES on an existing directory whatever its mode,
      // so a guard around only the mkdir would sail through and then throw
      // EACCES on the write — reproducing the very fail-open being fixed.
      const shims = join(home, "state", "shims");
      mkdirSync(shims, { recursive: true });
      chmodSync(shims, 0o555);
      const distIndex = join(pkg, "dist-index.js");

      const { shimPath } = await createEsmShim(distIndex, `file://${distIndex}`, `${TMP_SUFFIX}.5.5.${randomUUID()}.mjs`);

      expect(existsSync(shimPath)).toBe(true);
      expect(shimPath.startsWith(resolve(tmpdir()))).toBe(true); // degraded, but it LOADED
      rmSync(shimPath, { force: true });
      chmodSync(shims, 0o700);
    },
  );

  it("writes the shim owner-only, never world-writable", async () => {
    // Unset mode is 0666 & ~umask, and `umask 000` is routine in containers —
    // on the fallback that is a world-writable file in shared /tmp that this
    // process then imports.
    const distIndex = join(pkg, "dist-index.js");
    const { shimPath } = await createEsmShim(distIndex, `file://${distIndex}`, TMP_SUFFIX);
    expect(statSync(shimPath).mode & 0o077).toBe(0);
  });
});
