// @vitest-environment node
/**
 * `failproofai publish` — the one command that both builds a pack and puts it
 * where a stranger's `policies add` can reach it.
 *
 * Every test here runs the real command against a local `node:http` stand-in for
 * GitHub, reached through `FAILPROOFAI_GITHUB_API` and
 * `FAILPROOFAI_GITHUB_UPLOADS`. Both are read at module scope, so the module is
 * imported only after the server is listening and the two variables point at it.
 *
 * The server records every request it is handed, which is what makes the two
 * halves of this file's contract testable at all: that the publishing paths send
 * what they claim to send, and — for `--dry-run`, a bad tag, and a missing
 * credential — that they send NOTHING. A command that reaches GitHub before it
 * has decided it should is a command that half-publishes.
 *
 * The token is a fixture string and is never printed into an assertion message;
 * one test exists purely to hold the line that it never reaches stdout either.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import {
  PACK_CHECKSUMS_ASSET,
  PACK_ENTRY_ASSET,
  PACK_MANIFEST_ASSET,
  packTagMatchesVersion,
} from "@/src/hooks/pack-store";

/** A credential shaped like the real thing and worth nothing. */
const TOKEN = "ghp_publish_command_test_token";

const ENTRY = `
  import { customPolicies, deny } from "failproofai";
  customPolicies.add({
    name: "block-big-refund",
    description: "Block refunds above the approved limit",
    category: "Finance",
    defaultEnabled: true,
    match: { events: ["PreToolUse"] },
    fn: async () => deny("no"),
  });
`;

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Buffer;
  authorization?: string;
  contentType?: string;
}

/** What the stand-in GitHub answers with, rewritten per test. */
interface FakeGitHub {
  repo: { status: number; body: Record<string, unknown> };
  /** The release already sitting on the tag, or null when the tag is fresh. */
  releaseOnTag: { id: number } | null;
  /** Assets already attached to the release we end up using. */
  assetsOnRelease: Array<{ id: number; name: string }>;
  created: { status: number; body: Record<string, unknown> };
  /** Per-asset upload outcome; anything unnamed uploads fine. */
  uploadFails: Record<string, { status: number; body: Record<string, unknown> }>;
  /** Tags already released here, which is what the next version is counted from. */
  releases: Array<{ tag_name: string }>;
  /** Who the credential belongs to — decides personal vs organisation creation. */
  login: string;
  createRepo: { status: number; body: Record<string, unknown> };
}

let server: Server;
let requests: Recorded[];
let github: FakeGitHub;
let work: string;
let saved: Record<string, string | undefined>;
let packCli: typeof import("@/src/hooks/pack-cli");

const uploadsOf = (asset?: string) =>
  requests.filter(
    (r) =>
      r.method === "POST" &&
      /\/releases\/\d+\/assets$/.test(r.path) &&
      (asset === undefined || r.query.get("name") === asset),
  );

const publish = (rest: string[]) => packCli.runPublishCommand(rest);

const writeEntry = (body = ENTRY) => {
  const p = join(work, "policies.mjs");
  writeFileSync(p, body, "utf8");
  return p;
};

beforeAll(async () => {
  requests = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      requests.push({
        method,
        path: url.pathname,
        query: url.searchParams,
        body: Buffer.concat(chunks),
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
      });

      const send = (status: number, body?: unknown) =>
        res
          .writeHead(status, { "content-type": "application/json" })
          .end(body === undefined ? "" : JSON.stringify(body));
      const p = url.pathname;

      let m = /^\/repos\/[^/]+\/[^/]+$/.exec(p);
      if (m && method === "GET") return send(github.repo.status, github.repo.body);

      m = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/.+$/.exec(p);
      if (m && method === "GET") {
        return github.releaseOnTag
          ? send(200, github.releaseOnTag)
          : send(404, { message: "Not Found" });
      }

      m = /^\/repos\/[^/]+\/[^/]+\/releases$/.exec(p);
      if (m && method === "POST") return send(github.created.status, github.created.body);
      // Listing releases is how the next version is counted.
      if (m && method === "GET") return send(200, github.releases);

      if (p === "/user" && method === "GET") return send(200, { login: github.login });
      if ((p === "/user/repos" || /^\/orgs\/[^/]+\/repos$/.test(p)) && method === "POST") {
        github.repo = { status: 200, body: { private: false } };
        return send(github.createRepo.status, github.createRepo.body);
      }

      m = /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(p);
      if (m && method === "DELETE") {
        github.assetsOnRelease = github.assetsOnRelease.filter((a) => a.id !== Number(m![1]));
        return send(204);
      }

      m = /^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/.exec(p);
      if (m && method === "GET") return send(200, github.assetsOnRelease);
      if (m && method === "POST") {
        const name = url.searchParams.get("name") ?? "";
        const failure = github.uploadFails[name];
        if (failure) return send(failure.status, failure.body);
        return send(201, { id: 900 + github.assetsOnRelease.length, name });
      }

      return send(404, { message: `unrouted ${method} ${p}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Both hosts are read once, at module scope — so they are set before the
  // module under test is ever evaluated.
  process.env.FAILPROOFAI_GITHUB_API = base;
  process.env.FAILPROOFAI_GITHUB_UPLOADS = base;
  vi.resetModules();
  packCli = await import("@/src/hooks/pack-cli");
});

afterAll(async () => {
  delete process.env.FAILPROOFAI_GITHUB_API;
  delete process.env.FAILPROOFAI_GITHUB_UPLOADS;
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  requests.length = 0;
  github = {
    repo: { status: 200, body: { private: false } },
    releaseOnTag: null,
    assetsOnRelease: [],
    created: { status: 201, body: { id: 4242 } },
    uploadFails: {},
    releases: [],
    login: "acme",
    createRepo: { status: 201, body: { id: 1 } },
  };
  work = mkdtempSync(join(tmpdir(), "fpai-publish-"));
  saved = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
    PATH: process.env.PATH,
  };
  process.env.GITHUB_TOKEN = TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(work, { recursive: true, force: true });
});

describe("publish without a release", () => {
  it("writes the three assets and reaches GitHub not once under --dry-run", async () => {
    const entry = writeEntry();
    const out = join(work, "dist-pack");
    const r = await publish([
      entry,
      "--repo",
      "acme/support",
      "--version",
      "1.0.0",
      "--out",
      out,
      "--dry-run",
    ]);

    expect(r.exitCode).toBe(0);
    for (const asset of [PACK_MANIFEST_ASSET, PACK_ENTRY_ASSET, PACK_CHECKSUMS_ASSET]) {
      expect(readFileSync(join(out, asset), "utf8").length).toBeGreaterThan(0);
    }
    expect(r.lines.join("\n")).toMatch(/Dry run — nothing was published\./);
    // The whole promise of the flag: the assets exist and GitHub never heard of it.
    expect(requests).toEqual([]);
  });

  it("stops at the assets, and says which repository it is missing, when no --repo is named", async () => {
    const entry = writeEntry();
    const out = join(work, "dist-pack");
    const r = await publish([entry, "--id", "acme/support", "--version", "1.0.0", "--out", out]);

    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(out, PACK_MANIFEST_ASSET), "utf8").length).toBeGreaterThan(0);
    expect(r.lines.join("\n")).toMatch(/Nothing was published: name a repository/);
    expect(requests).toEqual([]);
  });
});

describe("publish to a release", () => {
  it("creates the release and attaches exactly the three assets an installer fetches", async () => {
    const entry = writeEntry();
    const out = join(work, "dist-pack");
    const r = await publish([entry, "--repo", "acme/support", "--version", "1.0.0", "--out", out]);

    expect(r.exitCode).toBe(0);

    const created = requests.filter((q) => q.method === "POST" && /\/releases$/.test(q.path));
    expect(created).toHaveLength(1);
    expect(JSON.parse(created[0].body.toString("utf8"))).toMatchObject({
      tag_name: "1.0.0",
      draft: false,
      // A prerelease is invisible to releases/latest, which is how a tagless
      // `policies add owner/repo` resolves a version.
      prerelease: false,
    });

    // Fixed names, because the install URL is constructed from them.
    expect(uploadsOf().map((q) => q.query.get("name"))).toEqual([
      PACK_MANIFEST_ASSET,
      PACK_ENTRY_ASSET,
      PACK_CHECKSUMS_ASSET,
    ]);
    // And the bytes on the release are the bytes that were built, not a re-render.
    for (const asset of [PACK_MANIFEST_ASSET, PACK_ENTRY_ASSET, PACK_CHECKSUMS_ASSET]) {
      expect(uploadsOf(asset)[0].body).toEqual(readFileSync(join(out, asset)));
    }
    expect(uploadsOf(PACK_MANIFEST_ASSET)[0].contentType).toBe("application/json");
    // Every request carried the credential; none of them is anonymous.
    expect(requests.length).toBeGreaterThan(3);
    expect(requests.every((q) => q.authorization === `Bearer ${TOKEN}`)).toBe(true);

    const text = r.lines.join("\n");
    expect(text).toMatch(/Published acme\/support@1\.0\.0 to acme\/support at tag 1\.0\.0\./);
    expect(text).toMatch(/3 assets attached/);
    // The line the publisher hands to someone else.
    expect(r.lines).toContain("  failproofai policies add acme/support");
    // A public repository is not warned about.
    expect(text).not.toMatch(/PRIVATE/);
  });

  it("keeps the credential out of everything it prints", async () => {
    const entry = writeEntry();
    const r = await publish([
      entry,
      "--repo",
      "acme/support",
      "--version",
      "1.0.0",
      "--out",
      join(work, "dist-pack"),
    ]);
    expect(r.exitCode).toBe(0);
    // A token that reaches stdout reaches CI logs.
    expect(r.lines.join("\n")).not.toContain(TOKEN);
  });
});

describe("a tag that does not describe the version", () => {
  it("takes the version itself, and the same version with a leading v", () => {
    expect(packTagMatchesVersion("1.0.0", "1.0.0")).toBe(true);
    expect(packTagMatchesVersion("v1.0.0", "1.0.0")).toBe(true);
    expect(packTagMatchesVersion("release-3", "1.0.0")).toBe(false);
  });

  it("is refused before a single request is made, because the install would 404", async () => {
    const entry = writeEntry();
    const r = await publish([
      entry,
      "--repo",
      "acme/support",
      "--version",
      "1.0.0",
      "--tag",
      "release-3",
      "--out",
      join(work, "dist-pack"),
    ]);

    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/Tag release-3 does not describe version 1\.0\.0/);
    // Refused ahead of the network, so there is no half-made release to clean up.
    expect(requests).toEqual([]);
  });

  it("accepts v1.0.0 for version 1.0.0 and releases on that tag", async () => {
    const entry = writeEntry();
    const r = await publish([
      entry,
      "--repo",
      "acme/support",
      "--version",
      "1.0.0",
      "--tag",
      "v1.0.0",
      "--out",
      join(work, "dist-pack"),
    ]);

    expect(r.exitCode).toBe(0);
    const created = requests.filter((q) => q.method === "POST" && /\/releases$/.test(q.path));
    expect(JSON.parse(created[0].body.toString("utf8")).tag_name).toBe("v1.0.0");
    expect(r.lines.join("\n")).toMatch(/at tag v1\.0\.0\./);
    expect(uploadsOf()).toHaveLength(3);
  });
});

describe("a release that is already there", () => {
  it("reuses the release on the tag instead of making a second one", async () => {
    github.releaseOnTag = { id: 77 };
    const entry = writeEntry();
    const r = await publish([
      entry,
      "--repo",
      "acme/support",
      "--version",
      "1.0.0",
      "--out",
      join(work, "dist-pack"),
    ]);

    expect(r.exitCode).toBe(0);
    expect(requests.filter((q) => q.method === "POST" && /\/releases$/.test(q.path))).toEqual([]);
    // Uploaded onto the release that was already there, not onto a new one.
    expect(uploadsOf().map((q) => q.path)).toEqual([
      "/repos/acme/support/releases/77/assets",
      "/repos/acme/support/releases/77/assets",
      "/repos/acme/support/releases/77/assets",
    ]);
  });

  it("deletes an asset already sitting under the same name before uploading the new one", async () => {
    github.releaseOnTag = { id: 77 };
    github.assetsOnRelease = [{ id: 5, name: PACK_MANIFEST_ASSET }];
    const entry = writeEntry();
    const r = await publish([
      entry,
      "--repo",
      "acme/support",
      "--version",
      "1.0.0",
      "--out",
      join(work, "dist-pack"),
    ]);

    expect(r.exitCode).toBe(0);
    // A stale copy under a fixed name is exactly what an installer would fetch,
    // so the old one goes before the new one arrives.
    const deletes = requests.filter((q) => q.method === "DELETE");
    expect(deletes.map((q) => q.path)).toEqual(["/repos/acme/support/releases/assets/5"]);
    const deletedAt = requests.indexOf(deletes[0]);
    expect(deletedAt).toBeLessThan(requests.indexOf(uploadsOf(PACK_MANIFEST_ASSET)[0]));
    // The two assets that were not already there are not deleted, only added.
    expect(uploadsOf()).toHaveLength(3);
  });
});

describe("a private repository", () => {
  it("publishes, then warns that every install will 404", async () => {
    github.repo = { status: 200, body: { private: true } };
    const entry = writeEntry();
    const r = await publish([
      entry,
      "--repo",
      "acme/support",
      "--version",
      "1.0.0",
      "--out",
      join(work, "dist-pack"),
    ]);

    // Published — the assets really are attached.
    expect(r.exitCode).toBe(0);
    expect(uploadsOf()).toHaveLength(3);

    const text = r.lines.join("\n");
    expect(text).toMatch(/Published acme\/support@1\.0\.0/);
    expect(text).toMatch(/acme\/support is PRIVATE/);
    // `pack add` sends no Authorization header at all, by design — so the
    // warning has to say what that costs, not just that the repo is private.
    expect(text).toMatch(/Installs are anonymous HTTPS[^\n]*404/);
  });
});

describe("no credential at all", () => {
  it("names GITHUB_TOKEN and gh auth login, and makes no request", async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    // No `gh` to fall back to either, so the failure is the one users hit on a
    // fresh machine rather than this machine's own login.
    process.env.PATH = join(work, "no-tools-here");

    const entry = writeEntry();
    const r = await publish([
      entry,
      "--repo",
      "acme/support",
      "--version",
      "1.0.0",
      "--out",
      join(work, "dist-pack"),
    ]);

    expect(r.exitCode).toBe(1);
    const text = r.lines.join("\n");
    expect(text).toMatch(/GITHUB_TOKEN/);
    expect(text).toMatch(/gh auth login/);
    expect(requests).toEqual([]);
  });
});

describe("an upload that fails partway", () => {
  it("says how many landed and calls the release incomplete", async () => {
    github.uploadFails[PACK_ENTRY_ASSET] = {
      status: 422,
      body: { message: "Validation Failed", errors: [{ field: "name", code: "already_exists" }] },
    };
    const entry = writeEntry();
    const r = await publish([
      entry,
      "--repo",
      "acme/support",
      "--version",
      "1.0.0",
      "--out",
      join(work, "dist-pack"),
    ]);

    expect(r.exitCode).toBe(1);
    const text = r.lines.join("\n");
    expect(text).toMatch(/Uploaded 1 of 3 assets, then failproofai-pack\.mjs failed/);
    // GitHub's bare `message` is frequently just "Validation Failed", so the
    // field-level errors are carried too.
    expect(text).toMatch(/Validation Failed \(name already_exists\)/);
    expect(text).toMatch(/INCOMPLETE/);
    expect(text).toMatch(/Re-run the same command/);
    // It stopped where it broke: the checksums were never attempted.
    expect(uploadsOf(PACK_CHECKSUMS_ASSET)).toEqual([]);
  });
});

describe("the version, when nobody says what it is", () => {
  it("starts at 1.0.0 on a repository that has never released", async () => {
    const r = await publish([writeEntry(), "--repo", "acme/guards"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toMatch(/acme\/guards@1\.0\.0/);
  });

  it("counts one past the highest already published", async () => {
    github.releases = [{ tag_name: "1.0.0" }, { tag_name: "v1.0.1" }];
    const r = await publish([writeEntry(), "--repo", "acme/guards"]);
    expect(r.lines.join("\n")).toMatch(/@1\.0\.2/);
  });

  it("compares numerically, not as text", async () => {
    // The failure this pins: sorting strings puts "1.0.9" after "1.0.10", so a
    // tenth release would be handed 1.0.10 a second time.
    github.releases = [{ tag_name: "1.0.9" }, { tag_name: "1.0.10" }];
    const r = await publish([writeEntry(), "--repo", "acme/guards"]);
    expect(r.lines.join("\n")).toMatch(/@1\.0\.11/);
  });

  it("ignores releases that are not versions rather than guessing at them", async () => {
    // A repo whose releases are named `nightly` has no sequence to continue.
    github.releases = [{ tag_name: "nightly" }, { tag_name: "latest" }];
    const r = await publish([writeEntry(), "--repo", "acme/guards"]);
    expect(r.lines.join("\n")).toMatch(/@1\.0\.0/);
  });

  it("reads the repository's own releases, not anything local", async () => {
    github.releases = [{ tag_name: "3.4.5" }];
    await publish([writeEntry(), "--repo", "acme/guards"]);
    expect(requests.some((r) => r.method === "GET" && /\/releases$/.test(r.path))).toBe(true);
  });
});

describe("a repository that is not there yet", () => {
  it("creates it, so publishing is one command and not two tools", async () => {
    github.repo = { status: 404, body: { message: "Not Found" } };
    const r = await publish([writeEntry(), "--repo", "acme/guards", "--version", "1.0.0"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toMatch(/Created acme\/guards \(public\)/);
  });

  it("creates it PUBLIC, because a private one publishes to nobody", async () => {
    // Installs are anonymous HTTPS with no credential to offer, so a private
    // repo 404s for everyone — creating one would manufacture that dead end.
    github.repo = { status: 404, body: { message: "Not Found" } };
    await publish([writeEntry(), "--repo", "acme/guards", "--version", "1.0.0"]);
    const create = requests.find((r) => r.method === "POST" && /repos$/.test(r.path));
    expect(create).toBeDefined();
    expect(JSON.parse(create!.body.toString()).private).toBe(false);
  });

  it("uses the personal endpoint when the credential owns the name", async () => {
    github.repo = { status: 404, body: { message: "Not Found" } };
    github.login = "acme";
    await publish([writeEntry(), "--repo", "acme/guards", "--version", "1.0.0"]);
    expect(requests.some((r) => r.method === "POST" && r.path === "/user/repos")).toBe(true);
  });

  it("uses the organisation endpoint when it does not", async () => {
    // The only way to tell which applies is to ask who the token belongs to.
    github.repo = { status: 404, body: { message: "Not Found" } };
    github.login = "someone-else";
    await publish([writeEntry(), "--repo", "acme/guards", "--version", "1.0.0"]);
    expect(requests.some((r) => r.method === "POST" && r.path === "/orgs/acme/repos")).toBe(true);
  });

  it("names who it authenticated as when creation is refused", async () => {
    // Without that, "could not create" gives no way to tell it picked the wrong
    // account from the credential being wrong.
    github.repo = { status: 404, body: { message: "Not Found" } };
    github.login = "someone-else";
    github.createRepo = { status: 403, body: { message: "Forbidden" } };
    const r = await publish([writeEntry(), "--repo", "acme/guards", "--version", "1.0.0"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/someone-else/);
    expect(r.lines.join("\n")).toMatch(/gh repo create/);
  });
});
