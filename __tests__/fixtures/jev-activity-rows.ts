/**
 * Hook activity rows carrying the Jev fields, as the handler hands them to
 * `persistHookActivity`. Persisted, they are the golden file
 * `crates/fpai-collect/tests/fixtures/hook-activity-jev.jsonl` that the
 * collector's tests read — see `__tests__/hooks/jev-activity-rust-contract.test.ts`,
 * which re-persists these and checks the golden file still matches, so a change
 * to how the store writes these rows cannot silently leave the Rust side
 * testing a shape that no longer exists.
 *
 * Row 3's fallback reason is free text on purpose: the golden file holds what
 * the store actually wrote (a code), and the marker word "zebra" must appear
 * nowhere in it.
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

export const JEV_ACTIVITY_ROWS: HookActivityEntry[] = [
  {
    ...base,
    timestamp: 1785740912000,
    policyName: "semantic/destructive-delete",
    decision: "deny",
    reason: "Destructive delete (semantic/destructive-delete, p=0.91). Confirm with the user first.",
    durationMs: 52,
    evaluator: "jev",
    jevDecision: "deny",
    jevCleared: ["block-env-files"],
    jevLatencyMs: 38.4,
    jevModel: "jev-1.13.0",
    jevMode: "enforce",
  },
  {
    ...base,
    timestamp: 1785740912100,
    policyName: null,
    decision: "allow",
    reason: null,
    durationMs: 47,
    evaluator: "jev",
    jevDecision: "allow",
    jevCleared: ["block-read-outside-cwd"],
    jevLatencyMs: 41,
    jevModel: "jev-1.13.0",
    jevMode: "enforce",
  },
  {
    ...base,
    timestamp: 1785740912200,
    policyName: "block-env-files",
    decision: "deny",
    reason: "Reading .env files is blocked",
    durationMs: 9,
    evaluator: "jev-fallback",
    jevFallbackReason: "prepare: Unexpected token while scanning rm -rf ./zebra-archive",
    jevLatencyMs: 2,
    jevMode: "enforce",
  },
  {
    ...base,
    timestamp: 1785740912300,
    policyName: null,
    decision: "allow",
    reason: null,
    durationMs: 50,
    evaluator: "jev",
    jevDecision: "deny",
    jevCleared: [],
    jevLatencyMs: 44,
    jevModel: "typesafe/jev",
    jevMode: "shadow",
  },
  {
    ...base,
    timestamp: 1785740912400,
    policyName: null,
    decision: "allow",
    reason: null,
    durationMs: 3,
  },
];
