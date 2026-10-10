/**
 * Opt-in OTLP/JSON SpanExporter. Only disk I/O: the daemon authenticates and
 * delivers opaque batches. No OpenTelemetry import until instrument("otel").
 */
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { importModule, resolveFrom, tryRequire } from "../node-require.js";
import type { Adapter } from "./core.js";

type ObjectValue = Record<string, unknown>;
export interface OtelReadableSpan {
  name: string;
  kind: number;
  spanContext(): { traceId: string; spanId: string; traceFlags?: number; traceState?: { serialize(): string } };
  parentSpanId?: string;
  parentSpanContext?: { spanId: string };
  startTime: readonly [number, number];
  endTime: readonly [number, number];
  attributes: ObjectValue;
  status: { code: number; message?: string };
  resource?: { attributes: ObjectValue; schemaUrl?: string };
  instrumentationScope?: { name: string; version?: string; schemaUrl?: string };
  instrumentationLibrary?: { name: string; version?: string; schemaUrl?: string };
  events?: readonly { name: string; time: readonly [number, number]; attributes?: ObjectValue; droppedAttributesCount?: number }[];
  links?: readonly { context: { traceId: string; spanId: string; traceFlags?: number; traceState?: { serialize(): string } }; attributes?: ObjectValue; droppedAttributesCount?: number }[];
  droppedAttributesCount?: number;
  droppedEventsCount?: number;
  droppedLinksCount?: number;
}
export interface OtelExportResult { code: number; error?: Error }
export interface OtelSpanExporterOptions { spoolDir?: string }
const MAX_BYTES = 8 * 1024 * 1024;
const metadata = '{"path":"/v1/traces","content_type":"application/json","encoding":null}\n';

function anyValue(value: unknown): ObjectValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "bigint") return { intValue: value.toString() };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { doubleValue: String(value) };
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (value instanceof Uint8Array) return { bytesValue: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  if (value && typeof value === "object") return { kvlistValue: { values: attributes(value as ObjectValue) } };
  return {};
}
function attributes(value: ObjectValue = {}): ObjectValue[] {
  return Object.entries(value).filter(([, v]) => v !== undefined && v !== null)
    .map(([key, v]) => ({ key, value: anyValue(v) }));
}
function nanos(time: readonly [number, number]): string {
  return (BigInt(time[0]) * 1_000_000_000n + BigInt(time[1])).toString();
}
function resourceSpan(span: OtelReadableSpan): ObjectValue {
  const context = span.spanContext();
  const scope = span.instrumentationScope ?? span.instrumentationLibrary;
  return {
    resource: { attributes: attributes(span.resource?.attributes) },
    ...(span.resource?.schemaUrl ? { schemaUrl: span.resource.schemaUrl } : {}),
    scopeSpans: [{
      scope: { name: scope?.name ?? "", ...(scope?.version ? { version: scope.version } : {}) },
      ...(scope?.schemaUrl ? { schemaUrl: scope.schemaUrl } : {}),
      spans: [{
        traceId: context.traceId, spanId: context.spanId,
        ...(span.parentSpanContext?.spanId || span.parentSpanId ? { parentSpanId: span.parentSpanContext?.spanId ?? span.parentSpanId } : {}),
        ...(context.traceState ? { traceState: context.traceState.serialize() } : {}),
        flags: context.traceFlags ?? 0, name: span.name, kind: span.kind + 1,
        startTimeUnixNano: nanos(span.startTime), endTimeUnixNano: nanos(span.endTime),
        attributes: attributes(span.attributes), status: span.status,
        droppedAttributesCount: span.droppedAttributesCount ?? 0,
        droppedEventsCount: span.droppedEventsCount ?? 0, droppedLinksCount: span.droppedLinksCount ?? 0,
        events: (span.events ?? []).map(event => ({
          name: event.name, timeUnixNano: nanos(event.time), attributes: attributes(event.attributes),
          droppedAttributesCount: event.droppedAttributesCount ?? 0,
        })),
        links: (span.links ?? []).map(link => ({
          traceId: link.context.traceId, spanId: link.context.spanId, flags: link.context.traceFlags ?? 0,
          ...(link.context.traceState ? { traceState: link.context.traceState.serialize() } : {}),
          attributes: attributes(link.attributes), droppedAttributesCount: link.droppedAttributesCount ?? 0,
        })),
      }],
    }],
  };
}

/** Structural implementation of OpenTelemetry's SpanExporter; zero hard deps. */
export class OtelSpanExporter {
  private stopped = false;
  private readonly directory?: string;
  constructor(options: OtelSpanExporterOptions = {}) { this.directory = options.spoolDir; }

  export(spans: readonly OtelReadableSpan[], callback: (result: OtelExportResult) => void): void {
    let result: OtelExportResult = { code: 0 };
    try {
      if (this.stopped) throw new Error("OTEL exporter has shut down.");
      const dir = this.directory ?? join(process.env.FAILPROOFAI_HOME || join(homedir(), ".failproofai"), "state", "spool-otlp");
      // Encode each span once and split batches at the relay's request limit.
      const chunks: string[] = [];
      let items: string[] = [];
      let size = Buffer.byteLength('{"resourceSpans":[]}');
      for (const span of spans) {
        const encoded = JSON.stringify(resourceSpan(span));
        const bytes = Buffer.byteLength(encoded);
        if (bytes + 20 > MAX_BYTES) throw new Error("OTEL span exceeds the 8 MiB relay limit.");
        if (size + bytes + 1 > MAX_BYTES) {
          chunks.push(`{"resourceSpans":[${items.join(",")}]}`); items = []; size = 20;
        }
        items.push(encoded); size += bytes + 1;
      }
      if (items.length) chunks.push(`{"resourceSpans":[${items.join(",")}]}`);
      for (const body of chunks) this.publish(dir, body);
    } catch (error) {
      result = { code: 1, error: error instanceof Error ? error : new Error(String(error)) };
    }
    callback(result);
  }
  private publish(dir: string, body: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `otlp-sdk-${randomUUID()}`;
    const temp = join(dir, `.${name}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      const bytes = Buffer.from(metadata + body);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, join(dir, `${name}.jsonl`));
      if (process.platform !== "win32") {
        const directory = openSync(dir, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
    }
  }
  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { this.stopped = true; return Promise.resolve(); }
}

interface Processor {
  onStart(...args: unknown[]): void;
  onEnd(...args: unknown[]): void;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}
interface Provider { addSpanProcessor(processor: Processor): void }
interface TraceSdk {
  BatchSpanProcessor: new (exporter: OtelSpanExporter) => Processor;
  BasicTracerProvider: new (options: { spanProcessors: Processor[] }) => unknown;
}
interface TraceApi { trace: { setGlobalTracerProvider(provider: unknown): boolean } }
let installed: { enabled: boolean; processor: Processor; list?: Processor[] } | null = null;
export const adapter: Adapter = {
  name: "otel",
  async install(options = {}) {
    const provider = options.provider as Provider | undefined;
    const list = options.spanProcessors as Processor[] | undefined;
    if (provider && typeof provider.addSpanProcessor !== "function") {
      throw new Error('instrument("otel") needs { spanProcessors } before constructing an OTEL v2 provider, or a provider with addSpanProcessor().');
    }
    const path = resolveFrom("@opentelemetry/sdk-trace-base");
    if (!path) throw new Error('Install @opentelemetry/sdk-trace-base to use instrument("otel").');
    const module = tryRequire<TraceSdk>("@opentelemetry/sdk-trace-base") ??
      await importModule(path) as TraceSdk;
    const exporter = new OtelSpanExporter({ spoolDir: options.spoolDir as string | undefined });
    const batch = new module.BatchSpanProcessor(exporter);
    const state = { enabled: true, processor: batch, list };
    // Providers have no portable remove API. A gate makes uninstall effective
    // without shutting down anybody else's processors or provider.
    const gate: Processor = {
      onStart: (...args) => { if (state.enabled) batch.onStart(...args); },
      onEnd: (...args) => { if (state.enabled) batch.onEnd(...args); },
      forceFlush: () => state.enabled ? batch.forceFlush() : Promise.resolve(),
      shutdown: () => batch.shutdown(),
    };
    installed = state;
    if (Array.isArray(list)) { list.push(gate); state.processor = gate; }
    else if (provider) { provider.addSpanProcessor(gate); state.processor = gate; }
    else {
      state.processor = gate;
      const apiPath = resolveFrom("@opentelemetry/api");
      if (!apiPath) throw new Error("Install @opentelemetry/api to register the OTEL provider.");
      const api = tryRequire<TraceApi>("@opentelemetry/api") ?? await importModule(apiPath) as TraceApi;
      if (!api.trace.setGlobalTracerProvider(new module.BasicTracerProvider({ spanProcessors: [gate] }))) {
        throw new Error('An OTEL provider is already registered; use instrument("otel", { spanProcessors }) before constructing it.');
      }
    }
  },
  uninstall() {
    if (!installed) return;
    installed.enabled = false;
    if (installed.list) {
      const index = installed.list.indexOf(installed.processor);
      if (index >= 0) installed.list.splice(index, 1);
    }
    void installed.processor.shutdown().catch(() => { /* SDK teardown never throws into the app. */ });
    installed = null;
  },
};
