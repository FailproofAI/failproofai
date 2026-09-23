// @vitest-environment node
/**
 * The warm worker's wedge deadline, across the release the two-tier path added.
 *
 * A task that never settles holds the process-global policy registry this
 * queue exists to serialize, so the worker exits and the supervisor respawns a
 * clean one. A two-tier task hands its place in the queue back early
 * (`releaseRegistry`) at the point it stops reading the registry and starts
 * waiting on Jev — and the deadline used to be simply CLEARED there, so from
 * that moment on nothing was watching it: a task wedged after the release
 * (a stuck activity write, a wedged store) kept its connection's later replies
 * queued behind it forever, with no exit and no respawn.
 *
 * `runQueuedTask` is `enqueue`'s body, exported so the deadlines can be driven
 * without waiting a minute or exiting the test runner.
 */
import { describe, it, expect, vi } from "vitest";
import { runQueuedTask } from "../../src/hooks/worker-server";

/** A promise plus the handles to settle it, for a task that finishes on command. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res as () => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const after = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs one task under short deadlines, recording every wedge instead of exiting. */
function run(task: (release: () => void) => Promise<void>, opts: { taskMs?: number; releasedMs?: number } = {}) {
  const wedged: Array<{ ms: number; released: boolean }> = [];
  const settled: number[] = [];
  let settles = 0;
  runQueuedTask(task, () => settled.push(++settles), {
    taskMs: opts.taskMs ?? 40,
    releasedMs: opts.releasedMs ?? 40,
    onWedged: (ms, released) => wedged.push({ ms, released }),
  });
  return { wedged, settled };
}

describe("a task that hands the queue back keeps a deadline of its own", () => {
  it("wedges after the release: the deadline still fires, and says it was released", async () => {
    const never = deferred();
    const { wedged, settled } = run(async (release) => {
      release();
      await never.promise;
    });
    // The queue moved on the moment it released…
    await after(10);
    expect(settled).toEqual([1]);
    expect(wedged).toEqual([]);
    // …and the task is still watched.
    await after(70);
    expect(wedged).toEqual([{ ms: 40, released: true }]);
    never.resolve();
    await never.promise;
  });

  it("releases and then finishes in time: nothing fires", async () => {
    const done = deferred();
    const { wedged, settled } = run(async (release) => {
      release();
      await done.promise;
    });
    await after(10);
    done.resolve();
    await done.promise;
    await after(70);
    expect(wedged).toEqual([]);
    // Settled once at the release; finishing does not start the next task twice.
    expect(settled).toEqual([1]);
  });

  it("a released task that rejects is a finish, not a wedge", async () => {
    const failed = deferred();
    const { wedged } = run(async (release) => {
      release();
      await failed.promise;
    });
    failed.reject(new Error("activity write failed"));
    await failed.promise.catch(() => {});
    await after(70);
    expect(wedged).toEqual([]);
  });

  it("a release after the task finished re-arms nothing", async () => {
    let release!: () => void;
    const { wedged, settled } = run(async (r) => {
      release = r;
    });
    await after(10);
    expect(settled).toEqual([1]);
    release();
    await after(70);
    expect(wedged).toEqual([]);
    expect(settled).toEqual([1]);
  });
});

describe("a task that never releases is watched exactly as before", () => {
  it("wedges at the task deadline", async () => {
    const never = deferred();
    const { wedged, settled } = run(async () => {
      await never.promise;
    });
    await after(70);
    expect(wedged).toEqual([{ ms: 40, released: false }]);
    expect(settled).toEqual([]);
    never.resolve();
    await never.promise;
  });

  it("finishing inside it fires nothing", async () => {
    const { wedged, settled } = run(async () => {
      await after(5);
    });
    await after(70);
    expect(wedged).toEqual([]);
    expect(settled).toEqual([1]);
  });

  it("a task that throws synchronously settles the queue and fires nothing", async () => {
    const { wedged, settled } = run(async () => {
      throw new Error("bad request");
    });
    await after(70);
    expect(wedged).toEqual([]);
    expect(settled).toEqual([1]);
  });
});

describe("the default deadlines", () => {
  it("are minutes, not milliseconds: a normal task is never touched", async () => {
    const wedged = vi.fn();
    let settles = 0;
    runQueuedTask(
      async (release) => {
        release();
        await after(5);
      },
      () => settles++,
      { onWedged: wedged },
    );
    await after(40);
    expect(wedged).not.toHaveBeenCalled();
    expect(settles).toBe(1);
  });
});
