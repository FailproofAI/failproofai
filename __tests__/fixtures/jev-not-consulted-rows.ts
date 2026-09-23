/**
 * Hook activity rows for calls Jev was NOT consulted on, exactly as the
 * two-tier combine rules record them: a hard policy denied, Jev was aborted,
 * and the row carries `{ evaluator: "jev", jevMode }` and no other Jev field
 * (`combineTwoTier`, the `not-consulted` branch, in
 * `src/hooks/semantic/combine.ts`). Persisted, they are the golden file
 * `crates/fpai-collect/tests/fixtures/hook-activity-jev-not-consulted.jsonl`
 * that the collector's tests read; `__tests__/hooks/jev-not-consulted.test.ts`
 * re-persists these and checks the golden file still matches.
 */
import type { HookActivityEntry } from "../../src/hooks/hook-activity-store";

const base = {
  eventType: "PreToolUse",
  integration: "claude",
  toolName: "Bash",
  sessionId: "sess-fixture",
  cwd: "/home/u/repo",
  permissionMode: "default",
} as const;

export const JEV_NOT_CONSULTED_ROWS: HookActivityEntry[] = [
  {
    ...base,
    timestamp: 1785740913000,
    policyName: "block-sudo",
    decision: "deny",
    reason: "sudo commands are blocked",
    durationMs: 4,
    evaluator: "jev",
    jevMode: "enforce",
  },
  {
    ...base,
    timestamp: 1785740913100,
    policyName: "block-rm-rf",
    decision: "deny",
    reason: "Recursive force deletes are blocked",
    durationMs: 3,
    evaluator: "jev",
    jevMode: "shadow",
  },
];
