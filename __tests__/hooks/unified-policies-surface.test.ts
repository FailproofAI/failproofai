// @vitest-environment node
//
// `policies`, `policy` and `pack` were three commands for one idea — two of them
// a single letter apart, doing unrelated things. They are one command now, and
// the old spellings are TRANSLATED rather than rejected, because they are
// printed in shipped help, in the docs, and in the release notes of every pack
// published so far.
//
// The translation happens as argv rewriting at the top of `bin/failproofai.mjs`,
// above `SUBCOMMANDS` and every dispatch, so no branch below has to remember the
// aliases. That is not reachable from a module import, so these drive the real
// binary and read what it printed.
//
// The property under test is EQUIVALENCE: an alias must not merely work, it must
// produce byte-identical output to the canonical spelling. A near-copy that
// drifts is exactly what having three commands cost in the first place.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RETIRED_CORE_ALIASES } from "../../src/hooks/pack-store";
import { runPolicyPicker } from "../../src/hooks/pack-cli";

const BINARY = resolve(__dirname, "..", "..", "bin", "failproofai.mjs");

const HOME = mkdtempSync(join(tmpdir(), "fpai-surface-"));
let fpHome: string;

/**
 * A package root carrying a freshly built `policy-pack/`.
 *
 * `core` reads the pack VENDORED in the package, which `bun run build` writes.
 * Pointing at the repo root works locally and fails in CI: `test` and `build`
 * are separate jobs, so `policy-pack/` does not exist when the tests run. The
 * other pack tests generate it; so does this one.
 */
let packageRoot: string;
let coreServer: Server;

beforeAll(async () => {
  packageRoot = mkdtempSync(join(tmpdir(), "fpai-surface-pkg-"));
  const packDir = join(packageRoot, "policy-pack");
  execFileSync(
    "bun",
    ["scripts/build-policy-pack.mjs", "--out", packDir],
    { cwd: resolve(__dirname, "../.."), stdio: ["pipe", "pipe", "inherit"] },
  );

  // `core` is FETCHED now — the package carries no copy. Served locally so
  // these tests do not depend on github.com being reachable, and so a CI run
  // cannot go green or red on somebody else's release.
  const assets: Record<string, Buffer> = {
    "failproofai-pack.json": readFileSync(join(packDir, "failproofai-pack.json")),
    "failproofai-pack.mjs": readFileSync(join(packDir, "failproofai-pack.mjs")),
    SHA256SUMS: readFileSync(join(packDir, "SHA256SUMS")),
  };
  const version = (JSON.parse(assets["failproofai-pack.json"].toString()) as { version: string }).version;
  coreServer = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/FailproofAI/policies/releases/latest") {
      res.writeHead(302, { location: `/FailproofAI/policies/releases/tag/v${version}` }).end();
      return;
    }
    const m = url.match(/^\/FailproofAI\/policies\/releases\/download\/([^/]+)\/([^/]+)$/);
    const body = m ? assets[m[2]] : undefined;
    if (!body) { res.writeHead(404).end("no such asset"); return; }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => coreServer.listen(0, "127.0.0.1", r));
}, 120_000);

beforeEach(() => {
  fpHome = mkdtempSync(join(tmpdir(), "fpai-surface-home-"));
  mkdirSync(fpHome, { recursive: true });
});

afterAll(async () => {
  await new Promise<void>((r) => coreServer.close(() => r()));
  rmSync(HOME, { recursive: true, force: true });
  rmSync(packageRoot, { recursive: true, force: true });
});

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  all: string;
}

/**
 * Runs the real binary and resolves with what it printed.
 *
 * ASYNC, and that is load-bearing rather than stylistic. `spawnSync` blocks the
 * worker's event loop — and the release server these tests stand up lives on
 * that same loop, so a synchronous spawn could never be served the assets the
 * child was fetching. Every `core` install sat there until the spawn timeout
 * and failed, while every test that touched no server passed, which is a very
 * convincing way to look like a product bug.
 *
 * `offline: true` proves a path reaches no network, rather than assuming it.
 */
function cli(args: string[], opts: { offline?: boolean } = {}): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bun", [BINARY, ...args], {
      env: {
        ...process.env,
        HOME,
        USERPROFILE: HOME,
        FAILPROOFAI_HOME: fpHome,
        FAILPROOFAI_TELEMETRY_DISABLED: "1",
        FAILPROOFAI_PACKAGE_ROOT: packageRoot,
        FAILPROOFAI_PACK_BASE_URL: `http://127.0.0.1:${(coreServer.address() as AddressInfo).port}`,
        ...(opts.offline ? { FAILPROOFAI_NO_DOWNLOAD: "1" } : {}),
      },
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolvePromise({ exitCode: code ?? 1, stdout, stderr, all: stdout + stderr }),
    );
  });
}

describe("the old spellings still answer, and answer identically", () => {
  it("takes `pack list` as the bare listing, which is the question it was asking", async () => {
    const canonical = await cli(["policies"]);
    const alias = await cli(["pack", "list"]);
    expect(canonical.exitCode).toBe(0);
    expect(alias.stdout).toBe(canonical.stdout);
  });

  it("takes `p` for the same listing", async () => {
    expect((await cli(["p"])).stdout).toBe((await cli(["policies"])).stdout);
  });

  it("routes `pack list <source>` to `show`, the OTHER question it was asking", async () => {
    // One word was doing two jobs: with no argument it described this machine,
    // with one it described a pack somewhere else. Those are different
    // questions and they are different words now.
    const viaAlias = await cli(["pack", "list", "acme/nothing-here"], { offline: true });
    const viaShow = await cli(["policies", "show", "acme/nothing-here"], { offline: true });
    expect(viaAlias.all).toBe(viaShow.all);
    expect(viaAlias.exitCode).toBe(viaShow.exitCode);
  });

  it("takes `policy add` and `policies add` as one command", async () => {
    expect((await cli(["policy", "add", "--help"])).stdout).toBe((await cli(["policies", "add", "--help"])).stdout);
  });

  it("resolves `pack build` to `publish`, which is what it always was minus the release", async () => {
    const built = await cli(["pack", "build"]);
    // Usage, not "unknown command" — the word still means something.
    expect(built.all).toMatch(/failproofai publish/);
    expect(built.all).toMatch(/--repo <owner>\/<repo>/);
  });
});

describe("a name or a source, told apart by the slash", () => {
  // A policy name matches /^[A-Za-z0-9._-]+$/, so a slash is already illegal in
  // one and unambiguous in the other. No flag to discover before you can install
  // somebody else's policies.

  it("sends a slashed argument to the pack lane", async () => {
    const r = await cli(["policies", "add", "acme/nothing-here"], { offline: true });
    expect(r.exitCode).not.toBe(0);
    // The pack lane's own refusal, which names fetching.
    expect(r.all).toMatch(/fetch|download|FAILPROOFAI_NO_DOWNLOAD/i);
  });

  it("sends a bare name to the policy lane, and fails DIFFERENTLY", async () => {
    const bare = await cli(["policies", "add", "no-such-policy-here"], { offline: true });
    const slashed = await cli(["policies", "add", "acme/nothing-here"], { offline: true });
    expect(bare.all).not.toBe(slashed.all);
    // A bare name is never a fetch — nothing about the network can appear.
    expect(bare.all).not.toMatch(/FAILPROOFAI_NO_DOWNLOAD/);
  });

  it("sends a github: source to the pack lane even with no slash-leading owner", async () => {
    const r = await cli(["policies", "add", "github:acme/nothing-here"], { offline: true });
    expect(r.all).toMatch(/fetch|download|FAILPROOFAI_NO_DOWNLOAD/i);
  });

  it("still routes a RETIRED spelling to the pack lane, so it can say what to type", async () => {
    // `core` no longer resolves — but it has to reach the layer that knows
    // that. Sent anywhere else it reads as an unknown POLICY name and the reply
    // lists 38 names, none of which is the answer.
    //
    // Read from the layer that OWNS the set. Restating it here is the drift
    // that already shipped once, when the dashboard could not resolve a name
    // the CLI could.
    expect(RETIRED_CORE_ALIASES.size).toBeGreaterThan(0);
    for (const retired of RETIRED_CORE_ALIASES) {
      const r = await cli(["policies", "add", retired, "--policy", "block-rm-rf"]);
      expect(r.exitCode, `${retired} should not silently succeed`).not.toBe(0);
      expect(r.all, `${retired} should name the replacement`).toMatch(/FailproofAI\/policies/);
    }
  });

  it("is case-insensitive about those spellings, because nobody types Core on purpose", async () => {
    const r = await cli(["policies", "add", "CORE", "--policy", "block-rm-rf"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.all).toMatch(/FailproofAI\/policies/);
  });
});

describe("`policies add` with nothing after it", () => {
  it("refuses from a script rather than silently confirming what is already true", async () => {
    // `multiSelect` degrades on a non-TTY by returning its PRE-CHECKED set. That
    // is the right degradation for a wizard step and the wrong one here: it
    // would report success for a run that changed nothing and answered nothing.
    const result = await runPolicyPicker("add", {
      stdin: { isTTY: false } as never,
      stdout: { isTTY: false, columns: 80 } as never,
    });
    expect(result.exitCode).not.toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain("policies add <policy-name>");
    expect(text).toContain("--all");
  });

  it("tells a machine with no packs where policies come from, and exits clean", async () => {
    // No packs is a FRESH machine, not a broken one — and since the wizard
    // stopped choosing policies, it is what every new install looks like. A
    // person at a terminal gets an answer, not an error.
    const empty = mkdtempSync(join(tmpdir(), "fpai-surface-packs-"));
    const before = process.env.FAILPROOFAI_PACK_DIR;
    process.env.FAILPROOFAI_PACK_DIR = empty;
    try {
      const result = await runPolicyPicker("add", {
        // isTTY on BOTH, so the refusal above does not fire; the empty-state
        // branch returns before any prompt is drawn, so nothing needs a stream.
        stdin: { isTTY: true } as never,
        stdout: { isTTY: true, columns: 80 } as never,
      });
      expect(result.exitCode).toBe(0);
      const text = result.lines.join("\n");
      expect(text).toContain("No policies are installed yet.");
      expect(text).toContain("failproofai policies add FailproofAI/policies");
      expect(text).toContain("<owner>/<repo>");
    } finally {
      if (before === undefined) delete process.env.FAILPROOFAI_PACK_DIR;
      else process.env.FAILPROOFAI_PACK_DIR = before;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("refuses through the real binary too, where stdin is a pipe", async () => {
    const r = await cli(["policies", "add"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.all).toMatch(/needs a terminal/);
    expect(r.all).toMatch(/<owner>\/<repo>/);
  });
});

describe("what the unified command actually does", () => {
  it("installs part of a pack and reports the part it did not take", async () => {
    const r = await cli(["policies", "add", "FailproofAI/policies", "--policy", "block-rm-rf"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/enabled \(1\//);
    expect(r.stdout).toMatch(/not enabled/);
  });

  // Removed by the id the pack DECLARES, which is now the id it is installed
  // from. It used to be `failproofai/core` — the published manifest said that
  // while `pack-store` and every piece of help said `FailproofAI/policies`, so
  // `policies remove FailproofAI/policies` answered "no installed pack with
  // that id" for the one pack everybody has. Two names, and neither surface
  // agreed with the other.
  it("uninstalls a whole pack by its id, which has a slash and so is a source", async () => {
    await cli(["policies", "add", "FailproofAI/policies", "--policy", "block-rm-rf"]);
    const removed = await cli(["policies", "remove", "FailproofAI/policies"]);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toMatch(/Removed FailproofAI\/policies/);
    expect((await cli(["policies"])).stdout).not.toMatch(/✓ PACK/);
    // The half that would have caught the original drift: the id you INSTALL
    // by is the id you REMOVE by, whatever it happens to be.
    expect(removed.stdout).not.toMatch(/failproofai\/core|failproofai\/builtins/);
  });

  it("needs the network to re-add what it removed, and says so plainly", async () => {
    // The artifact is still kept on disk, but `addPack` always fetches and
    // re-verifies — so a remove is not a local undo any more. The message used
    // to promise "re-adding it works offline", which stopped being true the day
    // the package stopped carrying policies. A message that promises offline
    // and then fails offline is worse than no message.
    await cli(["policies", "add", "FailproofAI/policies", "--policy", "block-rm-rf"]);
    const removed = await cli(["policies", "remove", "FailproofAI/policies"]);
    expect(removed.exitCode).toBe(0);
    expect(removed.all).not.toMatch(/offline/i);

    const offline = await cli(["policies", "add", "FailproofAI/policies"], { offline: true });
    expect(offline.exitCode).not.toBe(0);
    expect(offline.all).toMatch(/FAILPROOFAI_NO_DOWNLOAD/);
  });

  it("suggests the new spelling, never the retired one, when it has more to offer", async () => {
    const r = await cli(["policies", "add", "FailproofAI/policies", "--policy", "block-rm-rf"]);
    expect(r.stdout).not.toMatch(/failproofai pack (add|list)/);
  });
});
