// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { evaluatePolicies } from "../../src/hooks/policy-evaluator";
import { clearPolicies, registerPolicy } from "../../src/hooks/policy-registry";

const OPERATIONS_WORKSPACE_RE = /(?:^|\/)operations(?:\/|$)/;
const REVIEW_CHECKPOINT_RE = /\brequires_manual_review\b/;
const NOTIFICATION_SEND_RE = /\bopenclaw\s+message\s+send\b[\s\S]*?(?:--channel\s+slack|-c\s+slack)[\s\S]*?(?:-t\s+C0123456789|--target\s+C0123456789)/i;
const FAILURE_STATUS_RE = /(?:needs\s+review|couldn['’]?t\s+process)/i;

describe("OpenClaw instruct policy", () => {
  beforeEach(() => {
    clearPolicies();
    registerPolicy("retry-before-action", "generic recovery", (ctx) => {
      if (ctx.cli !== "openclaw") return { decision: "allow" };
      if (!OPERATIONS_WORKSPACE_RE.test(String(ctx.session?.cwd ?? ""))) return { decision: "allow" };

      const toolInput = JSON.stringify(ctx.toolInput ?? {});
      const isReviewCheckpoint = REVIEW_CHECKPOINT_RE.test(toolInput);
      const isNotification =
        ctx.toolName === "Bash" &&
        NOTIFICATION_SEND_RE.test(toolInput) &&
        FAILURE_STATUS_RE.test(toolInput);

      if (!isReviewCheckpoint && !isNotification) return { decision: "allow" };
      return { decision: "instruct", reason: "make one more evidence-backed recovery pass" };
    }, { events: ["PreToolUse"] });
  });

  it("emits an OpenClaw instruct verdict for a matching escalation", async () => {
    const result = await evaluatePolicies("PreToolUse", {
      tool_name: "Bash",
      tool_input: {
        command: "openclaw message send --channel slack -t C0123456789 --message 'Needs review: couldn’t process record'",
      },
      cwd: "/Users/tester/.openclaw/workspace/operations",
    }, {
      cli: "openclaw",
      cwd: "/Users/tester/.openclaw/workspace/operations",
    });

    expect(result.decision).toBe("instruct");
    expect(JSON.parse(result.stdout)).toMatchObject({
      permission: "instruct",
      policyName: "failproofai/retry-before-action",
    });
  });

  it("does not affect unrelated OpenClaw Slack sends", async () => {
    const result = await evaluatePolicies("PreToolUse", {
      tool_name: "Bash",
      tool_input: {
        command: "openclaw message send --channel slack -t C0123456789 --message 'Record processed successfully'",
      },
      cwd: "/Users/tester/.openclaw/workspace/operations",
    }, {
      cli: "openclaw",
      cwd: "/Users/tester/.openclaw/workspace/operations",
    });

    expect(result.decision).toBe("allow");
    expect(result.stdout).toBe("");
  });
});
