#!/usr/bin/env node
/**
 * `failproofaid` npm bin entry — runs the compiled daemon binary this CLI
 * version downloaded into `~/.failproofai/bin`, forwarding argv and
 * propagating the exit code verbatim.
 *
 * NOT what any service manager invokes: the systemd unit / launchd plist
 * `daemon-service.ts` writes points `ExecStart`/`ProgramArguments`
 * directly at the resolved binary, bypassing this shim entirely — a
 * supervised service needs a direct path, not a wrapper it would have to
 * keep alive itself. This shim exists only for a user (or script)
 * invoking `failproofaid` by hand.
 *
 * The npm package deliberately ships no binary: one tarball serves every
 * platform, and the four cross-compiled binaries live on the GitHub
 * Release for this version (see `src/hooks/daemon-download.ts`).
 * `failproofai config` is what fetches one. So "not installed" here is a
 * normal state rather than a broken install, and it degrades with a
 * one-line message and a non-zero exit — never a stack trace — including
 * on a platform that has no binary at all (Windows). The daemon-connect
 * logic in the CLI never depends on this shim: it detects "no daemon"
 * independently via the socket/daemonConfigured marker.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const requireFromHere = createRequire(import.meta.url);
const { version } = requireFromHere("../package.json");

function platformKey() {
  const os = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : null;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (!os || !arch) return null;
  return `${os}-${arch}`;
}

/**
 * Mirrors `resolveFailproofaidBinaryPath()` in src/hooks/daemon-service.ts.
 * Deliberately its own copy: this file is plain .mjs, run by node straight
 * out of the installed package, with no access to the bundled TypeScript.
 */
function resolveBinary() {
  if (process.env.FAILPROOFAI_DAEMON_BINARY) return process.env.FAILPROOFAI_DAEMON_BINARY;
  const downloaded = resolve(homedir(), ".failproofai", "bin", `failproofaid-${version}`);
  return existsSync(downloaded) ? downloaded : null;
}

const binaryPath = resolveBinary();
if (!binaryPath) {
  const key = platformKey();
  process.stderr.write(
    key
      ? `failproofaid ${version} is not installed on this machine. Run \`failproofai config\` and choose the global scope to install it.\n`
      : `failproofaid is not available on ${process.platform}/${process.arch} yet — the CLI's in-process enforcement is unaffected.\n`,
  );
  process.exit(1);
}

const result = spawnSync(binaryPath, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`failproofaid: failed to run ${binaryPath}: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
