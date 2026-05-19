# AI Failure Handling in Python: Stop Swallowing Errors From LLM Calls

*Target keyword: "ai failure handling python" | LSI: "python ai agent errors", "handle llm exceptions python"*
*Placement: Blog | Word count: ~750 | CTA: npm install*

---

When you call an LLM from Python, a lot can go wrong. Rate limits hit at 2am. Context windows overflow mid-session. Tool calls return malformed JSON that breaks your parser. The model hallucinates a function signature that doesn't exist.

Most Python codebases handle this with a `try/except` wrapped around the API call and a `time.sleep(2)` before retry. That's not AI failure handling — that's hoping the problem goes away.

This post covers what actually fails in production AI agents built with Python, and how to intercept those failures systematically before they become incidents.

## What Actually Fails in Python AI Agents

There are four failure categories that account for the vast majority of python ai agent errors in production:

**1. Transient API errors** — Rate limits (429), timeouts, 500s from the model provider. These are recoverable if your retry logic distinguishes them from hard failures.

**2. Structural tool call failures** — The model invokes a tool with arguments that don't match the schema. Your validator throws, the agent loop either crashes or silently continues with broken state.

**3. Context overflow** — Long agent sessions accumulate context until you hit the token limit. The next call fails, and without a compaction strategy, you restart from scratch.

**4. Runaway loops** — The agent retries the same failing action repeatedly. Without a loop detector, you burn through tokens and hit the rate limit ceiling.

A naive Python implementation handles none of these systematically:

```python
# What most codebases look like
response = client.chat.completions.create(
    model="gpt-4o",
    messages=messages,
    tools=tools
)
# Assume it worked. Proceed.
```

## A Better Approach: Policy-Based Failure Interception

The right mental model for handle llm exceptions python is policies, not ad-hoc try/except blocks. A policy is a named rule that intercepts specific events in the agent lifecycle and decides: allow, block, or instruct.

Here's what that looks like with FailproofAI:

```javascript
// .failproofai/policies/python-agent-guards.js
import { customPolicies, deny, instruct } from "failproofai";

// Catch runaway bash loops before they spiral
customPolicies.add({
  name: "no-repeated-commands",
  match: { events: ["PreToolUse"], tools: ["Bash"] },
  fn: async (ctx) => {
    const cmd = ctx.toolInput?.command;
    const recent = ctx.recentTools?.slice(-5) ?? [];
    if (recent.filter(t => t.input?.command === cmd).length >= 3) {
      return deny(`Command "${cmd}" has been repeated 3+ times. Stop and reassess.`);
    }
    return allow();
  },
});

// Block writes to production paths unless explicitly confirmed
customPolicies.add({
  name: "protect-prod-paths",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    const path = ctx.toolInput?.file_path ?? "";
    if (path.includes("/prod/") || path.includes("production.db")) {
      return deny("Production path detected. Confirm intent before proceeding.");
    }
    return allow();
  },
});
```

Install it once, and these policies fire across every session — no per-call try/except required:

```bash
npm i -g failproofai
failproofai policies --install
```

## The 30 Built-in Policies You Get Immediately

FailproofAI ships 30 policies that activate on install. The ones most relevant to Python AI agents:

| Policy | What it catches |
|---|---|
| `block-rm-rf` | Recursive deletion from agent Bash calls |
| `sanitize-api-keys` | API keys leaking into agent context or logs |
| `detect-loop` | Same tool called repeatedly without progress |
| `block-force-push` | Git operations that could overwrite remote state |
| `require-tests-before-stop` | Agent can't sign off without running tests |

For Python agents specifically, `sanitize-api-keys` is critical — if your agent reads config files or env dumps, you don't want those values appearing in the session transcript.

## Connecting the Dots: Python + FailproofAI

FailproofAI hooks into coding agent CLIs (Claude Code, Codex, Cursor, Gemini CLI, Copilot) at the process level. Your Python agent code runs as it normally would — FailproofAI sits at the agent event layer and intercepts before tool calls execute.

The workflow for a Python dev:

1. Build your agent logic in Python using whatever SDK (openai, anthropic, litellm)
2. Run it through a supported agent CLI
3. FailproofAI intercepts PreToolUse, PostToolUse, and Stop events
4. Policies block dangerous actions and surface actionable errors instead of silent failures

You write Python. FailproofAI handles the ai failure handling in python at the orchestration layer.

## Start Here

```bash
npm i -g failproofai
failproofai policies --install
failproofai
```

Dashboard at `localhost:8020` shows every tool call, every policy trigger, and what the agent was told. No guessing what went wrong at 2am.

→ [All 30 built-in policies](https://docs.befailproof.ai/built-in-policies)
→ [Write your own policies](https://docs.befailproof.ai/custom-policies)
→ [befailproof.ai](https://befailproof.ai)
