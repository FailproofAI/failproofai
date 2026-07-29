// @vitest-environment node
/**
 * Guards the capability matrix that the activity log renders from.
 *
 * The matrix used to be prose in CLAUDE.md, and prose drifted: Hermes
 * `subagent_stop` was documented "✅ block" while upstream discarded its return,
 * so customer policies on that event enforced nothing for months. A table with
 * tests behind it cannot rot the same way.
 */
import { describe, it, expect } from "vitest";
import {
  ENFORCEMENT_CAPABILITY,
  enforcementFor,
} from "@/src/hooks/enforcement-capability";
import { INTEGRATION_TYPES, HOOK_EVENT_TYPES } from "@/src/hooks/types";

describe("ENFORCEMENT_CAPABILITY", () => {
  it("keys every integration", () => {
    for (const cli of INTEGRATION_TYPES) {
      expect(ENFORCEMENT_CAPABILITY[cli]).toBeDefined();
    }
  });

  it("uses only canonical event names", () => {
    const canonical = new Set<string>(HOOK_EVENT_TYPES);
    for (const [cli, events] of Object.entries(ENFORCEMENT_CAPABILITY)) {
      for (const event of Object.keys(events)) {
        expect(canonical.has(event), `${cli}.${event} is not a canonical event`).toBe(true);
      }
    }
  });

  it("uses only block or observe — never a hedge value", () => {
    for (const events of Object.values(ENFORCEMENT_CAPABILITY)) {
      for (const capability of Object.values(events)) {
        expect(["block", "observe"]).toContain(capability);
      }
    }
  });

  // The load-bearing property. Absent must mean "we did not verify this", so a
  // caller can stay silent. If lookup ever defaulted to a value, the UI would
  // assert a capability nobody established — the exact failure being fixed.
  it("returns undefined for an unverified pair rather than guessing", () => {
    expect(enforcementFor("goose", "Stop")).toBeUndefined();
    expect(enforcementFor("hermes", "Stop")).toBeUndefined();
    expect(enforcementFor(undefined, "PreToolUse")).toBeUndefined();
    expect(enforcementFor("claude", undefined)).toBeUndefined();
    expect(enforcementFor("claude", "NotAnEvent")).toBeUndefined();
  });

  it("records the findings that motivated this file", () => {
    // Every CLI we install a tool gate for blocks on PreToolUse — the one
    // capability the daily suite exercises.
    for (const cli of INTEGRATION_TYPES) {
      const pre = ENFORCEMENT_CAPABILITY[cli].PreToolUse;
      if (pre !== undefined) expect(pre).toBe("block");
    }

    // Hermes: only pre_tool_call is gated in upstream's _parse_response among
    // the events we install. (pre_verify is also gated in upstream, but we do
    // not install it, so no Stop event fires.)
    expect(enforcementFor("hermes", "PreToolUse")).toBe("block");
    expect(enforcementFor("hermes", "SessionEnd")).toBe("observe");
    // Documented as a working gate for months; upstream discards the return.
    expect(enforcementFor("hermes", "SubagentStop")).toBe("observe");

    // OpenClaw: three real gates, five void hooks.
    expect(enforcementFor("openclaw", "Stop")).toBe("block");
    expect(enforcementFor("openclaw", "SubagentStop")).toBe("observe");

    // Antigravity: PostToolHookResult is an empty proto message, so our deny is
    // not merely ignored — protojson rejects it and the hook call errors.
    expect(enforcementFor("antigravity", "PostToolUse")).toBe("observe");
  });

  it("never claims WorktreeCreate as a capability", () => {
    // It is a path provider, not a gate: with no stdout an ALLOW aborts
    // worktree creation exactly like a deny. Degenerate, so it is unclassified
    // and we no longer install it.
    for (const events of Object.values(ENFORCEMENT_CAPABILITY)) {
      expect(events.WorktreeCreate).toBeUndefined();
    }
  });
});
