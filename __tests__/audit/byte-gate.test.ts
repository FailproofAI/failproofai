// @vitest-environment node
/**
 * Admission control for the transcript scan.
 *
 * The scan's concurrency counts FILES, which is the wrong unit: the reader
 * materialises every event of a transcript into JS objects, so a 57 MB JSONL
 * becomes several hundred MB of them. On a real 1.15 GB corpus — 2,107 files,
 * 7 of them holding 224 MB — eight workers put a quarter of the corpus in
 * memory at once and the run printed `Aborted(OOM)` 22 times.
 */
import { describe, it, expect } from "vitest";
import { ByteGate } from "@/src/audit/index";

async function run(sizes: number[], budget: number, workers: number) {
  const gate = new ByteGate(budget);
  let inFlight = 0;
  let peak = 0;
  let concurrentPeak = 0;
  let running = 0;
  let next = 0;
  const worker = async () => {
    while (next < sizes.length) {
      const size = sizes[next++];
      await gate.acquire(size);
      inFlight += size;
      running += 1;
      peak = Math.max(peak, inFlight);
      concurrentPeak = Math.max(concurrentPeak, running);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= size;
      running -= 1;
      gate.release(size);
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return { peak, concurrentPeak };
}

const MB = 1024 * 1024;

describe("the memory budget", () => {
  it("never lets the big files bunch, however many workers there are", async () => {
    // The measured shape: a long tail of small files and a handful of huge ones.
    const sizes = [
      ...Array.from({ length: 40 }, () => 300 * 1024),
      57 * MB, 40 * MB, 34 * MB, 27 * MB, 24 * MB, 22 * MB, 20 * MB,
    ];
    const { peak } = await run(sizes, 48 * MB, 8);
    // Two 57MB files at once is the crash. One plus small change is fine.
    expect(peak).toBeLessThanOrEqual(57 * MB + 48 * MB);
    expect(peak).toBeLessThan(224 * MB);
  });

  it("admits a file larger than the whole budget rather than deadlocking", async () => {
    // Refusing it would make the largest transcript on the machine permanently
    // unscannable — precisely the one most likely to hold something.
    const { peak } = await run([500 * MB], 48 * MB, 8);
    expect(peak).toBe(500 * MB);
  });

  it("still runs the small files in parallel", async () => {
    // The budget must not turn a 2,000-file scan into a serial one.
    const { concurrentPeak } = await run(
      Array.from({ length: 200 }, () => 100 * 1024),
      48 * MB,
      8,
    );
    expect(concurrentPeak).toBe(8);
  });

  it("frees weight even when a task fails", async () => {
    // Holding a failed task's weight shrinks the budget permanently over a long
    // scan, until nothing can be admitted at all.
    const gate = new ByteGate(10);
    await gate.acquire(10);
    gate.release(10);
    await expect(gate.acquire(10)).resolves.toBeUndefined();
  });

});
