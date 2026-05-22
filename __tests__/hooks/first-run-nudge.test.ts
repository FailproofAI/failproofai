// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";

vi.mock("../../src/hooks/integrations", () => ({
  detectInstalledClis: vi.fn(),
  getIntegration: vi.fn(),
}));

vi.mock("../../src/hooks/manager", () => ({
  installHooks: vi.fn(async () => undefined),
}));

vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(async () => undefined),
}));

vi.mock("../../lib/telemetry-id", () => ({
  getInstanceId: vi.fn(() => "test-distinct-id"),
}));

function makeIntegration(displayName: string, scopes: readonly string[], installed: boolean) {
  return {
    id: displayName.toLowerCase(),
    displayName,
    scopes,
    eventTypes: [],
    getSettingsPath: vi.fn(),
    readSettings: vi.fn(),
    writeSettings: vi.fn(),
    buildHookEntry: vi.fn(),
    isFailproofaiHook: vi.fn(),
    writeHookEntries: vi.fn(),
    removeHooksFromFile: vi.fn(),
    hooksInstalledInSettings: vi.fn(() => installed),
    detectInstalled: vi.fn(),
  };
}

interface IO {
  stdin: PassThrough & { isTTY?: boolean };
  stdout: PassThrough & { isTTY?: boolean };
  output: string;
}

function makeIO(isTTY: boolean): IO {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  const stdout = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = isTTY;
  stdout.isTTY = isTTY;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const io = { stdin, stdout } as IO;
  Object.defineProperty(io, "output", { get: () => output });
  return io;
}

async function importModule() {
  return await import("../../src/hooks/first-run-nudge");
}

async function importMocks() {
  const integrations = await import("../../src/hooks/integrations");
  const manager = await import("../../src/hooks/manager");
  const telemetry = await import("../../src/hooks/hook-telemetry");
  return { integrations, manager, telemetry };
}

describe("hooks/first-run-nudge", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.FAILPROOFAI_NO_FIRST_RUN;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("returns immediately when FAILPROOFAI_NO_FIRST_RUN=1 (no detection, no telemetry)", async () => {
    process.env.FAILPROOFAI_NO_FIRST_RUN = "1";
    const { maybeRunFirstRunNudge } = await importModule();
    const { integrations, manager, telemetry } = await importMocks();

    await maybeRunFirstRunNudge(makeIO(true));

    expect(integrations.detectInstalledClis).not.toHaveBeenCalled();
    expect(manager.installHooks).not.toHaveBeenCalled();
    expect(telemetry.trackHookEvent).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("returns when no CLIs are detected", async () => {
    const { maybeRunFirstRunNudge } = await importModule();
    const { integrations, manager, telemetry } = await importMocks();
    vi.mocked(integrations.detectInstalledClis).mockReturnValue([]);

    await maybeRunFirstRunNudge(makeIO(true));

    expect(manager.installHooks).not.toHaveBeenCalled();
    expect(telemetry.trackHookEvent).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("returns when any detected CLI already has hooks installed in any scope", async () => {
    const { maybeRunFirstRunNudge } = await importModule();
    const { integrations, manager, telemetry } = await importMocks();
    vi.mocked(integrations.detectInstalledClis).mockReturnValue(["claude", "codex"] as never);
    const claudeInt = makeIntegration("Claude Code", ["user", "project", "local"], false);
    const codexInt = makeIntegration("Codex", ["user", "project"], true);
    vi.mocked(integrations.getIntegration).mockImplementation(
      (id: string) => (id === "claude" ? claudeInt : codexInt) as never,
    );

    await maybeRunFirstRunNudge(makeIO(true));

    expect(manager.installHooks).not.toHaveBeenCalled();
    expect(telemetry.trackHookEvent).not.toHaveBeenCalled();
  });

  it("non-TTY: prints hint and fires _skipped_noninteractive", async () => {
    const { maybeRunFirstRunNudge } = await importModule();
    const { integrations, manager, telemetry } = await importMocks();
    vi.mocked(integrations.detectInstalledClis).mockReturnValue(["claude"] as never);
    vi.mocked(integrations.getIntegration).mockReturnValue(
      makeIntegration("Claude Code", ["user"], false) as never,
    );

    const io = makeIO(false);
    await maybeRunFirstRunNudge(io);

    expect(io.output).toContain("No policies are installed");
    expect(io.output).toContain("Launching dashboard");
    expect(manager.installHooks).not.toHaveBeenCalled();
    expect(telemetry.trackHookEvent).toHaveBeenCalledWith(
      "test-distinct-id",
      "first_run_nudge_skipped_noninteractive",
      { detected_clis: ["claude"], detected_count: 1 },
    );
  });

  it("TTY accept (Y): fires _shown then _accepted, calls installHooks with detected CLIs, exits 0", async () => {
    const { maybeRunFirstRunNudge } = await importModule();
    const { integrations, manager, telemetry } = await importMocks();
    vi.mocked(integrations.detectInstalledClis).mockReturnValue(["claude", "codex"] as never);
    const intMap: Record<string, ReturnType<typeof makeIntegration>> = {
      claude: makeIntegration("Claude Code", ["user"], false),
      codex: makeIntegration("Codex", ["user"], false),
    };
    vi.mocked(integrations.getIntegration).mockImplementation(
      (id: string) => intMap[id] as never,
    );

    const io = makeIO(true);
    setTimeout(() => io.stdin.write("y\n"), 10);

    await expect(maybeRunFirstRunNudge(io)).rejects.toThrow("exit:0");

    expect(io.output).toContain("Failproof AI — first-run setup");
    expect(io.output).toContain("Claude Code, Codex");

    const calls = vi.mocked(telemetry.trackHookEvent).mock.calls;
    const events = calls.map((c) => c[1]);
    expect(events).toEqual(["first_run_nudge_shown", "first_run_nudge_accepted"]);
    expect(calls[1][2]).toMatchObject({
      detected_clis: ["claude", "codex"],
      detected_count: 2,
      target_scope: "user",
      source: "first-run-nudge",
    });

    expect(manager.installHooks).toHaveBeenCalledWith(
      undefined,
      "user",
      undefined,
      false,
      "first-run-nudge",
      undefined,
      false,
      ["claude", "codex"],
    );
  });

  it("TTY accept on empty Enter (default Y): runs installHooks", async () => {
    const { maybeRunFirstRunNudge } = await importModule();
    const { integrations, manager } = await importMocks();
    vi.mocked(integrations.detectInstalledClis).mockReturnValue(["claude"] as never);
    vi.mocked(integrations.getIntegration).mockReturnValue(
      makeIntegration("Claude Code", ["user"], false) as never,
    );

    const io = makeIO(true);
    setTimeout(() => io.stdin.write("\n"), 10);

    await expect(maybeRunFirstRunNudge(io)).rejects.toThrow("exit:0");
    expect(manager.installHooks).toHaveBeenCalled();
  });

  it("TTY decline (n): fires _declined with reason user_no, does NOT call installHooks, does NOT exit", async () => {
    const { maybeRunFirstRunNudge } = await importModule();
    const { integrations, manager, telemetry } = await importMocks();
    vi.mocked(integrations.detectInstalledClis).mockReturnValue(["claude"] as never);
    vi.mocked(integrations.getIntegration).mockReturnValue(
      makeIntegration("Claude Code", ["user"], false) as never,
    );

    const io = makeIO(true);
    setTimeout(() => io.stdin.write("n\n"), 10);

    await maybeRunFirstRunNudge(io);

    const events = vi.mocked(telemetry.trackHookEvent).mock.calls.map((c) => c[1]);
    expect(events).toEqual(["first_run_nudge_shown", "first_run_nudge_declined"]);
    const declined = vi
      .mocked(telemetry.trackHookEvent)
      .mock.calls.find((c) => c[1] === "first_run_nudge_declined")?.[2];
    expect(declined).toMatchObject({ reason: "user_no" });
    expect(manager.installHooks).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("TTY SIGINT: fires _declined with reason sigint and exits 130", async () => {
    // Mock readline so we can trigger the SIGINT handler directly — emulating
    // ^C through a PassThrough is brittle across Node versions.
    vi.doMock("node:readline", () => ({
      createInterface: () => {
        const handlers: Record<string, () => void> = {};
        return {
          on: (ev: string, cb: () => void) => {
            handlers[ev] = cb;
          },
          question: (_q: string, _cb: () => void) => {
            setImmediate(() => handlers["SIGINT"]?.());
          },
          close: () => {},
        };
      },
    }));

    const { maybeRunFirstRunNudge } = await importModule();
    const { integrations, manager, telemetry } = await importMocks();
    vi.mocked(integrations.detectInstalledClis).mockReturnValue(["claude"] as never);
    vi.mocked(integrations.getIntegration).mockReturnValue(
      makeIntegration("Claude Code", ["user"], false) as never,
    );

    const io = makeIO(true);
    await expect(maybeRunFirstRunNudge(io)).rejects.toThrow("exit:130");

    const declined = vi
      .mocked(telemetry.trackHookEvent)
      .mock.calls.find((c) => c[1] === "first_run_nudge_declined")?.[2];
    expect(declined).toMatchObject({ reason: "sigint" });
    expect(manager.installHooks).not.toHaveBeenCalled();
    vi.doUnmock("node:readline");
  });

  it("survives a broken integration.hooksInstalledInSettings (treats it as not-installed)", async () => {
    const { maybeRunFirstRunNudge } = await importModule();
    const { integrations, manager } = await importMocks();
    vi.mocked(integrations.detectInstalledClis).mockReturnValue(["claude"] as never);
    const broken = makeIntegration("Claude Code", ["user"], false);
    broken.hooksInstalledInSettings = vi.fn(() => {
      throw new Error("boom");
    });
    vi.mocked(integrations.getIntegration).mockReturnValue(broken as never);

    const io = makeIO(true);
    setTimeout(() => io.stdin.write("n\n"), 10);

    await maybeRunFirstRunNudge(io);

    expect(manager.installHooks).not.toHaveBeenCalled();
  });
});
