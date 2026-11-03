// @vitest-environment node
/**
 * Readiness for the launch screen: Next's ready line, the TCP probe fallback,
 * a server that dies before it listens, and one that never answers. Driven
 * with a fake child process and fake streams, so no server ever starts and no
 * socket is opened.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const net = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:net", () => ({ connect: net.connect }));

import {
  dashboardProbeHost,
  dashboardStartupCause,
  probeDashboardPort,
  watchDashboardStart,
  type DashboardStartOutcome,
} from "../../scripts/launch-ready";

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough };

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
}

/** Let the streams and readline deliver what was written. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

interface Rig {
  child: FakeChild;
  log: string[];
  outcomes: DashboardStartOutcome[];
  exits: Array<[number | null, Error | undefined]>;
  probe: ReturnType<typeof vi.fn>;
}

function rig(probeAnswers: boolean[] = []): Rig {
  const child = fakeChild();
  const log: string[] = [];
  const outcomes: DashboardStartOutcome[] = [];
  const exits: Array<[number | null, Error | undefined]> = [];
  const answers = [...probeAnswers];
  const probe = vi.fn(async () => answers.shift() ?? false);
  watchDashboardStart({
    child,
    stdout: { write: (chunk: string) => log.push(`out:${chunk.replace(/\n$/, "")}`) },
    stderr: { write: (chunk: string) => log.push(`err:${chunk.replace(/\n$/, "")}`) },
    probe,
    onSettled: (outcome) => {
      outcomes.push(outcome);
      log.push(`settled:${outcome.kind}`);
    },
    onExit: (code, error) => exits.push([code, error]),
  });
  return { child, log, outcomes, exits, probe };
}

const BANNER = [
  "\x1B[1m\x1B[35m▲ Next.js 16.3.6\x1B[39m\x1B[22m",
  "- Local:         http://127.0.0.1:8020",
  "- Network:       http://127.0.0.1:8020",
  "\x1B[32m\x1B[1m✓\x1B[22m\x1B[39m Ready in 112ms",
];

// What Next's standalone server writes to stderr when 8020 is taken.
const EADDRINUSE_DUMP = [
  "\x1B[31m\x1B[1m⨯\x1B[22m\x1B[39m Failed to start server",
  "Error: listen EADDRINUSE: address already in use 127.0.0.1:8020",
  "    at Server.setupListenHandle [as _listen2] (node:net:1940:16)",
  "    at listenInCluster (node:net:1997:12)",
  "  code: 'EADDRINUSE',",
  "  port: 8020",
  "}",
];

beforeEach(() => {
  // Timers only: the streams run on nextTick and setImmediate, which stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watchDashboardStart — the ready line", () => {
  it("settles on Next's ready line, swallows its banner, and releases held output after the screen", async () => {
    const r = rig();
    r.child.stdout.write("instrumentation registered\n");
    await drain();
    r.child.stderr.write("(node:1) ExperimentalWarning: something\n");
    await drain();
    expect(r.log).toEqual([]);

    r.child.stdout.write(`${BANNER.join("\n")}\n`);
    await drain();
    expect(r.outcomes).toEqual([{ kind: "ready", via: "ready-line" }]);
    expect(r.log).toEqual([
      "settled:ready",
      "out:instrumentation registered",
      "err:(node:1) ExperimentalWarning: something",
    ]);

    // From here on, everything passes straight through.
    r.child.stdout.write("GET /policies 200 in 8ms\n");
    r.child.stderr.write("⚠ a later warning\n");
    await drain();
    expect(r.log.slice(3)).toEqual(["out:GET /policies 200 in 8ms", "err:⚠ a later warning"]);
    expect(r.probe).not.toHaveBeenCalled();
  });

  it("still drops the deployment-skew block on the way through", async () => {
    const r = rig();
    r.child.stderr.write(
      'Error: Failed to find Server Action "4027". This request might be from an older or newer deployment.\n' +
        "Read more: https://nextjs.org/docs/messages/failed-to-find-server-action\n" +
        "    at ignore-listed frames\n",
    );
    await drain();
    r.child.stdout.write(`${BANNER.join("\n")}\n`);
    await drain();
    expect(r.log).toEqual(["settled:ready"]);
  });
});

describe("watchDashboardStart — the probe fallback", () => {
  it("probes the port only after 5s without a ready line, and settles when it answers", async () => {
    const r = rig([false, true]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(r.probe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(r.probe).toHaveBeenCalledTimes(1);
    expect(r.outcomes).toEqual([]);

    await vi.advanceTimersByTimeAsync(250);
    expect(r.probe).toHaveBeenCalledTimes(2);
    expect(r.outcomes).toEqual([{ kind: "ready", via: "probe" }]);

    // Settled: no more probing, and the deadline no longer fires.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.probe).toHaveBeenCalledTimes(2);
    expect(r.outcomes).toHaveLength(1);
  });

  it("keeps probing through a probe that throws", async () => {
    const child = fakeChild();
    const outcomes: DashboardStartOutcome[] = [];
    let calls = 0;
    watchDashboardStart({
      child,
      stdout: { write: () => true },
      stderr: { write: () => true },
      probe: () => {
        calls += 1;
        if (calls === 1) throw new Error("bad port");
        return Promise.resolve(true);
      },
      onSettled: (o) => outcomes.push(o),
      onExit: () => {},
    });
    await vi.advanceTimersByTimeAsync(5_250);
    expect(outcomes).toEqual([{ kind: "ready", via: "probe" }]);
  });
});

describe("watchDashboardStart — a server that exits before it is ready", () => {
  it("calls a taken port a taken port, and drops Next's stack trace for it", async () => {
    const r = rig();
    r.child.stderr.write(`${EADDRINUSE_DUMP.join("\n")}\n`);
    await drain();
    r.child.emit("exit", 1, null);
    r.child.emit("close", 1, null);
    expect(r.outcomes).toEqual([{ kind: "failed", code: 1, portInUse: true, cause: null }]);
    expect(r.log).toEqual(["settled:failed"]);
  });

  it("releases the server's own stderr, then settles with the cause it named", async () => {
    const r = rig();
    r.child.stderr.write("Error: Cannot find module '/pkg/.next/standalone/server.js'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)\n");
    await drain();
    r.child.emit("exit", 1, null);
    r.child.emit("close", 1, null);
    expect(r.outcomes).toEqual([
      { kind: "failed", code: 1, portInUse: false, cause: "Cannot find module '/pkg/.next/standalone/server.js'" },
    ]);
    expect(r.log).toEqual([
      "err:Error: Cannot find module '/pkg/.next/standalone/server.js'",
      "err:    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
      "settled:failed",
    ]);
  });

  it("decides on exit alone when the streams never close", async () => {
    const r = rig();
    r.child.emit("exit", 7, null);
    expect(r.outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(r.outcomes).toEqual([{ kind: "failed", code: 7, portInUse: false, cause: null }]);
    r.child.emit("close", 7, null);
    expect(r.outcomes).toHaveLength(1);
  });

  it("treats a spawn error as a failed start with the error's message", () => {
    const r = rig();
    r.child.emit("error", new Error("spawn node ENOENT"));
    expect(r.outcomes).toEqual([{ kind: "failed", code: null, portInUse: false, cause: "spawn node ENOENT" }]);
  });
});

describe("watchDashboardStart — the deadline", () => {
  it("prints the screen as still starting at 30s, then lets Next's banner through", async () => {
    const r = rig();
    r.child.stdout.write("still compiling\n");
    await drain();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(r.outcomes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(r.outcomes).toEqual([{ kind: "timeout" }]);
    expect(r.log).toEqual(["settled:timeout", "out:still compiling"]);

    // A late start still says when it happened.
    r.child.stdout.write(`${BANNER.join("\n")}\n`);
    await drain();
    expect(r.log.slice(2)).toEqual(BANNER.map((l) => `out:${l}`));
    expect(r.outcomes).toHaveLength(1);
  });
});

describe("watchDashboardStart — after the start", () => {
  it("hands a later exit on, with its code", async () => {
    const r = rig();
    r.child.stdout.write(`${BANNER.join("\n")}\n`);
    await drain();
    r.child.emit("exit", 0, null);
    r.child.emit("close", 0, null);
    expect(r.exits).toEqual([[0, undefined]]);
    expect(r.outcomes).toHaveLength(1);
  });

  it("hands a later error on as well", async () => {
    const r = rig();
    r.child.stdout.write(`${BANNER.join("\n")}\n`);
    await drain();
    const error = new Error("kill EPERM");
    r.child.emit("error", error);
    expect(r.exits).toEqual([[null, error]]);
  });
});

describe("dashboardStartupCause", () => {
  it("takes the message of the first Error line, without the plain Error prefix", () => {
    expect(dashboardStartupCause(["⨯ Failed to start server", "Error: listen EACCES: permission denied 127.0.0.1:80"])).toBe(
      "listen EACCES: permission denied 127.0.0.1:80",
    );
  });

  it("keeps a named error's name", () => {
    expect(dashboardStartupCause(["TypeError: Cannot read properties of undefined (reading 'x')"])).toBe(
      "TypeError: Cannot read properties of undefined (reading 'x')",
    );
  });

  it("reads through colour codes and Next's ⨯ prefix", () => {
    expect(dashboardStartupCause(["\x1B[31m⨯\x1B[39m Error: boom"])).toBe("boom");
    expect(dashboardStartupCause(["\x1B[31m\x1B[1m⨯\x1B[22m\x1B[39m Failed to start server"])).toBe(
      "Failed to start server",
    );
  });

  it("returns null when nothing says why", () => {
    expect(dashboardStartupCause(["", "    at somewhere (x.js:1:1)"])).toBeNull();
  });
});

describe("dashboardProbeHost", () => {
  it.each([
    ["127.0.0.1", "127.0.0.1"],
    ["0.0.0.0", "127.0.0.1"],
    ["::", "::1"],
    ["[::1]", "::1"],
    ["localhost", "localhost"],
    ["192.168.1.20", "192.168.1.20"],
  ])("probes %s at %s", (bind, probe) => {
    expect(dashboardProbeHost(bind)).toBe(probe);
  });
});

describe("probeDashboardPort", () => {
  function fakeSocket() {
    const socket = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      setTimeout: vi.fn((ms: number, cb: () => void) => {
        socket.timeoutCb = cb;
        return socket;
      }),
      timeoutCb: undefined as undefined | (() => void),
    });
    return socket;
  }

  it("answers true on a connect, and closes the socket", async () => {
    const socket = fakeSocket();
    net.connect.mockReturnValueOnce(socket);
    const answer = probeDashboardPort("127.0.0.1", 8020);
    socket.emit("connect");
    await expect(answer).resolves.toBe(true);
    expect(net.connect).toHaveBeenLastCalledWith({ host: "127.0.0.1", port: 8020 });
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("answers false on a refusal or a timeout", async () => {
    const refused = fakeSocket();
    net.connect.mockReturnValueOnce(refused);
    const first = probeDashboardPort("127.0.0.1", 8020);
    refused.emit("error", new Error("ECONNREFUSED"));
    await expect(first).resolves.toBe(false);

    const silent = fakeSocket();
    net.connect.mockReturnValueOnce(silent);
    const second = probeDashboardPort("127.0.0.1", 8020);
    silent.timeoutCb?.();
    await expect(second).resolves.toBe(false);
  });

  it("answers false when the port cannot even be connected to", async () => {
    net.connect.mockImplementationOnce(() => {
      throw new RangeError("Port should be >= 0 and < 65536");
    });
    await expect(probeDashboardPort("127.0.0.1", Number.NaN)).resolves.toBe(false);
  });
});
