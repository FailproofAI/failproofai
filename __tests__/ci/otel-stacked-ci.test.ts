import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

describe("OTEL stacked PR checks", () => {
  it.each(["ci.yml", "osv-scanner.yml"])("%s checks the TUI base without adding feature pushes", file => {
    const workflow = parse(readFileSync(resolve(__dirname, "../../.github/workflows", file), "utf8"));
    expect(workflow.on.pull_request.branches).toContain("feat/tui-ux");
    expect(workflow.on.pull_request.branches).toContain("main");
    expect(workflow.on.push.branches).toEqual(["main"]);
  });
});
