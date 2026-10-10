// @vitest-environment node
/**
 * `launch()` end to end, with the server process faked: what it spawns, what it
 * prints and when. The child is an event emitter with two streams, and the
 * machine facts are stubbed, so nothing starts, listens or reads the real home.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  gatherLaunchFacts: vi.fn(() => ({
    policies: "10 on from FailproofAI/policies@06b802b",
    agents: "1 traced: Claude Code",
    cloud: "Not connected",
    notEnforcing: false,
  })),
}));
vi.mock("child_process", () => ({ spawn: h.spawn }));
vi.mock("../../scripts/launch-facts", () => ({ gatherLaunchFacts: h.gatherLaunchFacts }));
// The readiness probe must never open a real socket from a test, even one
// whose server never says it is ready.
vi.mock("node:net", () => ({
  connect: vi.fn(() => {
    throw new Error("no sockets in unit tests");
  }),
}));

import { launch } from "../../scripts/launch";

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough };

const READY = ["▲ Next.js 16.3.6", "- Local:         http://127.0.0.1:8020", "- Network:       http://127.0.0.1:8020", "✓ Ready in 9ms"];
const ENV_KEYS = [
  "FAILPROOFAI_PACKAGE_ROOT",
  "FAILPROOFAI_DASHBOARD_HOST",
  "FAILPROOFAI_LAUNCH_CWD",
  "FORCE_COLOR",
  "NO_COLOR",
  "PORT",
  "HOSTNAME",
] as const;

let pkgRoot: string;
let child: FakeChild;
let out: string[];
let err: string[];
let savedEnv: Record<string, string | undefined>;
let savedArgv: string[];
let savedIsTTY: PropertyDescriptor | undefined;
let exit: ReturnType<typeof vi.spyOn>;

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function setStdoutTTY(isTTY: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true, writable: true });
}

const printed = () => out.join("");
const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");

beforeEach(() => {
  // Timers only, so the 5s probe and the 30s deadline never fire after a test
  // ends; the streams run on nextTick and setImmediate, which stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  pkgRoot = mkdtempSync(join(tmpdir(), "fpai-launch-pkg-"));
  mkdirSync(join(pkgRoot, ".next", "standalone"), { recursive: true });
  writeFileSync(join(pkgRoot, ".next", "standalone", "server.js"), "// never run\n");
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.FAILPROOFAI_PACKAGE_ROOT = pkgRoot;
  savedArgv = process.argv;
  process.argv = ["node", "failproofai"];
  savedIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  setStdoutTTY(false);

  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  h.spawn.mockReset();
  h.spawn.mockReturnValue(child);
  h.gatherLaunchFacts.mockClear();
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.argv = savedArgv;
  if (savedIsTTY) Object.defineProperty(process.stdout, "isTTY", savedIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(pkgRoot, { recursive: true, force: true });
});

describe("launch('start')", () => {
  it("spawns the standalone server with piped output, and no forced colour when piped", () => {
    launch("start");
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = h.spawn.mock.calls[0];
    expect(cmd).toBe("node");
    expect(args).toEqual([join(pkgRoot, ".next", "standalone", "server.js")]);
    expect(opts.stdio).toEqual(["inherit", "pipe", "pipe"]);
    expect(opts.env.FORCE_COLOR).toBeUndefined();
    expect(opts.env.PORT).toBe("8020");
    expect(opts.env.HOSTNAME).toBe("127.0.0.1");
  });

  it("forces the child's colour only when failproofai itself writes to a terminal", () => {
    setStdoutTTY(true);
    launch("start");
    expect(h.spawn.mock.calls[0][2].env.FORCE_COLOR).toBe("1");
  });

  it("prints the screen once the server says it is listening, and not before", async () => {
    launch("start");
    expect(printed()).toBe("");
    child.stdout.write(`${READY.join("\n")}\n`);
    await drain();
    const screen = strip(printed());
    expect(screen).toContain("DASHBOARD");
    expect(screen).toContain("  url        http://127.0.0.1:8020  ● live");
    expect(screen).toContain("  policies   10 on from FailproofAI/policies@06b802b");
    expect(screen).toContain("ctrl+c stop the dashboard");
    // Next's own banner said none of this.
    expect(screen).not.toContain("Next.js");
    expect(screen).not.toContain("- Local:");
    expect(h.gatherLaunchFacts).toHaveBeenCalledWith(process.cwd());
  });

  it("reads the project from the same directory the dashboard is told about", async () => {
    process.env.FAILPROOFAI_LAUNCH_CWD = "/work/some-project";
    launch("start");
    expect(h.spawn.mock.calls[0][2].env.FAILPROOFAI_LAUNCH_CWD).toBe("/work/some-project");
    child.stdout.write(`${READY.join("\n")}\n`);
    await drain();
    expect(h.gatherLaunchFacts).toHaveBeenCalledWith("/work/some-project");
  });

  it("draws no art when piped", async () => {
    launch("start");
    child.stdout.write(`${READY.join("\n")}\n`);
    await drain();
    expect(printed()).not.toMatch(/[▀▄█]/);
    expect(printed()).not.toContain("\x1B");
  });

  it("draws the logomark on a terminal, unless the setup wizard already drew it", async () => {
    setStdoutTTY(true);
    launch("start");
    child.stdout.write(`${READY.join("\n")}\n`);
    await drain();
    expect(printed()).toMatch(/[▀▄█]/);

    out.length = 0;
    child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    h.spawn.mockReturnValue(child);
    launch("start", { logo: false });
    child.stdout.write(`${READY.join("\n")}\n`);
    await drain();
    expect(strip(printed())).toContain("DASHBOARD");
    expect(printed()).not.toMatch(/[▀▄█]/);
  });

  it("reads a terminal that reports 0 columns as unknown width, not too narrow for the art", async () => {
    setStdoutTTY(true);
    const savedColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 0, configurable: true, writable: true });
    try {
      launch("start");
      child.stdout.write(`${READY.join("\n")}\n`);
      await drain();
      expect(printed()).toMatch(/[▀▄█]/);
    } finally {
      if (savedColumns) Object.defineProperty(process.stdout, "columns", savedColumns);
      else delete (process.stdout as { columns?: number }).columns;
    }
  });

  it("prints no screen for audit's hand-off, which keeps its own lines", async () => {
    launch("start", { screen: false });
    child.stdout.write(`${READY.join("\n")}\n`);
    child.stdout.write("GET /audit 200 in 40ms\n");
    await drain();
    expect(printed()).toBe("GET /audit 200 in 40ms\n");
    expect(h.gatherLaunchFacts).not.toHaveBeenCalled();
  });

  it("still warns about an exposed bind on audit's hand-off, before anything listens", () => {
    process.env.FAILPROOFAI_DASHBOARD_HOST = "0.0.0.0";
    launch("start", { screen: false });
    const warned = strip(err.join(""));
    expect(warned).toContain("▲ The dashboard is bound to 0.0.0.0");
    expect(warned).toContain("  unset FAILPROOFAI_DASHBOARD_HOST");
  });

  it("carries the exposed bind as the screen's one attention line", async () => {
    process.env.FAILPROOFAI_DASHBOARD_HOST = "0.0.0.0";
    h.gatherLaunchFacts.mockReturnValueOnce({
      policies: "none on",
      agents: "none traced",
      cloud: "Not connected",
      notEnforcing: true,
    });
    launch("start");
    expect(err.join("")).toBe("");
    child.stdout.write(`${READY.join("\n")}\n`);
    await drain();
    const screen = strip(printed());
    expect(screen).toContain("  url        http://127.0.0.1:8020  ● live");
    expect(screen.split("\n").filter((l) => l.startsWith("▲"))).toEqual([
      expect.stringContaining("bound to 0.0.0.0"),
    ]);
  });

  it("says the port is taken and exits with the server's code when it dies before listening", async () => {
    launch("start");
    child.stderr.write("⨯ Failed to start server\nError: listen EADDRINUSE: address already in use 127.0.0.1:8020\n");
    await drain();
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    const said = strip(err.join(""));
    expect(said).toContain("✕ Port 8020 is already in use, so the dashboard did not start.");
    expect(said).not.toContain("EADDRINUSE");
    expect(exit).toHaveBeenCalledWith(1);
    expect(printed()).toBe("");
  });

  it("passes the server's exit code on once it is running", async () => {
    launch("start");
    child.stdout.write(`${READY.join("\n")}\n`);
    await drain();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("launch('dev')", () => {
  it("prints the screen up front, marked as starting, and leaves Next's output alone", () => {
    process.argv = ["node", "dev.ts", "--port", "8020"];
    launch("dev");
    const screen = strip(printed());
    expect(screen).toContain("  url        http://127.0.0.1:8020  ○ starting");
    const [cmd, args, opts] = h.spawn.mock.calls[0];
    expect(cmd).toBe("bunx");
    expect(args).toEqual(["--bun", "next", "dev", "-H", "127.0.0.1", "--port", "8020"]);
    expect(opts.stdio).toBe("inherit");
    expect(opts.env.FORCE_COLOR).toBeUndefined();
  });
});

describe("the entry points' hand-off to launch()", () => {
  // Both are one line in files the suite cannot drive end to end without a
  // terminal (the wizard) or a real scan, so the wiring itself is pinned.
  const read = (rel: string) => readFileSync(join(__dirname, "..", "..", rel), "utf8");

  it("skips the launch logomark when the first-run wizard already drew one", () => {
    const bin = read("bin/failproofai.mjs");
    expect(bin).toContain("setupWizardRan = await maybeFirstRunConfigure(");
    expect(bin).toContain('launch("start", { logo: !setupWizardRan });');
  });

  it("starts audit's dashboard with no launch screen", () => {
    expect(read("src/audit/cli.ts")).toContain('launch("start", { screen: false });');
  });
});
