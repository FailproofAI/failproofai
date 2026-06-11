// @vitest-environment node
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  tryAcquireRun,
  releaseRun,
  finishRun,
  getRunState,
} from "../../app/api/audit/_state";

describe("audit run-lock state", () => {
  beforeEach(() => {
    // Belt-and-suspenders: tests share module state, so always reset first.
    releaseRun();
    vi.useRealTimers();
  });

  afterEach(() => {
    releaseRun();
    vi.useRealTimers();
  });

  it("the first tryAcquireRun wins and the second fails", () => {
    expect(tryAcquireRun()).toBe(true);
    expect(tryAcquireRun()).toBe(false);
    expect(getRunState().running).toBe(true);
  });

  it("releaseRun lets the next caller acquire", () => {
    expect(tryAcquireRun()).toBe(true);
    releaseRun();
    expect(tryAcquireRun()).toBe(true);
  });

  it("finishRun records the run's error and clears running", () => {
    expect(tryAcquireRun()).toBe(true);
    finishRun("scan blew up");
    const s = getRunState();
    expect(s.running).toBe(false);
    expect(s.startedAt).toBeUndefined();
    expect(s.error).toBe("scan blew up");
  });

  it("finishRun(null) clears a prior error", () => {
    tryAcquireRun();
    finishRun("scan blew up");
    expect(getRunState().error).toBe("scan blew up");
    finishRun(null);
    expect(getRunState().error).toBeNull();
  });

  it("a fresh tryAcquireRun clears the prior run's error", () => {
    tryAcquireRun();
    finishRun("scan blew up");
    expect(getRunState().error).toBe("scan blew up");
    // The lock is free again, so the next run acquires and starts clean.
    expect(tryAcquireRun()).toBe(true);
    expect(getRunState().error).toBeNull();
  });

  it("never auto-expires the lock, even across a large time jump", () => {
    // The old behavior released a lock older than 5 min; we removed that so a
    // long but healthy run is never mistaken for a wedged one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T00:00:00Z"));
    expect(tryAcquireRun()).toBe(true);
    // Jump an hour into the future — far past the old 5-min expiry window.
    vi.setSystemTime(new Date(Date.now() + 60 * 60_000));
    expect(getRunState().running).toBe(true);
    expect(tryAcquireRun()).toBe(false);
  });

  it("releaseRun on an unheld lock is a no-op", () => {
    releaseRun();
    releaseRun();
    expect(getRunState().running).toBe(false);
  });
});
