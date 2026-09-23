/**
 * Hook activity rows for calls Jev sent NO request for, exactly as the
 * two-tier path records them: no semantic policy applies to the tool
 * (TodoWrite, Task, Skill, AskUserQuestion, ExitPlanMode…), so the evaluator
 * compiles zero questions and answers `allow` without calling the provider
 * (`evaluateSemantic` → `via: "none"`). `toReview` then sets latency and model
 * to null but keeps the verdict, and `combineTwoTier` records
 * `{ evaluator: "jev", jevDecision: "allow", jevMode }` — no latency, no model,
 * no cleared list (it only writes one that is non-empty).
 *
 * Persisted, they are the golden file
 * `crates/fpai-collect/tests/fixtures/hook-activity-jev-no-request.jsonl` that
 * the collector's tests read; `__tests__/hooks/jev-no-request.test.ts`
 * re-persists these and checks the golden file still matches.
 */
import type { HookActivityEntry } from "../../src/hooks/hook-activity-store";

const base = {
  eventType: "PreToolUse",
  integration: "claude",
  policyName: null,
  decision: "allow",
  reason: null,
  sessionId: "sess-fixture",
  cwd: "/home/u/repo",
  permissionMode: "default",
} as const;

export const JEV_NO_REQUEST_ROWS: HookActivityEntry[] = [
  {
    ...base,
    timestamp: 1785740914000,
    toolName: "TodoWrite",
    durationMs: 3,
    evaluator: "jev",
    jevDecision: "allow",
    jevMode: "enforce",
  },
  {
    ...base,
    timestamp: 1785740914100,
    toolName: "Task",
    durationMs: 2,
    evaluator: "jev",
    jevDecision: "allow",
    jevMode: "shadow",
  },
];
