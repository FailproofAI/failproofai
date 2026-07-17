// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The launcher must never shell out to find bun — it runs on every hook event,
// so resolution is an existsSync walk. Mocking child_process lets the "never
// spawns" test below prove that rather than assume it.
const spawnSync = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync }));

const LAUNCHER = "../../scripts/dev-hook.mjs";
const HOME = "/fake/home";

/** Every dep injected, so no test touches the real filesystem or env. */
function deps(overrides: Record<string, unknown> = {}) {
  return {
    env: {},
    platform: "linux",
    execPath: "/usr/bin/node",
    home: HOME,
    exists: () => false,
    readdir: () => [],
    ...overrides,
  };
}

/** exists() backed by an explicit set — anything else does not exist. */
function existsIn(...paths: string[]) {
  const set = new Set(paths);
  return (p: string) => set.has(p);
}

describe("findBun — locating the bun executable", () => {
  it("returns the first PATH entry that has bun", async () => {
    const { findBun } = await import(LAUNCHER);
    expect(
      findBun(deps({ env: { PATH: "/a:/b" }, exists: existsIn("/a/bun", "/b/bun") })),
    ).toBe("/a/bun");
  });

  it("skips PATH entries that do not have bun", async () => {
    const { findBun } = await import(LAUNCHER);
    expect(
      findBun(deps({ env: { PATH: "/empty:/also-empty:/b" }, exists: existsIn("/b/bun") })),
    ).toBe("/b/bun");
  });

  it("ignores empty PATH segments", async () => {
    const { findBun } = await import(LAUNCHER);
    expect(
      findBun(deps({ env: { PATH: "::/b:" }, exists: existsIn("/b/bun") })),
    ).toBe("/b/bun");
  });

  it("falls back to $BUN_INSTALL/bin when PATH has no bun", async () => {
    const { findBun } = await import(LAUNCHER);
    expect(
      findBun(deps({
        env: { PATH: "/nope", BUN_INSTALL: "/opt/bun" },
        exists: existsIn("/opt/bun/bin/bun"),
      })),
    ).toBe("/opt/bun/bin/bun");
  });

  // The macOS GUI-launch case: launchd builds PATH without ~/.zshrc, so
  // ~/.bun/bin is absent from the hook's PATH while bun is right there on disk.
  it("falls back to ~/.bun/bin — the macOS GUI-launch case", async () => {
    const { findBun } = await import(LAUNCHER);
    expect(
      findBun(deps({ env: { PATH: "/usr/bin" }, exists: existsIn(`${HOME}/.bun/bin/bun`) })),
    ).toBe(`${HOME}/.bun/bin/bun`);
  });

  it("falls back to Homebrew before /usr/local", async () => {
    const { findBun } = await import(LAUNCHER);
    expect(
      findBun(deps({
        env: { PATH: "/nope" },
        exists: existsIn("/opt/homebrew/bin/bun", "/usr/local/bin/bun"),
      })),
    ).toBe("/opt/homebrew/bin/bun");
  });

  it("skips the POSIX prefixes on win32", async () => {
    const { findBun } = await import(LAUNCHER);
    expect(
      findBun(deps({
        platform: "win32",
        env: { PATH: "C:\\nope" },
        exists: existsIn("/opt/homebrew/bin/bun", "/usr/local/bin/bun"),
      })),
    ).toBeNull();
  });

  // The load-bearing case. `npm i -g bun` puts bun in ONE nvm version's bin,
  // so `nvm use <other>` drops it off PATH entirely even though it still works.
  it("finds bun in another nvm version dir when the active node's dir has none", async () => {
    const { findBun } = await import(LAUNCHER);
    const nvm = `${HOME}/.nvm/versions/node`;
    expect(
      findBun(deps({
        env: { PATH: `${nvm}/v24.0.0/bin` },
        execPath: `${nvm}/v24.0.0/bin/node`,
        readdir: (p: string) => (p === nvm ? ["v20.1.0", "v24.0.0", "v26.5.0"] : []),
        exists: existsIn(`${nvm}/v26.5.0/bin/bun`),
      })),
    ).toBe(`${nvm}/v26.5.0/bin/bun`);
  });

  it("prefers the newest nvm version when several have bun", async () => {
    const { findBun } = await import(LAUNCHER);
    const nvm = `${HOME}/.nvm/versions/node`;
    expect(
      findBun(deps({
        env: { PATH: "/nope" },
        readdir: (p: string) => (p === nvm ? ["v20.1.0", "v26.5.0"] : []),
        exists: existsIn(`${nvm}/v20.1.0/bin/bun`, `${nvm}/v26.5.0/bin/bun`),
      })),
    ).toBe(`${nvm}/v26.5.0/bin/bun`);
  });

  // Only the executable *name* is platform-driven here — PATH splitting and
  // joining come from the host's node:path, so these run with POSIX-shaped
  // dirs even while asserting win32 naming.
  it("prefers bun.exe over bare bun on win32", async () => {
    const { findBun } = await import(LAUNCHER);
    expect(
      findBun(deps({
        platform: "win32",
        env: { PATH: "/tools" },
        exists: existsIn("/tools/bun.exe", "/tools/bun"),
      })),
    ).toBe("/tools/bun.exe");
  });

  it("returns null when bun exists nowhere", async () => {
    const { findBun } = await import(LAUNCHER);
    expect(findBun(deps({ env: { PATH: "/a:/b" } }))).toBeNull();
  });

  it("does not probe the same directory twice", async () => {
    const { findBun } = await import(LAUNCHER);
    const seen: string[] = [];
    findBun(deps({
      // /usr/local/bin appears on PATH *and* as a hardcoded prefix; the node
      // execPath sibling duplicates a PATH entry too.
      env: { PATH: "/usr/local/bin:/usr/bin" },
      execPath: "/usr/bin/node",
      exists: (p: string) => {
        seen.push(p);
        return false;
      },
    }));
    expect(seen).toStrictEqual([...new Set(seen)]);
  });

  it("never spawns a subprocess", async () => {
    const { findBun } = await import(LAUNCHER);
    spawnSync.mockClear();
    findBun(deps({ env: { PATH: "/a:/b" } }));
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe("findNpm", () => {
  it("finds npm on PATH", async () => {
    const { findNpm } = await import(LAUNCHER);
    expect(findNpm(deps({ env: { PATH: "/usr/bin" }, exists: existsIn("/usr/bin/npm") }))).toBe(
      "/usr/bin/npm",
    );
  });

  it("returns null when npm is absent", async () => {
    const { findNpm } = await import(LAUNCHER);
    expect(findNpm(deps({ env: { PATH: "/usr/bin" } }))).toBeNull();
  });

  it("prefers npm.cmd over bare npm on win32", async () => {
    const { findNpm } = await import(LAUNCHER);
    expect(
      findNpm(deps({
        platform: "win32",
        env: { PATH: "/tools" },
        exists: existsIn("/tools/npm.cmd", "/tools/npm"),
      })),
    ).toBe("/tools/npm.cmd");
  });
});

describe("resolveDevSpawn", () => {
  it("pairs the resolved bun with the real binary's absolute path", async () => {
    const { resolveDevSpawn } = await import(LAUNCHER);
    const spawn = resolveDevSpawn(deps({ env: { PATH: "/a" }, exists: existsIn("/a/bun") }));
    expect(spawn.cmd).toBe("/a/bun");
    expect(spawn.args).toStrictEqual([resolve(process.cwd(), "bin", "failproofai.mjs")]);
  });

  it("returns null when bun is unfindable", async () => {
    const { resolveDevSpawn } = await import(LAUNCHER);
    expect(resolveDevSpawn(deps({ env: { PATH: "/a" } }))).toBeNull();
  });
});

describe("bunMissingMessage", () => {
  it("is a single actionable line — it can fire on all 26 events", async () => {
    const { bunMissingMessage } = await import(LAUNCHER);
    const msg = bunMissingMessage();
    expect(msg).not.toContain("\n");
    expect(msg).toContain("bun.sh/install");
  });
});

// Every CLI except Claude and Factory reads its deny decision as JSON on the
// hook's stdout. One stray byte from the launcher corrupts that parse and turns
// a denial into a silent allow, so the launcher must never write there at all.
describe("stdout purity", () => {
  /** Launcher source with comments stripped — prose may discuss stdout freely. */
  function launcherCode() {
    const src = readFileSync(resolve(process.cwd(), "scripts", "dev-hook.mjs"), "utf8");
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  it("the launcher source never writes to stdout", () => {
    expect(launcherCode()).not.toMatch(/console\.log|process\.stdout/);
  });

  it("never hands a subprocess our stdout to write to", () => {
    // The delegate spawn inherits all three fds on purpose — that is the whole
    // point, the child owns the contract. Every *other* spawn (npm, bun build)
    // must discard its stdout instead.
    expect(launcherCode().match(/stdio:\s*"inherit"/g) ?? []).toHaveLength(1);
  });
});
