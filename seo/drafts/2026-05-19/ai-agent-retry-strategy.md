# AI Agent Retry Strategy: Why Exponential Backoff Isn't Enough

*Target keyword: "ai agent retry strategy" | LSI: "exponential backoff ai agent", "llm retry logic"*
*Placement: Blog | Word count: ~700 | CTA: npm install*

---

Every LLM SDK ships with retry logic. OpenAI's Python client does exponential backoff on rate limits by default. Anthropic's SDK retries on 529s. Litellm wraps them both.

But those retries only handle network-layer failures. They don't handle the failure mode that actually kills production agents: the agent retrying the *wrong action* in a loop.

## The Two Types of Retries in AI Agents

**Infrastructure retries** handle transient errors — rate limits, timeouts, 5xx responses. Exponential backoff with jitter is the right tool here. Most SDKs do this for you.

**Behavioral retries** are what the *agent* does when a tool call fails — it tries again, with variations. This is where llm retry logic gets complicated, because:

1. The agent doesn't know what "correct" looks like
2. It may retry into an even worse state
3. Without a stopping condition, it loops until it hits token limits or rate limits

A common production scenario: an agent tries to write to a file, fails due to a permission error, rewrites the file path slightly, fails again, tries a different approach, fails, eventually halts at the context limit with nothing done. You get a bill and an empty result.

## What a Real AI Agent Retry Strategy Looks Like

The right retry strategy operates at two layers:

**Layer 1: Infrastructure** — retry on transient API errors, with backoff. Your SDK probably handles this.

**Layer 2: Behavioral** — detect when an agent is looping and intervene before it wastes resources.

Layer 2 requires external policy enforcement. The agent can't reliably detect its own loops — that's the same as asking a confused person to notice they're confused.

## Detecting Loops With Policies

FailproofAI provides a `PreToolUse` hook that fires before every tool call. You can write a policy that tracks recent tool calls and denies execution if the same action is being repeated:

```javascript
// .failproofai/policies/loop-detection.js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "detect-repetitive-commands",
  match: { events: ["PreToolUse"], tools: ["Bash"] },
  fn: async (ctx) => {
    const currentCmd = ctx.toolInput?.command;
    const history = ctx.session?.recentTools ?? [];
    
    // Count occurrences of this exact command in last 10 calls
    const repeats = history
      .slice(-10)
      .filter(t => t.name === "Bash" && t.input?.command === currentCmd)
      .length;
    
    if (repeats >= 2) {
      return deny(
        `This command has been run ${repeats} times without success: "${currentCmd}". ` +
        `Stop retrying and diagnose the root cause.`
      );
    }
    return allow();
  },
});

// Broader pattern: detect any tool being called too often
customPolicies.add({
  name: "detect-tool-saturation",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    const history = ctx.session?.recentTools ?? [];
    const recentSameTool = history
      .slice(-6)
      .filter(t => t.name === ctx.toolName)
      .length;
    
    if (recentSameTool >= 5) {
      return deny(
        `${ctx.toolName} has been called 5 times in the last 6 tool calls. ` +
        `Reassess your approach before continuing.`
      );
    }
    return allow();
  },
});
```

This is what the built-in `detect-loop` policy does — it's one of the 30 policies that activate immediately on install.

## Connecting to Infrastructure Retries

For the network layer, the right exponential backoff ai agent setup uses jitter to avoid thundering herd on rate limits:

```python
import random
import time
from openai import OpenAI, RateLimitError

client = OpenAI()

def call_with_backoff(messages, tools, max_retries=5):
    for attempt in range(max_retries):
        try:
            return client.chat.completions.create(
                model="gpt-4o",
                messages=messages,
                tools=tools,
            )
        except RateLimitError:
            if attempt == max_retries - 1:
                raise
            # Exponential backoff with full jitter
            delay = random.uniform(0, min(60, 2 ** attempt))
            time.sleep(delay)
```

This handles the SDK layer. FailproofAI handles the behavioral layer. Together, you have a complete ai agent retry strategy.

## The Stopping Condition Problem

Retries need a stopping condition. For infrastructure retries, it's max_retries + circuit breaker. For behavioral retries, the stopping condition is a policy that says "you've tried this three times, stop."

Without that policy, the agent's own stopping condition is: context window full, or user cancels, or rate limit hit. All of those are worse than a controlled early exit with a clear error message.

```bash
# Install FailproofAI with loop detection built in
npm i -g failproofai
failproofai policies --install
```

The `detect-loop` built-in policy activates immediately. You can tune its threshold or add your own pattern-specific loop detectors on top.

→ [Built-in policies reference](https://docs.befailproof.ai/built-in-policies)
→ [Custom policies guide](https://docs.befailproof.ai/custom-policies)
→ [befailproof.ai](https://befailproof.ai)
