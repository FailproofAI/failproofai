import { describe, expect, it } from "vitest";

import {
  Assertion,
  ConditionResult,
  EvalResult,
  Evaluator,
  Metric,
  Score,
} from "../src/evaluator/authoring.js";
import {
  ExecutionMode,
  PROTOCOL_VERSION,
  ProtocolError,
  ResultKind,
  UnsupportedProtocolVersion,
  assignmentDefinitionFromWire,
  assignmentFromWire,
  claimResponseFromWire,
  planResponseFromWire,
  registerResponseFromWire,
  sessionTranscriptFromWire,
} from "../src/evaluator/protocol.js";
import { transcriptWire } from "./helpers.js";

/**
 * Every `fromWire` is a VALIDATOR, not a cast. The server is across a network
 * boundary: a field that arrives as a number where a string was promised has to
 * fail here, naming the field — not three frames later as an undefined property
 * nobody can explain.
 */

describe("protocol version", () => {
  it("refuses a version it does not implement", () => {
    expect(() =>
      registerResponseFromWire({ protocol_version: "3", evaluator_instance_id: "x" }),
    ).toThrow(UnsupportedProtocolVersion);
  });

  it("accepts its own", () => {
    expect(PROTOCOL_VERSION).toBe("2");
  });
});

describe("wire validation", () => {
  const assignment = {
    assignment_id: "a1",
    lease_generation: 1,
    lease_expires_at: "2026-01-01T00:02:00Z",
    session_id: "s1",
    session_revision_id: "r1",
    agent_id: "main",
    environment: "dev",
    trigger_reason: "session_end",
    event_count: 3,
    transcript_url: "/v1/evaluator/assignments/a1/transcript",
  };

  it("reads a well-formed assignment", () => {
    expect(assignmentFromWire(assignment)).toMatchObject({ assignmentId: "a1", eventCount: 3 });
  });

  it("names the offending field", () => {
    expect(() => assignmentFromWire({ ...assignment, session_id: 7 })).toThrow(
      /session_id must be a string/,
    );
    expect(() => assignmentFromWire({ ...assignment, lease_generation: 0 })).toThrow(
      /lease_generation must be greater than zero/,
    );
    expect(() => assignmentFromWire({ ...assignment, event_count: -1 })).toThrow(
      /event_count must not be negative/,
    );
  });

  it("requires execution_mode explicitly rather than defaulting to local", () => {
    // Coercing a missing value to `local` silently runs a server-authored
    // definition down the customer-local path, or the reverse.
    const definition = {
      eval_key: "k",
      display_name: "K",
      eval_version: "1",
      result_kind: "score",
      labels: [],
    };
    expect(() => assignmentDefinitionFromWire(definition)).toThrow(ProtocolError);
    expect(
      assignmentDefinitionFromWire({ ...definition, execution_mode: "local" }).executionMode,
    ).toBe(ExecutionMode.LOCAL);
    // `python` is the wire spelling of "the server authored this, sandbox it".
    expect(
      assignmentDefinitionFromWire({ ...definition, execution_mode: "python" }).executionMode,
    ).toBe(ExecutionMode.SANDBOX);
  });

  it("refuses a transcript whose event_count disagrees with its events", () => {
    const wire = transcriptWire([{ type: "tool_use" }]);
    wire.event_count = 5;
    expect(() => sessionTranscriptFromWire(wire)).toThrow(/event_count is 5/);
  });

  it("refuses a transcript schema version it does not implement", () => {
    const wire = transcriptWire();
    wire.schema_version = "9";
    expect(() => sessionTranscriptFromWire(wire)).toThrow(/unsupported transcript schema version/);
  });

  it("round-trips a transcript through toWire", () => {
    const wire = transcriptWire([{ type: "tool_use", payload: { a: 1 } }]);
    expect(sessionTranscriptFromWire(sessionTranscriptFromWire(wire).toWire()).events).toHaveLength(1);
  });

  it("refuses a non-boolean idempotent_replay", () => {
    expect(() =>
      planResponseFromWire({
        protocol_version: "2",
        assignment_id: "a1",
        assignment_status: "planned",
        runs: [],
        idempotent_replay: "yes",
      }),
    ).toThrow(/idempotent_replay must be a boolean/);
  });

  it("refuses a non-array assignments list", () => {
    expect(() => claimResponseFromWire({ protocol_version: "2", assignments: {} })).toThrow(
      /assignments must be an array/,
    );
  });
});

describe("transcript helpers", () => {
  const session = sessionTranscriptFromWire(
    transcriptWire([{ type: "tool_use" }, { type: "tool_result" }, { type: "tool_result" }]),
  );

  it("filters and counts by event type", () => {
    expect(session.count("tool_result")).toBe(2);
    expect(session.eventsOfType("tool_use")).toHaveLength(1);
    expect(session.count("absent")).toBe(0);
  });
});

describe("authoring bounds", () => {
  it("keeps a score inside 0..1", () => {
    expect(() => new Score(1.5)).toThrow(/between 0 and 1/);
    expect(() => new Score(Number.NaN)).toThrow(/must be finite/);
    expect(new Score(0.5).unit).toBe("ratio");
  });

  it("refuses control characters the server would 422 on", () => {
    // A non-retryable 422 loses a SUCCESSFUL evaluation and dead-letters its
    // assignment, so this has to fail at the line that wrote it.
    expect(() => new EvalResult({ reasoning: "line\u0000break" })).toThrow(
      /must not contain control characters/,
    );
    // Real multi-line reasoning is fine.
    expect(() => new EvalResult({ reasoning: "line\nbreak\ttab" })).not.toThrow();
  });

  it("normalizes and de-duplicates labels", () => {
    expect(new EvalResult({ score: new Score(1), labels: ["b", "a"] }).labels).toEqual(["a", "b"]);
    expect(() => new EvalResult({ labels: ["a", "a"] })).toThrow(/must be unique/);
  });

  it("requires at least one result", () => {
    expect(() => new EvalResult({}).resultItems("k")).toThrow(/must contain a score, metric/);
  });

  it("attaches the eval's reasoning to the PRIMARY result of a non-score eval", () => {
    const items = new EvalResult({
      metrics: { latency: 12, other: 3 },
      reasoning: "because",
    }).resultItems("latency");
    expect(items.find((item) => item.resultKey === "latency")!.reasoning).toBe("because");
    expect(items.find((item) => item.resultKey === "other")!.reasoning).toBeNull();
  });

  it("coerces a bare number or boolean into a Metric or an Assertion", () => {
    const items = new EvalResult({ metrics: { a: 1 }, assertions: { b: true } }).resultItems("a");
    expect(items.map((item) => item.resultKind)).toEqual([ResultKind.METRIC, ResultKind.ASSERTION]);
    expect(new Metric(1).unit).toBe("");
    expect(new Assertion(true).passed).toBe(true);
  });

  it("validates a condition's reason code as a key", () => {
    expect(() => new ConditionResult(false, "Not A Key")).toThrow(/must match/);
    expect(new ConditionResult(false).reasonCode).toBe("condition_false");
  });
});

describe("Evaluator registry", () => {
  it("validates the eval key shape", () => {
    const app = new Evaluator({ name: "n", version: "1" });
    expect(() => app.eval("Bad-Key", { version: "1" }, () => new EvalResult())).toThrow(/must match/);
  });

  it("refuses a duplicate key", () => {
    const app = new Evaluator({ name: "n", version: "1" });
    app.eval("a", { version: "1" }, () => new EvalResult());
    expect(() => app.eval("a", { version: "2" }, () => new EvalResult())).toThrow(/duplicate/);
  });

  it("derives a display name from the key", () => {
    const app = new Evaluator({ name: "n", version: "1" });
    app.eval("tool_success_rate", { version: "1" }, () => new EvalResult());
    expect(app.definition("tool_success_rate").displayName).toBe("Tool success rate");
  });

  it("produces a stable catalog revision that changes with the catalog", () => {
    const build = (version: string): string => {
      const app = new Evaluator({ name: "n", version: "1" });
      app.eval("b", { version }, () => new EvalResult());
      app.eval("a", { version: "1" }, () => new EvalResult());
      return app.catalogRevision;
    };
    expect(build("1")).toBe(build("1"));
    expect(build("1")).not.toBe(build("2"));
    expect(build("1")).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Sorted, so registration order cannot change the hash.
    const app = new Evaluator({ name: "n", version: "1" });
    app.eval("z", { version: "1" }, () => new EvalResult());
    app.eval("a", { version: "1" }, () => new EvalResult());
    expect(app.catalog().map((item) => item.evalKey)).toEqual(["a", "z"]);
  });
});
