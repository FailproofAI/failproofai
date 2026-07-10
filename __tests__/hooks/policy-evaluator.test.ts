// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { evaluatePolicies } from "../../src/hooks/policy-evaluator";
import { registerPolicy, clearPolicies } from "../../src/hooks/policy-registry";

describe("hooks/policy-evaluator", () => {
  beforeEach(() => {
    clearPolicies();
  });

  it("returns allow (exit 0, no stdout) when no policies match", async () => {
    const result = await evaluatePolicies("PreToolUse", { tool_name: "Read" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.policyName).toBeNull();
    expect(result.reason).toBeNull();
  });

  it("returns allow when all policies allow", async () => {
    registerPolicy("allow1", "desc", () => ({ decision: "allow" }), { events: ["PreToolUse"] });
    registerPolicy("allow2", "desc", () => ({ decision: "allow" }), { events: ["PreToolUse"] });
    const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.policyName).toBeNull();
    expect(result.reason).toBeNull();
  });

  it("deny short-circuits — first deny wins for PreToolUse", async () => {
    registerPolicy("blocker", "desc", () => ({ decision: "deny", reason: "blocked" }), {
      events: ["PreToolUse"],
    });
    registerPolicy("allow", "desc", () => ({ decision: "allow" }), { events: ["PreToolUse"] });

    const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(
      "Blocked Bash by failproofai because: blocked, as per the policy configured by the user",
    );
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(result.policyName).toBe("failproofai/blocker");
    expect(result.reason).toBe("blocked");
  });

  it("formats PostToolUse deny with additionalContext", async () => {
    registerPolicy("jwt-scrub", "desc", () => ({
      decision: "deny",
      reason: "JWT found",
      message: "[REDACTED]",
    }), { events: ["PostToolUse"] });

    const result = await evaluatePolicies("PostToolUse", { tool_name: "Read" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toBe(
      "Blocked Read by failproofai because: JWT found, as per the policy configured by the user",
    );
    expect(result.policyName).toBe("failproofai/jwt-scrub");
    expect(result.reason).toBe("JWT found");
  });

  it("other event types use exit 2 for deny", async () => {
    registerPolicy("blocker", "desc", () => ({ decision: "deny", reason: "nope" }), {
      events: ["SessionStart"],
    });

    const result = await evaluatePolicies("SessionStart", {});
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("nope");
    expect(result.reason).toBe("nope");
  });

  it("passes toolName and toolInput from payload to policy context", async () => {
    let capturedCtx: unknown = null;
    registerPolicy("spy", "desc", (ctx) => {
      capturedCtx = ctx;
      return { decision: "allow" };
    }, { events: ["PreToolUse"] });

    await evaluatePolicies("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });

    const ctx = capturedCtx as { toolName: string; toolInput: { command: string } };
    expect(ctx.toolName).toBe("Bash");
    expect(ctx.toolInput.command).toBe("ls");
  });

  it("supports async policy functions", async () => {
    registerPolicy("async-deny", "desc", async () => {
      return { decision: "deny", reason: "async block" };
    }, { events: ["PreToolUse"] });

    const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("instruct produces additionalContext in stdout with exit code 0", async () => {
    registerPolicy("advisor", "desc", () => ({
      decision: "instruct",
      reason: "You should try something else",
    }), { events: ["PreToolUse"] });

    const result = await evaluatePolicies("PreToolUse", { tool_name: "Read" });
    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe("instruct");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("You should try something else");
    expect(result.policyName).toBe("failproofai/advisor");
    expect(result.policyNames).toEqual(["failproofai/advisor"]);
    expect(result.reason).toBe("You should try something else");
  });

  it("deny takes precedence over instruct", async () => {
    registerPolicy("advisor", "desc", () => ({
      decision: "instruct",
      reason: "just a warning",
    }), { events: ["PreToolUse"] });
    registerPolicy("blocker", "desc", () => ({
      decision: "deny",
      reason: "hard block",
    }), { events: ["PreToolUse"] });

    const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" });
    expect(result.decision).toBe("deny");
    expect(result.policyName).toBe("failproofai/blocker");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("EvaluationResult.decision is 'allow' when all allow", async () => {
    registerPolicy("ok", "desc", () => ({ decision: "allow" }), { events: ["PreToolUse"] });
    const result = await evaluatePolicies("PreToolUse", { tool_name: "Read" });
    expect(result.decision).toBe("allow");
    expect(result.stdout).toBe("");
  });

  it("skips a policy that throws and continues to allow", async () => {
    registerPolicy("thrower", "desc", () => { throw new Error("unexpected failure"); }, { events: ["PreToolUse"] });
    registerPolicy("ok", "desc", () => ({ decision: "allow" }), { events: ["PreToolUse"] });

    const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" });
    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe("allow");
  });

  it("skips an async policy that rejects and continues to allow", async () => {
    registerPolicy("async-thrower", "desc", async () => { throw new Error("async failure"); }, { events: ["PreToolUse"] });

    const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" });
    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe("allow");
  });

  it("Stop + instruct returns exitCode 2 with reason in stderr", async () => {
    registerPolicy("verify", "desc", () => ({
      decision: "instruct",
      reason: "Unsatisfied intents remain",
    }), { events: ["Stop"] });

    const result = await evaluatePolicies("Stop", {});
    expect(result.exitCode).toBe(2);
    expect(result.decision).toBe("instruct");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("MANDATORY ACTION REQUIRED");
    expect(result.stderr).toContain("Unsatisfied intents remain");
    expect(result.policyName).toBe("failproofai/verify");
  });

  it("SubagentStop + instruct also returns exitCode 2 (Claude path mirrors Stop)", async () => {
    // The instruct-path Stop branch was widened to include SubagentStop, so
    // custom subagent-instruct policies now go through the MANDATORY ACTION
    // wrapper instead of falling through to the generic hookSpecificOutput
    // additionalContext shape (which Claude does not honor for SubagentStop).
    registerPolicy("verify", "desc", () => ({
      decision: "instruct",
      reason: "subagent left work undone",
    }), { events: ["SubagentStop"] });

    const result = await evaluatePolicies("SubagentStop", {});
    expect(result.exitCode).toBe(2);
    expect(result.decision).toBe("instruct");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("MANDATORY ACTION REQUIRED");
    expect(result.stderr).toContain("subagent left work undone");
  });

  it("Copilot Stop + instruct emits {decision:'block', reason} JSON on stdout (NOT exit 2)", async () => {
    // CodeRabbit catch on PR #299: the Copilot block-payload branch existed in
    // the deny path but the instruct path's `eventType === "Stop"` arm had no
    // Copilot branch, so instruct verdicts on Copilot Stop fell through to
    // exit-2 — which Copilot logs as `[WARNING] Hook warning: ...` but does
    // NOT honor for retry. Mirror the deny branch so instruct enforces too.
    registerPolicy("verify", "desc", () => ({
      decision: "instruct",
      reason: "needs verification",
    }), { events: ["Stop"] });

    const result = await evaluatePolicies("Stop", {}, { cli: "copilot" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.decision).toBe("instruct");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("MANDATORY ACTION REQUIRED");
    expect(parsed.reason).toContain("needs verification");
  });

  it("Copilot SubagentStop + instruct also emits {decision:'block', reason} JSON", async () => {
    // Combined coverage of both fixes: instruct-path SubagentStop on Copilot
    // must produce the JSON-block shape (was double-fallthrough before — the
    // branch only matched Stop AND only the deny path had a Copilot arm).
    registerPolicy("verify", "desc", () => ({
      decision: "instruct",
      reason: "subagent verification pending",
    }), { events: ["SubagentStop"] });

    const result = await evaluatePolicies("SubagentStop", {}, { cli: "copilot" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.decision).toBe("instruct");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("MANDATORY ACTION REQUIRED");
    expect(parsed.reason).toContain("subagent verification pending");
  });

  it("Hermes deny emits {decision:'block', reason} JSON on stdout (exit 0, ignores exit codes)", async () => {
    // Hermes's only actionable channel is `{"decision":"block"}` on stdout —
    // it ignores exit codes. One unconditional branch covers every Hermes event.
    registerPolicy("blocker", "desc", () => ({ decision: "deny", reason: "no rm -rf" }), {
      events: ["PreToolUse"],
    });
    const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, { cli: "hermes" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.decision).toBe("deny");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("no rm -rf");
  });

  it("Hermes deny on SubagentStop also emits {decision:'block'} (no Stop special-case)", async () => {
    registerPolicy("blocker", "desc", () => ({ decision: "deny", reason: "finish first" }), {
      events: ["SubagentStop"],
    });
    const result = await evaluatePolicies("SubagentStop", {}, { cli: "hermes" });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.decision).toBe("block");
  });

  it("Hermes instruct degrades to allow + logged note (no context-injection channel)", async () => {
    registerPolicy("advise", "desc", () => ({ decision: "instruct", reason: "prefer git mv" }), {
      events: ["PreToolUse"],
    });
    const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, { cli: "hermes" });
    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe("instruct");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.decision).toBe("allow"); // does NOT block — tool still runs
    expect(parsed.reason).toContain("prefer git mv");
    expect(result.stderr).toContain("prefer git mv"); // surfaced on stderr for logs
  });

  it("Cursor SubagentStop + instruct emits {followup_message} JSON (parity with Stop branch)", async () => {
    // The Cursor Stop instruct branch was widened to also match SubagentStop
    // so custom policies subscribing to SubagentStop on Cursor get the same
    // force-retry semantics. Mirrors the Copilot widening above.
    registerPolicy("verify", "desc", () => ({
      decision: "instruct",
      reason: "subagent verification pending",
    }), { events: ["SubagentStop"] });

    const result = await evaluatePolicies("SubagentStop", {}, { cli: "cursor" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.decision).toBe("instruct");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.followup_message).toMatch(/^Instruction from failproofai:/);
    expect(parsed.followup_message).toContain("subagent verification pending");
  });

  it("OpenCode Stop + instruct emits {hookSpecificOutput.additionalContext} JSON on stdout (NOT exit 2)", async () => {
    // Mirrors the Copilot/Cursor instruct-on-Stop fixes: without a per-CLI
    // branch, opencode instruct verdicts fall through to exit-2 + stderr,
    // which the OpenCode shim throws from inside session.idle — a no-op
    // because the agent has already gone idle. The shim's only working
    // force-retry channel is hookSpecificOutput.additionalContext routed
    // through client.session.prompt.
    registerPolicy("verify", "desc", () => ({
      decision: "instruct",
      reason: "needs verification",
    }), { events: ["Stop"] });

    const result = await evaluatePolicies("Stop", {}, { cli: "opencode" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.decision).toBe("instruct");
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("MANDATORY ACTION REQUIRED");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("needs verification");
  });

  it("OpenCode SubagentStop + instruct also emits {hookSpecificOutput.additionalContext} JSON", async () => {
    // Forward-compat parity with the SubagentStop deny test — see comment
    // there for why we widen even though OpenCode doesn't yet expose
    // subagent boundaries to plugins.
    registerPolicy("verify", "desc", () => ({
      decision: "instruct",
      reason: "subagent verification pending",
    }), { events: ["SubagentStop"] });

    const result = await evaluatePolicies("SubagentStop", {}, { cli: "opencode" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.decision).toBe("instruct");
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("subagent verification pending");
  });

  it("Pi Stop + instruct emits {permission:'deny', reason} JSON with MANDATORY ACTION wording", async () => {
    // Pi cannot veto agent_end (the agent loop has already exited when it
    // fires — Pi's AgentEndEvent has no Result type). Instead the
    // pi-extension shim captures the deny reason and re-injects it as a
    // systemPrompt suffix on the next before_agent_start. The instruct
    // path must therefore use {permission: "deny"} (NOT the regular Pi
    // instruct shape `{permission: "allow", reason}`) so the shim's
    // agent_end handler captures the reason. Locks down the wording and
    // shape so a regression here would silently weaken Pi Stop enforcement.
    registerPolicy("verify", "desc", () => ({
      decision: "instruct",
      reason: "needs verification",
    }), { events: ["Stop"] });

    const result = await evaluatePolicies("Stop", {}, { cli: "pi" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.decision).toBe("instruct");
    const parsed = JSON.parse(result.stdout) as { permission?: string; reason?: string };
    expect(parsed.permission).toBe("deny");
    expect(parsed.reason).toContain("MANDATORY ACTION REQUIRED");
    expect(parsed.reason).toContain("policy: failproofai/verify");
    expect(parsed.reason).toContain("needs verification");
  });

  it("Pi non-Stop + instruct keeps the existing flat {permission:'allow', reason} shape", async () => {
    // Regression guard: only Stop events should flip to permission:"deny".
    // PreToolUse / PostToolUse / UserPromptSubmit instruct verdicts on Pi
    // must keep the prior `{permission: "allow", reason: "Instruction
    // from failproofai: …"}` shape so the shim's tool_call handler does
    // NOT block tool execution.
    registerPolicy("note", "desc", () => ({
      decision: "instruct",
      reason: "fyi",
    }), { events: ["PreToolUse"] });

    const result = await evaluatePolicies(
      "PreToolUse",
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { cli: "pi" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe("instruct");
    const parsed = JSON.parse(result.stdout) as { permission?: string; reason?: string };
    expect(parsed.permission).toBe("allow");
    expect(parsed.reason).toMatch(/^Instruction from failproofai: /);
    expect(parsed.reason).toContain("fyi");
  });

  it("Gemini Stop + instruct emits {decision:'block', reason} JSON on stdout (force-retry via AfterAgent)", async () => {
    // Confirms the existing cli==="gemini" Stop arm in the instruct path
    // emits the documented force-retry shape. Pairs with the deny-path
    // test in the "Stop event deny format" describe block.
    registerPolicy("verify", "desc", () => ({
      decision: "instruct",
      reason: "needs verification",
    }), { events: ["Stop"] });

    const result = await evaluatePolicies("Stop", {}, { cli: "gemini" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.decision).toBe("instruct");
    const parsed = JSON.parse(result.stdout) as { decision?: string; reason?: string };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("MANDATORY ACTION REQUIRED");
    expect(parsed.reason).toContain("needs verification");
  });

  it("accumulates multiple instruct messages", async () => {
    registerPolicy("first", "desc", () => ({
      decision: "instruct",
      reason: "first warning",
    }), { events: ["PreToolUse"] });
    registerPolicy("second", "desc", () => ({
      decision: "instruct",
      reason: "second warning",
    }), { events: ["PreToolUse"] });

    const result = await evaluatePolicies("PreToolUse", { tool_name: "Read" });
    expect(result.decision).toBe("instruct");
    expect(result.policyName).toBe("failproofai/first");
    expect(result.policyNames).toEqual(["failproofai/first", "failproofai/second"]);
    expect(result.reason).toBe("first warning\nsecond warning");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("first warning");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("second warning");
  });

  describe("allow with message", () => {
    it("returns additionalContext when allow has a reason", async () => {
      registerPolicy("info", "desc", () => ({
        decision: "allow",
        reason: "All checks passed",
      }), { events: ["PreToolUse"] });

      const result = await evaluatePolicies("PreToolUse", { tool_name: "Read" });
      expect(result.exitCode).toBe(0);
      expect(result.decision).toBe("allow");
      expect(result.reason).toBe("All checks passed");
      expect(result.policyName).toBe("failproofai/info");
      expect(result.policyNames).toEqual(["failproofai/info"]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toBe("Note from failproofai: All checks passed");
      expect(result.stderr).toContain("[failproofai] failproofai/info: All checks passed");
    });

    it("combines multiple allow messages with newline", async () => {
      registerPolicy("info1", "desc", () => ({
        decision: "allow",
        reason: "Commit check passed",
      }), { events: ["Stop"] });
      registerPolicy("info2", "desc", () => ({
        decision: "allow",
        reason: "Push check passed",
      }), { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {});
      expect(result.exitCode).toBe(0);
      expect(result.decision).toBe("allow");
      expect(result.policyName).toBe("failproofai/info1");
      expect(result.policyNames).toEqual(["failproofai/info1", "failproofai/info2"]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.reason).toBe("Commit check passed\nPush check passed");
      expect(result.stderr).toContain("[failproofai] failproofai/info1: Commit check passed");
      expect(result.stderr).toContain("[failproofai] failproofai/info2: Push check passed");
    });

    it("returns empty stdout when allow has no reason (backward-compatible)", async () => {
      registerPolicy("ok", "desc", () => ({ decision: "allow" }), { events: ["PreToolUse"] });

      const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.reason).toBeNull();
      expect(result.policyName).toBeNull();
      expect(result.policyNames).toBeUndefined();
    });

    it("deny still takes precedence over allow with message", async () => {
      registerPolicy("info", "desc", () => ({
        decision: "allow",
        reason: "looks good",
      }), { events: ["PreToolUse"] });
      registerPolicy("blocker", "desc", () => ({
        decision: "deny",
        reason: "blocked",
      }), { events: ["PreToolUse"] });

      const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" });
      expect(result.decision).toBe("deny");
      expect(result.policyName).toBe("failproofai/blocker");
    });

    it("instruct takes precedence over allow with message", async () => {
      registerPolicy("info", "desc", () => ({
        decision: "allow",
        reason: "looks good",
      }), { events: ["PreToolUse"] });
      registerPolicy("advisor", "desc", () => ({
        decision: "instruct",
        reason: "be careful",
      }), { events: ["PreToolUse"] });

      const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" });
      expect(result.decision).toBe("instruct");
      expect(result.policyName).toBe("failproofai/advisor");
    });
  });

  describe("params injection", () => {
    it("injects schema defaults into ctx.params when no policyParams in config", async () => {
      let capturedParams: unknown = null;
      // Use BUILTIN_POLICIES to get a real policy with a params schema
      const { BUILTIN_POLICIES } = await import("../../src/hooks/builtin-policies");
      const orig = BUILTIN_POLICIES.find((p) => p.name === "block-sudo")!;

      // Wrap the original fn to capture params
      registerPolicy("block-sudo", orig.description, async (ctx) => {
        capturedParams = ctx.params;
        return { decision: "allow" };
      }, orig.match);

      await evaluatePolicies("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }, undefined, { enabledPolicies: ["block-sudo"] });

      expect(capturedParams).toBeDefined();
      expect((capturedParams as Record<string, unknown>).allowPatterns).toEqual([]);
    });

    it("overrides schema defaults with policyParams from config", async () => {
      let capturedParams: unknown = null;
      const { BUILTIN_POLICIES } = await import("../../src/hooks/builtin-policies");
      const orig = BUILTIN_POLICIES.find((p) => p.name === "block-sudo")!;

      registerPolicy("block-sudo", orig.description, async (ctx) => {
        capturedParams = ctx.params;
        return { decision: "allow" };
      }, orig.match);

      const config = {
        enabledPolicies: ["block-sudo"],
        policyParams: { "block-sudo": { allowPatterns: ["sudo systemctl status"] } },
      };
      await evaluatePolicies("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }, undefined, config);

      expect((capturedParams as Record<string, unknown>).allowPatterns).toEqual(["sudo systemctl status"]);
    });

    it("unknown policyParams key does not crash evaluator", async () => {
      registerPolicy("allow-all", "desc", () => ({ decision: "allow" }), { events: ["PreToolUse"] });

      const config = {
        enabledPolicies: ["allow-all"],
        policyParams: { "nonexistent-policy": { someParam: 42 } },
      };
      await expect(
        evaluatePolicies("PreToolUse", { tool_name: "Bash" }, undefined, config),
      ).resolves.not.toThrow();
    });

    it("flat policyParams key only matches default-namespace policies (not custom/myorg)", async () => {
      // A custom hook registered with a third-party namespace must NOT pick up
      // params keyed by the bare short name — that key belongs to the
      // failproofai/<short> builtin slot, not myorg/<short>.
      let capturedHint: unknown = null;
      registerPolicy("myorg/foo", "desc", () => ({
        decision: "deny",
        reason: "denied by myorg/foo",
      }), { events: ["PreToolUse"] });

      const config = {
        enabledPolicies: ["myorg/foo"],
        policyParams: { foo: { hint: "should NOT leak across namespaces" } },
      };
      const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, undefined, config);
      expect(result.decision).toBe("deny");
      // Reason must not include the hint from the unrelated default-namespace key
      expect(result.reason).toBe("denied by myorg/foo");
      capturedHint = result.reason?.includes("should NOT leak");
      expect(capturedHint).toBe(false);
    });

    it("custom hooks registered with custom/ prefix receive empty params", async () => {
      let capturedParams: unknown = undefined;
      registerPolicy("custom/my-hook", "custom", async (ctx) => {
        capturedParams = ctx.params;
        return { decision: "allow" };
      }, { events: ["PreToolUse"] }, -1);

      await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, undefined, { enabledPolicies: [] });

      // Custom hooks get empty params object
      expect(capturedParams).toEqual({});
    });
  });

  describe("Stop event deny format", () => {
    it("Stop deny uses exit code 2 with reason in stderr", async () => {
      registerPolicy("stop-blocker", "desc", () => ({
        decision: "deny",
        reason: "changes not committed",
      }), { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {});
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("MANDATORY ACTION REQUIRED");
      expect(result.stderr).toContain("changes not committed");
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("changes not committed");
    });

    it("Copilot Stop deny emits {decision:'block', reason} JSON on stdout (NOT exit 2)", async () => {
      // Copilot CLI 1.0.41 logs exit-2 from agentStop as `[WARNING] Hook
      // warning: ...` but does NOT retry the agent. The documented retry
      // shape is `{decision: "block", reason}` JSON on stdout (exit 0) — the
      // reason becomes the next-turn prompt. The cli==="copilot" branch in
      // policy-evaluator.ts emits this shape; this test pins it.
      registerPolicy("stop-blocker", "desc", () => ({
        decision: "deny",
        reason: "changes not committed",
      }), { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {}, { cli: "copilot" });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("MANDATORY ACTION REQUIRED");
      expect(parsed.reason).toContain("changes not committed");
      expect(result.decision).toBe("deny");
    });

    it("Copilot SubagentStop deny also emits {decision:'block', reason} JSON (subagent retry)", async () => {
      // CodeRabbit catch on PR #299: the cli==="copilot" branch initially only
      // matched eventType==="Stop", so SubagentStop denies fell through to
      // exit-2 — which Copilot ignores for stop-style events, leaving subagent
      // policies as observation-only. Custom policies matching SubagentStop
      // need the same JSON-block shape as Stop. (Builtin require-*-before-stop
      // policies still match Stop only by design — they are session-completion
      // gates, not subagent-return gates.)
      registerPolicy("subagent-blocker", "desc", () => ({
        decision: "deny",
        reason: "subagent left work undone",
      }), { events: ["SubagentStop"] });

      const result = await evaluatePolicies("SubagentStop", {}, { cli: "copilot" });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("MANDATORY ACTION REQUIRED");
      expect(parsed.reason).toContain("subagent left work undone");
      expect(result.decision).toBe("deny");
    });

    it("Claude SubagentStop deny still uses exit-2+stderr (regression: non-copilot path unchanged)", async () => {
      // The Stop branch was widened to include SubagentStop; verify the
      // non-copilot path still emits exit-2 with the MANDATORY ACTION wrapper
      // (was previously falling through to the bare-reason "other events"
      // fallback at the function tail — pre-existing minor inconsistency that
      // the widening also fixed for SubagentStop on Claude).
      registerPolicy("subagent-blocker", "desc", () => ({
        decision: "deny",
        reason: "subagent left work undone",
      }), { events: ["SubagentStop"] });

      const result = await evaluatePolicies("SubagentStop", {});
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("MANDATORY ACTION REQUIRED");
      expect(result.stderr).toContain("subagent left work undone");
      expect(result.decision).toBe("deny");
    });

    it("Cursor Stop deny emits {followup_message} JSON on stdout (NOT exit 2)", async () => {
      // Cursor's `stop` hook ignores `{permission: "deny"}` — that shape is
      // only honored on tool events. The only force-retry channel for Stop
      // is `{followup_message}` on stdout (exit 0); Cursor auto-submits the
      // text as the next user message (capped at `loop_limit`, default 5).
      // Without the cli==="cursor" Stop arm in policy-evaluator.ts, the 5
      // require-*-before-stop builtins were observation-only on Cursor —
      // the deny was logged but the agent stopped cleanly.
      // Ref: https://cursor.com/docs/hooks
      registerPolicy("stop-blocker", "desc", () => ({
        decision: "deny",
        reason: "changes not committed",
      }), { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {}, { cli: "cursor" });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed.followup_message).toContain("MANDATORY ACTION REQUIRED");
      expect(parsed.followup_message).toContain("changes not committed");
      // The flat {permission:"deny", user_message, agent_message} shape MUST
      // NOT be emitted on Stop — Cursor would ignore it and the agent would
      // stop cleanly. This is the load-bearing assertion.
      expect(parsed.permission).toBeUndefined();
      expect(parsed.user_message).toBeUndefined();
      expect(parsed.agent_message).toBeUndefined();
      expect(result.decision).toBe("deny");
    });

    it("Cursor SubagentStop deny also emits {followup_message} JSON (subagent retry)", async () => {
      // The cli==="cursor" Stop arm was widened to also match SubagentStop
      // so custom policies subscribing to SubagentStop on Cursor enforce
      // (the 5 require-*-before-stop builtins still match Stop only by
      // design — they are session-completion gates, not subagent-return
      // gates). Mirrors the Copilot SubagentStop widening from #299.
      registerPolicy("subagent-blocker", "desc", () => ({
        decision: "deny",
        reason: "subagent left work undone",
      }), { events: ["SubagentStop"] });

      const result = await evaluatePolicies("SubagentStop", {}, { cli: "cursor" });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed.followup_message).toContain("MANDATORY ACTION REQUIRED");
      expect(parsed.followup_message).toContain("subagent left work undone");
      expect(result.decision).toBe("deny");
    });

    it("Cursor PreToolUse deny still uses {permission:'deny'} flat shape (regression: tool-event path unchanged)", async () => {
      // The Stop/SubagentStop arm is added INSIDE the cli==="cursor" branch
      // so the flat-shape return below it is unchanged for tool events.
      // Verify PreToolUse still emits the flat deny shape — Cursor's tool
      // hooks DO honor it.
      registerPolicy("tool-blocker", "desc", () => ({
        decision: "deny",
        reason: "blocked tool",
      }), { events: ["PreToolUse"] });

      const result = await evaluatePolicies(
        "PreToolUse",
        { tool_name: "Bash", tool_input: { command: "ls" } },
        { cli: "cursor" },
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed.permission).toBe("deny");
      expect(parsed.user_message).toMatch(/Blocked Bash by failproofai/);
      expect(parsed.agent_message).toMatch(/Blocked Bash by failproofai/);
      // No followup_message on tool events — that's a Stop-only shape.
      expect(parsed.followup_message).toBeUndefined();
    });

    it("Stop deny short-circuits subsequent policies", async () => {
      const secondPolicyCalled = { value: false };
      registerPolicy("blocker", "desc", () => ({
        decision: "deny",
        reason: "blocked first",
      }), { events: ["Stop"] });
      registerPolicy("second", "desc", () => {
        secondPolicyCalled.value = true;
        return { decision: "allow" };
      }, { events: ["Stop"] });

      await evaluatePolicies("Stop", {});
      expect(secondPolicyCalled.value).toBe(false);
    });

    it("OpenCode Stop deny emits {hookSpecificOutput.additionalContext} JSON on stdout (NOT exit 2)", async () => {
      // OpenCode's `session.idle` event is notification-only — by the time
      // the plugin handler fires, the agent has already gone idle and a
      // thrown error from the handler does not force-retry. The shim's only
      // working force-retry channel is `client.session.prompt(...)`, which
      // it routes through `hookSpecificOutput.additionalContext`. Without
      // this branch, the 5 require-*-before-stop builtins were
      // observation-only on OpenCode — the deny was logged in the dashboard
      // but the agent stopped silently.
      registerPolicy("stop-blocker", "desc", () => ({
        decision: "deny",
        reason: "changes not committed",
      }), { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {}, { cli: "opencode" });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } };
      expect(parsed.hookSpecificOutput?.additionalContext).toContain("MANDATORY ACTION REQUIRED");
      expect(parsed.hookSpecificOutput?.additionalContext).toContain("changes not committed");
      // Load-bearing: must NOT emit exit-2 (the shim would `throw` from
      // session.idle, which OpenCode logs but ignores) or
      // permissionDecision: "deny" (the shim would also throw on that path).
      expect(parsed.hookSpecificOutput?.permissionDecision).toBeUndefined();
      expect(result.decision).toBe("deny");
    });

    it("OpenCode SubagentStop deny also emits {hookSpecificOutput.additionalContext} JSON (forward-compat)", async () => {
      // OpenCode does not yet expose subagent boundaries to plugins, but
      // custom policies subscribing to SubagentStop should still get the
      // force-retry shape if OpenCode adds the bus event later. Mirrors the
      // Cursor + Copilot SubagentStop widening.
      registerPolicy("subagent-blocker", "desc", () => ({
        decision: "deny",
        reason: "subagent left work undone",
      }), { events: ["SubagentStop"] });

      const result = await evaluatePolicies("SubagentStop", {}, { cli: "opencode" });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(parsed.hookSpecificOutput?.additionalContext).toContain("MANDATORY ACTION REQUIRED");
      expect(parsed.hookSpecificOutput?.additionalContext).toContain("subagent left work undone");
      expect(result.decision).toBe("deny");
    });

    it("OpenCode PreToolUse deny still uses Claude permissionDecision shape (regression: tool-event path unchanged)", async () => {
      // The Stop arm is added INSIDE the cli==="opencode" branch so the
      // generic Claude shape below it is unchanged for tool events. The
      // shim's applyDecision throws on permissionDecision: "deny" — that's
      // the working path for tool events.
      registerPolicy("tool-blocker", "desc", () => ({
        decision: "deny",
        reason: "blocked tool",
      }), { events: ["PreToolUse"] });

      const result = await evaluatePolicies(
        "PreToolUse",
        { tool_name: "Bash", tool_input: { command: "ls" } },
        { cli: "opencode" },
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string } };
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
      // No additionalContext on tool events — that's a Stop-only shape.
      expect(parsed.hookSpecificOutput?.additionalContext).toBeUndefined();
    });

    it("Pi Stop deny emits flat {permission:'deny', reason} JSON with MANDATORY ACTION wording", async () => {
      // Pi's AgentEndEvent has no Result type — by the time agent_end fires,
      // Pi's agent loop has already exited, so a deny return cannot keep
      // Pi running the way Claude's exit-2-from-Stop does. The
      // pi-extension shim instead captures the deny `reason` from
      // agent_end and re-injects it as a systemPrompt suffix on the next
      // before_agent_start. policy-evaluator.ts emits the flat
      // `{permission:"deny", reason}` shape with the MANDATORY ACTION
      // wrapper for `cli === "pi" && eventType === "Stop"` so the shim
      // can capture the reason verbatim. This test pins both the shape
      // and the wording — a regression here would silently weaken Pi
      // Stop enforcement (the shim would still deny but the LLM would
      // see the generic "Blocked stop by failproofai because: …"
      // wording that's calibrated for tool-event denials, not Stop).
      registerPolicy("stop-blocker", "desc", () => ({
        decision: "deny",
        reason: "tests not run",
      }), { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {}, { cli: "pi" });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout) as { permission?: string; reason?: string };
      expect(parsed.permission).toBe("deny");
      expect(parsed.reason).toContain("MANDATORY ACTION REQUIRED");
      expect(parsed.reason).toContain("policy: failproofai/stop-blocker");
      expect(parsed.reason).toContain("tests not run");
      expect(result.decision).toBe("deny");
      expect(result.policyName).toBe("failproofai/stop-blocker");
      expect(result.reason).toBe("tests not run");
    });

    it("Pi non-Stop deny keeps the existing flat {permission:'deny', reason: blockedMessage} shape", async () => {
      // Regression guard: the Pi-Stop branch is gated on
      // `eventType === "Stop"` — every other event type must keep the
      // pre-existing flat shape so PreToolUse/UserPromptSubmit/etc. denies
      // continue to fire on Pi. Confirms the split (added in the
      // before_agent_start handoff PR) didn't accidentally route non-Stop
      // events through the MANDATORY ACTION wrapper.
      registerPolicy("blocker", "desc", () => ({
        decision: "deny",
        reason: "sudo not allowed",
      }), { events: ["PreToolUse"] });

      const result = await evaluatePolicies(
        "PreToolUse",
        { tool_name: "Bash", tool_input: { command: "sudo ls" } },
        { cli: "pi" },
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { permission?: string; reason?: string };
      expect(parsed.permission).toBe("deny");
      expect(parsed.reason).not.toContain("MANDATORY ACTION REQUIRED");
      expect(parsed.reason).toMatch(/^Blocked Bash by failproofai because: /);
      expect(parsed.reason).toContain("sudo not allowed");
    });

    it("Gemini Stop deny emits {decision:'block', reason} JSON on stdout (force-retry via AfterAgent)", async () => {
      // Per Gemini's hooks docs (https://geminicli.com/docs/hooks/), the
      // AfterAgent hook (canonical "Stop") force-retries when the hook
      // returns `{decision: "block", reason}` on stdout. Exit-2 is per-
      // action only ("turn continues") and would NOT trigger the retry.
      registerPolicy("stop-blocker", "desc", () => ({
        decision: "deny",
        reason: "tests not run",
      }), { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {}, { cli: "gemini" });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout) as { decision?: string; reason?: string };
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("MANDATORY ACTION REQUIRED");
      expect(parsed.reason).toContain("tests not run");
      expect(result.decision).toBe("deny");
    });
  });

  describe("workflow policy chain integration", () => {
    it("first deny short-circuits — later workflow policies do not run", async () => {
      const policyCalls: string[] = [];

      registerPolicy("require-commit", "desc", () => {
        policyCalls.push("commit");
        return { decision: "deny", reason: "uncommitted changes" };
      }, { events: ["Stop"] });
      registerPolicy("require-push", "desc", () => {
        policyCalls.push("push");
        return { decision: "deny", reason: "unpushed commits" };
      }, { events: ["Stop"] });
      registerPolicy("require-pr", "desc", () => {
        policyCalls.push("pr");
        return { decision: "deny", reason: "no PR" };
      }, { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {});
      expect(result.decision).toBe("deny");
      expect(result.policyName).toBe("failproofai/require-commit");
      expect(policyCalls).toEqual(["commit"]);
    });

    it("all workflow policies allow with messages — messages accumulate", async () => {
      registerPolicy("wf-commit", "desc", () => ({
        decision: "allow",
        reason: "All changes committed",
      }), { events: ["Stop"] });
      registerPolicy("wf-push", "desc", () => ({
        decision: "allow",
        reason: "All commits pushed",
      }), { events: ["Stop"] });
      registerPolicy("wf-pr", "desc", () => ({
        decision: "allow",
        reason: "PR #42 exists",
      }), { events: ["Stop"] });
      registerPolicy("wf-ci", "desc", () => ({
        decision: "allow",
        reason: "All CI checks passed",
      }), { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {});
      expect(result.exitCode).toBe(0);
      expect(result.decision).toBe("allow");
      expect(result.policyNames).toEqual(["failproofai/wf-commit", "failproofai/wf-push", "failproofai/wf-pr", "failproofai/wf-ci"]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.reason).toContain("All changes committed");
      expect(parsed.reason).toContain("All commits pushed");
      expect(parsed.reason).toContain("PR #42 exists");
      expect(parsed.reason).toContain("All CI checks passed");
    });

    it("allow messages from early policies are discarded when a later policy denies", async () => {
      registerPolicy("wf-commit", "desc", () => ({
        decision: "allow",
        reason: "All changes committed",
      }), { events: ["Stop"] });
      registerPolicy("wf-push", "desc", () => ({
        decision: "deny",
        reason: "unpushed commits",
      }), { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {});
      expect(result.decision).toBe("deny");
      expect(result.policyName).toBe("failproofai/wf-push");
      expect(result.reason).toBe("unpushed commits");
    });

    it("instruct on Stop takes precedence over allow messages", async () => {
      registerPolicy("wf-commit", "desc", () => ({
        decision: "allow",
        reason: "All committed",
      }), { events: ["Stop"] });
      registerPolicy("wf-instruct", "desc", () => ({
        decision: "instruct",
        reason: "Please verify tests",
      }), { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {});
      expect(result.decision).toBe("instruct");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("MANDATORY ACTION REQUIRED");
      expect(result.stderr).toContain("Please verify tests");
    });

    it("mixed allow (no message) and allow (with message) — only messages returned", async () => {
      registerPolicy("silent", "desc", () => ({
        decision: "allow",
      }), { events: ["Stop"] });
      registerPolicy("informative", "desc", () => ({
        decision: "allow",
        reason: "CI is green",
      }), { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {});
      expect(result.exitCode).toBe(0);
      expect(result.decision).toBe("allow");
      expect(result.policyName).toBe("failproofai/informative");
      expect(result.policyNames).toEqual(["failproofai/informative"]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.reason).toBe("CI is green");
    });

    it("policy that throws is skipped — subsequent policies still run", async () => {
      registerPolicy("thrower", "desc", () => {
        throw new Error("unexpected crash");
      }, { events: ["Stop"] });
      registerPolicy("checker", "desc", () => ({
        decision: "deny",
        reason: "uncommitted",
      }), { events: ["Stop"] });

      const result = await evaluatePolicies("Stop", {});
      expect(result.decision).toBe("deny");
      expect(result.policyName).toBe("failproofai/checker");
    });
  });

  describe("hint appending", () => {
    it("appends hint to deny reason for PreToolUse", async () => {
      registerPolicy("block-force-push", "desc", () => ({
        decision: "deny",
        reason: "Force-pushing is blocked",
      }), { events: ["PreToolUse"] });

      const config = {
        enabledPolicies: ["block-force-push"],
        policyParams: { "block-force-push": { hint: "Try creating a fresh branch instead." } },
      };
      const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash", tool_input: { command: "git push --force" } }, undefined, config);
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("Force-pushing is blocked. Try creating a fresh branch instead.");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("Try creating a fresh branch instead.");
    });

    it("appends hint to deny reason for PostToolUse", async () => {
      registerPolicy("scrubber", "desc", () => ({
        decision: "deny",
        reason: "Secret detected",
      }), { events: ["PostToolUse"] });

      const config = {
        enabledPolicies: ["scrubber"],
        policyParams: { scrubber: { hint: "Remove the secret before retrying." } },
      };
      const result = await evaluatePolicies("PostToolUse", { tool_name: "Bash" }, undefined, config);
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("Secret detected. Remove the secret before retrying.");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain("Remove the secret before retrying.");
    });

    it("appends hint to deny reason for other event types (exit 2)", async () => {
      registerPolicy("blocker", "desc", () => ({
        decision: "deny",
        reason: "nope",
      }), { events: ["SessionStart"] });

      const config = {
        enabledPolicies: ["blocker"],
        policyParams: { blocker: { hint: "Ask admin for access." } },
      };
      const result = await evaluatePolicies("SessionStart", {}, undefined, config);
      expect(result.exitCode).toBe(2);
      expect(result.reason).toBe("nope. Ask admin for access.");
      expect(result.stderr).toBe("nope. Ask admin for access.");
    });

    it("appends hint to instruct reason", async () => {
      registerPolicy("advisor", "desc", () => ({
        decision: "instruct",
        reason: "Large file detected",
      }), { events: ["PreToolUse"] });

      const config = {
        enabledPolicies: ["advisor"],
        policyParams: { advisor: { hint: "Consider splitting into smaller files." } },
      };
      const result = await evaluatePolicies("PreToolUse", { tool_name: "Write" }, undefined, config);
      expect(result.decision).toBe("instruct");
      expect(result.reason).toBe("Large file detected. Consider splitting into smaller files.");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain("Consider splitting into smaller files.");
    });

    it("appends hint to instruct reason on Stop event", async () => {
      registerPolicy("verify", "desc", () => ({
        decision: "instruct",
        reason: "Unsatisfied intents",
      }), { events: ["Stop"] });

      const config = {
        enabledPolicies: ["verify"],
        policyParams: { verify: { hint: "Run the test suite first." } },
      };
      const result = await evaluatePolicies("Stop", {}, undefined, config);
      expect(result.exitCode).toBe(2);
      expect(result.decision).toBe("instruct");
      expect(result.reason).toBe("Unsatisfied intents. Run the test suite first.");
      expect(result.stderr).toContain("MANDATORY ACTION REQUIRED");
      expect(result.stderr).toContain("Unsatisfied intents. Run the test suite first.");
    });

    it("does not alter reason when no hint is configured", async () => {
      registerPolicy("blocker", "desc", () => ({
        decision: "deny",
        reason: "blocked",
      }), { events: ["PreToolUse"] });

      const config = { enabledPolicies: ["blocker"] };
      const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, undefined, config);
      expect(result.reason).toBe("blocked");
    });

    it("does not alter reason when policyParams has no hint key", async () => {
      registerPolicy("blocker", "desc", () => ({
        decision: "deny",
        reason: "blocked",
      }), { events: ["PreToolUse"] });

      const config = {
        enabledPolicies: ["blocker"],
        policyParams: { blocker: { someOtherParam: "value" } },
      };
      const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, undefined, config);
      expect(result.reason).toBe("blocked");
    });

    it("ignores hint when it is not a string (number)", async () => {
      registerPolicy("blocker", "desc", () => ({
        decision: "deny",
        reason: "blocked",
      }), { events: ["PreToolUse"] });

      const config = {
        enabledPolicies: ["blocker"],
        policyParams: { blocker: { hint: 123 } },
      };
      const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, undefined, config);
      expect(result.reason).toBe("blocked");
    });

    it("ignores hint when it is an empty string", async () => {
      registerPolicy("blocker", "desc", () => ({
        decision: "deny",
        reason: "blocked",
      }), { events: ["PreToolUse"] });

      const config = {
        enabledPolicies: ["blocker"],
        policyParams: { blocker: { hint: "" } },
      };
      const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, undefined, config);
      expect(result.reason).toBe("blocked");
    });

    it("works with custom/ prefixed policy names", async () => {
      registerPolicy("custom/my-hook", "custom", () => ({
        decision: "deny",
        reason: "custom block",
      }), { events: ["PreToolUse"] }, -1);

      const config = {
        enabledPolicies: [],
        policyParams: { "custom/my-hook": { hint: "Ask the user for approval." } },
      };
      const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, undefined, config);
      expect(result.reason).toBe("custom block. Ask the user for approval.");
    });

    it("works with .failproofai-project/ prefixed policy names", async () => {
      registerPolicy(".failproofai-project/my-policy", "convention", () => ({
        decision: "deny",
        reason: "convention block",
      }), { events: ["PreToolUse"] }, -1);

      const config = {
        enabledPolicies: [],
        policyParams: { ".failproofai-project/my-policy": { hint: "Check project CLAUDE.md." } },
      };
      const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, undefined, config);
      expect(result.reason).toBe("convention block. Check project CLAUDE.md.");
    });

    it("hint on instruct does not affect subsequent deny", async () => {
      registerPolicy("advisor", "desc", () => ({
        decision: "instruct",
        reason: "heads up",
      }), { events: ["PreToolUse"] });
      registerPolicy("blocker", "desc", () => ({
        decision: "deny",
        reason: "hard block",
      }), { events: ["PreToolUse"] });

      const config = {
        enabledPolicies: ["advisor", "blocker"],
        policyParams: {
          advisor: { hint: "instruct hint" },
          blocker: { hint: "deny hint" },
        },
      };
      const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, undefined, config);
      // Deny still takes precedence
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("hard block. deny hint");
    });
  });

  describe("Gemini CLI response shape", () => {
    const geminiSession = (hookEventName: string) => ({
      sessionId: "g-1", cwd: "/tmp", cli: "gemini" as const, hookEventName,
    });

    it("PreToolUse deny → flat {decision:'deny', reason} (NOT Claude's hookSpecificOutput shape)", async () => {
      registerPolicy("blocker", "desc", () => ({ decision: "deny", reason: "sudo blocked" }), {
        events: ["PreToolUse"],
      });
      const result = await evaluatePolicies(
        "PreToolUse",
        { tool_name: "Bash", tool_input: { command: "sudo ls" } },
        geminiSession("BeforeTool"),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.decision).toBe("deny");
      expect(parsed.reason).toContain("sudo blocked");
      expect(parsed.reason).toContain("Blocked Bash by failproofai");
      // Crucial: NOT Claude's nested shape
      expect(parsed.hookSpecificOutput).toBeUndefined();
    });

    it("BeforeAgent deny (UserPromptSubmit) → flat {decision:'deny', reason}", async () => {
      registerPolicy("prompt-block", "desc", () => ({ decision: "deny", reason: "bad prompt" }), {
        events: ["UserPromptSubmit"],
      });
      const result = await evaluatePolicies(
        "UserPromptSubmit",
        { prompt: "<bad>" },
        geminiSession("BeforeAgent"),
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.decision).toBe("deny");
      expect(parsed.reason).toContain("bad prompt");
      expect(parsed.hookSpecificOutput).toBeUndefined();
    });

    it("AfterAgent deny (Stop) → {decision:'block', reason} with MANDATORY ACTION REQUIRED prefix", async () => {
      registerPolicy("must-do", "desc", () => ({ decision: "deny", reason: "missing CHANGELOG" }), {
        events: ["Stop"],
      });
      const result = await evaluatePolicies(
        "Stop",
        {},
        geminiSession("AfterAgent"),
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // Gemini's AfterAgent supports "Retry / Halt" via decision: "block"
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("MANDATORY ACTION REQUIRED");
      expect(parsed.reason).toContain("missing CHANGELOG");
    });

    it("instruct on PreToolUse → {hookSpecificOutput:{hookEventName:'BeforeTool', additionalContext}}", async () => {
      registerPolicy("advisor", "desc", () => ({ decision: "instruct", reason: "consider X" }), {
        events: ["PreToolUse"],
      });
      const result = await evaluatePolicies(
        "PreToolUse",
        { tool_name: "Bash" },
        geminiSession("BeforeTool"),
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // hookEventName must be the Gemini event name (not the canonical PreToolUse)
      expect(parsed.hookSpecificOutput.hookEventName).toBe("BeforeTool");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("Instruction from failproofai");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("consider X");
      // Must NOT use Gemini's flat block shape — that's reserved for deny
      expect(parsed.decision).toBeUndefined();
    });

    it("instruct on AfterTool → {hookSpecificOutput:{hookEventName:'AfterTool', additionalContext}}", async () => {
      registerPolicy("after", "desc", () => ({ decision: "instruct", reason: "post note" }), {
        events: ["PostToolUse"],
      });
      const result = await evaluatePolicies(
        "PostToolUse",
        { tool_name: "Read" },
        geminiSession("AfterTool"),
      );
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("AfterTool");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("post note");
    });

    it("instruct on SessionStart → {hookSpecificOutput:{hookEventName:'SessionStart', additionalContext}}", async () => {
      registerPolicy("greet", "desc", () => ({ decision: "instruct", reason: "warm context" }), {
        events: ["SessionStart"],
      });
      const result = await evaluatePolicies(
        "SessionStart",
        {},
        geminiSession("SessionStart"),
      );
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("warm context");
    });

    it("instruct on AfterAgent (Stop) → {decision:'block', reason} with MANDATORY ACTION", async () => {
      registerPolicy("must-do", "desc", () => ({ decision: "instruct", reason: "open the PR" }), {
        events: ["Stop"],
      });
      const result = await evaluatePolicies(
        "Stop",
        {},
        geminiSession("AfterAgent"),
      );
      const parsed = JSON.parse(result.stdout);
      // For Gemini AfterAgent, both deny and instruct map to {decision: "block"} which forces a retry.
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("MANDATORY ACTION REQUIRED");
      expect(parsed.reason).toContain("open the PR");
    });

    it("multiple instruct on AfterAgent → reasons concatenated, single {decision:'block'} response", async () => {
      registerPolicy("a", "desc", () => ({ decision: "instruct", reason: "first" }), { events: ["Stop"] });
      registerPolicy("b", "desc", () => ({ decision: "instruct", reason: "second" }), { events: ["Stop"] });
      const result = await evaluatePolicies(
        "Stop",
        {},
        geminiSession("AfterAgent"),
      );
      const parsed = JSON.parse(result.stdout);
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("first");
      expect(parsed.reason).toContain("second");
    });

    it("instruct on a non-context-injection event (e.g. SessionEnd) → stderr only, no stdout JSON", async () => {
      registerPolicy("byebye", "desc", () => ({ decision: "instruct", reason: "after-note" }), {
        events: ["SessionEnd"],
      });
      const result = await evaluatePolicies(
        "SessionEnd",
        {},
        geminiSession("SessionEnd"),
      );
      // SessionEnd is observation-only on Gemini; we don't emit a stdout JSON shape
      expect(result.stdout).toBe("");
      // Reason still surfaces via stderr for visibility
      expect(result.stderr).toContain("after-note");
    });

    it("allow with informational reason on BeforeAgent → context-injection shape", async () => {
      registerPolicy("info", "desc", () => ({ decision: "allow", reason: "fyi" }), {
        events: ["UserPromptSubmit"],
      });
      const result = await evaluatePolicies(
        "UserPromptSubmit",
        { prompt: "x" },
        geminiSession("BeforeAgent"),
      );
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("BeforeAgent");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("Note from failproofai");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("fyi");
    });

    it("allow with informational reason on SessionEnd → stderr only", async () => {
      registerPolicy("info", "desc", () => ({ decision: "allow", reason: "fyi" }), {
        events: ["SessionEnd"],
      });
      const result = await evaluatePolicies(
        "SessionEnd",
        {},
        geminiSession("SessionEnd"),
      );
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("fyi");
    });

    it("allow without reason → empty stdout, exit 0 (no extra noise)", async () => {
      registerPolicy("ok", "desc", () => ({ decision: "allow" }), { events: ["PreToolUse"] });
      const result = await evaluatePolicies(
        "PreToolUse",
        { tool_name: "Bash" },
        geminiSession("BeforeTool"),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("instruct falls back to session.rawHookEventName when stdin omits hook_event_name", async () => {
      registerPolicy("advisor", "desc", () => ({ decision: "instruct", reason: "consider X" }), {
        events: ["PreToolUse"],
      });
      const result = await evaluatePolicies(
        "PreToolUse",
        { tool_name: "Bash" },
        // session.hookEventName intentionally undefined; rawHookEventName carries
        // the raw CLI --hook arg as captured by handler.ts.
        { sessionId: "g", cwd: "/tmp", cli: "gemini", rawHookEventName: "BeforeTool" },
      );
      const parsed = JSON.parse(result.stdout);
      // Must use the raw Gemini event name, NOT the canonicalized "PreToolUse".
      expect(parsed.hookSpecificOutput.hookEventName).toBe("BeforeTool");
    });

    it("allow-with-context also falls back to session.rawHookEventName", async () => {
      registerPolicy("info", "desc", () => ({ decision: "allow", reason: "fyi" }), {
        events: ["UserPromptSubmit"],
      });
      const result = await evaluatePolicies(
        "UserPromptSubmit",
        { prompt: "x" },
        { sessionId: "g", cwd: "/tmp", cli: "gemini", rawHookEventName: "BeforeAgent" },
      );
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("BeforeAgent");
    });

    it("session.hookEventName from stdin still wins over rawHookEventName when both are set", async () => {
      registerPolicy("advisor", "desc", () => ({ decision: "instruct", reason: "x" }), {
        events: ["PreToolUse"],
      });
      const result = await evaluatePolicies(
        "PreToolUse",
        { tool_name: "Bash" },
        { sessionId: "g", cwd: "/tmp", cli: "gemini", hookEventName: "BeforeTool", rawHookEventName: "RawShouldLose" },
      );
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("BeforeTool");
    });

    it("UserPromptSubmit deny on Gemini emits event-appropriate text (NOT 'Blocked unknown tool')", async () => {
      registerPolicy("prompt-block", "desc", () => ({ decision: "deny", reason: "bad prompt" }), {
        events: ["UserPromptSubmit"],
      });
      const result = await evaluatePolicies(
        "UserPromptSubmit",
        { prompt: "<bad>" },
        geminiSession("BeforeAgent"),
      );
      const parsed = JSON.parse(result.stdout);
      // Without ctx.toolName, the deny message used to say "Blocked unknown tool";
      // now we branch on event type.
      expect(parsed.reason).toMatch(/Blocked prompt/);
      expect(parsed.reason).not.toMatch(/Blocked unknown tool/);
    });

    it("SessionStart deny emits 'Blocked session start' label, not 'unknown tool'", async () => {
      registerPolicy("greet-block", "desc", () => ({ decision: "deny", reason: "no greeting" }), {
        events: ["SessionStart"],
      });
      const result = await evaluatePolicies(
        "SessionStart",
        {},
        geminiSession("SessionStart"),
      );
      const parsed = JSON.parse(result.stdout);
      expect(parsed.reason).toMatch(/Blocked session start/);
      expect(parsed.reason).not.toMatch(/Blocked unknown tool/);
    });
  });
});
