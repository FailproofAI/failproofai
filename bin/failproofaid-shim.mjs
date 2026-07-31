#!/usr/bin/env node
/**
 * `failproofaid` npm bin entry — resolves the installed
 * `@failproofai/failproofaid-<os>-<arch>` optional-dependency package for
 * the current platform and execs its real compiled binary, forwarding
 * argv and propagating the exit code verbatim.
 *
 * NOT what any service manager invokes: the systemd unit / launchd plist
 * `daemon-service.ts` writes points `ExecStart`/`ProgramArguments`
 * directly at the resolved platform package's binary, bypassing this
 * shim entirely — a supervised service needs a direct path, not a
 * wrapper it would have to keep alive itself. This shim exists only for
 * a user (or script) invoking `failproofaid` by hand.
 *
 * Degrades cleanly with no throw on an unsupported platform (Windows, or
 * an architecture with no shipped package): `optionalDependencies`
 * causes npm/bun to simply skip installing the non-matching platform
 * package, so this reports a clear one-line message on stderr and exits
 * non-zero — never a stack trace. The daemon-connect logic in the CLI
 * never depends on this shim: it detects "no daemon" independently via
 * the socket/daemonConfigured marker.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const requireFromHere = createRequire(import.meta.url);

function platformKey() {
  const os = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : null;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (!os || !arch) return null;
  return `${os}-${arch}`;
}

function resolveBinary() {
  const key = platformKey();
  if (!key) return null;
  try {
    const pkgJsonPath = requireFromHere.resolve(`@failproofai/failproofaid-${key}/package.json`);
    return resolve(dirname(pkgJsonPath), "bin", "failproofaid");
  } catch {
    return null;
  }
}

const binaryPath = resolveBinary();
if (!binaryPath) {
  const key = platformKey();
  process.stderr.write(
    key
      ? `failproofaid: no prebuilt binary is installed for ${key}. Reinstall failproofai, or check that @failproofai/failproofaid-${key} is available.\n`
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
