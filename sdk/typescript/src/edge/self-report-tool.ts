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
