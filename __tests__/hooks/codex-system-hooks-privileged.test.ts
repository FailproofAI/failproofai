/**
 * The Codex hook runner and system config as they are written on a real
 * machine: through `sudo -n` (`runPrivileged`, `writePrivilegedFile` in
 * ./daemon-service), not by this process. No real sudo: the privileged helpers
 * are stand-ins that do what root would, as the test user, and record each call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; args: unknown[] }>,
  /** Bytes a write delivers instead of what it was asked to write, per destination. */
  tamper: new Map<string, string>(),
}));
vi.mock("../../src/hooks/daemon-service", () => ({
  canElevate: () => true,
  runPrivileged: (command: string, args: string[]) => {
    root.calls.push({ op: command, args });
    if (command === "install" && args[0] === "-d") {
      mkdirSync(args[3], { recursive: true, mode: 0o755 });
      chmodSync(args[3], 0o755);
    } else if (command === "rm") rmSync(args[1], { force: true });
    else if (command === "rmdir") rmdirSync(args[0]);
    else throw new Error(`unexpected privileged command ${command}`);
  },
  writePrivilegedFile: (destination: string, contents: string, mode: string) => {
    root.calls.push({ op: "write", args: [destination, mode] });
    writeFileSync(destination, root.tamper.get(destination) ?? contents);
    chmodSync(destination, parseInt(mode, 8));
  },
}));

import {
  CODEX_MANAGED_BEGIN,
  codexHookRunnerPath,
  installCodexSystemHooks,
  parseCodexHookRunner,
  removeCodexSystemHooks,
} from "../../src/hooks/codex-system-hooks";
import { codexSystemHookEntries } from "../../src/hooks/integrations";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "fp-codex-privileged-")));
  root.calls.length = 0;
  root.tamper.clear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const path = () => join(dir, "etc", "codex", "config.toml");
const runner = () => codexHookRunnerPath(path())!;
const cli = () => {
  const file = join(dir, "home", "failproofai");
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  chmodSync(dirname(file), 0o755);
  writeFileSync(file, "#!/bin/sh\ntrue\n");
  chmodSync(file, 0o755);
  return file;
};
const deps = () => ({ path: path(), codexVersion: () => "0.162.1", direct: false });
const install = () => installCodexSystemHooks(cli(), codexSystemHookEntries, deps());

describe("the Codex system hooks, written as root", () => {
  it("makes the runner's directory, then writes the runner 0755 and the config 0644, all through root", () => {
    expect(install()).toMatchObject({ ok: true, changed: true });
    expect(root.calls).toEqual([
      { op: "install", args: ["-d", "-m", "0755", dirname(runner())] },
      { op: "write", args: [runner(), "0755"] },
      { op: "write", args: [path(), "0644"] },
    ]);
    expect(readFileSync(path(), "utf8")).toContain(CODEX_MANAGED_BEGIN);
    expect(parseCodexHookRunner(readFileSync(runner(), "utf8"))?.accounts).toHaveLength(1);
  });

  it("takes the block out again when the runner root wrote does not hold what was meant", () => {
    root.tamper.set(runner(), "#!/bin/sh\n# failproofai Codex hook runner\nexec /bin/true\n");
    expect(install()).toMatchObject({
      ok: false,
      reason: "unsafe",
      detail: `${runner()} does not hold what failproofai wrote`,
    });
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runner())).toBe(false);
    expect(root.calls.at(-1)).toEqual({ op: "rm", args: ["-f", runner()] });
  });

  it("judges a directory that is already there as it is, never tightening it first", () => {
    expect(install()).toMatchObject({ ok: true });
    chmodSync(dirname(runner()), 0o775);
    root.calls.length = 0;
    expect(install()).toMatchObject({
      ok: false,
      reason: "unsafe",
      detail: `${dirname(runner())} can be written by accounts other than its owner`,
    });
    expect(root.calls.some((c) => c.op === "install")).toBe(false);
    expect(existsSync(path())).toBe(false);
  });

  it("undoes its own writes when the config root wrote does not hold what was meant", () => {
    root.tamper.set(path(), "something else\n");
    expect(install()).toMatchObject({
      ok: false,
      reason: "unsafe",
      detail: `${path()} does not hold what failproofai wrote`,
    });
    // A config this call created, and the runner it wrote, are both gone.
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runner())).toBe(false);
  });

  it("removes the config it created, then the runner, through root", () => {
    expect(install()).toMatchObject({ ok: true });
    root.calls.length = 0;
    expect(removeCodexSystemHooks(deps())).toMatchObject({ status: "removed", remaining: 0 });
    expect(root.calls).toEqual([
      { op: "rm", args: ["-f", path()] },
      { op: "rm", args: ["-f", runner()] },
    ]);
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runner())).toBe(false);
  });
});
