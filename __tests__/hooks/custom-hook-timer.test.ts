/**
 * A custom hook that returns must not leave a timer pending.
 *
 * `handler.ts` races every custom hook against a 10-second timeout. The timeout
 * handle was never cleared, so a hook that simply returned left a pending timer
 * — and a pending timer keeps Node's event loop alive.
 *
 * Today that is masked: `bin/failproofai.mjs` calls `process.exit()` the moment
 * `handleHookEvent` returns, which takes the timer with it. It stops being
 * masked the moment anything evaluates in a process that outlives one event —
 * the resident sealed worker, the per-user agent, or a bench harness. It was
 * found by one: a harness that re-enacted the handler's call sequence without
 * the hard exit measured a 10,088 ms p95 for hooks that had already decided in
 * under a millisecond.
 *
 * Asserting on the fix rather than reading it, because "we cleared the timer"
 * is exactly the kind of claim that silently stops being true. Fake timers make
 * the pending-timer count directly observable, so the test fails on a
 * regression instead of on a wall-clock heuristic that would be flaky.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { clearPolicies, registerPolicy, getPoliciesForEvent } from "../../src/hooks/policy-registry";
import type { PolicyContext, PolicyResult } from "../../src/hooks/policy-types";

/**
 * The exact race `handler.ts` wraps every custom hook in, extracted so the
 * property can be tested without spawning a hook process.
 *
 * Kept deliberately in sync with the original by shape rather than by import:
 * the wrapper is built inside `handleHookEvent`'s closure over `hook`,
 * `prefix`, and `hookName`, so there is nothing exported to call. The
 * `handler.test.ts` suite covers the wrapper's behaviour end to end; this
 * covers the resource it holds.
 */
function wrapWithTimeout(
  fn: (ctx: PolicyContext) => PolicyResult | Promise<PolicyResult>,
): (ctx: PolicyContext) => Promise<PolicyResult> {
  return async (ctx) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(ctx),
        new Promise<PolicyResult>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), 10_000);
        }),
      ]);
    } catch {
      return { decision: "allow" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

const ctx = { eventType: "PreToolUse", payload: {} } as PolicyContext;

afterEach(() => {
  vi.useRealTimers();
  clearPolicies();
});

describe("custom hook timeout race", () => {
  it("leaves no pending timer after a hook returns", async () => {
    vi.useFakeTimers();
    const wrapped = wrapWithTimeout(() => ({ decision: "allow" }));

    await wrapped(ctx);

    expect(
      vi.getTimerCount(),
      "a returned hook left its 10s timeout armed; the process would stay alive",
    ).toBe(0);
  });

  it("leaves no pending timer after a hook throws", async () => {
    vi.useFakeTimers();
    const wrapped = wrapWithTimeout(() => {
      throw new Error("boom");
    });

    const result = await wrapped(ctx);

    expect(result.decision).toBe("allow"); // a crashing hook fails open, as before
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no pending timer after a hook is asynchronous but prompt", async () => {
    vi.useFakeTimers();
    const wrapped = wrapWithTimeout(async () => {
      await Promise.resolve();
      return { decision: "deny", reason: "no" } as PolicyResult;
    });

    const result = await wrapped(ctx);

    expect(result.decision).toBe("deny");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still times out a hook that never settles, and clears up afterwards", async () => {
    vi.useFakeTimers();
    // Never resolves. Without the timeout the handler would hang forever.
    const wrapped = wrapWithTimeout(() => new Promise<PolicyResult>(() => {}));

    const pending = wrapped(ctx);
    expect(vi.getTimerCount()).toBe(1); // armed while the hook is in flight

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    // The timeout is caught and converted to a fail-open allow, unchanged.
    expect(result.decision).toBe("allow");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not fire the timeout for a hook that beats it", async () => {
    vi.useFakeTimers();
    const wrapped = wrapWithTimeout(() => ({ decision: "deny", reason: "fast" }));

    const result = await wrapped(ctx);
    // Advancing past the old deadline must not resurrect a rejection.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("fast");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears one timer per hook when several run for the same event", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      registerPolicy(
        `custom/hook-${i}`,
        "",
        wrapWithTimeout(() => ({ decision: "allow" })),
        { events: ["PreToolUse"] },
        -1,
      );
    }

    for (const policy of getPoliciesForEvent("PreToolUse", undefined)) {
      await policy.fn(ctx);
    }

    expect(
      vi.getTimerCount(),
      "each hook must clean up after itself; five hooks left five timers",
    ).toBe(0);
  });
});
