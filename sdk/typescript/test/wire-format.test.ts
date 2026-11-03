import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setEnvironment } from "../src/environment.js";
import * as schema from "../src/schema.js";

/**
 * The wire format, frozen.
 *
 * These assertions exist to FAIL when somebody reorders a field or renames one,
 * because the other end of this pipe is a Rust daemon, an ingest endpoint whose
 * dedup key hashes the canonical payload, and a Python SDK writing into the
 * same directories. None of those three will tell us when we drift; this file
 * is the only thing that will.
 *
 * Key ORDER is asserted, not just membership. The identity block comes first,
 * then `environment`, then the declared optionals that were supplied, then the
 * caller's extras — the same order `failproofai_sdk/_schema.py` produces.
 */

const IDENTITY = {
  timestamp: "2026-01-01T00:00:00.000000Z",
  sessionId: "s1",
  agentId: "main",
} as const;

describe("event wire format", () => {
  beforeEach(() => {
    setEnvironment("test-env");
  });
  afterEach(() => {
    setEnvironment(null);
  });

  it("puts the identity block first, then environment, then optionals, then extras", () => {
    const event = schema.toolUseEvent({
      ...IDENTITY,
      toolName: "search",
      toolCallId: "c1",
      input: { q: "kites" },
      extraFields: { fw_run_id: "r1" },
    });
    expect(Object.keys(event)).toEqual([
      "timestamp",
      "session_id",
      "agent_id",
      "type",
      "tool_name",
      "tool_call_id",
      "environment",
      "input",
      "fw_run_id",
    ]);
    expect(event).toEqual({
      timestamp: "2026-01-01T00:00:00.000000Z",
      session_id: "s1",
      agent_id: "main",
      type: "tool_use",
      tool_name: "search",
      tool_call_id: "c1",
      environment: "test-env",
      input: { q: "kites" },
      fw_run_id: "r1",
    });
  });

  it("omits an optional that was not supplied rather than writing null", () => {
    const event = schema.toolResultEvent({ ...IDENTITY, toolName: "s", toolCallId: "c1" });
    expect(Object.keys(event)).toEqual([
      "timestamp",
      "session_id",
      "agent_id",
      "type",
      "tool_name",
      "tool_call_id",
      "environment",
    ]);
    expect("output" in event).toBe(false);
    expect("duration_ms" in event).toBe(false);
  });

  it("treats null and undefined identically for optionals", () => {
    const withNull = schema.agentEndEvent({ ...IDENTITY, outcome: null, summary: null });
    const withUndefined = schema.agentEndEvent({ ...IDENTITY });
    expect(withNull).toEqual(withUndefined);
  });

  it("appends request_id LAST on model events, so older events are byte-identical", () => {
    const withoutRequestId = schema.modelResponseEvent({ ...IDENTITY, model: "m", role: "assistant" });
    const withRequestId = schema.modelResponseEvent({
      ...IDENTITY,
      model: "m",
      role: "assistant",
      requestId: "r1",
    });
    expect(Object.keys(withRequestId)).toEqual([...Object.keys(withoutRequestId), "request_id"]);
    expect(JSON.stringify(withRequestId).startsWith(JSON.stringify(withoutRequestId).slice(0, -1))).toBe(
      true,
    );
  });

  it("lets extras override nothing that is declared — they are merged last by design", () => {
    // This is the hazard `guardExtras` and the reserved-name check exist for:
    // the schema itself does NOT protect the declared field.
    const event = schema.toolUseEvent({
      ...IDENTITY,
      toolName: "declared",
      toolCallId: "c1",
      extraFields: { tool_name: "overwritten" },
    });
    expect(event.tool_name).toBe("overwritten");
  });

  it("covers all 15 event types with the type discriminator the server reads", () => {
    const types = [
      schema.toolUseEvent({ ...IDENTITY, toolName: "t", toolCallId: "c" }),
      schema.toolResultEvent({ ...IDENTITY, toolName: "t", toolCallId: "c" }),
      schema.modelRequestEvent({ ...IDENTITY }),
      schema.modelResponseEvent({ ...IDENTITY }),
      schema.agentStartEvent({ ...IDENTITY }),
      schema.agentEndEvent({ ...IDENTITY }),
      schema.agentPauseEvent({ ...IDENTITY, pauseId: "p" }),
      schema.agentResumeEvent({ ...IDENTITY, pauseId: "p" }),
      schema.hookTriggeredEvent({ ...IDENTITY, hookName: "h", hookId: "h1" }),
      schema.hookCompletedEvent({ ...IDENTITY, hookName: "h", hookId: "h1" }),
      schema.errorEvent({ ...IDENTITY, errorType: "E", message: "m" }),
      schema.humanWaitEvent({ ...IDENTITY, inputId: "i" }),
      schema.humanInputEvent({ ...IDENTITY, inputId: "i" }),
      schema.humanPauseEvent({ ...IDENTITY }),
      schema.humanInterruptEvent({ ...IDENTITY }),
    ].map((event) => event.type);

    expect(types).toEqual([
      "tool_use",
      "tool_result",
      "model_request",
      "model_response",
      "agent_start",
      "agent_end",
      "agent_pause",
      "agent_resume",
      "hook_triggered",
      "hook_completed",
      "error",
      "human_wait",
      "human_input",
      "human_pause",
      "human_interrupt",
    ]);
  });

  it("names every declared field, so integrations/core.ts cannot hold a stale copy", () => {
    // `DECLARED_FIELD_NAMES` drives `FORBIDDEN_EXTRAS`. A field added above and
    // missing here is a field an adapter could silently overwrite.
    const declared = new Set<string>();
    const identity = { ...IDENTITY };
    const builders = [
      schema.toolUseEvent({ ...identity, toolName: "t", toolCallId: "c", input: {} }),
      schema.toolResultEvent({
        ...identity,
        toolName: "t",
        toolCallId: "c",
        output: 1,
        error: "e",
        durationMs: 1,
      }),
      schema.modelRequestEvent({
        ...identity,
        model: "m",
        messages: [],
        system: "s",
        tools: [],
        requestId: "r",
      }),
      schema.modelResponseEvent({
        ...identity,
        model: "m",
        stopReason: "s",
        inputTokens: 1,
        outputTokens: 1,
        content: "c",
        role: "assistant",
        requestId: "r",
      }),
      schema.agentStartEvent({ ...identity, goal: "g", parentId: "p" }),
      schema.agentEndEvent({ ...identity, outcome: "success", summary: "s" }),
      schema.agentPauseEvent({ ...identity, pauseId: "p", reason: "r", userId: "u" }),
      schema.agentResumeEvent({ ...identity, pauseId: "p", durationMs: 1, reason: "r", userId: "u" }),
      schema.hookTriggeredEvent({
        ...identity,
        hookName: "h",
        hookId: "h",
        triggerEvent: "t",
        input: 1,
      }),
      schema.hookCompletedEvent({
        ...identity,
        hookName: "h",
        hookId: "h",
        outcome: "o",
        output: 1,
        error: "e",
        durationMs: 1,
      }),
      schema.errorEvent({ ...identity, errorType: "E", message: "m", traceback: "t" }),
      schema.humanWaitEvent({ ...identity, inputId: "i", prompt: "p", options: ["a"], reason: "r" }),
      schema.humanInputEvent({ ...identity, inputId: "i", response: "r", durationMs: 1 }),
      schema.humanPauseEvent({ ...identity, reason: "r", userId: "u" }),
      schema.humanInterruptEvent({ ...identity, reason: "r", userId: "u", atStep: "s" }),
    ];
    for (const event of builders) for (const key of Object.keys(event)) declared.add(key);

    expect([...declared].sort()).toEqual([...schema.DECLARED_FIELD_NAMES].sort());
  });
});
