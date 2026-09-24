import { afterAll } from "vitest";

import { runtime } from "../src/runtime.js";

/**
 * Close the process-wide writer when a test FILE finishes.
 *
 * Vitest gives each file a fresh module registry but one process, so every file
 * that touches `runtime.ts` builds another writer with another flush timer and
 * another `exit` listener. Left open they accumulate across the run, Node warns
 * about the listener count, and the last file's assertions race timers the
 * first file started.
 *
 * `close()` is the API the writer already exposes for exactly this.
 */
afterAll(async () => {
  await runtime.writer.flushNow();
  runtime.writer.close();
});
