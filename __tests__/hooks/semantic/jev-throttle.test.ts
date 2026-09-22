// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { JevError, type JevTransport } from "../../../src/hooks/semantic/jev-client";
import {
  DEFAULT_THROTTLE,
  MAX_CACHED_ENTRY_CHARS,
  isCachedJevResponse,
  jevRequestDigest,
  jevThrottleStats,
  resetJevThrottle,
  throttleTransport,
} from "../../../src/hooks/semantic/jev-throttle";
import { evaluateSemantic } from "../../../src/hooks/semantic/evaluator";
import type { JevRequest, JevResponse } from "../../../src/hooks/semantic/types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function request(command: string, extra: Record<string, unknown> = {}): JevRequest {
  return {
    model: "jev-1.13.0",
    state: { agent_request: { tool: "Bash", input: { command } }, user_said: ["tidy the repo"], ...extra },
    questions: {
      "destroy.target": { type: "noul", instructions: "Does it delete files?" } as never,
      "intent.op_requested": { type: "noul", instructions: "Did the human ask for it?" } as never,
    },
  };
}

function answerFor(req: JevRequest, p = 0.1): JevResponse {
  const answers: JevResponse["answers"] = {};
  for (const id of Object.keys(req.questions)) answers[id] = { type: "noul", noul: p };
  return { model: req.model, answers, usage: { input_tokens: 321 } };
}

/** A transport that records every call and answers with `respond`. */
function fakeTransport(respond: (req: JevRequest, call: number) => JevResponse | Promise<JevResponse> = (r) => answerFor(r)) {
  const calls: JevRequest[] = [];
  const transport: JevTransport = async (req) => {
    calls.push(req);
    return respond(req, calls.length);
  };
  return { transport, calls };
}

/** A manually advanced monotonic clock. */
function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const live = () => new AbortController().signal;

beforeEach(() => resetJevThrottle());

// ── Cache ────────────────────────────────────────────────────────────────────

describe("jev-throttle: cache", () => {
  it("passes a first request through and returns the transport's own response object", async () => {
    const original = answerFor(request("ls"));
    const { transport, calls } = fakeTransport(() => original);
    const out = await throttleTransport(transport)(request("ls"), live());
    expect(out).toBe(original);
    expect(calls).toHaveLength(1);
    expect(isCachedJevResponse(out)).toBe(false);
  });

  it("serves an identical request from the cache without calling the transport", async () => {
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport);
    const first = await t(request("rm -rf build"), live());
    const second = await t(request("rm -rf build"), live());
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(isCachedJevResponse(second)).toBe(true);
    expect(jevThrottleStats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  it("hands out a fresh copy per hit: a caller mutating its response cannot poison the next", async () => {
    const { transport } = fakeTransport();
    const t = throttleTransport(transport);
    const first = await t(request("ls"), live());
    first.answers["destroy.target"].noul = 0.99; // the caller's own object, after it was cached
    const hit1 = await t(request("ls"), live());
    hit1.answers["destroy.target"].noul = 0.5;
    const hit2 = await t(request("ls"), live());
    expect(hit1.answers["destroy.target"].noul).toBe(0.5);
    expect(hit2.answers["destroy.target"].noul).toBe(0.1);
  });

  it("misses when anything in the request differs: state, a question, the model, or the scope", async () => {
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { ratePerSec: 1_000 });
    await t(request("ls"), live());
    await t(request("ls "), live());
    await t(request("ls", { facts: { git_branch: "main" } }), live());
    await t({ ...request("ls"), model: "jev-1.13.1" }, live());
    const extraQ = request("ls");
    extraQ.questions["scope.beyond_task"] = { type: "noul", instructions: "Beyond the task?" } as never;
    await t(extraQ, live());
    await throttleTransport(transport, { scope: "cloudflare:typesafe/jev", ratePerSec: 1_000 })(request("ls"), live());
    expect(calls).toHaveLength(6);
    expect(jevThrottleStats().hits).toBe(0);
  });

  it("keys on the SHA-256 of the scope and the full serialized request", () => {
    const req = request("git status");
    const expected = createHash("sha256").update("").update("\0").update(JSON.stringify(req)).digest("hex");
    expect(jevRequestDigest(req)).toBe(expected);
    expect(jevRequestDigest(req)).toMatch(/^[0-9a-f]{64}$/);
    expect(jevRequestDigest(req, "a")).not.toBe(jevRequestDigest(req, "b"));
  });

  it("is shared by every wrapper in the process (a new wrapper per hook event still hits)", async () => {
    const { transport, calls } = fakeTransport();
    await throttleTransport(transport)(request("ls"), live());
    const out = await throttleTransport(transport)(request("ls"), live());
    expect(calls).toHaveLength(1);
    expect(isCachedJevResponse(out)).toBe(true);
  });

  it("expires an answer after the TTL, counted from the fetch; a hit never extends it", async () => {
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { cacheTtlMs: 1_000, now: clock.now });
    await t(request("ls"), live());
    clock.advance(600);
    await t(request("ls"), live()); // hit at 600 ms
    clock.advance(399);
    await t(request("ls"), live()); // hit at 999 ms
    expect(calls).toHaveLength(1);
    clock.advance(1);
    await t(request("ls"), live()); // 1000 ms after the fetch: expired
    expect(calls).toHaveLength(2);
    expect(jevThrottleStats()).toMatchObject({ hits: 2, misses: 2 });
  });

  it("defaults to a five-minute TTL", async () => {
    expect(DEFAULT_THROTTLE.cacheTtlMs).toBe(300_000);
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { now: clock.now });
    await t(request("ls"), live());
    clock.advance(299_999);
    await t(request("ls"), live());
    expect(calls).toHaveLength(1);
    clock.advance(1);
    await t(request("ls"), live());
    expect(calls).toHaveLength(2);
  });

  it("is off when the TTL or the entry bound is zero", async () => {
    for (const opts of [{ cacheTtlMs: 0 }, { cacheMaxEntries: 0 }]) {
      resetJevThrottle();
      const { transport, calls } = fakeTransport();
      const t = throttleTransport(transport, opts);
      await t(request("ls"), live());
      await t(request("ls"), live());
      expect(calls).toHaveLength(2);
      expect(jevThrottleStats()).toMatchObject({ hits: 0, misses: 0, entries: 0 });
    }
  });

  it("never caches an incomplete or out-of-range answer, but still returns it unchanged", async () => {
    const bad: JevResponse[] = [
      { model: "jev-1.13.0", answers: { "destroy.target": { noul: 0.2 } } }, // one question missing
      { model: "jev-1.13.0", answers: { "destroy.target": { noul: 1.5 }, "intent.op_requested": { noul: 0.1 } } },
      { model: "jev-1.13.0", answers: { "destroy.target": { noul: Number.NaN }, "intent.op_requested": { noul: 0.1 } } },
      { model: "jev-1.13.0", answers: null as never },
    ];
    for (const response of bad) {
      resetJevThrottle();
      const { transport, calls } = fakeTransport(() => response);
      const t = throttleTransport(transport, { ratePerSec: 100 });
      expect(await t(request("ls"), live())).toBe(response);
      await t(request("ls"), live());
      expect(calls).toHaveLength(2);
      expect(jevThrottleStats().entries).toBe(0);
    }
  });
});

// ── Bounds ───────────────────────────────────────────────────────────────────

describe("jev-throttle: no unbounded growth", () => {
  it("evicts the least recently used entry past the entry bound", async () => {
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { cacheMaxEntries: 3, ratePerSec: 1_000 });
    for (const c of ["a", "b", "c"]) await t(request(c), live());
    await t(request("a"), live()); // touch a: b is now the oldest
    await t(request("d"), live()); // evicts b
    expect(jevThrottleStats()).toMatchObject({ entries: 3, evictions: 1 });
    const before = calls.length;
    await t(request("a"), live());
    await t(request("c"), live());
    await t(request("d"), live());
    expect(calls.length).toBe(before); // a, c, d still cached
    await t(request("b"), live());
    expect(calls.length).toBe(before + 1); // b was evicted
  });

  it("stays within the default entry bound however many distinct requests arrive", async () => {
    const clock = fakeClock();
    const { transport } = fakeTransport();
    const t = throttleTransport(transport, { now: clock.now });
    for (let i = 0; i < 5_000; i++) {
      clock.advance(200); // one token per call at the default 5 req/s
      await t(request(`echo ${i}`), live());
    }
    const stats = jevThrottleStats();
    expect(stats.entries).toBe(DEFAULT_THROTTLE.cacheMaxEntries);
    expect(stats.rateLimited).toBe(0);
    expect(stats.chars).toBeLessThanOrEqual(DEFAULT_THROTTLE.cacheMaxBytes);
  });

  it("stays within the size bound and skips an answer too big to keep", async () => {
    const { transport } = fakeTransport();
    const oneEntry = (() => {
      const r = request("x0");
      return jevRequestDigest(r).length + JSON.stringify(answerFor(r)).length;
    })();
    const t = throttleTransport(transport, { cacheMaxBytes: oneEntry * 2 + 10, ratePerSec: 1_000 });
    for (let i = 0; i < 10; i++) await t(request(`x${i}`), live());
    expect(jevThrottleStats().entries).toBe(2);
    expect(jevThrottleStats().chars).toBeLessThanOrEqual(oneEntry * 2 + 10);

    resetJevThrottle();
    const huge = fakeTransport((r) => ({ ...answerFor(r), padding: "p".repeat(MAX_CACHED_ENTRY_CHARS) }) as JevResponse);
    const th = throttleTransport(huge.transport, { ratePerSec: 1_000 });
    await th(request("ls"), live());
    await th(request("ls"), live());
    expect(huge.calls).toHaveLength(2);
    expect(jevThrottleStats().entries).toBe(0);
  });

  it("drops expired entries as new ones arrive", async () => {
    const clock = fakeClock();
    const { transport } = fakeTransport();
    const t = throttleTransport(transport, { cacheTtlMs: 100, now: clock.now, ratePerSec: 1_000 });
    for (let i = 0; i < 20; i++) await t(request(`old ${i}`), live());
    clock.advance(200);
    await t(request("new"), live());
    expect(jevThrottleStats()).toMatchObject({ entries: 1, evictions: 0 });
  });
});

// ── Token bucket ─────────────────────────────────────────────────────────────

describe("jev-throttle: token bucket", () => {
  async function rejection(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (err) {
      return err;
    }
    throw new Error("expected a rejection");
  }

  it("defaults to 5 req/s with a burst of 5, then refuses with JevError('rate-limited')", async () => {
    expect(DEFAULT_THROTTLE.ratePerSec).toBe(5);
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { now: clock.now });
    for (let i = 0; i < 5; i++) await t(request(`c${i}`), live());
    const err = await rejection(t(request("c5"), live()));
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).code).toBe("rate-limited");
    expect(calls).toHaveLength(5);
    expect(jevThrottleStats().rateLimited).toBe(1);
  });

  it("refills at the configured rate and never beyond the burst", async () => {
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { ratePerSec: 10, burst: 2, now: clock.now });
    await t(request("a"), live());
    await t(request("b"), live());
    expect(((await rejection(t(request("c"), live()))) as JevError).code).toBe("rate-limited");
    clock.advance(99);
    expect(((await rejection(t(request("c"), live()))) as JevError).code).toBe("rate-limited");
    clock.advance(1); // 100 ms at 10/s = one token
    await t(request("c"), live());
    expect(((await rejection(t(request("d"), live()))) as JevError).code).toBe("rate-limited");
    clock.advance(60_000); // a long idle refills to the burst, not to 600
    await t(request("d"), live());
    await t(request("e"), live());
    expect(((await rejection(t(request("f"), live()))) as JevError).code).toBe("rate-limited");
    expect(calls.map((r) => (r.state.agent_request as { input: { command: string } }).input.command)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("does not spend tokens on cache hits", async () => {
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { ratePerSec: 1, burst: 1, now: clock.now });
    await t(request("ls"), live());
    for (let i = 0; i < 20; i++) await t(request("ls"), live());
    expect(calls).toHaveLength(1);
    expect(((await rejection(t(request("pwd"), live()))) as JevError).code).toBe("rate-limited");
  });

  it("empties the bucket when the provider answers 429, then recovers at the normal rate", async () => {
    const clock = fakeClock();
    const limited = new JevError("http-429", "Too Many Requests");
    const { transport, calls } = fakeTransport((r, n) => {
      if (n === 1) throw limited;
      return answerFor(r);
    });
    const t = throttleTransport(transport, { ratePerSec: 5, burst: 5, now: clock.now });
    expect(await rejection(t(request("a"), live()))).toBe(limited);
    expect(((await rejection(t(request("b"), live()))) as JevError).code).toBe("rate-limited");
    expect(calls).toHaveLength(1);
    clock.advance(200);
    await t(request("b"), live());
    expect(calls).toHaveLength(2);
  });

  it("with maxWaitMs, waits for the next token instead of refusing", async () => {
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { ratePerSec: 25, burst: 1, maxWaitMs: 200 }); // a token every 40 ms
    const started = performance.now();
    await t(request("a"), live());
    await t(request("b"), live());
    await t(request("c"), live());
    expect(calls).toHaveLength(3);
    expect(performance.now() - started).toBeGreaterThanOrEqual(60);
    expect(jevThrottleStats().rateLimited).toBe(0);
  });

  it("with maxWaitMs, still refuses when the wait would be longer", async () => {
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { ratePerSec: 1, burst: 1, maxWaitMs: 50 });
    await t(request("a"), live());
    expect(((await rejection(t(request("b"), live()))) as JevError).code).toBe("rate-limited");
    expect(calls).toHaveLength(1);
  });

  it("falls back to the defaults for invalid options", async () => {
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, {
      ratePerSec: Number.NaN,
      burst: -3,
      maxWaitMs: -1,
      cacheTtlMs: Number.POSITIVE_INFINITY,
      cacheMaxEntries: -5,
      now: clock.now,
    });
    for (let i = 0; i < 5; i++) await t(request(`c${i}`), live());
    expect(((await rejection(t(request("c5"), live()))) as JevError).code).toBe("rate-limited");
    await t(request("c0"), live()); // cache still on with the default TTL and bound
    expect(calls).toHaveLength(5);
  });
});

// ── Errors and abort ─────────────────────────────────────────────────────────

describe("jev-throttle: errors and abort", () => {
  it("rethrows the transport's own error object and never caches it", async () => {
    const errors = [new JevError("http-500", "HTTP 500"), new JevError("timeout", "slow"), new TypeError("boom")];
    for (const thrown of errors) {
      resetJevThrottle();
      let n = 0;
      const t = throttleTransport(
        async (r) => {
          n++;
          if (n === 1) throw thrown;
          return answerFor(r);
        },
        { ratePerSec: 100 },
      );
      let caught: unknown;
      try {
        await t(request("ls"), live());
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(thrown);
      const retry = await t(request("ls"), live());
      expect(n).toBe(2);
      expect(isCachedJevResponse(retry)).toBe(false);
      expect(jevThrottleStats().upstreamErrors).toBe(1);
    }
  });

  it("refuses an already-aborted signal without the cache, the bucket or the transport", async () => {
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { ratePerSec: 1, burst: 1, now: clock.now });
    await t(request("ls"), live()); // cached, and the only token spent

    const aborted = new AbortController();
    aborted.abort();
    const err = await t(request("ls"), aborted.signal).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).code).toBe("aborted");
    expect(jevThrottleStats().hits).toBe(0);

    const timedOut = await t(request("pwd"), AbortSignal.abort(new DOMException("t", "TimeoutError"))).then(
      () => null,
      (e: unknown) => e,
    );
    expect((timedOut as JevError).code).toBe("timeout");
    expect(calls).toHaveLength(1);
  });

  it("stops waiting for a token when the signal aborts, and gives the slot back", async () => {
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { ratePerSec: 2, burst: 1, maxWaitMs: 5_000 });
    await t(request("a"), live());
    const ctl = new AbortController();
    const waiting = t(request("b"), ctl.signal);
    setTimeout(() => ctl.abort(), 10);
    const err = await waiting.then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as JevError).code).toBe("aborted");
    expect(calls).toHaveLength(1);
    // The refunded slot is the next one (~500 ms out), so an immediate call still waits for it rather than a later one.
    const next = throttleTransport(transport, { ratePerSec: 2, burst: 1, maxWaitMs: 0 });
    const refused = await next(request("c"), live()).then(
      () => null,
      (e: unknown) => e,
    );
    expect((refused as JevError).code).toBe("rate-limited");
    expect((refused as JevError).message).toMatch(/next slot in (4\d\d|500) ms/);
  });

  it("does not throw on its own when a caller passes no signal", async () => {
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { ratePerSec: 20, burst: 1, maxWaitMs: 200 });
    await t(request("a"), undefined as never);
    await t(request("b"), undefined as never); // waits ~50 ms for its token, with nothing to listen to
    expect(await t(request("a"), undefined as never)).toEqual(answerFor(request("a")));
    expect(calls).toHaveLength(2);
  });

  it("never throws on its own for a request it cannot key: it goes upstream uncached", async () => {
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { ratePerSec: 100 });
    const cyclic = request("ls");
    (cyclic.state as Record<string, unknown>).self = cyclic.state;
    await t(cyclic, live());
    await t(cyclic, live());
    expect(calls).toHaveLength(2);
    expect(jevThrottleStats().entries).toBe(0);
  });
});

// ── Through the evaluator ────────────────────────────────────────────────────

describe("jev-throttle: through evaluateSemantic", () => {
  const input = {
    eventType: "PreToolUse",
    toolName: "Bash",
    toolInput: { command: "rm -rf ./build" },
    cwd: "/work/repo",
    userSaid: ["clean the build output"],
  };

  it("a rate-limited call degrades with reason 'rate-limited', so the caller falls back to regex", async () => {
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport, { ratePerSec: 1, burst: 1, now: clock.now });
    const first = await evaluateSemantic(input, { transport: t });
    expect(first.status).toBe("ok");
    const other = await evaluateSemantic({ ...input, toolInput: { command: "rm -rf ./dist" } }, { transport: t });
    expect(other).toMatchObject({ status: "degraded", reason: "rate-limited" });
    expect(calls).toHaveLength(1);
  });

  it("a repeated call is answered from the cache with the same verdict", async () => {
    const { transport, calls } = fakeTransport();
    const t = throttleTransport(transport);
    const first = await evaluateSemantic(input, { transport: t });
    const again = await evaluateSemantic(input, { transport: t });
    expect(calls).toHaveLength(1);
    expect(first.status).toBe("ok");
    expect(again.status).toBe("ok");
    if (first.status === "ok" && again.status === "ok") {
      expect(again.verdict).toEqual(first.verdict);
      expect(again.answers).toEqual(first.answers);
    }
  });
});
