/**
 * `failproofai update`'s Hermes half, and the linked-plugin install it moves
 * profiles to.
 *
 * Legacy (≤1.0.5) Hermes enforcement is config.yaml shell hooks, which Hermes
 * cron jobs never run — each cron fire builds its own hook scope that only
 * discovered plugins join. `update` never looked at Hermes, so an upgraded
 * machine kept that gap silently. These tests pin the migration, the daemon
 * gate that keeps shell hooks when the plugin could not get verdicts, and the
 * ownership rules for `<profile>/plugins/failproofai`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import {
  hermes,
  hermesProfileHealth,
  hermesProfileStatusRows,
  installHermesPlugin,
  findHermesPluginSourcePath,
} from "../../src/hooks/integrations";
import { runHermesUpdateMigration } from "../../src/hooks/hermes-update";
import { FAILPROOFAI_HOOK_MARKER } from "../../src/hooks/types";

const ORIG_CWD = process.cwd();
const PLUGIN_FILES = ["plugin.yaml", "__init__.py", "client.py", "ledger.py"];

let tempDir: string;
let packageRoot: string;
let source: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "fp-hermes-update-"));
  for (const key of ["HOME", "HERMES_HOME", "FAILPROOFAI_PACKAGE_ROOT"]) saved[key] = process.env[key];
  process.env.HOME = tempDir;
  delete process.env.HERMES_HOME;
  // Bun caches homedir() at startup and would ignore the override, sending
  // every write below into the developer's real ~/.hermes. Refuse instead.
  if (homedir() !== tempDir) {
    throw new Error(`HOME override not honoured (homedir() is ${homedir()}); refusing to run`);
  }
  packageRoot = resolve(tempDir, "npm-global", "failproofai");
  source = resolve(packageRoot, "hermes-plugin");
  cpSync(resolve(ORIG_CWD, "hermes-plugin"), source, { recursive: true });
  process.env.FAILPROOFAI_PACKAGE_ROOT = packageRoot;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function home(profile = "default"): string {
  return profile === "default"
    ? resolve(tempDir, ".hermes")
    : resolve(tempDir, ".hermes", "profiles", profile);
}
function configPath(profile = "default"): string {
  return resolve(home(profile), "config.yaml");
}
function pluginPath(profile = "default"): string {
  return resolve(home(profile), "plugins", "failproofai");
}
function writeConfig(profile: string, body: string): void {
  mkdirSync(home(profile), { recursive: true });
  writeFileSync(configPath(profile), body);
}
interface HermesConfig {
  model?: string;
  plugins?: { enabled?: string[] };
  hooks?: Record<string, Array<{ command: string }> | undefined>;
}
function readConfig(profile = "default"): HermesConfig {
  return parse(readFileSync(configPath(profile), "utf8")) as HermesConfig;
}

/** A ≤1.0.5 install: failproofai shell hooks beside an operator's own hook. */
const LEGACY_CONFIG = [
  "model: gpt-5",
  "hooks_auto_accept: true",
  "hooks:",
  "  pre_tool_call:",
  "    - command: operator-check --tool",
  "    - command: failproofai --hook pre_tool_call --cli hermes",
  "      " + FAILPROOFAI_HOOK_MARKER + ": true",
  "  post_tool_call:",
  "    - command: failproofai --hook post_tool_call --cli hermes",
  "      " + FAILPROOFAI_HOOK_MARKER + ": true",
  "",
].join("\n");

/** A 1.0.6–1.0.8 install: a marked COPY of the plugin, enabled in config. */
function makeManagedCopy(profile = "default"): void {
  writeConfig(profile, "model: gpt-5\nplugins:\n  enabled: [failproofai]\n");
  const dest = pluginPath(profile);
  mkdirSync(dest, { recursive: true });
  for (const file of PLUGIN_FILES) cpSync(resolve(ORIG_CWD, "hermes-plugin", file), resolve(dest, file));
  writeFileSync(resolve(dest, ".failproofai-managed"), "Managed by failproofai.\n");
}

const daemonYes = () => vi.fn(async () => true);
const daemonNo = () => vi.fn(async () => false);

describe("linked Hermes plugin install", () => {
  it("links the profile's plugin dir to the package's hermes-plugin/", () => {
    writeConfig("default", "model: gpt-5\n");
    expect(installHermesPlugin(configPath())).toBe("linked");
    expect(lstatSync(pluginPath()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(pluginPath())).toBe(source);
    // Hermes reads the manifest through the link, exactly as from a directory.
    expect(readFileSync(resolve(pluginPath(), "plugin.yaml"), "utf8")).toMatch(/^name: failproofai$/m);
    expect(installHermesPlugin(configPath())).toBe("unchanged");
  });

  it("an npm upgrade is picked up with no reinstall", () => {
    installHermesPlugin(configPath());
    writeFileSync(resolve(source, "client.py"), "# new release\n");
    expect(readFileSync(resolve(pluginPath(), "client.py"), "utf8")).toBe("# new release\n");
  });

  it("relinks a dangling link left by a removed install prefix", () => {
    const oldPrefix = resolve(tempDir, "old-node", "lib", "node_modules", "failproofai", "hermes-plugin");
    mkdirSync(resolve(home(), "plugins"), { recursive: true });
    symlinkSync(oldPrefix, pluginPath()); // target never existed: dangling
    expect(installHermesPlugin(configPath())).toBe("linked");
    expect(readlinkSync(pluginPath())).toBe(source);
  });

  it("refuses to replace a symlink to somebody else's plugin", () => {
    const other = resolve(tempDir, "operator-plugins", "guard");
    mkdirSync(other, { recursive: true });
    writeFileSync(resolve(other, "plugin.yaml"), "name: guard\n");
    mkdirSync(resolve(home(), "plugins"), { recursive: true });
    symlinkSync(other, pluginPath());

    expect(() => installHermesPlugin(configPath())).toThrow(/Refusing to overwrite an unmanaged Hermes plugin/);
    expect(readlinkSync(pluginPath())).toBe(other);
  });

  it("refuses a link that is named hermes-plugin but is not FailproofAI's", () => {
    const other = resolve(tempDir, "someone-else", "hermes-plugin");
    mkdirSync(other, { recursive: true });
    writeFileSync(resolve(other, "plugin.yaml"), "name: another-plugin\n");
    mkdirSync(resolve(home(), "plugins"), { recursive: true });
    symlinkSync(other, pluginPath());

    expect(() => installHermesPlugin(configPath())).toThrow(/Refusing to overwrite/);
    expect(readlinkSync(pluginPath())).toBe(other);
  });

  it("falls back to a marked copy when a symlink cannot be created", () => {
    writeConfig("default", "model: gpt-5\n");
    const symlink = () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    };
    expect(installHermesPlugin(configPath(), { symlink })).toBe("copied");
    expect(lstatSync(pluginPath()).isDirectory()).toBe(true);
    expect(existsSync(resolve(pluginPath(), ".failproofai-managed"))).toBe(true);
    for (const file of PLUGIN_FILES) expect(existsSync(resolve(pluginPath(), file))).toBe(true);

    const settings = hermes.readSettings(configPath());
    hermes.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    hermes.writeSettings(configPath(), settings);
    expect(hermesProfileHealth()[0]).toMatchObject({ pluginMode: "copy", healthy: true });
    expect(hermesProfileStatusRows()[0][1]).toMatch(/^native plugin enabled \(copied/);
  });

  it("uninstall removes the link and never the package directory", () => {
    writeConfig("default", "model: gpt-5\n");
    hermes.prepareInstall!(configPath());
    const settings = hermes.readSettings(configPath());
    hermes.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    hermes.writeSettings(configPath(), settings);

    expect(hermes.removeHooksFromFile(configPath())).toBe(2);
    expect(existsSync(pluginPath())).toBe(false);
    expect(() => lstatSync(pluginPath())).toThrow();
    for (const file of PLUGIN_FILES) expect(existsSync(resolve(source, file))).toBe(true);
    expect(readConfig().plugins).toBeUndefined();
  });

  it("uninstall still removes an old managed copy", () => {
    makeManagedCopy();
    expect(hermes.removeHooksFromFile(configPath())).toBe(2);
    expect(existsSync(pluginPath())).toBe(false);
  });
});

describe("Hermes health flags legacy shell hooks", () => {
  it("a profile only on shell hooks is unhealthy because cron is unchecked", () => {
    writeConfig("default", LEGACY_CONFIG);
    expect(hermesProfileHealth()[0]).toMatchObject({
      legacyShellHookPresent: true,
      cronUnchecked: true,
      healthy: false,
      pluginMode: null,
    });
    expect(hermesProfileStatusRows()).toEqual([
      [
        "hermes/default",
        "UNHEALTHY — legacy shell hooks: Hermes cron jobs are not checked. Run `failproofai update`",
      ],
    ]);
  });
});

describe("failproofai update → Hermes migration", () => {
  it("migrates a legacy shell-hook profile to the linked plugin, keeping operator hooks", async () => {
    writeConfig("default", LEGACY_CONFIG);
    const probe = daemonYes();
    const result = await runHermesUpdateMigration({ daemonSupportsPolicyEvaluation: probe });

    expect(result.ok).toBe(true);
    expect(result.profiles[0]).toMatchObject({ status: "migrated", detail: "shell hooks → linked plugin" });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(readlinkSync(pluginPath())).toBe(source);
    const config = readConfig();
    expect(config.plugins?.enabled).toEqual(["failproofai"]);
    expect(config.hooks?.pre_tool_call).toEqual([{ command: "operator-check --tool" }]);
    expect(config.hooks?.post_tool_call).toBeUndefined();
    expect(config.model).toBe("gpt-5");
    expect(hermesProfileHealth()[0]).toMatchObject({ healthy: true, pluginMode: "link" });
    expect(result.lines.join("\n")).toMatch(/hermes\/default\s+migrated — shell hooks → linked plugin/);
    expect(result.lines.join("\n")).toMatch(/Cron jobs load the plugin on their next run/);
  });

  it("migrates a copied plugin (1.0.6–1.0.8) to the link", async () => {
    makeManagedCopy();
    const result = await runHermesUpdateMigration({ daemonSupportsPolicyEvaluation: daemonYes() });
    expect(result.ok).toBe(true);
    expect(result.profiles[0]).toMatchObject({ status: "migrated", detail: "copied plugin → linked plugin" });
    expect(lstatSync(pluginPath()).isSymbolicLink()).toBe(true);
    expect(readConfig().plugins?.enabled).toEqual(["failproofai"]);
  });

  it("leaves profiles without any failproofai integration alone and asks the daemon nothing", async () => {
    writeConfig("default", "model: gpt-5\n");
    writeConfig("work", "model: other\nplugins:\n  enabled: [operator-plugin]\n");
    const before = readFileSync(configPath("work"), "utf8");
    const probe = daemonYes();
    const result = await runHermesUpdateMigration({ daemonSupportsPolicyEvaluation: probe });

    expect(result).toMatchObject({ ok: true, lines: [] });
    expect(result.profiles.map((p) => p.status)).toEqual(["untouched", "untouched"]);
    expect(probe).not.toHaveBeenCalled();
    expect(readFileSync(configPath("work"), "utf8")).toBe(before);
    expect(existsSync(pluginPath("work"))).toBe(false);
    expect(existsSync(pluginPath())).toBe(false);
  });

  it("migrates only the profiles that use failproofai", async () => {
    writeConfig("default", LEGACY_CONFIG);
    writeConfig("work", "model: other\n");
    const result = await runHermesUpdateMigration({ daemonSupportsPolicyEvaluation: daemonYes() });
    expect(result.profiles.map((p) => [p.name, p.status])).toEqual([
      ["default", "migrated"],
      ["work", "untouched"],
    ]);
    expect(existsSync(pluginPath("work"))).toBe(false);
    expect(result.lines.join("\n")).toMatch(/hermes\/work\s+skipped — no failproofai integration/);
  });

  it("reports an already-linked profile as current without probing the daemon", async () => {
    writeConfig("default", "model: gpt-5\n");
    hermes.prepareInstall!(configPath());
    const settings = hermes.readSettings(configPath());
    hermes.writeHookEntries(settings, "/usr/bin/failproofai", "user");
    hermes.writeSettings(configPath(), settings);

    const probe = daemonYes();
    const result = await runHermesUpdateMigration({ daemonSupportsPolicyEvaluation: probe });
    expect(result.ok).toBe(true);
    expect(result.profiles[0].status).toBe("current");
    expect(probe).not.toHaveBeenCalled();
    expect(result.lines.join("\n")).toMatch(/hermes\/default\s+already current/);
  });

  it("keeps the shell hooks and fails when the daemon cannot do policyEvaluation", async () => {
    writeConfig("default", LEGACY_CONFIG);
    makeManagedCopy("work");
    const legacyBefore = readFileSync(configPath(), "utf8");
    const probe = daemonNo();
    const result = await runHermesUpdateMigration({ daemonSupportsPolicyEvaluation: probe });

    expect(result.ok).toBe(false); // → `failproofai update` exits 1
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.profiles.map((p) => [p.name, p.status, p.legacyShellHooksRemain])).toEqual([
      ["default", "blocked", true],
      ["work", "blocked", false],
    ]);
    // Nothing changed anywhere: the hooks are the only enforcement left.
    expect(readFileSync(configPath(), "utf8")).toBe(legacyBefore);
    expect(existsSync(pluginPath())).toBe(false);
    expect(lstatSync(pluginPath("work")).isDirectory()).toBe(true);
    const text = result.lines.join("\n");
    expect(text).toMatch(/hermes\/default\s+NOT migrated — daemon lacks native policy evaluation; shell hooks left in place/);
    expect(text).toMatch(/Hermes is NOT migrated/);
    expect(text).toMatch(/failproofai config/);
  });

  it("fails without touching hooks when an unmanaged plugin holds the name", async () => {
    writeConfig("default", LEGACY_CONFIG);
    mkdirSync(pluginPath(), { recursive: true });
    writeFileSync(resolve(pluginPath(), "plugin.yaml"), "name: operator-owned\n");
    const before = readFileSync(configPath(), "utf8");

    const result = await runHermesUpdateMigration({ daemonSupportsPolicyEvaluation: daemonYes() });
    expect(result.ok).toBe(false);
    expect(result.profiles[0]).toMatchObject({ status: "failed", legacyShellHooksRemain: true });
    expect(result.profiles[0].detail).toMatch(/unmanaged plugin occupies/);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(readFileSync(resolve(pluginPath(), "plugin.yaml"), "utf8")).toBe("name: operator-owned\n");
  });

  it("never rewrites a config.yaml that does not parse", async () => {
    const broken = LEGACY_CONFIG + "  bad: [unclosed\n";
    writeConfig("default", broken);
    const result = await runHermesUpdateMigration({ daemonSupportsPolicyEvaluation: daemonYes() });
    expect(result.ok).toBe(false);
    expect(result.profiles[0].status).toBe("failed");
    expect(readFileSync(configPath(), "utf8")).toBe(broken);
    expect(existsSync(pluginPath())).toBe(false);
  });

  it("uses the copy fallback during migration when links are impossible", async () => {
    writeConfig("default", LEGACY_CONFIG);
    const symlink = () => {
      throw new Error("EPERM");
    };
    const result = await runHermesUpdateMigration({
      daemonSupportsPolicyEvaluation: daemonYes(),
      installDeps: { symlink },
    });
    expect(result.ok).toBe(true);
    expect(result.profiles[0].detail).toBe("shell hooks → plugin copy (symlink not possible here)");
    expect(existsSync(resolve(pluginPath(), ".failproofai-managed"))).toBe(true);
    expect(readConfig().hooks?.pre_tool_call).toEqual([{ command: "operator-check --tool" }]);
  });
});

describe("findHermesPluginSourcePath — the package root from any layout", () => {
  let pkg: string;
  beforeEach(() => {
    pkg = mkdtempSync(join(tmpdir(), "fpai-pkgroot-"));
    mkdirSync(join(pkg, "hermes-plugin"), { recursive: true });
    writeFileSync(join(pkg, "hermes-plugin", "plugin.yaml"), "name: failproofai\n");
    mkdirSync(join(pkg, "src", "hooks"), { recursive: true });
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, ".next", "standalone", "server", "chunks"), { recursive: true });
  });
  afterEach(() => rmSync(pkg, { recursive: true, force: true }));

  it("finds it from the source tree (src/hooks)", () => {
    expect(findHermesPluginSourcePath(join(pkg, "src", "hooks"))).toBe(resolve(pkg, "hermes-plugin"));
  });

  it("finds it from the bundled CLI (dist/), where three parents would overshoot", () => {
    expect(findHermesPluginSourcePath(join(pkg, "dist"))).toBe(resolve(pkg, "hermes-plugin"));
  });

  it("finds it from the dashboard's standalone build", () => {
    expect(findHermesPluginSourcePath(join(pkg, ".next", "standalone", "server", "chunks"))).toBe(
      resolve(pkg, "hermes-plugin"),
    );
  });

  it("with no plugin anywhere above, answers a path that does not exist so install fails loudly", () => {
    rmSync(join(pkg, "hermes-plugin"), { recursive: true, force: true });
    expect(existsSync(findHermesPluginSourcePath(join(pkg, "src", "hooks")))).toBe(false);
  });
});
