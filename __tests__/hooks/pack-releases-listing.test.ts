// @vitest-environment node
/**
 * `failproofai policies show <owner>/<repo> --releases` — every release a pack
 * has published, and which one this machine is on.
 *
 * Driven against a real `node:http` stand-in for GitHub rather than a mocked
 * `fetch`, for the reason `pack-commit-spec.test.ts` is: the load-bearing claim
 * here is about HOW MANY requests the listing makes, and a mock that answers
 * whatever it is asked cannot tell one request from a hundred. The server wears
 * both hats — the API origin the listing reads AND the release-download origin
 * a manifest fetch would go to — so a future "fix" that counts policies by
 * downloading a manifest per release is COUNTED by this file rather than
 * quietly passing it.
 *
 * `GITHUB_API` is read once at pack-cli's module scope, so the module is
 * imported only after the server is listening and the variable points at it.
 *
 * Every test runs against a throwaway `FAILPROOFAI_PACK_DIR` and HOME. A test
 * that reads the real `~/.failproofai` decides its own result from whatever the
 * developer running it happens to have installed, and — worse — leaves the
 * vitest worker holding that state for whichever file runs next.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

/** Written by `publish` and read back by `--releases`; see `releaseBody`. */
const body = (version: string, counts = true, commit?: string): string =>
  [
    `acme/finance@${version}`,
    ...(counts ? ["", "7 policies, 4 on by default"] : []),
    ...(commit ? [`commit ${commit}`] : []),
  ].join("\n") + "\n";

const COMMIT = "abcdef1234567890abcdef1234567890abcdef12";

/** The three names an installable release carries. Anything else is
 *  "incomplete" — by NAME, not by count, which is what makes the next constant
 *  a case worth having. */
const THREE_ASSETS = [
  { name: "failproofai-pack.json" },
  { name: "failproofai-pack.mjs" },
  { name: "SHA256SUMS" },
];

/** Three attachments belonging to somebody else's release. Same COUNT as a pack
 *  release and not one of its names — what every ordinary repository that ships
 *  binaries looks like, and what `--releases` gets pointed at by anyone
 *  checking whether a repo publishes a pack at all. */
const THREE_FOREIGN_ASSETS = [
  { name: "app-linux-x64.tar.gz" },
  { name: "app-darwin-arm64.tar.gz" },
  { name: "checksums.txt" },
];

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

interface Release {
  tag_name?: unknown;
  body?: unknown;
  /** `null`, not absent, is what GitHub sends for a release with no publish
   *  date — a draft. `undefined` disappears through `JSON.stringify` and would
   *  only ever exercise the absent-key path. */
  published_at?: string | null;
  created_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ name: string }> | unknown;
}

/** A release the way GitHub returns one, with the fields this listing reads. */
function release(tag: string, over: Partial<Release> = {}): Release {
  return {
    tag_name: tag,
    body: body(tag, true, COMMIT),
    published_at: daysAgo(3),
    draft: false,
    prerelease: false,
    assets: THREE_ASSETS,
    ...over,
  };
}

const ARTIFACT = "export const hooks = [];\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

interface Recorded {
  path: string;
  authorization?: string;
}

let server: Server;
let requests: Recorded[];
/** What the stand-in answers the releases endpoint with, rewritten per test. */
let apiStatus: number;
let apiBody: string;
let packRoot: string;
let home: string;
let packCli: typeof import("@/src/hooks/pack-cli");
const saved: Record<string, string | undefined> = {};
let savedTTY: unknown;
let savedColumns: unknown;

const ENV_KEYS = [
  "FAILPROOFAI_GITHUB_API",
  "FAILPROOFAI_PACK_BASE_URL",
  "FAILPROOFAI_PACK_DIR",
  "FAILPROOFAI_HOME",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NO_COLOR",
  "PATH",
  "HOME",
  "USERPROFILE",
];

const run = (...args: string[]) => packCli.runPackCommand(["list", ...args]);

/**
 * One rendered table row, split back into cells. `table` joins cells with two
 * spaces and pads to the column width, so two-or-more spaces is the separator
 * and no cell this listing prints contains one.
 */
function cells(lines: string[], tag: string): string[] | null {
  const line = lines.find((l) => l.trimStart().split(/\s{2,}/)[0] === tag);
  return line ? line.trim().split(/\s{2,}/) : null;
}

/** Record packs as installed, artifact and all — `readInstalledPacks`
 *  re-verifies the digest, so a record with no file behind it reads as broken
 *  and would cost the marker this file is asserting. Takes a LIST because the
 *  interesting case is a machine with more than one pack on it: the marker is
 *  supposed to key off the pack id, and a single-pack fixture cannot tell that
 *  apart from an implementation matching any installed version at all. */
function installPacks(...packs: Array<{ id: string; version: string }>): void {
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  writeFileSync(join(packRoot, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  writeFileSync(
    join(packRoot, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: packs.map(({ id, version }) => ({
        id,
        version,
        source: `github:${id}@${version}`,
        entry: `artifacts/${DIGEST}.mjs`,
        sha256: DIGEST,
        policies: [
          {
            name: "block-big-refund",
            description: "Block refunds above the approved limit",
            category: "Finance",
            defaultEnabled: true,
            match: { events: ["PreToolUse"] },
          },
        ],
      })),
    }),
  );
}

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];

  requests = [];
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push({ path: url, authorization: req.headers.authorization });

    if (url.startsWith("/repos/acme/finance/releases")) {
      res.writeHead(apiStatus, { "content-type": "application/json" }).end(apiBody);
      return;
    }
    // The download half. It answers correctly on purpose: an implementation
    // that went back to reading a manifest per release would WORK, and the only
    // thing that catches it is the request count.
    if (/^\/acme\/finance\/releases\/download\/[^/]+\/failproofai-pack\.json$/.test(url)) {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ id: "acme/finance", version: "2026.08.26", policies: [] }));
      return;
    }
    res.writeHead(404).end("unrouted");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  process.env.FAILPROOFAI_GITHUB_API = base;
  process.env.FAILPROOFAI_PACK_BASE_URL = base;
  // No credential anywhere: listing a public repository's releases is a read
  // anybody can do, and an empty PATH keeps `githubToken()`'s `gh auth token`
  // fallback from finding a real one and posting it to a local socket.
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  process.env.PATH = "";

  vi.resetModules();
  packCli = await import("@/src/hooks/pack-cli");
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  requests.length = 0;
  apiStatus = 200;
  apiBody = "[]";
  packRoot = mkdtempSync(join(tmpdir(), "fpai-releases-packs-"));
  home = mkdtempSync(join(tmpdir(), "fpai-releases-home-"));
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  process.env.FAILPROOFAI_HOME = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Colour and width are read off the live stdout, which under a terminal-run
  // vitest is a real tty — so pin both, or every column assertion in this file
  // depends on the window the developer happened to have open.
  savedTTY = (process.stdout as { isTTY?: unknown }).isTTY;
  savedColumns = (process.stdout as { columns?: unknown }).columns;
  (process.stdout as { isTTY?: unknown }).isTTY = false;
  (process.stdout as { columns?: unknown }).columns = 100;
  process.env.NO_COLOR = "1";
});

afterEach(() => {
  (process.stdout as { isTTY?: unknown }).isTTY = savedTTY;
  (process.stdout as { columns?: unknown }).columns = savedColumns;
  rmSync(packRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("what the listing renders", () => {
  it("prints one row per release, newest first, under the columns it promises", async () => {
    // Deliberately handed over in an order that is NOT the answer — newest in
    // the middle, undated last — so "newest first" is a property of the render
    // rather than of the fixture. See the dedicated sorting test below for why
    // the API's own order cannot be trusted.
    apiBody = JSON.stringify([
      release("2026.08.26-2", { published_at: daysAgo(3) }),
      release("2026.08.26", { published_at: daysAgo(1) }),
      release("2026.08.20", { published_at: undefined, created_at: undefined }),
    ]);

    const r = await run("acme/finance", "--releases");
    const text = r.lines.join("\n");

    expect(r.exitCode).toBe(0);
    expect(text).toMatch(/version\s+published\s+commit\s+policies\s+default/);
    expect(text).toMatch(/acme\/finance/);
    expect(text).toMatch(/3 releases/);

    // By PUBLISHED date, descending, with the undated one last. Not by version:
    // a sha does not compare to anything, which is the whole reason this
    // listing exists.
    const order = ["2026.08.26", "2026.08.26-2", "2026.08.20"].map((tag) =>
      r.lines.findIndex((l) => l.trimStart().startsWith(tag)),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    const row = cells(r.lines, "2026.08.26")!;
    expect(row[0]).toBe("2026.08.26");
    // A relative age, never the ISO timestamp GitHub returns — "how stale" is
    // the question this column answers. The UNIT is pinned, and it has to be:
    // this used to accept any unit at all, and under that regex `relativeAge`
    // labelled every span one unit too fresh — this row, one day old, rendered
    // `1 hour ago`, and a six-month-old pack rendered `5 weeks ago`. A column
    // that cannot be wrong is not answering the question it is there for.
    expect(row[1]).toBe("1 day ago");
    expect(row.slice(2)).toEqual([COMMIT.slice(0, 7), "7", "4"]);
    // Plural too, from the same arithmetic — `1 day` alone would still pass
    // against a renderer that divided by the wrong unit and happened to land on
    // 1 for this row.
    expect(cells(r.lines, "2026.08.26-2")?.[1]).toBe("3 days ago");

    // Neither `published_at` nor `created_at`: a release that never said when
    // reads as a gap, not as `Invalid Date` or the epoch.
    expect(cells(r.lines, "2026.08.20")?.[1]).toBe("—");
  });

  it("falls back to created_at for a release GitHub never published, and to a gap for a date it cannot read", async () => {
    // `published_at: null` with a `created_at` beside it is the shape of a
    // DRAFT, which this listing shows rather than hides — so the fallback is on
    // the normal path for every row a draft occupies, and nothing was covering
    // it. The second row is the other half: `published_at` present and not a
    // date at all, which is what a non-GitHub host behind
    // `FAILPROOFAI_GITHUB_API` can send.
    apiBody = JSON.stringify([
      release("2026.08.26", { draft: true, published_at: null, created_at: daysAgo(2) }),
      release("2026.08.25", { published_at: "not a timestamp" }),
    ]);

    const r = await run("acme/finance", "--releases");

    expect(r.exitCode).toBe(0);
    expect(cells(r.lines, "2026.08.26")?.[1]).toBe("2 days ago");
    expect(cells(r.lines, "2026.08.25")?.[1]).toBe("—");
  });

  it("shows the counts a release recorded and an em dash for one that recorded none", async () => {
    // Mixed history is the NORMAL case: every pack that existed before the
    // release-body format has releases that say nothing, and a hand-made
    // release says nothing either. Both shapes have to render in one listing.
    apiBody = JSON.stringify([
      release("2026.08.26"),
      release("2026.08.20", { body: body("2026.08.20", false) }),
      release("1.0.0", { body: null }),
      // A release that recorded ZERO, which is a different fact from a release
      // that recorded nothing: `0 policies, 0 on by default` is what publishing
      // an empty pack, or one with every policy off, actually writes. The two
      // collapse into each other under any `count || "—"` spelling, and then a
      // pack that guards nothing reads exactly like one that simply predates
      // this format.
      release("0.9.0", { body: `acme/finance@0.9.0\n\n0 policies, 0 on by default\n` }),
    ]);

    const r = await run("acme/finance", "--releases");

    expect(cells(r.lines, "2026.08.26")?.slice(2)).toEqual([COMMIT.slice(0, 7), "7", "4"]);
    // Said its name and nothing else: no commit line, no counts line.
    expect(cells(r.lines, "2026.08.20")?.slice(2)).toEqual(["—", "—", "—"]);
    // No body at all — GitHub returns `null` for one, not an empty string.
    expect(cells(r.lines, "1.0.0")?.slice(2)).toEqual(["—", "—", "—"]);
    expect(cells(r.lines, "0.9.0")?.slice(2)).toEqual(["—", "0", "0"]);
    expect(r.lines.join("\n")).toMatch(/— means the release did not record it\./);
  });

  it("labels a draft, a prerelease and a half-attached release instead of hiding them", async () => {
    apiBody = JSON.stringify([
      release("2026.08.26", { draft: true }),
      release("2026.08.25", { prerelease: true }),
      release("2026.08.24", { assets: THREE_ASSETS.slice(0, 2) }),
      release("2026.08.23"),
    ]);

    const r = await run("acme/finance", "--releases");
    const text = r.lines.join("\n");

    expect(text).toMatch(/4 releases/);
    expect(cells(r.lines, "2026.08.26")?.at(-1)).toBe("draft");
    expect(cells(r.lines, "2026.08.25")?.at(-1)).toBe("prerelease");
    // Two of the three assets: an install would 404 later, so say so now.
    expect(cells(r.lines, "2026.08.24")?.at(-1)).toBe("incomplete");
    expect(cells(r.lines, "2026.08.23")).toHaveLength(5);

    // The hint has to name something installable, and nobody can install a draft.
    expect(text).toMatch(/failproofai policies add acme\/finance@2026\.08\.25/);
  });

  it("calls a release incomplete for the assets it is MISSING, not for how many it has", async () => {
    // Somebody else's repository, pointed at by somebody deciding whether it
    // publishes a pack at all. Counting attachments said three-is-three and
    // called the first two rows installable, which sent the reader to an
    // `add` that 404s on an asset nobody ever attached.
    apiBody = JSON.stringify([
      release("2026.08.26", { assets: THREE_FOREIGN_ASSETS }),
      release("2026.08.25", { assets: [...THREE_ASSETS.slice(0, 2), { name: "notes.txt" }] }),
      release("2026.08.24", { assets: [] }),
      release("2026.08.23", { assets: undefined }),
      // More than three is fine: a publisher may attach whatever else they like
      // beside the three the installer constructs URLs for.
      release("2026.08.22", { assets: [...THREE_ASSETS, { name: "notes.txt" }] }),
    ]);

    const r = await run("acme/finance", "--releases");
    const text = r.lines.join("\n");

    for (const tag of ["2026.08.26", "2026.08.25", "2026.08.24", "2026.08.23"]) {
      expect(cells(r.lines, tag)?.at(-1)).toBe("incomplete");
    }
    expect(cells(r.lines, "2026.08.22")).toHaveLength(5);
    // And the hint skips every one of them for the only row that installs.
    expect(text).toMatch(/failproofai policies add acme\/finance@2026\.08\.22/);
  });

  it("stacks every flag that is true of one release rather than reporting the first", async () => {
    // A prerelease this machine is on is an ordinary state — a pack tracking a
    // beta line — and it is the case that catches a flags column built from an
    // if/else chain, where the row would say `prerelease` and quietly drop the
    // one fact the reader ran this command for.
    installPacks({ id: "acme/finance", version: "2026.08.25" });
    apiBody = JSON.stringify([
      release("2026.08.26"),
      release("2026.08.25", { prerelease: true, assets: THREE_ASSETS.slice(0, 1) }),
    ]);

    const r = await run("acme/finance", "--releases");

    expect(cells(r.lines, "2026.08.25")?.at(-1)).toBe("prerelease · incomplete · installed");
  });

  it("skips a release with no tag name, in the table and in the hint alike", async () => {
    // A release the table drops has to be dropped by the hint too. It was not:
    // the row loop skipped an empty `tag_name` and the hint's own filter asked
    // only whether it was a string, so the command it offered was
    // `policies add acme/finance@` — a copyable line that cannot work. Anything
    // that is not a string is the same class, and `null` is what a host that is
    // not github.com will send.
    apiBody = JSON.stringify([
      release("", { published_at: daysAgo(0) }),
      release("2026.08.26", { tag_name: null }),
      release("2026.08.20"),
    ]);

    const r = await run("acme/finance", "--releases");
    const text = r.lines.join("\n");

    expect(text).toMatch(/1 release\b/);
    expect(text).toMatch(/failproofai policies add acme\/finance@2026\.08\.20/);
    expect(cells(r.lines, "2026.08.26")).toBeNull();
  });

  it("offers a placeholder rather than a tag when nothing on the page is installable", async () => {
    // Every release is a draft, so there is nothing to name. `<tag>` says "fill
    // this in" where naming a draft would say "run this", and running it fails.
    apiBody = JSON.stringify([
      release("2026.08.26", { draft: true }),
      release("2026.08.25", { draft: true }),
    ]);

    const r = await run("acme/finance", "--releases");
    const text = r.lines.join("\n");

    expect(text).toMatch(/failproofai policies add acme\/finance@<tag>/);
    expect(text).not.toMatch(/policies add acme\/finance@2026/);
  });

  it("marks the release this machine is actually on", async () => {
    installPacks({ id: "acme/finance", version: "2026.08.20" });
    apiBody = JSON.stringify([release("2026.08.26"), release("2026.08.20")]);

    const r = await run("acme/finance", "--releases");

    expect(cells(r.lines, "2026.08.20")?.at(-1)).toBe("installed");
    // Five cells is the row with an empty flags column — nothing marked.
    expect(cells(r.lines, "2026.08.26")).toHaveLength(5);
  });

  it("does not lend the marker to another pack that happens to sit on the same version", async () => {
    // Version strings are dates and semver — collisions between two packs are
    // ordinary, not exotic. The marker is keyed by pack id for exactly this,
    // and a fixture with one pack on it cannot tell that apart from a lookup
    // that matched any installed version at all.
    installPacks(
      { id: "other/pack", version: "2026.08.26" },
      { id: "acme/finance", version: "2026.08.20" },
    );
    apiBody = JSON.stringify([release("2026.08.26"), release("2026.08.20")]);

    const r = await run("acme/finance", "--releases");

    expect(cells(r.lines, "2026.08.26")).toHaveLength(5);
    expect(cells(r.lines, "2026.08.20")?.at(-1)).toBe("installed");
  });

  it("marks a v-prefixed tag and a differently-cased id as the same thing", async () => {
    // Two spellings that are the same pack. `pack build` tells publishers to tag
    // `<version>` while plenty of repositories tag `v<version>`, and GitHub owner
    // names are case-insensitive — so a listing that compared either literally
    // would tell somebody they are not on a release they are on, and offer them
    // an install they already have.
    installPacks({ id: "ACME/Finance", version: "2026.08.20" });
    apiBody = JSON.stringify([release("v2026.08.20")]);

    const r = await run("acme/finance", "--releases");

    expect(cells(r.lines, "v2026.08.20")?.at(-1)).toBe("installed");
  });

  it("keeps rendering, and marks nothing, when the record on this machine is broken", async () => {
    // Two separate things, both cheap to get wrong. The listing is about a
    // repository out there, so a broken file here costs one column's worth of
    // annotation and never the answer. And the marker goes through
    // `readInstalledPacks`, which re-verifies the artifact digest — so a record
    // whose artifact is gone or has been swapped is NOT something this machine
    // is running, and saying "installed" for it would be a claim about
    // enforcement that is not true. Reading id and version straight out of the
    // JSON is the obvious shortcut, and this is what stands in front of it.
    installPacks({ id: "acme/finance", version: "2026.08.20" });
    rmSync(join(packRoot, "artifacts", `${DIGEST}.mjs`));
    apiBody = JSON.stringify([release("2026.08.20")]);

    const r = await run("acme/finance", "--releases");

    expect(r.exitCode).toBe(0);
    expect(cells(r.lines, "2026.08.20")).toHaveLength(5);
  });

  it("keeps rendering when installed.json is not JSON at all", async () => {
    // `readInstalledPacks` reports that breakage rather than throwing, so this
    // pins that the listing does not go looking for its `errors` and turn them
    // into a failure of its own.
    mkdirSync(packRoot, { recursive: true });
    writeFileSync(join(packRoot, "installed.json"), "{ this is not json");
    apiBody = JSON.stringify([release("2026.08.26")]);

    const r = await run("acme/finance", "--releases");

    expect(r.exitCode).toBe(0);
    expect(cells(r.lines, "2026.08.26")).toHaveLength(5);
  });

  // The listing SORTS; it does not inherit an order.
  //
  // GitHub orders this endpoint by `created_at`, and a release's `created_at`
  // is the date of the COMMIT its tag points at — not when the release was cut.
  // Two releases made from one commit therefore tie, and the tie broke
  // backwards on the real FailproofAI/policies repository: a release published
  // at 14:38 sat above one published at 15:27, and the install hint offered the
  // older of the two.
  //
  // Survivable while versions sorted by themselves. Not survivable now: a sha
  // carries no order, so this list is the only place "which is newest?" is
  // answered, and `publish --help` sends people here to ask it.
  it("sorts by when each was PUBLISHED, not by the order the API returned", async () => {
    apiBody = JSON.stringify([
      // API order, verbatim from the tie GitHub actually produced: the older
      // publish first, both claiming the same created_at.
      release("2026.08.26", { created_at: "2026-08-26T10:48:55Z", published_at: daysAgo(1) }),
      release("5b0e6e4e666c", { created_at: "2026-08-26T10:48:55Z", published_at: daysAgo(0) }),
    ]);

    const r = await run("acme/finance", "--releases");
    const text = r.lines.join("\n");
    expect(r.exitCode).toBe(0);

    const newer = text.indexOf("5b0e6e4e666c");
    const older = text.indexOf("2026.08.26");
    expect(newer).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(-1);
    expect(newer).toBeLessThan(older);

    // The other half, and the one that actually cost somebody an install: the
    // hint has to name the newest too, not whatever the API happened to put
    // first.
    expect(text).toContain("acme/finance@5b0e6e4e666c");
    expect(text).not.toContain("acme/finance@2026.08.26");
  });

  it("sinks a release carrying no usable date rather than floating it to the top", async () => {
    // Absent and unparseable dates both. A release that has made no claim about
    // when it happened must not be shown as the newest thing on the strength of
    // it — which is what `undefined - number = NaN` does to a comparator that
    // does not handle it, since NaN leaves the pair in whatever order it found.
    apiBody = JSON.stringify([
      release("no-date", { created_at: undefined, published_at: undefined }),
      release("bad-date", { created_at: "not-a-date", published_at: "also-not" }),
      release("dated", { published_at: daysAgo(9) }),
    ]);

    const r = await run("acme/finance", "--releases");
    const text = r.lines.join("\n");
    expect(text.indexOf("dated")).toBeLessThan(text.indexOf("no-date"));
    expect(text.indexOf("dated")).toBeLessThan(text.indexOf("bad-date"));
    expect(text).toContain("acme/finance@dated");
  });

  it("counts one release in the singular", async () => {
    apiBody = JSON.stringify([release("2026.08.26")]);

    const r = await run("acme/finance", "--releases");

    expect(r.lines.join("\n")).toMatch(/1 release\b/);
    expect(r.lines.join("\n")).not.toMatch(/1 releases/);
  });

  it("emits no ANSI escapes when colour is off, and does emit them when it is on", async () => {
    apiBody = JSON.stringify([release("2026.08.26")]);

    (process.stdout as { isTTY?: unknown }).isTTY = true;
    const plain = await run("acme/finance", "--releases");
    expect(plain.lines.join("\n")).not.toMatch(/\u001b\[/);

    // The other half of the same claim: without it this test would still pass
    // against a render that had lost the ability to colour at all, which is not
    // what it is meant to be holding.
    delete process.env.NO_COLOR;
    const painted = await run("acme/finance", "--releases");
    expect(painted.lines.join("\n")).toMatch(/\u001b\[/);
  });
});

describe("the cost of the listing", () => {
  it("makes exactly one request however many releases come back", async () => {
    // The entire reason `publish` writes the counts into the release body. The
    // obvious implementation reads a manifest per release, which costs a
    // request each and gets slower the longer a pack has existed — and the
    // download half of this server would answer every one of them, so this
    // count is the only thing standing between here and that regression.
    apiBody = JSON.stringify(
      Array.from({ length: 25 }, (_, i) => release(`2026.08.${String(i + 1).padStart(2, "0")}`)),
    );

    const r = await run("acme/finance", "--releases");

    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toMatch(/25 releases/);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/repos/acme/finance/releases?per_page=100");
  });

  it("asks anonymously when there is no credential to offer", async () => {
    apiBody = JSON.stringify([release("2026.08.26")]);

    const r = await run("acme/finance", "--releases");

    expect(r.exitCode).toBe(0);
    // Requiring `gh auth login` to look at what a public pack published would be
    // a worse answer than the anonymous rate limit.
    expect(requests[0].authorization).toBeUndefined();
  });

  it("offers the credential it has, so the 5000-an-hour limit is reachable", async () => {
    // The other half of the claim above. Without it this pair would still pass
    // against a listing that could not send a token at all — and then the
    // `gh auth login` the rate-limit message prescribes fixes nothing, which is
    // a worse failure than asking anonymously in the first place.
    apiBody = JSON.stringify([release("2026.08.26")]);
    process.env.GITHUB_TOKEN = "ghp_notarealtoken";
    try {
      const r = await run("acme/finance", "--releases");

      expect(r.exitCode).toBe(0);
      expect(requests[0].authorization).toBe("Bearer ghp_notarealtoken");
      // And it stays out of the output: a token that reaches stdout reaches CI
      // logs.
      expect(r.lines.join("\n")).not.toMatch(/ghp_notarealtoken/);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });
});

describe("when there is nothing, or GitHub says no", () => {
  it("treats a repo with no releases as an empty state naming the publish command", async () => {
    apiBody = "[]";

    const r = await run("acme/finance", "--releases");
    const text = r.lines.join("\n");

    // Not an error: a repository somebody has not published from yet is a
    // perfectly ordinary thing to look at, and the useful reply is what its
    // author would run.
    expect(r.exitCode).toBe(0);
    expect(text).toMatch(/no releases/);
    expect(text).toMatch(/nothing to install/);
    expect(text).toMatch(/failproofai publish/);
    expect(text).not.toMatch(/version\s+published\s+commit/);
  });

  it("explains on a 404 that a pack has to be public to be installable at all", async () => {
    apiStatus = 404;
    apiBody = JSON.stringify({ message: "Not Found" });

    const r = await run("acme/finance", "--releases");
    const text = r.lines.join("\n");

    expect(r.exitCode).toBe(1);
    expect(text).toMatch(/No repository at acme\/finance, or it is private/);
    // The half a user cannot guess: installs are anonymous, so "make it public"
    // is the fix, not "give this machine a token".
    expect(text).toMatch(/has to be public/);
  });

  it("points a rate-limited listing at gh auth login rather than at the raw status", async () => {
    apiStatus = 403;
    apiBody = JSON.stringify({ message: "API rate limit exceeded for 127.0.0.1." });

    const r = await run("acme/finance", "--releases");
    const text = r.lines.join("\n");

    expect(r.exitCode).toBe(1);
    expect(text).toMatch(/rate-limited/i);
    expect(text).toMatch(/gh auth login/);
    expect(text).toMatch(/60 requests an hour to 5000/);
  });

  it("reports any other failure with the status rather than pretending the pack is empty", async () => {
    apiStatus = 500;
    apiBody = JSON.stringify({ message: "Server Error" });

    const r = await run("acme/finance", "--releases");

    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/Could not list releases for acme\/finance/);
    // GitHub's own message, not a paraphrase — a 500 is theirs to explain.
    expect(r.lines.join("\n")).toMatch(/Server Error/);
    expect(r.lines.join("\n")).not.toMatch(/gh auth login/);
  });

  it("does not offer the rate-limit fix for a 403 that is not about the rate limit", async () => {
    // The claim the 500 above was written for and could not make: the rate-limit
    // branch is chosen on the STATUS AND the message, so a 403 saying anything
    // else — SAML enforcement, a blocked token, an org policy — has to fall
    // through to the generic report. `gh auth login` fixes none of those, and
    // sending somebody to re-authenticate over a repository their credential is
    // deliberately not allowed to see is a wasted afternoon.
    apiStatus = 403;
    apiBody = JSON.stringify({ message: "Resource protected by organization SAML enforcement" });

    const r = await run("acme/finance", "--releases");
    const text = r.lines.join("\n");

    expect(r.exitCode).toBe(1);
    expect(text).toMatch(/Could not list releases for acme\/finance/);
    expect(text).toMatch(/SAML enforcement/);
    expect(text).not.toMatch(/gh auth login/);
    expect(text).not.toMatch(/rate-limited/i);
  });

  it("refuses a 200 that is not a list instead of rendering it as no releases", async () => {
    // An HTML error page from a proxy, or a `{"message": …}` object from a host
    // behind `FAILPROOFAI_GITHUB_API` that answers 200 for everything. Reading
    // that as an empty array would print "This repository has published no
    // releases" — a confident, wrong answer about somebody else's pack, and the
    // one failure mode a listing must never have.
    apiStatus = 200;
    apiBody = JSON.stringify({ message: "Moved Permanently" });

    const r = await run("acme/finance", "--releases");
    const text = r.lines.join("\n");

    expect(r.exitCode).toBe(1);
    expect(text).toMatch(/Could not list releases for acme\/finance/);
    expect(text).not.toMatch(/no releases/);
  });
});

describe("routing from the list command", () => {
  it("refuses --releases with no source instead of listing what is installed here", async () => {
    const r = await packCli.runPackCommand(["list", "--releases"]);

    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/Usage: failproofai policies show <owner>\/<repo> --releases/);
    // The distinction the flag exists for: out there versus here.
    expect(r.lines.join("\n")).toMatch(/what is installed here/);
    expect(requests).toHaveLength(0);
  });

  it("rejects an unparseable source before it reaches GitHub", async () => {
    const r = await run("not-a-repo", "--releases");

    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/pack source must be owner\/repo/);
    expect(requests).toHaveLength(0);
  });
});
