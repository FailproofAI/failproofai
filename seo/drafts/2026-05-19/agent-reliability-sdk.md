# What to Look for in an Agent Reliability SDK

*Target keyword: "agent reliability sdk" | LSI: "ai agent monitoring", "llm output validation"*
*Placement: Blog | Word count: ~850 | CTA: npm install*

---

The term "agent reliability" covers a lot of ground. At the infrastructure layer, it means retry logic and rate limit handling. At the application layer, it means the agent actually does what you asked without breaking something else.

Most developers have the infrastructure layer covered — OpenAI's SDK retries rate limits, Anthropic's client handles 529s. The application layer is where things break in production, and where most teams have no tooling at all.

This is a guide to what an agent reliability SDK should actually do, and what to look for when choosing one.

## What "Reliability" Means for an AI Agent

For a traditional service, reliability is availability — it responds to requests within SLA. For an AI agent, reliability has three additional dimensions that availability doesn't capture:

**Safety** — The agent doesn't take destructive actions. It doesn't delete the wrong files, push to the wrong branch, or leak credentials into the session transcript.

**Correctness** — The agent's outputs actually satisfy the task. This is the hardest one to measure and the one most SDKs don't touch.

**Auditability** — You can reconstruct what the agent did, in what order, and why. Without this, debugging and compliance are guesswork.

An ai agent monitoring tool that only tracks uptime is measuring the wrong thing.

## The Four Capabilities an Agent Reliability SDK Needs

### 1. Pre-Execution Interception

The SDK must be able to inspect a tool call *before* it executes and decide whether to allow it. Post-execution monitoring tells you what went wrong. Pre-execution interception prevents it.

This is the difference between `sanitize-api-keys` (which intercepts before a credential leaks into context) and log scrubbing (which catches it after it's already in the transcript).

### 2. LLM Output Validation

The agent's text outputs and tool call arguments need to be validated against your schema. Not just syntactic validation (is this valid JSON?) but semantic validation (does this match what I asked for?).

llm output validation is hard because LLM outputs are probabilistic — the model might generate a valid-schema tool call with wrong values, or a reasonable-sounding response that contradicts earlier context. A good reliability SDK makes it possible to write policies that catch semantic mismatches.

### 3. Session Observability

Every tool call, every policy trigger, every agent decision needs to be logged in a queryable format. Not just for debugging — for compliance, for auditing AI actions in regulated environments, and for improving your policies over time.

The session log should answer: what did the agent do, in what order, and what did each policy say about it?

### 4. Policy Composability

You need to write your own rules for your own systems. A locked-down policy set that only covers the vendor's use cases isn't useful for a team with specific security requirements, specific prohibited paths, or specific compliance rules.

The policy system should be programmable and testable, not just a settings toggle.

## What FailproofAI Provides

FailproofAI is a policy-based reliability layer for coding agents (Claude Code, Codex, Cursor, Gemini CLI, Copilot, OpenCode, Pi). Install once, and it adds all four capabilities described above.

**Pre-execution interception** via `PreToolUse` hooks:

```javascript
import { customPolicies, deny, allow } from "failproofai";

// Block writes to infrastructure files
customPolicies.add({
  name: "protect-infra",
  match: { events: ["PreToolUse"], tools: ["Write", "Edit"] },
  fn: async (ctx) => {
    const path = ctx.toolInput?.file_path ?? "";
    if (path.startsWith("infra/") || path.endsWith(".tf")) {
      return deny("Infrastructure files require a separate review workflow.");
    }
    return allow();
  },
});
```

**LLM output validation** via `PostToolUse` hooks:

```javascript
// Flag when agent writes to files it shouldn't have context about
customPolicies.add({
  name: "validate-write-scope",
  match: { events: ["PostToolUse"], tools: ["Write"] },
  fn: async (ctx) => {
    const written = ctx.toolResponse?.path ?? "";
    const taskScope = ctx.session?.taskContext?.scope ?? [];
    
    if (taskScope.length > 0 && !taskScope.some(s => written.startsWith(s))) {
      return instruct(
        `You wrote to ${written}, which is outside the task scope. ` +
        `Verify this was intentional.`
      );
    }
    return allow();
  },
});
```

**Session observability** via the local dashboard at `localhost:8020` — every tool call logged with timing, policy outcomes, and agent responses.

**Policy composability** via a JavaScript policy API. Your policies live in `.failproofai/policies/` and are committed with your project, so the whole team gets them on next pull.

## The 30 Built-In Policies as a Starting Point

Rather than building from zero, FailproofAI ships 30 policies covering the most common failure modes:

| Capability | Policies |
|---|---|
| Safety | `block-rm-rf`, `block-force-push`, `sanitize-api-keys`, `block-work-on-main` |
| Correctness | `require-tests-before-stop`, `detect-loop` |
| Auditability | Session logging, policy trigger log, agent response log |

You extend this baseline with your own policies for your specific environment.

## Getting Started

```bash
npm i -g failproofai
failproofai policies --install
failproofai
```

30 built-in policies activate immediately. The dashboard starts at `localhost:8020`. Add your own policies to `.failproofai/policies/` — they're picked up automatically on the next session.

FailproofAI works with Claude Code, Codex, Cursor, GitHub Copilot CLI, OpenCode, Pi, and Gemini CLI. No SDK changes required in your agent code.

→ [Built-in policies](https://docs.befailproof.ai/built-in-policies)
→ [Custom policies](https://docs.befailproof.ai/custom-policies)
→ [Architecture](https://docs.befailproof.ai/architecture)
→ [befailproof.ai](https://befailproof.ai)
