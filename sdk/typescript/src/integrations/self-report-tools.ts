/**
 * Ready-made Self Reports tools, one per framework, each exported as
 * `selfReportTool()` from that framework's subpath.
 *
 * Every one offers the same tool — `failproofai_report`, the description and
 * schema from `selfReportSpec()` — and does the same thing when called:
 * record a `self_report` event and answer `Recorded.`, never throwing.
 *
 * The frameworks stay OPTIONAL peers. Nothing here imports one at module
 * scope; each builder loads its framework when it is called, from the
 * application's own `node_modules` (`tryRequire`, anchored at the app), or
 * uses the module the caller hands it in `options.module` — the way to pass
 * the exact copy a bundler inlined.
 */

import { tryRequire } from "../node-require.js";
import { recordToolCall, selfReportSpec } from "../self-report.js";
import { SELF_REPORT_TOOL_NAME } from "../self-report-spec.js";
import { versionTuple } from "./compat.js";

/** Identity to record reports under, when the tool runs outside any scope. */
export interface SelfReportToolOptions {
  sessionId?: string;
  agentId?: string;
}

const pickId = (...values: unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === "string" && value !== "");

function identityOf(options: SelfReportToolOptions): { sessionId?: string; agentId?: string } {
  return {
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
  };
}

function missing(framework: string, install: string): Error {
  return new Error(
    `selfReportTool() needs ${framework}, which could not be loaded from this application. ` +
      `Install it (\`${install}\`), or pass the module: selfReportTool({ module: await import("${framework}") }).`,
  );
}

// -- Vercel AI SDK ----------------------------------------------------------

/** The `ai` exports this builder uses. */
export interface AiModule {
  tool?: (definition: never) => unknown;
  jsonSchema?: (schema: never) => unknown;
}

export interface AiSelfReportToolOptions extends SelfReportToolOptions {
  module?: AiModule;
}

/** The shape `selfReportTool()` returns when nothing narrows it. */
export interface AiSelfReportTool {
  description: string;
  inputSchema?: unknown;
  parameters?: unknown;
  execute: (input: unknown, options?: { toolCallId?: string }) => Promise<string>;
}

/**
 * What `jsonSchema()` returns, built by hand when `ai` cannot be `require`d
 * (v7 is ESM-only). Every major from 4 through 7 recognises a schema by these
 * registered symbols and the `jsonSchema` / `validate` keys, so the result is
 * the same object `jsonSchema()` would have made.
 */
function handMadeJsonSchema(schema: Record<string, unknown>): Record<PropertyKey, unknown> {
  return {
    [Symbol.for("vercel.ai.schema")]: true,
    _type: undefined,
    [Symbol.for("vercel.ai.validator")]: true,
    jsonSchema: schema,
    validate: undefined,
  };
}

/**
 * The report tool for the Vercel AI SDK, majors 4–7:
 *
 *     tools: { failproofai_report: selfReportTool(), ...yourTools }
 *
 * Built with `ai`'s own `tool()` and `jsonSchema()` (no zod). The schema goes
 * under `parameters` on v4 and `inputSchema` from v5, and under both when the
 * version is unknown (including a `module` passed in). The report lands on the
 * agent whose loop called it: the model's `toolCallId` finds the `tool_use`
 * the adapter recorded, else the enclosing `failproofai` scope.
 */
export function aiSelfReportTool<T = AiSelfReportTool>(options: AiSelfReportToolOptions = {}): T {
  const spec = selfReportSpec();
  const resolved = versionTuple("ai")?.[0];
  // v4–v6 ship CommonJS; v7 does not, and a `require` of it would print
  // Node's require(esm) warning in the customer's process for nothing.
  const ai = options.module ?? (resolved !== undefined && resolved <= 6 ? tryRequire<AiModule>("ai") : null);
  // The resolved `ai` says nothing about a module the caller passed in (an
  // application can resolve v6 and hand over a v4 copy), so its version is
  // unknown and the definition carries both schema keys.
  const major = options.module ? undefined : resolved;
  const schema =
    typeof ai?.jsonSchema === "function"
      ? ai.jsonSchema(spec.inputSchema as never)
      : handMadeJsonSchema(spec.inputSchema);
  const identity = identityOf(options);
  const definition: AiSelfReportTool = {
    description: spec.description,
    ...(major === undefined || major >= 5 ? { inputSchema: schema } : {}),
    ...(major === undefined || major < 5 ? { parameters: schema } : {}),
    execute: (input: unknown, callOptions?: { toolCallId?: string }) =>
      Promise.resolve(recordToolCall(input, { ...identity, toolCallId: pickId(callOptions?.toolCallId) })),
  };
  return (typeof ai?.tool === "function" ? ai.tool(definition as never) : definition) as T;
}

// -- LangChain ----------------------------------------------------------------

/** The `@langchain/core/tools` exports this builder uses. */
export interface LangChainToolsModule {
  tool?: (func: never, fields: never) => unknown;
  DynamicStructuredTool?: new (fields: never) => unknown;
}

export interface LangChainSelfReportToolOptions extends SelfReportToolOptions {
  module?: LangChainToolsModule;
}

/**
 * The report tool for LangChain / LangGraph (`@langchain/core` ≥0.3), a
 * structured tool with a JSON Schema — bind it with the rest:
 *
 *     const model = chat.bindTools([selfReportTool(), ...tools]);
 *     createReactAgent({ llm, tools: [selfReportTool(), ...tools] });
 */
export function langchainSelfReportTool<T = unknown>(options: LangChainSelfReportToolOptions = {}): T {
  const tools = options.module ?? tryRequire<LangChainToolsModule>("@langchain/core/tools");
  const spec = selfReportSpec();
  const identity = identityOf(options);
  // `tool()` calls `func(input, config)`, with the model's call at
  // `config.toolCall`; a `DynamicStructuredTool` calls `func(input, runManager,
  // config)`. Read the id from whichever argument carries it. A run id is not
  // the model's call id, so it is never used.
  type WithToolCall = { toolCall?: { id?: unknown } } | undefined;
  const func = (input: unknown, second?: WithToolCall, third?: WithToolCall) =>
    Promise.resolve(
      recordToolCall(input, { ...identity, toolCallId: pickId(second?.toolCall?.id, third?.toolCall?.id) }),
    );
  const fields = { name: SELF_REPORT_TOOL_NAME, description: spec.description, schema: spec.inputSchema };
  if (typeof tools?.tool === "function") return tools.tool(func as never, fields as never) as T;
  if (typeof tools?.DynamicStructuredTool === "function") {
    return new tools.DynamicStructuredTool({ ...fields, func } as never) as T;
  }
  throw missing("@langchain/core/tools", "npm install @langchain/core");
}

// -- Mastra -------------------------------------------------------------------

/** The `@mastra/core/tools` export this builder uses. */
export interface MastraToolsModule {
  createTool?: (definition: never) => unknown;
}

/** The `zod` export this builder uses. */
export interface ZodModule {
  z?: ZodLike;
  object?: ZodLike["object"];
}
interface ZodLike {
  object(shape: Record<string, unknown>): unknown;
  string(): { describe(text: string): unknown };
  enum(values: [string, ...string[]]): unknown;
}

export interface MastraSelfReportToolOptions extends SelfReportToolOptions {
  module?: MastraToolsModule;
  /** The application's `zod`, which Mastra tools need for their schema. */
  zod?: ZodModule;
}

/**
 * The input and call id of a Mastra `execute`, in either major's signature:
 * 1.x `execute(input, { agent: { toolCallId } })`, 0.x
 * `execute({ context: input, runtimeContext, … }, { toolCallId })`.
 */
function mastraCall(args: unknown[]): { input: unknown; toolCallId?: string } {
  const [first, second] = args as [unknown, Record<string, unknown> | undefined];
  if (typeof first === "object" && first !== null && "context" in first) {
    const envelope = first as { context?: unknown; toolCallId?: unknown };
    return { input: envelope.context, toolCallId: pickId(second?.toolCallId, envelope.toolCallId) };
  }
  const agentContext = second?.agent as { toolCallId?: unknown } | undefined;
  return { input: first, toolCallId: pickId(agentContext?.toolCallId, second?.toolCallId) };
}

/**
 * The report tool for Mastra (`@mastra/core` ≥0.20), made with `createTool`:
 *
 *     new Agent({ ..., tools: { failproofai_report: selfReportTool(), ...tools } });
 *
 * Mastra tools take a zod schema, so this uses the application's own `zod`
 * (every Mastra install has it).
 */
export function mastraSelfReportTool<T = unknown>(options: MastraSelfReportToolOptions = {}): T {
  const tools = options.module ?? tryRequire<MastraToolsModule>("@mastra/core/tools");
  if (typeof tools?.createTool !== "function") throw missing("@mastra/core/tools", "npm install @mastra/core");
  const zodModule = options.zod ?? tryRequire<ZodModule>("zod");
  const z = zodModule?.z ?? (zodModule as ZodLike | null);
  if (typeof z?.object !== "function") throw missing("zod", "npm install zod");
  const spec = selfReportSpec();
  const names = ((spec.inputSchema.properties as { category: { enum: string[] } }).category.enum) as [
    string,
    ...string[],
  ];
  const inputSchema = z.object({
    category: z.enum(names),
    detail: z.string().describe("One factual sentence: what is blocking you."),
  });
  const identity = identityOf(options);
  return tools.createTool({
    id: SELF_REPORT_TOOL_NAME,
    description: spec.description,
    inputSchema,
    execute: (...args: unknown[]) => {
      const { input, toolCallId } = mastraCall(args);
      return Promise.resolve(recordToolCall(input, { ...identity, toolCallId }));
    },
  } as never) as T;
}

// -- LlamaIndex ---------------------------------------------------------------

/** The `FunctionTool` export this builder can use (`llamaindex` or `@llamaindex/core/tools`). */
export interface LlamaIndexToolsModule {
  FunctionTool?: { from(fn: never, metadata: never): unknown };
}

export interface LlamaIndexSelfReportToolOptions extends SelfReportToolOptions {
  /** Build it with this `FunctionTool` instead of as a plain `BaseTool`. */
  module?: LlamaIndexToolsModule;
}

/**
 * The report tool for LlamaIndex.TS (`llamaindex` ≥0.11.4):
 *
 *     agent({ llm, tools: [selfReportTool(), ...tools] });
 *
 * A LlamaIndex tool is any `BaseTool` — `{ metadata, call }` — so by default
 * this is that plain object with a JSON Schema, and loads nothing: `require`
 * of a second copy of `llamaindex` is what makes it print "already imported.
 * This breaks constructor checks". Pass `module` (your `FunctionTool`) to get
 * a `FunctionTool` instead.
 *
 * LlamaIndex hands a tool no call id, so the report finds its agent, and
 * takes its call id, from the open `tool_use` named `failproofai_report`
 * (recorded by `instrument("llamaindex")`), else the enclosing scope.
 */
export function llamaindexSelfReportTool<T = LlamaIndexSelfReportTool>(
  options: LlamaIndexSelfReportToolOptions = {},
): T {
  const spec = selfReportSpec();
  const identity = identityOf(options);
  const call = (input: unknown) => Promise.resolve(recordToolCall(input, identity));
  const metadata = { name: SELF_REPORT_TOOL_NAME, description: spec.description, parameters: spec.inputSchema };
  if (typeof options.module?.FunctionTool?.from === "function") {
    return options.module.FunctionTool.from(call as never, metadata as never) as T;
  }
  const tool: LlamaIndexSelfReportTool = { metadata, call };
  return tool as T;
}

/** A LlamaIndex `BaseTool`, structurally. */
export interface LlamaIndexSelfReportTool {
  metadata: { name: string; description: string; parameters: Record<string, unknown> };
  call: (input: unknown) => Promise<string>;
}
