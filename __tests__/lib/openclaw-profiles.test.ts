// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listOpenClawProfiles, openclawProfileHome } from "../../lib/openclaw-profiles";

const previousStateDir = process.env.OPENCLAW_STATE_DIR;
const previousHome = process.env.OPENCLAW_HOME;
const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
const dirs: string[] = [];

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = previousStateDir;
  if (previousHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = previousHome;
  if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
  else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("OpenClaw profile discovery", () => {
  it("lists default plus valid named sibling profiles", () => {
    const parent = mkdtempSync(join(tmpdir(), "openclaw-profiles-"));
    dirs.push(parent);
    process.env.OPENCLAW_STATE_DIR = join(parent, ".openclaw");
    delete process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_CONFIG_PATH;

    for (const name of ["research", "operations"]) {
      const home = join(parent, `.openclaw-${name}`);
      mkdirSync(home);
      writeFileSync(join(home, "openclaw.json"), "{}\n");
    }
    mkdirSync(join(parent, ".openclaw-backup"));

    expect(listOpenClawProfiles()).toEqual([
      { name: "default", home: join(parent, ".openclaw") },
      { name: "operations", home: join(parent, ".openclaw-operations") },
      { name: "research", home: join(parent, ".openclaw-research") },
    ]);
  });

  it("uses an explicit non-standard state directory without scanning siblings", () => {
    const home = mkdtempSync(join(tmpdir(), "custom-openclaw-home-"));
    dirs.push(home);
    process.env.OPENCLAW_STATE_DIR = home;
    delete process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_CONFIG_PATH;

    expect(openclawProfileHome()).toBe(home);
    expect(listOpenClawProfiles()).toEqual([{ name: "default", home }]);
  });
});
