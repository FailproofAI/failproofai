// @vitest-environment node
/**
 * The pack client, against a real socket.
 *
 * Every case here is a way a best-effort fetch could stop being best-effort:
 * by throwing, by replacing a good cache with something worse, or by silently
 * doing nothing when it was supposed to be configured. A pack is extra
 * information — failing to get one must leave the machine exactly as it was.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refreshContractPack,
  readCachedPack,
  packUrl,
  packChannel,
} from "../../src/hooks/contract-pack-client";
import { contractPackFile } from "../../src/hooks/fp-home";

let home: string;
let server: Server;
let url: string;
/** What the server answers with. Reassigned per test. */
let respond: (send: (status: number, body: string) => void) => void;

const PACK = JSON.stringify({
  generatedAt: "2026-08-18T00:00:00.000Z",
  clis: { goose: { version: "1.43.0", hooks: { PreToolUse: { envelope: [], tools: {} } } } },
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "fpai-pack-"));
  process.env.FAILPROOFAI_HOME = home;
  delete process.env.FAILPROOFAI_NO_DOWNLOAD;
  delete process.env.FAILPROOFAI_CONTRACTS_CHANNEL;

  respond = (send) => send(200, PACK);
  server = createServer((_req, res) => {
    respond((status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/pack.json`;
  process.env.FAILPROOFAI_CONTRACTS_URL = url;
});

afterEach(async () => {
  delete process.env.FAILPROOFAI_HOME;
  delete process.env.FAILPROOFAI_CONTRACTS_URL;
  delete process.env.FAILPROOFAI_NO_DOWNLOAD;
  delete process.env.FAILPROOFAI_CONTRACTS_CHANNEL;
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

/** Put a cache in place and age it, so freshness logic can be exercised. */
function seedCache(body: string, ageMs = 0): void {
  mkdirSync(join(home, "contracts"), { recursive: true });
  writeFileSync(contractPackFile(), body);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(contractPackFile(), when, when);
  }
}

describe("fetching a pack", () => {
  it("downloads and caches one", async () => {
    const out = await refreshContractPack();
    expect(out.status).toBe("fetched");
    expect(readCachedPack()).toMatchObject({ clis: { goose: { version: "1.43.0" } } });
  });

  it("does not refetch a cache that is still fresh", async () => {
    await refreshContractPack();
    let hits = 0;
    respond = (send) => {
      hits += 1;
      send(200, PACK);
    };
    expect((await refreshContractPack()).status).toBe("fresh");
    expect(hits).toBe(0);
  });

  it("refetches when forced, and when the cache is old", async () => {
    seedCache(PACK, 24 * 60 * 60 * 1000);
    expect((await refreshContractPack()).status).toBe("fetched");
    expect((await refreshContractPack({ force: true })).status).toBe("fetched");
  });
});

describe("what it refuses to cache", () => {
  it("keeps the old pack when the server answers with an error", async () => {
    seedCache(PACK, 24 * 60 * 60 * 1000);
    respond = (send) => send(503, "down");
    const out = await refreshContractPack();
    expect(out.status).toBe("failed");
    // The point: a failed refresh leaves a usable pack in place.
    expect(readCachedPack()).toMatchObject({ clis: { goose: {} } });
  });

  it("keeps the old pack when the server answers with something that is not JSON", async () => {
    seedCache(PACK, 24 * 60 * 60 * 1000);
    respond = (send) => send(200, "<html>a proxy login page</html>");
    expect((await refreshContractPack()).status).toBe("failed");
    expect(readCachedPack()).toMatchObject({ clis: { goose: {} } });
  });

  it("rejects JSON that is not a pack", async () => {
    // A cache holding something that is not a pack is worse than an empty one:
    // every later read pays to discover it.
    respond = (send) => send(200, JSON.stringify({ hello: "world" }));
    const out = await refreshContractPack();
    expect(out.status).toBe("failed");
    expect(out).toMatchObject({ reason: expect.stringContaining("not a pack") });
    expect(readCachedPack()).toBeNull();
  });

  it("refuses a body far larger than a pack could be", async () => {
    respond = (send) => send(200, JSON.stringify({ clis: {}, filler: "x".repeat(5 * 1024 * 1024) }));
    expect((await refreshContractPack()).status).toBe("failed");
    expect(readCachedPack()).toBeNull();
  });
});

describe("when it must do nothing at all", () => {
  it("defaults to the promoted channel, and an unknown name cannot move it off", () => {
    // The lab's unattended pushes cut PRERELEASES, which `releases/latest`
    // skips — so a pack from a bad run cannot become the one customers fetch.
    // A typo in the channel name must not be a route onto the unreviewed one.
    delete process.env.FAILPROOFAI_CONTRACTS_URL;
    expect(packChannel()).toBe("stable");
    process.env.FAILPROOFAI_CONTRACTS_CHANNEL = "nonsense";
    expect(packChannel()).toBe("stable");
    expect(packUrl()).toContain("releases/latest/download/pack.json");
  });

  it("reads the branch directly on the internal channel", () => {
    // Our own machines take the risk first. It reads the branch rather than the
    // newest prerelease because "latest prerelease" has no constructible URL —
    // only an API query, which is the discovery step the stable path avoids.
    delete process.env.FAILPROOFAI_CONTRACTS_URL;
    process.env.FAILPROOFAI_CONTRACTS_CHANNEL = "internal";
    expect(packChannel()).toBe("internal");
    expect(packUrl()).toBe(
      "https://raw.githubusercontent.com/FailproofAI/hook-contracts/packs/pack.json",
    );
  });

  it("lets an explicit URL win over either channel, for a mirror", () => {
    process.env.FAILPROOFAI_CONTRACTS_CHANNEL = "internal";
    process.env.FAILPROOFAI_CONTRACTS_URL = "http://mirror.internal/pack.json";
    expect(packUrl()).toBe("http://mirror.internal/pack.json");
  });

  it("falls back to the published release asset, constructed and not discovered", async () => {
    // `releases/latest/download/<asset>` is a plain redirect: no API call to
    // rate-limit, and no way to end up holding an artifact from a source we did
    // not name. It 404s until the lab's first publish, which is the correct
    // answer while no vendor contract has been measured.
    delete process.env.FAILPROOFAI_CONTRACTS_URL;
    expect(packUrl()).toBe(
      "https://github.com/FailproofAI/hook-contracts/releases/latest/download/pack.json",
    );
  });

  it("skips when downloads are disabled, without touching an existing cache", async () => {
    seedCache(PACK, 24 * 60 * 60 * 1000);
    process.env.FAILPROOFAI_NO_DOWNLOAD = "1";
    const before = readFileSync(contractPackFile(), "utf8");
    expect((await refreshContractPack()).status).toBe("skipped");
    expect(readFileSync(contractPackFile(), "utf8")).toBe(before);
    // Disabled fetching, not disabled reading: what is already there still works.
    expect(readCachedPack()).not.toBeNull();
  });

  it("never throws, whatever the server does", async () => {
    respond = (send) => send(200, "");
    await expect(refreshContractPack()).resolves.toMatchObject({ status: "failed" });
    delete process.env.FAILPROOFAI_CONTRACTS_URL;
    process.env.FAILPROOFAI_CONTRACTS_URL = "http://127.0.0.1:1/nothing-listening";
    await expect(refreshContractPack({ force: true })).resolves.toMatchObject({ status: "failed" });
  });
});

describe("reading the cache", () => {
  it("treats an unreadable or half-written cache as no cache", () => {
    seedCache("{ half-writ");
    expect(readCachedPack()).toBeNull();
  });

  it("leaves no temp file behind after a successful write", async () => {
    await refreshContractPack();
    const dir = join(home, "contracts");
    const leftovers = readFileSync(contractPackFile(), "utf8");
    expect(leftovers.length).toBeGreaterThan(0);
    expect(() => statSync(join(dir, `.pack.${process.pid}.tmp`))).toThrow();
  });
});
