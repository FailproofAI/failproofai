// @vitest-environment node
/**
 * Direct byte-level coverage for `encodeResponse` — the seam between running
 * policies and speaking each vendor's native hook protocol.
 *
 * `evaluatePolicies` is `encodeResponse(await evaluateVerdicts(...))`, and
 * every other test in the suite drives the pair through that public wrapper.
 * This file drives `encodeResponse` on its own with hand-built `VerdictSet`
 * values, because a caller that evaluates policies in more than one place
 * (merging several verdict sets before encoding a single response) reaches the
 * encoder without ever going through `evaluatePolicies`. That path needs its
 * own guarantee.
 *
 * Every expected string below was captured from the evaluator BEFORE the
 * split, so a drift here is a real change in what a CLI receives — not a
 * refactor artifact. The twelve response matrices are mutually incompatible
 * and each was verified against a live vendor build (see the per-branch
 * comments in policy-evaluator.ts); "semantically equivalent" is not a thing
 * here, so these assertions are on exact bytes.
 *
 * The matrix is keyed off `INTEGRATION_TYPES` rather than a literal list, so
 * a thirteenth CLI fails loudly instead of silently going untested.
 */
import { describe, it, expect } from "vitest";
import { encodeResponse } from "../../src/hooks/policy-evaluator";
import type { VerdictSet, EvaluationResult } from "../../src/hooks/policy-evaluator";
import { INTEGRATION_TYPES } from "../../src/hooks/types";
import type { IntegrationType, SessionMetadata } from "../../src/hooks/types";

const POLICY = "test/p";
const DENY_REASON = "nope";
const INSTRUCT_REASON = "do the thing";

// The four message bodies the matrix is built from. Kept as named constants so
// a reworded template fails every affected cell at once rather than one.
const BLOCKED_BASH = `Blocked Bash by failproofai because: ${DENY_REASON}, as per the policy configured by the user`;
const BLOCKED_STOP = `Blocked stop by failproofai because: ${DENY_REASON}, as per the policy configured by the user`;
const MANDATORY_DENY = `MANDATORY ACTION REQUIRED from failproofai (policy: ${POLICY}): ${DENY_REASON}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
const INSTRUCTION = `Instruction from failproofai: ${INSTRUCT_REASON}`;
const INSTRUCT_NOTE = `[failproofai] ${POLICY}: ${INSTRUCT_REASON}\n`;

function session(cli: IntegrationType): SessionMetadata {
  return { sessionId: "s", transcriptPath: "/dev/null", cwd: "/workspace", cli };
}

/** A short-circuited deny, exactly as `evaluateVerdicts` returns one. */
function denyVerdicts(toolName?: string): VerdictSet {
  return {
    deny: { policyName: POLICY, reason: DENY_REASON },
    instructEntries: [],
    allowEntries: [],
    matchedCount: 1,
    toolName,
  };
}

/** One instruct, no deny — the accumulating (non-short-circuiting) path. */
function instructVerdicts(toolName?: string): VerdictSet {
  return {
    deny: null,
    instructEntries: [{ policyName: POLICY, reason: INSTRUCT_REASON }],
    allowEntries: [],
    matchedCount: 1,
    toolName,
  };
}

/** Policies ran and every one allowed without a message. */
function silentAllowVerdicts(toolName?: string): VerdictSet {
  return { deny: null, instructEntries: [], allowEntries: [], matchedCount: 1, toolName };
}

type Wire = Pick<EvaluationResult, "exitCode" | "stdout" | "stderr" | "decision" | "policyName" | "reason">;

function wire(result: EvaluationResult): Wire {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    decision: result.decision,
    policyName: result.policyName,
    reason: result.reason,
  };
}

const SILENT_ALLOW: Wire = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  decision: "allow",
  policyName: null,
  reason: null,
};

// Claude's own shapes, reused by every CLI with no branch of its own.
const CLAUDE_DENY_PRETOOLUSE: Wire = {
  exitCode: 0,
  stdout: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"${BLOCKED_BASH}"}}`,
  stderr: "",
  decision: "deny",
  policyName: POLICY,
  reason: DENY_REASON,
};
const CLAUDE_DENY_STOP: Wire = {
  exitCode: 2,
  stdout: "",
  stderr: MANDATORY_DENY,
  decision: "deny",
  policyName: POLICY,
  reason: DENY_REASON,
};
const CLAUDE_INSTRUCT_PROMPT: Wire = {
  exitCode: 0,
  stdout: `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"${INSTRUCTION}"}}`,
  stderr: "",
  decision: "instruct",
  policyName: POLICY,
  reason: INSTRUCT_REASON,
};

/** An instruct that has no channel on this CLI: allow + a note on stderr. */
const DEGRADED_INSTRUCT: Wire = {
  exitCode: 0,
  stdout: "",
  stderr: INSTRUCT_NOTE,
  decision: "instruct",
  policyName: POLICY,
  reason: INSTRUCT_REASON,
};

function deny(stdout: string, exitCode = 0, stderr = ""): Wire {
  return { exitCode, stdout, stderr, decision: "deny", policyName: POLICY, reason: DENY_REASON };
}
function instruct(stdout: string, stderr = ""): Wire {
  return { exitCode: 0, stdout, stderr, decision: "instruct", policyName: POLICY, reason: INSTRUCT_REASON };
}

interface Cell {
  denyPreToolUse: Wire;
  denyStop: Wire;
  instructUserPromptSubmit: Wire;
  silentAllow: Wire;
}

// Typed as a total map over IntegrationType: a thirteenth CLI is a tsc error
// here, and the coverage assertion below turns it into a test failure too.
const MATRIX: Record<IntegrationType, Cell> = {
  // Claude: the reference contract the encoder falls back to.
  claude: {
    denyPreToolUse: CLAUDE_DENY_PRETOOLUSE,
    denyStop: CLAUDE_DENY_STOP,
    instructUserPromptSubmit: CLAUDE_INSTRUCT_PROMPT,
    silentAllow: SILENT_ALLOW,
  },
  // Codex: Claude-shaped for all three of these; its own branch is
  // PermissionRequest only.
  codex: {
    denyPreToolUse: CLAUDE_DENY_PRETOOLUSE,
    denyStop: CLAUDE_DENY_STOP,
    instructUserPromptSubmit: CLAUDE_INSTRUCT_PROMPT,
    silentAllow: SILENT_ALLOW,
  },
  // Copilot: exit 2 is never a deny channel; Stop needs {decision:"block"}.
  copilot: {
    denyPreToolUse: CLAUDE_DENY_PRETOOLUSE,
    denyStop: deny(`{"decision":"block","reason":${JSON.stringify(MANDATORY_DENY)}}`),
    instructUserPromptSubmit: CLAUDE_INSTRUCT_PROMPT,
    silentAllow: SILENT_ALLOW,
  },
  // Cursor: flat {permission,user_message,agent_message}; Stop is
  // {followup_message}, the only force-retry channel it honors.
  cursor: {
    denyPreToolUse: deny(
      `{"permission":"deny","user_message":"${BLOCKED_BASH}","agent_message":"${BLOCKED_BASH}"}`,
    ),
    denyStop: deny(`{"followup_message":${JSON.stringify(MANDATORY_DENY)}}`),
    instructUserPromptSubmit: instruct(`{"permission":"allow","additional_context":"${INSTRUCTION}"}`),
    silentAllow: SILENT_ALLOW,
  },
  // OpenCode: Stop is notification-only, so the deny rides as
  // additionalContext for the shim to re-submit via client.session.prompt.
  opencode: {
    denyPreToolUse: CLAUDE_DENY_PRETOOLUSE,
    denyStop: deny(`{"hookSpecificOutput":{"additionalContext":${JSON.stringify(MANDATORY_DENY)}}}`),
    instructUserPromptSubmit: CLAUDE_INSTRUCT_PROMPT,
    silentAllow: SILENT_ALLOW,
  },
  // Pi: flat {permission,reason} everywhere; Stop reuses the deny shape so the
  // shim can stash it for next-turn before_agent_start injection.
  pi: {
    denyPreToolUse: deny(`{"permission":"deny","reason":"${BLOCKED_BASH}"}`),
    denyStop: deny(`{"permission":"deny","reason":${JSON.stringify(MANDATORY_DENY)}}`),
    instructUserPromptSubmit: instruct(`{"permission":"allow","reason":"${INSTRUCTION}"}`),
    silentAllow: SILENT_ALLOW,
  },
  // Hermes: one {decision:"block"} shape for every event (it ignores exit
  // codes), and no Stop event at all — so a Stop deny is the plain blocked
  // message with the "stop" noun, not the MANDATORY wording.
  hermes: {
    denyPreToolUse: deny(`{"decision":"block","reason":"${BLOCKED_BASH}"}`),
    denyStop: deny(`{"decision":"block","reason":"${BLOCKED_STOP}"}`),
    instructUserPromptSubmit: instruct(
      `{"decision":"allow","reason":"${INSTRUCTION}"}`,
      INSTRUCT_NOTE,
    ),
    silentAllow: SILENT_ALLOW,
  },
  // OpenClaw: flat {permission,reason}; Stop maps to {action:"revise"} in the
  // shim, so it carries the MANDATORY wording.
  openclaw: {
    denyPreToolUse: deny(`{"permission":"deny","reason":"${BLOCKED_BASH}"}`),
    denyStop: deny(`{"permission":"deny","reason":${JSON.stringify(MANDATORY_DENY)}}`),
    instructUserPromptSubmit: instruct(
      `{"permission":"allow","reason":"${INSTRUCTION}"}`,
      INSTRUCT_NOTE,
    ),
    silentAllow: SILENT_ALLOW,
  },
  // Factory droid: blocking is exit 2 + stderr on every event EXCEPT Stop,
  // where exit-2 is not a force-retry and JSON is.
  factory: {
    denyPreToolUse: deny("", 2, BLOCKED_BASH + "\n"),
    denyStop: deny(`{"decision":"block","reason":${JSON.stringify(MANDATORY_DENY)}}`),
    instructUserPromptSubmit: DEGRADED_INSTRUCT,
    silentAllow: SILENT_ALLOW,
  },
  // Devin: {decision:"block"} at exit 0 for every event; instruct falls
  // through to the generic Claude additionalContext path.
  devin: {
    denyPreToolUse: deny(`{"decision":"block","reason":"${BLOCKED_BASH}"}`),
    denyStop: deny(`{"decision":"block","reason":${JSON.stringify(MANDATORY_DENY)}}`),
    instructUserPromptSubmit: CLAUDE_INSTRUCT_PROMPT,
    silentAllow: SILENT_ALLOW,
  },
  // Antigravity: its own verbs — "deny" to block, "continue" to re-enter the
  // loop, and injectSteps for prompt-time instruction.
  antigravity: {
    denyPreToolUse: deny(`{"decision":"deny","reason":"${BLOCKED_BASH}"}`),
    denyStop: deny(`{"decision":"continue","reason":${JSON.stringify(MANDATORY_DENY)}}`),
    instructUserPromptSubmit: instruct(
      `{"injectSteps":[{"ephemeralMessage":"${INSTRUCTION}"}]}`,
    ),
    silentAllow: SILENT_ALLOW,
  },
  // Goose: one {decision:"block"} shape (honored on PreToolUse only) and no
  // Stop event, so a Stop deny gets the "stop" noun like Hermes.
  goose: {
    denyPreToolUse: deny(`{"decision":"block","reason":"${BLOCKED_BASH}"}`),
    denyStop: deny(`{"decision":"block","reason":"${BLOCKED_STOP}"}`),
    instructUserPromptSubmit: DEGRADED_INSTRUCT,
    silentAllow: SILENT_ALLOW,
  },
};

describe("hooks/encode-response", () => {
  it("covers every integration in INTEGRATION_TYPES", () => {
    // Derived, never hardcoded: adding a CLI without adding its response
    // matrix must fail here rather than ship an unencoded verdict.
    expect(Object.keys(MATRIX).sort()).toEqual([...INTEGRATION_TYPES].sort());
    expect(Object.keys(MATRIX)).toHaveLength(INTEGRATION_TYPES.length);
  });

  describe.each([...INTEGRATION_TYPES])("%s", (cli) => {
    const expected = MATRIX[cli];

    it("encodes a PreToolUse deny", () => {
      expect(wire(encodeResponse(denyVerdicts("Bash"), "PreToolUse", session(cli)))).toEqual(
        expected.denyPreToolUse,
      );
    });

    it("encodes a Stop deny", () => {
      // No tool_name on a Stop payload, so the deny noun comes from the event.
      expect(wire(encodeResponse(denyVerdicts(undefined), "Stop", session(cli)))).toEqual(
        expected.denyStop,
      );
    });

    it("encodes a UserPromptSubmit instruct", () => {
      const result = encodeResponse(instructVerdicts(undefined), "UserPromptSubmit", session(cli));
      expect(wire(result)).toEqual(expected.instructUserPromptSubmit);
      expect(result.policyNames).toEqual([POLICY]);
    });

    it("encodes a silent allow", () => {
      expect(wire(encodeResponse(silentAllowVerdicts("Bash"), "PreToolUse", session(cli)))).toEqual(
        expected.silentAllow,
      );
    });
  });

  it("falls back to the Claude shapes when no session cli is known", () => {
    expect(wire(encodeResponse(denyVerdicts("Bash"), "PreToolUse"))).toEqual(CLAUDE_DENY_PRETOOLUSE);
    expect(wire(encodeResponse(denyVerdicts(undefined), "Stop"))).toEqual(CLAUDE_DENY_STOP);
    expect(wire(encodeResponse(instructVerdicts(undefined), "UserPromptSubmit"))).toEqual(
      CLAUDE_INSTRUCT_PROMPT,
    );
  });

  it("returns the silent allow when no policy matched at all", () => {
    // matchedCount 0 is the zero-policy early return: identical bytes to a run
    // where every policy allowed without a message, on every CLI.
    const empty: VerdictSet = {
      deny: null,
      instructEntries: [],
      allowEntries: [],
      matchedCount: 0,
      toolName: "Bash",
    };
    for (const cli of INTEGRATION_TYPES) {
      expect(wire(encodeResponse(empty, "PreToolUse", session(cli)))).toEqual(SILENT_ALLOW);
    }
    expect(wire(encodeResponse(empty, "PreToolUse"))).toEqual(SILENT_ALLOW);
  });

  it("picks the deny noun from the event when there is no tool name", () => {
    // Tool events name the tool; non-tool events get an event-appropriate
    // noun so the message is never "Blocked unknown tool by failproofai".
    const nouns: Array<[string, string]> = [
      ["UserPromptSubmit", "prompt"],
      ["SessionStart", "session start"],
      ["SessionEnd", "session end"],
      ["PreCompact", "operation"],
    ];
    for (const [eventType, noun] of nouns) {
      const result = encodeResponse(
        denyVerdicts(undefined),
        eventType as Parameters<typeof encodeResponse>[1],
        session("hermes"),
      );
      expect(result.stdout).toBe(
        `{"decision":"block","reason":"Blocked ${noun} by failproofai because: ${DENY_REASON}, as per the policy configured by the user"}`,
      );
    }
    // A tool name always wins over the event-derived noun.
    const withTool = encodeResponse(denyVerdicts("Write"), "Stop", session("hermes"));
    expect(withTool.stdout).toBe(
      `{"decision":"block","reason":"Blocked Write by failproofai because: ${DENY_REASON}, as per the policy configured by the user"}`,
    );
  });

  it("merges several verdict sets into one encoded response", () => {
    // The reason the seam exists: verdicts accumulated from more than one
    // evaluation pass encode as if they had come from a single loop.
    const merged: VerdictSet = {
      deny: null,
      instructEntries: [
        { policyName: "sealed/one", reason: "first" },
        { policyName: "user/two", reason: "second" },
      ],
      allowEntries: [],
      matchedCount: 2,
    };
    const result = encodeResponse(merged, "UserPromptSubmit", session("claude"));
    expect(result.stdout).toBe(
      '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Instruction from failproofai: first\\nsecond"}}',
    );
    expect(result.policyName).toBe("sealed/one");
    expect(result.policyNames).toEqual(["sealed/one", "user/two"]);
    expect(result.reason).toBe("first\nsecond");

    // A deny in either set still short-circuits the encoded response.
    const withDeny: VerdictSet = { ...merged, deny: { policyName: "sealed/one", reason: DENY_REASON } };
    expect(wire(encodeResponse(withDeny, "PreToolUse", session("claude")))).toEqual({
      ...CLAUDE_DENY_PRETOOLUSE,
      stdout: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked operation by failproofai because: ${DENY_REASON}, as per the policy configured by the user"}}`,
      policyName: "sealed/one",
    });
  });

  it("carries allow-with-reason notes only where there is a channel for them", () => {
    const notes: VerdictSet = {
      deny: null,
      instructEntries: [],
      allowEntries: [{ policyName: POLICY, reason: "fyi" }],
      matchedCount: 1,
      toolName: "Bash",
    };
    const preToolUse = encodeResponse(notes, "PreToolUse", session("claude"));
    expect(preToolUse.stdout).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Note from failproofai: fyi"}}',
    );
    expect(preToolUse.stderr).toBe(`[failproofai] ${POLICY}: fyi\n`);

    // Stop has no additional-context channel, so the note stays off stdout.
    const stop = encodeResponse({ ...notes, toolName: undefined }, "Stop", session("claude"));
    expect(stop.stdout).toBe("");
    expect(stop.stderr).toBe(`[failproofai] ${POLICY}: fyi\n`);
    expect(stop.decision).toBe("allow");
  });
});
