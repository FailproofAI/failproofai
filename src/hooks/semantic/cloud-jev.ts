/**
 * FailproofAI Cloud Jev (CONTRACT C10): one tool call in, one verdict out, with
 * the checks FailproofAI Cloud deployed to this machine decided ON CLOUD.
 *
 * Jev policies, and the Jev half of `both` policies, never reach the machine.
 * When Cloud sets this machine's Jev mode to `observe` or `enforce`, every
 * gated tool call is sent to `POST /enforcement/v1/jev/systemone` on the Cloud
 * Jev credential as today's Jev request — the machine's own questions, which
 * are the global intent questions (ALWAYS, even with no installed pack's check
 * applying) plus its installed packs' per-policy questions — and a `cloud`
 * block of tool-call metadata (`buildCloudBlock`). Cloud strips the block,
 * adds this machine's deployed Cloud checks, asks TypeSafe once, decides its
 * own checks with a port of `decide` / `decideV1`, and replies with every
 * answer plus `cloud.verdict`.
 *
 * Here the machine decides its pack checks from the answers exactly as the
 * local path does (minus any group Cloud dropped, `droppedLocal`) and merges
 * the two verdicts (`mergeCloudVerdict`). The merged verdict then goes to
 * `combine.ts` unchanged, via `toReview` in `jev-review.ts`.
 *
 * Never throws, and never guesses: anything short of a complete, well-formed
 * reply — no transport, timeout, HTTP error, a reply without a valid `cloud`
 * block, a missing answer — is `degraded`, and the combine keeps the regex
 * result for that call (a `both` policy's regex half stays hard).
 */
import { MAX_REQUEST_CHARS } from "./compile";
import { DEFAULT_THRESHOLDS, decide, decideV1, scanTargets } from "./decide";
import { redactSecrets } from "./envelope";
import { DEFAULT_JEV_TIMEOUT_MS, prepareSemantic, type PreparedCall, type SemanticOptions, type SemanticOutcome } from "./evaluator";
import { JevError, readAnswers, type JevTransport } from "./jev-client";
import type { JevProviderKind } from "./jev-config";
import { INJECTION_PROBE, SCOPE_PROBE, TASK_PROBES } from "./policies";
import { redactSecretsDetailed } from "./redact";
import type {
  Facts,
  IntentMode,
  JevRequest,
  JevResponse,
  NoulQuestion,
  PolicyOutcome,
  SemanticInput,
  SemanticPolicy,
  SemanticVerdict,
} from "./types";

/** The `cloud` block's version (CONTRACT C10.3). */
export const CLOUD_BLOCK_VERSION = 1;

/**
 * How many characters of `targetScan.groups` (serialized) are sent. The one
 * part of the block that grows with the tool input: an MCP call with thousands
 * of string fields, or a huge command whose scan fell back to its raw words.
 * Past it a prefix of the groups goes with `complete: false`, which is strictly
 * safer — an incomplete scan clears nothing (`decide.ts`).
 */
export const MAX_TARGET_SCAN_CHARS = 64_000;

/**
 * The block as serialized may not exceed this: Cloud answers a larger one with
 * a 400 (256 KiB there), and a refused call is a fallback. Kept a little under
 * Cloud's cap. The rest of the block is bounded by the envelope's own caps
 * (three human turns of at most `MAX_USER_MESSAGE_CHARS`, one capped agent
 * message, the capped facts); if it still does not fit, the human's turns are
 * left out — the stricter direction, since no consent can then be read.
 */
export const MAX_CLOUD_BLOCK_CHARS = 240_000;

/** What a secret word in a target group becomes: no human's words can contain it. */
export const REDACTED_TARGET_WORD = "\u0000redacted";

/** The `cloud` block of a request (CONTRACT C10.3). */
export interface CloudJevBlock {
  v: 1;
  machineId: string;
  intentMode: IntentMode;
  facts: Facts;
  targetScan: { groups: string[][]; complete: boolean };
  userSaid: string[];
  agentLastMessage: string | null;
  userSaidCut: boolean;
  /** The machine's own per-policy question groups, in the order Cloud drops them from (last first). */
  localPolicies: string[];
}

/** FailproofAI Cloud's reply block, validated. Its outcomes carry a pack-shaped `cloud:<id>` origin. */
export interface CloudJevReply {
  verdict: SemanticVerdict;
  asked: string[];
  droppedLocal: string[];
  droppedCloud: string[];
}

/** What the Cloud review adds to a `SemanticOutcome`, for the verdict log and the budget report. */
export interface CloudReplySummary {
  asked: string[];
  /** The machine's own groups Cloud dropped, with the pack that declared each (null when none did). */
  droppedLocal: Array<{ name: string; packId: string | null }>;
  droppedCloud: string[];
}

export type CloudSemanticOutcome =
  | (Extract<SemanticOutcome, { status: "ok" }> & { cloud: CloudReplySummary })
  | Extract<SemanticOutcome, { status: "degraded" }>;

export interface CloudSemanticOptions extends SemanticOptions {
  /** This machine's FailproofAI Cloud machine id, from `credentials.json`. */
  machineId: string;
}

// ── The request ──────────────────────────────────────────────────────────────

function noul(probe: { instructions: string; criteria?: { true: string; false: string } }): NoulQuestion {
  return {
    type: "noul",
    instructions: probe.instructions,
    ...(probe.criteria ? { criteria: { ...probe.criteria } } : {}),
  };
}

/**
 * The global intent questions a Cloud call ALWAYS carries, whatever the
 * machine's own checks are — Cloud's checks are decided on them:
 *
 * - `injection`, always (`compile.ts` asks it on every call it sends);
 * - v1: the three task probes whenever a human message was recorded, as
 *   `compileRequest` asks them;
 * - v0: `scope` whenever a human message was recorded. `compileRequest` asks
 *   it only when a SELECTED policy may be overridden, and the machine cannot
 *   know whether a Cloud check may be — without it no Cloud check could ever
 *   be cleared in v0. `decide` reads `scope` only inside the override branch,
 *   so the extra question changes no local verdict.
 */
export function cloudGlobalQuestions(intent: IntentMode, userSaidCount: number): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = { [INJECTION_PROBE.id]: noul(INJECTION_PROBE) };
  if (userSaidCount > 0) {
    if (intent === "v1") for (const probe of TASK_PROBES) questions[probe.id] = noul(probe);
    else questions[SCOPE_PROBE.id] = noul(SCOPE_PROBE);
  }
  return questions;
}

/**
 * How much of the tool input's text is searched for secrets. The groups sent
 * are cut at {@link MAX_TARGET_SCAN_CHARS} and come from the text in order
 * (the shell scan itself reads far less), so this covers every word that can
 * be sent, while a 1 MB heredoc does not cost the hook a second full pass.
 */
const MAX_SECRET_SCAN_CHARS = 4 * MAX_TARGET_SCAN_CHARS;

/**
 * Secret-shaped strings in the text `scanTargets` reads, lowercased like its
 * words: the command, or — for any other tool — the string values it takes a
 * target from (the same ≤300-character, non-content fields).
 */
function secretWords(toolInput: Record<string, unknown>): string[] {
  const text = (
    typeof toolInput.command === "string"
      ? toolInput.command
      : Object.entries(toolInput)
          .filter(([key, v]) => typeof v === "string" && v.length <= 300 && !/content|old_string|new_string|body|text|prompt/i.test(key))
          .map(([, v]) => v as string)
          .join("\n")
  ).slice(0, MAX_SECRET_SCAN_CHARS);
  try {
    return redactSecretsDetailed(text, { blunt: false })
      .found.map((s) => s.toLowerCase())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/**
 * `scanTargets(toolInput)` as the `cloud` block carries it: each group's Set as
 * a sorted array, `targets` left out (it is the groups' union).
 *
 * Two changes, both in the stricter direction only:
 *
 * - A word that is (part of) a secret the narrow redactor finds in the tool
 *   input is replaced by {@link REDACTED_TARGET_WORD}, which no human's words
 *   can contain. The envelope already keeps that secret out of what Jev reads;
 *   this keeps it out of the metadata too. The group is kept, so the call still
 *   names as many targets — one the human can no longer be matched against.
 * - Past {@link MAX_TARGET_SCAN_CHARS}, a prefix of the groups with
 *   `complete: false`: an incomplete scan clears nothing.
 */
export function cloudTargetScan(toolInput: Record<string, unknown>): CloudJevBlock["targetScan"] {
  const scan = scanTargets(toolInput);
  const secrets = scan.groups.length > 0 ? secretWords(toolInput) : [];
  const hidden = (word: string): boolean =>
    secrets.some((s) => s === word || (word.length >= 8 && s.includes(word)) || (s.length >= 8 && word.includes(s)));
  const groups: string[][] = [];
  let chars = 2;
  let complete = scan.complete;
  for (const group of scan.groups) {
    const words = [...new Set([...group].map((w) => (hidden(w) ? REDACTED_TARGET_WORD : w)))].sort();
    const cost = JSON.stringify(words).length + 1;
    if (chars + cost > MAX_TARGET_SCAN_CHARS) {
      complete = false;
      break;
    }
    chars += cost;
    groups.push(words);
  }
  return { groups, complete };
}

/** The machine's facts with their strings passed through the narrow redactor, as the envelope sends them. */
function cloudFacts(facts: Facts): Facts {
  const scrub = (s: string | null): string | null => (s === null ? null : redactSecrets(s, { blunt: false }).text);
  return {
    toolName: facts.toolName,
    toolClass: facts.toolClass,
    toolIsKnown: facts.toolIsKnown,
    cwd: scrub(facts.cwd),
    projectRoot: scrub(facts.projectRoot),
    currentGitBranch: scrub(facts.currentGitBranch),
    paths: facts.paths.map((p) => ({ asWritten: scrub(p.asWritten) ?? "", resolved: scrub(p.resolved) ?? "", relation: p.relation })),
    permissionMode: facts.permissionMode,
  };
}

/**
 * The `cloud` block for a prepared call (CONTRACT C10.3): what the local
 * decider reads, so Cloud decides its checks on the same evidence.
 *
 * - `facts`: the machine's `Facts`, strings redacted as the envelope's are.
 * - `targetScan`: {@link cloudTargetScan}.
 * - `userSaid`: the human turns the envelope CARRIES, uncut (`prepared.userSaid`,
 *   cleaned in v1), each with secrets redacted by the rules the envelope uses
 *   for everything that leaves the machine (`blunt`). A secret the human typed
 *   is then simply not matchable — stricter, never looser.
 * - `agentLastMessage`: the string the envelope SENT (v1), null in v0.
 * - `userSaidCut`, `intentMode`: as the local decider takes them.
 * - `localPolicies`: the names of this call's own per-policy question groups.
 */
export function buildCloudBlock(prepared: PreparedCall, input: SemanticInput, machineId: string): CloudJevBlock {
  const block: CloudJevBlock = {
    v: CLOUD_BLOCK_VERSION,
    machineId,
    intentMode: prepared.intent,
    facts: cloudFacts(prepared.facts),
    targetScan: cloudTargetScan(input.toolInput),
    userSaid: prepared.userSaid.map((turn) => redactSecrets(turn, { blunt: true }).text),
    agentLastMessage: prepared.agentLastMessage,
    userSaidCut: prepared.userSaidCut,
    localPolicies: prepared.selected.map((p) => p.name),
  };
  // Bounded by the caps above in practice; this is the floor under them. The
  // human's turns go first (no consent can be read, which clears nothing),
  // then the target scan (incomplete, which clears nothing either).
  if (JSON.stringify(block).length > MAX_CLOUD_BLOCK_CHARS) {
    block.userSaid = [];
    block.userSaidCut = false;
  }
  if (JSON.stringify(block).length > MAX_CLOUD_BLOCK_CHARS) {
    block.targetScan = { groups: [], complete: false };
  }
  return block;
}

/** The request sent to FailproofAI Cloud: today's, the global questions always, and the block. */
export function buildCloudRequest(prepared: PreparedCall, input: SemanticInput, machineId: string): JevRequest {
  const own = prepared.compiled.request;
  return {
    model: own.model,
    state: own.state,
    questions: { ...own.questions, ...cloudGlobalQuestions(prepared.intent, prepared.userSaid.length) },
    cloud: buildCloudBlock(prepared, input, machineId) as unknown as Record<string, unknown>,
  };
}

// ── The reply ────────────────────────────────────────────────────────────────

/** A Cloud policy id, as `cloud-managed-policies.ts` accepts one. */
const POLICY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** Longest check name accepted back; declarations are far shorter. */
const MAX_NAME_CHARS = 256;
/** Most outcomes / names accepted back: 24 declarations per policy leaves this far out of reach. */
const MAX_LIST = 4096;

function malformed(what: string): never {
  throw new JevError("malformed", `FailproofAI Cloud's reply: ${what}`);
}

const isProbability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isName = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_NAME_CHARS;

function nullableProbability(v: unknown, what: string): number | null {
  if (v === null || v === undefined) return null;
  if (!isProbability(v)) malformed(`${what} is not a probability`);
  return v;
}

function names(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_LIST || !v.every(isName)) malformed(`${what} is not a list of names`);
  return [...v];
}

const DECISIONS = new Set(["allow", "deny", "instruct"]);
const VERDICTS = new Set(["deny", "instruct", "overridden", "none"]);
const INTENTS = new Set(["op-requested", "task-step", "downgraded-task-step"]);

/** One Cloud outcome, rebuilt field by field so nothing but these fields crosses over. */
function parseOutcome(raw: unknown, i: number): PolicyOutcome {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) malformed(`outcome ${i} is not an object`);
  const o = raw as Record<string, unknown>;
  if (!isName(o.policy)) malformed(`outcome ${i} has no policy name`);
  if (o.mode !== "deny" && o.mode !== "instruct") malformed(`outcome ${i} has no mode`);
  if (!isProbability(o.evidence)) malformed(`outcome ${i} has no evidence`);
  if (typeof o.targetNamedByUser !== "boolean" || typeof o.escalatedByInjection !== "boolean") {
    malformed(`outcome ${i} is missing a flag`);
  }
  if (typeof o.verdict !== "string" || !VERDICTS.has(o.verdict)) malformed(`outcome ${i} has no verdict`);
  if (o.intent !== undefined && (typeof o.intent !== "string" || !INTENTS.has(o.intent))) malformed(`outcome ${i} has an unknown intent`);
  if (o.targetScanIncomplete !== undefined && o.targetScanIncomplete !== true) malformed(`outcome ${i} has a bad targetScanIncomplete`);
  if (o.userCanOverride !== undefined && typeof o.userCanOverride !== "boolean") malformed(`outcome ${i} has a bad userCanOverride`);
  const origin = o.origin as Record<string, unknown> | undefined;
  if (
    !origin ||
    typeof origin !== "object" ||
    typeof origin.cloudPolicyId !== "string" ||
    !POLICY_ID_RE.test(origin.cloudPolicyId) ||
    !Number.isSafeInteger(origin.cloudVersion) ||
    (origin.cloudVersion as number) < 0
  ) {
    malformed(`outcome ${i} has no Cloud origin`);
  }
  return {
    policy: o.policy,
    mode: o.mode,
    ...(typeof o.userCanOverride === "boolean" ? { userCanOverride: o.userCanOverride } : {}),
    // Pack-shaped, so the attribution the hook path already has files it as
    // `cloudPolicyId`/`cloudVersion` (`jevAttribution` in `handler.ts`), and the
    // review keys it as that policy's own reviewer (`cloudReviewerName`).
    origin: { packId: `cloud:${origin.cloudPolicyId}`, packVersion: String(origin.cloudVersion) },
    evidence: o.evidence,
    exempt: nullableProbability(o.exempt, `outcome ${i} exempt`),
    userAsked: nullableProbability(o.userAsked, `outcome ${i} userAsked`),
    targetNamedByUser: o.targetNamedByUser as boolean,
    escalatedByInjection: o.escalatedByInjection as boolean,
    verdict: o.verdict as PolicyOutcome["verdict"],
    ...(o.intent !== undefined ? { intent: o.intent as PolicyOutcome["intent"] } : {}),
    ...(o.targetScanIncomplete === true ? { targetScanIncomplete: true as const } : {}),
  };
}

/**
 * The reply's `cloud` block, validated and rebuilt, or a `malformed` JevError.
 * A reply without one (a server that does not implement C10) is malformed:
 * nothing it says can be told apart from "Cloud has no checks here".
 */
export function parseCloudReply(raw: unknown): CloudJevReply {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) malformed("no cloud block");
  const block = raw as Record<string, unknown>;
  const v = block.verdict as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) malformed("no verdict");
  if (typeof v.decision !== "string" || !DECISIONS.has(v.decision)) malformed("verdict has no decision");
  if (v.reason !== null && v.reason !== undefined && typeof v.reason !== "string") malformed("verdict reason is not text");
  if (!Array.isArray(v.outcomes) || v.outcomes.length > MAX_LIST) malformed("verdict has no outcomes list");
  if (v.beyondTask !== undefined && typeof v.beyondTask !== "boolean") malformed("verdict beyondTask is not a flag");
  const outcomes = v.outcomes.map(parseOutcome);
  return {
    verdict: {
      decision: v.decision as SemanticVerdict["decision"],
      reason: typeof v.reason === "string" ? v.reason : null,
      outcomes,
      injectionSuspected: nullableProbability(v.injectionSuspected, "injectionSuspected"),
      scopeWithinRequest: nullableProbability(v.scopeWithinRequest, "scopeWithinRequest"),
      beyondTask: v.beyondTask === true,
    },
    asked: names(block.asked, "asked"),
    droppedLocal: names(block.droppedLocal, "droppedLocal"),
    droppedCloud: names(block.droppedCloud, "droppedCloud"),
  };
}

// ── The merge (CONTRACT C10.5) ───────────────────────────────────────────────

const RANK: Record<SemanticVerdict["decision"], number> = { allow: 0, instruct: 1, deny: 2 };

/** Lines of the given reasons, first seen first, each once. */
function joinLines(reasons: ReadonlyArray<string | null>): string | null {
  const lines: string[] = [];
  for (const reason of reasons) {
    if (!reason) continue;
    for (const line of reason.split("\n")) if (!lines.includes(line)) lines.push(line);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Cloud's verdict and the machine's own, as ONE verdict for `combine.ts`:
 *
 * - outcomes: Cloud's first, then the machine's;
 * - decision: the most severe (deny > instruct > allow);
 * - reason: the deny's (Cloud's first) for a deny; every warning line (Cloud's
 *   first, each once — a beyond-the-task line both sides raised is one line)
 *   for an instruct; the allow notes (Cloud's first) for an allow;
 * - `beyondTask`: either side's; `injectionSuspected` / `scopeWithinRequest`:
 *   the machine's own reading of the shared answer, else Cloud's.
 *
 * Pure.
 */
export function mergeCloudVerdict(cloud: SemanticVerdict, local: SemanticVerdict): SemanticVerdict {
  const decision = RANK[cloud.decision] >= RANK[local.decision] ? cloud.decision : local.decision;
  let reason: string | null;
  if (decision === "deny") {
    reason = cloud.decision === "deny" ? cloud.reason ?? local.reason : local.reason;
  } else if (decision === "instruct") {
    reason = joinLines([cloud, local].filter((v) => v.decision === "instruct").map((v) => v.reason));
  } else {
    reason = joinLines([cloud.reason, local.reason]);
  }
  const beyond = cloud.beyondTask === undefined && local.beyondTask === undefined ? undefined : cloud.beyondTask === true || local.beyondTask === true;
  return {
    decision,
    reason,
    outcomes: [...cloud.outcomes, ...local.outcomes],
    injectionSuspected: local.injectionSuspected ?? cloud.injectionSuspected,
    scopeWithinRequest: local.scopeWithinRequest ?? cloud.scopeWithinRequest,
    ...(beyond !== undefined ? { beyondTask: beyond } : {}),
  };
}

// ── The call ─────────────────────────────────────────────────────────────────

/** An allow with nothing decided: Cloud's short-circuit verdict. */
const EMPTY_ALLOW: SemanticVerdict = {
  decision: "allow",
  reason: null,
  outcomes: [],
  injectionSuspected: null,
  scopeWithinRequest: null,
  beyondTask: false,
};

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The answers the machine needs back: its own questions, minus the groups Cloud dropped. */
function expectedQuestions(request: JevRequest, prepared: PreparedCall, dropped: ReadonlySet<string>): JevRequest {
  if (dropped.size === 0) return request;
  const questions = Object.fromEntries(
    Object.entries(request.questions).filter(([id]) => {
      const owner = prepared.compiled.owners.get(id);
      return !(typeof owner === "string" && dropped.has(owner));
    }),
  );
  return { ...request, questions };
}

/** Whatever answers a short-circuit reply carries, read leniently: none is required. */
function presentAnswers(response: JevResponse): Record<string, number> {
  const out: Record<string, number> = {};
  const answers = response.answers && typeof response.answers === "object" ? response.answers : {};
  for (const [id, a] of Object.entries(answers)) {
    const p = (a as { noul?: unknown } | null)?.noul;
    if (isProbability(p)) out[id] = p;
  }
  return out;
}

/**
 * Ask FailproofAI Cloud about one call and return the merged verdict. Mirrors
 * `evaluateSemantic` in everything but where the verdict comes from.
 */
export async function evaluateCloudSemantic(input: SemanticInput, opts: CloudSemanticOptions): Promise<CloudSemanticOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let prepared: PreparedCall;
  let request: JevRequest;
  try {
    prepared = prepareSemantic(input, opts);
    request = buildCloudRequest(prepared, input, opts.machineId);
  } catch (err) {
    return {
      status: "degraded",
      reason: `prepare: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: elapsed(),
      questionCount: 0,
      truncated: false,
      requestCut: false,
    };
  }
  // A known tool with no side effects (TodoWrite, Task, …) selects no check
  // anywhere — `selectPolicies` answers `[]` for it before reading a single
  // declaration, and Cloud selects its checks with an exact port of that
  // function — so Cloud's reply is its short-circuit, an empty allow, every
  // time. Not asked for: a round trip on every such call would buy nothing.
  if (prepared.facts.toolIsKnown && prepared.facts.toolClass === "other") {
    return {
      status: "ok",
      verdict: { ...EMPTY_ALLOW, outcomes: [] },
      answers: {},
      latencyMs: elapsed(),
      inputTokens: null,
      questionCount: 0,
      truncated: false,
      requestCut: false,
      redactions: prepared.envelope.redactions,
      model: request.model,
      modelVerified: true,
      via: "none",
      cloud: { asked: [], droppedLocal: [], droppedCloud: [] },
    };
  }
  const questionCount = Object.keys(request.questions).length;
  // What Cloud forwards is `{model, state, questions}` plus its own checks; the
  // machine's share is checked here the way `prepareSemantic` checks it.
  const { cloud: _block, ...forwarded } = request;
  void _block;
  const oversized = prepared.oversized || JSON.stringify(forwarded).length > MAX_REQUEST_CHARS;
  const truncated = prepared.truncated || oversized;
  const requestCut = prepared.requestCut || oversized;
  const degraded = (reason: string): CloudSemanticOutcome => ({
    status: "degraded",
    reason,
    latencyMs: elapsed(),
    questionCount,
    truncated,
    requestCut,
  });

  const transport: JevTransport | undefined = opts.transport;
  if (!transport) return degraded("no-transport");
  const via: JevProviderKind = opts.via ?? "failproofai";
  if (opts.signal?.aborted) return degraded("aborted");

  try {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? envNumber("FAILPROOFAI_JEV_TIMEOUT_MS", DEFAULT_JEV_TIMEOUT_MS));
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    const response = await transport(request, signal);
    const reply = parseCloudReply(response.cloud);

    // Only the machine's own groups can be dropped from its side; a name it
    // did not send is not its to act on.
    const own = new Map(prepared.selected.map((p) => [p.name, p] as const));
    const dropped = new Set(reply.droppedLocal.filter((name) => own.has(name)));
    const kept: SemanticPolicy[] = prepared.selected.filter((p) => !dropped.has(p.name));

    // Short-circuit (C10.4 step 6): nothing of the machine's left to decide and
    // no Cloud check asked, so Cloud made no TypeSafe call and there are no
    // answers to demand. The local verdict is then an empty allow whatever the
    // answers — `decide` with nothing selected reads no per-policy answer, and
    // no warning can fire without one.
    const shortCircuit = kept.length === 0 && reply.asked.length === 0 && reply.verdict.outcomes.length === 0;
    const answers = shortCircuit ? presentAnswers(response) : readAnswers(expectedQuestions(request, prepared, dropped), response);

    const local =
      prepared.intent === "v1"
        ? decideV1(kept, answers, input.toolInput, prepared.userSaid, prepared.agentLastMessage, {
            ...opts.v1,
            userSaidCut: prepared.userSaidCut,
          })
        : decide(kept, answers, input.toolInput, prepared.userSaid, opts.thresholds ?? DEFAULT_THRESHOLDS, prepared.userSaidCut);

    return {
      status: "ok",
      verdict: mergeCloudVerdict(reply.verdict, local),
      answers,
      latencyMs: elapsed(),
      inputTokens: typeof response.usage?.input_tokens === "number" ? response.usage.input_tokens : null,
      questionCount,
      truncated,
      requestCut,
      redactions: prepared.envelope.redactions,
      model: response.model || request.model,
      modelVerified: response.modelUnverified !== true,
      via,
      cloud: {
        asked: reply.asked,
        droppedLocal: [...dropped].map((name) => ({ name, packId: own.get(name)?.origin?.packId ?? null })),
        droppedCloud: reply.droppedCloud,
      },
    };
  } catch (err) {
    // Checked first: a transport that surfaces the abort as its own timeout
    // error must still read as the caller's abort, not as Jev being slow.
    if (opts.signal?.aborted) return degraded("aborted");
    if (err instanceof JevError) return degraded(err.code);
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return degraded("timeout");
    return degraded(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
