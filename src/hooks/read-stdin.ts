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
  /** No `end` arrived within the budget; the payload is `""`. */
  timedOut: boolean;
}

/**
 * How long to wait for the agent to finish writing the payload.
 *
 * Deliberately generous: the parent has the payload in hand before it spawns
 * the hook, so a real read is milliseconds and this can only fire on a
 * misconfiguration. It exists to bound that misconfiguration, not to police a
 * slow write — a false timeout here would drop a real policy decision.
 */
const STDIN_TIMEOUT_MS = 10_000;

/**
 * Read the hook payload, and NEVER wait forever for it.
 *
 * This runs on the enforcement path — every tool call, on all eleven agent
 * CLIs — and it used to have no bound at all. The only early exit was
 * `readableEnded`, which helps only when stdin is ALREADY closed, so a parent
 * that spawned the hook with a pipe it had not yet closed, or with an inherited
 * terminal, left this promise unsettled forever. A hung hook is worse than
 * either verdict: it does not fail open or closed, it freezes the agent's tool
 * call, and nothing on our side ever gives up.
 *
 * Two bounds, because there are two ways in:
 *
 *  - A TTY on stdin means no payload is coming, ever. Nobody types a hook
 *    payload at a keyboard, so waiting for EOF on a terminal is waiting for a
 *    person to press ctrl-D — which is exactly what a hand-run
 *    `failproofai --hook PreToolUse` looked like.
 *  - An open pipe might still deliver, so it gets a clock rather than a
 *    refusal.
 *
 * Both resolve empty and flag what happened. That matches how a read error has
 * always been treated — warn, report, evaluate an empty payload — rather than
 * inventing a third verdict for a case that is a malformed invocation, not a
 * policy decision.
 */
export async function readStdinPayload(
  maxBytes = 1_048_576,
  timeoutMs = STDIN_TIMEOUT_MS,
  // Injectable so a test can hand in a stream that never ends — which is the
  // whole condition under test — WITHOUT reassigning `process.stdin`. Doing
  // that globally takes the test runner's own stdin away and kills it.
  stream: NodeJS.ReadableStream & {
    isTTY?: boolean;
    readableEnded?: boolean;
    destroy?: () => void;
  } = process.stdin,
): Promise<StdinRead> {
  let payload = "";
  let oversized = false;
  let readError = false;
  let timedOut = false;

  // A terminal never ends on its own. Checked before any listener is attached,
  // so the hand-run case costs nothing and returns immediately.
  if (stream.isTTY) {
    return { payload: "", oversized: false, readError: false, timedOut: false };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    payload = await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      let totalBytes = 0;
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        totalBytes += Buffer.byteLength(chunk);
        if (totalBytes > maxBytes) {
          oversized = true;
          stream.destroy?.();
          resolve("");
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve(chunks.join("")));
      stream.on("error", reject);
      // If stdin is already closed or not piped, resolve immediately
      if (stream.readableEnded) resolve("");

      timer = setTimeout(() => {
        timedOut = true;
        // Whatever arrived before the clock ran out is NOT used: a partial
        // payload is not valid JSON, and half a tool call is not a thing any
        // policy should be asked to judge.
        stream.destroy?.();
        resolve("");
      }, timeoutMs);
      // Nothing else keeps this process alive on account of the timer.
      timer.unref?.();
    });
  } catch {
    readError = true;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { payload, oversized, readError, timedOut };
}
