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
import type { IntegrationType } from "./types";

const RESULT_TTL_MS = 5 * 60_000;
const WAIT_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 10;

let dedupDir = join(homedir(), ".failproofai", "cache", "hook-invocations");

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
): string | null {
  if (cli !== "claude") return null;
  const sessionId = payload.session_id;
  const toolUseId = payload.tool_use_id;
  if (typeof sessionId !== "string" || typeof toolUseId !== "string") return null;
  return createHash("sha256").update(`${cli}\0${eventType}\0${sessionId}\0${toolUseId}`).digest("hex");
}

async function removeOldEntries(): Promise<void> {
  try {
    const names = await readdir(dedupDir);
    const now = Date.now();
    await Promise.all(names.map(async (name) => {
      const path = join(dedupDir, name);
      try {
        if (now - (await stat(path)).mtimeMs > RESULT_TTL_MS) await unlink(path);
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
    if (Date.now() - (await stat(path)).mtimeMs > RESULT_TTL_MS) return null;
  } catch {
    return null;
  }
  return readResponse(path);
}

export async function claimHookInvocation(
  eventType: string,
  cli: IntegrationType,
  payload: Record<string, unknown>,
): Promise<HookInvocationClaim> {
  const key = invocationKey(eventType, cli, payload);
  if (!key) return { role: "independent" };

  try {
    await mkdir(dedupDir, { recursive: true });
    void removeOldEntries();
    const lockPath = join(dedupDir, `${key}.lock`);
    const resultPath = join(dedupDir, `${key}.json`);
    const existingResponse = await readFreshResponse(resultPath);
    if (existingResponse) return { role: "duplicate", response: existingResponse };

    try {
      const handle = await open(lockPath, "wx");
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
          try {
            const tmpPath = `${resultPath}.${process.pid}.tmp`;
            await writeFile(tmpPath, JSON.stringify(response), "utf8");
            await rename(tmpPath, resultPath);
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

    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await readResponse(resultPath);
      if (response) return { role: "duplicate", response };
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } catch {
    // Deduplication is an optimization. Fail open into normal policy evaluation.
  }
  return { role: "independent" };
}

export function setHookInvocationDedupDirForTests(path: string): void {
  dedupDir = path;
}
