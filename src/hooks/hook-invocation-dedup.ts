/**
 * Cross-process deduplication for Claude hooks installed in multiple scopes.
 *
 * Claude starts one hook process per matching user/project/local registration.
 * Those processes receive the same session + tool-use identifiers. An exclusive
 * lock elects one process to evaluate policies; the others wait briefly and
 * replay its response without duplicating activity or telemetry.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { version } from "../../package.json";
import type { CustomHook, HooksConfig } from "./policy-types";
import type { IntegrationType } from "./types";

const DEFAULT_RESULT_TTL_MS = 10 * 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10;

let dedupDir = join(homedir(), ".failproofai", "cache", "hook-invocations");
let resultTtlMs = DEFAULT_RESULT_TTL_MS;
let waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

export interface HookInvocationResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type HookInvocationClaim =
  | { role: "owner"; complete: (response: HookInvocationResponse) => Promise<void>; release: () => Promise<void> }
  | { role: "duplicate"; response: HookInvocationResponse }
  | { role: "independent" };

function invocationKey(
  eventType: string,
  cli: IntegrationType,
  payload: Record<string, unknown>,
  runtimeIdentity: string,
): string | null {
  if (cli !== "claude") return null;
  const sessionId = payload.session_id;
  const toolUseId = payload.tool_use_id;
  if (typeof sessionId !== "string" || typeof toolUseId !== "string") return null;
  return createHash("sha256")
    .update(`${cli}\0${eventType}\0${sessionId}\0${toolUseId}\0${runtimeIdentity}`)
    .digest("hex");
}

export function createHookRuntimeIdentity(
  config: HooksConfig,
  customHooks: CustomHook[],
  cwd?: string,
): string {
  const packageRoot = process.env.FAILPROOFAI_PACKAGE_ROOT ?? process.argv[1] ?? "unknown";
  const customHookIdentity = customHooks.map((hook) => ({
    name: hook.name,
    description: hook.description,
    match: hook.match,
    implementation: String(hook.fn),
    conventionScope: (hook as CustomHook & { __conventionScope?: string }).__conventionScope,
  }));
  return createHash("sha256")
    .update(JSON.stringify({ version, packageRoot, cwd, config, customHookIdentity }))
    .digest("hex");
}

async function removeOldEntries(): Promise<void> {
  try {
    const names = await readdir(dedupDir);
    const now = Date.now();
    await Promise.all(names.map(async (name) => {
      const path = join(dedupDir, name);
      try {
        if (now - (await stat(path)).mtimeMs > resultTtlMs) await unlink(path);
      } catch {
        // Another hook process may have removed it first.
      }
    }));
  } catch {
    // Cleanup is best-effort and must never delay or block policy evaluation.
  }
}

async function readResponse(path: string): Promise<HookInvocationResponse | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<HookInvocationResponse>;
    if (
      typeof parsed.exitCode === "number"
      && typeof parsed.stdout === "string"
      && typeof parsed.stderr === "string"
    ) {
      return parsed as HookInvocationResponse;
    }
  } catch {
    // The owner has not published its response yet.
  }
  return null;
}

async function readFreshResponse(path: string): Promise<HookInvocationResponse | null> {
  try {
    if (Date.now() - (await stat(path)).mtimeMs > resultTtlMs) return null;
  } catch {
    return null;
  }
  return readResponse(path);
}

export async function claimHookInvocation(
  eventType: string,
  cli: IntegrationType,
  payload: Record<string, unknown>,
  runtimeIdentity: string,
): Promise<HookInvocationClaim> {
  const key = invocationKey(eventType, cli, payload, runtimeIdentity);
  if (!key) return { role: "independent" };

  try {
    await mkdir(dedupDir, { recursive: true });
    void removeOldEntries();
    const lockPath = join(dedupDir, `${key}.lock`);
    const resultPath = join(dedupDir, `${key}.json`);
    const existingResponse = await readFreshResponse(resultPath);
    if (existingResponse) return { role: "duplicate", response: existingResponse };

    while (true) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid }), "utf8");
        await handle.close();
        const racedResponse = await readFreshResponse(resultPath);
        if (racedResponse) {
          try { await unlink(lockPath); } catch { /* best-effort */ }
          return { role: "duplicate", response: racedResponse };
        }
        let completed = false;
        return {
          role: "owner",
          complete: async (response) => {
            const tmpPath = `${resultPath}.${process.pid}.tmp`;
            try {
              const serialized = JSON.stringify(response);
              await writeFile(tmpPath, serialized, "utf8");
              try {
                await rename(tmpPath, resultPath);
              } catch {
                // Windows does not reliably replace an existing destination.
                await writeFile(resultPath, serialized, "utf8");
                try { await unlink(tmpPath); } catch { /* best-effort */ }
              }
              completed = true;
            } catch {
              // Publishing is best-effort; the owner must still return its policy result.
            } finally {
              try { await unlink(lockPath); } catch { /* best-effort */ }
            }
          },
          release: async () => {
            if (!completed) {
              try { await unlink(lockPath); } catch { /* best-effort */ }
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { role: "independent" };
      }

      const deadline = Date.now() + waitTimeoutMs;
      let retryClaim = false;
      while (Date.now() < deadline) {
        const response = await readResponse(resultPath);
        if (response) return { role: "duplicate", response };

        const ownerPid = await readOwnerPid(lockPath);
        if (ownerPid !== null && !isProcessAlive(ownerPid)) {
          try {
            await unlink(lockPath);
            retryClaim = true;
            break;
          } catch {
            // Another waiting process may have taken over first.
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      if (!retryClaim) return { role: "independent" };
    }
  } catch {
    // Deduplication is an optimization. Fail open into normal policy evaluation.
  }
  return { role: "independent" };
}

async function readOwnerPid(lockPath: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function setHookInvocationDedupDirForTests(path: string): void {
  dedupDir = path;
}

export function setHookInvocationDedupTimingForTests(options?: {
  resultTtlMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}): void {
  resultTtlMs = options?.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;
  waitTimeoutMs = options?.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
}
