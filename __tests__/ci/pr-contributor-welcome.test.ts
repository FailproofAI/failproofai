/** Contributor automation must work with GitHub Actions PR approvals disabled. */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

interface Workflow {
  on: { pull_request_target: { types: string[] } };
  permissions: Record<string, string>;
  jobs: Record<string, {
    steps: Array<{ uses?: string; with?: { script?: string } }>;
  }>;
}

const workflow = parse(readFileSync(
  resolve(process.cwd(), ".github/workflows/pr-contributor-welcome.yml"),
  "utf8",
)) as Workflow;

describe("contributor welcome workflow", () => {
  it("runs comment automation on opening a PR without approval permissions", () => {
    expect(workflow.on.pull_request_target.types).toEqual(["opened"]);
    expect(workflow.permissions.issues).toBe("write");
    expect(workflow.permissions["pull-requests"]).not.toBe("write");
    expect(Object.keys(workflow.jobs)).toEqual(["welcome"]);
  });

  it.each(["dependabot[bot]", "contributor"])("welcomes %s without creating a review", async (author) => {
    const createComment = vi.fn().mockResolvedValue({});
    const createReview = vi.fn().mockRejectedValue(new Error("GitHub Actions is not permitted to approve pull requests."));
    const steps = workflow.jobs.welcome.steps;
    expect(steps.some((step) => step.uses?.startsWith("actions/checkout"))).toBe(false);
    const script = steps.find((step) => step.uses?.startsWith("actions/github-script"))?.with?.script;
    expect(script).toBeDefined();

    await runInNewContext(`(async () => {${script}})()`, {
      github: { rest: { issues: { createComment }, pulls: { createReview } } },
      context: {
        repo: { owner: "FailproofAI", repo: "failproofai" },
        payload: { pull_request: { number: 1049, user: { login: author } } },
      },
    });

    expect(createComment).toHaveBeenCalledExactlyOnceWith({
      owner: "FailproofAI",
      repo: "failproofai",
      issue_number: 1049,
      body: expect.stringContaining(`Thanks @${author}`),
    });
    const body = createComment.mock.calls[0][0].body;
    if (author === "dependabot[bot]") {
      expect(body).toContain("keeping our dependencies current");
    } else {
      expect(body).toContain("https://discord.befailproof.ai/");
      expect(body).toContain("https://www.reddit.com/r/failproofai/");
    }
    expect(createReview).not.toHaveBeenCalled();
  });
});
