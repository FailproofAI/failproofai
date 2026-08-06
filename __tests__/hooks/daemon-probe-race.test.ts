// @vitest-environment node
//
// The health probe runs moments after `systemctl enable --now`. A `Type=simple`
// unit is reported ACTIVE the instant systemd forks it — before the daemon has
// bound its socket — and the hook path's connect budget is deliberately 150ms.
// A single attempt therefore raced the bind and lost it on any loaded machine:
// setup aborted with "its worker process could not be run" at a daemon that was
// seconds from serving, whose worker had ALREADY logged that it was listening.
//
// These use a real Unix socket server rather than a mock, because the bug lives
// in the timing between connect() and listen(), which a mock cannot reproduce.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let sockPath: string;
let server: Server | null = null;
const originalSocket = process.env.FAILPROOFAI_DAEMON_SOCKET;

/** A stand-in daemon: answers `ping` with `pong` and `hook` with exit 0. */
function startDaemon(opts: { answerHooks: boolean }): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer((conn) => {
      let buf = Buffer.alloc(0);
      // Annotated: the `data` event is typed `string | Buffer` because a socket
      // MAY have an encoding set. This one never does, so it is always a Buffer.
      conn.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf-8"));
        buf = buf.subarray(4 + len);
        // A daemon whose worker cannot run still ACCEPTS the connection — that
        // is exactly the case the taxonomy has to tell apart from a socket that
        // never came up, so this stub must accept and then stay silent.
        if (msg.type === "hook" && !opts.answerHooks) return;
        const body = Buffer.from(
          JSON.stringify(
            msg.type === "ping"
              ? { type: "pong", protocolVersion: 1 }
              : { type: "hookResult", protocolVersion: 1, exitCode: 0, stdout: "", stderr: "" },
          ),
          "utf-8",
        );
        const head = Buffer.alloc(4);
        head.writeUInt32BE(body.length, 0);
        conn.write(Buffer.concat([head, body]));
      });
      conn.on("error", () => {});
    });
    s.listen(sockPath, () => resolve(s));
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fpai-probe-"));
  sockPath = join(dir, "failproofaid.sock");
  process.env.FAILPROOFAI_DAEMON_SOCKET = sockPath;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  if (originalSocket === undefined) delete process.env.FAILPROOFAI_DAEMON_SOCKET;
  else process.env.FAILPROOFAI_DAEMON_SOCKET = originalSocket;
  rmSync(dir, { recursive: true, force: true });
});

describe("hooks/daemon-service — health probe startup race", () => {
  it("succeeds when the socket binds AFTER the probe starts", async () => {
    const { probeDaemon } = await import("../../src/hooks/daemon-service");
    // The regression: 1.2s is far beyond the 150ms connect budget a single
    // attempt gets, and comfortably inside what a loaded machine takes between
    // systemd reporting `active` and the daemon binding.
    const late = new Promise<void>((r) =>
      setTimeout(async () => {
        server = await startDaemon({ answerHooks: true });
        r();
      }, 1200),
    );

    const [probe] = await Promise.all([probeDaemon(), late]);
    expect(probe.ok).toBe(true);
  }, 20_000);

  it("answers immediately when the daemon is already up", async () => {
    server = await startDaemon({ answerHooks: true });
    const { probeDaemon } = await import("../../src/hooks/daemon-service");
    const started = Date.now();

    expect((await probeDaemon()).ok).toBe(true);
    // Must not pay the retry budget when there is nothing to wait for.
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 20_000);

  it("reports `unreachable` when nothing ever listens", async () => {
    const { probeDaemon } = await import("../../src/hooks/daemon-service");
    const probe = await probeDaemon();
    expect(probe).toEqual({ ok: false, reason: "unreachable" });
  }, 30_000);

  it("reports `worker` when the daemon accepts but never answers a hook", async () => {
    // The fault the probe exists to catch, and the one whose message was being
    // shown for BOTH cases: a listening daemon whose worker cannot run.
    server = await startDaemon({ answerHooks: false });
    const { probeDaemon } = await import("../../src/hooks/daemon-service");

    const probe = await probeDaemon();
    expect(probe).toEqual({ ok: false, reason: "worker" });
  }, 40_000);
});
