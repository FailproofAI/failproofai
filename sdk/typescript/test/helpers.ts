import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setBaseDir } from "../src/resolver.js";
import { runtime } from "../src/runtime.js";

export interface Spool {
  dir: string;
  /** Every event written so far, oldest batch first. */
  events(): Array<Record<string, unknown>>;
  /** The raw lines, for tests that care about bytes rather than values. */
  lines(): string[];
  files(): string[];
  /**
   * Drain the writer into THIS spool, then remove it.
   *
   * Draining first is not tidiness. The writer is process-wide and its queue
   * outlives a test, so a test that left events buffered would have them
   * flushed by the NEXT test — into that test's assertions, and, in the window
   * where no base directory is set, into the developer's real
   * `~/.failproofai/custom-agents`, where a running daemon would collect them.
   */
  cleanup(): Promise<void>;
}

/**
 * A throwaway spool root with the writer pointed at it.
 *
 * Every test that emits anything needs this: without it they would write into
 * the developer's real `~/.failproofai/custom-agents`, where a daemon would
 * happily collect the fixtures and ship them.
 */
export function useSpool(): Spool {
  const dir = mkdtempSync(join(tmpdir(), "failproofai-sdk-test-"));
  setBaseDir(dir);
  const eventsDir = join(dir, "events");
  return {
    dir,
    files(): string[] {
      try {
        return readdirSync(eventsDir)
          .filter((name) => name.endsWith(".jsonl"))
          .sort();
      } catch {
        return [];
      }
    },
    lines(): string[] {
      return this.files().flatMap((name) =>
        readFileSync(join(eventsDir, name), "utf8").split("\n").filter(Boolean),
      );
    },
    events(): Array<Record<string, unknown>> {
      return this.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    async cleanup(): Promise<void> {
      await runtime.writer.flushNow();
      setBaseDir(null);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Flush the process-wide writer and read back what landed. */
export async function flushed(spool: Spool): Promise<Array<Record<string, unknown>>> {
  await runtime.writer.flushNow();
  return spool.events();
}

/** The built ESM entry, as a URL a child process can import. */
export function indexUrl(): string {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const entry = join(root, "dist/esm/index.js");
  if (!existsSync(entry)) {
    throw new Error(`dist/esm/index.js is not built. Run \`npm run build\` (\`npm test\` does it).`);
  }
  return pathToFileURL(entry).href;
}

/**
 * Run `source` in a FRESH Node process and collect its output.
 *
 * Some of this SDK's guarantees are about process lifetime — the flush interval
 * must not keep the loop alive, and the exit hook must write what is buffered.
 * Neither can be observed from inside a test runner, which holds the loop open
 * by itself and never exits.
 */
export async function runNode(
  source: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** A minimal transcript for the evaluator tests. */
export function transcriptWire(
  events: Array<{ type: string; payload?: Record<string, unknown> }> = [],
): Record<string, unknown> {
  return {
    schema_version: "2",
    assignment_id: "assignment-1",
    session_id: "session-1",
    session_revision_id: "revision-1",
    agent_id: "main",
    environment: "dev",
    started_at: "2026-01-01T00:00:00.000000Z",
    ended_at: "2026-01-01T00:05:00.000000Z",
    event_count: events.length,
    events: events.map((event, index) => ({
      id: `e${index}`,
      ts: "2026-01-01T00:00:01.000000Z",
      event_type: event.type,
      payload: event.payload ?? {},
    })),
  };
}
