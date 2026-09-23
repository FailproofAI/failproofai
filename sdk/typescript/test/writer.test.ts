import { statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLogger } from "../src/logger.js";
import { runtime } from "../src/runtime.js";
import {
  EventWriter,
  approxSize,
  capFields,
  encodeEntry,
  roll,
  sanitize,
  scrubSurrogates,
  validatedInterval,
} from "../src/writer.js";
import { indexUrl, runNode, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

let spool: Spool;

beforeEach(() => {
  spool = useSpool();
});
afterEach(async () => {
  await spool.cleanup();
  setLogger(null);
});

describe("flush interval validation", () => {
  it("refuses a value the timer cannot run on, at the boundary", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validatedInterval(bad)).toThrow(/finite number greater than zero/);
    }
    expect(validatedInterval(0.25)).toBe(0.25);
  });

  it("leaves the writer on its old interval when a new one is rejected", () => {
    const writer = new EventWriter(0.5);
    try {
      expect(() => writer.setFlushInterval(-1)).toThrow();
      expect(writer.getFlushInterval()).toBe(0.5);
    } finally {
      writer.close();
    }
  });
});

describe("durability", () => {
  it("publishes .jsonl files, never leaving a .tmp behind", async () => {
    runtime.event.agentStart({ sessionId: "s" });
    await runtime.writer.flushNow();
    expect(spool.files()).toHaveLength(1);
    expect(spool.files()[0]).toMatch(/^event-.*-\d+-\d+\.jsonl$/);
  });

  it("names each batch uniquely, so two in the same millisecond cannot overwrite", async () => {
    runtime.event.agentStart({ sessionId: "s" });
    await runtime.writer.flushNow();
    runtime.event.agentStart({ sessionId: "s" });
    await runtime.writer.flushNow();
    const files = spool.files();
    expect(new Set(files).size).toBe(2);
    // The pid is in the stem so unrelated processes sharing one spool root
    // cannot collide either.
    for (const name of files) expect(name).toContain(`-${process.pid}-`);
  });

  it("writes 0600 batches inside a 0700 directory", async () => {
    runtime.event.agentStart({ sessionId: "s" });
    await runtime.writer.flushNow();
    const eventsDir = join(spool.dir, "events");
    expect(statSync(eventsDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(eventsDir, spool.files()[0]!)).mode & 0o777).toBe(0o600);
  });

  it("flushNow() writes an event emitted while another flush was already writing", async () => {
    // The interval timer (or a second caller) can be mid-write when you call
    // `flush()`. That flush drained the queue BEFORE this event arrived, so
    // returning it — what flushNow() used to do — resolved with the newest
    // event still in memory, breaking "resolves once your events are on disk"
    // for exactly the emit-flush-exit script it exists for.
    runtime.event.agentStart({ sessionId: "s" });
    const alreadyWriting = runtime.writer.flushNow();
    runtime.event.agentEnd({ sessionId: "s" });
    await runtime.writer.flushNow();
    expect(spool.events().map((e) => e.type)).toEqual(["agent_start", "agent_end"]);
    await alreadyWriting;
  });

  it("ends every batch file with a newline, as the collector's line reader expects", async () => {
    runtime.event.agentStart({ sessionId: "s" });
    await runtime.writer.flushNow();
    const raw = spool.lines();
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0]!)).toMatchObject({ type: "agent_start" });
  });
});

describe("encoding isolation", () => {
  it("drops ONE unencodable event rather than the batch around it", async () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

    runtime.event.agentStart({ sessionId: "s", fw_before: 1 });
    runtime.event.agentStart({ sessionId: "s", fw_cycle: circular });
    runtime.event.agentStart({ sessionId: "s", fw_after: 1 });
    await runtime.writer.flushNow();

    const events = spool.events();
    expect(events).toHaveLength(3);
    // The cyclic one is still published — sanitized, not dropped.
    expect(events[1]!.fw_cycle).toEqual({ name: "loop", self: "<circular reference>" });
  });

  it("sanitizes a cycle rather than failing the event", () => {
    const node: Record<string, unknown> = { a: 1 };
    node.self = node;
    expect(sanitize(node, new Set())).toEqual({ a: 1, self: "<circular reference>" });
  });

  it("does not mistake a DAG for a cycle", () => {
    const shared = { value: 1 };
    expect(sanitize({ left: shared, right: shared }, new Set())).toEqual({
      left: { value: 1 },
      right: { value: 1 },
    });
  });

  it("makes a lone surrogate inert, which ingest would otherwise skip at 200 OK", () => {
    expect(scrubSurrogates("ok\ud800bad")).toBe("ok\\ud800bad");
    // A well-formed pair is left alone.
    expect(scrubSurrogates("emoji \u{1F600}")).toBe("emoji \u{1F600}");
  });

  it("scrubs a lone surrogate in a KEY as well as a value", () => {
    // An unscrubbed key reaches the wire as a JSON lone-surrogate escape, ingest
    // answers 200 with `{"accepted":0,"skipped":1}`, and the uploader parks that
    // batch and poisons it after three retries — so one bad key loses every
    // event batched with it. A filesystem path, the realistic source, is most
    // naturally a key.
    const encoded = encodeEntry({ type: "t", ["path\udcff"]: "x", value: "v\udcff" })!;
    // No RAW surrogate survives anywhere in the line...
    expect(/[\uD800-\uDFFF]/.test(encoded)).toBe(false);
    // ...and both the key and the value carry the byte visibly instead.
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    expect(Object.keys(parsed)).toContain(String.raw`path\udcff`);
    expect(parsed.value).toBe(String.raw`v\udcff`);
  });

  it("writes a non-finite number as null rather than invalid JSON", () => {
    const encoded = encodeEntry({ type: "t", value: Number.NaN, other: Number.POSITIVE_INFINITY })!;
    expect(JSON.parse(encoded)).toEqual({ type: "t", value: null, other: null });
  });

  it("encodes the values JSON.stringify refuses", () => {
    const encoded = encodeEntry({
      type: "t",
      big: 1n,
      set: new Set([1, 2]),
      map: new Map([["a", 1]]),
      when: new Date("2026-01-01T00:00:00Z"),
    })!;
    expect(JSON.parse(encoded)).toEqual({
      type: "t",
      big: "1",
      set: [1, 2],
      map: { a: 1 },
      when: "2026-01-01T00:00:00.000Z",
    });
  });

  it("never lets a throwing getter escape the encoder", () => {
    const hostile = {
      type: "t",
      get boom(): never {
        throw new Error("from the caller's own code");
      },
    };
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    expect(() => encodeEntry(hostile)).not.toThrow();
  });
});

describe("size bounds", () => {
  it("caps an oversized event's fields so the collector can still deliver the batch", () => {
    const huge = "x".repeat(5 * 1024 * 1024);
    const encoded = encodeEntry({ type: "tool_result", output: huge })!;
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(4 * 1024 * 1024);
    expect(JSON.parse(encoded).output).toContain("…[truncated]");
  });

  it("never splits a surrogate pair when it truncates", () => {
    const capped = capFields("\u{1F600}".repeat(10), 5) as string;
    expect(capped.endsWith("…[truncated]")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(capped)).toBe(false);
  });

  it("rolls lines into batches that each stay under the limit", () => {
    const lines = Array.from({ length: 5 }, () => ({ text: "x".repeat(40), bytes: 40 }));
    const chunks = roll(lines, 100);
    expect(chunks.map((chunk) => chunk.length)).toEqual([2, 2, 1]);
  });

  it("emits an over-limit line alone rather than dropping it", () => {
    const chunks = roll(
      [
        { text: "a", bytes: 1 },
        { text: "b", bytes: 500 },
      ],
      100,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[1]![0]!.bytes).toBe(500);
  });

  it("sizes a value by walking nodes, not characters", () => {
    expect(approxSize("abcd")).toBe(4);
    expect(approxSize({ a: "bb" })).toBe(3);
    expect(approxSize([1, 2, 3])).toBe(24);
  });
});

describe("queue bounds", () => {
  it("discards the OLDEST events when the queue stops draining, and says so once", () => {
    const warn = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    const writer = new EventWriter(3600);
    try {
      for (let i = 0; i < 10_050; i += 1) writer.submit({ type: "t", index: i });
      const stats = writer.stats();
      expect(stats.queued).toBeLessThanOrEqual(10_000);
      expect(stats.dropped).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("queue is full"));
    } finally {
      writer.close();
    }
  });

  it("bounds by BYTES as well as by count, because a count is not a memory bound", () => {
    const writer = new EventWriter(3600);
    try {
      const chunk = "x".repeat(2 * 1024 * 1024);
      for (let i = 0; i < 64; i += 1) writer.submit({ type: "t", blob: chunk });
      // 64 x 2 MiB is 128 MiB, well past the 64 MiB ceiling, and far under the
      // 10,000-event count cap — so only the byte bound can have stopped it.
      expect(writer.stats().queuedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(writer.stats().dropped).toBeGreaterThan(0);
    } finally {
      writer.close();
    }
  });
});

describe("process lifetime", () => {
  it("lets a script that merely imports it exit, and flushes on the way out", async () => {
    // The flush interval MUST be unref'd. Without that, importing this SDK
    // stops every script that uses it from ever exiting — the most visible bug
    // a telemetry library can ship, and one no in-process assertion can catch,
    // because the test runner keeps the loop alive by itself.
    const child = await runNode(`
      const fp = await import(${JSON.stringify(indexUrl())});
      fp.configure({ baseDir: ${JSON.stringify(spool.dir)}, flushInterval: 3600 });
      fp.event.agentStart({ sessionId: "exit-test" });
      console.log("emitted");
    `);
    expect(child.code).toBe(0);
    expect(child.stdout.trim()).toBe("emitted");
    // The exit hook is the only thing that can have written this: the interval
    // was set to an hour.
    expect(spool.events().map((event) => event.session_id)).toEqual(["exit-test"]);
  });

  it("closes the runs a SIGTERM abandons, so none renders as running forever", async () => {
    // The documented shutdown recipe, killed mid-tool. It used to leave an
    // agent_start with no agent_end and a tool_use with no tool_result, and
    // exit 0 — every deploy stranded the runs it interrupted.
    const child = await runNode(`
      const fp = await import(${JSON.stringify(indexUrl())});
      fp.configure({ baseDir: ${JSON.stringify(spool.dir)}, flushInterval: 3600 });
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => { fp.flushSync(); process.exit(0); });
      }
      setInterval(() => {}, 1000); // a service's server keeps the loop alive
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
      await fp.agent("svc", { sessionId: "term-test" }, async () => {
        await fp.agent("writer", async () => {
          await fp.toolCall("slow", { toolCallId: "t1" }, () => new Promise(() => {}));
        });
      });
    `);
    expect(child.code).toBe(0);
    const events = spool.events();
    expect(events.map((e) => [e.agent_id, e.type])).toEqual([
      ["svc", "agent_start"],
      ["writer", "agent_start"],
      ["writer", "tool_use"],
      ["writer", "tool_result"],
      ["writer", "error"],
      ["writer", "agent_end"],
      ["svc", "error"],
      ["svc", "agent_end"],
    ]);
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.tool_call_id).toBe("t1");
    expect(result.error).toMatch(/^ProcessExit: the process exited \(code 0\) while tool "slow"/);
    for (const end of events.filter((e) => e.type === "agent_end")) expect(end.outcome).toBe("failed");
    expect(events.find((e) => e.type === "error")!.error_type).toBe("ProcessExit");
  });

  it("closes a hand-written model call left open by a SIGTERM", async () => {
    // The no-framework recipe: modelRequest before the provider call,
    // modelResponse after. Killed in between, the request had no response and
    // rendered as running forever.
    const child = await runNode(`
      const fp = await import(${JSON.stringify(indexUrl())});
      fp.configure({ baseDir: ${JSON.stringify(spool.dir)}, flushInterval: 3600 });
      process.once("SIGTERM", () => { fp.flushSync(); process.exit(143); });
      setInterval(() => {}, 1000);
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
      await fp.agent("planner", { sessionId: "model-term" }, async () => {
        fp.event.modelRequest({ model: "m", requestId: "r1" });
        await new Promise(() => {});
      });
    `);
    expect(child.code).toBe(143);
    const events = spool.events();
    expect(events.map((e) => e.type)).toEqual(["agent_start", "model_request", "model_response", "error", "agent_end"]);
    const response = events[2]!;
    expect(response.request_id).toBe("r1");
    expect(response.stop_reason).toBe("error");
    expect(response.error).toMatch(/^ProcessExit: the process exited \(code 143\) while the model call/);
  });

  it("closes nothing on a flushSync() while the process carries on", async () => {
    const child = await runNode(`
      const fp = await import(${JSON.stringify(indexUrl())});
      fp.configure({ baseDir: ${JSON.stringify(spool.dir)}, flushInterval: 3600 });
      await fp.agent("svc", { sessionId: "flush-test" }, async () => {
        fp.flushSync();
        await new Promise((r) => setTimeout(r, 10));
      });
    `);
    expect(child.code).toBe(0);
    expect(spool.events().map((e) => [e.type, e.outcome ?? null])).toEqual([
      ["agent_start", null],
      ["agent_end", "success"],
    ]);
  });
});
