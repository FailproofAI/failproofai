/**
 * Codex's system-config hooks and the trust check (./codex-system-hooks).
 *
 * The hash and state-key fixtures below were checked against Codex 0.162.1's
 * own `hooks/list` (app-server): every `currentHash` and `key` it reported for
 * failproofai's hooks in `~/.codex/hooks.json` and `/etc/codex/config.toml`
 * equals what these functions compute, and the rendered block loads with
 * `trustStatus: "managed"`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_MANAGED_BEGIN,
  CODEX_MANAGED_END,
  codexGatesHookTrust,
  codexHookHash,
  codexHookTrust,
  codexSystemBackupPath,
  codexSystemConfigPath,
  conflictingHooksDefinition,
  failproofaiCodexHookIdentities,
  hasCodexManagedBlock,
  installCodexSystemHooks,
  mergeCodexManagedBlock,
  parseCodexTrustedHashes,
  removeCodexSystemHooks,
  renderCodexManagedBlock,
} from "../../src/hooks/codex-system-hooks";
import { codex, codexSystemHookEntries } from "../../src/hooks/integrations";

const BIN = "/usr/lib/node_modules/failproofai/dist/cli.mjs";
const ENTRIES = codexSystemHookEntries(BIN);
const BLOCK = renderCodexManagedBlock(ENTRIES);
const CURRENT = () => "0.162.1";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fp-codex-system-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the managed block", () => {
  it("holds every event failproofai registers for Codex, with buildHookEntry's commands and timeouts", () => {
    expect(BLOCK.startsWith(`${CODEX_MANAGED_BEGIN}\n`)).toBe(true);
    expect(BLOCK.endsWith(`${CODEX_MANAGED_END}\n`)).toBe(true);
    for (const eventType of codex.eventTypes) {
      const entry = codex.buildHookEntry(BIN, eventType, "user") as { command: string; timeout: number };
      expect(BLOCK).toContain(`command = ${JSON.stringify(entry.command)}\ntimeout = ${entry.timeout}`);
    }
    expect(BLOCK).toContain('[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype = "command"\n');
    expect(BLOCK.match(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/gm)).toHaveLength(codex.eventTypes.length);
  });

  it("appends to a file and keeps every byte of it", () => {
    const original = '# mine\nmodel = "o3"\n\n[model_providers.x]\nname = "x"\n';
    const merged = mergeCodexManagedBlock(original, BLOCK);
    expect(merged.startsWith(original)).toBe(true);
    expect(merged).toBe(`${original}\n${BLOCK}`);
    expect(hasCodexManagedBlock(merged)).toBe(true);
  });

  it("replaces only its own block, idempotently, wherever it sits", () => {
    const before = 'model = "o3"\n\n';
    const after = '\n[profiles.fast]\nmodel = "mini"\n';
    const stale = renderCodexManagedBlock(codexSystemHookEntries("/old/path/failproofai"));
    const file = `${before}${stale}${after}`;
    const once = mergeCodexManagedBlock(file, BLOCK);
    expect(once).toBe(`${before}${BLOCK}${after}`);
    expect(mergeCodexManagedBlock(once, BLOCK)).toBe(once);
  });

  it("is taken back out leaving the original byte for byte", () => {
    for (const original of ['model = "o3"\n', 'model = "o3"\n\n\n', "# only a comment\n", ""]) {
      expect(mergeCodexManagedBlock(mergeCodexManagedBlock(original, BLOCK), null)).toBe(original);
    }
    // Content after the block, added later by someone else, survives too.
    const merged = mergeCodexManagedBlock('a = 1\n', BLOCK) + 'b = 2\n';
    expect(mergeCodexManagedBlock(merged, null)).toBe('a = 1\n\nb = 2\n');
  });

  it("refuses a block that has lost a marker rather than guessing where it ends", () => {
    expect(() => mergeCodexManagedBlock(`${CODEX_MANAGED_BEGIN}\n[[hooks.Stop]]\n`, BLOCK)).toThrow(/marker/);
    expect(hasCodexManagedBlock(`x = 1\n${CODEX_MANAGED_END}\n`)).toBe(false);
  });
});

describe("conflictingHooksDefinition", () => {
  it("allows arrays of hook tables, [hooks] and [hooks.state] tables", () => {
    expect(conflictingHooksDefinition('[hooks]\n\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ncommand = "x"\n')).toBeNull();
    expect(conflictingHooksDefinition('[hooks.state."/x/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:1"\n')).toBeNull();
    expect(conflictingHooksDefinition('model = "o3"\n')).toBeNull();
  });

  it("names what would make the merged file invalid TOML", () => {
    expect(conflictingHooksDefinition("hooks = { }\n")).toBe("hooks = { }");
    expect(conflictingHooksDefinition("[hooks]\nPreToolUse = []\n")).toBe("PreToolUse = []");
    expect(conflictingHooksDefinition("hooks.Stop = []\n")).toBe("hooks.Stop = []");
    expect(conflictingHooksDefinition("[hooks.PreToolUse]\nmatcher = 'x'\n")).toBe("[hooks.PreToolUse]");
  });
});

describe("installCodexSystemHooks", () => {
  const path = () => join(dir, "etc", "codex", "config.toml");

  it("creates the file (and its directory) with mode 0644 when there is none, and backs nothing up", () => {
    const result = installCodexSystemHooks(ENTRIES, { path: path(), codexVersion: CURRENT });
    expect(result).toEqual({ ok: true, path: path(), changed: true });
    expect(readFileSync(path(), "utf8")).toBe(BLOCK);
    expect(statSync(path()).mode & 0o777).toBe(0o644);
    expect(existsSync(codexSystemBackupPath(path()))).toBe(false);
  });

  it("merges into an existing file, backs it up once, and is a no-op the second time", () => {
    mkdirSync(join(dir, "etc", "codex"), { recursive: true });
    const original = '# admin\napproval_policy = "never"\n';
    writeFileSync(path(), original);
    chmodSync(path(), 0o640);
    expect(installCodexSystemHooks(ENTRIES, { path: path(), codexVersion: CURRENT })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(path(), "utf8")).toBe(`${original}\n${BLOCK}`);
    expect(readFileSync(codexSystemBackupPath(path()), "utf8")).toBe(original);
    expect(statSync(path()).mode & 0o777).toBe(0o640);

    expect(installCodexSystemHooks(ENTRIES, { path: path(), codexVersion: CURRENT })).toMatchObject({ ok: true, changed: false });
    // A new binary path replaces the block and leaves the first backup alone.
    const moved = codexSystemHookEntries("/opt/failproofai/cli.mjs");
    expect(installCodexSystemHooks(moved, { path: path(), codexVersion: CURRENT })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(path(), "utf8")).toBe(`${original}\n${renderCodexManagedBlock(moved)}`);
    expect(readFileSync(codexSystemBackupPath(path()), "utf8")).toBe(original);
  });

  it("falls back, writing nothing, where the system layer cannot be used", () => {
    expect(installCodexSystemHooks(ENTRIES, { path: null, codexVersion: CURRENT })).toMatchObject({
      ok: false,
      reason: "unsupported-platform",
    });
    expect(installCodexSystemHooks(ENTRIES, { path: path(), codexVersion: () => null })).toMatchObject({
      ok: false,
      reason: "codex-not-found",
    });
    expect(installCodexSystemHooks(ENTRIES, { path: path(), codexVersion: () => "0.128.0" })).toMatchObject({
      ok: false,
      reason: "codex-too-old",
    });
    expect(existsSync(path())).toBe(false);
  });

  it("needs root for a file it cannot write itself, and leaves it untouched without", () => {
    if (process.getuid?.() === 0) return; // root can write anything
    const etc = join(dir, "etc", "codex");
    mkdirSync(etc, { recursive: true });
    writeFileSync(path(), "x = 1\n");
    chmodSync(path(), 0o444);
    chmodSync(etc, 0o555);
    try {
      expect(installCodexSystemHooks(ENTRIES, { path: path(), codexVersion: CURRENT, canElevate: () => false })).toEqual({
        ok: false,
        reason: "no-root",
        path: path(),
      });
      expect(readFileSync(path(), "utf8")).toBe("x = 1\n");
    } finally {
      chmodSync(etc, 0o755);
    }
  });

  it("will not write a block that would break the file's TOML", () => {
    mkdirSync(join(dir, "etc", "codex"), { recursive: true });
    writeFileSync(path(), "hooks = {}\n");
    expect(installCodexSystemHooks(ENTRIES, { path: path(), codexVersion: CURRENT })).toMatchObject({
      ok: false,
      reason: "conflict",
      detail: "hooks = {}",
    });
    expect(readFileSync(path(), "utf8")).toBe("hooks = {}\n");
  });
});

describe("removeCodexSystemHooks", () => {
  const path = () => join(dir, "config.toml");

  it("deletes a file failproofai created and nobody else added to", () => {
    installCodexSystemHooks(ENTRIES, { path: path(), codexVersion: CURRENT });
    expect(removeCodexSystemHooks({ path: path() })).toEqual({ status: "removed", path: path(), hooks: ENTRIES.length });
    expect(existsSync(path())).toBe(false);
  });

  it("restores the exact original from the backup, even one with no final newline", () => {
    const original = 'model = "o3"'; // no trailing newline
    writeFileSync(path(), original);
    installCodexSystemHooks(ENTRIES, { path: path(), codexVersion: CURRENT });
    expect(removeCodexSystemHooks({ path: path() }).status).toBe("removed");
    expect(readFileSync(path(), "utf8")).toBe(original);
    expect(existsSync(codexSystemBackupPath(path()))).toBe(false);
  });

  it("keeps edits made since, and the backup, when the rest of the file changed", () => {
    writeFileSync(path(), "a = 1\n");
    installCodexSystemHooks(ENTRIES, { path: path(), codexVersion: CURRENT });
    writeFileSync(path(), `${readFileSync(path(), "utf8")}b = 2\n`);
    expect(removeCodexSystemHooks({ path: path() }).status).toBe("removed");
    expect(readFileSync(path(), "utf8")).toBe("a = 1\n\nb = 2\n");
    expect(existsSync(codexSystemBackupPath(path()))).toBe(true);
  });

  it("is absent when there is nothing of ours", () => {
    expect(removeCodexSystemHooks({ path: path() })).toEqual({ status: "absent" });
    writeFileSync(path(), "a = 1\n");
    expect(removeCodexSystemHooks({ path: path() })).toEqual({ status: "absent" });
    expect(readFileSync(path(), "utf8")).toBe("a = 1\n");
  });
});

describe("trust", () => {
  const hooksJson = () => join(dir, ".codex", "hooks.json");
  const userConfig = () => join(dir, ".codex", "config.toml");
  const systemPath = () => join(dir, "etc", "config.toml");
  const deps = (over: Record<string, unknown> = {}) => ({
    path: systemPath(),
    hooksJsonPath: hooksJson(),
    userConfigPath: userConfig(),
    codexVersion: CURRENT,
    ...over,
  });
  const writeHooksJson = (extra: Record<string, unknown> = {}) => {
    const settings: Record<string, unknown> = { ...extra };
    codex.writeHookEntries(settings, BIN, "user");
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(hooksJson(), JSON.stringify(settings, null, 2));
  };

  it("computes Codex's own hash for a failproofai hook", () => {
    // Codex 0.162.1 hooks/list reported exactly this currentHash, for the entry
    // as it was before hooks named their scope (`--agent-scope`): the live
    // anchor for the hash itself.
    const withoutScope = (e: Record<string, unknown>) => ({ ...e, command: String(e.command).replace(/ --agent-scope user$/, "") });
    const entry = codex.buildHookEntry(BIN, "pre_tool_use", "user") as Record<string, unknown>;
    expect(String(entry.command)).toMatch(/ --agent-scope user$/);
    expect(codexHookHash("PreToolUse", null, withoutScope(entry))).toBe(
      "sha256:a38a73af7b65aed439e83f5862e6894eeeec40a7f15ee44311bb4100df755be7",
    );
    const stop = codex.buildHookEntry(BIN, "permission_request", "user") as Record<string, unknown>;
    expect(codexHookHash("PermissionRequest", null, withoutScope(stop))).toBe(
      "sha256:5909f53157dc846188f16e03686d8da586bef0ef0e4a1cefed7f0b9b3ac9fd7b",
    );
    // The scope is part of the command, so it is part of what Codex trusts.
    expect(codexHookHash("PreToolUse", null, entry)).not.toBe(codexHookHash("PreToolUse", null, withoutScope(entry)));
  });

  it("keys each hook as Codex does: path, snake_case event, group and handler index", () => {
    writeHooksJson({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }] } });
    const keys = failproofaiCodexHookIdentities(hooksJson()).map((h) => h.key);
    expect(keys).toContain(`${hooksJson()}:pre_tool_use:1:0`);
    expect(keys).toContain(`${hooksJson()}:session_start:0:0`);
    expect(keys).toHaveLength(codex.eventTypes.length);
  });

  it("is none with no failproofai hooks at user scope", () => {
    expect(codexHookTrust(deps())).toEqual({ kind: "none" });
  });

  it("is untrusted with hooks.json present and no [hooks.state]", () => {
    writeHooksJson();
    writeFileSync(userConfig(), 'model = "o3"\n');
    expect(codexHookTrust(deps())).toEqual({
      kind: "untrusted",
      path: hooksJson(),
      untrusted: codex.eventTypes.length,
      total: codex.eventTypes.length,
    });
  });

  it("is trusted once every hook's state holds its current hash, in any form Codex writes it", () => {
    writeHooksJson();
    const ours = failproofaiCodexHookIdentities(hooksJson());
    const [first, ...rest] = ours;
    writeFileSync(
      userConfig(),
      [
        'model = "o3"',
        "",
        "[hooks.state]",
        `${JSON.stringify(first.key)} = { trusted_hash = ${JSON.stringify(first.hash)}, enabled = true }`,
        "",
        ...rest.flatMap((h) => [`[hooks.state.${JSON.stringify(h.key)}]`, `trusted_hash = ${JSON.stringify(h.hash)}`, ""]),
      ].join("\n"),
    );
    expect(codexHookTrust(deps())).toEqual({ kind: "trusted", path: hooksJson() });
  });

  it("counts a hook trusted at an older hash as untrusted, as Codex calls it modified and skips it", () => {
    writeHooksJson();
    const ours = failproofaiCodexHookIdentities(hooksJson());
    writeFileSync(
      userConfig(),
      ours
        .map((h, i) => `[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash = "${i === 0 ? "sha256:stale" : h.hash}"\n`)
        .join("\n"),
    );
    expect(codexHookTrust(deps())).toMatchObject({ kind: "untrusted", untrusted: 1 });
  });

  it("is system (managed) whenever failproofai's block is in the system config", () => {
    writeHooksJson();
    mkdirSync(join(dir, "etc"), { recursive: true });
    writeFileSync(systemPath(), BLOCK);
    expect(codexHookTrust(deps())).toEqual({ kind: "system", path: systemPath() });
  });

  it("is ungated on a Codex older than the trust gate", () => {
    writeHooksJson();
    expect(codexHookTrust(deps({ codexVersion: () => "0.128.0" }))).toMatchObject({ kind: "ungated", version: "0.128.0" });
    expect(codexGatesHookTrust("0.129.0")).toBe(true);
    expect(codexGatesHookTrust(null)).toBe(true);
  });

  it("parses state keys with escapes and ignores look-alikes inside multi-line strings", () => {
    const text = [
      // A root-level dotted key; it must come before any [table] header.
      "hooks.state.'/lit:stop:0:0'.trusted_hash = 'sha256:lit'",
      'notes = """',
      '[hooks.state."/fake:stop:0:0"]',
      'trusted_hash = "sha256:fake"',
      '"""',
      '[hooks.state."/home/u/.codex/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:real" # comment',
    ].join("\n");
    const found = parseCodexTrustedHashes(text);
    expect(found.get("/home/u/.codex/hooks.json:stop:0:0")).toBe("sha256:real");
    expect(found.get("/lit:stop:0:0")).toBe("sha256:lit");
    expect(found.has("/fake:stop:0:0")).toBe(false);
  });
});

describe("codexSystemConfigPath", () => {
  it("honours the override, and `off` means none", () => {
    const saved = process.env.FAILPROOFAI_CODEX_SYSTEM_CONFIG;
    try {
      process.env.FAILPROOFAI_CODEX_SYSTEM_CONFIG = "off";
      expect(codexSystemConfigPath()).toBeNull();
      process.env.FAILPROOFAI_CODEX_SYSTEM_CONFIG = "/tmp/x/config.toml";
      expect(codexSystemConfigPath()).toBe("/tmp/x/config.toml");
      delete process.env.FAILPROOFAI_CODEX_SYSTEM_CONFIG;
      expect(codexSystemConfigPath()).toBe(process.platform === "win32" ? null : "/etc/codex/config.toml");
    } finally {
      if (saved === undefined) delete process.env.FAILPROOFAI_CODEX_SYSTEM_CONFIG;
      else process.env.FAILPROOFAI_CODEX_SYSTEM_CONFIG = saved;
    }
  });
});
