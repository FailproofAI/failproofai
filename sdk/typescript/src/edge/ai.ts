/**
 * `@failproofai/sdk/ai` for runtimes with no filesystem — see `./index.ts`.
 *
 * Every helper hands the Vercel AI SDK something it accepts and that records
 * nothing: `telemetry()` returns telemetry settings with `isEnabled: false`,
 * the middleware passes calls straight through, the wrappers return what they
 * were given.
 */

import { noopAdapter } from "./adapter.js";
import { notice } from "./notice.js";

type AttributeValue = string | number | boolean | Array<string | number | boolean>;

/** A span that records nothing, for a caller holding the tracer directly. */
export class FailproofSpan {
  readonly attributes: Record<string, AttributeValue> = {};
  spanContext() {
    return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };
  }
  setAttribute(): this {
    return this;
  }
  setAttributes(): this {
    return this;
  }
  addEvent(): this {
    return this;
  }
  addLink(): this {
    return this;
  }
  addLinks(): this {
    return this;
  }
  setStatus(): this {
    return this;
  }
  updateName(): this {
    return this;
  }
  recordException(): void {}
  isRecording(): boolean {
    return false;
  }
  end(): void {}
}

export class FailproofTracer {
  startSpan(): FailproofSpan {
    return new FailproofSpan();
  }

  startActiveSpan(_name: string, ...rest: unknown[]): unknown {
    const fn = rest[rest.length - 1] as (span: FailproofSpan) => unknown;
    return fn(new FailproofSpan());
  }
}

export function telemetry(
  options: { functionId?: string; metadata?: Record<string, AttributeValue> } = {},
): { isEnabled: false; functionId?: string; metadata?: Record<string, AttributeValue> } {
  notice();
  return {
    isEnabled: false,
    ...(options.functionId === undefined ? {} : { functionId: options.functionId }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

export function tracer(): FailproofTracer {
  notice();
  return new FailproofTracer();
}

const ignore = (): void => {};

/** The v7 telemetry integration, with every hook a no-op. */
export const integration = Object.freeze({
  onStart: ignore,
  onLanguageModelCallStart: ignore,
  onLanguageModelCallEnd: ignore,
  onObjectStepStart: ignore,
  onObjectStepEnd: ignore,
  onEmbedStart: ignore,
  onEmbedEnd: ignore,
  onToolExecutionStart: ignore,
  onToolExecutionEnd: ignore,
  onEnd: ignore,
});

export function middleware() {
  notice();
  return {
    specificationVersion: "v3" as const,
    wrapGenerate: async <R>({ doGenerate }: { doGenerate: () => PromiseLike<R> }): Promise<R> => await doGenerate(),
    wrapStream: async <R>({ doStream }: { doStream: () => PromiseLike<R> }): Promise<R> => await doStream(),
  };
}

export function wrapModel<T>(model: T): Promise<T> {
  notice();
  return Promise.resolve(model);
}

export function wrapTool<T>(_toolName: string, tool: T): T {
  notice();
  return tool;
}

export function wrapTools<T>(tools: T): T {
  notice();
  return tools;
}

export const adapter = noopAdapter("ai");
