// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createInstructRetryGate,
  mapBeforeToolVerdict,
} from "../../openclaw-plugin/instruct-retry-gate.js";

describe("OpenClaw instruct retry gate", () => {
  it("interrupts the first instruction and permits retries during the window", () => {
    let now = 1_000;
    const gate = createInstructRetryGate({ windowMs: 300_000, now: () => now });
    const verdict = {
      permission: "instruct",
      reason: "recover once",
      policyName: "failproofai/warn-invoice-self-resolution",
    };
    const ctx = { sessionKey: "invoice-session" };

    expect(gate.shouldInterrupt(verdict, {}, ctx)).toBe(true);
    expect(gate.shouldInterrupt(verdict, {}, ctx)).toBe(false);

    now += 300_001;
    expect(gate.shouldInterrupt(verdict, {}, ctx)).toBe(true);
  });

  it("keeps sessions and policies independent", () => {
    const gate = createInstructRetryGate();
    const invoice = { permission: "instruct", reason: "recover", policyName: "invoice" };
    const security = { permission: "instruct", reason: "review", policyName: "security" };

    expect(gate.shouldInterrupt(invoice, {}, { sessionKey: "one" })).toBe(true);
    expect(gate.shouldInterrupt(invoice, {}, { sessionKey: "one" })).toBe(false);
    expect(gate.shouldInterrupt(security, {}, { sessionKey: "one" })).toBe(true);
    expect(gate.shouldInterrupt(invoice, {}, { sessionKey: "two" })).toBe(true);
  });

  it("keeps separate OpenClaw runs independent within one session", () => {
    const gate = createInstructRetryGate();
    const verdict = { permission: "instruct", reason: "recover", policyName: "invoice" };

    expect(gate.shouldInterrupt(verdict, {}, { sessionKey: "one", runId: "run-a" })).toBe(true);
    expect(gate.shouldInterrupt(verdict, {}, { sessionKey: "one", runId: "run-a" })).toBe(false);
    expect(gate.shouldInterrupt(verdict, {}, { sessionKey: "one", runId: "run-b" })).toBe(true);
  });

  it("does not share a retry window between anonymous invocations", () => {
    const gate = createInstructRetryGate();
    const verdict = { permission: "instruct", reason: "recover", policyName: "invoice" };

    expect(gate.shouldInterrupt(verdict, {}, {})).toBe(true);
    expect(gate.shouldInterrupt(verdict, {}, {})).toBe(true);
  });

  it("clears the retry window when the session ends", () => {
    const gate = createInstructRetryGate();
    const verdict = { permission: "instruct", reason: "recover", policyName: "invoice" };
    const ctx = { sessionKey: "invoice-session", runId: "invoice-run" };

    expect(gate.shouldInterrupt(verdict, {}, ctx)).toBe(true);
    expect(gate.shouldInterrupt(verdict, {}, ctx)).toBe(false);
    gate.clear({}, { sessionKey: "invoice-session" });
    expect(gate.shouldInterrupt(verdict, {}, ctx)).toBe(true);
  });

  it("maps deny permanently and instruct to a one-shot model-visible rejection", () => {
    const gate = createInstructRetryGate();
    const ctx = { sessionKey: "invoice-session" };
    const deny = { permission: "deny", reason: "never send this" };
    const instruct = {
      permission: "instruct",
      reason: "perform one more recovery pass",
      policyName: "invoice",
    };

    expect(mapBeforeToolVerdict(deny, {}, ctx, gate)).toEqual({
      block: true,
      blockReason: "never send this",
    });
    expect(mapBeforeToolVerdict(deny, {}, ctx, gate)).toEqual({
      block: true,
      blockReason: "never send this",
    });
    expect(mapBeforeToolVerdict(instruct, {}, ctx, gate)).toEqual({
      block: true,
      blockReason: "perform one more recovery pass",
    });
    expect(mapBeforeToolVerdict(instruct, {}, ctx, gate)).toBeUndefined();
    expect(mapBeforeToolVerdict({ permission: "allow" }, {}, ctx, gate)).toBeUndefined();
  });
});
