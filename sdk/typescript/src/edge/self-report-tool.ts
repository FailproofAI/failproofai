/**
 * The Self Reports tool for runtimes with no filesystem — see `./index.ts`.
 *
 * Each framework subpath's `selfReportTool()` returns a tool that offers the
 * same name, description and schema and answers `Recorded.`, recording
 * nothing. No framework is loaded: these are plain objects in the shape each
 * framework reads.
 */

import {
  SELF_REPORT_RESULT,
  SELF_REPORT_TOOL_NAME,
  buildSelfReportSpec,
  defaultCategories,
} from "../self-report-spec.js";
import { notice } from "./notice.js";

export function inertSpec() {
  return buildSelfReportSpec(defaultCategories());
}

export function inertAnswer(): Promise<string> {
  notice();
  return Promise.resolve(SELF_REPORT_RESULT);
}

/** The AI SDK shape: a `jsonSchema()` result under both v4 and v5+ keys. */
export function inertAiTool<T>(): T {
  const spec = inertSpec();
  const schema = {
    [Symbol.for("vercel.ai.schema")]: true,
    _type: undefined,
    [Symbol.for("vercel.ai.validator")]: true,
    jsonSchema: spec.inputSchema,
    validate: undefined,
  };
  return { description: spec.description, inputSchema: schema, parameters: schema, execute: inertAnswer } as T;
}

/** A structured-tool-like object: `name`, `description`, `schema`, and every call entry point. */
export function inertNamedTool<T>(): T {
  const spec = inertSpec();
  return {
    name: SELF_REPORT_TOOL_NAME,
    id: SELF_REPORT_TOOL_NAME,
    description: spec.description,
    schema: spec.inputSchema,
    inputSchema: spec.inputSchema,
    metadata: { name: SELF_REPORT_TOOL_NAME, description: spec.description, parameters: spec.inputSchema },
    invoke: inertAnswer,
    call: inertAnswer,
    func: inertAnswer,
    execute: inertAnswer,
  } as T;
}

/** The `@langchain/core/tools` exports the Edge LangChain tool can build with. */
export interface EdgeLangChainToolsModule {
  tool?: (func: never, fields: never) => unknown;
  DynamicStructuredTool?: new (fields: never) => unknown;
}

/**
 * The LangChain report tool for runtimes with no filesystem. Handed the
 * application's `@langchain/core/tools` (`{ module: await import(...) }`), it is
 * a real structured tool built by that module, which every `@langchain/core`
 * from 0.3.44 converts for the model and runs like any other. Without one it is
 * the plain named-tool object: `@langchain/core` 0.3.52 and later recognise it
 * as a tool (name + JSON Schema); older ones would pass it to the model as it
 * is, so pass the module there. No framework is ever imported here.
 */
export function inertLangChainTool<T>(module?: EdgeLangChainToolsModule): T {
  const spec = inertSpec();
  const fields = { name: SELF_REPORT_TOOL_NAME, description: spec.description, schema: spec.inputSchema };
  const func = () => inertAnswer();
  if (typeof module?.tool === "function") return module.tool(func as never, fields as never) as T;
  if (typeof module?.DynamicStructuredTool === "function") {
    return new module.DynamicStructuredTool({ ...fields, func } as never) as T;
  }
  return inertNamedTool<T>();
}
