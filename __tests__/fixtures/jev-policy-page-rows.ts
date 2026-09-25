/**
 * Hook activity rows carrying the two things FailproofAI Cloud's policy page
 * reads about Jev (contract §5), exactly as the two-tier handler writes them:
 *
 *   A. enforce mode, Jev's own verdict decided the call: `policyName` is
 *      `semantic/<check>` and `policySource` is `jev` (it used to be omitted,
 *      so the chart filed every Jev block under "unattributed");
 *   B. shadow mode, Jev's own verdict was deny / instruct while the regex
 *      result (allow) was enforced: the verdict is a "would have" in
 *      `observed`, `{policyId, version, decision, reason}`, the list
 *      observe-mode cloud and pack policies already use.
 *
 * `__tests__/hooks/two-tier-handler.test.ts` ("what the policy page reads")
 * pins that the handler produces these shapes. Persisted by the store, these
 * rows are the golden file
 * `crates/fpai-collect/tests/fixtures/hook-activity-jev-policy-page.jsonl`
 * that `crates/fpai-collect/tests/hooks_jev.rs` reads;
 * `__tests__/hooks/jev-policy-page-golden.test.ts` re-persists them and checks
 * the golden file still matches.
 */
import type { HookActivityEntry } from "../../src/hooks/hook-activity-store";

const base = {
  eventType: "PreToolUse",
  integration: "claude",
  toolName: "Bash",
  sessionId: "sess-policy-page",
  cwd: "/home/u/repo",
  permissionMode: "default",
  hookEventName: "PreToolUse",
} as const;

const DELETION_REASON =
  "Tried to permanently delete data that cannot be regenerated (semantic/destructive-deletion, p=0.97). " +
  "This permanently deletes data that cannot be rebuilt. Confirm the exact paths with the user first.";
const SYSTEM_REASON =
  "Tried to change the system outside the project (semantic/system-modification, p=0.90). " +
  "This changes the machine outside the project. Mention it to the user.";

export const JEV_POLICY_PAGE_ROWS: HookActivityEntry[] = [
  // A — enforce: Jev decided.
  {
    ...base,
    timestamp: 1785740915000,
    policyName: "semantic/destructive-deletion",
    policyNames: ["semantic/destructive-deletion"],
    matchedPolicies: ["failproofai/block-rm-rf"],
    decision: "deny",
    reason: DELETION_REASON,
    durationMs: 845,
    evaluator: "jev",
    jevDecision: "deny",
    jevLatencyMs: 812,
    jevModel: "jev-1.13.0",
    jevMode: "enforce",
    policySource: "jev",
  },
  // B — shadow: Jev would have denied; the regex result (allow) was enforced.
  {
    ...base,
    timestamp: 1785740915100,
    policyName: null,
    matchedPolicies: ["failproofai/block-rm-rf"],
    decision: "allow",
    reason: null,
    durationMs: 790,
    evaluator: "jev",
    jevDecision: "deny",
    jevLatencyMs: 761,
    jevModel: "jev-1.13.0",
    jevMode: "shadow",
    observed: [{ policyId: "semantic/destructive-deletion", version: "jev-1.13.0", decision: "deny", reason: DELETION_REASON }],
  },
  // B — shadow: Jev would have warned.
  {
    ...base,
    timestamp: 1785740915200,
    policyName: null,
    matchedPolicies: [],
    decision: "allow",
    reason: null,
    durationMs: 702,
    evaluator: "jev",
    jevDecision: "instruct",
    jevLatencyMs: 688,
    jevModel: "jev-1.13.0",
    jevMode: "shadow",
    observed: [{ policyId: "semantic/system-modification", version: "jev-1.13.0", decision: "instruct", reason: SYSTEM_REASON }],
  },
];
