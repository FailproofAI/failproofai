import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as edge from "../src/edge/index.js";
import { EDGE_NOTICE, resetNotice } from "../src/edge/notice.js";

/**
 * The no-op build an Edge / Worker runtime or a browser bundle gets through the
 * `edge-light` / `workerd` / `worker` / `browser` export conditions.
 *
 * Found by `integration/nextjs.test.ts`: a Next.js route with
 * `export const runtime = "edge"` importing the SDK failed `next build`
 * outright — "Native module not found: node:fs" — because the real entry
 * statically imports Node builtins and an ES module cannot catch that.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const edgeDir = join(root, "src", "edge");

afterEach(() => {
  resetNotice();
  vi.restoreAllMocks();
});

describe("the edge build's imports", () => {
  it("imports no Node builtin and nothing from the Node build but VERSION and types", () => {
    for (const file of readdirSync(edgeDir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(edgeDir, file), "utf8");
      const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)].map((m) => ({
        typeOnly: m[1] !== undefined,
        from: m[2]!,
      }));
      for (const { typeOnly, from } of imports) {
        if (typeOnly) continue;
        const allowed = from.startsWith("./") || from === "../version.js";
        expect(allowed, `${file} imports ${from} at run time`).toBe(true);
      }
      expect(source, file).not.toMatch(/\bprocess\./);
      expect(source, file).not.toMatch(/require\(/);
    }
  });
});

/**
 * Exports of the Node build that are internals (test helpers, parsing
 * functions) rather than API; an edge module need not mirror them. Anything
 * NOT listed here must exist in the edge build, or an Edge import of it is a
 * link error — the crash this build exists to prevent.
 */
const INTERNAL: Record<string, string[]> = {
  index: [],
  ai: ["toolCallsOf", "_internals", "usageTokens", "stopReasonOf", "responseContent"],
  langchain: [
    "ABANDONED_ROOT_GRACE_MS",
    "PAUSED_SESSION_TTL_MS",
    "_stats",
    "captureLimitOf",
    "interruptIdOf",
    "isCancellation",
    "isControlFlow",
    "nodeOf",
    "normalizeMessages",
    "resetOrphanWarning",
    "promptOf",
    "readOptions",
    "summarizeDocuments",
    "toolOutput",
    "usageOf",
  ],
  mastra: ["_internals"],
  llamaindex: ["BELOW_VERSION", "MIN_VERSION", "eventCallerStorage", "parseOptions", "summarizeNodes", "usageOf"],
};

const PAIRS: Array<[string, () => Promise<Record<string, unknown>>, () => Promise<Record<string, unknown>>]> = [
  ["index", () => import("../src/index.js"), () => import("../src/edge/index.js")],
  ["ai", () => import("../src/integrations/ai.js"), () => import("../src/edge/ai.js")],
  ["langchain", () => import("../src/integrations/langchain.js"), () => import("../src/edge/langchain.js")],
  ["mastra", () => import("../src/integrations/mastra.js"), () => import("../src/edge/mastra.js")],
  ["llamaindex", () => import("../src/integrations/llamaindex.js"), () => import("../src/edge/llamaindex.js")],
];

describe.each(PAIRS)("the edge %s module", (name, loadReal, loadEdge) => {
  it("exports every public name the Node build does, as the same kind of value", async () => {
    const real = await loadReal();
    const noop = await loadEdge();
    const missing: string[] = [];
    for (const key of Object.keys(real)) {
      if (INTERNAL[name]!.includes(key)) continue;
      if (!(key in noop)) missing.push(key);
      else expect(typeof noop[key], `${name}.${key}`).toBe(typeof real[key]);
    }
    expect(missing).toEqual([]);
  });

  it("is what every edge export condition selects", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports: Record<string, Record<string, unknown>>;
    };
    const entry = manifest.exports[name === "index" ? "." : `./${name}`]!;
    const conditions = Object.keys(entry);
    // Ahead of import/require: a bundler takes the FIRST condition it matches.
    expect(conditions.slice(0, 4)).toEqual(["edge-light", "workerd", "worker", "browser"]);
    for (const condition of conditions.slice(0, 4)) {
      expect(entry[condition]).toEqual({
        import: { types: expect.any(String), default: `./dist/esm/edge/${name}.js` },
        require: { types: expect.any(String), default: `./dist/cjs/edge/${name}.js` },
      });
      // The REAL declarations, so code that compiles for Node compiles here.
      const real = name === "index" ? "index" : `integrations/${name}`;
      expect((entry[condition] as { import: { types: string } }).import.types).toBe(`./dist/esm/${real}.d.ts`);
    }
  });
});

describe("the edge build's behaviour", () => {
  it("runs scope bodies and returns their values, recording nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await edge.session({ sessionId: "s-1" }, (sessionId) =>
      edge.agent("planner", { goal: "g" }, (identity) =>
        edge.toolCall("search", { toolCallId: "call-1", input: { q: 1 } }, (call) => {
          call.output = 42;
          return { sessionId, agent: identity.agentId, call: call.id, assigned: call.outputAssigned };
        }),
      ),
    );
    expect(out).toEqual({ sessionId: "s-1", agent: "planner", call: "call-1", assigned: true });
    expect(edge.session(() => "no options")).toBe("no options");
    expect(await edge.agent("a", async () => 7)).toBe(7);

    const scope = edge.agent.open("planner");
    expect(scope.agentId).toBe("planner");
    scope.dispose();
    edge.session.open().dispose();
    edge.toolCall.open("t").dispose();

    for (const method of Object.keys(edge.event)) {
      expect(() => (edge.event as unknown as Record<string, (o: unknown) => void>)[method]!({})).not.toThrow();
    }
    expect(Object.keys(edge.event)).toHaveLength(15);
    await expect(edge.flush()).resolves.toBeUndefined();
    expect(await edge.instrument()).toEqual([]);
    expect(await (edge.instrument as (name: string) => Promise<unknown[]>)("langchain")).toEqual([]);
    expect(edge.uninstrument()).toEqual([]);
    expect(edge.current().sessionId).toBeNull();
    expect(edge.AUTO).toBe(Symbol.for("failproofai.AUTO"));

    // Said once, on first use — and it says nothing is recorded.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(`[failproofai-sdk] ${EDGE_NOTICE}`);
    expect(EDGE_NOTICE).toContain("NOTHING is recorded");
  });

  it("is silent when merely imported", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await import("../src/edge/ai.js");
    expect(warn).not.toHaveBeenCalled();
  });

  it("hands the frameworks values they accept and that record nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ai = await import("../src/edge/ai.js");
    expect(ai.telemetry({ functionId: "f" })).toEqual({ isEnabled: false, functionId: "f" });
    const model = { modelId: "m" };
    expect(await ai.wrapModel(model)).toBe(model);
    const mw = ai.middleware();
    expect(await mw.wrapGenerate({ doGenerate: async () => "generated" })).toBe("generated");
    expect(await mw.wrapStream({ doStream: async () => "streamed" })).toBe("streamed");
    const tool = { execute: () => 1 };
    expect(ai.wrapTool("t", tool)).toBe(tool);
    expect(ai.tracer().startActiveSpan("x", (span: { isRecording(): boolean }) => span.isRecording())).toBe(false);

    const langchain = await import("../src/edge/langchain.js");
    expect(typeof langchain.langchainHandler()).toBe("object");
    const mastra = await import("../src/edge/mastra.js");
    expect(mastra.workflow("w", () => "ran")).toBe("ran");
    expect(mastra.wrapTool(tool)).toBe(tool);
    const llamaindex = await import("../src/edge/llamaindex.js");
    expect(typeof llamaindex.attach()).toBe("function");
  });
});
