import { describe, expect, it } from "vitest";

import {
  FORMATS,
  count,
  describeTrace,
  ofType,
  runAgent,
  traceViolations,
  typecheck,
  type Event,
} from "./harness.js";

/**
 * The Vercel AI SDK (`ai`), against real releases of every supported major.
 *
 * The mapping (the adapter's module comment has the reasoning):
 *
 *   * one `generateText` / `streamText` / `generateObject` / `streamObject`
 *     call is ONE agent, named by its `functionId` — never a span or call id;
 *   * each model step is a `model_request` / `model_response` pair on
 *     `request_id`, with integer token counts and a STRING stop reason;
 *   * each tool is a `tool_use` / `tool_result` pair carrying the MODEL's own
 *     tool call id;
 *   * a bare model call through `wrapModel` is its own run, named after the
 *     model — the LangChain precedent for a bare chat-model call — unless an
 *     enclosing `failproofai.agent()` already owns it;
 *   * a failure is recorded once, where it happened — no stack of `error`
 *     events.
 *
 * Four fixtures because the AI SDK changed its extension points at every
 * major: v4 speaks LanguageModelV1 (`promptTokens`), v5 V2, v6 V3 (usage and
 * finish reason became objects), and v7 dropped the OpenTelemetry `tracer`
 * option for its own `Telemetry` integration interface.
 */

const ALL = ["ai-4", "ai-5", "ai-6", "ai-7"] as const;
const only = process.env.FAILPROOFAI_IT_FIXTURES?.split(",").filter(Boolean);
const FIXTURES = ALL.filter((name) => !only || only.includes(name));

/** One line per event: `agent_id type [tool]`. */
const shape = (events: Event[]): string[] =>
  events.map((e) => [e.agent_id, e.type, (e.tool_name ?? "") as string].join(" ").trim());

const LOOP = (agent: string): string[] => [
  `${agent} agent_start`,
  `${agent} model_request`,
  `${agent} model_response`,
  `${agent} tool_use weather`,
  `${agent} tool_result weather`,
  `${agent} model_request`,
  `${agent} model_response`,
  `${agent} agent_end`,
];
const GEN = LOOP("weather-agent");

/**
 * A stream on v4–v6. The SDK runs a tool the moment its `tool-call` part
 * arrives and holds the stream's `finish` part until the tool returns, so the
 * model step's span — the only place its usage and finish reason exist — ends
 * AFTER the tool. Events are stamped when they happen, never backdated, so
 * that is the order they land in; `request_id` still pairs them. v7 closes
 * the model call before it executes tools, so there a stream reads like GEN.
 */
const LEGACY_STREAM = [
  "weather-agent agent_start",
  "weather-agent model_request",
  "weather-agent tool_use weather",
  "weather-agent tool_result weather",
  "weather-agent model_response",
  "weather-agent model_request",
  "weather-agent model_response",
  "weather-agent agent_end",
];

const tokens = (events: Event[]) => ofType(events, "model_response").map((e) => [e.input_tokens, e.output_tokens]);

describe.each(FIXTURES)("%s", (fixture) => {
  const major = Number(fixture.split("-")[1]);
  const STREAM = major >= 7 ? GEN : LEGACY_STREAM;

  it("typechecks the README call sites as a customer's nodenext project", () => {
    expect(typecheck(fixture)).toBe("");
  });

  describe.each(FORMATS)("as %s", (format) => {
    const run = (scenario: string, { expectNote = false } = {}) => {
      const result = runAgent(fixture, format, scenario);
      expect(result.status, describeTrace(result)).toBe(0);
      // A warning from the SDK is how a silently-inert adapter shows itself
      // ("could not resolve a session", "outside the supported range").
      const lines = result.stderr.split("\n").filter((line) => line.includes("[failproofai-sdk]"));
      if (expectNote) {
        // The one deliberate exception: instrument("ai") on ai 4–6 says, once,
        // that by itself it records nothing there — and nothing else is said.
        expect(lines, describeTrace(result)).toHaveLength(1);
        expect(lines[0], describeTrace(result)).toContain("registerGlobalTracer");
      } else {
        expect(lines, describeTrace(result)).toEqual([]);
      }
      return result;
    };
    /** instrument("ai") without the opt-in: inert, and noted, on ai 4–6. */
    const noted = major < 7;

    it("records generateText with a tool loop as one agent", () => {
      const result = run("generate");
      const { events } = result;
      expect(shape(events), describeTrace(result)).toEqual(GEN);
      expect(traceViolations(events), describeTrace(result)).toEqual([]);
      expect(new Set(events.map((e) => e.session_id)).size).toBe(1);
      expect(tokens(events)).toEqual([
        [11, 7],
        [23, 9],
      ]);
      const responses = ofType(events, "model_response");
      expect(responses.map((e) => e.stop_reason)).toEqual(["tool-calls", "stop"]);
      for (const e of [...responses, ...ofType(events, "model_request")]) expect(e.model).toBe("mock-model");
      for (const e of responses) expect(Number.isInteger(e.duration_ms)).toBe(true);
      // The first step answered with a tool call and no text: its content is
      // the call, not an empty string.
      expect(responses[0]!.content).not.toBe("");
      expect(JSON.stringify(responses[0]!.content)).toContain("weather");
      expect(responses[1]!.content).toBe("It is 20C in Paris.");
      const [use] = ofType(events, "tool_use");
      expect(use!.tool_call_id).toBe("call-1");
      expect(use!.input).toEqual({ city: "Paris" });
      expect(ofType(events, "tool_result")[0]!.output).toEqual({ city: "Paris", celsius: 20 });
      expect(ofType(events, "agent_end")[0]!.outcome).toBe("success");
      expect(count(events, "error")).toBe(0);
      for (const event of events) {
        expect(event.framework).toBe("ai");
        expect(String(event.framework_version)).toMatch(new RegExp(`^${major}\\.`));
      }
      expect(result.stdout).toContain("It is 20C in Paris.");
    });

    it("records streamText like generateText, and stamps the request when it is made", () => {
      const result = run("stream");
      const { events } = result;
      expect(shape(events), describeTrace(result)).toEqual(STREAM);
      expect(traceViolations(events), describeTrace(result)).toEqual([]);
      expect(tokens(events)).toEqual([
        [13, 4],
        [30, 6],
      ]);
      const responses = ofType(events, "model_response");
      expect(responses.map((e) => e.stop_reason)).toEqual(["tool-calls", "stop"]);
      expect(responses[0]!.content).not.toBe("");
      expect(responses[1]!.content).toBe("Rome is 25C.");
      expect(ofType(events, "tool_use")[0]!.tool_call_id).toBe("call-s1");
      const request = ofType(events, "model_request")[0]!;
      const use = ofType(events, "tool_use")[0]!;
      expect(String(request.timestamp) <= String(use.timestamp)).toBe(true);
      expect(result.stdout).toContain("Rome is 25C.");
    });

    it.each(["object", "stream-object"])("records %s as one agent with one model call", (scenario) => {
      const result = run(scenario);
      expect(shape(result.events), describeTrace(result)).toEqual([
        "extractor agent_start",
        "extractor model_request",
        "extractor model_response",
        "extractor agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(tokens(result.events)).toEqual([[5, 3]]);
      expect(ofType(result.events, "model_response")[0]!.stop_reason).toBe("stop");
      expect(result.stdout).toContain('"city":"Paris"');
    });

    it("records a bare wrapModel call as its own run, named after the model", () => {
      const result = run("wrap");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "mock-model agent_start",
        "mock-model model_request",
        "mock-model model_response",
        "mock-model agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      const response = ofType(result.events, "model_response")[0]!;
      expect([response.input_tokens, response.output_tokens]).toEqual([23, 9]);
      expect(response.stop_reason).toBe("stop");
      expect(response.content).toBe("It is 20C in Paris.");
    });

    it("records a streamed wrapModel call with its usage", () => {
      const result = run("wrap-stream");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "mock-model agent_start",
        "mock-model model_request",
        "mock-model model_response",
        "mock-model agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      const response = ofType(result.events, "model_response")[0]!;
      expect([response.input_tokens, response.output_tokens]).toEqual([30, 6]);
      expect(response.stop_reason).toBe("stop");
      expect(response.content).toBe("Rome is 25C.");
    });

    it("records wrapModel calls under an enclosing agent() rather than as runs of their own", () => {
      const result = run("wrap-in-agent");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "planner agent_start",
        "planner model_request",
        "planner model_response",
        "planner model_request",
        "planner model_response",
        "planner agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["req-1"]));
      expect(tokens(result.events)).toEqual([
        [11, 7],
        [23, 9],
      ]);
    });

    it("records each call once when telemetry() and wrapModel are both in use", () => {
      const result = run("wrap-and-telemetry");
      expect(shape(result.events), describeTrace(result)).toEqual(GEN);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it.each(["instrument", "instrument-stream"])(
      "%s: instrument('ai') records the same trace as telemetry() on ai 7, and on ai 4–6 records nothing and says so",
      (scenario) => {
        const result = run(scenario, { expectNote: noted });
        expect(result.stdout).toContain('"instrumented":["ai"]');
        if (major >= 7) {
          expect(shape(result.events), describeTrace(result)).toEqual(scenario === "instrument" ? GEN : STREAM);
          expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
        } else {
          // v4–v6's only process-wide hook is the global OpenTelemetry slot,
          // which instrument("ai") no longer takes by default.
          expect(result.events, describeTrace(result)).toEqual([]);
          expect(result.stdout).toContain(scenario === "instrument" ? "It is 20C in Paris." : "Rome is 25C.");
        }
      },
    );

    it.each(["instrument-global", "instrument-global-stream"])(
      "%s: instrument('ai', { registerGlobalTracer: true }) records the same trace as telemetry()",
      (scenario) => {
        const result = run(scenario);
        expect(result.stdout).toContain('"instrumented":["ai"]');
        expect(shape(result.events), describeTrace(result)).toEqual(scenario === "instrument-global" ? GEN : STREAM);
        expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      },
    );

    it("leaves the global OpenTelemetry slot to a customer provider registered after instrument('ai')", () => {
      const result = run("instrument-then-otel", { expectNote: noted });
      const report = JSON.parse(result.stdout.trim().split("\n").pop()!) as {
        text: string;
        customer: "absent" | { registered: boolean; ended: string[] };
      };
      expect(report.text).toBe("It is 20C in Paris.");
      if (major >= 7) {
        // v7 has no OpenTelemetry dependency; the integration records the call.
        expect(report.customer).toBe("absent");
        expect(shape(result.events), describeTrace(result)).toEqual(GEN);
        return;
      }
      // Their registration is accepted, and their tracer gets every span —
      // the AI SDK's own and their service's.
      expect(report.customer, describeTrace(result)).toEqual({
        registered: true,
        ended: expect.arrayContaining(["ai.generateText", "ai.generateText.doGenerate", "ai.toolCall", "http.request"]),
      });
      expect(result.events, describeTrace(result)).toEqual([]);
    });

    it("closes a streamed wrapModel call the reader cancels, as cancelled", () => {
      const result = run("wrap-stream-cancel");
      expect(result.stdout).toContain('"cancelled":true');
      expect(shape(result.events), describeTrace(result)).toEqual([
        "mock-model agent_start",
        "mock-model model_request",
        "mock-model model_response",
        "mock-model agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      const response = ofType(result.events, "model_response")[0]!;
      expect(response.stop_reason).toBe("cancelled");
      expect(response.error).toBeUndefined();
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("cancelled");
      expect(count(result.events, "error")).toBe(0);
    });

    it("closes a streamed wrapModel call whose stream errors, with the error", () => {
      const result = run("wrap-stream-error");
      expect(result.stdout).toContain('"threw":"connection reset"');
      expect(shape(result.events), describeTrace(result)).toEqual([
        "mock-model agent_start",
        "mock-model model_request",
        "mock-model model_response",
        "mock-model agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      const response = ofType(result.events, "model_response")[0]!;
      expect(response.stop_reason).toBe("error");
      expect(response.error).toMatch(/connection reset/);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("failed");
      expect(count(result.events, "error")).toBe(0);
    });

    it("records nothing after uninstrument()", () => {
      const result = run("uninstrument", { expectNote: noted });
      expect(result.stdout).toContain('"removed":["ai"]');
      expect(result.events, describeTrace(result)).toEqual([]);
    });

    it("records a failing tool once, on its tool_result", () => {
      const result = run("tool-error");
      const { events } = result;
      const toolResult = ofType(events, "tool_result")[0]!;
      expect(toolResult.error, describeTrace(result)).toMatch(/weather service down/);
      expect(count(events, "error"), describeTrace(result)).toBe(0);
      expect(traceViolations(events), describeTrace(result)).toEqual([]);
      if (major >= 5) {
        // v5+ hands the failure back to the model as a tool-error result and
        // the loop carries on — the agent recovered, so the run succeeded.
        expect(shape(events), describeTrace(result)).toEqual(GEN);
        expect(ofType(events, "agent_end")[0]!.outcome).toBe("success");
      } else {
        // v4 throws a ToolExecutionError out of generateText: the run failed.
        expect(shape(events), describeTrace(result)).toEqual([...GEN.slice(0, 5), "weather-agent agent_end"]);
        expect(ofType(events, "agent_end")[0]!.outcome).toBe("failed");
        expect(result.stdout).toContain("threw");
      }
    });

    it("records a failing model once, on its model_response", () => {
      const result = run("model-error");
      const { events } = result;
      expect(result.stdout).toContain("model exploded");
      expect(shape(events), describeTrace(result)).toEqual([
        "weather-agent agent_start",
        "weather-agent model_request",
        "weather-agent model_response",
        "weather-agent agent_end",
      ]);
      expect(traceViolations(events), describeTrace(result)).toEqual([]);
      const response = ofType(events, "model_response")[0]!;
      expect(response.error).toMatch(/model exploded/);
      expect(response.stop_reason).toBe("error");
      expect(ofType(events, "agent_end")[0]!.outcome).toBe("failed");
      expect(count(events, "error")).toBe(0);
    });

    it("nests the call under an enclosing agent() scope", () => {
      const result = run("scope");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "planner agent_start",
        ...GEN,
        "planner agent_end",
      ]);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["req-1"]));
      expect(ofType(result.events, "agent_start")[1]!.parent_id).toBe("planner");
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("runs the README call sites cleanly", () => {
      const result = run("readme");
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      const agents = ofType(result.events, "agent_start").map((e) => e.agent_id);
      expect(agents).toEqual(expect.arrayContaining(["answer-question", "tagged", "mock-model"]));
    });
  });
});
