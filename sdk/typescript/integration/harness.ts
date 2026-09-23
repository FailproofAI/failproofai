import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/**
 * The real-framework harness.
 *
 * Everything under `test/` runs against `src/` with no framework installed, so
 * it can prove an adapter's logic and nothing about whether that logic ever
 * reaches the framework. The failures this directory exists for are invisible
 * from there and total from outside it:
 *
 *   * an adapter that patches the CommonJS copy of a dual-published framework
 *     while an ES-module app runs the ESM copy — `instrument()` reports
 *     success, every event is lost, nothing warns;
 *   * a framework major that moved the extension point — the adapter still
 *     installs, the callbacks never fire;
 *   * type declarations that resolve in the SDK's own `nodenext` tsconfig and
 *     in no CommonJS project's.
 *
 * So each fixture is a real consumer project: its own `package.json`, its own
 * lockfile pinning a real framework release, the PACKED tarball extracted into
 * its `node_modules` exactly as `npm install @failproofai/sdk` would lay it out,
 * and one `agent.ts` run twice — once transpiled to an ES module and once to
 * CommonJS — because the two module systems load different copies of the
 * framework and both are what customers run.
 */

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = join(ROOT, "integration", "fixtures");

export type Format = "esm" | "cjs";
export const FORMATS: readonly Format[] = ["esm", "cjs"];

export type Event = Record<string, unknown> & {
  type: string;
  session_id: string;
  agent_id: string;
};

export interface RunResult {
  events: Event[];
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Pack `dist/` exactly as `npm publish` would, once per process. */
let tarball: string | null = null;
export function packedTarball(): string {
  if (tarball !== null) return tarball;
  if (!existsSync(join(ROOT, "dist", "esm", "index.js"))) {
    throw new Error("dist/ is not built. Run `npm run build` first (`npm run test:integration` does).");
  }
  const out = mkdtempSync(join(tmpdir(), "failproofai-sdk-pack-"));
  const name = execFileSync("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", out], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop()!;
  tarball = join(out, name);
  return tarball;
}

/**
 * Install one fixture: `npm ci` against its lockfile, then the packed SDK.
 *
 * The SDK is extracted rather than `npm install`ed. It has no dependencies to
 * resolve, and an install would rewrite the fixture's lockfile — which is the
 * one file that pins the framework release this fixture exists to test.
 *
 * `npm ci` is skipped when `node_modules` was already built from this exact
 * lockfile, so a local re-run costs seconds rather than minutes.
 */
export async function installFixture(fixture: string, pack: string): Promise<void> {
  const dir = join(FIXTURES, fixture);
  const lock = join(dir, "package-lock.json");
  if (!existsSync(lock)) throw new Error(`${fixture} has no package-lock.json`);
  const stamp = join(dir, "node_modules", ".failproofai-lock");
  const lockText = readFileSync(lock, "utf8");
  if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== lockText) {
    await run("npm", ["ci", "--no-audit", "--no-fund", "--ignore-scripts"], dir, `npm ci in ${fixture}`);
    writeFileSync(stamp, lockText);
  }
  const target = join(dir, "node_modules", "@failproofai", "sdk");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", pack, "-C", target, "--strip-components=1"]);
  transpile(fixture);
}

function run(command: string, args: string[], cwd: string, label: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${label} failed (exit ${String(code)}):\n${output}`)),
    );
  });
}

/** Every fixture directory, i.e. every framework release under test. */
export function fixtures(): string[] {
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(FIXTURES, entry.name, "package.json")))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Transpile `agent.ts` into both module systems, beside the fixture's
 * `node_modules` so resolution is exactly the fixture's.
 *
 * `transpileModule` rather than `tsc`: this step is about RUNTIME resolution and
 * must not fail because of a type error — type correctness is checked
 * separately, by `typecheck()`, where a failure names itself.
 */
export function transpile(fixture: string): void {
  const dir = join(FIXTURES, fixture);
  const out = join(dir, ".run");
  mkdirSync(out, { recursive: true });
  // `agent.ts`, plus any other top-level `agent-*.ts` program a fixture carries
  // for APIs only its own framework release has, and the named EXTRA_PROGRAMS
  // (the ai fixtures' `surfaces.ts`) — all run through `runAgent`'s `program`.
  // Each is standalone: programs never import one another.
  const programs = readdirSync(dir).filter(
    (name) => /^agent(-[\w-]+)?\.ts$/.test(name) || EXTRA_PROGRAMS.some((extra) => name === `${extra}.ts`),
  );
  for (const name of programs) {
    const base = name.slice(0, -".ts".length);
    const source = readFileSync(join(dir, name), "utf8");
    const emit = (module: ts.ModuleKind, file: string): void => {
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        fileName: join(dir, name),
      });
      writeFileSync(join(out, file), outputText);
    };
    emit(ts.ModuleKind.ESNext, `${base}.mjs`);
    emit(ts.ModuleKind.CommonJS, `${base}.cjs`);
  }
}

/** Entry programs besides `agent.ts` that a fixture may ship, run with `runAgent(..., program)`. */
const EXTRA_PROGRAMS = ["surfaces"];

/** Run one case of a fixture's agent in one module system. */
export function runAgent(
  fixture: string,
  format: Format,
  scenario: string,
  env: Record<string, string> = {},
  /** Which `agent*.ts` program of the fixture to run; `agent` unless it carries more. */
  program = "agent",
): RunResult {
  const dir = join(FIXTURES, fixture);
  const home = mkdtempSync(join(tmpdir(), `failproofai-it-${fixture}-`));
  try {
    const entry = join(dir, ".run", `${program}.${format === "esm" ? "mjs" : "cjs"}`);
    const result = spawnSync(process.execPath, [entry, scenario], {
      cwd: dir,
      encoding: "utf8",
      timeout: 90_000,
      env: {
        ...process.env,
        // Never the developer's real spool: a running daemon would collect it.
        FAILPROOFAI_HOME: home,
        FAILPROOFAI_SDK_STRICT: "1",
        NODE_OPTIONS: "",
        ...env,
      },
    });
    return {
      events: readSpool(join(home, "custom-agents", "events")),
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function readSpool(dir: string): Event[] {
  if (!existsSync(dir)) return [];
  const events: Event[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line.trim()) events.push(JSON.parse(line) as Event);
    }
  }
  // Batches are named by time, then pid, then sequence; order within the run
  // is the order the timestamps say, with the file order breaking ties.
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => String(a.event.timestamp).localeCompare(String(b.event.timestamp)) || a.index - b.index)
    .map(({ event }) => event);
}

/** `tsc --noEmit` over a fixture with a given tsconfig; returns diagnostics. */
export function typecheck(fixture: string, tsconfig = "tsconfig.json"): string {
  const dir = join(FIXTURES, fixture);
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", join(dir, tsconfig), "--noEmit"], {
    cwd: dir,
    encoding: "utf8",
  });
  return (result.stdout + result.stderr).trim();
}

export const count = (events: Event[], type: string): number =>
  events.filter((event) => event.type === type).length;

export const ofType = (events: Event[], type: string): Event[] =>
  events.filter((event) => event.type === type);

/**
 * The four checks every adapter must pass, from the Python SDK's
 * `skill/references/frameworks.md` ("Verifying an adapter"), plus the two that
 * make them meaningful: something was recorded, and nothing was recorded twice.
 * Returns the list of violations so a failure names every problem at once.
 */
export function traceViolations(events: Event[]): string[] {
  const problems: string[] = [];
  if (events.length === 0) return ["no events were recorded"];

  const bySession = new Map<string, Event[]>();
  for (const event of events) {
    const list = bySession.get(event.session_id) ?? [];
    list.push(event);
    bySession.set(event.session_id, list);
  }
  const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

  for (const [session, list] of bySession) {
    // 1. The first event of each session is the root agent_start.
    if (list[0]!.type !== "agent_start") {
      problems.push(`session ${session} starts with ${list[0]!.type}, not agent_start`);
    }
    // 2. agent_id values are names, not UUIDs.
    for (const id of new Set(list.map((e) => e.agent_id))) {
      if (UUID.test(id)) problems.push(`session ${session} has a UUID agent_id ${id}`);
    }
    // 3. model_request/model_response pair on request_id, response has duration.
    const requests = new Set(ofType(list, "model_request").map((e) => e.request_id));
    for (const response of ofType(list, "model_response")) {
      if (!requests.has(response.request_id)) {
        problems.push(`model_response ${String(response.request_id)} has no matching model_request`);
      }
      if (typeof response.duration_ms !== "number") {
        problems.push(`model_response ${String(response.request_id)} has no duration_ms`);
      }
    }
    if (count(list, "model_request") !== count(list, "model_response")) {
      problems.push(
        `session ${session}: ${count(list, "model_request")} model_request vs ` +
          `${count(list, "model_response")} model_response`,
      );
    }
    // 4. Nothing left open.
    const pairs: Array<[string, string, string]> = [
      ["tool_use", "tool_result", "tool_call_id"],
      ["hook_triggered", "hook_completed", "hook_id"],
    ];
    for (const [open, close, key] of pairs) {
      const opened = ofType(list, open).map((e) => String(e[key]));
      const closed = new Set(ofType(list, close).map((e) => String(e[key])));
      for (const id of opened) if (!closed.has(id)) problems.push(`${open} ${id} never closed`);
      const dupes = opened.filter((id, i) => opened.indexOf(id) !== i);
      for (const id of new Set(dupes)) problems.push(`${open} ${id} emitted more than once`);
    }
    const depth = new Map<string, number>();
    for (const event of list) {
      if (event.type === "agent_start") depth.set(event.agent_id, (depth.get(event.agent_id) ?? 0) + 1);
      if (event.type === "agent_end") depth.set(event.agent_id, (depth.get(event.agent_id) ?? 0) - 1);
    }
    for (const [agent, open] of depth) {
      if (open !== 0) problems.push(`session ${session}: agent ${agent} start/end imbalance ${open}`);
    }
  }
  return problems;
}

/** Shorthand for a failure message that shows the trace it is about. */
export function describeTrace(result: RunResult): string {
  const lines = result.events.map(
    (e) =>
      `  ${e.session_id.slice(0, 12)} ${e.agent_id} ${e.type}` +
      (e.tool_name ? ` tool=${JSON.stringify(e.tool_name)}` : "") +
      (e.hook_name ? ` hook=${JSON.stringify(e.hook_name)}` : "") +
      (e.input_tokens !== undefined ? ` tokens=${JSON.stringify([e.input_tokens, e.output_tokens])}` : ""),
  );
  return [
    `exit=${String(result.status)}`,
    `trace (${result.events.length}):`,
    ...lines,
    `stdout: ${result.stdout.slice(-1500)}`,
    `stderr: ${result.stderr.slice(-3000)}`,
  ].join("\n");
}
