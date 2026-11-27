import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as edge from "../src/edge/index.js";
import * as edgeAi from "../src/edge/ai.js";
import * as edgeLangchain from "../src/edge/langchain.js";
import * as edgeLlamaindex from "../src/edge/llamaindex.js";
import * as edgeMastra from "../src/edge/mastra.js";
import { resetNotice } from "../src/edge/notice.js";
import { EventNamespace, UNATTRIBUTED_SESSION } from "../src/events.js";
import * as failproofai from "../src/index.js";
import { selfReportTool as aiTool } from "../src/integrations/ai.js";
import { selfReportTool as langchainTool } from "../src/integrations/langchain.js";
import { selfReportTool as llamaindexTool } from "../src/integrations/llamaindex.js";
import { selfReportTool as mastraTool } from "../src/integrations/mastra.js";
import { setLogger } from "../src/logger.js";
import { runtime } from "../src/runtime.js";
import * as schema from "../src/schema.js";
import { agent, session, toolCall } from "../src/scopes.js";
import { DEFAULT_SELF_REPORT_CATEGORIES, clipDetail } from "../src/self-report-spec.js";
import { flushed, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

/**
 * Self Reports in the TypeScript SDK: the `self_report` event, the settings
 * file, the raw tool helpers and the framework tools. The tool's name,
 * description, schema and answer are a contract shared with the MCP servers and
 * the Python SDK, so the texts below are asserted verbatim.
 */

let spool: Spool;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  spool = useSpool();
  home = mkdtempSync(join(tmpdir(), "failproofai-sr-home-"));
  previousHome = process.env.FAILPROOFAI_HOME;
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(async () => {
  await spool.cleanup();
  setLogger(null);
  if (previousHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  resetNotice();
  vi.restoreAllMocks();
});

/** openai's Responses `FunctionTool` (openai 7.x), copied: this package does not depend on openai. */
interface OpenAIFunctionTool {
  name: string;
  parameters: { [key: string]: unknown } | null;
  strict: boolean | null;
  type: "function";
  description?: string | null;
}

const reports = async () => (await flushed(spool)).filter((e) => e.type === "self_report");
const writeSettings = (value: unknown) =>
  writeFileSync(join(home, "self-report.json"), typeof value === "string" ? value : JSON.stringify(value));
const quietLogger = () => {
  const warn = vi.fn();
  setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
  return warn;
};

const DEFAULT_DESCRIPTION = [
  "Report to FailproofAI that you are stuck. Call this only when you are blocked and cannot make progress on your own; do not call it for normal work, clarifying questions or a single error. One call per distinct problem.",
  "Reporting does not unblock you and changes no decision: afterwards, work around the problem or tell the user what is blocking you. There is no need to mention this report to the user.",
  "",
  "Categories:",
  "- looping: You keep repeating the same or circular steps without making progress.",
  "- cannot_do_request: The user asked for something you cannot do here: a missing capability, tool or permission, or it is only possible by cheating.",
  "- invalid_tool_or_credential: A tool, MCP server, plugin, API key or token you need is broken, invalid, expired or rejected.",
  "- missing_context: Information or access you need is missing and you cannot get it yourself. Not for normal clarifying questions.",
  "- repeated_tool_failure: A command or tool failed on several distinct attempts and is blocking you. A single error is not enough.",
  "- task_failure: You genuinely tried and could not complete the task. Not for refusals or policy blocks.",
].join("\n");

const DEFAULT_SCHEMA = {
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: [
        "looping",
        "cannot_do_request",
        "invalid_tool_or_credential",
        "missing_context",
        "repeated_tool_failure",
        "task_failure",
      ],
    },
    detail: { type: "string", description: "One factual sentence: what is blocking you." },
  },
  required: ["category", "detail"],
  additionalProperties: false,
};

describe("the self_report wire format", () => {
  it("puts category, detail and source beside the identity, then environment, then tool_call_id", () => {
    const event = schema.selfReportEvent({
      timestamp: "2026-01-01T00:00:00.000000Z",
      sessionId: "s1",
      agentId: "main",
      category: "looping",
      detail: "d",
      source: "sdk",
      toolCallId: "c1",
      extraFields: { fw_x: 1 },
    });
    expect(Object.keys(event)).toEqual([
      "timestamp",
      "session_id",
      "agent_id",
      "type",
      "category",
      "detail",
      "source",
      "environment",
      "tool_call_id",
      "fw_x",
    ]);
    expect(event.type).toBe("self_report");
  });

  it("declares its fields, so an adapter extra cannot overwrite them", () => {
    for (const name of ["category", "detail", "source"]) expect(schema.DECLARED_FIELD_NAMES.has(name)).toBe(true);
  });
});

describe("event.selfReport and selfReport()", () => {
  it("records in the current session and agent with source sdk", async () => {
    await session({ sessionId: "s1" }, () =>
      agent("planner", () => failproofai.selfReport("looping", "Going in circles.")),
    );
    const [report] = await reports();
    expect(report).toMatchObject({
      session_id: "s1",
      agent_id: "planner",
      category: "looping",
      detail: "Going in circles.",
      source: "sdk",
    });
    expect("tool_call_id" in report!).toBe(false);
  });

  it("records an unknown category as-is, a missing detail as empty, and cuts detail at 2000", async () => {
    await session({ sessionId: "s1" }, () => {
      failproofai.selfReport("not_a_category");
      failproofai.event.selfReport("looping", "x".repeat(2500));
      failproofai.selfReport("looping", `${"y".repeat(1999)}😀`);
    });
    const [unknown, long, surrogate] = await reports();
    expect(unknown).toMatchObject({ category: "not_a_category", detail: "" });
    expect((long!.detail as string).length).toBe(2000);
    // 2000 code points, as the daemon and the Python SDK count: the emoji is the 2000th.
    expect(surrogate!.detail).toBe(`${"y".repeat(1999)}😀`);
  });

  it("cuts detail as the shared truncation cases say, and replaces a lone surrogate", async () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "test-fixtures", "self-report", "truncation.golden.json"), "utf8")) as {
      max: number;
      cases: { pad_char: string; pad: number; tail: string; expected_tail: string }[];
    };
    await session({ sessionId: "trunc" }, () => {
      for (const c of fixture.cases) failproofai.selfReport("looping", c.pad_char.repeat(c.pad) + c.tail);
      failproofai.selfReport("lo\ud83dping", "x\ud83d");
    });
    const recorded = await reports();
    fixture.cases.forEach((c, i) => {
      expect(recorded[i]!.detail, JSON.stringify(c.tail)).toBe(c.pad_char.repeat(c.pad) + c.expected_tail);
      expect(clipDetail(c.pad_char.repeat(c.pad) + c.tail)).toBe(c.pad_char.repeat(c.pad) + c.expected_tail);
    });
    expect(recorded.at(-1)).toMatchObject({ category: "lo\ufffdping", detail: "x\ufffd" });
  });

  it("takes an explicit session, agent, tool call id and custom fields", async () => {
    failproofai.selfReport("task_failure", "d", { sessionId: "s9", agentId: "worker", toolCallId: "c1", fw_note: "n" });
    expect((await reports())[0]).toMatchObject({
      session_id: "s9",
      agent_id: "worker",
      tool_call_id: "c1",
      fw_note: "n",
    });
  });

  it("refuses reserved names and the fields it sets itself", () => {
    expect(() => failproofai.selfReport("looping", "d", { sessionId: "s", timestamp: "t" })).toThrow(/Reserved/);
    expect(() => failproofai.selfReport("looping", "d", { sessionId: "s", category: "x" })).toThrow(/itself/);
    expect(() => failproofai.selfReport("looping", "d", { sessionId: "s", source: "mcp" })).toThrow(/itself/);
  });

  it("joins the open tool call it was made from, by id, even outside any scope", async () => {
    const ns = new EventNamespace(runtime.writer);
    await session({ sessionId: "framework-run" }, () =>
      agent("weather-agent", () => {
        ns.toolUse({ toolName: "failproofai_report", toolCallId: "call-7" });
      }),
    );
    ns.selfReport("looping", "d", { toolCallId: "call-7" });
    const [report] = await reports();
    expect(report).toMatchObject({ session_id: "framework-run", agent_id: "weather-agent", tool_call_id: "call-7" });
  });

  it("joins an open report-tool call by name when there is no id", async () => {
    const ns = new EventNamespace(runtime.writer);
    await session({ sessionId: "s2" }, () =>
      agent("reporter", () => ns.toolUse({ toolName: "failproofai_report", toolCallId: "own-id" })),
    );
    ns.selfReport("looping", "d");
    expect((await reports())[0]).toMatchObject({ session_id: "s2", agent_id: "reporter", tool_call_id: "own-id" });
  });

  it("keeps the caller's call id over the matched tool call's", async () => {
    const ns = new EventNamespace(runtime.writer);
    await session({ sessionId: "s3" }, () =>
      agent("reporter", () => ns.toolUse({ toolName: "failproofai_report", toolCallId: "adapter-id" })),
    );
    ns.selfReport("looping", "d", { toolCallId: "model-id" });
    expect((await reports())[0]).toMatchObject({ session_id: "s3", tool_call_id: "model-id" });
  });

  it("records no call id when no open tool call matches", async () => {
    await session({ sessionId: "s4" }, () => failproofai.selfReport("looping", "d"));
    expect((await reports())[0]!.tool_call_id).toBeUndefined();
  });

  it("inside a scope, only looks at that scope's open tool calls", async () => {
    await session({ sessionId: "other" }, () =>
      agent("elsewhere", () => failproofai.event.toolUse({ toolName: "failproofai_report", toolCallId: "c" })),
    );
    await session({ sessionId: "mine" }, () =>
      toolCall("failproofai_report", { toolCallId: "c2" }, () => failproofai.selfReport("looping", "d")),
    );
    const [report] = await reports();
    expect(report).toMatchObject({ session_id: "mine" });
  });

  it("with no scope, never picks among open report calls of different sessions by recency", async () => {
    const ns = new EventNamespace(runtime.writer);
    quietLogger();
    // Two concurrent runs (LlamaIndex gives its tool no id and binds no scope),
    // each with a report-tool call open.
    await session({ sessionId: "run-a" }, () =>
      agent("a", () => ns.toolUse({ toolName: "failproofai_report", toolCallId: "a-1" })),
    );
    await session({ sessionId: "run-b" }, () =>
      agent("b", () => ns.toolUse({ toolName: "failproofai_report", toolCallId: "b-1" })),
    );
    ns.selfReport("looping", "no id");
    // An id open in both sessions is ambiguous too; one open in only one is not.
    await session({ sessionId: "run-a" }, () => ns.toolUse({ toolName: "x", toolCallId: "dup" }));
    await session({ sessionId: "run-b" }, () => ns.toolUse({ toolName: "x", toolCallId: "dup" }));
    ns.selfReport("looping", "dup id", { toolCallId: "dup" });
    ns.selfReport("looping", "unique id", { toolCallId: "a-1" });
    const recorded = await reports();
    expect(recorded.map((e) => [e.detail, e.session_id])).toEqual([
      ["no id", UNATTRIBUTED_SESSION],
      ["dup id", UNATTRIBUTED_SESSION],
      ["unique id", "run-a"],
    ]);
  });

  it("an id open in several sessions never falls back to the tool name; an id open nowhere does", async () => {
    const ns = new EventNamespace(runtime.writer);
    quietLogger();
    await session({ sessionId: "s-1" }, () => ns.toolUse({ toolName: "search", toolCallId: "dup" }));
    await session({ sessionId: "s-2" }, () => ns.toolUse({ toolName: "search", toolCallId: "dup" }));
    await session({ sessionId: "s-3" }, () =>
      agent("reporter", () => ns.toolUse({ toolName: "failproofai_report", toolCallId: "r-3" })),
    );
    ns.selfReport("looping", "ambiguous id", { toolCallId: "dup" });
    ns.selfReport("looping", "unknown id", { toolCallId: "model-id" });
    const recorded = await reports();
    expect(recorded.map((e) => [e.detail, e.session_id, e.tool_call_id])).toEqual([
      ["ambiguous id", UNATTRIBUTED_SESSION, "dup"],
      ["unknown id", "s-3", "model-id"],
    ]);
  });

  it("with an explicit session, infers the call id only from the one open report call of that agent", async () => {
    const ns = new EventNamespace(runtime.writer);
    await session({ sessionId: "s" }, async () => {
      await agent("planner", () => ns.toolUse({ toolName: "failproofai_report", toolCallId: "p-1" }));
      await agent("worker", () => ns.toolUse({ toolName: "failproofai_report", toolCallId: "w-1" }));
    });
    ns.selfReport("looping", "planner", { sessionId: "s", agentId: "planner" });
    ns.selfReport("looping", "worker", { sessionId: "s", agentId: "worker" });
    ns.selfReport("looping", "nobody", { sessionId: "s", agentId: "other" });
    await session({ sessionId: "s" }, () =>
      agent("worker", () => ns.toolUse({ toolName: "failproofai_report", toolCallId: "w-2" })),
    );
    ns.selfReport("looping", "worker twice", { sessionId: "s", agentId: "worker" });
    await agent("planner", () => ns.selfReport("looping", "ambient agent", { sessionId: "s" }));
    const recorded = await reports();
    expect(recorded.map((e) => [e.detail, e.agent_id, e.tool_call_id])).toEqual([
      ["planner", "planner", "p-1"],
      ["worker", "worker", "w-1"],
      ["nobody", "other", undefined],
      ["worker twice", "worker", undefined],
      ["ambient agent", "planner", "p-1"],
    ]);
  });

  it("files a report with no session under unattributed and warns once, never throwing", async () => {
    const warn = quietLogger();
    const namespace = new EventNamespace(runtime.writer);
    namespace.selfReport("looping", "a");
    namespace.selfReport("looping", "b");
    const recorded = await reports();
    expect(recorded.map((e) => [e.session_id, e.agent_id])).toEqual([
      [UNATTRIBUTED_SESSION, "main"],
      [UNATTRIBUTED_SESSION, "main"],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("unattributed");
  });
});

describe("the settings file", () => {
  it("is disabled, with the default categories, when the file is missing", () => {
    expect(failproofai.selfReportSettingsPath()).toBe(join(home, "self-report.json"));
    expect(failproofai.selfReportSettings()).toEqual({
      enabled: false,
      source: null,
      categories: DEFAULT_SELF_REPORT_CATEGORIES.map((c) => ({ ...c })),
      guidance: null,
      mcp: null,
      updatedAt: null,
    });
  });

  it("is disabled when the file does not parse", () => {
    writeSettings("{not json");
    expect(failproofai.selfReportSettings().enabled).toBe(false);
  });

  it("reads an enabled file: categories, guidance, mcp, source", () => {
    writeSettings({
      version: 1,
      enabled: true,
      source: "cloud",
      categories: [{ name: "tracker_down", description: "The ticket tracker is unreachable." }],
      guidance: "Prefer tracker_down for anything about tickets.",
      mcp: { port: 4319, url: "http://127.0.0.1:4319/mcp" },
      updatedAt: "2026-11-25T10:00:00Z",
    });
    expect(failproofai.selfReportSettings()).toEqual({
      enabled: true,
      source: "cloud",
      categories: [{ name: "tracker_down", description: "The ticket tracker is unreachable." }],
      guidance: "Prefer tracker_down for anything about tickets.",
      mcp: { port: 4319, url: "http://127.0.0.1:4319/mcp" },
      updatedAt: "2026-11-25T10:00:00Z",
    });
    const spec = failproofai.selfReportSpec();
    expect(spec.description.endsWith(
      "Categories:\n- tracker_down: The ticket tracker is unreachable.\n\nPrefer tracker_down for anything about tickets.",
    )).toBe(true);
    expect((spec.inputSchema.properties as { category: { enum: string[] } }).category.enum).toEqual(["tracker_down"]);
  });

  it("uses the defaults when disabled, whatever categories the file lists", () => {
    writeSettings({ enabled: false, categories: [{ name: "x", description: "y" }], guidance: "g" });
    const settings = failproofai.selfReportSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.categories.map((c) => c.name)).toEqual(DEFAULT_SELF_REPORT_CATEGORIES.map((c) => c.name));
    expect(settings.guidance).toBeNull();
  });

  it.each([
    ["empty", []],
    ["a bad name", [{ name: "Bad-Name", description: "d" }]],
    ["a duplicate", [{ name: "a", description: "d" }, { name: "a", description: "e" }]],
    ["an empty description", [{ name: "a", description: "" }]],
    ["too many", Array.from({ length: 33 }, (_, i) => ({ name: `c${i}`, description: "d" }))],
  ])("falls back to the default categories for %s list", (_label, categories) => {
    writeSettings({ enabled: true, categories });
    expect(failproofai.selfReportSettings().categories.map((c) => c.name)).toEqual(
      DEFAULT_SELF_REPORT_CATEGORIES.map((c) => c.name),
    );
  });

  it("drops guidance over 2000 characters", () => {
    writeSettings({ enabled: true, guidance: "g".repeat(2001) });
    expect(failproofai.selfReportSettings().guidance).toBeNull();
  });
});

describe("the raw tool helpers", () => {
  it("builds the contract's spec from the defaults", () => {
    expect(failproofai.selfReportSpec()).toEqual({
      name: "failproofai_report",
      description: DEFAULT_DESCRIPTION,
      inputSchema: DEFAULT_SCHEMA,
    });
  });

  it("shapes OpenAI and Anthropic tool entries", () => {
    expect(failproofai.openaiTool()).toEqual({
      type: "function",
      function: { name: "failproofai_report", description: DEFAULT_DESCRIPTION, parameters: DEFAULT_SCHEMA },
    });
    expect(failproofai.anthropicTool()).toEqual({
      name: "failproofai_report",
      description: DEFAULT_DESCRIPTION,
      input_schema: DEFAULT_SCHEMA,
    });
  });

  it("shapes the OpenAI Responses API entry flat, like Python's openai_responses_tool()", () => {
    expect(failproofai.openaiResponsesTool()).toEqual({
      type: "function",
      name: "failproofai_report",
      description: DEFAULT_DESCRIPTION,
      parameters: DEFAULT_SCHEMA,
      strict: true,
    });
    expect(edge.openaiResponsesTool()).toEqual(failproofai.openaiResponsesTool());
    // Strict mode holds for the schema: every property required, nothing else allowed.
    const { parameters } = failproofai.openaiResponsesTool();
    expect([...(parameters.required as string[])].sort()).toEqual(Object.keys(parameters.properties as object).sort());
    expect(parameters.additionalProperties).toBe(false);
    // Assignable to openai's own `FunctionTool` (openai/resources/responses), whose
    // `strict` is required: checked by `npm run typecheck`, which covers test/.
    const asOpenAI: OpenAIFunctionTool = failproofai.openaiResponsesTool();
    expect(asOpenAI.strict).toBe(true);
  });

  it.each([
    ["failproofai_report", true],
    ["mcp__failproofai__report", true],
    ["failproofai__report", true],
    ["failproofai.report", true],
    ["failproofai/report", true],
    ["report", false],
    ["failproofai_report_x", false],
    ["mcp__other__report", false],
  ])("isSelfReportTool(%j) is %s", (name, expected) => {
    expect(failproofai.isSelfReportTool(name)).toBe(expected);
  });

  it("handles a report call: records it and answers Recorded.", async () => {
    const answer = await session({ sessionId: "s1" }, () =>
      failproofai.handleToolCall("failproofai_report", '{"category":"missing_context","detail":"No repo access."}', {
        toolCallId: "call_1",
      }),
    );
    expect(answer).toBe("Recorded.");
    expect((await reports())[0]).toMatchObject({
      session_id: "s1",
      category: "missing_context",
      detail: "No repo access.",
      tool_call_id: "call_1",
    });
  });

  it("keeps the detail a model sent under an alias (summary), ignoring unknown keys", async () => {
    await session({ sessionId: "s1" }, () =>
      failproofai.handleToolCall("failproofai_report", { type: "looping", summary: "Same fix three times.", extra: 1 }),
    );
    expect((await reports())[0]).toMatchObject({ category: "looping", detail: "Same fix three times." });
  });

  it("returns null for any other tool, recording nothing", async () => {
    expect(failproofai.handleToolCall("get_weather", { city: "Paris" })).toBeNull();
    expect(await reports()).toEqual([]);
  });

  it("never throws: unreadable arguments are recorded empty, a bad field is logged", async () => {
    const warn = quietLogger();
    await session({ sessionId: "s1" }, () => {
      expect(failproofai.handleToolCall("mcp__failproofai__report", "{oops")).toBe("Recorded.");
      expect(failproofai.handleToolCall("failproofai_report", { category: "looping" }, { timestamp: "x" })).toBe(
        "Recorded.",
      );
    });
    const recorded = await reports();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ category: "", detail: "" });
    expect(String(warn.mock.calls[0]![0])).toContain("not recorded");
  });
});

describe("the framework tools", () => {
  describe("/ai", () => {
    it("is built with ai's own tool() and jsonSchema() when handed them", async () => {
      const tool = vi.fn((definition: unknown) => ({ wrapped: definition }));
      const jsonSchema = vi.fn((value: unknown) => ({ schemaOf: value }));
      const built = aiTool<{ wrapped: { description: string; inputSchema: unknown; execute: (i: unknown, o: unknown) => Promise<string> } }>({
        module: { tool, jsonSchema },
      });
      expect(jsonSchema).toHaveBeenCalledWith(DEFAULT_SCHEMA);
      expect(built.wrapped.description).toBe(DEFAULT_DESCRIPTION);
      expect(built.wrapped.inputSchema).toEqual({ schemaOf: DEFAULT_SCHEMA });
      const answer = await session({ sessionId: "s1" }, () =>
        built.wrapped.execute({ category: "looping", detail: "d" }, { toolCallId: "call-1" }),
      );
      expect(answer).toBe("Recorded.");
      expect((await reports())[0]).toMatchObject({ session_id: "s1", tool_call_id: "call-1", category: "looping" });
    });

    it("makes the jsonSchema() object itself when ai cannot be required", () => {
      // `ai` is not installed in this package, so neither the version nor the
      // module resolves: the schema goes under both keys, by hand.
      const built = aiTool();
      const schemaObject = built.inputSchema as Record<PropertyKey, unknown>;
      expect(built.parameters).toBe(built.inputSchema);
      expect(schemaObject[Symbol.for("vercel.ai.schema")]).toBe(true);
      expect(schemaObject[Symbol.for("vercel.ai.validator")]).toBe(true);
      expect(schemaObject.jsonSchema).toEqual(DEFAULT_SCHEMA);
      expect("validate" in schemaObject).toBe(true);
    });
  });

  describe("/langchain", () => {
    it("builds a structured tool with the JSON schema and records with the model's call id", async () => {
      const tool = vi.fn((func: unknown, fields: unknown) => ({ func, fields }));
      const built = langchainTool<{
        func: (input: unknown, runManager?: unknown, config?: unknown) => Promise<string>;
        fields: unknown;
      }>({ module: { tool }, sessionId: "fixed", agentId: "lc" });
      expect(built.fields).toEqual({ name: "failproofai_report", description: DEFAULT_DESCRIPTION, schema: DEFAULT_SCHEMA });
      // `tool()` calls `func(input, config)`: the call is on the 2nd argument.
      expect(await built.func({ category: "looping", detail: "d" }, { toolCall: { id: "call_9" } })).toBe("Recorded.");
      expect((await reports())[0]).toMatchObject({ session_id: "fixed", agent_id: "lc", tool_call_id: "call_9" });
    });

    it("reads the call id from the 3rd argument for DynamicStructuredTool, never a run id", async () => {
      class DynamicStructuredTool {
        constructor(readonly fields: { func: (...args: unknown[]) => Promise<string> }) {}
      }
      const built = langchainTool<DynamicStructuredTool>({ module: { DynamicStructuredTool }, sessionId: "fixed" });
      await built.fields.func({ category: "looping", detail: "d" }, { runId: "run-1" }, { toolCall: { id: "call_3" } });
      await built.fields.func({ category: "looping", detail: "d" }, { runId: "run-2" });
      const recorded = await reports();
      expect(recorded[0]).toMatchObject({ tool_call_id: "call_3" });
      expect(recorded[1]!.tool_call_id).toBeUndefined();
    });

    it("reads the call id from configurable.tool_call_id in either argument, toolCall.id first", async () => {
      class DynamicStructuredTool {
        constructor(readonly fields: { func: (...args: unknown[]) => Promise<string> }) {}
      }
      const tool = vi.fn((func: unknown) => ({ func }));
      const viaTool = langchainTool<{ func: (...args: unknown[]) => Promise<string> }>({ module: { tool }, sessionId: "fixed" });
      const viaDst = langchainTool<DynamicStructuredTool>({ module: { DynamicStructuredTool }, sessionId: "fixed" });
      const input = { category: "looping", detail: "d" };
      await viaTool.func(input, { configurable: { tool_call_id: "cfg-2nd" } });
      await viaDst.fields.func(input, { runId: "run-1" }, { configurable: { tool_call_id: "cfg-3rd" } });
      await viaTool.func(input, { toolCall: { id: "tc" }, configurable: { tool_call_id: "cfg" } });
      await viaDst.fields.func(input, { runId: "run-2", configurable: {} });
      expect((await reports()).map((e) => e.tool_call_id)).toEqual(["cfg-2nd", "cfg-3rd", "tc", undefined]);
    });

    it("falls back to DynamicStructuredTool", () => {
      class DynamicStructuredTool {
        constructor(readonly fields: Record<string, unknown>) {}
      }
      const built = langchainTool<DynamicStructuredTool>({ module: { DynamicStructuredTool } });
      expect(built.fields.name).toBe("failproofai_report");
      expect(typeof built.fields.func).toBe("function");
    });

    it("says how to install @langchain/core when it is missing", () => {
      expect(() => langchainTool()).toThrow(/npm install @langchain\/core/);
    });
  });

  describe("/mastra", () => {
    const fakeZod = {
      object: (shape: Record<string, unknown>) => ({ kind: "object", shape }),
      string: () => ({ describe: (text: string) => ({ kind: "string", text }) }),
      enum: (values: string[]) => ({ kind: "enum", values }),
    };

    it("uses createTool with a zod schema, in both execute signatures", async () => {
      const createTool = vi.fn((definition: Record<string, unknown>) => definition);
      const built = mastraTool<{
        id: string;
        inputSchema: { shape: { category: { values: string[] } } };
        execute: (...args: unknown[]) => Promise<string>;
      }>({ module: { createTool }, zod: { z: fakeZod } });
      expect(built.id).toBe("failproofai_report");
      expect(built.inputSchema.shape.category.values).toEqual(DEFAULT_SCHEMA.properties.category.enum);
      await session({ sessionId: "s1" }, async () => {
        // 1.x
        expect(await built.execute({ category: "looping", detail: "one" }, { agent: { toolCallId: "c1" } })).toBe("Recorded.");
        // 0.x
        expect(await built.execute({ context: { category: "looping", detail: "zero" }, runtimeContext: {} }, { toolCallId: "c0" })).toBe(
          "Recorded.",
        );
      });
      const recorded = await reports();
      expect(recorded.map((e) => [e.detail, e.tool_call_id])).toEqual([
        ["one", "c1"],
        ["zero", "c0"],
      ]);
    });

    it("says how to install what is missing", () => {
      expect(() => mastraTool()).toThrow(/npm install @mastra\/core/);
      expect(() => mastraTool({ module: { createTool: (d: unknown) => d }, zod: {} })).toThrow(/npm install zod/);
    });
  });

  describe("/llamaindex", () => {
    it("is a plain BaseTool by default, loading nothing", async () => {
      const built = llamaindexTool();
      expect(built.metadata).toEqual({ name: "failproofai_report", description: DEFAULT_DESCRIPTION, parameters: DEFAULT_SCHEMA });
      await session({ sessionId: "s1" }, () =>
        agent("li", async () => {
          failproofai.event.toolUse({ toolName: "failproofai_report", toolCallId: "li-1" });
          expect(await built.call({ category: "looping", detail: "d" })).toBe("Recorded.");
        }),
      );
      // LlamaIndex hands the tool no call id: it takes the open call's.
      expect((await reports())[0]).toMatchObject({ session_id: "s1", agent_id: "li", tool_call_id: "li-1" });
    });

    it("uses FunctionTool.from when handed one", () => {
      const from = vi.fn((fn: unknown, metadata: unknown) => ({ fn, metadata }));
      const built = llamaindexTool<{ metadata: { name: string } }>({ module: { FunctionTool: { from } } });
      expect(built.metadata.name).toBe("failproofai_report");
    });
  });
});

describe("the edge build", () => {
  it("offers the same spec and answers Recorded. without writing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(edge.selfReportSpec()).toEqual(failproofai.selfReportSpec());
    expect(edge.openaiTool()).toEqual(failproofai.openaiTool());
    expect(edge.anthropicTool()).toEqual(failproofai.anthropicTool());
    expect(edge.handleToolCall("failproofai_report")).toBe("Recorded.");
    expect(edge.handleToolCall("other")).toBeNull();
    expect(edge.selfReportSettings().enabled).toBe(false);
    edge.selfReport();
    edge.event.selfReport("looping", "d");

    const ai = edgeAi.selfReportTool<{ execute: () => Promise<string>; inputSchema: Record<PropertyKey, unknown> }>();
    expect(await ai.execute()).toBe("Recorded.");
    expect(ai.inputSchema[Symbol.for("vercel.ai.schema")]).toBe(true);
    for (const make of [edgeLangchain.selfReportTool, edgeMastra.selfReportTool, edgeLlamaindex.selfReportTool]) {
      const tool = make<{ name: string; invoke: () => Promise<string>; execute: () => Promise<string>; call: () => Promise<string> }>();
      expect(tool.name).toBe("failproofai_report");
      expect(await tool.invoke()).toBe("Recorded.");
      expect(await tool.execute()).toBe("Recorded.");
      expect(await tool.call()).toBe("Recorded.");
    }
    expect(await reports()).toEqual([]);
  });

  it("builds a real LangChain tool with the module it is handed, still recording nothing", async () => {
    const tool = vi.fn((func: (input: unknown) => Promise<string>, fields: Record<string, unknown>) => ({ func, fields }));
    const built = edgeLangchain.selfReportTool<{ func: (i: unknown) => Promise<string>; fields: Record<string, unknown> }>({
      module: { tool: tool },
    });
    expect(tool).toHaveBeenCalledTimes(1);
    expect(built.fields).toEqual({ name: "failproofai_report", description: DEFAULT_DESCRIPTION, schema: DEFAULT_SCHEMA });
    expect(await built.func({ category: "looping", detail: "d" })).toBe("Recorded.");
    class DynamicStructuredTool {
      constructor(readonly fields: Record<string, unknown>) {}
    }
    const viaClass = edgeLangchain.selfReportTool<DynamicStructuredTool>({ module: { DynamicStructuredTool: DynamicStructuredTool } });
    expect(viaClass).toBeInstanceOf(DynamicStructuredTool);
    expect(viaClass.fields).toMatchObject({ name: "failproofai_report", schema: DEFAULT_SCHEMA });
    expect(await (viaClass.fields.func as () => Promise<string>)()).toBe("Recorded.");
    expect(await reports()).toEqual([]);
  });
});
