// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(
  resolve(process.cwd(), ".github/workflows/issue-filters.yml"), "utf8",
));
const scripts = (job: { steps: { run?: string }[] }) =>
  job.steps.map((step) => step.run ?? "").join("\n");

describe("issue-filter stacked verification", () => {
  it("tests the actual PR base without publishing or release credentials", () => {
    expect(workflow.on.pull_request.branches).toContain("feat/fp-cli-parity");
    expect(workflow.on.workflow_dispatch).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.pull_request.paths).toContain("crates/fpai-collect/**");
    expect(workflow.on.pull_request.paths).toContain("fp-cloud-cli/**");
  });

  it("runs collector formatting, clippy and all cargo tests", () => {
    const run = scripts(workflow.jobs.collector);
    expect(run).toContain("cargo fmt --all -- --check");
    expect(run).toContain("cargo clippy -p fpai-collect --all-targets -- -D warnings");
    expect(run).toContain("cargo test -p fpai-collect");
  });

  it("tests both auth modes across supported Python versions and a clean wheel", () => {
    const job = workflow.jobs["cloud-cli"];
    expect(job.strategy.matrix["python-version"]).toEqual(["3.10", "3.11", "3.12", "3.13"]);
    const run = scripts(job);
    expect(run).toContain("uv sync --locked --extra dev");
    expect(run).toContain("pytest -q");
    expect(run).toContain("uv build");
    expect(run).toContain("uv pip install --python /tmp/fp-issue-smoke/bin/python dist/*.whl");
    expect(run).toContain("tests/issue_filters_smoke.py");
  });
});
