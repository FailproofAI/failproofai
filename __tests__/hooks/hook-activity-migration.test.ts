/**
 * Carrying layout 1's decision log into layout 2.
 *
 * The reset deleted `cache/` wholesale, and `cache/hook-activity` lives inside
 * it — so an upgrade silently discarded every decision the machine had ever
 * recorded, which is exactly the data the dashboard's activity tab exists to
 * show.
 *
 * The design rests on ONE property: the collector keys its cursors on
 * `(device, inode)`, so a MOVE keeps a page recognisable and a COPY does not.
 * Most of this file exists to pin that, because it is invisible in the output —
 * a copied log looks identical on disk and re-ships in full.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { migrateHookActivity, resetHome } from "../../src/hooks/fp-reset";
import { hookActivityDir, legacy, resettablePaths, cursorsDir } from "../../src/hooks/fp-home";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-actmig-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

/** A layout-1 activity store with the given files. */
function seedLegacy(files: Record<string, string>) {
  const dir = legacy.hookActivityDir();
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(resolve(dir, name), body, "utf8");
  }
  return dir;
}

const entry = (cmd: string) =>
  JSON.stringify({ timestamp: 1, eventType: "PreToolUse", toolName: "Bash", decision: "deny", cmd }) + "\n";

describe("carrying the log across", () => {
  it("moves every page into the layout-2 directory", () => {
    seedLegacy({
      "page-1000-0.jsonl": entry("a"),
      "page-1000-1.jsonl": entry("b"),
      "current.jsonl": entry("c"),
    });

    const moved = migrateHookActivity();

    expect(moved).toHaveLength(3);
    // Pages, not directory entries: `stats.json` is rebuilt beside them now (see
    // the counters test below), and this assertion is about the log being carried.
    const landed = readdirSync(hookActivityDir()).filter((f) => f.endsWith(".jsonl"));
    expect(landed).toHaveLength(3);
    // Nothing is left behind to be deleted later.
    expect(readdirSync(legacy.hookActivityDir()).filter((f) => f.endsWith(".jsonl"))).toEqual([]);
  });

  it("PRESERVES THE INODE, which is what stops a re-ship", () => {
    // The cursor store keys on (device, inode). A copy would pass every other
    // assertion in this file and still re-ship the entire log.
    const dir = seedLegacy({ "page-1000-0.jsonl": entry("a") });
    const before = statSync(resolve(dir, "page-1000-0.jsonl"));

    migrateHookActivity();

    const after = statSync(resolve(hookActivityDir(), "page-1000-0.jsonl"));
    expect(after.ino).toBe(before.ino);
    expect(after.dev).toBe(before.dev);
  });

  it("keeps the records byte-for-byte", () => {
    const body = entry("a") + entry("b");
    seedLegacy({ "page-1000-0.jsonl": body });

    migrateHookActivity();

    expect(readFileSync(resolve(hookActivityDir(), "page-1000-0.jsonl"), "utf8")).toBe(body);
  });

  it("renames the legacy `current.jsonl` to a page", () => {
    // The destination has its own `current.jsonl`, possibly mid-write. A
    // rotated page is what the store itself would have made of it.
    seedLegacy({ "current.jsonl": entry("legacy-current") });
    mkdirSync(hookActivityDir(), { recursive: true });
    writeFileSync(resolve(hookActivityDir(), "current.jsonl"), entry("live"), "utf8");

    migrateHookActivity();

    // The live file is untouched…
    expect(readFileSync(resolve(hookActivityDir(), "current.jsonl"), "utf8")).toContain("live");
    // …and the legacy one survived under a page name.
    const pages = readdirSync(hookActivityDir()).filter((f) => f.startsWith("page-"));
    expect(pages).toHaveLength(1);
    expect(readFileSync(resolve(hookActivityDir(), pages[0]), "utf8")).toContain("legacy-current");
  });

  it("never overwrites a same-named page", () => {
    // Two layouts can independently produce `page-<ts>-<seq>.jsonl` with the
    // same name. Losing either file is worse than an unfamiliar filename.
    seedLegacy({ "page-1000-0.jsonl": entry("from-legacy") });
    mkdirSync(hookActivityDir(), { recursive: true });
    writeFileSync(resolve(hookActivityDir(), "page-1000-0.jsonl"), entry("already-here"), "utf8");

    migrateHookActivity();

    const bodies = readdirSync(hookActivityDir()).map((f) =>
      readFileSync(resolve(hookActivityDir(), f), "utf8"),
    );
    expect(bodies.some((b) => b.includes("already-here"))).toBe(true);
    expect(bodies.some((b) => b.includes("from-legacy"))).toBe(true);
  });

  it("never COPIES the legacy counters, and rebuilds the stats from the pages", () => {
    // This asserted that `stats.json` simply did not exist afterwards, on the
    // stated grounds that the store would rebuild it. Nothing did: `stats.json` is
    // incremental — one entry folded in per append, never rescanned — so a dropped
    // file read as zeroes and began accumulating from the next event. A user
    // upgrading from a pre-daemon home kept every record and lost every total,
    // which is what this now pins.
    //
    // The original intent still holds and is still tested: the legacy file is NOT
    // copied across (its shape is not even the current one) and `current.count` is
    // not carried. The numbers are recomputed from the pages instead, which is
    // exact because pages are never pruned.
    seedLegacy({
      "page-1000-0.jsonl": entry("a"),
      "current.count": "7",
      "stats.json": JSON.stringify({ total: 7 }),
    });

    const moved = migrateHookActivity();

    expect(moved.every((n) => n.endsWith(".jsonl"))).toBe(true);
    expect(existsSync(resolve(hookActivityDir(), "current.count"))).toBe(false);

    // Present, and NOT the legacy body.
    const statsPath = resolve(hookActivityDir(), "stats.json");
    expect(existsSync(statsPath)).toBe(true);
    const stats = JSON.parse(readFileSync(statsPath, "utf8")) as Record<string, unknown>;
    expect(stats.total).toBeUndefined();
    // Recomputed from the one carried page.
    expect(stats.totalEvents).toBe(1);
  });

  it("the dashboard's totals survive the upgrade, not just the records", () => {
    // The bug as a user hit it: upgrade a pre-daemon home, and the activity list
    // still showed every decision while the summary reported 0 events, 0 denies and
    // no top policy. The records were carried; the totals were not, and nothing
    // recomputed them.
    seedLegacy({
      "page-1000-0.jsonl":
        JSON.stringify({ decision: "deny", policyName: "block-sudo" }) +
        "\n" +
        JSON.stringify({ decision: "allow", policyName: "block-env-files" }) +
        "\n",
      "current.jsonl": JSON.stringify({ decision: "deny", policyName: "block-sudo" }) + "\n",
      "stats.json": JSON.stringify({ totalEvents: 3, denyCount: 2, policyMap: { "block-sudo": 2 } }),
    });

    migrateHookActivity();

    const stats = JSON.parse(
      readFileSync(resolve(hookActivityDir(), "stats.json"), "utf8"),
    ) as { totalEvents: number; denyCount: number; policyMap: Record<string, number> };

    // Recomputed from the carried pages, and equal to what the legacy file said —
    // which is the point: the recount agrees with the incremental total it replaces.
    expect(stats.totalEvents).toBe(3);
    expect(stats.denyCount).toBe(2);
    expect(stats.policyMap["block-sudo"]).toBe(2);
    expect(stats.policyMap["block-env-files"]).toBe(1);
  });

  it("is a no-op with nothing to carry", () => {
    expect(migrateHookActivity()).toEqual([]);
    seedLegacy({});
    expect(migrateHookActivity()).toEqual([]);
  });
});

describe("the reset no longer destroys what it just moved", () => {
  it("keeps the carried log through a full reset", () => {
    // The bug this pins: `hookActivityDir()` was in `resettablePaths()`, and
    // the reset runs that list AFTER the migrations — so the log was moved and
    // then deleted moments later.
    seedLegacy({ "page-1000-0.jsonl": entry("survive-me") });

    const outcome = resetHome(1);

    expect(outcome.activity).toHaveLength(1);
    const bodies = readdirSync(hookActivityDir()).map((f) =>
      readFileSync(resolve(hookActivityDir(), f), "utf8"),
    );
    expect(bodies.some((b) => b.includes("survive-me"))).toBe(true);
  });

  it("keeps the cursors, without which the carried log re-ships anyway", () => {
    mkdirSync(cursorsDir(), { recursive: true });
    writeFileSync(resolve(cursorsDir(), "hooks.json"), '{"files":[]}', "utf8");

    resetHome(1);

    expect(existsSync(resolve(cursorsDir(), "hooks.json"))).toBe(true);
  });

  it("still clears the rest of layout 1's cache", () => {
    // `cache/` is no longer deleted wholesale, so its other children have to be
    // named individually or they silently outlive the reset.
    mkdirSync(legacy.auditCacheDir(), { recursive: true });
    writeFileSync(resolve(legacy.auditCacheDir(), "x.json"), "{}", "utf8");
    mkdirSync(resolve(home, "cache"), { recursive: true });
    writeFileSync(legacy.codexSessionPaths(), "{}", "utf8");

    resetHome(1);

    expect(existsSync(legacy.auditCacheDir())).toBe(false);
    expect(existsSync(legacy.codexSessionPaths())).toBe(false);
  });

  it("no longer lists the activity directory or the cursors as resettable", () => {
    const paths = resettablePaths();
    expect(paths).not.toContain(hookActivityDir());
    expect(paths).not.toContain(cursorsDir());
    // …and still lists something, so a bad edit cannot empty the list silently.
    expect(paths.length).toBeGreaterThan(10);
  });
});
