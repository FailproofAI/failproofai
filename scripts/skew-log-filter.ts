/**
 * Filters the benign Next.js "Failed to find Server Action" deployment-skew
 * block out of the standalone server's forwarded output.
 *
 * Why this exists: the dashboard ships as a per-version Next standalone build,
 * and Server Action IDs are hashed at build time. A browser tab left open
 * across a rebuild/upgrade keeps POSTing a stale action ID the running build no
 * longer has, so Next throws + logs (server-side, to stderr) a 3-line block:
 *
 *     Error: Failed to find Server Action "<hash>". This request might be from an older or newer deployment.
 *     Read more: https://nextjs.org/docs/messages/failed-to-find-server-action
 *         at ignore-listed frames
 *
 * The client receives a graceful 404 (`x-nextjs-action-not-found: 1`) and
 * recovers on its own, so the server-side log is pure noise. `launch.ts` pipes
 * the spawned server's stdout/stderr through this filter (one instance per
 * stream) to drop that block while passing everything else through verbatim.
 *
 * Stateful by design: the block spans multiple lines, so each stream needs its
 * own filter instance. Call the returned function with each line; it returns
 * the line to emit, or `null` to drop it.
 */
export function makeSkewLogFilter(): (line: string) => string | null {
  let inSkewBlock = false;
  return (line: string): string | null => {
    if (line.includes("Failed to find Server Action")) {
      inSkewBlock = true;
      return null;
    }
    if (inSkewBlock) {
      // Continuation lines of the same error block — drop them too.
      const trimmed = line.trimStart();
      if (
        trimmed.startsWith("Read more:") ||
        line.includes("failed-to-find-server-action") ||
        line.includes("ignore-listed frames") ||
        /^\s+at\s/.test(line)
      ) {
        return null;
      }
      // First line that isn't part of the block — stop dropping and emit it.
      inSkewBlock = false;
    }
    return line;
  };
}

/**
 * Drops Next's own startup banner from the standalone server's stdout, and
 * reports the moment the server is listening.
 *
 * The launch screen prints the dashboard's address itself once the server is
 * up, so in `start` mode Next's banner would say it a second time, in another
 * style:
 *
 *     ▲ Next.js 16.3.6
 *     - Local:         http://127.0.0.1:8020
 *     - Network:       http://127.0.0.1:8020
 *     ✓ Ready in 0ms
 *
 * Next logs `Ready in` from its `listening` handler, straight after the banner,
 * so that line doubles as the readiness signal (`onReady`). Only those four
 * shapes are dropped, and only until the ready line; every other line, and
 * every line after it, passes through verbatim. That is the skew filter's
 * contract too, and the reason the two are separate: its test pins these exact
 * lines passing through it.
 *
 * The child is coloured when failproofai runs on a terminal, so a line is
 * matched with its SGR codes stripped and, when kept, emitted as it arrived.
 */
export function makeNextStartupFilter(onReady?: () => void): (line: string) => string | null {
  let listening = false;
  return (line: string): string | null => {
    if (listening) return line;
    const plain = line.replace(/\x1B\[[0-9;]*m/g, "").trim();
    if (/^(?:✓\s*)?Ready in\b/.test(plain)) {
      listening = true;
      onReady?.();
      return null;
    }
    if (/^▲ Next\.js\b/.test(plain) || /^- (?:Local|Network):/.test(plain)) return null;
    return line;
  };
}
