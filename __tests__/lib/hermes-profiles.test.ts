// @vitest-environment node
//
// Hermes profile discovery. A profile is a whole separate Hermes home dir with
// its own config.yaml + state.db, so getting this wrong means either invisible
// sessions (audit) or unhooked gateways (enforcement) — see lib/hermes-profiles.ts.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const prevHome = process.env.HERMES_HOME;
const prevDbPath = process.env.HERMES_DB_PATH;
const dirs: string[] = [];

function makeRoot(profiles: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "hermes-root-"));
  dirs.push(root);
  writeFileSync(join(root, "config.yaml"), "hooks: {}\n");
  for (const name of profiles) {
    mkdirSync(join(root, "profiles", name), { recursive: true });
  }
  return root;
}

beforeEach(() => {
  delete process.env.HERMES_DB_PATH;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = prevHome;
  if (prevDbPath === undefined) delete process.env.HERMES_DB_PATH;
  else process.env.HERMES_DB_PATH = prevDbPath;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("listHermesProfiles", () => {
  it("returns just the default profile when there is no profiles/ dir", async () => {
    const root = makeRoot();
    process.env.HERMES_HOME = root;
    const { listHermesProfiles } = await import("@/lib/hermes-profiles");
    expect(listHermesProfiles()).toEqual([{ name: "default", home: root }]);
  });

  it("lists the root as `default` first, then each profile dir in name order", async () => {
    const root = makeRoot(["work", "coder"]);
    process.env.HERMES_HOME = root;
    const { listHermesProfiles } = await import("@/lib/hermes-profiles");
    expect(listHermesProfiles().map((p) => p.name)).toEqual(["default", "coder", "work"]);
    expect(listHermesProfiles()[2].home).toBe(join(root, "profiles", "work"));
  });

  it("keeps profile names containing a hyphen intact", async () => {
    const root = makeRoot(["my-bot"]);
    process.env.HERMES_HOME = root;
    const { listHermesProfiles } = await import("@/lib/hermes-profiles");
    expect(listHermesProfiles().map((p) => p.name)).toContain("my-bot");
  });

  it("climbs to the root when HERMES_HOME points AT a profile", async () => {
    // The per-profile alias wrapper exports HERMES_HOME=<root>/profiles/<name>,
    // so discovery must still see every sibling profile.
    const root = makeRoot(["work", "coder"]);
    process.env.HERMES_HOME = join(root, "profiles", "work");
    const { listHermesProfiles, hermesRoot } = await import("@/lib/hermes-profiles");
    expect(hermesRoot()).toBe(root);
    expect(listHermesProfiles().map((p) => p.name)).toEqual(["default", "coder", "work"]);
  });

  it("skips dotfiles and follows symlinked profile dirs", async () => {
    const root = makeRoot(["real"]);
    mkdirSync(join(root, "profiles", ".hidden"), { recursive: true });
    const linkTarget = mkdtempSync(join(tmpdir(), "hermes-linked-"));
    dirs.push(linkTarget);
    symlinkSync(linkTarget, join(root, "profiles", "linked"));
    process.env.HERMES_HOME = root;
    const { listHermesProfiles } = await import("@/lib/hermes-profiles");
    const names = listHermesProfiles().map((p) => p.name);
    expect(names).toContain("real");
    expect(names).toContain("linked");
    expect(names).not.toContain(".hidden");
  });

  it("does not emit a duplicate when a profile dir is literally named `default`", async () => {
    const root = makeRoot(["default"]);
    process.env.HERMES_HOME = root;
    const { listHermesProfiles } = await import("@/lib/hermes-profiles");
    const names = listHermesProfiles().map((p) => p.name);
    expect(names.filter((n) => n === "default")).toHaveLength(1);
    expect(listHermesProfiles()[0].home).toBe(root); // the root wins
  });
});

describe("hermesDbPaths", () => {
  it("resolves one state.db per profile", async () => {
    const root = makeRoot(["work"]);
    process.env.HERMES_HOME = root;
    const { hermesDbPaths } = await import("@/lib/hermes-sessions");
    expect(hermesDbPaths()).toEqual([
      { profile: "default", dbPath: join(root, "state.db") },
      { profile: "work", dbPath: join(root, "profiles", "work", "state.db") },
    ]);
  });

  it("collapses to a single default profile when HERMES_DB_PATH is set", async () => {
    // Back-compat: pointing at a copied/remote state.db must keep working.
    const root = makeRoot(["work"]);
    process.env.HERMES_HOME = root;
    process.env.HERMES_DB_PATH = "/tmp/copied-state.db";
    const { hermesDbPaths } = await import("@/lib/hermes-sessions");
    expect(hermesDbPaths()).toEqual([{ profile: "default", dbPath: "/tmp/copied-state.db" }]);
  });
});
