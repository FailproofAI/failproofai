// @vitest-environment node
/**
 * The version probe runs from inside the warm worker, so the assertions that
 * matter are about what it refuses to do: throw, reject, or hand back a string
 * that only looks like a version.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parseCliVersionOutput, probeCliVersion, resolveCliBinary } from "../../src/hooks/cli-version-probe";

describe("parseCliVersionOutput", () => {
  it("reads the plain shapes the vendors actually print", () => {
    // Every string here was captured from a live `--version` on a real machine.
    expect(parseCliVersionOutput("1.43.0\n")).toBe("1.43.0");
    expect(parseCliVersionOutput("0.147.0\n")).toBe("0.147.0");
    expect(parseCliVersionOutput("3000.4.25\n")).toBe("3000.4.25");
    expect(parseCliVersionOutput("2026.08.11-e8db854\n")).toBe("2026.08.11-e8db854");
  });

  it("strips the sentence punctuation Copilot prints after its version", () => {
    // `GitHub Copilot CLI 1.0.80.` — the trailing dot is prose, and keeping it
    // would make every comparison against a real version string fail.
    expect(parseCliVersionOutput("GitHub Copilot CLI 1.0.80.\nRun 'copilot update'...\n")).toBe("1.0.80");
  });

  it("ignores everything after the first non-empty line", () => {
    expect(parseCliVersionOutput("\n\n  droid 0.175.1  \nsome banner\n2.0.0\n")).toBe("0.175.1");
  });

  it("keeps a prerelease suffix intact", () => {
    expect(parseCliVersionOutput("1.0.1-beta.2\n")).toBe("1.0.1-beta.2");
  });

  it("returns null rather than an empty string for output with no version", () => {
    expect(parseCliVersionOutput("")).toBeNull();
    expect(parseCliVersionOutput("\n \n")).toBeNull();
  });

  it("returns null rather than dressing a failure up as a version", () => {
    // Observed live: the daemon's PATH could not resolve the `#!/usr/bin/env
    // node` shebang of three npm-installed CLIs, and an earlier first-line
    // fallback recorded the error text as the version. A wrong version is
    // worse than a missing one.
    expect(parseCliVersionOutput("/usr/bin/env: \u2018node\u2019: No such file or directory\n")).toBeNull();
    expect(parseCliVersionOutput("command not found\n")).toBeNull();
    expect(parseCliVersionOutput("nightly\n")).toBeNull();
  });

  it("bounds what it will record", () => {
    expect(parseCliVersionOutput(`1.${"9".repeat(200)}\n`)?.length).toBe(64);
  });
});

describe("resolveCliBinary", () => {
  it("returns null for a CLI it does not know", () => {
    expect(resolveCliBinary("not-a-real-cli")).toBeNull();
    expect(resolveCliBinary("")).toBeNull();
  });
});

describe("probeCliVersion", () => {
  it("calls back with null for an unknown CLI instead of throwing", async () => {
    const result = await new Promise<string | null>((resolve) => {
      expect(() => probeCliVersion("not-a-real-cli", resolve)).not.toThrow();
    });
    expect(result).toBeNull();
  });

  it("survives a callback that throws", async () => {
    // The callback runs on the event loop; an escaping throw there would be an
    // uncaught exception, which kills the worker.
    let ran = false;
    expect(() =>
      probeCliVersion("not-a-real-cli", () => {
        ran = true;
        throw new Error("caller blew up");
      }),
    ).not.toThrow();
    expect(ran).toBe(true);
  });

  it("calls back exactly once", async () => {
    let calls = 0;
    await new Promise<void>((resolve) => {
      probeCliVersion("not-a-real-cli", () => {
        calls++;
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
  });
});

/**
 * These actually fork. Everything above proves only the no-binary path, and the
 * mechanisms that matter here — the deadline, the SIGKILL escalation, the
 * once-only latch across `exit` AND `close` — live entirely in the spawn path.
 * Without these the whole file could be deleted with a green suite.
 */
describe("probeCliVersion: the spawn path", () => {
  let binDir: string;
  let originalPath: string | undefined;

  /** Plant an executable under a name the probe looks for, first on PATH. */
  function plant(name: string, script: string): void {
    const path = join(binDir, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    chmodSync(path, 0o755);
  }

  function probe(cli: string): Promise<string | null> {
    return new Promise((resolve) => probeCliVersion(cli, resolve));
  }

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "fpai-probe-bin-"));
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  it("reads a version off stdout", async () => {
    plant("goose", 'echo "1.43.0"');
    expect(await probe("goose")).toBe("1.43.0");
  });

  it("reads a version a vendor prints to stderr", async () => {
    // Recording nothing for those would be indistinguishable from "not installed".
    plant("goose", 'echo "2.0.0" >&2');
    expect(await probe("goose")).toBe("2.0.0");
  });

  it("still reads the version when the binary exits non-zero", async () => {
    plant("goose", 'echo "3.1.4"; exit 3');
    expect(await probe("goose")).toBe("3.1.4");
  });

  it("returns null for a binary that prints nothing", async () => {
    plant("goose", "exit 0");
    expect(await probe("goose")).toBeNull();
  });

  it("settles even when the binary ignores SIGTERM", async () => {
    // spawn's own `timeout` sends one SIGTERM and never escalates, so a child
    // that traps it is never reaped, `close` never fires, and the caller's
    // in-flight latch sticks for the life of the worker. SIGKILL cannot be
    // trapped, which is why the deadline sends it.
    plant("goose", 'trap "" TERM; echo "9.9.9"; sleep 30');
    process.env.FAILPROOFAI_PROBE_TIMEOUT_MS = "1000";
    const started = Date.now();
    const version = await probe("goose");
    expect(Date.now() - started).toBeLessThan(6000);
    expect(version).toBe("9.9.9");
    delete process.env.FAILPROOFAI_PROBE_TIMEOUT_MS;
  }, 15_000);

  it("calls back exactly once even though both exit and close fire", async () => {
    plant("goose", 'echo "1.2.3"');
    let calls = 0;
    await new Promise<void>((resolve) => {
      probeCliVersion("goose", () => {
        calls++;
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(1);
  });

  it("walks past a directory that happens to have the right name", () => {
    // `existsSync` says yes to a directory, so resolution used to stop there —
    // which would leave a genuinely installed CLI permanently unprobeable
    // behind a same-named decoy earlier on PATH. Asserted as "not the decoy"
    // rather than "null", so the test holds whether or not this machine has a
    // real goose further down PATH.
    const decoy = join(binDir, "goose");
    mkdirSync(decoy);
    expect(resolveCliBinary("goose")).not.toBe(decoy);
  });

  it("can run an npm-style `#!/usr/bin/env node` shim even with node off PATH", () => {
    // The daemon is a system service whose PATH has no nvm dir, so this
    // shebang fails and the CLI never runs — observed live for codex, copilot
    // and pi on a machine where all three work fine from a shell.
    plant("goose", "");
    writeFileSync(
      join(binDir, "goose"),
      '#!/usr/bin/env node\nconsole.log("5.5.5");\n',
      { mode: 0o755 },
    );
    chmodSync(join(binDir, "goose"), 0o755);
    // A PATH with neither node nor anything else useful on it.
    process.env.PATH = binDir;
    return probe("goose").then((v) => expect(v).toBe("5.5.5"));
  }, 15_000);

  it("walks past a non-executable file with the right name", () => {
    const decoy = join(binDir, "goose");
    writeFileSync(decoy, "#!/bin/sh\necho 0.0.0\n", { mode: 0o644 });
    chmodSync(decoy, 0o644);
    expect(resolveCliBinary("goose")).not.toBe(decoy);
  });
});
