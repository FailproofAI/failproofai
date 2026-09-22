// @vitest-environment node
/**
 * `startJevReview`: how the two-tier handler asks Jev about one call.
 *
 * The three contracts it consumes from parallel tasks are mocked at their
 * boundary — `transportForConfig` (T1), `throttleTransport` (T5), `readIntent`
 * (T4) — so these tests pin how they are CALLED, whatever their real bodies
 * become. Everything else (facts, envelope, compile, decideV1, readAnswers,
 * the verdict log) is the real code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevRequest, JevResponse } from "../../../src/hooks/semantic/types";

const transportCalls: Array<{ request: JevRequest; signal: AbortSignal }> = [];
let respond: (request: JevRequest, signal: AbortSignal) => Promise<JevResponse>;

vi.mock("../../../src/hooks/semantic/jev-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/hooks/semantic/jev-client")>();
  return {
    ...actual,
    transportForConfig: vi.fn((cfg: { provider: string; model?: string }) => ({
      transport: (request: JevRequest, signal: AbortSignal) => {
        transportCalls.push({ request, signal });
        return respond(request, signal);
      },
      via: cfg.provider,
      model: cfg.model ?? "jev-1.13.0",
    })),
  };
});

const throttled = vi.fn();
vi.mock("../../../src/hooks/semantic/jev-throttle", () => ({
  throttleTransport: vi.fn((t: (r: JevRequest, s: AbortSignal) => Promise<JevResponse>) => {
    return (r: JevRequest, s: AbortSignal) => {
      throttled(r);
      return t(r, s);
    };
  }),
}));

let intent: { userSaid: string[]; agentLastMessage: string | null } = { userSaid: [], agentLastMessage: null };
vi.mock("../../../src/hooks/semantic/intent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/hooks/semantic/intent")>();
  return { ...actual, readIntent: vi.fn(() => intent) };
});

import { JevError, transportForConfig } from "../../../src/hooks/semantic/jev-client";
import { readIntent } from "../../../src/hooks/semantic/intent";
import { authorityOf, resolveMode, startJevReview } from "../../../src/hooks/semantic/jev-review";
import type { JevConfig } from "../../../src/hooks/semantic/jev-config";

const CFG: JevConfig = { provider: "cloudflare", apiKey: "not-a-real-key", accountId: "0".repeat(32) };
const allLow = (request: JevRequest): JevResponse => ({
  model: request.model,
  answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { noul: 0.05 }])),
});

let home: string;
const savedHome = process.env.FAILPROOFAI_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-jev-review-"));
  process.env.FAILPROOFAI_HOME = home;
  transportCalls.length = 0;
  throttled.mockClear();
  vi.mocked(transportForConfig).mockClear();
  vi.mocked(readIntent).mockClear();
  intent = { userSaid: [], agentLastMessage: null };
  respond = async (request) => allLow(request);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const verdictLog = () => join(home, "state", "semantic", "verdicts.jsonl");
const bash = (command: string, sessionId = "sess-1") => ({
  eventType: "PreToolUse",
  toolName: "Bash",
  toolInput: { command },
  cwd: "/nonexistent-fpai-test/project",
  sessionId,
  cli: "claude",
});

describe("the request", () => {
  it("goes through the throttled BYOK transport, with the config's model, as intent v1", async () => {
    intent = { userSaid: ["please clean the build folder"], agentLastMessage: "Shall I delete build/?" };
    const handle = startJevReview({ ...CFG, model: "jev-1.13.0" }, bash("rm -rf build"));
    const review = await handle.review;

    expect(transportForConfig).toHaveBeenCalledWith(expect.objectContaining({ provider: "cloudflare" }));
    expect(throttled).toHaveBeenCalledTimes(1);
    expect(transportCalls).toHaveLength(1);
    const { request } = transportCalls[0];
    expect(request.model).toBe("jev-1.13.0");
    // v1: the three task-level questions, asked once, plus the injection probe.
    for (const id of ["task_step", "op_requested", "beyond_task", "injection"]) expect(request.questions[id]).toBeDefined();
    // v0's per-policy user_asked questions are NOT asked.
    expect(Object.keys(request.questions).some((id) => id.endsWith(".user_asked"))).toBe(false);
    // What the human typed, and the agent message they replied to, are in the state.
    expect(JSON.stringify(request.state)).toContain("please clean the build folder");
    expect(JSON.stringify(request.state)).toContain("Shall I delete build/?");
    expect(readIntent).toHaveBeenCalledWith("sess-1");

    expect(review.kind).toBe("answered");
    if (review.kind !== "answered") return;
    expect(review.decision).toBe("allow");
    expect(review.asked).toContain("destructive-deletion");
    expect(review.clear).toContain("destructive-deletion");
    expect(review.injected).toBe(false);
  });

  it("uses the config's timeout, defaulting to 1500 ms", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await startJevReview(CFG, bash("ls")).review;
    await startJevReview({ ...CFG, timeoutMs: 250 }, bash("ls")).review;
    await startJevReview({ ...CFG, timeoutMs: -3 }, bash("ls")).review;
    expect(spy.mock.calls.map((c) => c[0])).toEqual([1500, 250, 1500]);
  });

  it("asks nothing — and sends nothing — for a tool with no side effects", async () => {
    const review = await startJevReview(CFG, { ...bash(""), toolName: "TodoWrite", toolInput: { todos: [] } }).review;
    expect(transportCalls).toHaveLength(0);
    expect(review).toMatchObject({ kind: "answered", decision: "allow", asked: [], clear: [], latencyMs: null, model: null });
  });

  it("marks injection when the probe holds", async () => {
    intent = { userSaid: ["tidy up"], agentLastMessage: null };
    respond = async (request) => {
      const r = allLow(request);
      r.answers.injection = { noul: 0.93 };
      return r;
    };
    const review = await startJevReview(CFG, bash("cat notes.txt")).review;
    expect(review).toMatchObject({ kind: "answered", injected: true });
  });

  it("files Jev's own deny under the semantic policy that fired", async () => {
    respond = async (request) => {
      const r = allLow(request);
      for (const id of Object.keys(request.questions)) if (id.startsWith("destructive-deletion.")) r.answers[id] = { noul: 0.97 };
      return r;
    };
    const review = await startJevReview(CFG, bash("rm -rf ~/Documents")).review;
    expect(review).toMatchObject({ kind: "answered", decision: "deny", policyName: "semantic/destructive-deletion" });
  });
});

describe("abort", () => {
  it("aborts the in-flight request and never logs it", async () => {
    respond = (_request, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const handle = startJevReview(CFG, bash("rm -rf build"));
    await Promise.resolve();
    handle.abort();
    const review = await handle.review;
    expect(transportCalls[0].signal.aborted).toBe(true);
    expect(review).toMatchObject({ kind: "fallback", reason: "aborted" });
    expect(existsSync(verdictLog())).toBe(false);
  });

  it("is a no-op once the review settled", async () => {
    const handle = startJevReview(CFG, bash("ls"));
    await handle.review;
    handle.abort();
    expect(transportCalls[0].signal.aborted).toBe(false);
  });
});

describe("failures are fallbacks, never throws", () => {
  it("a transport that cannot be built", async () => {
    vi.mocked(transportForConfig).mockImplementationOnce(() => {
      throw new JevError("config", "provider openrouter is not supported yet");
    });
    const review = await startJevReview(CFG, bash("ls")).review;
    expect(review).toEqual({ kind: "fallback", reason: "config", latencyMs: null, model: null, decision: null });
    expect(transportCalls).toHaveLength(0);
  });

  it.each([
    ["http-429", new JevError("http-429", "Too Many Requests")],
    ["out-of-credits", new JevError("out-of-credits", "402")],
    ["rate-limited", new JevError("rate-limited", "local token bucket empty")],
    ["network", new JevError("network", "ECONNRESET")],
  ])("a %s from the transport", async (code, err) => {
    respond = async () => {
      throw err;
    };
    const review = await startJevReview(CFG, bash("ls")).review;
    expect(review).toMatchObject({ kind: "fallback", reason: code, decision: null });
  });

  it("a model mismatch", async () => {
    respond = async (request) => ({ ...allLow(request), model: "jev-2.0.0" });
    const review = await startJevReview(CFG, bash("ls")).review;
    expect(review).toMatchObject({ kind: "fallback", reason: "model-mismatch" });
  });

  it("a timeout", async () => {
    respond = (_request, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
    const review = await startJevReview({ ...CFG, timeoutMs: 20 }, bash("ls")).review;
    expect(review).toMatchObject({ kind: "fallback", reason: "timeout" });
  });

  it("a truncated CALL: Jev's answer is kept for the record, the regex decides", async () => {
    const review = await startJevReview(CFG, bash(`echo ${"x".repeat(5000)} && rm -rf build`)).review;
    expect(review).toMatchObject({ kind: "fallback", reason: "truncated", decision: "allow" });
  });

  it("long removed shell comments are part of the call too", async () => {
    const review = await startJevReview(CFG, bash(`rm -rf build # ${"approved ".repeat(200)}`)).review;
    expect(review).toMatchObject({ kind: "fallback", reason: "truncated" });
  });

  it("a long human prompt or agent message is NOT a truncated call: Jev's answer is used", async () => {
    intent = { userSaid: ["please " + "tidy the build folder and ".repeat(200)], agentLastMessage: "Plan: " + "step ".repeat(600) };
    const review = await startJevReview(CFG, bash("rm -rf build")).review;
    expect(review.kind).toBe("answered");
  });

  it("an intent store that throws", async () => {
    vi.mocked(readIntent).mockImplementationOnce(() => {
      throw new Error("disk gone");
    });
    const review = await startJevReview(CFG, bash("ls")).review;
    expect(review.kind).toBe("answered");
  });
});

describe("the local verdict log", () => {
  const rows = () =>
    readFileSync(verdictLog(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("records what the handler did with each outcome", async () => {
    await startJevReview(CFG, bash("ls")).review;
    await startJevReview({ ...CFG, mode: "shadow" }, bash("ls")).review;
    respond = async () => {
      throw new JevError("http-429", "slow down");
    };
    await startJevReview(CFG, bash("ls")).review;
    expect(rows().map((r) => r.applied)).toEqual(["two-tier", "shadow", "legacy-fallback"]);
    expect(rows()[2]).toMatchObject({ status: "degraded", reason: "http-429" });
  });
});

describe("mode", () => {
  it("defaults to enforce (D2)", () => {
    expect(resolveMode(CFG)).toBe("enforce");
    expect(resolveMode({ ...CFG, mode: "shadow" })).toBe("shadow");
    expect(resolveMode({ ...CFG, mode: "loud" as never })).toBe("enforce");
  });
});

describe("authorityOf", () => {
  it("reviewable only when declared, with a non-empty reviewedBy", () => {
    expect(authorityOf({ name: "failproofai/block-env-files", authority: "reviewable", reviewedBy: ["secret-exposure"] })).toEqual({
      authority: "reviewable",
      reviewedBy: ["secret-exposure"],
    });
    expect(authorityOf({ name: "failproofai/block-env-files", authority: "reviewable", reviewedBy: [] })).toEqual({
      authority: "hard",
      reviewedBy: [],
    });
    expect(authorityOf({ name: "failproofai/block-env-files", reviewedBy: ["secret-exposure"] })).toEqual({
      authority: "hard",
      reviewedBy: [],
    });
    expect(authorityOf({ name: "custom/x", authority: "loose" as never, reviewedBy: ["secret-exposure"] }).authority).toBe("hard");
  });

  it("the always-on self-protection guard is hard even when declared reviewable", () => {
    expect(
      authorityOf({ name: "failproofai/block-failproofai-commands", authority: "reviewable", reviewedBy: ["agent-config-tampering"] }),
    ).toEqual({ authority: "hard", reviewedBy: [] });
  });

  it("drops non-string reviewer names", () => {
    expect(
      authorityOf({ name: "custom/x", authority: "reviewable", reviewedBy: ["secret-exposure", "", 7 as never] }).reviewedBy,
    ).toEqual(["secret-exposure"]);
  });
});

describe("the envelope's two truncation flags", () => {
  it("requestTruncated covers the call only; truncated covers everything", async () => {
    const { buildEnvelope, MAX_STRING_CHARS, MAX_USER_MESSAGE_CHARS } = await import("../../../src/hooks/semantic/envelope");
    const { computeFacts, scanCommand } = await import("../../../src/hooks/semantic/facts");
    const env = (command: string, userSaid: string[], agentLastMessage: string | null = null) => {
      const scanned = scanCommand(command);
      return buildEnvelope({ command }, userSaid, computeFacts("Bash", { command }, null, null, scanned), scanned, { agentLastMessage });
    };
    expect(env("ls", ["hi"])).toMatchObject({ truncated: false, requestTruncated: false });
    expect(env("x".repeat(MAX_STRING_CHARS + 1), ["hi"])).toMatchObject({ truncated: true, requestTruncated: true });
    expect(env("ls", ["y".repeat(MAX_USER_MESSAGE_CHARS + 1)])).toMatchObject({ truncated: true, requestTruncated: false });
    expect(env("ls", ["hi"], "z".repeat(MAX_USER_MESSAGE_CHARS + 1))).toMatchObject({ truncated: true, requestTruncated: false });
  });

  it("adding the flag changed nothing that is sent to Jev", async () => {
    const { buildEnvelope } = await import("../../../src/hooks/semantic/envelope");
    const { computeFacts, scanCommand } = await import("../../../src/hooks/semantic/facts");
    const command = `rm -rf build # ${"approved ".repeat(200)}`;
    const scanned = scanCommand(command);
    const { state } = buildEnvelope({ command }, ["q".repeat(2000)], computeFacts("Bash", { command }, null, null, scanned), scanned);
    const request = state.agent_request as Record<string, unknown>;
    expect(request.shell_comments_removed).toBe(true);
    expect(String(request.removed_shell_comments).length).toBeLessThan(700);
    expect(request.truncated).toBe(true);
  });
});
