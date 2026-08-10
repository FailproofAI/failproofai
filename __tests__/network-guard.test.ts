/**
 * The guard in `__tests__/setup.ts` — the thing standing between a missing test
 * stub and an intermittently-red suite.
 *
 * Tested because a guard nobody exercises is a guard that quietly stops working:
 * an `await` accidentally dropped from the wrapper, or the loopback list edited,
 * would disarm it, every suite would still pass, and the next unstubbed network
 * call would go back to failing one run in two on network weather.
 */
import { describe, it, expect } from "vitest";

describe("the unit-test network guard", () => {
  it("blocks a call to an external host", async () => {
    await expect(fetch("https://be.failproof.ai/v1/auth/introspect")).rejects.toThrow(
      /must not reach the network/,
    );
  });

  it("names the host, so the missing stub is findable", async () => {
    await expect(fetch("https://api.example.com/whatever")).rejects.toThrow(/api\.example\.com/);
  });

  it("rejects rather than throwing synchronously, like real fetch", async () => {
    // A synchronous throw escapes `fetch(…).catch(…)` and crashes the caller
    // instead of being handled — which would make the guard behave unlike the
    // thing it replaces, and turn a diagnostic into a different bug.
    let rejected = false;
    const result = fetch("https://be.failproof.ai/").catch(() => {
      rejected = true;
    });
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(rejected).toBe(true);
  });

  it("lets loopback through, because six suites serve their own fixtures", async () => {
    // Nothing is listening on this port, so this must fail as a CONNECTION
    // error — which is the proof it was allowed through rather than blocked.
    await expect(fetch("http://127.0.0.1:59999/")).rejects.not.toThrow(
      /must not reach the network/,
    );
  });

  it("allows every loopback spelling", async () => {
    for (const url of ["http://localhost:59999/", "http://127.0.0.1:59999/"]) {
      await expect(fetch(url)).rejects.not.toThrow(/must not reach the network/);
    }
  });
});
