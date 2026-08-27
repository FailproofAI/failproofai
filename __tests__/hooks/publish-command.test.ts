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
 * what they claim to send, and — for `--dry-run`, a bad tag, a missing
 * credential, a dirty tree and a directory that is not a checkout — that they
 * send NOTHING. A command that reaches GitHub before it has decided it should
 * is a command that half-publishes.
 *
 * The token is a fixture string and is never printed into an assertion message;
 * one test exists purely to hold the line that it never reaches stdout either.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /**
   * Tags already released here. Nothing reads them any more — the version is
   * the commit — and the route below is kept precisely so a test can fill this
   * in and prove the request is still never made.
   */
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
      // Listing releases used to be how the next version was counted. The route
      // stays so "nothing is counted" is provable: a test that deleted it would
      // watch the request 404 rather than watch it never happen.
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

// Reusing an existing PRIVATE repository used to upload all three assets, exit
// 0, print `failproofai policies add <repo>` and append a warning underneath —
// a success message for a release nobody can install. `fetchBytes` in
// pack-store.ts sends no Authorization header at all, by design, so every
// install of a private pack 404s; there is no credential a reader could supply
// to make that publish work. So it is refused before the release is created,
// and `--allow-private` is the way past it for somebody who will hand the
// assets over another way.
describe("an existing private repository", () => {
  const publishTo = (extra: string[] = []) =>
    publish([
      // Deliberately AHEAD OF THE ENTRY PATH, which every other test here puts
      // first. `publishEntryArg` finds the entry by skipping whatever follows a
      // flag that takes a value, so a valueless flag wrongly listed in
      // PUBLISH_VALUE_FLAGS eats the path after it and publish falls back to
      // scanning the cwd for policy files. Put anywhere else — between --repo
      // and its value, say — that mistake is invisible: `flag()` does not
      // consult that list, so the repo still resolves and the run still passes.
      ...extra,
      writeEntry(),
      "--repo",
      "acme/support",
      "--version",
      "1.0.0",
      "--out",
      join(work, "dist-pack"),
    ]);

  it("refuses, and uploads nothing at all", async () => {
    github.repo = { status: 200, body: { private: true } };

    const r = await publishTo();

    expect(r.exitCode).toBe(1);
    // Not the exit code alone. The bug being fixed was a SUCCESS that had
    // already attached three assets, so what has to hold is at the wire: no
    // release created, nothing uploaded, nothing deleted. The one request left
    // is the read that discovered the visibility in the first place — there is
    // no way to learn it without asking.
    expect(requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /repos/acme/support"]);
    expect(uploadsOf()).toEqual([]);
    // Nothing was BUILT either, which the request log cannot see: a complete,
    // uploadable pack left on disk under a publish the command just refused is
    // one `gh release upload` away from the dead end it refused to make.
    expect(existsSync(join(work, "dist-pack", PACK_MANIFEST_ASSET))).toBe(false);
  });

  it("names the repository, why no install can work, and both ways out", async () => {
    github.repo = { status: 200, body: { private: true } };

    const r = await publishTo();

    const text = r.lines.join("\n");
    expect(text).toMatch(/acme\/support is PRIVATE/);
    // "It is private" is not the reason — plenty of private things work. The
    // reason is that the install carries no credential, so it 404s.
    expect(text).toMatch(/anonymous HTTPS/);
    expect(text).toMatch(/404/);
    expect(text).toMatch(/gh repo edit acme\/support --visibility public/);
    expect(text).toMatch(/--allow-private/);
    // And a refusal must not print the install line it just refused to make
    // work — that line is the whole thing that was dishonest before.
    expect(r.lines.some((l) => l.includes("policies add"))).toBe(false);
  });

  it("publishes under --allow-private, and still says nobody can install it", async () => {
    github.repo = { status: 200, body: { private: true } };

    const r = await publishTo(["--allow-private"]);

    expect(r.exitCode).toBe(0);
    expect(uploadsOf().map((q) => q.query.get("name"))).toEqual([
      PACK_MANIFEST_ASSET,
      PACK_ENTRY_ASSET,
      PACK_CHECKSUMS_ASSET,
    ]);
    const text = r.lines.join("\n");
    expect(text).toMatch(/Published acme\/support@1\.0\.0/);
    // The flag buys a publish, never a working install, so the warning stays.
    expect(text).toMatch(/acme\/support is PRIVATE/);
    expect(text).toMatch(/anonymous HTTPS/);
    // Printed INSTEAD of the install lines, not underneath them: a reader who
    // copies the first command they see must not be copying one that 404s.
    expect(text).not.toMatch(/Anyone can now install it/);
    expect(r.lines).not.toContain("  failproofai policies add acme/support");
  });

  it("leaves a public repository alone, flag or no flag", async () => {
    // The flag permits a private destination; it does not change what a public
    // publish says or does. A regression here would mute the install lines for
    // everybody who passed it out of habit.
    github.repo = { status: 200, body: { private: false } };

    const r = await publishTo(["--allow-private"]);

    expect(r.exitCode).toBe(0);
    expect(uploadsOf()).toHaveLength(3);
    const text = r.lines.join("\n");
    expect(text).toMatch(/Published acme\/support@1\.0\.0/);
    expect(text).not.toMatch(/PRIVATE/);
    expect(r.lines).toContain("  failproofai policies add acme/support");
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

// The version is the COMMIT now. This block used to be about counting: it
// listed the repository's releases, found the highest date already there and
// minted the next ordinal after it. Every one of those tests is gone because
// the thing they described is gone — nothing is counted, nothing is asked of
// GitHub, and the answer is a property of the tree in front of you. What is
// asserted instead is that property: the same source always yields the same
// version, and the version is never minted where it would be a lie about which
// commit produced these bytes.
//
// These run against a REAL git checkout in the temp directory rather than a
// stubbed `git`, for the reason the sibling authoring suite gives: the whole
// point of the path is that it reads what git actually reports, and a stub
// would assert my idea of its output instead of its own.
describe("the version, when nobody says what it is", () => {
  const gitIn = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();

  /**
   * Where the built assets go — deliberately a SIBLING of the checkout below,
   * never inside it, so the only thing dirtying that tree is whatever a test
   * dirtied on purpose.
   *
   * Output landing INSIDE the checkout is not an unsupported arrangement, it is
   * the default one, and it has two tests of its own further down: the command
   * skips its own output directory when it reads the tree, and it is that skip
   * rather than this harness choice that keeps a second publish working.
   */
  const OUT = () => join(work, "dist-pack");

  /** A checkout with the entry committed in it, and the sha it sits at. */
  function checkout(): { entry: string; sha: string } {
    const dir = join(work, "pack");
    mkdirSync(dir, { recursive: true });
    const entry = join(dir, "policies.mjs");
    writeFileSync(entry, ENTRY, "utf8");
    gitIn(dir, "init", "-q", "-b", "main");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-qm", "policies");
    return { entry, sha: gitIn(dir, "rev-parse", "HEAD") };
  }

  const manifestVersion = (): { version: string; commit?: string } =>
    JSON.parse(readFileSync(join(OUT(), PACK_MANIFEST_ASSET), "utf8"));

  it("publishes a clean checkout at its own short sha", async () => {
    const { entry, sha } = checkout();
    const r = await publish([entry, "--repo", "acme/guards", "--out", OUT()]);

    expect(r.exitCode).toBe(0);
    const version = packCli.versionFromCommit(sha);
    // The whole line, not just the `@version` fragment: a version carrying an
    // extra suffix still CONTAINS the fragment, so the fragment alone would
    // read a counted `<sha>-2` as a pass. The tag is pinned in the same breath
    // because a release whose tag and version disagree installs as neither.
    expect(r.lines.join("\n")).toContain(
      `Published acme/guards@${version} to acme/guards at tag ${version}.`,
    );
    expect(manifestVersion().version).toBe(version);
    // The ABBREVIATION is what reaches the artifact — the version is a prefix
    // of the commit and not the whole forty characters of it. Which prefix is
    // pinned in pack-commit-version.test.ts; what is pinned here is that the
    // publish path truncates at all rather than writing the sha out twice.
    expect(manifestVersion().version).not.toBe(sha);
    expect(sha.startsWith(manifestVersion().version)).toBe(true);
    // And abbreviating loses nothing, because the FULL sha is still written
    // beside it — that is what a commit lookup resolves a tag from.
    expect(manifestVersion().commit).toBe(sha);
  });

  it("gives the same source the same version, however many times it is published", async () => {
    // The sharpest difference from counting. The old scheme handed a second
    // publish of identical bytes a NEW version, so a re-publish after a failed
    // upload silently became a different artifact and nobody could tell the two
    // apart by name. There is nothing to count now, so there is nothing to move.
    const { entry, sha } = checkout();
    const version = packCli.versionFromCommit(sha);

    const first = await publish([entry, "--repo", "acme/guards", "--out", OUT()]);
    expect(first.exitCode).toBe(0);
    expect(first.lines.join("\n")).toContain(
      `Published acme/guards@${version} to acme/guards at tag ${version}.`,
    );

    // The release the first publish made is now sitting on that tag.
    github.releaseOnTag = { id: 77 };
    requests.length = 0;

    const second = await publish([entry, "--repo", "acme/guards", "--out", OUT()]);
    expect(second.exitCode).toBe(0);
    expect(second.lines.join("\n")).toContain(
      `Published acme/guards@${version} to acme/guards at tag ${version}.`,
    );
    expect(manifestVersion().version).toBe(version);
    // Asserted at the wire too, because the printed line is downstream of the
    // decision: the second run looked for a release on the SAME tag, and then
    // uploaded onto the one it found rather than making a second release.
    expect(requests.find((q) => /\/releases\/tags\//.test(q.path))?.path).toBe(
      `/repos/acme/guards/releases/tags/${version}`,
    );
    expect(requests.filter((q) => q.method === "POST" && /\/releases$/.test(q.path))).toEqual([]);
    expect(uploadsOf().map((q) => q.path)).toEqual([
      "/repos/acme/guards/releases/77/assets",
      "/repos/acme/guards/releases/77/assets",
      "/repos/acme/guards/releases/77/assets",
    ]);
  });

  it("refuses a dirty tree, and publishes nothing at all", async () => {
    // The version claims to name a commit. Uncommitted bytes are not in that
    // commit, so minting it would point both the version and the `commit` field
    // beside it at source that does not contain what was published.
    const { entry } = checkout();
    writeFileSync(entry, `${ENTRY}\n// edited\n`, "utf8");

    const r = await publish([entry, "--repo", "acme/guards", "--out", OUT()]);

    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/policy files differ from it|uncommitted changes/);
    // Refusing AFTER creating a repository and a release would be worse than
    // not refusing: it leaves a half-made artifact somebody has to clean up.
    expect(requests).toEqual([]);
    // Nothing was BUILT either, which the request log cannot see. A refusal
    // that still wrote the three assets leaves a complete, uploadable pack on
    // disk carrying a version the command had just decided it must not mint.
    expect(existsSync(join(OUT(), PACK_MANIFEST_ASSET))).toBe(false);
    // And it says which flag gets past it, or the refusal is a dead end.
    expect(r.lines.join("\n")).toMatch(/--version <version>/);
  });

  it("refuses dirt anywhere in the tree, not only in the file being published", async () => {
    // A pack is every policy file in the directory, not only the one named, so
    // a check scoped to the entry would ship a dirty sibling under a commit
    // that does not contain it. The entry here is committed and untouched —
    // what disqualifies the publish is the rest of the tree.
    //
    // Both spellings of dirt count, and the second is the one that bites: a
    // file that was never `git add`ed is not in the commit at all, so a version
    // naming that commit is exactly as false as one minted over an edit.
    const { entry } = checkout();
    const dir = join(work, "pack");
    writeFileSync(join(dir, "README.md"), "# guards\n", "utf8");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-qm", "readme");

    writeFileSync(join(dir, "README.md"), "# guards, edited\n", "utf8");
    const edited = await publish([entry, "--repo", "acme/guards", "--out", OUT()]);
    expect(edited.exitCode).toBe(1);
    expect(edited.lines.join("\n")).toMatch(/policy files differ from it|uncommitted changes/);
    expect(requests).toEqual([]);

    gitIn(dir, "checkout", "--", "README.md");
    writeFileSync(join(dir, "notes.txt"), "scratch\n", "utf8");
    const untracked = await publish([entry, "--repo", "acme/guards", "--out", OUT()]);
    expect(untracked.exitCode).toBe(1);
    expect(untracked.lines.join("\n")).toMatch(/policy files (differ from it|are not in it)|uncommitted changes/);
    expect(requests).toEqual([]);
  });

  it("is not refused by the dist-pack its own previous run wrote", async () => {
    // The headline command is `cd my-policies && failproofai publish`, and its
    // default output directory is `dist-pack` under the cwd — so it writes
    // build output INTO the checkout whose cleanliness it reads. Untracked
    // files are dirt to `git status`, so the second publish of an unchanged,
    // fully committed tree was refused for uncommitted changes the command had
    // itself created, and the remedy it printed — `git add -A` — commits the
    // build output into the pack repository.
    //
    // Run through cwd with no --out rather than pointing --out inside the tree,
    // because the default is the whole point: a user who passes nothing gets
    // this arrangement and cannot see why the refusal is not about their work.
    const { sha } = checkout();
    const version = packCli.versionFromCommit(sha);
    const dir = join(work, "pack");
    const before = process.cwd();
    // `findDistIndex()` falls back to `<cwd>/dist` to resolve the `failproofai`
    // import inside a policy file, and chdir'ing out of the repo takes that
    // fallback away — the loader would then fail for a reason this test has no
    // opinion about. Pin it to the same directory the fallback would have found.
    const prevDist = process.env.FAILPROOFAI_DIST_PATH;
    process.env.FAILPROOFAI_DIST_PATH = join(before, "dist");
    process.chdir(dir);
    try {
      const first = await publish(["--repo", "acme/guards"]);
      expect(first.exitCode).toBe(0);
      expect(existsSync(join(dir, "dist-pack", PACK_MANIFEST_ASSET))).toBe(true);

      // The release the first run made is now on that tag, as it would be.
      github.releaseOnTag = { id: 77 };
      const second = await publish(["--repo", "acme/guards"]);
      expect(second.exitCode).toBe(0);
      expect(second.lines.join("\n")).toContain(
        `Published acme/guards@${version} to acme/guards at tag ${version}.`,
      );
    } finally {
      process.chdir(before);
      if (prevDist === undefined) delete process.env.FAILPROOFAI_DIST_PATH;
      else process.env.FAILPROOFAI_DIST_PATH = prevDist;
    }
  });

  it("skips that output directory by its place in the REPOSITORY, not in the entry's folder", async () => {
    // Both halves of the skip, on the arrangement that tells them apart: the
    // policies live in a subdirectory, so the repository root and the directory
    // git is run in are not the same place.
    //
    // The output directory has to be named from the ROOT — a pathspec is read
    // relative to git's cwd, so a relative one would exclude
    // `guards/dist-pack`, leave the real `dist-pack/` in the read, and hand the
    // self-inflicted refusal straight back to anyone whose pack is not at the
    // top of its repository. And the read still has to span the WHOLE
    // repository, or skipping one directory would quietly become "look only in
    // the entry's folder" and stop seeing dirt that belongs in the artifact.
    const dir = join(work, "repo");
    const nested = join(dir, "guards");
    mkdirSync(nested, { recursive: true });
    const entry = join(nested, "policies.mjs");
    writeFileSync(entry, ENTRY, "utf8");
    writeFileSync(join(dir, "README.md"), "# guards\n", "utf8");
    gitIn(dir, "init", "-q", "-b", "main");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-qm", "policies");
    const version = packCli.versionFromCommit(gitIn(dir, "rev-parse", "HEAD"));
    const out = join(dir, "dist-pack");

    const first = await publish([entry, "--repo", "acme/guards", "--out", out]);
    expect(first.exitCode).toBe(0);
    expect(existsSync(join(out, PACK_MANIFEST_ASSET))).toBe(true);

    github.releaseOnTag = { id: 77 };
    const second = await publish([entry, "--repo", "acme/guards", "--out", out]);
    expect(second.exitCode).toBe(0);
    expect(second.lines.join("\n")).toContain(
      `Published acme/guards@${version} to acme/guards at tag ${version}.`,
    );

    // Dirt two levels up from the file being published, with the same skip in
    // play, still stops it.
    writeFileSync(join(dir, "README.md"), "# guards, edited\n", "utf8");
    requests.length = 0;
    const third = await publish([entry, "--repo", "acme/guards", "--out", out]);
    expect(third.exitCode).toBe(1);
    expect(third.lines.join("\n")).toMatch(/policy files (differ from it|are not in it)|uncommitted changes/);
    expect(requests).toEqual([]);
  });

  it("refuses a directory that is not a checkout, and publishes nothing at all", async () => {
    const entry = writeEntry();
    // The temp directory must not itself sit inside a repository, or this test
    // would be measuring the harness rather than the refusal.
    expect(() => gitIn(work, "rev-parse", "HEAD")).toThrow();

    const r = await publish([entry, "--repo", "acme/guards", "--out", OUT()]);

    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/not a git checkout/);
    expect(requests).toEqual([]);
    expect(existsSync(join(OUT(), PACK_MANIFEST_ASSET))).toBe(false);
    expect(r.lines.join("\n")).toMatch(/--version <version>/);
  });

  it("lets --version through both refusals, because it is the stated way past them", async () => {
    // Both messages name this flag, so both have to honour it — a refusal that
    // advertises an escape hatch it does not have is worse than a plain refusal.
    //
    // The whole line each time, not the `@version` fragment: the fragment is
    // still contained in a version carrying a suffix, and the tag has to agree
    // with the version or the release installs as neither.
    const bare = writeEntry();
    const bareOut = join(work, "out-bare");
    const r1 = await publish([bare, "--repo", "acme/guards", "--version", "1.0.0", "--out", bareOut]);
    expect(r1.exitCode).toBe(0);
    expect(r1.lines.join("\n")).toContain(
      "Published acme/guards@1.0.0 to acme/guards at tag 1.0.0.",
    );
    // No checkout, so there is no commit to record — and an invented one would
    // be worse than none, because `commit` is what a reader resolves back to
    // source.
    expect(JSON.parse(readFileSync(join(bareOut, PACK_MANIFEST_ASSET), "utf8")).commit).toBeUndefined();

    const { entry, sha } = checkout();
    writeFileSync(entry, `${ENTRY}\n// edited\n`, "utf8");
    const dirtyOut = join(work, "out-dirty");
    const r2 = await publish([entry, "--repo", "acme/guards", "--version", "2.0.0", "--out", dirtyOut]);
    expect(r2.exitCode).toBe(0);
    expect(r2.lines.join("\n")).toContain(
      "Published acme/guards@2.0.0 to acme/guards at tag 2.0.0.",
    );
    // NO commit is recorded on a dirty tree, even though --version let the
    // publish through. `commit` claims these bytes came from that commit, and
    // on a dirty tree they did not — so recording it put the exact false claim
    // the dirty refusal exists to prevent through the door right beside it,
    // reachable by taking the escape hatch that refusal recommends. This used
    // to be a documented gap; it is now closed, and the two assertions below
    // are what keeps it closed.
    expect(JSON.parse(readFileSync(join(dirtyOut, PACK_MANIFEST_ASSET), "utf8")).commit).toBeUndefined();
    // And nowhere else either: the release body is the other place a reader
    // would resolve a commit from, so the sha must not appear there.
    const body = requests
      .filter((q) => q.method === "POST" && /\/releases$/.test(q.path))
      .map((q) => JSON.parse(q.body.toString("utf8")))
      .find((b) => b.tag_name === "2.0.0");
    expect(body).toBeDefined();
    expect(body.body).not.toContain(sha);
    // And the sha-derived version is not silently smuggled in beside the one
    // that was asked for.
    expect(r2.lines.join("\n")).not.toContain(packCli.versionFromCommit(sha));
  });

  it("asks the repository nothing in order to choose the version", async () => {
    // Not asking is now the design, not an optimisation: a fresh clone, an
    // air-gapped machine and a second publisher all compute the same answer for
    // the same source without knowing what the repository has published before.
    // The stand-in still serves a release list, and it stays untouched.
    github.releases = [{ tag_name: "2099.01.01" }, { tag_name: "3.4.5" }];
    const { entry, sha } = checkout();

    const r = await publish([entry, "--repo", "acme/guards", "--out", OUT()]);

    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain(`acme/guards@${packCli.versionFromCommit(sha)}`);
    expect(requests.filter((q) => q.method === "GET" && /\/releases$/.test(q.path))).toEqual([]);
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

  it("stays public under --allow-private, which is not a request to create one", async () => {
    // The flag's name reads like an instruction ("make it private") and is not
    // one: it only acknowledges a repository that was ALREADY private. Wiring it
    // into the creation body would mint a brand-new pack nobody can install, for
    // somebody who passed the flag purely to get past a refusal — the exact dead
    // end that refusal exists to prevent, reached through its own escape hatch.
    github.repo = { status: 404, body: { message: "Not Found" } };

    const r = await publish([
      "--allow-private",
      writeEntry(),
      "--repo",
      "acme/guards",
      "--version",
      "1.0.0",
      "--out",
      join(work, "dist-pack"),
    ]);

    expect(r.exitCode).toBe(0);
    const create = requests.find((q) => q.method === "POST" && /repos$/.test(q.path));
    expect(create, "the repository has to have been created for this to mean anything").toBeDefined();
    expect(JSON.parse(create!.body.toString()).private).toBe(false);
    // And because it came back public, the install lines stand — the flag
    // suppresses them only for a destination that really is private.
    expect(r.lines).toContain("  failproofai policies add acme/guards");
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

  it("never prompts where nobody can answer", async () => {
    // The destination prompt is TTY-only. On a pipe, in CI, or under a test
    // runner there is nobody to answer it, and a publish that blocks forever
    // waiting for a line that never comes is worse than one that says what
    // flag it needed. Reaching the assertion at all is the test: a prompt here
    // would hang until the suite timed out.
    github.repo = { status: 404, body: { message: "Not Found" } };
    const r = await publish([writeEntry(), "--repo", "acme/guards", "--version", "1.0.0"]);
    expect(r.exitCode).toBe(0);
  });

  it("does NOT seed it, so the author's own push is a fast-forward", async () => {
    // It was created with `auto_init: true`, which meant GitHub wrote an
    // "Initial commit" the author did not have — so the `git push` that every
    // publish is followed by was rejected as unrelated history, for everybody.
    github.repo = { status: 404, body: { message: "Not Found" } };
    await publish([writeEntry(), "--repo", "acme/guards", "--version", "1.0.0"]);
    const create = requests.find((r) => r.method === "POST" && /repos$/.test(r.path));
    expect(JSON.parse(create!.body.toString()).auto_init).toBe(false);
  });

  it("gives the empty repository a default branch for the release to tag", async () => {
    // The release API tags the DEFAULT BRANCH and is sent no target_commitish,
    // so a repository with no commits has nothing to tag. Publishing from a
    // directory that is not a git checkout has no history to push, so the
    // commit has to come from somewhere — here, the contents API.
    github.repo = { status: 404, body: { message: "Not Found" } };
    await publish([writeEntry(), "--repo", "acme/guards", "--version", "1.0.0"]);
    const seed = requests.find((r) => r.method === "PUT" && /\/contents\//.test(r.path));
    expect(seed, "an un-pushable new repo must still get a first commit").toBeDefined();
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
