// @vitest-environment node
/**
 * Writing an agent's config must never leave it half-written.
 *
 * These files belong to the user's agent (Hermes, Claude Code, OpenClaw, …);
 * a truncated one is an agent that will not start. So every case here is about
 * what the live file looks like when something goes wrong part-way.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  existsSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfigFileAtomic, configBackupPath, DanglingConfigSymlinkError } from "../../src/hooks/safe-config-write";
import { claudeCode, hermes, UnreadableAgentConfigError } from "../../src/hooks/integrations";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fpai-safe-write-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const leftovers = () => readdirSync(dir).filter((f) => f.includes(".failproofai-") && f.endsWith(".tmp"));

describe("writeConfigFileAtomic", () => {
  it("writes a new file and leaves no temporary file or backup behind", () => {
    const p = join(dir, "config.yaml");
    writeConfigFileAtomic(p, "a: 1\n");
    expect(readFileSync(p, "utf8")).toBe("a: 1\n");
    expect(leftovers()).toEqual([]);
    expect(() => statSync(configBackupPath(p))).toThrow();
  });

  it("keeps the previous version as <name>.failproofai-backup", () => {
    const p = join(dir, "config.yaml");
    writeFileSync(p, "model: gpt-6-luna\n");
    writeConfigFileAtomic(p, "model: gpt-6-luna\nplugins: {}\n");
    expect(readFileSync(configBackupPath(p), "utf8")).toBe("model: gpt-6-luna\n");
    expect(readFileSync(p, "utf8")).toBe("model: gpt-6-luna\nplugins: {}\n");
  });

  it("keeps the file's permission bits (Hermes keeps config.yaml at 0600)", () => {
    const p = join(dir, "config.yaml");
    writeFileSync(p, "a: 1\n");
    chmodSync(p, 0o600);
    writeConfigFileAtomic(p, "a: 2\n");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(configBackupPath(p)).mode & 0o777).toBe(0o600);
  });

  it("an interruption before the swap leaves the live file exactly as it was", () => {
    const p = join(dir, "config.yaml");
    writeFileSync(p, "model: gpt-6-luna\napi_key: ${KEY}\n");
    expect(() =>
      writeConfigFileAtomic(p, "plugins: {}\n", {
        rename: () => {
          throw new Error("killed mid-write");
        },
      }),
    ).toThrow("killed mid-write");
    expect(readFileSync(p, "utf8")).toBe("model: gpt-6-luna\napi_key: ${KEY}\n");
    expect(leftovers()).toEqual([]);
  });

  it("a retry after an interruption succeeds, and a stale temp file from a killed process does not get in the way", () => {
    const p = join(dir, "config.yaml");
    writeFileSync(p, "a: 1\n");
    writeFileSync(join(dir, ".config.yaml.failproofai-99999-deadbeef.tmp"), "half");
    expect(() => writeConfigFileAtomic(p, "a: 2\n", { rename: () => { throw new Error("boom"); } })).toThrow();
    writeConfigFileAtomic(p, "a: 3\n");
    expect(readFileSync(p, "utf8")).toBe("a: 3\n");
  });

  it("writes through a symlinked config to its target and keeps the link", () => {
    const real = join(dir, "dotfiles");
    mkdirSync(real);
    writeFileSync(join(real, "config.yaml"), "a: 1\n");
    const link = join(dir, "config.yaml");
    symlinkSync(join(real, "config.yaml"), link);
    writeConfigFileAtomic(link, "a: 2\n");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(real, "config.yaml"), "utf8")).toBe("a: 2\n");
  });
});

describe("links planted around a config are never followed into other files", () => {
  it("F8: a symlink sitting at <name>.failproofai-backup is replaced, and the file it points at is untouched", () => {
    // A cloned repository controls <repo>/.claude/: it can pre-create the backup
    // path as a link to any file the developer can write.
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "unchanged");
    const p = join(dir, "settings.json");
    writeFileSync(p, '{"old":true}\n');
    symlinkSync(victim, `${p}.failproofai-backup`);
    writeConfigFileAtomic(p, '{"new":true}\n');
    expect(readFileSync(victim, "utf8")).toBe("unchanged");
    expect(lstatSync(`${p}.failproofai-backup`).isSymbolicLink()).toBe(false);
    expect(readFileSync(`${p}.failproofai-backup`, "utf8")).toBe('{"old":true}\n');
    expect(readFileSync(p, "utf8")).toBe('{"new":true}\n');
    expect(leftovers()).toEqual([]);
  });

  it("F10: a dangling config symlink is refused — the link is kept and nothing is created at its target", () => {
    const missing = join(dir, "dotfiles", "config.yaml"); // not checked out
    const link = join(dir, "config.yaml");
    symlinkSync(missing, link);
    expect(() => writeConfigFileAtomic(link, "a: 1\n")).toThrow(DanglingConfigSymlinkError);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(missing);
    expect(existsSync(missing)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("symlinks: replace swaps a planted link for the file and never writes into its target", () => {
    const victim = join(dir, "victim.sh");
    writeFileSync(victim, "echo safe\n");
    const shim = join(dir, "failproofai.mjs");
    symlinkSync(victim, shim);
    writeConfigFileAtomic(shim, "export default {};\n", { symlinks: "replace" });
    expect(readFileSync(victim, "utf8")).toBe("echo safe\n");
    expect(lstatSync(shim).isSymbolicLink()).toBe(false);
    expect(readFileSync(shim, "utf8")).toBe("export default {};\n");
    expect(existsSync(`${shim}.failproofai-backup`)).toBe(false);
  });

  it("backup: false writes no backup (used for failproofai's own records)", () => {
    const p = join(dir, "record");
    writeFileSync(p, "a\n");
    writeConfigFileAtomic(p, "b\n", { backup: false });
    expect(readFileSync(p, "utf8")).toBe("b\n");
    expect(existsSync(`${p}.failproofai-backup`)).toBe(false);
  });
});

describe("a config that does not parse is refused, never overwritten", () => {
  it("Hermes: an unparseable config.yaml throws and is left byte-for-byte", () => {
    const p = join(dir, "config.yaml");
    const broken = "model:\n  default: gpt-6-luna\n  bad: [unclosed\n";
    writeFileSync(p, broken);
    expect(() => hermes.readSettings(p)).toThrow(UnreadableAgentConfigError);
    expect(readFileSync(p, "utf8")).toBe(broken);
  });

  it("Claude Code: invalid settings.json throws and is left byte-for-byte", () => {
    const p = join(dir, "settings.json");
    writeFileSync(p, '{ "model": "x", ');
    expect(() => claudeCode.readSettings(p)).toThrow(UnreadableAgentConfigError);
    expect(readFileSync(p, "utf8")).toBe('{ "model": "x", ');
  });

  it("an empty file still reads as empty (nothing to lose)", () => {
    const p = join(dir, "settings.json");
    writeFileSync(p, "  \n");
    expect(claudeCode.readSettings(p)).toEqual({});
  });
});
