#!/usr/bin/env node
/**
 * failproofai-worker — the warm worker process failproofaid (the Rust
 * supervisor) spawns and supervises. NOT a user-facing entry point (no
 * "bin" entry in package.json) — the daemon always invokes this directly by
 * path, either `node bin/failproofai-worker.mjs` (dev, via
 * FAILPROOFAI_WORKER_CMD) or the built `dist/worker.mjs` in production.
 *
 * Reads FAILPROOFAI_WORKER_SOCKET for where to listen — the daemon resolves
 * and passes this; the worker never guesses a path of its own.
 */
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.FAILPROOFAI_PACKAGE_ROOT) {
  process.env.FAILPROOFAI_PACKAGE_ROOT = resolve(
    dirname(realpathSync(fileURLToPath(import.meta.url))),
    ".."
  );
}

if (!process.env.FAILPROOFAI_DIST_PATH) {
  process.env.FAILPROOFAI_DIST_PATH = resolve(
    dirname(realpathSync(fileURLToPath(import.meta.url))),
    "..",
    "dist"
  );
}

const socketPath = process.env.FAILPROOFAI_WORKER_SOCKET;
if (!socketPath) {
  console.error("[failproofai-worker] FAILPROOFAI_WORKER_SOCKET is not set");
  process.exit(1);
}

const { startWorkerServer } = await import("../src/hooks/worker-server");
const server = startWorkerServer(socketPath, shutdown);

server.on("error", (err) => {
  console.error(`[failproofai-worker] server error: ${err.message}`);
  process.exit(1);
});

console.error(`[failproofai-worker] listening on ${socketPath}`);

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
