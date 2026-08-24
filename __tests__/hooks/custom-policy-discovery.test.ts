/**
 * Custom policies load by convention: any file in `.failproofai/policies/`
 * whose name ends in `policies.{js,mjs,ts}`. The trap is that a file which
 * misses that suffix is skipped **silently and completely** — right directory,
 * right exports, zero enforcement, no message. This repo shipped
 * `block-version-bumps.mjs` that way, so a guard written after a bad version
 * bump had never once run.
 *
 * These pin both halves: the files we load, and the near-misses we now report.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { discoverPolicyFiles, findSkippedPolicyFiles } from "../../src/hooks/custom-hooks-loader";
import {
  describeCustomPolicies,
  setCustomPoliciesEnabled,
  reviewLines,
} from "../../src/hooks/configure-wizard";

let dir: string;
let policiesDir: string;

// describeCustomPolicies scans the GLOBAL policies dir (~/.failproofai/policies)
// as well as the project one — correctly, since custom policies really do live
// in both. But that made these tests read the developer's own policy files:
// green on a machine with an empty global dir, eight failures on one with
// personal rules in it. That is the same ambient-state defect this PR fixes for
// the Pi tests in #569, reintroduced one file over.
//
// Pin HOME to a temp dir for the whole file (the pattern configure-wizard.test.ts
// already uses) so the global half is empty and controlled, not inherited.
let fileHome: string;
let realHome: string | undefined;

beforeAll(() => {
  realHome = process.env.HOME;
  fileHome = mkdtempSync(resolve(tmpdir(), "fpai-custom-home-"));
  process.env.HOME = fileHome;
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fileHome, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "fpai-custom-"));
  policiesDir = resolve(dir, ".failproofai", "policies");
  mkdirSync(policiesDir, { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string) => writeFileSync(resolve(policiesDir, name), "// test\n");

describe("custom policy discovery", () => {
  it("loads every accepted extension when the name ends in `policies`", () => {
    write("team-policies.js");
    write("team-policies.mjs");
    write("team-policies.ts");
    expect(discoverPolicyFiles(policiesDir).map((p) => p.split("/").pop()).sort()).toEqual([
      "team-policies.js",
      "team-policies.mjs",
      "team-policies.ts",
    ]);
    expect(findSkippedPolicyFiles(policiesDir)).toEqual([]);
  });

  // The regression this exists for.
  it("reports a script that misses the naming convention instead of ignoring it", () => {
    write("good-policies.mjs");
    write("block-version-bumps.mjs"); // the real-world case

    expect(discoverPolicyFiles(policiesDir).map((p) => p.split("/").pop())).toEqual([
      "good-policies.mjs",
    ]);
    expect(findSkippedPolicyFiles(policiesDir)).toEqual(["block-version-bumps.mjs"]);
  });

  it("ignores non-script files rather than flagging them", () => {
    write("good-policies.mjs");
    write("README.md");
    write("config.json");
    write("types.d.ts"); // a declaration file is not a policy
    expect(findSkippedPolicyFiles(policiesDir)).toEqual([]);
  });

  it("returns empty for a directory that does not exist", () => {
    expect(discoverPolicyFiles(resolve(dir, "nope"))).toEqual([]);
    expect(findSkippedPolicyFiles(resolve(dir, "nope"))).toEqual([]);
  });
});

describe("wizard review screen — custom policies", () => {
  it("counts loadable files so the user sees their own rules were picked up", () => {
    write("a-policies.mjs");
    write("b-policies.mjs");
    const { active, warnings } = describeCustomPolicies(dir);
    expect(active.some((l) => l.includes("2 files (project)"))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("singularises a lone file", () => {
    write("solo-policies.mjs");
    expect(describeCustomPolicies(dir).active.some((l) => l.includes("1 file (project)"))).toBe(true);
  });

  it("warns about a skipped file and names the rename that fixes it", () => {
    write("block-foo.mjs");
    const { warnings } = describeCustomPolicies(dir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("NOT loaded");
    expect(warnings[0]).toContain("block-foo-policies.mjs");
  });

  it("says nothing when there are no custom policies at all", () => {
    // Both halves can be asserted now that HOME is pinned — previously the
    // global half was whatever the developer happened to have on disk.
    const { active, warnings } = describeCustomPolicies(dir);
    expect(active).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("disabling custom policies", () => {
  // Custom policies auto-load, which is right by default but must not be a
  // one-way door — you need a way to switch them off without deleting or
  // renaming your own files.
  it("writes the flag only to turn discovery OFF", () => {
    const cfg = resolve(dir, ".failproofai", "policies-config.json");
    writeFileSync(cfg, JSON.stringify({ enabledPolicies: ["block-sudo"] }), "utf8");

    setCustomPoliciesEnabled("project", dir, false);
    expect(JSON.parse(readFileSync(cfg, "utf8")).customPoliciesEnabled).toBe(false);
  });

  // "Absent means enabled" is the single default, so re-enabling removes the
  // key rather than writing `true` — otherwise two spellings mean the same
  // thing and the file accumulates noise on every run.
  it("removes the flag when re-enabled, rather than writing true", () => {
    const cfg = resolve(dir, ".failproofai", "policies-config.json");
    writeFileSync(cfg, JSON.stringify({ enabledPolicies: [], customPoliciesEnabled: false }), "utf8");

    setCustomPoliciesEnabled("project", dir, true);
    const parsed = JSON.parse(readFileSync(cfg, "utf8"));
    expect("customPoliciesEnabled" in parsed).toBe(false);
  });

  it("preserves the rest of the config", () => {
    const cfg = resolve(dir, ".failproofai", "policies-config.json");
    writeFileSync(
      cfg,
      JSON.stringify({ enabledPolicies: ["block-sudo"], policyParams: { a: { b: 1 } } }),
      "utf8",
    );
    setCustomPoliciesEnabled("project", dir, false);
    const parsed = JSON.parse(readFileSync(cfg, "utf8"));
    expect(parsed.enabledPolicies).toEqual(["block-sudo"]);
    expect(parsed.policyParams).toEqual({ a: { b: 1 } });
  });

  // undefined means "there was nothing to toggle" — don't touch the file.
  it("leaves the config untouched when there is nothing to toggle", () => {
    const cfg = resolve(dir, ".failproofai", "policies-config.json");
    writeFileSync(cfg, JSON.stringify({ enabledPolicies: [], customPoliciesEnabled: false }), "utf8");
    setCustomPoliciesEnabled("project", dir, undefined);
    expect(JSON.parse(readFileSync(cfg, "utf8")).customPoliciesEnabled).toBe(false);
  });
});

describe("the Custom choice is visible to the user", () => {
  // The toggle worked but nothing on screen changed: the review screen said
  // "(auto-loaded)" whether or not custom policies had been switched off. With
  // no feedback anywhere, a working toggle is indistinguishable from a broken
  // one — which is why the review screen has to reflect the DECISION and not
  // merely what is on disk.
  it("review screen says DISABLED when custom policies are switched off", () => {
    write("team-policies.mjs");
    const off = reviewLines({
      target: "project",
      clis: ["claude"],
      policies: [],
      cwd: dir,
      customEnabled: false,
    }).join("\n");
    expect(off).toContain("DISABLED");
    expect(off).not.toContain("(auto-loaded)");
  });

  it("review screen says auto-loaded when custom policies are left on", () => {
    write("team-policies.mjs");
    const on = reviewLines({
      target: "project",
      clis: ["claude"],
      policies: [],
      cwd: dir,
      customEnabled: true,
    }).join("\n");
    expect(on).toContain("(auto-loaded)");
    expect(on).not.toContain("DISABLED");
  });
});
