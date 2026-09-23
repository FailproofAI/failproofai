import { describe, expect, it } from "vitest";

import {
  describeTrace,
  runAgentAsync,
  scenarios,
  traceViolations,
  type Event,
  type Format,
  type RunResult,
} from "./harness.js";

/**
 * Runtime parity: every scenario of every framework fixture, run under another
 * runtime and under Node, must record the same trace.
 *
 * The framework files (`ai.test.ts`, …) say what a correct trace IS; this says
 * only that Bun or Deno produce the one Node does. That keeps a runtime suite
 * from restating — and drifting from — a hundred and eighty expectations, and
 * it still catches every way a runtime differs that matters here: the adapter
 * patched a copy the app does not run (no events), a hook never fired (a
 * missing pair), the exit flush never ran (a short trace), a warning Node does
 * not print.
 */

export const FRAMEWORK_FIXTURES = [
  "ai-4",
  "ai-5",
  "ai-6",
  "ai-7",
  "langchain-0.3",
  "langchain-1",
  "mastra-0",
  "mastra-1",
  "llamaindex-0.11",
  "llamaindex-0.12",
] as const;

/**
 * The fields of an event that are a property of the RUN, not of the moment:
 * no timestamps, durations, generated ids or session ids.
 */
const STABLE = [
  "type",
  "agent_id",
  "parent_id",
  "tool_name",
  "hook_name",
  "trigger_event",
  "model",
  "input_tokens",
  "output_tokens",
  "stop_reason",
  "tool_call_id",
  "outcome",
  "framework",
] as const;

/** A generated id (a tool call with no model-assigned id gets a UUID). */
const GENERATED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Each session's events in order, sessions sorted. Two sessions run
 * concurrently (`shared-query`) interleave by scheduling, which is a property
 * of the event loop and not of the SDK; the order WITHIN a session is not.
 */
export const digest = (events: Event[]): string[][] => {
  const sessions = new Map<string, Event[]>();
  for (const event of events) sessions.set(event.session_id, [...(sessions.get(event.session_id) ?? []), event]);
  return [...sessions.values()].map(digestSession).sort((a, b) => a.join().localeCompare(b.join()));
};

const digestSession = (events: Event[]): string[] =>
  events.map((event) =>
    JSON.stringify(
      Object.fromEntries(
        STABLE.filter((key) => key in event).map((key) => {
          const value = event[key];
          return [key, typeof value === "string" && GENERATED.test(value) ? "<generated>" : value];
        }),
      ),
    ),
  );

/** The SDK's own diagnostics, without the parts that name paths or numbers. */
export const sdkLines = (stderr: string): string[] =>
  stderr
    .split("\n")
    .filter((line) => line.includes("[failproofai-sdk]"))
    .map((line) => line.replace(/\/[^\s"')]+/g, "<path>").replace(/\d+/g, "N"));

export interface Divergence {
  /** Why this scenario is allowed to differ, stated as the observed behaviour. */
  reason: string;
}

/**
 * One `describe` per fixture and module system; one concurrent case per
 * scenario. `known` lists scenarios whose difference is understood and is NOT
 * the SDK's (each is asserted to still differ, so a fix upstream shows up),
 * keyed `fixture:format:scenario` with `*` for either of the first two.
 */
export function parity(
  label: string,
  pairs: ReadonlyArray<readonly [node: Format, other: Format]>,
  known: Record<string, Divergence> = {},
): void {
  describe.each(FRAMEWORK_FIXTURES)(`%s under ${label}`, (fixture) => {
    describe.each(pairs)("%s vs %s", (nodeFormat, otherFormat) => {
      it.concurrent.each(scenarios(fixture))("%s", async (scenario) => {
        const [node, other] = await Promise.all([
          runAgentAsync(fixture, nodeFormat, scenario),
          runAgentAsync(fixture, otherFormat, scenario),
        ]);
        const key = `${fixture}:${otherFormat}:${scenario}`;
        const matches = same(node, other);
        const divergence =
          known[key] ??
          known[`${fixture}:*:${scenario}`] ??
          known[`*:${otherFormat}:${scenario}`] ??
          known[`*:*:${scenario}`];
        if (divergence !== undefined) {
          expect(matches, `${key} is listed as a known divergence (${divergence.reason}) but now matches Node`).toBe(
            false,
          );
          return;
        }
        const context = `NODE ${nodeFormat}\n${describeTrace(node)}\n\n${otherFormat.toUpperCase()}\n${describeTrace(other)}`;
        expect(other.status, context).toBe(node.status);
        expect(digest(other.events), context).toEqual(digest(node.events));
        expect(traceViolations(other.events), context).toEqual(traceViolations(node.events));
        expect(sdkLines(other.stderr), context).toEqual(sdkLines(node.stderr));
      });
    });
  });
}

function same(a: RunResult, b: RunResult): boolean {
  return (
    a.status === b.status &&
    JSON.stringify(digest(a.events)) === JSON.stringify(digest(b.events)) &&
    JSON.stringify(sdkLines(a.stderr)) === JSON.stringify(sdkLines(b.stderr))
  );
}
