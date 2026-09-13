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

function restore(name: "OPENCLAW_STATE_DIR" | "OPENCLAW_HOME" | "OPENCLAW_CONFIG_PATH", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("OPENCLAW_STATE_DIR", previousStateDir);
  restore("OPENCLAW_HOME", previousHome);
  restore("OPENCLAW_CONFIG_PATH", previousConfigPath);
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

  it("uses OPENCLAW_HOME when the state override is absent or whitespace", () => {
    const parent = mkdtempSync(join(tmpdir(), "openclaw-home-override-"));
    dirs.push(parent);
    const home = join(parent, ".openclaw");
    process.env.OPENCLAW_STATE_DIR = "   ";
    process.env.OPENCLAW_HOME = `  ${home}  `;
    process.env.OPENCLAW_CONFIG_PATH = join(parent, "ignored", "openclaw.json");

    expect(openclawProfileHome()).toBe(home);
    expect(listOpenClawProfiles()[0]).toEqual({ name: "default", home });
  });

  it("uses OPENCLAW_CONFIG_PATH only after state and home overrides", () => {
    const parent = mkdtempSync(join(tmpdir(), "openclaw-config-override-"));
    dirs.push(parent);
    const configHome = join(parent, "configured");
    process.env.OPENCLAW_STATE_DIR = "";
    process.env.OPENCLAW_HOME = "   ";
    process.env.OPENCLAW_CONFIG_PATH = ` ${join(configHome, "openclaw.json")} `;

    expect(openclawProfileHome()).toBe(configHome);
    expect(listOpenClawProfiles()).toEqual([{ name: "default", home: configHome }]);
  });

  it("keeps state-directory precedence over home and config-path overrides", () => {
    const parent = mkdtempSync(join(tmpdir(), "openclaw-precedence-"));
    dirs.push(parent);
    const stateHome = join(parent, "state");
    process.env.OPENCLAW_STATE_DIR = stateHome;
    process.env.OPENCLAW_HOME = join(parent, "home");
    process.env.OPENCLAW_CONFIG_PATH = join(parent, "config", "openclaw.json");

    expect(openclawProfileHome()).toBe(stateHome);
  });
});
