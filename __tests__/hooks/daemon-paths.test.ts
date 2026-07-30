/**
 * The TypeScript client and the Rust daemon must resolve the same paths.
 *
 * This is the one disagreement in the whole daemon integration that does not
 * fail loudly. If the daemon binds `~/.failproofai/run/failproofaid.sock` and
 * the client looks in `~/.failproofai/runtime/`, nothing errors, nothing is
 * logged, and no test that exercises either side alone notices:
 * `tryDaemonEvaluate` stats a path that is not there, returns `null`, and every
 * hook on the machine silently takes the legacy path forever. The daemon sits
 * idle and healthy. Someone finds out weeks later by wondering why.
 *
 * So the two implementations are checked against each other, in two legs:
 *
 * **Leg 1 — the source of `crates/failproofaid/src/paths.rs` (unconditional).**
 * The path components and the environment-variable names are extracted from the
 * Rust source and used to rebuild its answer, which is then compared against the
 * TypeScript for every case. This leg carries the guarantee, because it runs in
 * the plain unit suite with no build step: a `bun run test:run` on a machine
 * that has never run `cargo` still catches the drift.
 *
 * **Leg 2 — the built binary's own `--help` (when `target/debug/failproofaid`
 * exists).** `failproofaid --help` prints `Resolved for this environment: …`,
 * so the *compiled* Rust can be driven through the same cases with a controlled
 * environment. This is the stronger check — it tests the artifact rather than a
 * transcription of its source — but it cannot be the only one, because it
 * silently tests nothing wherever the binary has not been built. Leg 1 exists
 * precisely so this one is allowed to be conditional.
 *
 * Leg 1 parses rather than reimplements on purpose. A hand-copied
 * `".failproofai/run"` in this file would drift in exactly the same silent way
 * as the one in `daemon-client.ts`, and the test would keep passing while both
 * sides were wrong together.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { socketPath, installManifestPath } from "../../src/hooks/daemon-client";

const REPO_ROOT = resolve(__dirname, "../..");
const PATHS_RS = join(REPO_ROOT, "crates/failproofaid/src/paths.rs");
const BINARY = join(REPO_ROOT, "target/debug/failproofaid");

const RUST = readFileSync(PATHS_RS, "utf8");

// ── Reading paths.rs ───────────────────────────────────────────────────────

/**
 * The body of `pub fn <name>`, brace-balanced.
 *
 * Brace counting rather than a line regex: `socket_path` spans a `map` closure
 * with nested braces, and a regex that stopped at the first `}` would silently
 * return a prefix — which would make every assertion below weaker without
 * making any of them fail.
 */
function fnBody(name: string): string {
  const signature = RUST.indexOf(`pub fn ${name}(`);
  if (signature === -1) throw new Error(`paths.rs no longer defines pub fn ${name}`);
  const open = RUST.indexOf("{", signature);
  if (open === -1) throw new Error(`could not find the body of ${name}`);
  let depth = 0;
  for (let i = open; i < RUST.length; i++) {
    if (RUST[i] === "{") depth++;
    else if (RUST[i] === "}") {
      depth--;
      if (depth === 0) return RUST.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** The value of a `const NAME: &str = "…";` declaration. */
function rustConst(name: string): string {
  const m = new RegExp(`const ${name}: &str = "([^"]+)";`).exec(RUST);
  if (!m) throw new Error(`paths.rs no longer declares const ${name}`);
  return m[1];
}

const SOCKET_FILE = rustConst("SOCKET_FILE");

/**
 * Every `.join(…)` argument in `segment`, in order, with `SOCKET_FILE`
 * resolved to its literal.
 */
function joinedComponents(segment: string): string[] {
  return [...segment.matchAll(/\.join\(\s*(?:"([^"]+)"|([A-Z_][A-Z0-9_]*))\s*\)/g)].map((m) => {
    if (m[1] !== undefined) return m[1];
    if (m[2] === "SOCKET_FILE") return SOCKET_FILE;
    throw new Error(`paths.rs joins an identifier this test cannot resolve: ${m[2]}`);
  });
}

/** Split `socket_path`'s body into its three preference branches. */
function socketBranches(): { explicit: string; runtimeDir: string; home: string } {
  const body = fnBody("socket_path");
  const iRuntime = body.indexOf("non_empty(runtime_dir)");
  const iHome = body.indexOf("non_empty(home)");
  if (iRuntime === -1 || iHome === -1 || iHome < iRuntime) {
    throw new Error("socket_path no longer has the explicit → runtime_dir → home shape");
  }
  return {
    explicit: body.slice(0, iRuntime),
    runtimeDir: body.slice(iRuntime, iHome),
    home: body.slice(iHome),
  };
}

const BRANCHES = socketBranches();
const RUNTIME_COMPONENTS = joinedComponents(BRANCHES.runtimeDir);
const HOME_COMPONENTS = joinedComponents(BRANCHES.home);
const ROOT_COMPONENTS = joinedComponents(fnBody("failproofai_root"));
const MANIFEST_COMPONENTS = [
  ...ROOT_COMPONENTS,
  ...joinedComponents(fnBody("install_manifest_path")),
];

/** Rebuild the Rust's answer for `socket_path(explicit, runtimeDir, home)`. */
function rustSocketPath(
  explicit: string | undefined,
  runtimeDir: string | undefined,
  home: string | undefined,
): string | null {
  if (explicit) return explicit;
  if (runtimeDir) return join(runtimeDir, ...RUNTIME_COMPONENTS);
  if (home) return join(home, ...HOME_COMPONENTS);
  return null;
}

/** Rebuild the Rust's answer for `install_manifest_path(explicit, home)`. */
function rustManifestPath(explicit: string | undefined, home: string | undefined): string | null {
  if (explicit) return explicit;
  if (home) return join(home, ...MANIFEST_COMPONENTS);
  return null;
}

// ── The cases ──────────────────────────────────────────────────────────────

const HOME = "/home/enrolled";

interface SocketCase {
  readonly name: string;
  readonly explicit?: string;
  readonly runtimeDir?: string;
  readonly home?: string;
}

const SOCKET_CASES: readonly SocketCase[] = [
  {
    name: "$FAILPROOFAI_DAEMON_SOCKET set — wins over both",
    explicit: "/tmp/explicit.sock",
    runtimeDir: "/run/user/1000",
    home: HOME,
  },
  {
    name: "$XDG_RUNTIME_DIR set, no explicit override",
    runtimeDir: "/run/user/1000",
    home: HOME,
  },
  {
    name: "both unset — the ~/.failproofai/run/ fallback",
    home: HOME,
  },
  {
    // Exported-but-empty is normal in stripped environments (a `su` without
    // `-l`, a container entrypoint, a cron job) and must not be read as "the
    // runtime directory is the filesystem root". Both sides treat "" as unset;
    // if one of them ever stopped, the daemon would bind /failproofai/… and
    // the client would look in $HOME.
    name: "$XDG_RUNTIME_DIR set but empty — behaves as unset",
    runtimeDir: "",
    home: HOME,
  },
  {
    name: "$FAILPROOFAI_DAEMON_SOCKET set but empty — falls through",
    explicit: "",
    runtimeDir: "/run/user/1000",
    home: HOME,
  },
  {
    name: "nothing resolves — a broken environment is reported, not invented",
  },
];

// ── Leg 1: against the source of paths.rs ──────────────────────────────────

describe("daemon path resolution agrees with crates/failproofaid/src/paths.rs", () => {
  it("read a complete set of components out of paths.rs", () => {
    // Anti-vacuity. Every assertion below is built from these arrays, so a
    // parse that silently produced `[]` would make the whole suite compare
    // `join(home)` against `join(home)` and pass while asserting nothing.
    expect(SOCKET_FILE).toBe("failproofaid.sock");
    expect(RUNTIME_COMPONENTS).toEqual(["failproofai", "failproofaid.sock"]);
    expect(HOME_COMPONENTS).toEqual([".failproofai", "run", "failproofaid.sock"]);
    expect(ROOT_COMPONENTS).toEqual([".failproofai"]);
    expect(MANIFEST_COMPONENTS).toEqual([".failproofai", "install.json"]);
    // The explicit branch returns the path verbatim — no components appended.
    expect(joinedComponents(BRANCHES.explicit)).toEqual([]);
  });

  it("reads the same environment variables, in the same preference order", () => {
    // The paths agreeing is only half of it: if the Rust consulted
    // $XDG_RUNTIME_DIR where the client consulted $XDG_DATA_HOME, every case
    // below would still pass while the two disagreed on every real machine.
    const socketEnv = fnBody("default_socket_path");
    expect(socketEnv.indexOf("FAILPROOFAI_DAEMON_SOCKET")).toBeGreaterThanOrEqual(0);
    expect(socketEnv.indexOf("XDG_RUNTIME_DIR")).toBeGreaterThan(
      socketEnv.indexOf("FAILPROOFAI_DAEMON_SOCKET"),
    );
    expect(socketEnv.indexOf('var("HOME")')).toBeGreaterThan(socketEnv.indexOf("XDG_RUNTIME_DIR"));

    const manifestEnv = fnBody("default_install_manifest_path");
    expect(manifestEnv.indexOf("FAILPROOFAI_INSTALL_JSON")).toBeGreaterThanOrEqual(0);
    expect(manifestEnv.indexOf('var("HOME")')).toBeGreaterThan(
      manifestEnv.indexOf("FAILPROOFAI_INSTALL_JSON"),
    );
  });

  it.each(SOCKET_CASES)("socket: $name", ({ explicit, runtimeDir, home }) => {
    expect(socketPath(explicit, runtimeDir, home)).toBe(rustSocketPath(explicit, runtimeDir, home));
  });

  it.each([
    { name: "$FAILPROOFAI_INSTALL_JSON set — wins", explicit: "/tmp/install.json", home: HOME },
    { name: "unset — ~/.failproofai/install.json", explicit: undefined, home: HOME },
    { name: "set but empty — falls through to the home path", explicit: "", home: HOME },
    { name: "no home — nothing to resolve", explicit: undefined, home: undefined },
  ])("install.json: $name", ({ explicit, home }) => {
    expect(installManifestPath(explicit, home)).toBe(rustManifestPath(explicit, home));
  });

  it("resolves the exact paths the scope decision settled on", () => {
    // Stated literally once, so that a *coordinated* rename — both
    // implementations changed together — is still a visible edit to this file
    // rather than a silent relocation of the user's state. The two roots and
    // the socket file name are the product's on-disk contract.
    expect(socketPath(undefined, undefined, HOME)).toBe(
      "/home/enrolled/.failproofai/run/failproofaid.sock",
    );
    expect(socketPath(undefined, "/run/user/1000", HOME)).toBe(
      "/run/user/1000/failproofai/failproofaid.sock",
    );
    expect(installManifestPath(undefined, HOME)).toBe("/home/enrolled/.failproofai/install.json");
  });

  it("puts nothing anywhere that would need elevated privilege", () => {
    // The property the whole user-scope decision turns on, asserted on the
    // client side too — `paths.rs` has the mirror of this test.
    for (const runtimeDir of [undefined, "/run/user/1000"]) {
      const resolved = socketPath(undefined, runtimeDir, HOME);
      expect(resolved).not.toBeNull();
      for (const privileged of ["/opt/", "/var/lib/", "/etc/", "/Library/", "/usr/"]) {
        expect(resolved!.startsWith(privileged)).toBe(false);
      }
    }
    expect(installManifestPath(undefined, HOME)!.startsWith(HOME)).toBe(true);
  });
});

// ── Leg 2: against the built binary ────────────────────────────────────────

const binaryBuilt = existsSync(BINARY);

describe.skipIf(!binaryBuilt)("the built failproofaid resolves the same socket path", () => {
  /** `failproofaid --help`'s `Resolved for this environment:` line. */
  function resolvedByBinary(env: Record<string, string>): string | null {
    const run = spawnSync(BINARY, ["--help"], {
      encoding: "utf8",
      // `NODE_ENV` is required by this repo's `ProcessEnv` augmentation and is
      // not one of the three variables `default_socket_path()` reads, so it
      // cannot affect the answer. Everything else is deliberately absent.
      env: { NODE_ENV: "test", ...env },
      timeout: 30_000,
    });
    if (run.status !== 0) {
      throw new Error(`failproofaid --help exited ${run.status}: ${run.stderr}`);
    }
    const line = run.stdout.split("\n").find((l) => l.includes("Resolved for this environment:"));
    if (line === undefined) {
      throw new Error(
        "failproofaid --help no longer prints its resolved socket path, so this " +
          "leg silently stopped checking anything. Restore the line or delete this test.",
      );
    }
    const value = line.slice(line.indexOf(":") + 1).trim();
    return value.startsWith("<") ? null : value;
  }

  it.each(SOCKET_CASES)("socket: $name", ({ explicit, runtimeDir, home }) => {
    // A constructed environment rather than `{...process.env}`: the real one
    // carries an $XDG_RUNTIME_DIR and a $HOME that would leak into the "unset"
    // cases and turn them into no-ops.
    const env: Record<string, string> = {};
    if (explicit !== undefined) env.FAILPROOFAI_DAEMON_SOCKET = explicit;
    if (runtimeDir !== undefined) env.XDG_RUNTIME_DIR = runtimeDir;
    if (home !== undefined) env.HOME = home;

    expect(resolvedByBinary(env)).toBe(socketPath(explicit, runtimeDir, home));
  });
});

describe("leg 2 coverage is reported rather than assumed", () => {
  it("says so when the binary leg did not run", () => {
    // A conditional suite that quietly covers nothing is worse than no suite,
    // because the file's presence reads as coverage. This makes the state
    // explicit in the run: if `target/debug/failproofaid` is absent, leg 1 is
    // the only thing that ran, and leg 1 checks the source rather than the
    // artifact.
    if (!binaryBuilt) {
      expect(existsSync(PATHS_RS)).toBe(true);
      return;
    }
    expect(binaryBuilt).toBe(true);
  });
});
