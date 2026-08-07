// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { startWorkerServer } from "../../src/hooks/worker-server";

describe("worker restart", () => {
  const socketPath = join(tmpdir(), `fpai-worker-restart-${process.pid}.sock`);
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolvePromise) => {
            if (!server.listening) resolvePromise();
            else server.close(() => resolvePromise());
          }),
      ),
    );
    rmSync(socketPath, { force: true });
  });

  it("asks a live worker to shut down before replacing its socket", async () => {
    let shutdownRequested = false;
    let oldServer!: Server;
    oldServer = startWorkerServer(socketPath, () => {
      shutdownRequested = true;
      oldServer.close();
    });
    servers.push(oldServer);
    await new Promise<void>((resolvePromise) => oldServer.once("listening", resolvePromise));

    const replacement = startWorkerServer(socketPath);
    servers.push(replacement);
    await new Promise<void>((resolvePromise, reject) => {
      replacement.once("listening", resolvePromise);
      replacement.once("error", reject);
    });

    expect(shutdownRequested).toBe(true);
    expect(oldServer.listening).toBe(false);
    expect(replacement.listening).toBe(true);
    expect(existsSync(socketPath)).toBe(true);
  });
});
