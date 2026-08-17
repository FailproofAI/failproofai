/**
 * The worker must accept the wire shape the DAEMON actually sends.
 *
 * The daemon builds its request in Rust with `json!({… "cwd": cwd})` where
 * `cwd` is an `Option<String>`. serde_json renders `None` as `null`, because
 * JSON has no way to spell `undefined` — so a request with no cwd arrives as
 * `"cwd": null`, and a validator that accepts only `undefined` rejects it.
 *
 * That rejection was invisible until it wasn't: `probeDaemonEndToEnd()` is the
 * only caller that omits cwd, so the HEALTH PROBE failed against a perfectly
 * healthy daemon. The wizard read that as "installed but cannot evaluate",
 * aborted, and wrote nothing — making first-run setup impossible to complete on
 * any machine where the daemon is required, while `systemctl status`, the
 * journal, and a hand-fired hook all said the daemon was fine.
 */
import { describe, it, expect } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startWorkerServer } from "../../src/hooks/worker-server";

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Send one request over the worker socket and read one reply. */
function call(socketPath: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const c = net.createConnection(socketPath);
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => {
      c.destroy();
      rej(new Error("timed out"));
    }, 15_000);
    c.on("error", (e) => {
      clearTimeout(t);
      rej(e);
    });
    c.on("connect", () => c.write(frame(payload)));
    c.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      clearTimeout(t);
      const parsed = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      c.destroy();
      res(parsed);
    });
  });
}

describe("the worker accepts what the daemon sends", () => {
  let dir: string;
  let server: ReturnType<typeof startWorkerServer> | null = null;
  let sock: string;

  async function serve() {
    dir = mkdtempSync(resolve(tmpdir(), "fpai-wsock-"));
    // Isolate the home. Driving the real hook path writes to `~/.failproofai`
    // — the decision log, and now `contracts/observed.json` — so without this
    // the suite records into the DEVELOPER'S own home, exactly as
    // `worker-server.test.ts` documents finding for hook-activity.
    process.env.FAILPROOFAI_HOME = resolve(dir, "home");
    sock = resolve(dir, "worker.sock");
    server = startWorkerServer(sock);
    // `listen` is async; wait for the socket to exist before dialling it.
    await new Promise<void>((res) => {
      if (server!.listening) return res();
      server!.once("listening", () => res());
    });
  }

  async function shutdown() {
    await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
    server = null;
    delete process.env.FAILPROOFAI_HOME;
  }

  it("accepts `cwd: null` — what serde renders an absent Option as", async () => {
    await serve();
    try {
      const reply = await call(sock, {
        type: "hook",
        hookEvent: "SessionStart",
        cli: "claude",
        stdin: JSON.stringify({ hook_event_name: "SessionStart", source: "probe" }),
        cwd: null,
      });
      expect(reply.type, JSON.stringify(reply)).not.toBe("error");
    } finally {
      await shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still accepts an omitted cwd and a real one", async () => {
    await serve();
    try {
      for (const cwd of [undefined, process.cwd()]) {
        const payload: Record<string, unknown> = {
          type: "hook",
          hookEvent: "SessionStart",
          cli: "claude",
          stdin: JSON.stringify({ hook_event_name: "SessionStart", source: "probe" }),
        };
        if (cwd !== undefined) payload.cwd = cwd;
        const reply = await call(sock, payload);
        expect(reply.type, `cwd=${String(cwd)} -> ${JSON.stringify(reply)}`).not.toBe("error");
      }
    } finally {
      await shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still REJECTS a genuinely malformed shape", async () => {
    // The validator must not have been loosened into accepting anything.
    await serve();
    try {
      const reply = await call(sock, { type: "hook", hookEvent: "SessionStart", cli: "claude" });
      expect(reply.type).toBe("error");
      expect(String(reply.message)).toContain("unrecognized request shape");
    } finally {
      await shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a cwd that is not a string", async () => {
    await serve();
    try {
      const reply = await call(sock, {
        type: "hook",
        hookEvent: "SessionStart",
        cli: "claude",
        stdin: "{}",
        cwd: 42,
      });
      expect(reply.type).toBe("error");
    } finally {
      await shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
