/**
 * Runs the failproofai binary as a subprocess for CLI argument e2e tests.
 *
 * Unlike hook-runner.ts (which feeds JSON via stdin), this runner invokes
 * the binary with arbitrary CLI args and captures stdout/stderr/exitCode.
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, expect } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Isolated HOME so config-mutating commands (`policies --install/--uninstall`,
// `policy add/remove`, `configure`) resolve `~/.failproofai` and `~/.claude`
// under a throwaway dir instead of the developer's real home. Without this, any
// runCli call that reaches installHooks/removeHooks clobbers the real user
// config (Bun honors the spawn-env HOME, so overriding it here fully isolates).
// Created once per test module; the OS reclaims it from tmp.
const ISOLATED_HOME = mkdtempSync(resolve(tmpdir(), "failproofai-cli-e2e-"));

// Remove the throwaway HOME after the importing suite finishes so repeated e2e
// runs don't accumulate config artifacts in tmp (mkdtempSync leaves it behind).
afterAll(() => {
  try {
    rmSync(ISOLATED_HOME, { recursive: true, force: true });
  } catch {
    // best-effort — the OS reclaims tmp regardless
  }
});

function getBinaryPath(): string {
  return resolve(REPO_ROOT, "bin/failproofai.mjs");
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Invoke `failproofai <...args>` and return stdout, stderr, exitCode.
 *
 * @param stdoutIsTTY - Whether captured stdout should present as a terminal
 * @param args - CLI arguments to pass to the binary
 */
function invokeCli(stdoutIsTTY: boolean, args: string[]): CliRunResult {
  const binaryPath = getBinaryPath();

  if (!existsSync(binaryPath)) {
    throw new Error(`Binary not found: ${binaryPath}`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: ISOLATED_HOME,
    USERPROFILE: ISOLATED_HOME,
    FAILPROOFAI_TELEMETRY_DISABLED: "1",
  };
  if (stdoutIsTTY) delete env.NO_COLOR;

  const commandArgs = stdoutIsTTY
    ? [
        "--eval",
        `Object.defineProperty(process.stdout, "isTTY", { value: true });\n` +
          `Object.defineProperty(process.stdout, "columns", { value: 80 });\n` +
          `await import(${JSON.stringify(pathToFileURL(binaryPath).href)});`,
        "--",
        binaryPath,
        ...args,
      ]
    : [binaryPath, ...args];

  const result = spawnSync("bun", commandArgs, {
    env,
    encoding: "utf8",
    timeout: 15_000,
  });

  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/** Invoke the CLI with its normal captured, non-TTY stdout. */
export function runCli(...args: string[]): CliRunResult {
  return invokeCli(false, args);
}

/** Invoke the CLI while presenting captured stdout as an 80-column TTY. */
export function runCliWithTTY(...args: string[]): CliRunResult {
  return invokeCli(true, args);
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

export function assertCleanError(result: CliRunResult, expectedMessage: string): void {
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(expectedMessage);
  // Must NOT be a raw stack trace
  expect(result.stderr).not.toMatch(/at \w+ \(.*:\d+:\d+\)/);
  expect(result.stderr).not.toContain("node:internal");
}

export function assertSuccess(result: CliRunResult): void {
  expect(result.exitCode).toBe(0);
}
