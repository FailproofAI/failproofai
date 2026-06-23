/**
 * Best-effort "open the dashboard in the browser once it's actually listening".
 *
 * `failproofai audit` writes the dashboard cache, then starts the bundled
 * dashboard server (a blocking call) and wants to pop the browser to /audit the
 * moment the server answers — never before (a connection-refused tab is a bad
 * first impression). This polls the server root, then shells out to the
 * platform's URL opener. Every failure is swallowed: the worst case is the user
 * clicks the URL we already printed to the terminal.
 */
import { spawn } from "node:child_process";

const POLL_INTERVAL_MS = 150;
const POLL_TIMEOUT_MS = 30_000;

/** Open a URL with the platform's default handler. Never throws. */
function openUrl(url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    // `start` is a cmd builtin; the empty "" is the (required) window-title arg
    // so a URL containing `&` or spaces isn't mis-parsed as the title.
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // Headless Linux without xdg-open, missing `open`, etc. — swallow.
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore — the URL was already printed for manual use.
  }
}

/**
 * Poll `http://localhost:<port>/` until it responds (any status, including a
 * redirect), then open `http://localhost:<port><path>`. Detached and
 * best-effort: returns immediately, does its work on the event loop, and never
 * throws into the caller (which is about to make a blocking `launch()` call).
 */
export function openWhenReady(port: number, path: string): void {
  const base = `http://localhost:${port}`;
  const target = `${base}${path}`;
  void (async () => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        // `redirect: "manual"` so the dashboard's `/ → /policies` 307 counts as
        // "up" without us following it and rendering an unrelated page.
        await fetch(base, { method: "GET", redirect: "manual" });
        openUrl(target);
        return;
      } catch {
        // Not listening yet — wait and retry.
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
    // Timed out waiting for the probe. The server may still be coming up; open
    // anyway as a last resort so a slow cold boot still lands on the page.
    openUrl(target);
  })();
}
