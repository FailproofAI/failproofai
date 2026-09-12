// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { evaluatePolicies } from "../../src/hooks/policy-evaluator";
import { clearPolicies, registerPolicy } from "../../src/hooks/policy-registry";

const INVOICE_WORKSPACE_RE = /(?:^|\/)invoice(?:\/|$)/;
const NEEDS_HUMAN_MAPPING_RE = /\bneeds_human_mapping\b/;
const FINANCE_SEND_RE = /\bopenclaw\s+message\s+send\b[\s\S]*?(?:--channel\s+slack|-c\s+slack)[\s\S]*?(?:-t\s+C0AVC7K2XDM|--target\s+C0AVC7K2XDM)/i;
const ESCALATION_STATUS_RE = /(?:needs\s+review|couldn['’]?t\s+file)/i;

describe("Zaum OpenClaw invoice instruct policy", () => {
  beforeEach(() => {
    clearPolicies();
    registerPolicy("warn-invoice-self-resolution", "invoice recovery", (ctx) => {
      if (ctx.cli !== "openclaw") return { decision: "allow" };
      if (!INVOICE_WORKSPACE_RE.test(String(ctx.session?.cwd ?? ""))) return { decision: "allow" };

      const toolInput = JSON.stringify(ctx.toolInput ?? {});
      const isPreQuestionCheckpoint = NEEDS_HUMAN_MAPPING_RE.test(toolInput);
      const isFinanceEscalation =
        ctx.toolName === "Bash" &&
        FINANCE_SEND_RE.test(toolInput) &&
        ESCALATION_STATUS_RE.test(toolInput);

      if (!isPreQuestionCheckpoint && !isFinanceEscalation) return { decision: "allow" };
      return { decision: "instruct", reason: "make one more evidence-backed recovery pass" };
    }, { events: ["PreToolUse"] });
  });

  it("emits an OpenClaw instruct verdict for Zaum's observed Finance escalation shape", async () => {
    const result = await evaluatePolicies("PreToolUse", {
      tool_name: "Bash",
      tool_input: {
        command: "openclaw message send --channel slack -t C0AVC7K2XDM --message 'Needs review: couldn’t file invoice'",
      },
      cwd: "/Users/atlas/.openclaw/workspace/invoice",
    }, {
      cli: "openclaw",
      cwd: "/Users/atlas/.openclaw/workspace/invoice",
    });

    expect(result.decision).toBe("instruct");
    expect(JSON.parse(result.stdout)).toMatchObject({
      permission: "instruct",
      policyName: "failproofai/warn-invoice-self-resolution",
    });
  });

  it("does not affect unrelated OpenClaw Slack sends", async () => {
    const result = await evaluatePolicies("PreToolUse", {
      tool_name: "Bash",
      tool_input: {
        command: "openclaw message send --channel slack -t C0AVC7K2XDM --message 'Invoice filed successfully'",
      },
      cwd: "/Users/atlas/.openclaw/workspace/invoice",
    }, {
      cli: "openclaw",
      cwd: "/Users/atlas/.openclaw/workspace/invoice",
    });

    expect(result.decision).toBe("allow");
    expect(result.stdout).toBe("");
  });
});
