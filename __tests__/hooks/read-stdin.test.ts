// @vitest-environment node
/**
 * The hook payload read is on the ENFORCEMENT path — every tool call, on all
 * eleven agent CLIs — and it had no bound at all.
 *
 * Its only early exit was `readableEnded`, which helps only when stdin is
 * ALREADY closed. A parent that spawned the hook with a pipe it had not yet
 * closed left the read unsettled forever — verified directly against a
 * held-open FIFO, where `end` never arrives. A hung hook is the worst outcome
 * available: it does not fail open or closed, it freezes the tool call it was
 * gating, and nothing on our side ever gives up.
 *
 * The streams below never emit `end`, which is exactly what the OS does with a
 * writer that stays open. What is under test is this module's response to
 * that, not the kernel's behaviour.
 *
 * The stream is PASSED IN rather than swapped onto `process.stdin`. Reassigning
 * that globally takes the test runner's own stdin away and kills it mid-run —
 * which is how this file was first written, and it took the whole suite down
 * with no output at all.
 */
import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { readStdinPayload } from "../../src/hooks/read-stdin";

type Stdinish = Parameters<typeof readStdinPayload>[2];

/** A pipe nobody ever closes: data may arrive, `end` never does. */
function neverEnds(chunks: string[] = []): Stdinish {
  const s = new Readable({ read() { /* pushed below; never push(null) */ } });
  for (const c of chunks) s.push(c);
  return s as unknown as Stdinish;
}

describe("reading the hook payload", () => {
  it("returns what was written, once stdin closes", async () => {
    // The path every real tool call takes.
    const r = await readStdinPayload(
      1_048_576,
      5_000,
      Readable.from(['{"tool_name":"Bash"}']) as unknown as Stdinish,
    );
    expect(r.payload).toBe('{"tool_name":"Bash"}');
    expect(r.timedOut).toBe(false);
    expect(r.readError).toBe(false);
  });

  it("gives up when `end` never arrives, instead of waiting forever", async () => {
    // Before this was bounded the promise simply never settled.
    const started = Date.now();
    const r = await readStdinPayload(1_048_576, 200, neverEnds());
    expect(r.timedOut).toBe(true);
    expect(r.payload).toBe("");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not pass off a partial read as a payload", async () => {
    // Half a tool call is not something any policy should be asked to judge,
    // and an empty payload that does not SAY it timed out is indistinguishable
    // from a hook that legitimately received nothing.
    const r = await readStdinPayload(1_048_576, 200, neverEnds(['{"tool_na']));
    expect(r.timedOut).toBe(true);
    expect(r.payload).toBe("");
    expect(r.readError).toBe(false);
  });

  it("does not wait on a terminal at all", async () => {
    // A TTY never ends on its own, so waiting for EOF there is waiting for a
    // person to press ctrl-D — which is what a hand-run `failproofai --hook`
    // used to do. Returns without spending any of the budget.
    const tty = neverEnds() as unknown as { isTTY?: boolean };
    tty.isTTY = true;
    const started = Date.now();
    const r = await readStdinPayload(1_048_576, 10_000, tty as Stdinish);
    expect(r.payload).toBe("");
    expect(r.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("still calls an oversized payload oversized, not a timeout", async () => {
    // The two are reported separately because the remedies differ, and because
    // an oversized read DID hear from the parent.
    const r = await readStdinPayload(100, 5_000, neverEnds(["x".repeat(200)]));
    expect(r.oversized).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.payload).toBe("");
  });
});
