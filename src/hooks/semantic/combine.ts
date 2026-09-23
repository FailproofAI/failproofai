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
 * | Jev answered                                  | reviewable denies/instructs Jev covered are cleared; final =|
 * |                                               | the most severe of {remaining regex results, Jev's verdict} |
 *
 * `shadow` mode computes and records all of it, and still returns the regex
 * result.
 *
 * "Jev can only clear what it was actually asked about": a reviewable
 * policy's deny or instruct is cleared only if EVERY semantic policy named in
 * its `reviewedBy` was among the ones put to Jev for this call AND came back
 * `none` or `overridden`. A name Jev was not asked about — its precondition was
 * false, the tool class did not apply, the name is misspelled — keeps the
 * regex verdict standing.
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
// The one value import, and deliberately from the activity vocabulary rather
// than a local literal: the fallback reason this module writes itself has to
// be a code the activity store's closed list names, or it is stored and
// shipped as `other`. Importing the constant makes a rename a compile error
// here. `jev-activity.ts` is pure (no node imports, no semantic modules), so
// this costs the hook path nothing.
import { JEV_REASON_REQUEST_CUT } from "../jev-activity";

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
  /** The semantic policies that must all come back clear. Empty for `hard`. */
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
      /** Of `asked`, the ones whose outcome was `none` or `overridden`. */
      clear: readonly string[];
      /**
       * The injection probe was in the request and answered. False → no clear:
       * an unmeasured injection is not an absent one.
       */
      injectionAsked: boolean;
      /** The injection probe held: every clear is withdrawn. */
      injected: boolean;
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

/** Whether Jev's answer clears this regex verdict. */
function clears(v: RegexVerdict, asked: ReadonlySet<string>, clear: ReadonlySet<string>): boolean {
  if (v.decision === "allow" || v.authority !== "reviewable") return false;
  if (v.reviewedBy.length === 0) return false;
  return v.reviewedBy.every((name) => asked.has(name) && clear.has(name));
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
  const clearSet = new Set(review.clear);
  const cleared = wholePicture ? verdicts.filter((v) => clears(v, asked, clearSet)).map((v) => v.policyName) : [];
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
    ...(cleared.length > 0 ? { jevCleared: cleared } : {}),
    ...(review.latencyMs !== null ? { jevLatencyMs: review.latencyMs } : {}),
    ...(review.model ? { jevModel: review.model } : {}),
    jevMode: mode,
  };

  if (mode === "shadow") return { final: legacy, cleared, decidedByJev: false, activity };

  const clearedSet = new Set(cleared);
  const remaining = verdicts.filter((v) => !clearedSet.has(v.policyName));
  const jevEntry = { policyName: review.policyName, reason: review.reason ?? `Flagged by semantic review (${review.policyName})` };

  // Most severe wins; within a severity, the regex engine's own order first.
  const regexDeny = remaining.find((v) => v.decision === "deny");
  if (regexDeny) {
    return {
      final: { decision: "deny", entries: [{ policyName: regexDeny.policyName, reason: regexDeny.reason ?? "" }] },
      cleared,
      decidedByJev: false,
      activity,
    };
  }
  if (review.decision === "deny") {
    return { final: { decision: "deny", entries: [jevEntry] }, cleared, decidedByJev: true, activity };
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
  if (review.decision === "instruct") instructs.push(jevEntry);
  if (instructs.length > 0) {
    return {
      final: { decision: "instruct", entries: instructs },
      cleared,
      decidedByJev: instructs[0] === jevEntry,
      activity,
    };
  }
  return { final: regexOnly(remaining), cleared, decidedByJev: false, activity };
}
