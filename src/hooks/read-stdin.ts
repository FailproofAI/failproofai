/**
 * Reads the hook payload off `process.stdin`, capped at `maxBytes`.
 *
 * Pure I/O only — no logging, no telemetry. Extracted out of handler.ts so
 * it's reusable and independently testable; callers that need the existing
 * `hook_stdin_error` telemetry-on-failure behavior (currently only the
 * one-shot `handleHookEvent` wrapper) add that themselves from the returned
 * flags. The daemon's warm worker never calls this at all — it receives the
 * payload directly over the socket, already read by the client.
 */

export interface StdinRead {
  payload: string;
  /** The payload exceeded `maxBytes` and was discarded (payload is `""`). */
  oversized: boolean;
  /** `process.stdin` emitted an `error` event before `end`. */
  readError: boolean;
}

export async function readStdinPayload(maxBytes = 1_048_576): Promise<StdinRead> {
  let payload = "";
  let oversized = false;
  let readError = false;
  try {
    payload = await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      let totalBytes = 0;
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        totalBytes += Buffer.byteLength(chunk);
        if (totalBytes > maxBytes) {
          oversized = true;
          process.stdin.destroy();
          resolve("");
          return;
        }
        chunks.push(chunk);
      });
      process.stdin.on("end", () => resolve(chunks.join("")));
      process.stdin.on("error", reject);
      // If stdin is already closed or not piped, resolve immediately
      if (process.stdin.readableEnded) resolve("");
    });
  } catch {
    readError = true;
  }
  return { payload, oversized, readError };
}
