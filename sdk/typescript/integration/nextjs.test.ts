import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FIXTURES, describeTrace, runAgentAsync, traceViolations, type Event, type RunResult } from "./harness.js";
import { digest } from "./runtime-parity.js";

/**
 * Next.js (App Router), the way it is deployed next to failproofaid: `next
 * build`, then `next start` as a long-running server, `instrument()` called
 * from `instrumentation.ts` — Next's documented startup hook.
 *
 * Each route runs the same program as a framework fixture's scenario (its
 * "twin"), with the same scripted model; the trace the route leaves in the
 * spool must equal the twin's trace under plain Node.
 *
 * ## Bundled or external — the question this file answers per framework
 *
 * Next 16's built-in `serverExternalPackages` list includes none of the four
 * frameworks, so by DEFAULT every one of them is bundled into the server
 * chunks: a copy that no `require`/`import` of `node_modules` can reach.
 *
 *   * `ai` records through `instrument()` either way — ai 7 reads its
 *     telemetry integrations from a global, which the bundled copy reads too.
 *   * LangChain, Mastra and LlamaIndex record through `instrument()` ONLY when
 *     listed in `serverExternalPackages`. Bundled, `instrument()` returns their
 *     names and records NOTHING: it patched the `node_modules` copy, the routes
 *     run the bundled one. Asserted below as empty, so a change shows up.
 *   * The call-site helpers (`langchainHandler()`, `telemetry()`, Mastra
 *     `wrapTool()`) work in every configuration: they travel with the call.
 *
 * External packages are loaded by Next with `import()` (Turbopack and webpack
 * alike) from a CommonJS launcher; before `appImportsReachCommonJs` the SDK
 * patched the CommonJS copies there and even the external configuration
 * recorded nothing for those three.
 *
 * Twin fixtures (langchain-1, ai-7, mastra-1, llamaindex-0.12) must be
 * installed alongside `nextjs`: `FAILPROOFAI_IT_FIXTURES=nextjs,langchain-1,ai-7,mastra-1,llamaindex-0.12`.
 */

const APP = join(FIXTURES, "nextjs");
const NEXT = join(APP, "node_modules", "next", "dist", "bin", "next");

interface Variant {
  name: string;
  dist: string;
  bundler: "turbopack" | "webpack";
  external: boolean;
  /** Built with `withFailproofai(config)` instead of a hand-written list. */
  wrapped?: boolean;
}

const VARIANTS: Variant[] = [
  { name: "turbopack, default config (frameworks bundled)", dist: ".next-it-turbopack", bundler: "turbopack", external: false },
  { name: "turbopack, frameworks in serverExternalPackages", dist: ".next-it-turbopack-external", bundler: "turbopack", external: true },
  { name: "webpack, default config (frameworks bundled)", dist: ".next-it-webpack", bundler: "webpack", external: false },
  { name: "webpack, frameworks in serverExternalPackages", dist: ".next-it-webpack-external", bundler: "webpack", external: true },
  { name: "turbopack, withFailproofai(nextConfig)", dist: ".next-it-turbopack-wrapped", bundler: "turbopack", external: true, wrapped: true },
];

const nextEnv = (variant: Variant): Record<string, string> => ({
  NEXT_TELEMETRY_DISABLED: "1",
  FAILPROOFAI_IT_NEXT_DIST: variant.dist,
  FAILPROOFAI_IT_NEXT_EXTERNAL: variant.external && !variant.wrapped ? "1" : "",
  FAILPROOFAI_IT_NEXT_WRAP: variant.wrapped ? "1" : "",
  // A hand-written list carries no marker, so the documented override tells
  // `instrument()` the app is configured. The wrapper needs none: it records
  // what it externalized when Next evaluates the config.
  FAILPROOFAI_NEXT_EXTERNALS: variant.external && !variant.wrapped ? "1" : "",
});

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

/** Reads only the spool files that appeared since the last call. */
class Spool {
  private seen = new Set<string>();
  constructor(readonly dir: string) {}

  private fresh(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".jsonl") && !this.seen.has(name))
      .sort();
  }

  /** Wait for the request's events to land and stop arriving, then take them. */
  async take(options: { expectNone?: boolean } = {}): Promise<Event[]> {
    const deadline = Date.now() + 20_000;
    let lastCount = -1;
    let stableSince = Date.now();
    // Four flush intervals with nothing new is "done"; for a case expected to
    // record nothing, that same quiet period is the whole wait.
    const quiet = 2_000;
    for (;;) {
      const count = this.fresh().length;
      if (count !== lastCount) {
        lastCount = count;
        stableSince = Date.now();
      }
      if ((count > 0 || options.expectNone) && Date.now() - stableSince >= quiet) break;
      if (Date.now() > deadline) break;
      await sleep(200);
    }
    const events: Event[] = [];
    for (const name of this.fresh()) {
      this.seen.add(name);
      for (const line of readFileSync(join(this.dir, name), "utf8").split("\n")) {
        if (line.trim()) events.push(JSON.parse(line) as Event);
      }
    }
    return events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  }
}

/** Twins run once per file: the same scenario always yields the same trace. */
const twins = new Map<string, Promise<RunResult>>();
function twin(fixture: string, scenario: string): Promise<RunResult> {
  const key = `${fixture}:${scenario}`;
  if (!twins.has(key)) {
    if (!existsSync(join(FIXTURES, fixture, ".run", "agent.mjs"))) {
      throw new Error(`twin fixture ${fixture} is not installed; add it to FAILPROOFAI_IT_FIXTURES`);
    }
    twins.set(key, runAgentAsync(fixture, "esm", scenario));
  }
  return twins.get(key)!;
}

const asTrace = (events: Event[], stderr = ""): RunResult => ({ events, stdout: "", stderr, status: 0 });

describe.each(VARIANTS)("Next.js 16, $name", (variant) => {
  let server: ChildProcess | null = null;
  let base = "";
  let home = "";
  let spool: Spool;
  let stderr = "";

  beforeAll(async () => {
    const args = [NEXT, "build", ...(variant.bundler === "webpack" ? ["--webpack"] : [])];
    const build = spawnSync(process.execPath, args, {
      cwd: APP,
      encoding: "utf8",
      env: { ...process.env, ...nextEnv(variant), NODE_OPTIONS: "" },
      timeout: 600_000,
    });
    if (build.status !== 0) {
      throw new Error(`next build failed (${variant.name}):\n${build.stdout}\n${build.stderr}`);
    }

    home = mkdtempSync(join(tmpdir(), "failproofai-it-nextjs-"));
    spool = new Spool(join(home, "custom-agents", "events"));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [NEXT, "start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: APP,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...nextEnv(variant),
        NODE_OPTIONS: "",
        FAILPROOFAI_HOME: home,
        FAILPROOFAI_SDK_STRICT: "1",
      },
    });
    server.stdout!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    server.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    for (let i = 0; i < 150; i += 1) {
      try {
        if ((await fetch(`${base}/api/status`)).ok) return;
      } catch {
        /* not up yet */
      }
      await sleep(200);
    }
    throw new Error(`next start never answered:\n${stderr}`);
  });

  afterAll(async () => {
    if (server !== null) {
      server.kill("SIGTERM");
      await new Promise((resolveExit) => server!.once("exit", resolveExit));
    }
    if (home) rmSync(home, { recursive: true, force: true });
  });

  /** GET a route (reading the whole body, as a client does) and take its trace. */
  const call = async (path: string, options: { expectNone?: boolean } = {}) => {
    const response = await fetch(`${base}${path}`);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    return { body, events: await spool.take(options) };
  };

  const expectTwin = async (events: Event[], fixture: string, scenario: string) => {
    const expected = await twin(fixture, scenario);
    expect(expected.status, describeTrace(expected)).toBe(0);
    const context = `NEXT (${variant.name})\n${describeTrace(asTrace(events, stderr))}\n\nTWIN ${fixture} ${scenario}\n${describeTrace(expected)}`;
    let got = events;
    let want = expected.events;
    if (fixture.startsWith("langchain")) {
      // KNOWN ADAPTER ISSUE, pinned so its fix shows up: for a chat model with
      // no model-name parameter the LangChain adapter falls back to the model's
      // CLASS name, and Next minifies the app's classes — `ScriptedModel`
      // arrives as `d` or `v5`. The rest of the trace must still match.
      const models = (list: Event[]) =>
        [...new Set(list.filter((e) => e.type.startsWith("model_")).map((e) => e.model))];
      expect(models(want)).toEqual(["ScriptedModel"]);
      expect(models(got), context).not.toEqual(["ScriptedModel"]);
      const mask = (list: Event[]) => list.map((e) => (e.type.startsWith("model_") ? { ...e, model: "<class>" } : e));
      got = mask(got);
      want = mask(want);
    }
    expect(digest(got), context).toEqual(digest(want));
    expect(traceViolations(events), context).toEqual([]);
  };

  it("runs instrument() from instrumentation.ts before the first request", async () => {
    const status = (await (await fetch(`${base}/api/status`)).json()) as { instrumented: string[] | null };
    expect(status.instrumented).toEqual(["ai", "langchain", "llamaindex", "mastra"]);
  });

  describe("call-site helpers work whether the framework is bundled or not", () => {
    it("LangGraph with langchainHandler()", async () => {
      const { body, events } = await call("/api/langgraph?mode=handler");
      expect(body).toContain("It is sunny in Paris.");
      await expectTwin(events, "langchain-1", variant.external ? "handler-and-instrument" : "handler");
    });

    it("ai generateText with telemetry()", async () => {
      const { body, events } = await call("/api/ai?mode=telemetry");
      expect(body).toContain("It is 20C in Paris.");
      await expectTwin(events, "ai-7", "generate");
    });

    it("ai streamText with telemetry(), returned as toUIMessageStreamResponse()", async () => {
      const { body, events } = await call("/api/ai?mode=stream");
      expect(body).toContain('"type":"finish"');
      await expectTwin(events, "ai-7", "stream");
    });

    it("Mastra wrapTool()", async () => {
      const { body, events } = await call("/api/mastra?mode=wraptool");
      expect(body).toContain("sunny");
      await expectTwin(events, "mastra-1", "wraptool");
    });

    it("a server action running an agent", async () => {
      const manifest = JSON.parse(
        readFileSync(join(APP, variant.dist, "server", "server-reference-manifest.json"), "utf8"),
      ) as { node: Record<string, { exportedName?: string }> };
      const id = Object.entries(manifest.node).find(([, entry]) => entry.exportedName === "askWeather")?.[0];
      expect(id, "askWeather is in the server-reference manifest").toBeDefined();
      const response = await fetch(`${base}/`, {
        method: "POST",
        headers: { "Next-Action": id!, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" },
        body: "[]",
      });
      expect(await response.text()).toContain("It is 20C in Paris.");
      await expectTwin(await spool.take(), "ai-7", "generate");
    });
  });

  describe("instrument()", () => {
    it("records the Vercel AI SDK, bundled or not", async () => {
      await expectTwin((await call("/api/ai?mode=instrument")).events, "ai-7", "instrument");
      await expectTwin((await call("/api/ai?mode=instrument-stream")).events, "ai-7", "instrument-stream");
    });

    const patched: Array<[string, string, string, string]> = [
      ["LangGraph", "/api/langgraph?mode=instrument", "langchain-1", "graph"],
      ["a Mastra agent", "/api/mastra?mode=instrument", "mastra-1", "generate"],
      ["a LlamaIndex agent workflow", "/api/llamaindex", "llamaindex-0.12", "workflow"],
    ];
    if (variant.external) {
      it.each(patched)("records %s when it is in serverExternalPackages", async (_label, path, fixture, scenario) => {
        await expectTwin((await call(path)).events, fixture, scenario);
      });
    } else {
      it.each(patched)(
        "records NOTHING for %s when Next bundles it — the known limitation",
        async (_label, path) => {
          const { body, events } = await call(path, { expectNone: true });
          expect(body).toContain("sunny");
          expect(events, describeTrace(asTrace(events, stderr))).toEqual([]);
        },
      );
    }
  });

  it("serves an Edge-runtime route that imports the SDK: its no-op build, announced once, nothing recorded", async () => {
    const { body, events } = await call("/api/edge", { expectNone: true });
    expect(JSON.parse(body)).toEqual({ imported: true, emitted: true, flushed: true });
    expect(events).toEqual([]);
    expect(stderr.match(/loaded its no-op build/g) ?? []).toHaveLength(1);
  });

  it("warns for each adapter Next bundles, and otherwise prints nothing from the SDK", () => {
    const lines = stderr
      .split("\n")
      .filter((line) => line.includes("[failproofai-sdk]") && !line.includes("loaded its no-op build"));
    const warned = lines
      .map((line) => /instrument\("([a-z]+)"\) is running under Next\.js/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined)
      .sort();
    // Bundled: exactly the three adapters that cannot reach a bundled copy,
    // each once, naming the wrapper. Never the Vercel AI SDK, which records
    // bundled or not. Configured (wrapper or hand-written list + override):
    // silence.
    expect(warned, stderr).toEqual(variant.external ? [] : ["langchain", "llamaindex", "mastra"]);
    if (!variant.external) {
      for (const line of lines) expect(line).toContain("withFailproofai");
    }
    expect(lines.length, stderr).toBe(warned.length);
    // Loading a second copy of LlamaIndex beside the one the app runs makes
    // LlamaIndex itself warn. External: the SDK patches the app's own copy, so
    // there is no second one. Bundled: `instrument()` loads the node_modules
    // copy the bundle never uses — LlamaIndex notices, and says so.
    const doubled = stderr.includes("llamaindex was already imported");
    expect(doubled, stderr).toBe(!variant.external);
  });
});
