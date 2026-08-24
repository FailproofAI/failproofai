// @vitest-environment node
/**
 * A `run:` step that executes before `actions/checkout` in a job whose DEFAULT
 * working directory is a repo-relative path cannot start at all.
 *
 * The runner creates the workspace root before the job begins, but everything
 * under it arrives with the checkout — so bash is asked to start in a directory
 * that does not exist yet and the step dies with "An error occurred trying to
 * start process '/usr/bin/bash' with working directory ... No such file or
 * directory". The step never runs, so its own logic is irrelevant: both PyPI
 * publish workflows put their actor/branch authorization first, deliberately
 * ahead of the checkout, and both `build` jobs died there on the first real
 * dispatch after the packages were open-sourced. A guard that cannot execute
 * fails the release for the wrong reason, and hides whatever verdict it would
 * have reached behind an infrastructure error.
 *
 * The failure is invisible to review — the step and the `defaults:` block are
 * dozens of lines apart, usually in different hunks — and invisible to the rest
 * of CI, because publish workflows only ever run on `workflow_dispatch`.
 *
 * Scope: only INHERITED directories. A step that names its own
 * `working-directory` is an author stating that the path is there, next to
 * whatever put it there — in this repo, `download-artifact` output directories
 * (`release-assets`, `tree`), created by the step immediately above.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const WORKFLOWS = resolve(process.cwd(), ".github/workflows");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  "working-directory"?: string;
}

interface Defaults {
  run?: { "working-directory"?: string };
}

interface Job {
  defaults?: Defaults;
  steps?: Step[];
}

interface Workflow {
  defaults?: Defaults;
  jobs?: Record<string, Job>;
}

/**
 * Both spellings GitHub accepts. Filtering on `.yml` alone would skip a `.yaml`
 * workflow silently — the same shape of failure this file exists to catch.
 */
function isWorkflowFile(name: string): boolean {
  return name.endsWith(".yml") || name.endsWith(".yaml");
}

/**
 * A directory that is already there when the job starts: the workspace root, or
 * an absolute path outside the repo. Anything else relative is created BY the
 * checkout.
 */
function existsBeforeCheckout(dir: string): boolean {
  return (
    dir === "${{ github.workspace }}" ||
    dir === "." ||
    dir.startsWith("/") ||
    dir.startsWith("${{ runner.temp }}")
  );
}

/**
 * The directory a step inherits when it names none of its own: the job's
 * default, else the workflow-level one, which jobs inherit unless they override
 * it.
 */
function inheritedDirectory(
  job: Job,
  workflowDefault?: string,
): string | undefined {
  return job.defaults?.run?.["working-directory"] ?? workflowDefault;
}

/** Names of the `run:` steps in `job` that would start in a directory that does not exist yet. */
function stepsThatCannotStart(job: Job, workflowDefault?: string): string[] {
  const inherited = inheritedDirectory(job, workflowDefault);
  if (inherited === undefined || existsBeforeCheckout(inherited)) return [];

  const steps = job.steps ?? [];
  const checkout = steps.findIndex((s) =>
    (s.uses ?? "").startsWith("actions/checkout"),
  );
  // No checkout at all means every step in the job runs before one.
  const preCheckout = checkout === -1 ? steps : steps.slice(0, checkout);

  return preCheckout
    .filter((s) => s.run !== undefined && s["working-directory"] === undefined)
    .map((s) => s.name ?? "(unnamed step)");
}

interface DiscoveredJob {
  file: string;
  name: string;
  job: Job;
  workflowDefault?: string;
}

const JOBS: DiscoveredJob[] = readdirSync(WORKFLOWS)
  .filter(isWorkflowFile)
  .flatMap((file) => {
    const workflow = parse(
      readFileSync(resolve(WORKFLOWS, file), "utf8"),
    ) as Workflow;
    const workflowDefault = workflow.defaults?.run?.["working-directory"];
    return Object.entries(workflow.jobs ?? {}).map(([name, job]) => ({
      file,
      name,
      job,
      workflowDefault,
    }));
  });

describe("workflow steps that run before checkout", () => {
  it("reads every workflow, so the check below is not vacuous", () => {
    expect(JOBS.length).toBeGreaterThan(20);
    expect(
      JOBS.some(({ job }) => job.defaults?.run?.["working-directory"]),
    ).toBe(true);
  });

  it("discovers both workflow file extensions", () => {
    expect(isWorkflowFile("ci.yml")).toBe(true);
    expect(isWorkflowFile("ci.yaml")).toBe(true);
    expect(isWorkflowFile("README.md")).toBe(false);
  });

  it("never inherits a directory the checkout has not created yet", () => {
    const broken = JOBS.flatMap(({ file, name, job, workflowDefault }) =>
      stepsThatCannotStart(job, workflowDefault).map(
        (step) =>
          `${file} → ${name} → ${step} inherits "${inheritedDirectory(job, workflowDefault)}" before actions/checkout`,
      ),
    );

    expect(broken).toEqual([]);
  });

  // The detector itself, against the exact job shape that failed. Without this,
  // a typo in the traversal above would report a clean sweep of nothing.
  it("catches the shape that broke both publish workflows", () => {
    const job: Job = {
      defaults: { run: { "working-directory": "fp-cloud-cli" } },
      steps: [
        { name: "Authorize actor and branch", run: "exit 0" },
        { uses: "actions/checkout@v7.0.1" },
        { name: "Test", run: "pytest" },
      ],
    };

    expect(stepsThatCannotStart(job)).toEqual(["Authorize actor and branch"]);

    // ...and clears it once the step names a directory that already exists.
    job.steps![0]["working-directory"] = "${{ github.workspace }}";
    expect(stepsThatCannotStart(job)).toEqual([]);
  });

  // A workflow-level `defaults:` block reaches every job that does not override
  // it, so a step can inherit the directory from a file no reviewer of the job
  // is looking at.
  it("catches a workflow-level default a job does not override", () => {
    const job: Job = {
      steps: [
        { name: "Authorize actor and branch", run: "exit 0" },
        { uses: "actions/checkout@v7.0.1" },
      ],
    };

    expect(stepsThatCannotStart(job, "fp-cloud-cli")).toEqual([
      "Authorize actor and branch",
    ]);
    expect(stepsThatCannotStart(job, "${{ github.workspace }}")).toEqual([]);
  });

  it("lets the job default win over the workflow default, both ways", () => {
    const steps: Step[] = [
      { name: "Authorize actor and branch", run: "exit 0" },
      { uses: "actions/checkout@v7.0.1" },
    ];
    const jobAtRoot: Job = {
      defaults: { run: { "working-directory": "${{ github.workspace }}" } },
      steps,
    };
    const jobInPackage: Job = {
      defaults: { run: { "working-directory": "sdk/python" } },
      steps,
    };

    expect(stepsThatCannotStart(jobAtRoot, "sdk/python")).toEqual([]);
    expect(
      stepsThatCannotStart(jobInPackage, "${{ github.workspace }}"),
    ).toEqual(["Authorize actor and branch"]);
  });
});
