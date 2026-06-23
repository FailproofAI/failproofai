/**
 * Shared launch logic for dev.ts and start.ts.
 */
import { spawn } from "child_process";
import { realpathSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseScriptArgs } from "./parse-script-args";
import { diagnoseShadow } from "./install-diagnosis.mjs";
import { version } from "../package.json";

export function launch(mode: "dev" | "start"): void {
  const { loggingLevel, disableTelemetry, allowedDevOrigins, remainingArgs } = parseScriptArgs(process.argv.slice(2));

  // Plain-text title + a labeled `Version` line that lines up with the
  // `Star us` / `Docs` / `Slack` lines below (all four labels pad to the
  // same column so the values form a clean right-hand column).
  console.log(`\n  failproof ai\n`);
  console.log(`  📦 Version:      ${version}`);
  console.log(`  ⭐ Star us:      https://github.com/failproofai/failproofai`);
  console.log(`  📖 Docs:         https://befailproof.ai`);
  console.log(`  💬 Discord:      https://discord.gg/2zjBZP7yQJ\n`);

  let cmd: string;
  let cmdArgs: string[];
  if (mode === "start") {
    const portIdx = remainingArgs.indexOf("--port");
    const port = portIdx >= 0 ? remainingArgs[portIdx + 1] : "8020";
    process.env.PORT = port;
    process.env.HOSTNAME = "0.0.0.0";
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
    cmdArgs = ["--bun", "next", "dev", ...remainingArgs];
  }

  const nextProcess = spawn(cmd, cmdArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(loggingLevel ? { FAILPROOFAI_LOG_LEVEL: loggingLevel } : {}),
      ...(disableTelemetry ? { FAILPROOFAI_TELEMETRY_DISABLED: "1" } : {}),
      ...(allowedDevOrigins ? { FAILPROOFAI_ALLOWED_DEV_ORIGINS: allowedDevOrigins.join(",") } : {}),
    },
  });

  nextProcess.on("error", (error) => {
    console.error("Error starting Next.js:", error);
    process.exit(1);
  });

  nextProcess.on("exit", (code) => {
    process.exit(code || 0);
  });
}
