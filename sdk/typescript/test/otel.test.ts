import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OtelSpanExporter } from "../src/index.js";
import { instrument, uninstrument, activeFrameworks } from "../src/integrations/index.js";
import { setStrict } from "../src/integrations/core.js";

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-otel-sdk-"));
  previousHome = process.env.FAILPROOFAI_HOME;
  process.env.FAILPROOFAI_HOME = home;
});
afterEach(() => {
  uninstrument("otel");
  setStrict(null);
  if (previousHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});
function files() { return readdirSync(join(home, "state/spool-otlp")); }
function body(name: string) {
  const text = readFileSync(join(home, "state/spool-otlp", name), "utf8");
  const split = text.indexOf("\n");
  expect(JSON.parse(text.slice(0, split))).toEqual({
    path: "/v1/traces", content_type: "application/json", encoding: null,
  });
  return JSON.parse(text.slice(split + 1)) as { resourceSpans: Array<{
    resource: { attributes: unknown[] };
    scopeSpans: Array<{ scope: { name: string }; spans: Array<Record<string, unknown>> }>;
  }> };
}

describe("OTLP/JSON SpanExporter", () => {
  it("exports real ended spans, links, events, precise nanos, status and typed attributes durably without network", async () => {
    const exporter = new OtelSpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const tracer = provider.getTracer("test-scope", "1.0");
    const parent = tracer.startSpan("agent", { startTime: [1780000000, 123], attributes: { "gen_ai.operation.name": "invoke_agent" } });
    const child = tracer.startSpan("chat", {
      startTime: [1780000000, 456], kind: SpanKind.CLIENT,
      attributes: { "gen_ai.operation.name": "chat", count: 42, enabled: true, decimal: 1.5, values: ["a", "b"] },
      links: [{ context: parent.spanContext(), attributes: { linked: true } }],
    }, trace.setSpanContext(ROOT_CONTEXT, parent.spanContext()));
    child.addEvent("prompt", { text: "hello" }, [1780000000, 789]);
    child.setStatus({ code: SpanStatusCode.ERROR, message: "failed" });
    child.end([1780000001, 12]); parent.end([1780000001, 13]);
    await provider.forceFlush();
    expect(files()).toHaveLength(2);
    const spans = files().flatMap(name => body(name).resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans)));
    const output = spans.find(span => span.name === "chat")!;
    expect(output).toMatchObject({
      traceId: child.spanContext().traceId, spanId: child.spanContext().spanId,
      parentSpanId: parent.spanContext().spanId, kind: 3,
      startTimeUnixNano: "1780000000000000456", endTimeUnixNano: "1780000001000000012",
      status: { code: 2, message: "failed" },
      events: [{ name: "prompt", timeUnixNano: "1780000000000000789" }],
      links: [{ traceId: parent.spanContext().traceId, spanId: parent.spanContext().spanId }],
    });
    expect(output.attributes).toContainEqual({ key: "count", value: { intValue: "42" } });
    expect(output.attributes).toContainEqual({ key: "values", value: { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } } });
    for (const name of files()) {
      expect(name).toMatch(/^otlp-sdk-.*\.jsonl$/);
      expect(statSync(join(home, "state/spool-otlp", name)).mode & 0o777).toBe(0o600);
    }
    await provider.shutdown();
  });

  it("reports disk and post-shutdown failures through the callback, once", async () => {
    const file = join(home, "not-a-directory");
    writeFileSync(file, "x");
    const exporter = new OtelSpanExporter({ spoolDir: file });
    const provider = new BasicTracerProvider();
    const span = provider.getTracer("test").startSpan("test");
    span.end();
    const results: number[] = [];
    exporter.export([span as unknown as ReadableSpan], result => results.push(result.code));
    await exporter.shutdown();
    exporter.export([], result => results.push(result.code));
    expect(results).toEqual([1, 1]);
    await provider.shutdown();
  });

  it("splits an export above 8 MiB into complete bounded requests", async () => {
    const provider = new BasicTracerProvider({ spanLimits: { attributeValueLengthLimit: 10_000_000 } });
    const span = provider.getTracer("test").startSpan("big", { attributes: { content: "x".repeat(4 * 1024 * 1024) } });
    span.end();
    const results: number[] = [];
    new OtelSpanExporter().export([span as unknown as ReadableSpan, span as unknown as ReadableSpan], result => results.push(result.code));
    expect(results).toEqual([0]);
    expect(files()).toHaveLength(2);
    for (const name of files()) expect(body(name).resourceSpans).toHaveLength(1);
    await provider.shutdown();
  });

  it("instrument('otel') adds one gated processor and leaves other exporters unchanged", async () => {
    setStrict(true);
    const processors: SpanProcessor[] = [];
    expect(await instrument("otel", { spanProcessors: processors })).toEqual(["otel"]);
    expect(await instrument("otel", { spanProcessors: processors })).toEqual([]);
    const observed: string[] = [];
    const existing: SpanProcessor = {
      onStart() {}, onEnd(span) { observed.push(span.name); },
      forceFlush: () => Promise.resolve(), shutdown: () => Promise.resolve(),
    };
    const provider = new BasicTracerProvider({ spanProcessors: [existing, ...processors] });
    const tracer = provider.getTracer("app");
    tracer.startSpan("before").end();
    await provider.forceFlush();
    expect(files()).toHaveLength(1);
    expect(activeFrameworks()).toContain("otel");
    expect(uninstrument("otel")).toEqual(["otel"]);
    tracer.startSpan("after").end();
    await provider.forceFlush();
    expect(files()).toHaveLength(1);
    expect(observed).toEqual(["before", "after"]);
    expect(processors).toHaveLength(0);
    await provider.shutdown();
  });
});
