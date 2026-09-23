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

/**
 * Every commonly used surface of the SDK, on every major where it exists —
 * `surfaces.ts` in each fixture. The cases above pin the README call sites
 * and the adapter's core paths; these walk the rest of what customers call:
 * the agent classes, embeddings, structured output, tool features, every way
 * of consuming a stream, reasoning models and concurrency.
 *
 * Where the SDK itself makes a surface unrecordable, the case pins what IS
 * recorded, with the reason beside it, so a change in either direction is
 * seen.
 */
describe.each(FIXTURES)("%s: every surface", (fixture) => {
  const major = Number(fixture.split("-")[1]);
  /** The tool loop the scripted model runs: one tool call, then the answer. */
  const loop = (agent: string, tool = "weather"): string[] => [
    `${agent} agent_start`,
    `${agent} model_request`,
    `${agent} model_response`,
    `${agent} tool_use ${tool}`,
    `${agent} tool_result ${tool}`,
    `${agent} model_request`,
    `${agent} model_response`,
    `${agent} agent_end`,
  ];
  /** The same loop streamed: on v4–v6 the step's span ends after the tool it caused (see LEGACY_STREAM). */
  const streamed = (agent: string): string[] =>
    major >= 7
      ? loop(agent)
      : [
          `${agent} agent_start`,
          `${agent} model_request`,
          `${agent} tool_use weather`,
          `${agent} tool_result weather`,
          `${agent} model_response`,
          `${agent} model_request`,
          `${agent} model_response`,
          `${agent} agent_end`,
        ];
  const single = (agent: string): string[] => [
    `${agent} agent_start`,
    `${agent} model_request`,
    `${agent} model_response`,
    `${agent} agent_end`,
  ];
  const hasAgentClass = major >= 5;
  const hasApproval = major >= 6;

  it("typechecks every surface program as a customer's nodenext project", () => {
    expect(typecheck(fixture, "tsconfig.surfaces.json")).toBe("");
  });

  describe.each(FORMATS)("as %s", (format) => {
    const run = (scenario: string, { expectNote = false } = {}) => {
      const result = runAgent(fixture, format, scenario, {}, "surfaces");
      expect(result.status, describeTrace(result)).toBe(0);
      const lines = result.stderr.split("\n").filter((line) => line.includes("[failproofai-sdk]"));
      if (expectNote) {
        expect(lines, describeTrace(result)).toHaveLength(1);
        expect(lines[0], describeTrace(result)).toContain("registerGlobalTracer");
      } else {
        expect(lines, describeTrace(result)).toEqual([]);
      }
      return result;
    };
    /** Every JSON line the program reported, merged. */
    const reported = (result: { stdout: string }): Record<string, unknown> =>
      Object.assign(
        {},
        ...result.stdout
          .trim()
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      ) as Record<string, unknown>;
    const clean = (result: ReturnType<typeof run>) =>
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);

    // ---- 1. the agent classes (ai 5 Experimental_Agent, ai 6/7 ToolLoopAgent)

    it.each(["agent-generate", "agent-stream"])("%s: one agent per call, named by the agent's functionId", (scenario) => {
      const result = run(scenario);
      if (!hasAgentClass) {
        expect(reported(result).skipped).toBe("no agent class");
        expect(result.events).toEqual([]);
        return;
      }
      expect(shape(result.events), describeTrace(result)).toEqual(
        scenario === "agent-generate" ? loop("support-agent") : streamed("support-agent"),
      );
      clean(result);
      expect(tokens(result.events)).toEqual([
        [11, 7],
        [23, 9],
      ]);
      expect(ofType(result.events, "tool_use")[0]!.tool_call_id).toBe("call-1");
      expect(reported(result).text).toBe("It is 20C in Paris.");
    });

    it("agent-id: an agent's own `id` never reaches telemetry, so without a functionId it is named after the operation", () => {
      // ToolLoopAgent spreads its settings into generateText, which drops `id`;
      // no span attribute (v4–v6) and no v7 event carries it. `functionId` in
      // the agent's telemetry settings is what names it.
      const result = run("agent-id");
      if (!hasAgentClass) return;
      expect(shape(result.events), describeTrace(result)).toEqual(loop("ai.generateText"));
      clean(result);
    });

    it.each(["agent-instrument", "agent-instrument-stream"])(
      "%s: instrument('ai') records an agent on ai 7, and on ai 5–6 records nothing and says so",
      (scenario) => {
        const result = run(scenario, { expectNote: hasAgentClass && major < 7 });
        if (!hasAgentClass) return;
        if (major >= 7) {
          expect(shape(result.events), describeTrace(result)).toEqual(loop("support-agent"));
          clean(result);
        } else {
          expect(result.events, describeTrace(result)).toEqual([]);
        }
        expect(reported(result).text).toBe("It is 20C in Paris.");
      },
    );

    it("agent-instrument-bare: with no telemetry setting at all, ai 7 still records the agent", () => {
      const result = run("agent-instrument-bare");
      if (!hasAgentClass) return;
      if (major >= 7) {
        expect(shape(result.events), describeTrace(result)).toEqual(loop("ai.generateText"));
        clean(result);
      } else {
        // v5–v6 consult no tracer unless the call sets isEnabled.
        expect(result.events, describeTrace(result)).toEqual([]);
      }
    });

    it("agent-wrap: a wrapped model under an agent with no enclosing scope records each step as its own run", () => {
      const result = run("agent-wrap");
      if (!hasAgentClass) return;
      // wrapModel sees model calls only: the tool loop above it is invisible.
      expect(shape(result.events), describeTrace(result)).toEqual([...single("mock-model"), ...single("mock-model")]);
      clean(result);
      expect(new Set(result.events.map((e) => e.session_id)).size).toBe(2);
      expect(tokens(result.events)).toEqual([
        [11, 7],
        [23, 9],
      ]);
    });

    it("agent-wrap-in-scope: inside agent(), the agent's wrapped model calls are steps of that agent", () => {
      const result = run("agent-wrap-in-scope");
      if (!hasAgentClass) return;
      expect(shape(result.events), describeTrace(result)).toEqual([
        "support-agent agent_start",
        "support-agent model_request",
        "support-agent model_response",
        "support-agent model_request",
        "support-agent model_response",
        "support-agent agent_end",
      ]);
      clean(result);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["req-1"]));
    });

    // ---- 2. embeddings: an agent only when nothing encloses them

    it("embed: a bare embed() is its own run, named by functionId, with its token count", () => {
      const result = run("embed");
      expect(shape(result.events), describeTrace(result)).toEqual(single("indexer"));
      clean(result);
      const response = ofType(result.events, "model_response")[0]!;
      expect(response.input_tokens).toBe(3);
      expect(response.model).toBe("mock-embedder");
    });

    it("embed-many: a bare embedMany() is one run with a model pair per provider call", () => {
      const result = run("embed-many");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "ai.embedMany agent_start",
        "ai.embedMany model_request",
        "ai.embedMany model_response",
        "ai.embedMany model_request",
        "ai.embedMany model_response",
        "ai.embedMany agent_end",
      ]);
      clean(result);
      // maxEmbeddingsPerCall: 2 → three values are two provider calls.
      expect(ofType(result.events, "model_response").map((e) => e.input_tokens)).toEqual([6, 3]);
    });

    it("embed-in-agent: inside agent(), embeddings are model calls of that agent — no nested agents", () => {
      const result = run("embed-in-agent");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "rag agent_start",
        "rag model_request",
        "rag model_response",
        "rag model_request",
        "rag model_response",
        "rag model_request",
        "rag model_response",
        "rag agent_end",
      ]);
      clean(result);
    });

    it("embed-in-tool: an embedding inside a tool is a model call of the agent that ran the tool", () => {
      const result = run("embed-in-tool");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "weather-agent agent_start",
        "weather-agent model_request",
        "weather-agent model_response",
        "weather-agent tool_use weather",
        "weather-agent model_request",
        "weather-agent model_response",
        "weather-agent tool_result weather",
        "weather-agent model_request",
        "weather-agent model_response",
        "weather-agent agent_end",
      ]);
      clean(result);
      expect(ofType(result.events, "model_request").map((e) => e.model)).toEqual(["mock-model", "mock-embedder", "mock-model"]);
    });

    // ---- 3. structured output

    it("object-partial: streamObject's partialObjectStream, consumed to the end, is one agent", () => {
      const result = run("object-partial");
      expect(shape(result.events), describeTrace(result)).toEqual(single("extractor"));
      clean(result);
      expect(reported(result).object).toEqual({ city: "Paris" });
      expect(reported(result).partials).toContainEqual({ city: "Paris" });
      expect(tokens(result.events)).toEqual([[5, 3]]);
    });

    it("object-invalid: a schema failure is one error on the failed agent, after the model's answer", () => {
      const result = run("object-invalid");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "extractor agent_start",
        "extractor model_request",
        "extractor model_response",
        "extractor error",
        "extractor agent_end",
      ]);
      clean(result);
      expect(ofType(result.events, "error")[0]!.message).toMatch(/did not match schema/);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("failed");
      expect(reported(result).threw).toBe("AI_NoObjectGeneratedError");
    });

    it.each(["text-output", "stream-output"])("%s: generateText / streamText with Output.object is one agent", (scenario) => {
      const result = run(scenario);
      expect(shape(result.events), describeTrace(result)).toEqual(single("extractor"));
      clean(result);
      expect(tokens(result.events)).toEqual([[5, 3]]);
      if (scenario === "text-output") expect(reported(result).output).toEqual({ city: "Paris" });
      else expect(reported(result).last).toEqual({ city: "Paris" });
    });

    // ---- 4. tool features

    it("parallel-tools: two calls in one step pair on the model's own ids, whatever order they finish in", () => {
      const result = run("parallel-tools");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "weather-agent agent_start",
        "weather-agent model_request",
        "weather-agent model_response",
        "weather-agent tool_use weather",
        "weather-agent tool_use weather",
        "weather-agent tool_result weather",
        "weather-agent tool_result weather",
        "weather-agent model_request",
        "weather-agent model_response",
        "weather-agent agent_end",
      ]);
      clean(result);
      const uses = ofType(result.events, "tool_use");
      expect(uses.map((e) => [e.tool_call_id, e.input])).toEqual([
        ["call-p1", { city: "Paris" }],
        ["call-p2", { city: "Rome" }],
      ]);
      // Rome returned first.
      expect(ofType(result.events, "tool_result").map((e) => [e.tool_call_id, e.output])).toEqual([
        ["call-p2", { city: "Rome", celsius: 16 }],
        ["call-p1", { city: "Paris", celsius: 20 }],
      ]);
      // The step's content lists both calls, inputs parsed, on every major.
      expect(ofType(result.events, "model_response")[0]!.content).toEqual([
        { toolCallId: "call-p1", toolName: "weather", input: { city: "Paris" } },
        { toolCallId: "call-p2", toolName: "weather", input: { city: "Rome" } },
      ]);
    });

    it("client-tool: a tool with no execute is a call in the model's answer, never a tool_use left open", () => {
      const result = run("client-tool");
      expect(shape(result.events), describeTrace(result)).toEqual(single("weather-agent"));
      clean(result);
      const response = ofType(result.events, "model_response")[0]!;
      expect(response.stop_reason).toBe("tool-calls");
      expect(response.content).toEqual([{ toolCallId: "call-c1", toolName: "ask", input: { city: "Paris" } }]);
      expect(reported(result).toolCalls).toBe(1);
    });

    it("tool-choice-required: a forced tool call is recorded like any other", () => {
      const result = run("tool-choice-required");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "weather-agent agent_start",
        "weather-agent model_request",
        "weather-agent model_response",
        "weather-agent tool_use weather",
        "weather-agent tool_result weather",
        "weather-agent agent_end",
      ]);
      clean(result);
    });

    it("repair: the tool_use carries the REPAIRED input", () => {
      const result = run("repair");
      expect(shape(result.events), describeTrace(result)).toEqual(loop("weather-agent"));
      clean(result);
      // v4–v6 record the step as the model produced it; v7's
      // onLanguageModelCallEnd already carries the repaired call.
      expect(ofType(result.events, "model_response")[0]!.content).toEqual([
        { toolCallId: "call-r1", toolName: "weather", input: major >= 7 ? { city: "Paris" } : { town: "Paris" } },
      ]);
      const use = ofType(result.events, "tool_use")[0]!;
      expect([use.tool_call_id, use.input]).toEqual(["call-r1", { city: "Paris" }]);
    });

    it("prepare-step: a model switched by prepareStep is named on its own step", () => {
      const result = run("prepare-step");
      expect(shape(result.events), describeTrace(result)).toEqual(loop("weather-agent"));
      clean(result);
      expect(ofType(result.events, "model_response").map((e) => e.model)).toEqual(["mock-model", "mock-model-large"]);
    });

    it("unknown-tool: a call to a tool that does not exist", () => {
      const result = run("unknown-tool");
      clean(result);
      if (major >= 5) {
        // v5+ hands the model a tool error and the loop carries on; the SDK
        // opens no tool span / execution for a tool it does not have.
        expect(shape(result.events), describeTrace(result)).toEqual([
          "weather-agent agent_start",
          "weather-agent model_request",
          "weather-agent model_response",
          "weather-agent model_request",
          "weather-agent model_response",
          "weather-agent agent_end",
        ]);
        expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
      } else {
        // v4 throws NoSuchToolError out of generateText.
        expect(shape(result.events), describeTrace(result)).toEqual([
          "weather-agent agent_start",
          "weather-agent model_request",
          "weather-agent model_response",
          "weather-agent error",
          "weather-agent agent_end",
        ]);
        expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("failed");
        expect(reported(result).threw).toBe("AI_NoSuchToolError");
      }
    });

    it("approval: a tool that needs approval runs in the call that carries the approval", () => {
      const result = run("approval");
      if (!hasApproval) {
        expect(reported(result).skipped).toBe("no tool approval");
        return;
      }
      // Two calls, two runs: the first ends with the model's request for
      // approval (a tool call in its content, nothing executed); the second
      // executes the approved tool, then answers. Put both in one
      // failproofai.session() to see them in one session.
      expect(shape(result.events), describeTrace(result)).toEqual([
        ...single("travel-agent"),
        "travel-agent agent_start",
        "travel-agent tool_use book",
        "travel-agent tool_result book",
        "travel-agent model_request",
        "travel-agent model_response",
        "travel-agent agent_end",
      ]);
      clean(result);
      expect(ofType(result.events, "tool_use")[0]!.tool_call_id).toBe("call-a1");
      expect(reported(result)).toMatchObject({ pending: 1, text: "Booked Paris." });
    });

    // ---- 5. consuming a stream

    it.each(["stream-full", "stream-response", "stream-on-finish"])("%s: records the whole loop", (scenario) => {
      const result = run(scenario);
      expect(shape(result.events), describeTrace(result)).toEqual(streamed("weather-agent"));
      clean(result);
      expect(tokens(result.events)).toEqual([
        [11, 7],
        [23, 9],
      ]);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
      const report = reported(result);
      if (scenario === "stream-response") expect(report).toMatchObject({ status: 200, containsAnswer: true });
      if (scenario === "stream-on-finish") expect(report.finished).toBe("It is 20C in Paris.");
    });

    it("stream-abort: an AbortSignal mid-stream closes the model call and the agent as cancelled", () => {
      const result = run("stream-abort");
      expect(shape(result.events), describeTrace(result)).toEqual(single("counter"));
      clean(result);
      expect(ofType(result.events, "model_response")[0]!.stop_reason).toBe("cancelled");
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("cancelled");
      expect(count(result.events, "error")).toBe(0);
      expect(reported(result).after).toEqual({ openCalls: 0, stats: { runs: 0, links: 0 } });
    });

    it("stream-response-cancel-signal: a client that disconnects from a route passing abortSignal ends cancelled", () => {
      const result = run("stream-response-cancel-signal");
      expect(shape(result.events), describeTrace(result)).toEqual(single("counter"));
      clean(result);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("cancelled");
      expect(reported(result).after).toEqual({ openCalls: 0, stats: { runs: 0, links: 0 } });
    });

    it.each(["stream-response-cancel", "stream-unconsumed"])(
      "%s: a stream nobody finishes reading is closed once it is garbage (ai 4–6); ai 7 cannot see it",
      (scenario) => {
        const result = run(scenario);
        const report = reported(result);
        if (major >= 7) {
          // v7 fires no telemetry callback when the consumer cancels or never
          // reads, and hands the integration no per-call object whose
          // collection could stand in for one: the agent stays open. Bounded
          // (MAX_OPEN_CALLS), and avoidable by passing the request's
          // abortSignal — see stream-response-cancel-signal.
          expect(count(result.events, "agent_start"), describeTrace(result)).toBe(1);
          expect(count(result.events, "agent_end"), describeTrace(result)).toBe(0);
          expect(report.after).toMatchObject({ openCalls: 1 });
          return;
        }
        // v4–v6: the SDK ends a stream's root span from a flush() that never
        // runs; the adapter ends it when the span is collected.
        clean(result);
        const end = ofType(result.events, "agent_end")[0]!;
        expect(end.outcome, describeTrace(result)).toBe("cancelled");
        expect(end.fw_abandoned).toBe(true);
        // (`report.before` is not asserted: an ordinary collection may already
        // have closed it by then.)
        expect(report.after).toEqual({ openCalls: 0, stats: { runs: 0, links: 0 } });
      },
    );

    it("stream-error: a provider stream that breaks mid-way leaves nothing open", () => {
      const result = run("stream-error");
      expect(shape(result.events), describeTrace(result)).toEqual(single("counter"));
      clean(result);
      expect(reported(result).threw).toBe("connection reset");
      expect(reported(result).after).toEqual({ openCalls: 0, stats: { runs: 0, links: 0 } });
      const response = ofType(result.events, "model_response")[0]!;
      const end = ofType(result.events, "agent_end")[0]!;
      if (major >= 7) {
        expect(response.stop_reason).toBe("error");
        expect(response.error).toMatch(/connection reset/);
        expect(end.outcome).toBe("failed");
      } else {
        // v4–v6 never end either span nor report the error to the tracer; the
        // operation is closed when it is collected, and cannot say why.
        expect(response.stop_reason).toBe("cancelled");
        expect(end.outcome).toBe("cancelled");
        expect(end.fw_abandoned).toBe(true);
      }
    });

    // ---- 6. reasoning models

    it.each(["reasoning-generate", "reasoning-stream", "reasoning-wrap"])(
      "%s: reasoning parts leave the token count and the answer intact",
      (scenario) => {
        const result = run(scenario);
        expect(shape(result.events), describeTrace(result)).toEqual(single(scenario === "reasoning-wrap" ? "mock-model" : "thinker"));
        clean(result);
        const response = ofType(result.events, "model_response")[0]!;
        expect([response.input_tokens, response.output_tokens]).toEqual([12, 20]);
        expect(response.stop_reason).toBe("stop");
        expect(response.content).toBe("Paris.");
        expect(reported(result).text).toBe("Paris.");
      },
    );

    // ---- 7. concurrency

    it.each(["concurrent", "concurrent-stream"])("%s: 10 concurrent calls in one session are 10 agents with no cross-talk", (scenario) => {
      const result = run(scenario);
      clean(result);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["busy"]));
      const starts = ofType(result.events, "agent_start").map((e) => e.agent_id).sort();
      expect(starts).toEqual(Array.from({ length: 10 }, (_, i) => `worker-${i}`).sort());
      for (let i = 0; i < 10; i += 1) {
        const mine = result.events.filter((e) => e.agent_id === `worker-${i}`);
        expect(mine.map((e) => e.type).sort(), describeTrace(result)).toEqual(
          ["agent_end", "agent_start", "model_request", "model_request", "model_response", "model_response", "tool_result", "tool_use"],
        );
        expect(ofType(mine, "tool_use")[0]!.tool_call_id).toBe(`call-${i}`);
        expect(ofType(mine, "tool_use")[0]!.input).toEqual({ city: `city-${i}` });
        expect(ofType(mine, "tool_result")[0]!.tool_call_id).toBe(`call-${i}`);
        expect(tokens(mine)).toEqual([
          [100 + i, 1],
          [200 + i, 2],
        ]);
        // Each response pairs with a request of the SAME agent.
        const requests = new Set(ofType(mine, "model_request").map((e) => e.request_id));
        for (const response of ofType(mine, "model_response")) expect(requests.has(response.request_id)).toBe(true);
      }
      expect(reported(result).texts).toEqual(Array.from({ length: 10 }, (_, i) => `answer ${i}`));
    });

    it("concurrent-unscoped: 10 concurrent same-named calls outside any scope are 10 sessions of one agent each", () => {
      const result = run("concurrent-unscoped");
      clean(result);
      const sessions = new Map<string, Event[]>();
      for (const e of result.events) sessions.set(e.session_id, [...(sessions.get(e.session_id) ?? []), e]);
      expect(sessions.size).toBe(10);
      for (const events of sessions.values()) {
        expect(shape(events)).toEqual(loop("worker"));
        const i = Number(String(ofType(events, "tool_use")[0]!.tool_call_id).split("-")[1]);
        expect(tokens(events)).toEqual([
          [100 + i, 1],
          [200 + i, 2],
        ]);
      }
    });

    it("concurrent-wrap: 10 concurrent bare wrapped-model calls are 10 runs, each its own model's", () => {
      const result = run("concurrent-wrap");
      clean(result);
      const sessions = new Map<string, Event[]>();
      for (const e of result.events) sessions.set(e.session_id, [...(sessions.get(e.session_id) ?? []), e]);
      expect(sessions.size).toBe(10);
      for (const events of sessions.values()) {
        const name = events[0]!.agent_id;
        expect(shape(events)).toEqual(single(name));
        expect(tokens(events)).toEqual([[100 + Number(name.split("-")[1]), 1]]);
      }
    });
  });
});
