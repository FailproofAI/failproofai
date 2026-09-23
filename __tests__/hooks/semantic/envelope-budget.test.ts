// @vitest-environment node
/**
 * The envelope's size is a function of its caps, and building it never throws.
 *
 * Five review rounds found five spellings of one attack: shape the tool input
 * so that the envelope comes out too big, or so that building it raises, and
 * Jev's verdict is discarded on the way in (`degraded("request-too-large")` and
 * `degraded("prepare: …")` are both `kind: "fallback"`, which carries no
 * decision). Each round patched the spelling that was reported — an uncapped
 * `facts.paths`, a shrink loop, a per-field cap — and the next round found
 * three more: an uncapped object KEY, nesting deep enough for a RangeError, a
 * key long enough to be an unredacted injection channel with `truncated` false.
 *
 * So these tests pin the PROPERTY rather than the spellings:
 *
 * 1. However the tool input is shaped, `JSON.stringify(state)` is inside
 *    `MAX_STATE_CHARS` and the compiled request is inside `MAX_REQUEST_CHARS`.
 * 2. However the tool input is shaped, `buildEnvelope` returns rather than
 *    throws, and what it drops is flagged `truncated`.
 * 3. No string anywhere in the state — VALUE or KEY — is over its cap, and
 *    every one has been through the redaction path.
 * 4. Therefore a padded call is `answered` with `truncated`, never a fallback:
 *    Jev's own deny still reaches `combineTwoTier`.
 *
 * Each `shape` below is one of the reported repros, or the obvious next one.
 */
import { describe, expect, it } from "vitest";
import { combineTwoTier } from "../../../src/hooks/semantic/combine";
import { MAX_REQUEST_CHARS, compileRequest, selectPolicies } from "../../../src/hooks/semantic/compile";
import { DEFAULT_THRESHOLDS_V1 } from "../../../src/hooks/semantic/decide";
import {
  MAX_KEYS,
  MAX_KEY_CHARS,
  MAX_STATE_CHARS,
  MAX_STRING_CHARS,
  MAX_TOKEN_CHARS,
  buildEnvelope,
} from "../../../src/hooks/semantic/envelope";
import { computeFacts, scanCommand } from "../../../src/hooks/semantic/facts";
import { evaluateSemantic, prepareSemantic, verdictLogRow, type SemanticOptions } from "../../../src/hooks/semantic/evaluator";
import { toReview } from "../../../src/hooks/semantic/jev-review";
import { SEMANTIC_POLICIES } from "../../../src/hooks/semantic/policies";
import type { Facts, JevRequest, JevResponse, SemanticInput } from "../../../src/hooks/semantic/types";

const DANGEROUS = "rm -rf / --no-preserve-root";

/** Every "does it do X" probe held; the human asked for none of it. Jev denies. */
const alarmed = async (request: JevRequest): Promise<JevResponse> => ({
  model: request.model,
  answers: Object.fromEntries(
    Object.keys(request.questions).map((id) => [id, { noul: id === "op_requested" || id === "task_step" ? 0.0 : 0.95 }]),
  ),
});

const opts: SemanticOptions = {
  transport: alarmed,
  via: "cloudflare",
  model: "jev-1.13.0",
  intent: "v1",
  v1: { thresholds: DEFAULT_THRESHOLDS_V1 },
};

const call = (toolInput: Record<string, unknown>, userSaid = ["clean up the temp dir"]): SemanticInput => ({
  eventType: "PreToolUse",
  toolName: "Bash",
  toolInput,
  cwd: "/work/project",
  userSaid,
  agentLastMessage: null,
});

/** One deeply nested value, built the way the hook's own stdin parse builds it. */
const parsedNesting = (depth: number): Record<string, unknown> =>
  JSON.parse(`{"command":${JSON.stringify(DANGEROUS)},"x":${"[".repeat(depth)}1${"]".repeat(depth)}}`);

const wide = (keys: number, chars: number): Record<string, unknown> => {
  const out: Record<string, unknown> = { command: DANGEROUS };
  for (let i = 0; i < keys; i++) out[`k${i}`] = "y".repeat(chars);
  return out;
};

const nested = (a: number, b: number, chars: number): Record<string, unknown> => {
  const out: Record<string, unknown> = { command: DANGEROUS };
  for (let i = 0; i < a; i++) {
    const inner: Record<string, unknown> = {};
    for (let j = 0; j < b; j++) inner[`k${j}`] = "z".repeat(chars);
    out[`n${i}`] = inner;
  }
  return out;
};

/** A cyclic object cannot come off `JSON.parse`, but it can come off a custom CLI shim. */
const cyclic = (): Record<string, unknown> => {
  const out: Record<string, unknown> = { command: DANGEROUS };
  out.self = out;
  return out;
};

const throwingGetter = (): Record<string, unknown> =>
  ({
    command: DANGEROUS,
    get boom(): string {
      throw new Error("no");
    },
  }) as unknown as Record<string, unknown>;

const shapes: Array<[string, Record<string, unknown>]> = [
  ["one 200,000-character KEY", { command: DANGEROUS, ["k".repeat(200_000)]: 1 }],
  ["two 60,000-character KEYs", { command: DANGEROUS, ["a".repeat(60_000)]: 1, ["b".repeat(60_000)]: 2 }],
  ["200 keys of 150,000 characters", (() => {
    const out: Record<string, unknown> = { command: DANGEROUS };
    for (let i = 0; i < 200; i++) out[`${i}${"p".repeat(150_000)}`] = 1;
    return out;
  })()],
  ["a 200,000-character value", { command: DANGEROUS, file_path: `/work/project/${"d".repeat(200_000)}` }],
  ["5,000 keys x 3,000 characters", wide(5_000, 3_000)],
  ["60 x 60 x 2,000 characters", nested(60, 60, 2_000)],
  ["nesting 25,000 deep", parsedNesting(25_000)],
  ["nesting 200,000 deep", parsedNesting(200_000)],
  ["20,000 control characters", { command: DANGEROUS, blob: "\u0000\u0001\u0002".repeat(20_000) }],
  ["20,000 unpaired surrogates", { command: DANGEROUS, blob: "\ud800".repeat(20_000) }],
  ["a 2,000,000-character command", { command: `echo ${"x".repeat(1_000_000)} ; ${DANGEROUS} ; echo ${"y".repeat(1_000_000)}` }],
  ["a cyclic object", cyclic()],
  ["a getter that throws", throwingGetter()],
  ["values JSON cannot carry", { command: DANGEROUS, a: BigInt("10000000000000000000000000000000000000000"), b: Symbol("s"), c: () => 1, d: undefined, e: NaN }],
];

/** Odd but LOSSLESS: carried whole, so `truncated` must stay false. */
const benign: Array<[string, Record<string, unknown>]> = [
  ["a __proto__ key", JSON.parse(`{"command":${JSON.stringify(DANGEROUS)},"__proto__":{"polluted":true}}`)],
  ["an ordinary call", { command: DANGEROUS, file_path: "/work/project/notes.md" }],
];

/** Every string in the state, keys included. */
function walkStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) walkStrings(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      walkStrings(v, out);
    }
  }
  return out;
}

function built(toolInput: Record<string, unknown>, userSaid = ["clean up the temp dir"]) {
  const scanned = typeof toolInput.command === "string" ? scanCommand(toolInput.command) : null;
  const facts = computeFacts("Bash", toolInput, "/work/project", null, scanned);
  return buildEnvelope(toolInput, userSaid, facts, scanned, {});
}

describe("the envelope's size is a function of its caps, not of the input", () => {
  it.each(shapes)("%s: the state stays inside MAX_STATE_CHARS", (_label, toolInput) => {
    const env = built(toolInput);
    expect(JSON.stringify(env.state).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(env.truncated).toBe(true);
  });

  it.each(benign)("%s: is carried whole and is not flagged cut", (_label, toolInput) => {
    const env = built(toolInput);
    expect(JSON.stringify(env.state).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(env.truncated).toBe(false);
  });

  it.each([...shapes, ...benign])("%s: the compiled request stays inside MAX_REQUEST_CHARS", (_label, toolInput) => {
    const prepared = prepareSemantic(call(toolInput), opts);
    expect(JSON.stringify(prepared.compiled.request).length).toBeLessThanOrEqual(MAX_REQUEST_CHARS);
    expect(prepared.oversized).toBe(false);
  });

  it("four 50,000-character human turns are bounded too", () => {
    const env = built({ command: DANGEROUS }, ["a".repeat(50_000), "b".repeat(50_000), "c".repeat(50_000), "d".repeat(50_000)]);
    expect(JSON.stringify(env.state).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
  });

  it("every axis at once is still bounded", () => {
    const worst: Record<string, unknown> = {
      ...nested(40, 40, MAX_STRING_CHARS),
      ...wide(200, 20_000),
      [`${"K".repeat(100_000)}`]: 1,
      command: `echo ${"x".repeat(200_000)} ; ${DANGEROUS}`,
      file_path: `/work/project/${"d".repeat(70_000)}`,
      path: `/work/project/${"e".repeat(70_000)}`,
      notebook_path: `/work/project/${"f".repeat(70_000)}`,
    };
    const prepared = prepareSemantic(call(worst, ["a".repeat(50_000), "b".repeat(50_000), "c".repeat(50_000)]), opts);
    expect(JSON.stringify(prepared.envelope.state).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(JSON.stringify(prepared.compiled.request).length).toBeLessThan(MAX_REQUEST_CHARS / 2);
    expect(prepared.oversized).toBe(false);
  });

  /**
   * The other half of the budget, and the only way `request-too-large` can
   * still be reached: our own questions. `MAX_STATE_CHARS` is only a bound on
   * the request if what sits beside it is far smaller than the difference.
   */
  it("the whole policy set's questions leave the state room to spare", () => {
    const facts = computeFacts("mcp__db__exec", { command: "x" }, "/work/project", null, scanCommand("x"));
    const selected = selectPolicies(SEMANTIC_POLICIES, facts);
    // An unknown (MCP) tool selects every policy with no precondition.
    expect(selected.length).toBeGreaterThan(10);
    const { request } = compileRequest(selected, {}, ["a"], "jev-1.13.0", "v1");
    const questions = JSON.stringify(request.questions).length;
    expect(questions + MAX_STATE_CHARS).toBeLessThan(MAX_REQUEST_CHARS);
    // And with the margin the constants were chosen for.
    expect(questions).toBeLessThan(40_000);
  });
});

describe("building the envelope never throws, whatever the input looks like", () => {
  it.each([...shapes, ...benign])("%s", (_label, toolInput) => {
    expect(() => built(toolInput)).not.toThrow();
    expect(() => prepareSemantic(call(toolInput), opts)).not.toThrow();
  });

  it("a __proto__ key becomes an ordinary property, not the prototype", () => {
    built(JSON.parse(`{"command":${JSON.stringify(DANGEROUS)},"__proto__":{"polluted":true}}`));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a value JSON cannot carry becomes a marker, and the call is flagged cut", () => {
    const env = built({ command: DANGEROUS, weird: Symbol("s") });
    const input = (env.state.agent_request as { input: Record<string, unknown> }).input;
    expect(input.weird).toBe("<value omitted>");
  });
});

describe("no string in the state is over its cap", () => {
  it.each(shapes)("%s", (_label, toolInput) => {
    const env = built(toolInput);
    const tokens = new Set(
      ((env.state.agent_request as { command_tokens?: string[] }).command_tokens ?? []) as string[],
    );
    for (const s of walkStrings(env.state)) {
      // `how_to_read` is ours and fixed; the rest is the caller's.
      if (s.startsWith("A coding agent has REQUESTED")) continue;
      if (tokens.has(s)) {
        expect(s.length).toBeLessThanOrEqual(MAX_TOKEN_CHARS + 24);
        continue;
      }
      expect(s.length).toBeLessThanOrEqual(MAX_STRING_CHARS);
    }
  });

  it("an object KEY is capped and redacted like any other string", () => {
    // Built at runtime so the fixture itself never carries a key-shaped token.
    const fakeKey = ["sk", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    const env = built({ command: "echo hi", [fakeKey]: "v", [`x${"p".repeat(5_000)}`]: 1 });
    const body = JSON.stringify(env.state);
    expect(body).not.toContain(fakeKey);
    expect(env.redactions).toBeGreaterThan(0);
    for (const s of walkStrings(env.state)) {
      if (s.startsWith("A coding agent has REQUESTED")) continue;
      if (s.startsWith("x") && s.includes("p")) expect(s.length).toBeLessThanOrEqual(MAX_KEY_CHARS);
    }
  });

  it("two keys that collide once cut keep the first and flag the cut", () => {
    // They differ only in the middle, which is exactly what the cap drops.
    const half = "q".repeat(MAX_KEY_CHARS * 3);
    const env = built({ command: "echo hi", [`${half}A${half}`]: 1, [`${half}B${half}`]: 2 });
    const input = (env.state.agent_request as { input: Record<string, unknown> }).input;
    // One survivor, not two, and no key is over the cap.
    expect(Object.keys(input).filter((k) => k.startsWith("q"))).toHaveLength(1);
    expect(env.truncated).toBe(true);
  });

  it("more keys than the cap are dropped and flagged", () => {
    const env = built(wide(MAX_KEYS * 3, 10));
    const input = (env.state.agent_request as { input: Record<string, unknown> }).input;
    expect(Object.keys(input).length).toBeLessThanOrEqual(MAX_KEYS);
    expect(env.truncated).toBe(true);
  });
});

/**
 * The point of all of it: a padded call is ANSWERED, so Jev's own deny still
 * reaches the combine. Each of these came back `allow` on some earlier
 * revision of this branch, through `request-too-large` or `prepare: …`.
 */
describe("a padded call still carries Jev's deny to the combine", () => {
  const padded: Array<[string, Record<string, unknown>]> = [
    ["a 200,000-character key", { command: DANGEROUS, ["k".repeat(200_000)]: 1 }],
    ["two 60,000-character keys", { command: DANGEROUS, ["a".repeat(60_000)]: 1, ["b".repeat(60_000)]: 2 }],
    ["nesting 50,000 deep", parsedNesting(50_000)],
    ["nesting 200,000 deep", parsedNesting(200_000)],
    ["a cyclic object", cyclic()],
    ["values JSON cannot carry", { command: DANGEROUS, a: BigInt("10000000000000000000000000000000000000000"), b: () => 1 }],
  ];

  it.each(padded)("%s", async (_label, toolInput) => {
    const outcome = await evaluateSemantic(call(toolInput), opts);
    expect(outcome.status).toBe("ok");
    const review = toReview(outcome);
    expect(review).toMatchObject({ kind: "answered", truncated: true, decision: "deny" });
    const out = combineTwoTier([], review, "enforce");
    expect(out.final.decision).toBe("deny");
    expect(out.activity).toMatchObject({ evaluator: "jev-fallback", jevFallbackReason: "truncated", jevDecision: "deny" });
  });

  it("control: the same command unpadded is a plain `jev` deny", async () => {
    const outcome = await evaluateSemantic(call({ command: DANGEROUS }), opts);
    const review = toReview(outcome);
    expect(review).toMatchObject({ kind: "answered", truncated: false, decision: "deny" });
    expect(combineTwoTier([], review, "enforce").activity.evaluator).toBe("jev");
  });
});

/**
 * The evidence half: when the judged command is cut, its token skeleton keeps
 * the WHOLE command in front of Jev, so padding on BOTH sides of the dangerous
 * part no longer hides it. This is the one open blocker whose repro was
 * `echo <1,250 x> ; find . -name '*.sqlite' -delete ; echo <850 y>`, which the
 * head-and-tail cap dropped into its cut middle — Jev answered about padding
 * and the deny disappeared.
 *
 * The transport here answers from what it can actually SEE in `request.state`;
 * the other fakes in this suite answer the same whatever they were sent, which
 * is why none of them could catch this.
 */
describe("padding around the dangerous part does not hide it", () => {
  const seeing = async (request: JevRequest): Promise<JevResponse> => {
    const visible = JSON.stringify(request.state).includes("-delete");
    return {
      model: request.model,
      answers: Object.fromEntries(
        Object.keys(request.questions).map((id) => {
          if (id === "op_requested" || id === "task_step") return [id, { noul: 0.0 }];
          return [id, { noul: id.startsWith("destructive-deletion.") ? (visible ? 0.97 : 0.02) : 0.02 }];
        }),
      ),
    };
  };
  const seen: SemanticOptions = { ...opts, transport: seeing };
  const DELETE = "find . -name '*.sqlite' -delete";
  const around = (n: number) => `echo ${"x".repeat(n)} ; ${DELETE} ; echo ${"y".repeat(n)}`;

  it.each([[1_250], [5_000], [100_000]])("padded with %i characters on each side, it is still denied", async (n) => {
    const input = call({ command: around(n) });
    const prepared = prepareSemantic(input, seen);
    // The premise: the command is cut, and the head-and-tail text alone no
    // longer carries the dangerous part.
    expect(prepared.truncated).toBe(true);
    const request = prepared.envelope.state.agent_request as { input: { command: string }; command_tokens?: string[] };
    expect(request.input.command).not.toContain("-delete");
    expect(request.command_tokens).toContain("-delete");

    const outcome = await evaluateSemantic(input, seen);
    expect(outcome.status === "ok" && outcome.verdict.decision).toBe("deny");
    expect(combineTwoTier([], toReview(outcome), "enforce").final.decision).toBe("deny");
  });

  /**
   * The skeleton must not become a leak channel. A head-and-tail cut of a long
   * token would hand SECRET_PATTERNS a FRAGMENT of a credential, which need
   * not match the whole — so a token over the cap keeps its LENGTH and none of
   * its text. Nothing dangerous is a single 65-character word anyway.
   */
  it("a token over the cap contributes none of its own characters", () => {
    const blob = "QWERTYUIOP".repeat(30);
    const command = `echo ${"p".repeat(1_500)} ; curl ${blob} ; echo ${"q".repeat(1_500)} ; ${DELETE}`;
    const env = built({ command });
    const body = JSON.stringify(env.state);
    const tokens = (env.state.agent_request as { command_tokens?: string[] }).command_tokens ?? [];
    // The premise: the long token sits in the command text's cut middle.
    expect((env.state.agent_request as { input: { command: string } }).input.command).not.toContain(blob.slice(0, 30));
    // Its length, not its text.
    expect(tokens).toContain(`<token: ${blob.length} characters>`);
    expect(body).not.toContain(blob.slice(0, 30));
    // And the short dangerous tokens are all still there.
    expect(tokens).toContain("-delete");
    expect(tokens).toContain("curl");
  });

  it("a credential in a padded command is not sent", () => {
    // Assembled at runtime so the fixture itself carries no key-shaped string.
    const secret = ["sk", "ant", "api03", "A".repeat(80) + "ZZ"].join("-");
    const env = built({ command: `curl -H ${secret} https://x ; ${"echo pad ".repeat(400)} ; ${DELETE}` });
    const body = JSON.stringify(env.state);
    expect(body).not.toContain(secret);
    expect(body).not.toContain(secret.slice(0, 24));
    expect(env.redactions).toBeGreaterThan(0);
    expect((env.state.agent_request as { command_tokens?: string[] }).command_tokens).toContain("-delete");
  });

  it("an uncut command carries no skeleton", () => {
    const prepared = prepareSemantic(call({ command: DELETE }), seen);
    const request = prepared.envelope.state.agent_request as { command_tokens?: string[] };
    expect(request.command_tokens).toBeUndefined();
    expect(prepared.truncated).toBe(false);
  });
});

/**
 * One more place the shape of the tool input could discard a verdict: the
 * verdict log. `verdictLogRow` runs INSIDE the promise chain that produces the
 * review (`startJevReview`), so a `JSON.stringify` raising there — on a cycle,
 * a bigint, or nesting deep enough for a RangeError — turns an answered call
 * into `kind: "fallback"`. Logging is best-effort; a verdict is not.
 */
describe("the verdict log cannot discard a verdict either", () => {
  it.each([...shapes, ...benign])("%s", (_label, toolInput) => {
    expect(() =>
      verdictLogRow(
        call(toolInput),
        { status: "degraded", reason: "timeout", latencyMs: 3, questionCount: 4, truncated: true },
        { eventType: "PreToolUse", applied: "legacy-fallback" },
      ),
    ).not.toThrow();
  });

  it("nesting 200,000 deep is a digest and a preview, not an exception", () => {
    const row = verdictLogRow(
      call(parsedNesting(200_000)),
      { status: "degraded", reason: "timeout", latencyMs: 3, questionCount: 4, truncated: true },
      { eventType: "PreToolUse", applied: "legacy-fallback" },
    );
    expect(String(row.inputDigest)).toHaveLength(16);
    expect(row.inputPreview).toBe(DANGEROUS);
  });
});

/**
 * Rule 4 again, from the other side: the envelope's inputs are not only the
 * tool input. `user_said` is read back out of T4's JSON store on disk,
 * `facts.cwd` comes off a hook payload normalized per CLI, and `agentLastMessage`
 * is snapshotted from a transcript. A `string` in the type is not a string at
 * runtime, and a raise here costs the call its verdict just the same.
 */
describe("hostile inputs other than the tool input", () => {
  const baseFacts = (): Facts => computeFacts("Bash", { command: "ls" }, "/work/project", null, scanCommand("ls"));

  const hostile: Array<[string, () => unknown]> = [
    ["tool input is null", () => buildEnvelope(null as never, ["x"], baseFacts(), null)],
    ["tool input is an array", () => buildEnvelope([1, 2] as never, ["x"], baseFacts(), null)],
    ["tool input is a string", () => buildEnvelope("hi" as never, ["x"], baseFacts(), null)],
    ["user_said is null", () => buildEnvelope({ command: "ls" }, null as never, baseFacts(), null)],
    ["user_said holds non-strings", () => buildEnvelope({ command: "ls" }, [1, null, { a: 1 }] as never, baseFacts(), null)],
    [
      "a user turn whose toString throws",
      () => buildEnvelope({ command: "ls" }, [{ toString() { throw new Error("x"); } }] as never, baseFacts(), null),
    ],
    ["facts.cwd is a number", () => buildEnvelope({ command: "ls" }, ["x"], { ...baseFacts(), cwd: 42 as never }, null)],
    ["facts.paths is null", () => buildEnvelope({ command: "ls" }, ["x"], { ...baseFacts(), paths: null as never }, null)],
    ["facts.paths holds junk", () => buildEnvelope({ command: "ls" }, ["x"], { ...baseFacts(), paths: [{}, null, 1] as never }, null)],
    ["agentLastMessage is a number", () => buildEnvelope({ command: "ls" }, ["x"], baseFacts(), null, { agentLastMessage: 7 as never })],
    [
      "a scan with no comments array",
      () =>
        buildEnvelope({ command: "ls # c" }, ["x"], baseFacts(), {
          segments: [["ls"]],
          withoutComments: "ls",
          commentsRemoved: true,
          comments: undefined as never,
        }),
    ],
    ["a proxy that throws on ownKeys", () => buildEnvelope(new Proxy({} as Record<string, unknown>, { ownKeys() { throw new Error("no"); } }), ["x"], baseFacts(), null)],
    ["a Map, a Date and a Buffer as values", () => buildEnvelope({ command: "ls", m: new Map([["a", 1]]), d: new Date(), b: Buffer.alloc(100_000) }, ["x"], baseFacts(), null)],
    ["a value whose toJSON throws", () => buildEnvelope({ command: "ls", t: { toJSON() { throw new Error("x"); } } }, ["x"], baseFacts(), null)],
    ["a null-prototype tool input", () => buildEnvelope(Object.assign(Object.create(null), { command: "ls" }), ["x"], baseFacts(), null)],
  ];

  it.each(hostile)("%s", (_label, build) => {
    let env: { state: Record<string, unknown> } | undefined;
    expect(() => {
      env = build() as { state: Record<string, unknown> };
    }).not.toThrow();
    expect(() => JSON.stringify(env!.state)).not.toThrow();
    expect(JSON.stringify(env!.state).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
  });
});
