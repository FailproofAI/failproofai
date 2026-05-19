# LLM Tool Call Failures: The Failure Mode Nobody Talks About

*Target keyword: "llm tool call failures" | LSI: "openai function call error", "tool call exception handling"*
*Placement: Blog | Word count: ~800 | CTA: npm install*

---

Tool use (also called function calling) is how modern LLM agents actually do things — read files, run commands, call APIs. It's also one of the most fragile parts of any agent pipeline. And most codebases handle it by hoping it doesn't break.

This is a guide to what actually goes wrong with LLM tool calls, why the standard approaches fail, and what a production-grade approach looks like.

## How Tool Call Failures Manifest

When a model generates a tool call, it produces a JSON blob with a function name and arguments. Your code then executes that function. There are at least five ways this breaks:

**Schema mismatch.** The model generates arguments that don't match your function signature. `required` fields are missing. Wrong types. Fields that don't exist. Your Pydantic model throws a `ValidationError` and the agent either crashes or retries into a loop.

**Hallucinated function names.** The model invokes a function you never defined. This is more common than you'd think, especially if your tool list changes between sessions or the model was fine-tuned on different function schemas.

**Unsafe argument values.** The model generates a valid-schema call with dangerous values — a `file_path` pointing to `/etc/passwd`, a `command` with `rm -rf`, a database query with unescaped user input. Schema validation passes. Your application does something bad.

**Cascading failures.** One tool call fails, returns an error, the model retries with slight variations, fails again, loops. Without a loop detector, you burn tokens and hit rate limits before anything useful happens.

**Silent success with wrong output.** The tool call executes, returns a result, the model proceeds — but the result was garbage. No exception was raised, so nothing flagged it.

```python
# The tool call went through. Did it do the right thing?
result = execute_tool(tool_name, tool_args)
messages.append({"role": "tool", "content": result})
# Assume it's fine. Continue.
```

## Why Try/Except Doesn't Scale

The standard openai function call error handling approach is per-call exception handling:

```python
try:
    result = execute_bash(cmd)
except Exception as e:
    messages.append({"role": "tool", "content": f"Error: {e}"})
    # Hope the model figures it out
```

This works for individual tools in isolation. It doesn't work when:
- You have 20+ tools across a complex agent
- Failures are semantic, not syntactic (valid JSON, bad intent)
- You need audit trails for what the agent actually did
- Multiple agents share the same tool set and policy needs

Tool call exception handling at scale requires a policy layer — rules that fire across all tool calls, not error handling bolted onto each tool individually.

## Policy-Based Tool Call Interception

FailproofAI provides a `PreToolUse` hook that intercepts every tool call before execution. You define policies that inspect the tool name and arguments, then decide: allow, block, or instruct the agent.

```javascript
// .failproofai/policies/tool-call-guards.js
import { customPolicies, deny, instruct, allow } from "failproofai";

// Catch dangerous bash commands before they run
customPolicies.add({
  name: "validate-bash-safety",
  match: { events: ["PreToolUse"], tools: ["Bash"] },
  fn: async (ctx) => {
    const cmd = ctx.toolInput?.command ?? "";
    
    if (/rm\s+-rf/.test(cmd)) {
      return deny("Recursive deletion detected. Use a safer alternative.");
    }
    if (/curl.*\|\s*bash/.test(cmd)) {
      return deny("Pipe-to-bash pattern is not allowed.");
    }
    return allow();
  },
});

// Validate file write paths
customPolicies.add({
  name: "validate-write-paths",
  match: { events: ["PreToolUse"], tools: ["Write", "Edit"] },
  fn: async (ctx) => {
    const path = ctx.toolInput?.file_path ?? "";
    const blocklist = ["/etc/", "/usr/", ".env", "id_rsa"];
    
    for (const blocked of blocklist) {
      if (path.includes(blocked)) {
        return deny(`Write to ${path} is not allowed.`);
      }
    }
    return allow();
  },
});

// Instruct the agent when a tool returns suspicious output
customPolicies.add({
  name: "flag-large-deletions",
  match: { events: ["PostToolUse"], tools: ["Bash"] },
  fn: async (ctx) => {
    const output = ctx.toolResponse?.output ?? "";
    if (output.includes("removed") && output.split("\n").length > 50) {
      return instruct("You deleted more than 50 files. Confirm this was intentional before continuing.");
    }
    return allow();
  },
});
```

## The Three Decisions Available to Every Policy

Every policy has three options:

| Decision | What happens |
|---|---|
| `allow()` | Tool call proceeds normally |
| `deny(message)` | Tool call is blocked. Message goes back to the agent as an error. |
| `instruct(message)` | Tool call proceeds, but agent gets additional context in its next prompt |

`deny` is for hard stops. `instruct` is for soft guidance — you want the agent to know something happened without blocking progress.

## Getting Started

Install FailproofAI and you get 30 built-in policies immediately, including `block-rm-rf`, `sanitize-api-keys`, and `detect-loop`. The custom policy layer is additive — your policies run alongside the built-ins.

```bash
npm i -g failproofai
failproofai policies --install
```

Every tool call your agent makes is logged. The dashboard at `localhost:8020` shows what ran, what was blocked, and what policy fired — so you're not debugging blind.

→ [Built-in policies reference](https://docs.befailproof.ai/built-in-policies)
→ [Custom policies guide](https://docs.befailproof.ai/custom-policies)
→ [befailproof.ai](https://befailproof.ai)
