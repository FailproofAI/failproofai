/**
 * Shared launch logic for dev.ts and start.ts, bare `failproofai`, and the
 * dashboard hand-off at the end of `failproofai audit`.
 */
import { spawn } from "child_process";
import { realpathSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseScriptArgs } from "./parse-script-args";
import { diagnoseShadow } from "./install-diagnosis.mjs";
import { colorsEnabled, screenKit } from "../src/hooks/tui";
import { isLoopbackHostname, resolveDashboardHost } from "../lib/dashboard-host";
import { dashboardBrowseUrl, exposedBindWarning, launchFailureLines, launchScreenLines } from "./launch-screen";
import { gatherLaunchFacts } from "./launch-facts";
import { dashboardProbeHost, probeDashboardPort, watchDashboardStart } from "./launch-ready";
import { version } from "../package.json";

export interface LaunchOptions {
  /**
   * Print the launch screen. Off for `failproofai audit`, whose hand-off prints
   * its own lines and the /audit address before the server starts.
   */
  screen?: boolean;
  /**
   * Draw the logomark above the screen, on a terminal. Off when the first-run
   * setup wizard already drew it in this process.
   */
  logo?: boolean;
}

export function launch(mode: "dev" | "start", options: LaunchOptions = {}): void {
  const { loggingLevel, disableTelemetry, allowedDevOrigins, host, remainingArgs } = parseScriptArgs(process.argv.slice(2));
  const showScreen = options.screen !== false;

  // The dashboard has no authentication and can toggle policies and uninstall
  // hooks from every agent CLI, so it binds loopback unless someone asks
  // otherwise. It used to bind 0.0.0.0 unconditionally, which handed all of
  // that to every peer on the network.
  const bindHost = resolveDashboardHost(host, process.env.FAILPROOFAI_DASHBOARD_HOST);
  const exposed = isLoopbackHostname(bindHost)
    ? undefined
    : { host: bindHost, fix: host !== undefined ? "--host 127.0.0.1" : "unset FAILPROOFAI_DASHBOARD_HOST" };
  // Read back by proxy.ts, which refuses any request whose Host is not one it
  // should be answering to — the layer that stops DNS rebinding, which a
  // loopback bind alone does not.
  process.env.FAILPROOFAI_DASHBOARD_HOST = bindHost;

  // A routable bind is allowed, and said out loud. The launch screen carries
  // that warning as its attention line; audit's hand-off has no screen, so it
  // is said here, before anything listens.
  if (exposed && !showScreen) {
    const k = screenKit({ color: colorsEnabled(process.stderr) });
    process.stderr.write(`\n${k.caution(exposedBindWarning(exposed.host))}\n  ${k.cmd(exposed.fix)}\n\n`);
  }

  // `.next/standalone/server.js` does `process.chdir(__dirname)` on its first
  // line, so by the time a server action runs, `process.cwd()` is the PACKAGE
  // directory, not the directory the user launched from. Anything resolving
  // project-scope paths from cwd would look inside the installed package and
  // find nothing. So the real cwd is captured here, before the child starts,
  // the same way FAILPROOFAI_PACKAGE_ROOT is threaded through, and the launch
  // screen reads the project from the same place the dashboard will.
  const launchCwd = process.env.FAILPROOFAI_LAUNCH_CWD ?? process.cwd();

  const portIdx = remainingArgs.indexOf("--port");
  const portFlag = portIdx >= 0 ? remainingArgs[portIdx + 1] : undefined;
  // `next dev` serves on PORT, else 3000, unless --port is passed through.
  const port = mode === "start" ? (portFlag ?? "8020") : (portFlag ?? process.env.PORT ?? "3000");

  const printScreen = (live: boolean): void => {
    const lines = launchScreenLines(
      { url: dashboardBrowseUrl(bindHost, port), live, exposed, ...gatherLaunchFacts(launchCwd) },
      {
        color: colorsEnabled(process.stdout),
        // Some pseudo-terminals report 0 columns; that is "unknown", not narrow.
        cols: process.stdout.columns || undefined,
        // Piped output is a log: no art in it.
        logo: options.logo !== false && Boolean(process.stdout.isTTY),
      },
    );
    process.stdout.write(`${lines.join("\n")}\n`);
  };

  let cmd: string;
  let cmdArgs: string[];
  if (mode === "start") {
    process.env.PORT = port;
    process.env.HOSTNAME = bindHost;
    cmd = "node";
    // Resolve the real package root via realpathSync so symlinked npm global binaries
    // don't cause import.meta.url to point at the symlink dir instead of the package dir.
    const packageRoot = process.env.FAILPROOFAI_PACKAGE_ROOT
      ?? resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "..");
    const serverJsPath = resolve(packageRoot, ".next/standalone/server.js");
    if (!existsSync(serverJsPath)) {
      // Most "missing server.js" reports come from a PATH shadow (an older
      // `bun link` or a `bun install -g` whose prefix wins over npm), not from
      // a genuinely broken build. Diagnose first so the error message names
      // the actual cause when that's what's going on.
      let shadowMessage: string | null = null;
      try {
        const diag = diagnoseShadow({ selfPackageRoot: packageRoot, selfVersion: version });
        if (diag.shadowed) {
          // Pick whichever alternate install exists at npm/bun globals AND
          // differs from PATH-first. In the runtime stale-binary scenario the
          // running install IS the PATH-first one, so we'd otherwise point the
          // user back at themselves.
          const alt =
            (diag.npmGlobalPath && diag.npmGlobalPath !== diag.pathFirstPath
              ? { path: diag.npmGlobalPath, version: diag.npmGlobalVersion }
              : null)
            ?? (diag.bunGlobalPath && diag.bunGlobalPath !== diag.pathFirstPath
              ? { path: diag.bunGlobalPath, version: diag.bunGlobalVersion }
              : null);
          const newer = alt?.path ?? "(unknown)";
          const newerVer = alt?.version ?? "?";
          shadowMessage =
            `\nError: failproofai on your PATH is a stale install that no longer has its build output.\n` +
            `  Running:    ${diag.pathFirstPath}` + (diag.pathFirstVersion ? `  (v${diag.pathFirstVersion})` : "") + `\n` +
            `  Newer copy: ${newer}  (v${newerVer})\n\n` +
            `Remove the shadow with:\n  ${diag.recommendation}\n`;
        }
      } catch {
        // Diagnosis is best-effort; fall back to the original message.
      }
      console.error(
        shadowMessage ??
        `\nError: Cannot find server.js at:\n  ${serverJsPath}\n\n` +
        `The package may be missing its build output.\n` +
        `Try reinstalling:\n  npm install -g failproofai@latest\n`
      );
      process.exit(1);
    }
    cmdArgs = [serverJsPath];
  } else {
    cmd = "bunx";
    // `next dev` with no -H listens on every interface too, so dev gets the same
    // default. Skipped when the caller already passed one through, so an
    // explicit -H in remainingArgs still wins.
    const hasHostFlag = remainingArgs.some((a) => a === "-H" || a === "--hostname" || a.startsWith("--hostname="));
    cmdArgs = ["--bun", "next", "dev", ...(hasHostFlag ? [] : ["-H", bindHost]), ...remainingArgs];
  }

  // In `start` (the shipped standalone server) we pipe + filter the child's
  // output: to drop the benign "Failed to find Server Action" deployment-skew
  // block — a stale browser tab POSTing an old action ID after a rebuild, which
  // the client recovers from via Next's graceful 404 (see skew-log-filter.ts) —
  // and to learn when the server is listening, so the launch screen can say so.
  // `dev` keeps "inherit" so Next's interactive compile output is untouched.
  const filterLogs = mode === "start";

  // Dev never learns when its server is up, so its screen goes first, as the
  // banner always did, and says it is starting.
  if (!filterLogs && showScreen) printScreen(false);

  const nextProcess = spawn(cmd, cmdArgs, {
    stdio: filterLogs ? ["inherit", "pipe", "pipe"] : "inherit",
    env: {
      ...process.env,
      FAILPROOFAI_LAUNCH_CWD: launchCwd,
      // Keeps the piped child's output coloured despite the pipe, when this
      // process is itself writing to a terminal. Not otherwise: piped output is
      // a log file, and forced colour put escape codes in it.
      ...(filterLogs && process.stdout.isTTY ? { FORCE_COLOR: process.env.FORCE_COLOR ?? "1" } : {}),
      ...(loggingLevel ? { FAILPROOFAI_LOG_LEVEL: loggingLevel } : {}),
      ...(disableTelemetry ? { FAILPROOFAI_TELEMETRY_DISABLED: "1" } : {}),
      ...(allowedDevOrigins ? { FAILPROOFAI_ALLOWED_DEV_ORIGINS: allowedDevOrigins.join(",") } : {}),
    },
  });

  if (!filterLogs) {
    nextProcess.on("error", (error) => {
      console.error("Error starting Next.js:", error);
      process.exit(1);
    });
    nextProcess.on("exit", (code) => {
      process.exit(code || 0);
    });
    return;
  }

  const failLine = (text: string): void => {
    process.stderr.write(`${screenKit({ color: colorsEnabled(process.stderr) }).fail(text)}\n`);
  };
  watchDashboardStart({
    child: nextProcess,
    stdout: process.stdout,
    stderr: process.stderr,
    probe: () => probeDashboardPort(dashboardProbeHost(bindHost), Number(port)),
    onSettled: (outcome) => {
      if (outcome.kind === "failed") {
        const lines = launchFailureLines(outcome, {
          port,
          portFromFlag: portFlag !== undefined,
          color: colorsEnabled(process.stderr),
        });
        process.stderr.write(`${lines.join("\n")}\n`);
        process.exit(outcome.code ?? 1);
        return;
      }
      if (showScreen) printScreen(outcome.kind === "ready");
    },
    onExit: (code, error) => {
      if (error) failLine(`The dashboard server failed: ${error.message}`);
      process.exit(error ? 1 : code || 0);
    },
  });
}
