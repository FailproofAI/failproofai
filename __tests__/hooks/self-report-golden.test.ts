// @vitest-environment node
/**
 * Self Reports: the CLI side of the shared golden files in
 * test-fixtures/self-report/. The Rust daemon (crates/fpai-collect) and the
 * TypeScript SDK (sdk/typescript) are tested against the same files, so the
 * tool description, input schema, default categories, recognised tool names,
 * server-recorded integrations and the `self_report` event's fields cannot
 * drift apart between them. Change a golden file only together with every
 * implementation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SELF_REPORT_ARG_ALIASES,
  SELF_REPORT_DEFAULT_CATEGORIES,
  SELF_REPORT_SERVER_RECORDS,
  selfReportArgs,
  describeSelfReportTool,
  isSelfReportCursorCall,
  isSelfReportToolName,
  selfReportInputSchema,
  selfReportInstructions,
} from "../../src/hooks/self-report";
import { writeSelfReportEvent } from "../../src/hooks/self-report-mcp";

const ROOT = resolve(__dirname, "..", "..");
const GOLDEN = join(ROOT, "test-fixtures", "self-report");
const golden = (name: string) => readFileSync(join(GOLDEN, name), "utf8");
const lines = (name: string) => golden(name).split("\n").filter((l) => l !== "");

describe("Self Reports golden files (CLI)", () => {
  it("builds the description byte for byte", () => {
    expect(describeSelfReportTool(SELF_REPORT_DEFAULT_CATEGORIES, null)).toBe(golden("description.golden.txt"));
    expect(
      describeSelfReportTool(SELF_REPORT_DEFAULT_CATEGORIES, "Report a missing repository as missing_context."),
    ).toBe(golden("description-guidance.golden.txt"));
  });

  it("builds the MCP server instructions byte for byte", () => {
    expect(selfReportInstructions(SELF_REPORT_DEFAULT_CATEGORIES, null)).toBe(golden("instructions.golden.txt"));
    expect(
      selfReportInstructions(SELF_REPORT_DEFAULT_CATEGORIES, "Report a missing repository as missing_context."),
    ).toBe(golden("instructions-guidance.golden.txt"));
    expect(golden("instructions.golden.txt").length).toBeLessThan(600);
  });

  it("reads argument aliases from the shared list, for raw and hook-wrapped arguments", () => {
    const fixture = JSON.parse(golden("arg-aliases.json")) as {
      aliases: { category: string[]; detail: string[] };
      cases: { args: Record<string, unknown>; category: string; detail: string }[];
    };
    expect(SELF_REPORT_ARG_ALIASES).toEqual(fixture.aliases);
    for (const c of fixture.cases) {
      const want = { category: c.category, detail: c.detail };
      expect(selfReportArgs(c.args), JSON.stringify(c.args)).toEqual(want);
      expect(selfReportArgs(JSON.stringify(c.args)), JSON.stringify(c.args)).toEqual(want);
      expect(selfReportArgs({ arguments: c.args }), JSON.stringify(c.args)).toEqual(want);
      expect(selfReportArgs({ args: JSON.stringify(c.args) }), JSON.stringify(c.args)).toEqual(want);
    }
  });

  it("builds the input schema byte for byte", () => {
    expect(`${JSON.stringify(selfReportInputSchema(SELF_REPORT_DEFAULT_CATEGORIES))}\n`).toBe(golden("input-schema.golden.json"));
  });

  it("ships the six default categories", () => {
    expect(SELF_REPORT_DEFAULT_CATEGORIES).toEqual(JSON.parse(golden("categories.golden.json")));
  });

  it("recognises every per-agent spelling of the tool, and nothing near it", () => {
    for (const name of lines("tool-names.golden.txt")) {
      expect(isSelfReportToolName(name), name).toBe(true);
      expect(isSelfReportToolName(name.toUpperCase()), name).toBe(true);
    }
    for (const name of ["report", "MCP:report", "mcp__other__report", "failproofai_report_x", "xfailproofai__report", "failproofai"]) {
      expect(isSelfReportToolName(name), name).toBe(false);
    }
  });

  it("recognises Cursor's MCP hook only with the failproofai server name", () => {
    expect(isSelfReportCursorCall({ tool_name: "report", mcp_server_name: "failproofai" })).toBe(true);
    expect(isSelfReportCursorCall({ tool_name: "MCP:report", mcp_server_name: "failproofai" })).toBe(true);
    expect(isSelfReportCursorCall({ tool_name: "report", mcp_server_name: "linear" })).toBe(false);
    expect(isSelfReportCursorCall({ tool_name: "report" })).toBe(false);
    expect(isSelfReportCursorCall({ tool_name: "MCP:report" })).toBe(false);
    expect(isSelfReportCursorCall({ tool_name: "search", mcp_server_name: "failproofai" })).toBe(false);
  });

  it("keeps the TypeScript SDK's tool-name list equal to the golden list", () => {
    const src = readFileSync(join(ROOT, "sdk", "typescript", "src", "self-report-spec.ts"), "utf8");
    const block = src.match(/SELF_REPORT_TOOL_SPELLINGS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
    expect(block, "SELF_REPORT_TOOL_SPELLINGS in the SDK").not.toBeNull();
    const names = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(lines("tool-names.golden.txt"));
  });

  it("lists the same server-recorded integrations as the Rust daemon", () => {
    expect([...SELF_REPORT_SERVER_RECORDS]).toEqual(lines("server-records.golden.txt"));
    const rs = readFileSync(join(ROOT, "crates", "fpai-collect", "src", "self_report.rs"), "utf8");
    const block = rs.match(/pub const SERVER_RECORDS: &\[&str\] = &\[([\s\S]*?)\];/);
    expect(block, "SERVER_RECORDS in self_report.rs").not.toBeNull();
    expect([...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...SELF_REPORT_SERVER_RECORDS]);
    for (const hooked of ["claude", "codex"]) expect(SELF_REPORT_SERVER_RECORDS).not.toContain(hooked);
  });

  describe("the stdio server's fallback event", () => {
    let home: string;
    let saved: string | undefined;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "fpai-sr-golden-"));
      saved = process.env.FAILPROOFAI_HOME;
      process.env.FAILPROOFAI_HOME = home;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.FAILPROOFAI_HOME;
      else process.env.FAILPROOFAI_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    });

    it("writes the golden fields in wire order", async () => {
      const spec = JSON.parse(golden("event-fields.golden.json")) as { order: string[]; fallbackExtras: string[] };
      const { path, event } = await writeSelfReportEvent({
        integration: "hermes",
        category: "looping",
        detail: "Same step again.",
        cwd: home,
        now: Date.parse("2026-11-25T10:00:00Z"),
      });
      expect(Object.keys(event)).toEqual([...spec.order, ...spec.fallbackExtras]);
      expect(Object.keys(JSON.parse(readFileSync(path, "utf8").trim()))).toEqual([...spec.order, ...spec.fallbackExtras]);
    });
  });
});
