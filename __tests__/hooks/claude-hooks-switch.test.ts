import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CLAUDE_MANAGED_SETTINGS_PATHS,
  claudeHooksSwitchedOffBy,
  claudeLocalSettingsPaths,
  claudeSettingsLayersByPrecedence,
} from "../../src/hooks/claude-hooks-switch";
import {
  claudeHooksSwitchedOff,
  gatherStatusFacts,
  pickStatusAttention,
  renderStatusScreen,
  type StatusFacts,
} from "../../src/hooks/config-status";
import { FAILPROOFAI_HOOK_MARKER } from "../../src/hooks/types";

/**
 * #1794: `"disableAllHooks": true` in any Claude Code settings layer turns off
 * every hook in the session, and nothing in failproofai read the key — so a
 * machine whose agent had set it still reported itself as enforcing.
 */
describe("claudeHooksSwitchedOffBy — Claude Code's precedence", () => {
  const files = (contents: Record<string, unknown>) => (path: string) => {
    if (!(path in contents)) throw new Error("ENOENT");
    const body = contents[path];
    return typeof body === "string" ? body : JSON.stringify(body);
  };
  const layers = ["/managed.json", "/p/.claude/settings.local.json", "/p/.claude/settings.json", "/h/.claude/settings.json"];

  it("names the user settings when they switch hooks off", () => {
    expect(claudeHooksSwitchedOffBy(layers, files({ "/h/.claude/settings.json": { disableAllHooks: true } }))).toBe(
      "/h/.claude/settings.json",
    );
  });

  it("names a project's local settings, which override the user's", () => {
    const read = files({
      "/h/.claude/settings.json": { hooks: {} },
      "/p/.claude/settings.local.json": { disableAllHooks: true },
    });
    expect(claudeHooksSwitchedOffBy(layers, read)).toBe("/p/.claude/settings.local.json");
  });

  it("lets a false higher up win over a true below it", () => {
    const read = files({ "/p/.claude/settings.json": { disableAllHooks: false }, "/h/.claude/settings.json": { disableAllHooks: true } });
    expect(claudeHooksSwitchedOffBy(layers, read)).toBeNull();
    expect(claudeHooksSwitchedOffBy(layers, files({ "/managed.json": { disableAllHooks: false }, "/p/.claude/settings.local.json": { disableAllHooks: true } }))).toBeNull();
  });

  it("skips a missing, unparseable or non-object file, and a non-boolean value", () => {
    const read = files({
      "/managed.json": "{not json",
      "/p/.claude/settings.local.json": [1, 2],
      "/p/.claude/settings.json": { disableAllHooks: "true" },
      "/h/.claude/settings.json": { disableAllHooks: true },
    });
    expect(claudeHooksSwitchedOffBy(layers, read)).toBe("/h/.claude/settings.json");
    expect(claudeHooksSwitchedOffBy(layers, files({}))).toBeNull();
  });

  it("orders the layers managed, local, project, user", () => {
    expect(claudeSettingsLayersByPrecedence({ user: "u", project: "p", local: "l" }, "/m.json")).toEqual(["/m.json", "l", "p", "u"]);
    expect(claudeSettingsLayersByPrecedence({ user: "u", project: "p", local: ["l1", "l2"] }, null)).toEqual(["l1", "l2", "p", "u"]);
  });

  it("reads the managed file where Claude Code keeps it, Windows included", () => {
    expect(CLAUDE_MANAGED_SETTINGS_PATHS.linux).toBe("/etc/claude-code/managed-settings.json");
    expect(CLAUDE_MANAGED_SETTINGS_PATHS.darwin).toBe("/Library/Application Support/ClaudeCode/managed-settings.json");
    const windows = CLAUDE_MANAGED_SETTINGS_PATHS.win32!;
    expect(windows).toBe("C:\\Program Files\\ClaudeCode\\managed-settings.json");
    const scopes = { user: "/h/.claude/settings.json", project: "/p/.claude/settings.json", local: "/p/.claude/settings.local.json" };
    const layers = claudeSettingsLayersByPrecedence(scopes, windows);
    expect(claudeHooksSwitchedOffBy(layers, files({ [windows]: { disableAllHooks: true } }))).toBe(windows);
  });
});

describe("config --status — disableAllHooks", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["HOME", "CLAUDE_CONFIG_DIR", "FAILPROOFAI_HOME"] as const;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fpai-claude-switch-"));
    for (const key of ENV) saved[key] = process.env[key];
    process.env.HOME = join(dir, "home");
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.FAILPROOFAI_HOME = join(dir, "home", ".failproofai");
    mkdirSync(process.env.FAILPROOFAI_HOME, { recursive: true });
  });

  afterEach(() => {
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (path: string, body: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body));
  };
  // Never the host's managed file: a machine whose policy sets the key would
  // decide these assertions.
  const managed = () => join(dir, "managed-settings.json");
  const ourHooks = {
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: "/bin/failproofai --hook PreToolUse", [FAILPROOFAI_HOOK_MARKER]: true }] }],
    },
  };

  it("reports the file that switches failproofai's installed Claude hooks off", () => {
    const project = join(dir, "project");
    put(join(dir, "home", ".claude", "settings.json"), ourHooks);
    put(join(project, ".claude", "settings.local.json"), { disableAllHooks: true });
    expect(claudeHooksSwitchedOff(project, managed())).toBe(join(project, ".claude", "settings.local.json"));
  });

  it("says nothing when failproofai has no Claude hooks to switch off", () => {
    const project = join(dir, "project");
    put(join(dir, "home", ".claude", "settings.json"), { disableAllHooks: true });
    expect(claudeHooksSwitchedOff(project, managed())).toBeNull();
  });

  it("says nothing while the hooks are on", () => {
    const project = join(dir, "project");
    put(join(dir, "home", ".claude", "settings.json"), { ...ourHooks, disableAllHooks: false });
    expect(claudeHooksSwitchedOff(project, managed())).toBeNull();
  });

  it("lets a managed file decide, in either direction", () => {
    const project = join(dir, "project");
    put(join(dir, "home", ".claude", "settings.json"), ourHooks);
    put(join(project, ".claude", "settings.local.json"), { disableAllHooks: true });
    put(managed(), { disableAllHooks: false });
    expect(claudeHooksSwitchedOff(project, managed())).toBeNull();
    put(managed(), { disableAllHooks: true });
    expect(claudeHooksSwitchedOff(project, managed())).toBe(managed());
  });

  // Windows keeps the file where the session started; that case injects "win32" below.
  it.skipIf(process.platform === "win32")("reads a repository's local settings at its root when run from a subdirectory", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    put(join(dir, "home", ".claude", "settings.json"), ourHooks);
    put(join(repo, ".claude", "settings.local.json"), { disableAllHooks: true });
    expect(claudeHooksSwitchedOff(join(repo, "src"), managed())).toBe(join(repo, ".claude", "settings.local.json"));
  });

  it("still reads one an older Claude Code left in the starting directory", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    put(join(dir, "home", ".claude", "settings.json"), ourHooks);
    put(join(repo, "src", ".claude", "settings.local.json"), { disableAllHooks: true });
    expect(claudeHooksSwitchedOff(join(repo, "src"), managed())).toBe(join(repo, "src", ".claude", "settings.local.json"));
  });

  it.skipIf(process.platform === "win32")("finds hooks installed only in the repository root's local file", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    put(join(repo, ".claude", "settings.local.json"), { ...ourHooks, disableAllHooks: true });
    expect(claudeHooksSwitchedOff(join(repo, "src"), managed())).toBe(join(repo, ".claude", "settings.local.json"));
  });

  it.skipIf(process.platform === "win32")("reads a worktree's local settings at the main checkout's root", () => {
    const main = join(dir, "main");
    const worktree = join(dir, "wt");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    put(join(dir, "home", ".claude", "settings.json"), ourHooks);
    put(join(main, ".claude", "settings.local.json"), { disableAllHooks: true });
    expect(claudeHooksSwitchedOff(join(worktree, "src"), managed())).toBe(join(main, ".claude", "settings.local.json"));
  });

  it("lets the last managed-settings.d fragment decide over the base file", () => {
    const project = join(dir, "project");
    const fragments = join(dir, "managed-settings.d");
    put(join(dir, "home", ".claude", "settings.json"), ourHooks);
    put(managed(), { disableAllHooks: false });
    put(join(fragments, "10-hooks.json"), { disableAllHooks: true });
    expect(claudeHooksSwitchedOff(project, managed())).toBe(join(fragments, "10-hooks.json"));
    put(join(fragments, "20-later.json"), { disableAllHooks: false });
    put(join(fragments, ".hidden.json"), { disableAllHooks: true });
    expect(claudeHooksSwitchedOff(project, managed())).toBeNull();
  });

  it("keeps it in the starting directory on Windows and when the repository is the home directory", () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".git"), { recursive: true });
    mkdirSync(join(home, "notes"), { recursive: true });
    const here = join(home, "notes", ".claude", "settings.local.json");
    expect(claudeLocalSettingsPaths(join(home, "notes"), "linux", home)).toEqual([here]);
    expect(claudeLocalSettingsPaths(join(home, "notes"), "win32", join(dir, "elsewhere"))).toEqual([here]);
    expect(claudeLocalSettingsPaths(join(home, "notes"), "linux", join(dir, "elsewhere"))).toEqual([
      join(home, ".claude", "settings.local.json"),
      here,
    ]);
  });

  it("carries the finding into the status facts through its seam", async () => {
    const f = await gatherStatusFacts({
      now: 0,
      cwd: join(dir, "project"),
      daemonStatus: () => "not-installed",
      daemonAnswering: () => false,
      detectInstalled: () => ["claude"],
      notEnforcing: () => null,
      codexTrust: () => ({ kind: "none" }),
      claudeHooksOff: () => "/p/.claude/settings.local.json",
    });
    expect(f.claudeHooksOff).toEqual({ path: "/p/.claude/settings.local.json" });
    const quiet = await gatherStatusFacts({
      now: 0,
      cwd: join(dir, "project"),
      daemonStatus: () => "not-installed",
      daemonAnswering: () => false,
      detectInstalled: () => ["claude"],
      notEnforcing: () => null,
      codexTrust: () => ({ kind: "none" }),
      claudeHooksOff: () => null,
    });
    expect(quiet.claudeHooksOff).toBeUndefined();
  });

  const base = (over: Partial<StatusFacts> = {}): StatusFacts => ({
    now: 0,
    daemon: {
      supported: true,
      platform: "linux",
      service: "running",
      answering: true,
      configured: true,
      version: "1.0.0",
      skew: null,
      checkCommand: null,
    },
    pauses: [],
    cloud: { kind: "none" },
    agents: { traced: 1, notInstalled: 0 },
    policies: {
      packOn: 10,
      firstPack: "FailproofAI/policies@1.0.0",
      morePacks: 0,
      cloudOn: 0,
      observing: 0,
      customFiles: 0,
      legacy: 0,
      refusedPacks: 0,
      packsInstalled: 1,
    },
    notEnforcing: null,
    ...over,
  });
  const PLAIN = { version: "1.0.0", cols: 120, color: false };

  it("shows a claude row and a failing attention line", () => {
    const facts = base({ claudeHooksOff: { path: "/p/.claude/settings.local.json" } });
    const screen = renderStatusScreen(facts, PLAIN).join("\n");
    expect(screen).toMatch(/claude\s+○ Not enforcing: disableAllHooks in \/p\/\.claude\/settings\.local\.json/);
    expect(pickStatusAttention(facts)).toEqual({
      severity: "fail",
      text: "Claude Code is running none of failproofai's hooks: disableAllHooks is true.",
      detail: 'Remove "disableAllHooks" from /p/.claude/settings.local.json.',
    });
  });

  it("ranks it above 'not enforcing yet', below a daemon that denies everything", () => {
    const off = { claudeHooksOff: { path: "/h/.claude/settings.json" } };
    expect(pickStatusAttention(base({ ...off, notEnforcing: "no-policies" }))?.text).toMatch(/disableAllHooks/);
    const down = base({ ...off, daemon: { ...base().daemon, answering: false } });
    expect(pickStatusAttention(down)?.text).toMatch(/failproofaid is not answering/);
  });

  it("shows no claude row while the hooks are on", () => {
    expect(renderStatusScreen(base(), PLAIN).join("\n")).not.toMatch(/^\s*claude\s/m);
    expect(pickStatusAttention(base())).toBeNull();
  });
});
