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
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CODEX_MANAGED_BEGIN,
  CODEX_MANAGED_END,
  codexGatesHookTrust,
  codexHookHash,
  codexHookRunnerPath,
  codexHookTrust,
  codexRefreshLines,
  codexSystemBackupPath,
  codexSystemConfigPath,
  codexSystemHooksPresent,
  conflictingHooksDefinition,
  failproofaiCodexHookIdentities,
  hasCodexManagedBlock,
  installCodexSystemHooks,
  mergeCodexManagedBlock,
  parseCodexHookRunner,
  parseCodexManagedBlock,
  parseCodexTrustedHashes,
  refreshCodexSystemHooks,
  removeCodexSystemHooks,
  renderCodexHookRunner,
  renderCodexManagedBlock,
  codexTrustedOwners,
  nsswitchIsLocal,
  untrustedPathReason,
} from "../../src/hooks/codex-system-hooks";
import { codex, codexSystemHookEntries } from "../../src/hooks/integrations";

const BIN = "/usr/lib/node_modules/failproofai/dist/cli.mjs";
const ENTRIES = codexSystemHookEntries(BIN);
const BLOCK = renderCodexManagedBlock(ENTRIES);
const CURRENT = () => "0.162.1";

let dir: string;
beforeEach(() => {
  // Resolved: the ownership check reports paths as the kernel resolves them.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "fp-codex-system-")));
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

/** Directories as the tests make them: 0755 whatever the umask, as the runner's check needs. */
function mkdirs(path: string): void {
  const missing: string[] = [];
  for (let d = path; !existsSync(d); d = dirname(d)) missing.unshift(d);
  for (const d of missing) {
    mkdirSync(d);
    chmodSync(d, 0o755);
  }
}

/** A system-config fixture: 0644 whatever the umask, as the config's own trust check needs. */
function writeConfig(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o644);
}

/** An executable shell script at `path`, 0755. */
function script(path: string, body: string): string {
  mkdirs(dirname(path));
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** The program each hook in the system config's block runs. */
function blockPrograms(configPath: string): string[] {
  const text = readFileSync(configPath, "utf8");
  const entries = parseCodexManagedBlock(text.slice(text.indexOf(CODEX_MANAGED_BEGIN)));
  return (entries ?? []).map((e) => /^"([^"]*)"/.exec(e.command)?.[1] ?? e.command);
}

const ME = process.getuid?.() ?? 0;

/** This account's own failproofai, as a real file: the runner's per-account check reads it. */
const myCli = () => script(join(dir, "home", "me", "failproofai"), "true");

describe("installCodexSystemHooks", () => {
  const path = () => join(dir, "etc", "codex", "config.toml");
  const runner = () => codexHookRunnerPath(path())!;
  const install = (over: Record<string, unknown> = {}, cli = myCli()) =>
    installCodexSystemHooks(cli, codexSystemHookEntries, { path: path(), codexVersion: CURRENT, ...over });
  const block = () => renderCodexManagedBlock(codexSystemHookEntries(runner()));

  it("creates the file (and its directory) with mode 0644 when there is none, and backs nothing up", () => {
    const result = install();
    expect(result).toEqual({ ok: true, path: path(), changed: true, dropped: [] });
    expect(readFileSync(path(), "utf8")).toBe(block());
    expect(statSync(path()).mode & 0o777).toBe(0o644);
    expect(existsSync(codexSystemBackupPath(path()))).toBe(false);
  });

  it("runs every hook through the hook runner, never through the account's own failproofai", () => {
    expect(install()).toMatchObject({ ok: true });
    const programs = blockPrograms(path());
    expect(programs).toHaveLength(codex.eventTypes.length);
    expect(new Set(programs)).toEqual(new Set([runner()]));
    expect(readFileSync(path(), "utf8")).not.toContain(myCli());
    // The runner: 0755, failproofai's, naming this account's failproofai for this uid alone.
    expect(statSync(runner()).mode & 0o777).toBe(0o755);
    expect(parseCodexHookRunner(readFileSync(runner(), "utf8"))?.accounts).toEqual([
      expect.objectContaining({ uid: ME, cli: myCli() }),
    ]);
  });

  it("merges into an existing file, backs it up once, and is a no-op the second time", () => {
    mkdirs(join(dir, "etc", "codex"));
    const original = '# admin\napproval_policy = "never"\n';
    writeFileSync(path(), original);
    chmodSync(path(), 0o640);
    expect(install()).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(path(), "utf8")).toBe(`${original}\n${block()}`);
    expect(readFileSync(codexSystemBackupPath(path()), "utf8")).toBe(original);
    expect(statSync(path()).mode & 0o777).toBe(0o640);

    const runnerBefore = readFileSync(runner(), "utf8");
    expect(install()).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(runner(), "utf8")).toBe(runnerBefore);
    // A new failproofai path changes the runner, not the block or the backup.
    const elsewhere = script(join(dir, "elsewhere", "failproofai"), "true");
    expect(install({}, elsewhere)).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(path(), "utf8")).toBe(`${original}\n${block()}`);
    expect(parseCodexHookRunner(readFileSync(runner(), "utf8"))?.accounts).toEqual([
      expect.objectContaining({ uid: ME, cli: elsewhere }),
    ]);
    expect(readFileSync(codexSystemBackupPath(path()), "utf8")).toBe(original);
  });

  it("falls back, writing nothing, where the system layer cannot be used", () => {
    expect(install({ path: null })).toMatchObject({ ok: false, reason: "unsupported-platform" });
    expect(install({ codexVersion: () => null })).toMatchObject({ ok: false, reason: "codex-not-found" });
    expect(install({ codexVersion: () => "0.128.0" })).toMatchObject({ ok: false, reason: "codex-too-old" });
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runner())).toBe(false);
  });

  it("needs root for a file it cannot write itself, and leaves it untouched without", () => {
    if (ME === 0) return; // root can write anything
    const etc = join(dir, "etc", "codex");
    mkdirs(etc);
    writeFileSync(path(), "x = 1\n");
    chmodSync(path(), 0o444);
    chmodSync(etc, 0o555);
    try {
      expect(install({ canElevate: () => false })).toEqual({ ok: false, reason: "no-root", path: path() });
      expect(readFileSync(path(), "utf8")).toBe("x = 1\n");
      expect(existsSync(runner())).toBe(false);
    } finally {
      chmodSync(etc, 0o755);
    }
  });

  it("will not write a block that would break the file's TOML", () => {
    mkdirs(join(dir, "etc", "codex"));
    writeFileSync(path(), "hooks = {}\n");
    expect(install()).toMatchObject({ ok: false, reason: "conflict", detail: "hooks = {}" });
    expect(readFileSync(path(), "utf8")).toBe("hooks = {}\n");
    expect(existsSync(runner())).toBe(false);
  });

  it("will not replace a file at the runner's path that failproofai did not write", () => {
    script(runner(), "echo mine");
    expect(install()).toMatchObject({ ok: false, reason: "conflict", detail: expect.stringContaining(runner()) });
    expect(readFileSync(runner(), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(existsSync(path())).toBe(false);
  });

  it("refuses hooks that would run anything else", () => {
    const direct = () => codexSystemHookEntries(BIN);
    expect(installCodexSystemHooks(myCli(), direct, { path: path(), codexVersion: CURRENT })).toMatchObject({
      ok: false,
      reason: "write-failed",
    });
    expect(existsSync(path())).toBe(false);
  });
});

describe("the hook runner, run", () => {
  const path = () => join(dir, "etc", "codex", "config.toml");
  const runner = () => codexHookRunnerPath(path())!;
  // `id` stands in for the account Codex runs as; the rest is the real system's.
  const programs = () => ({ sh: "/bin/sh", id: script(join(dir, "fake", "id"), 'echo "$FAKE_UID"'), cat: "/bin/cat" });
  /** An account's own failproofai: writes who it is, its arguments and the event to $MARKER. */
  const fakeCli = (home: string, label = home) =>
    script(join(dir, "accounts", home, "failproofai"), `printf "%s %s\\n" ${label} "$*" >"$MARKER"; cat >>"$MARKER"`);
  const marker = () => join(dir, "ran");
  const payload = '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}';

  /** Every hook in the block, run as `uid` the way Codex runs one: through a shell, the event on stdin. */
  function runHooksAs(uid: number): Array<{ status: number | null; stdout: string }> {
    const text = readFileSync(path(), "utf8");
    const entries = parseCodexManagedBlock(text.slice(text.indexOf(CODEX_MANAGED_BEGIN))) ?? [];
    expect(entries.length).toBeGreaterThan(0);
    return entries.map((entry) => {
      const result = spawnSync("/bin/sh", ["-c", entry.command], {
        input: payload,
        env: { ...process.env, FAKE_UID: String(uid), MARKER: marker() },
        encoding: "utf8",
        timeout: 10_000,
      });
      return { status: result.status, stdout: result.stdout };
    });
  }

  it("hands the event to the account's own failproofai for that account, and runs nothing for root or anyone else", () => {
    const cli = fakeCli("alice");
    expect(
      installCodexSystemHooks(cli, codexSystemHookEntries, {
        path: path(),
        codexVersion: CURRENT,
        uid: 4242,
        userName: "alice",
        programs: programs(),
      }),
    ).toMatchObject({ ok: true });

    for (const uid of [0, 4243]) {
      const results = runHooksAs(uid);
      expect(results.every((r) => r.status === 0 && r.stdout === "")).toBe(true);
      expect(existsSync(marker())).toBe(false);
    }

    const [first] = runHooksAs(4242);
    expect(first.status).toBe(0);
    const ran = readFileSync(marker(), "utf8");
    expect(ran).toMatch(/^alice --hook \w+ --cli codex --agent-scope user\n/);
    expect(ran).toContain(payload);
  });

  it("runs each account that set it up its own failproofai", () => {
    const alice = fakeCli("alice");
    const bob = fakeCli("bob");
    const deps = { path: path(), codexVersion: CURRENT, programs: programs() };
    expect(installCodexSystemHooks(alice, codexSystemHookEntries, { ...deps, uid: 4242 })).toMatchObject({ ok: true });
    expect(installCodexSystemHooks(bob, codexSystemHookEntries, { ...deps, uid: 4243 })).toMatchObject({ ok: true });
    runHooksAs(4243);
    expect(readFileSync(marker(), "utf8")).toMatch(/^bob --hook /);
    runHooksAs(4242);
    expect(readFileSync(marker(), "utf8")).toMatch(/^alice --hook /);
    expect(parseCodexHookRunner(readFileSync(runner(), "utf8"))?.accounts.map((a) => [a.uid, a.cli])).toEqual([
      [4242, alice],
      [4243, bob],
    ]);
  });

  it("quotes a failproofai path that holds a quote", () => {
    const cli = fakeCli("o'brien", "obrien");
    installCodexSystemHooks(cli, codexSystemHookEntries, { path: path(), codexVersion: CURRENT, uid: 4242, programs: programs() });
    expect(parseCodexHookRunner(readFileSync(runner(), "utf8"))?.accounts[0].cli).toBe(cli);
    runHooksAs(4242);
    expect(existsSync(marker())).toBe(true);
  });
});

describe("removeCodexSystemHooks", () => {
  const path = () => join(dir, "config.toml");
  const runner = () => codexHookRunnerPath(path())!;
  const install = (over: Record<string, unknown> = {}) =>
    installCodexSystemHooks(myCli(), codexSystemHookEntries, { path: path(), codexVersion: CURRENT, ...over });

  it("deletes a file failproofai created and nobody else added to, and the runner with it", () => {
    install();
    expect(removeCodexSystemHooks({ path: path() })).toEqual({ status: "removed", path: path(), hooks: ENTRIES.length, remaining: 0 });
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runner())).toBe(false);
  });

  it("restores the exact original from the backup, even one with no final newline", () => {
    const original = 'model = "o3"'; // no trailing newline
    writeConfig(path(), original);
    install();
    expect(removeCodexSystemHooks({ path: path() }).status).toBe("removed");
    expect(readFileSync(path(), "utf8")).toBe(original);
    expect(existsSync(codexSystemBackupPath(path()))).toBe(false);
  });

  it("keeps edits made since, and the backup, when the rest of the file changed", () => {
    writeConfig(path(), "a = 1\n");
    install();
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

  it("takes out only this account while another still has its hooks there", () => {
    install({ uid: 4242 });
    install({ uid: 4243 });
    const config = readFileSync(path(), "utf8");
    expect(removeCodexSystemHooks({ path: path(), uid: 4242 })).toMatchObject({ status: "removed", remaining: 1 });
    expect(readFileSync(path(), "utf8")).toBe(config);
    expect(parseCodexHookRunner(readFileSync(runner(), "utf8"))?.accounts.map((a) => a.uid)).toEqual([4243]);
    expect(codexSystemHooksPresent({ path: path(), uid: 4242 })).toBe(false);
    expect(codexSystemHooksPresent({ path: path(), uid: 4243 })).toBe(true);
    // An account with nothing there removes nothing.
    expect(removeCodexSystemHooks({ path: path(), uid: 4244 })).toEqual({ status: "absent" });
    expect(removeCodexSystemHooks({ path: path(), uid: 4243 })).toMatchObject({ status: "removed" });
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runner())).toBe(false);
  });
});

describe("what the runner may run before it knows the account", () => {
  const path = () => join(dir, "etc", "codex", "config.toml");
  const runner = () => codexHookRunnerPath(path())!;
  const install = (over: Record<string, unknown> = {}) =>
    installCodexSystemHooks(myCli(), codexSystemHookEntries, { path: path(), codexVersion: CURRENT, ...over });

  it("is root's alone when the system config is: the runner of an account is refused and the hooks stay out", () => {
    if (ME === 0) return; // root's own files are root's
    // As on a real machine, where /etc/codex is root's: this test's files are an account's.
    const result = install({ trustedUids: [0] });
    expect(result).toMatchObject({ ok: false, reason: "unsafe", detail: expect.stringMatching(/is owned by uid \d+/) });
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runner())).toBe(false);
  });

  it("refuses a runner directory others can write, and takes out the block that was there", () => {
    // In its own directory, as /opt/failproofai-codex is: the config's stays trusted.
    const runnerPath = join(dir, "opt", "failproofai-codex", "codex-hook");
    expect(install({ runnerPath })).toMatchObject({ ok: true });
    chmodSync(dirname(runnerPath), 0o775);
    expect(install({ runnerPath })).toMatchObject({
      ok: false,
      reason: "unsafe",
      detail: `${dirname(runnerPath)} can be written by accounts other than its owner`,
    });
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runnerPath)).toBe(false);
  });

  it("refuses a system config another account can change, and writes nothing to it", () => {
    mkdirs(dirname(path()));
    writeConfig(path(), "a = 1\n");
    chmodSync(path(), 0o666);
    expect(install()).toMatchObject({
      ok: false,
      reason: "unsafe",
      detail: `${path()} can be written by accounts other than its owner`,
    });
    expect(readFileSync(path(), "utf8")).toBe("a = 1\n");
    expect(existsSync(runner())).toBe(false);
  });

  it("refuses a system config reached through a directory everyone can write", () => {
    const loose = join(dir, "loose");
    mkdirs(loose);
    chmodSync(loose, 0o777);
    writeConfig(join(loose, "config.toml"), "a = 1\n");
    mkdirs(dirname(path()));
    symlinkSync(join(loose, "config.toml"), path());
    expect(install()).toMatchObject({ ok: false, reason: "unsafe", detail: `${loose} can be written by accounts other than its owner` });
    expect(readFileSync(path(), "utf8")).toBe("a = 1\n");
  });

  it("refuses an `id` or `cat` another account could replace", () => {
    const loose = join(dir, "loose");
    const id = script(join(loose, "id"), "echo 0");
    chmodSync(loose, 0o777);
    expect(install({ programs: { sh: "/bin/sh", id, cat: "/bin/cat" } })).toMatchObject({
      ok: false,
      reason: "unsafe",
      detail: `${loose} can be written by accounts other than its owner`,
    });
    expect(existsSync(path())).toBe(false);
  });

  describe("untrustedPathReason", () => {
    const trusted = new Set([0, ME]);

    it("accepts a file only its owner can write, under directories only their owners can", () => {
      const file = script(join(dir, "a", "b", "f"), "true");
      expect(untrustedPathReason(file, trusted)).toBeNull();
      expect(untrustedPathReason(join(dir, "a"), trusted, { dir: true })).toBeNull();
      expect(untrustedPathReason("/bin/sh", new Set([0]), { link: true })).toBeNull();
    });

    it("names the first entry that belongs to someone else, or that others can write", () => {
      const file = script(join(dir, "a", "f"), "true");
      if (ME !== 0) expect(untrustedPathReason(file, new Set([0]))).toMatch(/is owned by uid \d+$/);
      chmodSync(file, 0o775);
      expect(untrustedPathReason(file, trusted)).toBe(`${file} can be written by accounts other than its owner`);
      chmodSync(file, 0o755);
      chmodSync(join(dir, "a"), 0o757);
      expect(untrustedPathReason(file, trusted)).toBe(`${join(dir, "a")} can be written by accounts other than its owner`);
    });

    it("accepts a sticky directory everyone can write, as /tmp is", () => {
      const file = script(join(dir, "sticky", "own", "f"), "true");
      chmodSync(join(dir, "sticky"), 0o1777);
      expect(untrustedPathReason(file, trusted)).toBeNull();
    });

    it("refuses a link as the runner, and checks every directory a link passes through", () => {
      const file = script(join(dir, "y", "f"), "true");
      // a/l -> x/l2 -> y/f, with x writable by others: resolving a/l reads x.
      mkdirs(join(dir, "x"));
      symlinkSync(file, join(dir, "x", "l2"));
      chmodSync(join(dir, "x"), 0o777);
      mkdirs(join(dir, "a"));
      symlinkSync(join(dir, "x", "l2"), join(dir, "a", "l"));
      expect(untrustedPathReason(join(dir, "a", "l"), trusted)).toBe(`${join(dir, "a", "l")} is a symbolic link`);
      expect(untrustedPathReason(join(dir, "a", "l"), trusted, { link: true })).toBe(
        `${join(dir, "x")} can be written by accounts other than its owner`,
      );
      chmodSync(join(dir, "x"), 0o755);
      expect(untrustedPathReason(join(dir, "a", "l"), trusted, { link: true })).toBeNull();
    });

    it("refuses a relative path and one that is not there", () => {
      expect(untrustedPathReason("bin/sh", trusted)).toBe("bin/sh is not an absolute path");
      expect(untrustedPathReason(join(dir, "nope"), trusted)).toBe(`${join(dir, "nope")} does not exist`);
    });
  });
});

describe("refreshCodexSystemHooks (failproofai update)", () => {
  const path = () => join(dir, "etc", "codex", "config.toml");
  const runner = () => codexHookRunnerPath(path())!;
  /** A block in the format earlier versions wrote: every hook runs `cli` itself. */
  const writeOlderBlock = (cli: string, before = "") => {
    mkdirs(dirname(path()));
    writeConfig(path(), mergeCodexManagedBlock(before, renderCodexManagedBlock(codexSystemHookEntries(cli))));
  };

  it("rewrites a block from before the runner to run it, for the account whose failproofai it ran", () => {
    if (ME === 0) return; // root owns every file here, so the block would be the running account's
    const cli = script(join(dir, "home", "failproofai"), "true");
    writeOlderBlock(cli, 'model = "o3"\n');
    expect(codexSystemHooksPresent({ path: path(), uid: 4242 })).toBe(true); // it runs for every account
    expect(refreshCodexSystemHooks({ path: path(), uid: 4242 })).toEqual({
      status: "rewritten",
      path: path(),
      runner: runner(),
      migrated: true,
      dropped: [],
    });
    expect(new Set(blockPrograms(path()))).toEqual(new Set([runner()]));
    expect(readFileSync(path(), "utf8").startsWith('model = "o3"\n')).toBe(true);
    // The failproofai it ran is this test's, so it runs for this test's uid and no other.
    expect(parseCodexHookRunner(readFileSync(runner(), "utf8"))?.accounts).toEqual([{ uid: ME, cli }]);
    expect(codexSystemHooksPresent({ path: path(), uid: 4242 })).toBe(false);
    expect(refreshCodexSystemHooks({ path: path() })).toEqual({ status: "current", path: path() });
  });

  it("keeps the same events, arguments and timeouts", () => {
    if (ME === 0) return; // root owns every file here, so this account's files are root's alone
    const cli = script(join(dir, "home", "failproofai"), "true");
    writeOlderBlock(cli);
    refreshCodexSystemHooks({ path: path() });
    const text = readFileSync(path(), "utf8");
    expect(parseCodexManagedBlock(text)).toEqual(
      codexSystemHookEntries(cli).map((e) => ({ ...e, command: e.command.replace(`"${cli}"`, `"${runner()}"`) })),
    );
  });

  it("takes out a block from before the runner rather than replace a file failproofai did not write", () => {
    if (ME === 0) return; // root owns every file here, so this account's files are root's alone
    const cli = script(join(dir, "home", "failproofai"), "true");
    writeOlderBlock(cli);
    script(runner(), "echo mine");
    expect(refreshCodexSystemHooks({ path: path() })).toEqual({
      status: "removed",
      path: path(),
      reason: `${runner()} is there, and failproofai did not write it`,
    });
    expect(existsSync(path())).toBe(false);
    expect(readFileSync(runner(), "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("takes out a block from before the runner whose failproofai is gone", () => {
    writeOlderBlock(join(dir, "gone", "failproofai"));
    expect(refreshCodexSystemHooks({ path: path() })).toEqual({
      status: "removed",
      path: path(),
      reason: "the failproofai they ran is gone",
    });
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runner())).toBe(false);
  });

  it("changes nothing without root, and says so", () => {
    if (ME === 0) return;
    const cli = script(join(dir, "home", "failproofai"), "true");
    writeOlderBlock(cli);
    const before = readFileSync(path(), "utf8");
    chmodSync(dirname(path()), 0o555);
    try {
      expect(refreshCodexSystemHooks({ path: path(), canElevate: () => false })).toMatchObject({ status: "needs-root", path: path() });
      expect(readFileSync(path(), "utf8")).toBe(before);
    } finally {
      chmodSync(dirname(path()), 0o755);
    }
  });

  it("reports a system config another account can change, never calling it current", () => {
    expect(installCodexSystemHooks(myCli(), codexSystemHookEntries, { path: path(), codexVersion: CURRENT })).toMatchObject({ ok: true });
    chmodSync(path(), 0o666);
    const before = readFileSync(path(), "utf8");
    expect(refreshCodexSystemHooks({ path: path() })).toEqual({
      status: "unsafe-config",
      path: path(),
      reason: `${path()} can be written by accounts other than its owner`,
    });
    // An account the hooks do not run for is told, and its update does not fail.
    expect(refreshCodexSystemHooks({ path: path(), uid: 4242 })).toMatchObject({ status: "others" });
    expect(readFileSync(path(), "utf8")).toBe(before);
    expect(codexRefreshLines({ status: "unsafe-config", path: path(), reason: "x" })[0]).toMatch(/^✕ Codex: /);
  });

  it("takes the block out when the runner stops passing the check", () => {
    expect(installCodexSystemHooks(myCli(), codexSystemHookEntries, { path: path(), codexVersion: CURRENT })).toMatchObject({ ok: true });
    expect(refreshCodexSystemHooks({ path: path() })).toEqual({ status: "current", path: path() });
    chmodSync(runner(), 0o777);
    expect(refreshCodexSystemHooks({ path: path() })).toEqual({
      status: "removed",
      path: path(),
      reason: `${runner()} can be written by accounts other than its owner`,
    });
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runner())).toBe(false);
  });

  it("takes the block out when its runner is missing or replaced", () => {
    const install = () => installCodexSystemHooks(myCli(), codexSystemHookEntries, { path: path(), codexVersion: CURRENT });
    install();
    rmSync(runner());
    expect(refreshCodexSystemHooks({ path: path() })).toMatchObject({ status: "removed", reason: `${runner()} is missing` });
    install();
    rmSync(runner());
    symlinkSync("/bin/true", runner());
    expect(refreshCodexSystemHooks({ path: path() })).toMatchObject({
      status: "removed",
      reason: `${runner()} was not written by failproofai`,
    });
    expect(existsSync(path())).toBe(false);
  });

  it("says what changed, and how to finish when it needs root", () => {
    expect(codexRefreshLines({ status: "current", path: path() })).toEqual([]);
    expect(codexRefreshLines({ status: "rewritten", path: path(), runner: runner(), migrated: true, dropped: [] })[0]).toMatch(/^✓ Codex: /);
    expect(codexRefreshLines({ status: "rewritten", path: path(), runner: runner(), migrated: false, dropped: [{ uid: 7, reason: "x" }] })).toEqual([
      `▲ Codex: took uid 7 out of failproofai's hooks in ${path()}: x.`,
      "  That account can run `failproofai config` to set them up again.",
    ]);
    expect(codexRefreshLines({ status: "others", path: path(), reason: "x" })).toEqual([
      `▲ Codex: failproofai's hooks in ${path()} need updating by an account that set them up, or by root: x.`,
      "  If you set them up, run `failproofai config`; otherwise tell whoever administers this machine.",
    ]);
    expect(codexRefreshLines({ status: "rewritten", path: path(), runner: runner(), migrated: false, dropped: [] })).toEqual([
      `✓ Codex: rewrote failproofai's hook runner, ${runner()}, which had changed since it was written.`,
    ]);
    expect(codexRefreshLines({ status: "removed", path: path(), reason: "x" })[0]).toMatch(/^▲ Codex: took/);
    expect(codexRefreshLines({ status: "needs-root", path: path(), reason: "x" })).toEqual([
      `✕ Codex: failproofai's hooks in ${path()} need updating, which needs root: x.`,
      "  Run `sudo -v` and then `failproofai update` again.",
    ]);
  });
});

describe("installing over a block from before the runner", () => {
  const path = () => join(dir, "etc", "codex", "config.toml");
  const runner = () => codexHookRunnerPath(path())!;

  it("keeps it for the account whose failproofai it ran, and adds this one", () => {
    if (ME === 0) return; // root owns every file here, so the block would be the running account's
    const theirs = script(join(dir, "home", "failproofai"), "true");
    mkdirs(dirname(path()));
    writeConfig(path(), renderCodexManagedBlock(codexSystemHookEntries(theirs)));
    // This account is not the one that owns `theirs`.
    expect(
      installCodexSystemHooks(myCli(), codexSystemHookEntries, { path: path(), codexVersion: CURRENT, uid: 4242 }),
    ).toMatchObject({ ok: true, changed: true });
    expect(new Set(blockPrograms(path()))).toEqual(new Set([runner()]));
    expect(parseCodexHookRunner(readFileSync(runner(), "utf8"))?.accounts.map((a) => [a.uid, a.cli])).toEqual(
      [[ME, theirs], [4242, myCli()]].sort((a, b) => Number(a[0]) - Number(b[0])),
    );
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

  it("is system (managed) for every account while the block runs failproofai itself, as before the runner", () => {
    writeHooksJson();
    mkdirSync(join(dir, "etc"), { recursive: true });
    writeFileSync(systemPath(), BLOCK);
    expect(codexHookTrust(deps())).toEqual({ kind: "system", path: systemPath() });
  });

  it("is system (managed) only for an account the hook runner runs failproofai for", () => {
    writeHooksJson();
    writeFileSync(userConfig(), 'model = "o3"\n');
    expect(installCodexSystemHooks(myCli(), codexSystemHookEntries, deps({ uid: 4242 }))).toMatchObject({ ok: true });
    expect(codexHookTrust(deps({ uid: 4242 }))).toEqual({ kind: "system", path: systemPath() });
    expect(codexHookTrust(deps({ uid: 4243 }))).toMatchObject({ kind: "untrusted" });
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

describe("the lines the runner keeps", () => {
  const path = () => join(dir, "etc", "codex", "config.toml");
  const runner = () => codexHookRunnerPath(path())!;
  const install = (over: Record<string, unknown> = {}, cli = myCli()) =>
    installCodexSystemHooks(cli, codexSystemHookEntries, { path: path(), codexVersion: CURRENT, ...over });
  const accounts = () => parseCodexHookRunner(readFileSync(runner(), "utf8"))?.accounts;

  it("never gives root a line that runs anything another account can change", () => {
    if (ME === 0) return; // root's own files are root's
    // As on a real machine: root's line must be root's alone, and this test's file is an account's.
    expect(install({ uid: 0, interpreter: "/bin/sh", trustedUids: [0] })).toMatchObject({
      ok: false,
      reason: "unsafe",
      detail: expect.stringMatching(/is owned by uid \d+$/),
    });
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runner())).toBe(false);
  });

  it("runs root's own install through the interpreter it names, by absolute path", () => {
    expect(install({ uid: 0, interpreter: "/bin/sh", trustedUids: [0, ME] }, "/bin/true")).toMatchObject({ ok: true });
    expect(readFileSync(runner(), "utf8")).toContain(`  0) exec '/bin/sh' '/bin/true' "$@" ;;`);
    expect(accounts()).toEqual([expect.objectContaining({ uid: 0, interpreter: "/bin/sh", cli: "/bin/true" })]);
  });

  it("takes out a root line that names no interpreter", () => {
    expect(install()).toMatchObject({ ok: true });
    const programs = parseCodexHookRunner(readFileSync(runner(), "utf8"))!.programs;
    writeFileSync(runner(), renderCodexHookRunner([...accounts()!, { uid: 0, cli: "/bin/true" }], programs));
    expect(refreshCodexSystemHooks({ path: path() })).toMatchObject({
      status: "rewritten",
      migrated: false,
      dropped: [{ uid: 0, reason: "root's line must name the program that runs failproofai" }],
    });
    expect(accounts()?.map((a) => a.uid)).toEqual([ME]);
  });

  it("refuses an account's line that runs another account's install", () => {
    if (ME === 0) return; // root owns every file here, so this account's files are root's alone
    // This test's file, put forward as uid 4242's own failproofai.
    expect(install({ uid: 4242, trustedUids: [0] })).toMatchObject({
      ok: false,
      reason: "unsafe",
      detail: expect.stringMatching(/is owned by uid \d+$/),
    });
    expect(existsSync(path())).toBe(false);
  });

  it("accepts an install its own private group can write, as a umask of 002 leaves it, but no other group, nor everyone", () => {
    if (ME === 0) return; // root's line takes no group at all
    const home = dirname(myCli());
    const gid = statSync(home).gid;
    const own = { users: [{ name: "me", uid: ME, gid }], groups: [{ name: "me", gid, members: [] }], local: true };
    chmodSync(home, 0o775);
    expect(install({ accounts: own })).toMatchObject({ ok: true });
    // The same group, shared: another account's primary group, a listed member, a name not the
    // account's, or accounts that may come from a directory service the files do not show.
    for (const shared of [
      { ...own, users: [...own.users, { name: "other", uid: ME + 1, gid }] },
      { ...own, groups: [{ name: "me", gid, members: ["other"] }] },
      { ...own, groups: [{ name: "staff", gid, members: [] }] },
      { ...own, local: false },
    ]) {
      expect(install({ accounts: shared })).toMatchObject({
        ok: false,
        reason: "unsafe",
        detail: `${home} can be written by accounts other than its owner`,
      });
      expect(install({ accounts: own })).toMatchObject({ ok: true });
    }
    chmodSync(home, 0o777);
    expect(install({ accounts: own })).toMatchObject({
      ok: false,
      reason: "unsafe",
      detail: `${home} can be written by accounts other than its owner`,
    });
    // This account's old line goes too: its hooks are not in the system config now.
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runner())).toBe(false);
  });

  it("does not let an extended ACL pass as the private group", () => {
    if (ME === 0) return; // root's line takes no group at all
    const home = dirname(myCli());
    const gid = statSync(home).gid;
    const own = { users: [{ name: "me", uid: ME, gid }], groups: [{ name: "me", gid, members: [] }], local: true };
    chmodSync(home, 0o775);
    expect(install({ accounts: { ...own, hasAcl: () => false } })).toMatchObject({ ok: true });
    expect(install({ accounts: { ...own, hasAcl: () => true } })).toMatchObject({
      ok: false,
      reason: "unsafe",
      detail: `${home} can be written by accounts other than its owner`,
    });
  });

  it("finds a real named-user ACL that grants write, as Linux shows it through the group bits", () => {
    if (ME === 0 || process.platform !== "linux") return;
    const setfacl = ["/usr/bin/setfacl", "/bin/setfacl"].find((p) => existsSync(p));
    if (!setfacl) return; // no acl tools on this machine
    const home = dirname(myCli());
    const gid = statSync(home).gid;
    const own = { users: [{ name: "me", uid: ME, gid }], groups: [{ name: "me", gid, members: [] }], local: true };
    chmodSync(home, 0o755);
    spawnSync(setfacl, ["-m", `u:${ME + 1}:rwx`, home]);
    // The ACL's mask now reads as the group's write bit.
    expect(statSync(home).mode & 0o020).toBe(0o020);
    expect(install({ accounts: own })).toMatchObject({
      ok: false,
      reason: "unsafe",
      detail: `${home} can be written by accounts other than its owner`,
    });
  });

  it("takes out an earlier block that runs this account's install when it refuses that install", () => {
    if (ME === 0) return; // root's line takes no group at all
    const cli = myCli();
    const home = dirname(cli);
    const gid = statSync(home).gid;
    // The install's directory is writable by a group other accounts are in.
    const shared = {
      users: [{ name: "me", uid: ME, gid }, { name: "other", uid: ME + 1, gid }],
      groups: [{ name: "me", gid, members: [] }],
      local: true,
    };
    chmodSync(home, 0o775);
    mkdirs(dirname(path()));
    writeConfig(path(), renderCodexManagedBlock(codexSystemHookEntries(cli)));
    expect(install({ accounts: shared })).toMatchObject({
      ok: false,
      reason: "unsafe",
      detail: `${home} can be written by accounts other than its owner`,
    });
    expect(existsSync(path())).toBe(false);
    expect(existsSync(runner())).toBe(false);
  });

  it("takes out an earlier block no account can keep when it refuses this account's install", () => {
    if (ME === 0) return; // root's line takes no group at all
    const home = dirname(myCli());
    const gid = statSync(home).gid;
    chmodSync(home, 0o775);
    // The program it ran is gone: no account owns it, and it is not another account's to keep.
    mkdirs(dirname(path()));
    writeConfig(path(), renderCodexManagedBlock(codexSystemHookEntries(join(dir, "gone", "failproofai"))));
    const notPrivate = { users: [{ name: "me", uid: ME, gid }], groups: [{ name: "me", gid, members: [] }], local: false };
    expect(install({ accounts: notPrivate })).toMatchObject({ ok: false, reason: "unsafe" });
    expect(existsSync(path())).toBe(false);
  });

  it("keeps another account's line that this account cannot read", () => {
    if (ME === 0) return; // root reads everything
    const locked = join(dir, "locked");
    const theirs = script(join(locked, "failproofai"), "true");
    expect(install({ uid: 4243 }, theirs)).toMatchObject({ ok: true });
    chmodSync(locked, 0o000);
    try {
      expect(install({ uid: 4242 })).toMatchObject({ ok: true, dropped: [] });
      expect(accounts()?.map((a) => a.uid)).toEqual([4242, 4243]);
      expect(refreshCodexSystemHooks({ path: path(), uid: 4242 })).toEqual({ status: "current", path: path() });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("does not bring back accounts from a runner whose block was taken out", () => {
    install({ uid: 4242 });
    install({ uid: 4243 });
    // Taken out by hand, or by an earlier version's uninstall: the runner stays.
    writeFileSync(path(), mergeCodexManagedBlock(readFileSync(path(), "utf8"), null));
    expect(install({ uid: 4242 })).toMatchObject({ ok: true });
    expect(accounts()?.map((a) => a.uid)).toEqual([4242]);
  });

  it("tidies away a runner no block runs, on update, once no install can be about to add its block", () => {
    install();
    writeFileSync(path(), mergeCodexManagedBlock(readFileSync(path(), "utf8"), null));
    // Just written: an install may be between writing the runner and the block.
    expect(refreshCodexSystemHooks({ path: path() })).toEqual({ status: "absent" });
    expect(existsSync(runner())).toBe(true);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(runner(), old, old);
    expect(refreshCodexSystemHooks({ path: path() })).toEqual({ status: "absent" });
    expect(existsSync(runner())).toBe(false);
  });

  it("writes the runner again when it was edited by hand or lost its mode", () => {
    expect(install()).toMatchObject({ ok: true });
    const written = readFileSync(runner(), "utf8");
    writeFileSync(runner(), written.replace("esac\n", "esac\nexit 0\n"));
    expect(refreshCodexSystemHooks({ path: path() })).toEqual({
      status: "rewritten",
      path: path(),
      runner: runner(),
      migrated: false,
      dropped: [],
    });
    expect(readFileSync(runner(), "utf8")).toBe(written);
    chmodSync(runner(), 0o644);
    expect(refreshCodexSystemHooks({ path: path() })).toMatchObject({ status: "rewritten", dropped: [] });
    expect(statSync(runner()).mode & 0o777).toBe(0o755);
    expect(refreshCodexSystemHooks({ path: path() })).toEqual({ status: "current", path: path() });
  });

  it("reads a block whose lines an editor turned into CRLF", () => {
    expect(install({ uid: 4242 })).toMatchObject({ ok: true });
    writeFileSync(path(), readFileSync(path(), "utf8").replace(/\n/g, "\r\n"));
    const text = readFileSync(path(), "utf8");
    expect(parseCodexManagedBlock(text)).toHaveLength(codex.eventTypes.length);
    // Still the runner's block: only the account it lists runs failproofai.
    expect(codexSystemHooksPresent({ path: path(), uid: 4242 })).toBe(true);
    expect(codexSystemHooksPresent({ path: path(), uid: 4243 })).toBe(false);
  });

  it("drains an event larger than a pipe holds for an account it does not run, rather than leave Codex writing", () => {
    install({ uid: 4242, programs: { sh: "/bin/sh", id: script(join(dir, "fake", "id"), 'echo "$FAKE_UID"'), cat: "/bin/cat" } });
    const text = readFileSync(path(), "utf8");
    const command = parseCodexManagedBlock(text.slice(text.indexOf(CODEX_MANAGED_BEGIN)))![0].command;
    const big = JSON.stringify({ hook_event_name: "PostToolUse", tool_response: "x".repeat(256 * 1024) });
    const result = spawnSync("/bin/sh", ["-c", command], {
      input: big,
      env: { ...process.env, FAKE_UID: "0" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("a block in the earlier format", () => {
  const path = () => join(dir, "etc", "codex", "config.toml");
  const runner = () => codexHookRunnerPath(path())!;
  const writeOlderBlock = (cli: string) => {
    mkdirs(dirname(path()));
    writeConfig(path(), renderCodexManagedBlock(codexSystemHookEntries(cli)));
  };

  it("is left as it is when everything it runs is root's alone", () => {
    writeOlderBlock("/bin/true");
    const before = readFileSync(path(), "utf8");
    expect(refreshCodexSystemHooks({ path: path() })).toEqual({ status: "current", path: path() });
    expect(readFileSync(path(), "utf8")).toBe(before);
    expect(existsSync(runner())).toBe(false);
  });

  it("asks no one for root, and fails no update, when it is not this account's", () => {
    if (ME === 0) return; // root owns every file here, so this account's files are root's alone
    writeOlderBlock(myCli()); // this test's install, seen from uid 4242
    const before = readFileSync(path(), "utf8");
    let asked = 0;
    const canElevate = () => {
      asked++;
      return true;
    };
    expect(refreshCodexSystemHooks({ path: path(), uid: 4242, direct: false, canElevate })).toEqual({
      status: "others",
      path: path(),
      reason: "they predate the hook runner",
    });
    expect(asked).toBe(0);
    expect(readFileSync(path(), "utf8")).toBe(before);
    // The account whose install it runs is asked, and told when root is not there.
    expect(refreshCodexSystemHooks({ path: path(), direct: false, canElevate: () => false })).toMatchObject({
      status: "needs-root",
    });
  });
});

describe("nsswitchIsLocal", () => {
  it("is local only when accounts, groups and supplementary groups come from local sources", () => {
    expect(nsswitchIsLocal("passwd: files systemd\ngroup: files systemd\n")).toBe(true);
    expect(nsswitchIsLocal("passwd: compat [NOTFOUND=return] files # comment\ngroup: files\n")).toBe(true);
    expect(nsswitchIsLocal("passwd: files systemd sss\ngroup: files systemd sss\n")).toBe(false);
    expect(nsswitchIsLocal("passwd: files\ngroup: files ldap\n")).toBe(false);
    expect(nsswitchIsLocal("passwd: files\ngroup: files\ninitgroups: files sss\n")).toBe(false);
    expect(nsswitchIsLocal("group: files\n")).toBe(false);
    expect(nsswitchIsLocal("")).toBe(false);
  });
});

describe("codexHookRunnerPath and codexTrustedOwners", () => {
  it("puts the runner in its own directory under /opt for Codex's config, and beside any other", () => {
    expect(codexHookRunnerPath("/etc/codex/config.toml")).toBe("/opt/failproofai-codex/codex-hook");
    expect(codexHookRunnerPath("/tmp/x/config.toml")).toBe("/tmp/x/failproofai-codex-hook");
    expect(codexHookRunnerPath(null)).toBeNull();
  });

  it("trusts root alone for Codex's config, and the directory's owner too for any other", () => {
    expect([...codexTrustedOwners("/etc/codex/config.toml")]).toEqual([0]);
    expect([...codexTrustedOwners(join(dir, "etc", "config.toml"))].sort()).toEqual([...new Set([0, ME])].sort());
    // A directory that does not exist yet: its nearest parent decides.
    expect([...codexTrustedOwners("/usr/share/fp-codex-nonexistent/config.toml")]).toEqual([0]);
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
