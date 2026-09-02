/**
 * Run the policy set once per element of an expanded batch tool call.
 *
 * Why this exists rather than a cleverer canonicalization: cline's tools carry
 * ARRAYS, and collapsing an array into one scalar cannot preserve an ANCHORED
 * regex. `SECRET_FILE_RE` is `/\.(?:pem|key)$/`, so under any join only the last
 * path can match and a `.pem` at `files[0]` rides straight through — a silent
 * allow, which is the failure mode this repo has already shipped twice.
 *
 * Combination rules:
 *   all allow, no notes       → plain allow, identical to a non-batch call
 *   any deny                  → LOWEST element index wins, returned verbatim,
 *                               short-circuiting the rest
 *   no deny, >=1 instruct     → union deduped by (policy, reason), shaped ONCE
 *   no deny/instruct, >=1 note→ same
 *
 * The deny is returned verbatim because `evaluatePolicies` already shaped it for
 * the calling CLI and already embedded the element locator (it received
 * `opts.batch`). No re-shaping, and therefore nothing to keep in sync with the
 * 16 per-CLI deny shapes.
 */
import { evaluatePolicies, type EvaluationResult } from "./policy-evaluator";
import { collapseElements, type BatchExpansion, type FanoutElement } from "./batch-expand";
import { hookLogWarn } from "./hook-logger";
import type { HookEventType, SessionMetadata } from "./types";
import type { HooksConfig } from "./policy-types";

/** A shape guard, not the real one: 32 elements of registered policies sits
 *  comfortably inside daemon-client.ts's 30s RESPONSE budget. The wall clock
 *  below is what actually protects that budget. */
const MAX_ELEMENTS = 32;
const WALL_CLOCK_BUDGET_MS = 5_000;

export interface BatchOutcome {
  size: number;
  evaluated: number;
  decidedIndex: number | null;
  decidedLabel: string | null;
  degraded: boolean;
}

type Entry = { policyName: string; reason: string };

/** Policy P saying the SAME thing about elements 3 and 7 contributes one line;
 *  P saying two different things contributes both. Keyed on (name, reason). */
function pushDeduped(into: Entry[], from: Entry[] | undefined): void {
  for (const e of from ?? []) {
    const k = `${e.policyName}\t${e.reason}`;
    if (!into.some((x) => `${x.policyName}\t${x.reason}` === k)) into.push(e);
  }
}

export async function evaluateExpandedBatch(
  eventType: HookEventType,
  payload: Record<string, unknown>,
  session: SessionMetadata | undefined,
  config: HooksConfig | undefined,
  expansion: BatchExpansion,
  dedupe: Set<string>,
): Promise<EvaluationResult & { batch: BatchOutcome }> {
  const started = Date.now();

  let queue: FanoutElement[] =
    expansion.elements.length > MAX_ELEMENTS
      ? [
          ...expansion.elements.slice(0, MAX_ELEMENTS),
          collapseElements(expansion.tool, expansion.elements.slice(MAX_ELEMENTS)),
        ]
      : [...expansion.elements];

  const instructs: Entry[] = [];
  const allows: Entry[] = [];
  let evaluated = 0;
  let sawDegraded = false;

  for (let i = 0; i < queue.length; i++) {
    // Checked BETWEEN elements only — a policy already inside its own timeout
    // race is not interruptible from here.
    if (i > 0 && Date.now() - started > WALL_CLOCK_BUDGET_MS) {
      const rest = queue.slice(i);
      hookLogWarn(
        `batch fan-out budget exceeded after ${i}/${queue.length} elements; the remaining ` +
          `${rest.length} are being evaluated COLLAPSED — anchored patterns may not match`,
      );
      queue = [...queue.slice(0, i), collapseElements(expansion.tool, rest)];
    }
    const el = queue[i]!;
    sawDegraded = sawDegraded || !!el.degraded;

    const r = await evaluatePolicies(
      eventType,
      { ...payload, tool_input: el.input },
      session,
      config,
      {
        dedupe,
        collectEntries: true,
        batch: {
          index: el.index,
          count: expansion.elements.length,
          label: el.label,
          degraded: !!el.degraded,
          all: expansion.elements.map((e) => e.input),
          raw: expansion.raw,
        },
      },
    );
    evaluated++;

    if (r.decision === "deny") {
      return {
        ...r,
        batch: {
          size: expansion.elements.length,
          evaluated,
          decidedIndex: el.index,
          decidedLabel: el.label,
          degraded: sawDegraded,
        },
      };
    }
    pushDeduped(instructs, r.instructEntries);
    pushDeduped(allows, r.allowEntries);
  }

  // One shaping pass over the deduped union, through the SAME per-CLI tails
  // every other integration uses — no shaping code was extracted to get here.
  const shaped = await evaluatePolicies(eventType, payload, session, config, {
    dedupe,
    preEvaluated: { instructEntries: instructs, allowEntries: allows },
  });
  return {
    ...shaped,
    batch: {
      size: expansion.elements.length,
      evaluated,
      decidedIndex: null,
      decidedLabel: null,
      degraded: sawDegraded,
    },
  };
}
