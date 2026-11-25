import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as schema from "../src/schema.js";
import {
  DEFAULT_SELF_REPORT_CATEGORIES,
  SELF_REPORT_TOOL_SPELLINGS,
  describeSelfReport,
  isSelfReportTool,
  selfReportInputSchema,
} from "../src/self-report-spec.js";

/**
 * The SDK side of the shared golden files in the repository's
 * test-fixtures/self-report/. The Rust daemon and the CLI are tested against
 * the same files, so the tool description, input schema, default categories,
 * tool names and `self_report` event fields cannot drift between them.
 */
const GOLDEN = resolve(__dirname, "..", "..", "..", "test-fixtures", "self-report");
const golden = (name: string): string => readFileSync(join(GOLDEN, name), "utf8");
const lines = (name: string): string[] => golden(name).split("\n").filter((l) => l !== "");

describe("Self Reports golden files (TypeScript SDK)", () => {
  it("builds the description byte for byte", () => {
    expect(describeSelfReport(DEFAULT_SELF_REPORT_CATEGORIES, null)).toBe(golden("description.golden.txt"));
    expect(
      describeSelfReport(DEFAULT_SELF_REPORT_CATEGORIES, "Report a missing repository as missing_context."),
    ).toBe(golden("description-guidance.golden.txt"));
  });

  it("builds the input schema byte for byte", () => {
    expect(`${JSON.stringify(selfReportInputSchema(DEFAULT_SELF_REPORT_CATEGORIES))}\n`).toBe(
      golden("input-schema.golden.json"),
    );
  });

  it("ships the six default categories", () => {
    expect(DEFAULT_SELF_REPORT_CATEGORIES).toEqual(JSON.parse(golden("categories.golden.json")));
  });

  it("recognises every per-agent spelling of the tool", () => {
    expect([...SELF_REPORT_TOOL_SPELLINGS]).toEqual(lines("tool-names.golden.txt"));
    for (const name of lines("tool-names.golden.txt")) expect(isSelfReportTool(name), name).toBe(true);
    expect(isSelfReportTool("report")).toBe(false);
    expect(isSelfReportTool("MCP:report")).toBe(false);
    expect(isSelfReportTool("report", "failproofai")).toBe(true);
    expect(isSelfReportTool("MCP:report", "failproofai")).toBe(true);
    expect(isSelfReportTool("report", "linear")).toBe(false);
  });

  it("writes the golden event fields in wire order", () => {
    const spec = JSON.parse(golden("event-fields.golden.json")) as { order: string[]; optional: string[] };
    const base = {
      timestamp: "2026-11-25T10:00:00.000000Z",
      sessionId: "s1",
      agentId: "a1",
      category: "looping",
      detail: "Same step again.",
      source: "sdk",
    };
    expect(Object.keys(schema.selfReportEvent(base))).toEqual(spec.order);
    expect(Object.keys(schema.selfReportEvent({ ...base, toolCallId: "call_1" }))).toEqual([...spec.order, ...spec.optional]);
  });
});
