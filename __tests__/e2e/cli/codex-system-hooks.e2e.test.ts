/**
 * E2E: user-scope Codex hooks go to Codex's system config, through the real binary.
 *
 * Codex runs a `~/.codex/hooks.json` hook only once a person has trusted it,
 * but runs hooks from its system config as managed. Each test gets its own
 * HOME, FAILPROOFAI_HOME and a temp "system config" (FAILPROOFAI_CODEX_SYSTEM_CONFIG),
 * plus a fake `codex` on PATH that reports a version, so nothing here reaches
 * /etc or needs sudo or a real Codex.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARY_PATH = resolve(REPO_ROOT, "bin/failproofai.mjs");
const BEGIN = "# >>> failproofai managed hooks >>>";

let root: string;
let home: string;
let fakeBin: string;
let systemConfig: string;

function fakeCodex(version: string): void {
  const script = join(fakeBin, "codex");
  writeFileSync(script, `#!/bin/sh\necho "codex-cli ${version}"\n`);
  chmodSync(script, 0o755);
}

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("bun", [BINARY_PATH, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      FAILPROOFAI_HOME: join(home, ".failproofai"),
      FAILPROOFAI_PACK_DIR: join(root, "packs"),
      FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH,
      FAILPROOFAI_TELEMETRY_DISABLED: "1",
      FAILPROOFAI_CODEX_SYSTEM_CONFIG: systemConfig,
      PATH: `${fakeBin}:${process.env.PATH}`,
      NO_COLOR: "1",
      ...env,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const hooksJson = () => join(home, ".codex", "hooks.json");
const codexHooksInUserFile = (): number => {
  if (!existsSync(hooksJson())) return 0;
  const hooks = (JSON.parse(readFileSync(hooksJson(), "utf8")) as { hooks?: Record<string, Array<{ hooks: unknown[] }>> }).hooks ?? {};
  return Object.values(hooks).flat().reduce((n, group) => n + group.hooks.length, 0);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fp-e2e-codex-system-"));
  home = join(root, "home");
  fakeBin = join(root, "bin");
  systemConfig = join(root, "etc", "codex", "config.toml");
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  fakeCodex("0.162.1");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("E2E: Codex hooks in the system config", () => {
  it("installs into the system config, keeps what was there, and moves hooks out of hooks.json", () => {
    mkdirSync(dirname(systemConfig), { recursive: true });
    const original = '# set by the admin\napproval_policy = "never"\n';
    writeFileSync(systemConfig, original);
    // An older install's entries in hooks.json, next to someone else's hook.
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      hooksJson(),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "/old/failproofai --hook pre_tool_use --cli codex", __failproofai_hook__: true }] },
            { hooks: [{ type: "command", command: "my-own-hook" }] },
          ],
        },
      }),
    );

    const installed = run(["policies", "--install", "--cli", "codex"]);
    expect(installed.exitCode, installed.stderr).toBe(0);
    expect(installed.stdout).toContain("OpenAI Codex hooks installed");
    expect(installed.stdout).toContain(systemConfig);
    expect(installed.stdout).not.toContain("trusted");

    const written = readFileSync(systemConfig, "utf8");
    expect(written.startsWith(original)).toBe(true);
    expect(written).toContain(BEGIN);
    expect(written).toContain("[[hooks.PreToolUse.hooks]]");
    expect(written).toContain(`--hook pre_tool_use --cli codex`);
    // Ours are gone from hooks.json; the user's own hook stays.
    expect(codexHooksInUserFile()).toBe(1);
    expect(readFileSync(hooksJson(), "utf8")).toContain("my-own-hook");

    // Idempotent.
    expect(run(["policies", "--install", "--cli", "codex"]).exitCode).toBe(0);
    expect(readFileSync(systemConfig, "utf8")).toBe(written);

    const removed = run(["policies", "--uninstall", "--cli", "codex"]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.stdout).toContain("from Codex's system config");
    expect(readFileSync(systemConfig, "utf8")).toBe(original);
  });

  it("deletes a system config it created when the hooks are removed", () => {
    expect(run(["policies", "--install", "--cli", "codex"]).exitCode).toBe(0);
    expect(existsSync(systemConfig)).toBe(true);
    expect(codexHooksInUserFile()).toBe(0);
    expect(run(["policies", "--uninstall", "--cli", "codex"]).exitCode).toBe(0);
    expect(existsSync(systemConfig)).toBe(false);
  });

  it("without a system config, keeps hooks.json and warns that Codex won't run them untrusted", () => {
    const installed = run(["policies", "--install", "--cli", "codex"], { FAILPROOFAI_CODEX_SYSTEM_CONFIG: "off" });
    expect(installed.exitCode, installed.stderr).toBe(0);
    expect(codexHooksInUserFile()).toBeGreaterThan(0);
    expect(installed.stdout).toContain("Codex won't run failproofai's hooks until they're trusted.");
    expect(installed.stdout).toContain("open  codex  once and approve the hooks");
  });

  it("keeps hooks.json, with no warning, for a Codex that predates hook trust", () => {
    fakeCodex("0.128.0");
    const installed = run(["policies", "--install", "--cli", "codex"]);
    expect(installed.exitCode, installed.stderr).toBe(0);
    expect(existsSync(systemConfig)).toBe(false);
    expect(codexHooksInUserFile()).toBeGreaterThan(0);
    expect(installed.stdout).not.toContain("trusted");
  });
});
