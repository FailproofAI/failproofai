import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { globalPolicyConfigFile, launcherMarker } from "../../src/hooks/fp-home";

// hasGlobalHooksInstalled walks every real integration and reads real settings
// files. Every test here is about PATHS, not about hook installs, so the
// integration layer is stubbed to "nothing installed" by default and overridden
// where a test is specifically about that signal.
const hooksInstalled = vi.fn(() => false);
vi.mock("../../src/hooks/integrations", () => ({
  INTEGRATION_TYPES: ["claude", "codex"],
  getIntegration: () => ({ hooksInstalledInSettings: hooksInstalled }),
}));

import {
  detectSetupState,
  isConfigured,
  buildTargetChoices,
  findProjectRoot,
  homeify,
  scopesFor,
} from "../../src/hooks/setup-state";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "fpai-setup-state-"));
  home = resolve(root, "home");
  mkdirSync(home, { recursive: true });
  hooksInstalled.mockReturnValue(false);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function writeGlobalConfig() {
  // Layout 2 nests this under policies/local-policies/, so creating
  // <home>/.failproofai alone is no longer enough.
  mkdirSync(dirname(globalPolicyConfigFile(home)), { recursive: true });
  writeFileSync(globalPolicyConfigFile(home), "{}");
}

function makeProject(name: string, withConfig = true): string {
  const dir = resolve(root, name);
  mkdirSync(resolve(dir, ".failproofai"), { recursive: true });
  if (withConfig) {
    writeFileSync(resolve(dir, ".failproofai", "policies-config.json"), "{}");
  }
  return dir;
}

describe("findProjectRoot", () => {
  it("walks up to the nearest .failproofai directory", () => {
    const project = makeProject("api");
    const deep = resolve(project, "src", "handlers");
    mkdirSync(deep, { recursive: true });
    expect(findProjectRoot(deep, home)).toBe(project);
  });

  it("returns the start dir when no marker exists anywhere above", () => {
    const plain = resolve(root, "plain");
    mkdirSync(plain, { recursive: true });
    expect(findProjectRoot(plain, home)).toBe(plain);
  });

  it("stops at home so the global config is never treated as a project root", () => {
    writeGlobalConfig();
    const under = resolve(home, "notes");
    mkdirSync(under, { recursive: true });
    // ~/.failproofai exists, but the walk must stop AT home without claiming it.
    expect(findProjectRoot(under, home)).toBe(under);
  });
});

describe("detectSetupState", () => {
  it("reports a bare machine as nothing configured", () => {
    const state = detectSetupState(root, home);
    expect(state.hasGlobalConfig).toBe(false);
    expect(state.hasProjectConfig).toBe(false);
    expect(state.hasGlobalHooks).toBe(false);
    expect(isConfigured(state)).toBe(false);
  });

  it("detects a global config", () => {
    writeGlobalConfig();
    const state = detectSetupState(root, home);
    expect(state.hasGlobalConfig).toBe(true);
    expect(isConfigured(state)).toBe(true);
  });

  it("detects a project config from a subdirectory of the project", () => {
    const project = makeProject("api");
    const deep = resolve(project, "src");
    mkdirSync(deep, { recursive: true });
    const state = detectSetupState(deep, home);
    expect(state.projectRoot).toBe(project);
    expect(state.hasProjectConfig).toBe(true);
  });

  it("never reports the home directory as a project config", () => {
    // ~/.failproofai/policies-config.json is the GLOBAL config. Counting it as
    // a project config too would offer "Both" for one single file.
    writeGlobalConfig();
    const state = detectSetupState(home, home);
    expect(state.inHomeDir).toBe(true);
    expect(state.hasGlobalConfig).toBe(true);
    expect(state.hasProjectConfig).toBe(false);
  });
});

describe("isConfigured", () => {
  it("is true when only user-scope hooks exist, with no config file", () => {
    // Someone who hand-deleted policies-config.json but still has live hooks
    // is configured; re-onboarding them would be wrong.
    hooksInstalled.mockReturnValue(true);
    expect(isConfigured(detectSetupState(root, home))).toBe(true);
  });

  it("is true when only the legacy marker exists", () => {
    // Users onboarded by an earlier version have the marker and nothing else
    // this function knows about. They must not see the wizard again.
    mkdirSync(dirname(launcherMarker(home)), { recursive: true });
    writeFileSync(launcherMarker(home), "1");
    expect(isConfigured(detectSetupState(root, home))).toBe(true);
  });

  it("is false when only a PROJECT config exists", () => {
    // A checkout carrying committed project config (this repo does) says
    // nothing about whether the machine was ever set up.
    makeProject("api");
    const state = detectSetupState(resolve(root, "api"), home);
    expect(state.hasProjectConfig).toBe(true);
    expect(isConfigured(state)).toBe(false);
  });
});

describe("buildTargetChoices", () => {
  it("offers only the global row when run from home", () => {
    const choices = buildTargetChoices(detectSetupState(home, home));
    expect(choices).toHaveLength(1);
    expect(choices[0].value).toBe("user");
  });

  it("offers only the global row when there is no project above cwd", () => {
    const plain = resolve(root, "plain");
    mkdirSync(plain, { recursive: true });
    const choices = buildTargetChoices(detectSetupState(plain, home));
    // No project marker anywhere: projectRoot === cwd, but there is no project
    // to speak of, so a "this project" row would invent one.
    expect(choices.map((c) => c.value)).toContain("user");
  });

  it("puts the project first when a global config already exists", () => {
    writeGlobalConfig();
    const project = makeProject("api");
    const choices = buildTargetChoices(detectSetupState(project, home));
    expect(choices[0].value).toBe("project");
    expect(choices.map((c) => c.value)).toEqual(["project", "user", "both"]);
  });

  it("puts global first when the machine has never been set up", () => {
    // Configuring one project on an unconfigured machine leaves every other
    // project unprotected — so global leads.
    const project = makeProject("api");
    const choices = buildTargetChoices(detectSetupState(project, home));
    expect(choices[0].value).toBe("user");
  });

  it("labels existing targets as Update and new ones as Set up", () => {
    writeGlobalConfig();
    const project = makeProject("api");
    const choices = buildTargetChoices(detectSetupState(project, home));
    const projectRow = choices.find((c) => c.value === "project")!;
    const globalRow = choices.find((c) => c.value === "user")!;
    expect(projectRow.label).toMatch(/^Update/);
    expect(projectRow.existing).toBe(true);
    expect(globalRow.label).toMatch(/^Update/);

    // A project directory with .failproofai/ but no config file yet is "Set up".
    const fresh = makeProject("fresh", /* withConfig */ false);
    const freshRow = buildTargetChoices(detectSetupState(fresh, home)).find(
      (c) => c.value === "project",
    )!;
    expect(freshRow.label).toMatch(/^Set up/);
    expect(freshRow.existing).toBe(false);
  });
});

describe("symlinked home", () => {
  it("recognises the home directory when reached through a symlink", () => {
    // $HOME is very often a symlink (/home/x -> /mnt/data/x; macOS
    // /tmp -> /private/tmp) while the shell reports the real cwd. Compared
    // lexically the two never match, so `inHomeDir` read false while standing
    // in home — and the wizard then offered to "configure this project"
    // pointing at ~, whose .failproofai/ is the GLOBAL config.
    const linked = resolve(root, "home-link");
    try {
      symlinkSync(home, linked, "dir");
    } catch {
      return; // no symlink support (e.g. some CI filesystems) — nothing to assert
    }
    writeGlobalConfig();

    // HOME given as the symlink, cwd as the real path.
    const state = detectSetupState(home, linked);
    expect(state.inHomeDir).toBe(true);
    expect(state.hasProjectConfig).toBe(false);
    expect(buildTargetChoices(state).map((c) => c.value)).toEqual(["user"]);
  });

  it("does not walk past a symlinked home when looking for a project root", () => {
    const linked = resolve(root, "home-link2");
    try {
      symlinkSync(home, linked, "dir");
    } catch {
      return;
    }
    writeGlobalConfig();
    const under = resolve(home, "notes");
    mkdirSync(under, { recursive: true });
    // Walking up from ~/notes with HOME given as the symlink must still stop
    // at home rather than claiming ~ as a project.
    expect(findProjectRoot(under, linked)).toBe(under);
  });
});

describe("homeify", () => {
  it("collapses the home prefix", () => {
    expect(homeify(resolve(home, "code", "api"), home)).toBe("~/code/api");
    expect(homeify(home, home)).toBe("~");
  });

  it("leaves paths outside home alone", () => {
    expect(homeify("/opt/src", home)).toBe("/opt/src");
  });

  it("does not collapse a sibling directory that merely shares the prefix", () => {
    // `/home/sid` must not be rewritten just because home is `/home/sidd`.
    const sibling = home + "-backup";
    expect(homeify(sibling, home)).toBe(sibling);
  });
});

describe("scopesFor", () => {
  it("expands both to user and project", () => {
    expect(scopesFor("both")).toEqual(["user", "project"]);
    expect(scopesFor("user")).toEqual(["user"]);
    expect(scopesFor("project")).toEqual(["project"]);
  });
});
