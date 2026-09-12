/**
 * Turning an audit result into a harm report the api-server can act on.
 *
 * Runs only after a SCHEDULED scan (`failproofai audit --scheduled`) and only
 * ever from the audit child — never the daemon, which holds no human credential
 * precisely so that refresh rotation stays inside the audit lock. Without an
 * email identity the scan and desktop notification still work; this module
 * simply reports `signed-out` and sends nothing.
 *
 * ## What counts as harm
 *
 * The policies the engine would have BLOCKED, plus the ones that caught a secret
 * on its way into the model's context. In terms of `severityForBuiltin`, that is
 * `deny` and `sanitize` — `block-*` and `sanitize-*` — and NOT `warn-`,
 * `prefer-` or `require-`, which are hygiene.
 *
 * One name is added by hand, and it is worth explaining rather than hiding:
 * `severityForBuiltin` derives severity from the NAME PREFIX, so
 * `protect-env-vars` reads as `warn` despite being a policy that blocks `env` /
 * `printenv` outright. Its whole subject is an agent reaching for the
 * environment, which is the "read my keys" case this feature exists to report.
 * Inheriting a scoring heuristic's blind spot into a security digest would be
 * the wrong kind of consistency.
 *
 * ## The window, and the trap in `--since`
 *
 * `RunAuditOptions.since` filters on transcript MTIME, and that is right for
 * what it does — it decides which files to open. It is WRONG as a window for
 * this: a session left open for a month has a fresh mtime, so `--since 7d`
 * hands back that whole transcript including month-old events, and the first
 * digest would report everything the agent has ever done as though it happened
 * this week.
 *
 * So the window is applied HERE, per event, against the timestamps `AuditCount`
 * already carries — `lastSeen` to decide whether a policy fired in the window at
 * all, and each example's own `timestamp` to decide which examples belong to it.
 * The scan itself stays unfiltered.
 *
 * ## Counts are approximate; the window boundary is not
 *
 * `AuditCount.hits` is a total over everything scanned, and there is no
 * per-event breakdown to subtract from it — the cache stores counts, not event
 * lists. Rather than report a total that spans the wrong period, a policy whose
 * activity straddles the window boundary reports the number of EXAMPLES that
 * fall inside it, which is a real count of real events even though it is capped
 * at three. A policy entirely inside the window reports its true total. The
 * server's threshold reads these, so undercounting is the safe direction: it can
 * delay a digest, never invent one.
 */
import type { AuditCount, AuditResult } from "./types";
import { redactExample } from "./redact-example";
import type { LeakFinding } from "./leak-record";

/** Severities that mean "the engine would have stopped this". */
const HARMFUL_SEVERITIES = new Set(["deny", "sanitize"]);

/**
 * Policies whose severity misreads their intent. See the module docs.
 *
 * Kept as an explicit list rather than by rewriting `severityForBuiltin`,
 * because that function feeds the SCORE's gentle/medium buckets and changing it
 * would silently move every historical score.
 */
const ALSO_HARMFUL = new Set(["protect-env-vars"]);

/** One policy's harmful activity inside the window, as the wire expects it. */
export interface ReportedPolicy {
  policy: string;
  category: string;
  title: string;
  hits: number;
  first_seen?: string;
  last_seen?: string;
  examples: string[];
}

/**
 * One leaked credential, as the digest carries it.
 *
 * **Nothing here can contain the secret**, and that is a structural property
 * rather than a promise this function keeps. `LeakFinding` has no field holding
 * the raw value — `recordLeaks` fingerprints at the moment of detection and
 * stores only the mask — so there is no raw value on disk for this to leak even
 * by accident. The most a bug here can send is a mask, a length and a label.
 *
 * The identifier NAME (`COMPOSIO_API_KEY`) is sent, and is not a secret: it is
 * the left-hand side of an assignment, and for the first-party class — 230 of
 * the 237 secret-named assignments the census measured, which no vendor console
 * can revoke — it is the only actionable thing in the finding. Without it the
 * digest can say a key leaked and not which one.
 */
export interface ReportedLeak {
  /** The machine-local salted id, so a reader can act on the same row twice.
   *  An HMAC under a salt that never leaves the machine — it names the finding
   *  without describing it. */
  id: string;
  /** WHAT. `ghp_••••••••4f2a`, or `[13-char password]` when nothing was minted. */
  display: string;
  label: string;
  length: number;
  /** False means "we know it leaked, not who issued it" — which changes the
   *  advice from "revoke at this console" to "find where this came from". */
  attributed: boolean;
  /** The identifier it was assigned to, when there was one. */
  name: string | null;
  confidence: string;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  /** WHO — the harness whose transcript carried it. */
  cli: string;
  /** WHERE — home-shortened already, like every path in `examples`. */
  project: string;
  /** HOW — "read from ~/…/.env". */
  mechanism: string;
  /** Input means the agent SENT it (deniable at PreToolUse next time); result
   *  means the agent RECEIVED it, which no gate can undo. */
  direction: "input" | "result";
}

export interface HarmReport {
  window_from?: string;
  window_to: string;
  harmful: ReportedPolicy[];
  /** Credentials seen in this window. Separate from `harmful` because it is a
   *  different kind of claim: `harmful` counts policy activity, this names a
   *  specific object that needs rotating. */
  leaks: ReportedLeak[];
}

/** `failproofai/block-rm-rf` → `block-rm-rf`. */
function shortName(name: string): string {
  const slash = name.indexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

export function isHarmful(count: AuditCount): boolean {
  if (count.source !== "builtin") return false;
  const short = shortName(count.name);
  return HARMFUL_SEVERITIES.has(count.severity) || ALSO_HARMFUL.has(short);
}

/** Parse an ISO timestamp, or null if it is absent or unusable. */
function ts(value: string | undefined): number | null {
  if (!value) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Select the harmful policies whose activity falls inside `[from, to]`.
 *
 * `from` undefined means "everything up to `to`", which is now only reachable
 * by an explicit caller — `buildHarmReport` always supplies a bound. See the
 * note there for why.
 *
 * `includeUnplaceable` decides what happens to a policy with NO usable
 * timestamps. It cannot be placed, and the two failure directions are not
 * equal: on a first report, dropping it loses a real finding; on a later one,
 * including it re-reports something already covered. Silence about something
 * new is the worse of the two and repetition is merely annoying, so each window
 * gets the answer that fails the way it can afford to.
 */
export function selectHarmful(
  result: AuditResult,
  from: Date | undefined,
  to: Date,
  opts: { includeUnplaceable?: boolean } = {},
): ReportedPolicy[] {
  const includeUnplaceable = opts.includeUnplaceable ?? from === undefined;
  const fromMs = from ? from.getTime() : null;
  const toMs = to.getTime();
  const out: ReportedPolicy[] = [];

  for (const count of result.results) {
    if (!isHarmful(count)) continue;

    const last = ts(count.lastSeen);
    const first = ts(count.firstSeen);

    // Nothing since the watermark — this policy's whole history predates the
    // window.
    if (fromMs !== null && last !== null && last <= fromMs) continue;
    // Fired entirely after the window closed (a clock skew, or a scan that
    // raced an event). It belongs to the next report, not this one.
    if (first !== null && first > toMs) continue;

    const inWindow = count.examples.filter((e) => {
      const at = ts(e.timestamp);
      if (at === null) return includeUnplaceable;
      if (fromMs !== null && at <= fromMs) return false;
      return at <= toMs;
    });

    const unplaceable = last === null && first === null;
    if (unplaceable && !includeUnplaceable) continue;

    // Wholly inside the window → the real total. Straddling EITHER edge → the
    // examples that actually fall inside, which undercounts but never invents.
    //
    // Both edges, and the upper one is not symmetry for its own sake. This used
    // to test the lower bound alone, so a policy that started inside the window
    // and was still firing after it closed reported `count.hits` — every hit,
    // including the ones after `to`, while its examples were filtered to the
    // window. Those hits then fell inside the NEXT report's window too, since
    // the watermark advances to `to`, and were counted a second time. A digest
    // that reports tomorrow's findings today and again tomorrow is worse than
    // one that is late.
    //
    // An UNPLACEABLE policy that survived the check above reports its full
    // count: there is nothing to narrow it with, and having decided to include
    // it, reporting zero would be a row claiming nothing happened. It is only
    // reachable on a first report, where over-reporting is the direction that
    // was chosen deliberately.
    const afterLowerEdge = fromMs === null || (first !== null && first > fromMs);
    const beforeUpperEdge = last !== null && last <= toMs;
    const wholly = unplaceable || (afterLowerEdge && beforeUpperEdge);
    // A straddling policy falls back to its in-window EXAMPLES, and the audit
    // keeps at most three of them per policy, chosen in whatever order the
    // transcripts happened to be walked. On a machine that has been running
    // agents for months those three are routinely all old — so a policy that
    // fired an hour ago scored zero and was dropped, and because `firstSeen`
    // stays before the watermark forever, it was dropped from every later report
    // too. Not a delayed digest: a feature that goes quiet on exactly the
    // machines with the most to report.
    //
    // `beforeUpperEdge` having survived the `last <= fromMs` skip above means
    // `lastSeen` itself sits inside the window, and that timestamp IS a real
    // event. One is the floor it proves, which keeps the "never invent a hit"
    // rule intact while making the row exist.
    const floor = beforeUpperEdge ? 1 : 0;
    const hits = wholly ? count.hits : Math.max(inWindow.length, floor);
    if (hits <= 0) continue;

    out.push({
      policy: shortName(count.name),
      category: count.category,
      title: count.displayTitle ?? "",
      hits,
      first_seen: count.firstSeen,
      last_seen: count.lastSeen,
      examples: inWindow.map((e) => redactExample(e.example)).filter((e) => e.length > 0),
    });
  }

  // Most active first, so a digest truncated by anything downstream keeps the
  // rows that matter.
  out.sort((a, b) => b.hits - a.hits);
  return out;
}

/**
 * Build the report body for one scan.
 *
 * `window_to` is the scan's own `scannedAt` rather than "now": it is the instant
 * the evidence was gathered, and using a later clock reading would advance the
 * watermark past events that happened while the scan was still running — events
 * no report would ever cover.
 *
 * ## A first report is bounded to one interval, not to all of history
 *
 * With no watermark the obvious window is "everything", and that is what this
 * did until it was run against a real machine: the first report covered 230
 * sessions and 22,059 tool calls and came out at **5,815 findings**. Every
 * number in it was true and the digest was still wrong — somebody's first email
 * would describe their agent's entire recorded history as though it were this
 * week's news, and would trip the critical bypass on day one for essentially
 * everyone.
 *
 * A digest is a statement about RECENT behaviour, so the first one covers the
 * same period every later one does: `interval_days` back from the scan. The
 * older findings are not lost, they are simply not news — they are on the
 * dashboard, which is where a full history belongs.
 *
 * `includeUnplaceable` still follows "is this the first report", not "is there a
 * lower bound", so a policy carrying no usable timestamps is reported once on a
 * new machine rather than silently dropped by the bound this now always sets.
 */
/**
 * The leaks worth putting in this window's digest.
 *
 * Windowed on `lastSeen`, not `firstSeen`: a key first seen months ago and used
 * again yesterday is live, and reporting it only in the window it debuted would
 * mean the digest goes quiet on exactly the credentials still in circulation.
 *
 * Dismissed findings never appear. A person who looked at a row and said "that
 * is not a secret" has given the only judgement available that beats ours, and
 * mailing it to them weekly afterwards is how a tool teaches people to filter
 * it out of their inbox.
 */
export function selectLeaks(findings: LeakFinding[], from: Date, to: Date): ReportedLeak[] {
  const lo = from.getTime();
  const hi = to.getTime();
  const out: ReportedLeak[] = [];
  for (const f of findings) {
    if (f.dismissedAt) continue;
    const last = ts(f.lastSeen);
    // No usable timestamp means it cannot be placed in a window. Included
    // rather than dropped, for the same reason `includeUnplaceable` exists
    // above: silence about a credential is the failure that costs something.
    if (last !== null && (last < lo || last > hi)) continue;
    // The most recent exposure is the one worth describing: it is where the key
    // is now, not where it was first noticed.
    // Defensive even though `readLeakRecord` already sanitises: this is
    // exported and takes whatever a caller hands it.
    const seen = f.sightings?.reduce((latest, candidate) => {
      if (!latest) return candidate;
      return (ts(candidate.at) ?? 0) >= (ts(latest.at) ?? 0) ? candidate : latest;
    }, undefined as LeakFinding["sightings"][number] | undefined);
    out.push({
      id: f.id,
      display: f.fingerprint?.display ?? "[credential]",
      label: f.fingerprint?.label ?? "secret",
      length: f.fingerprint?.length ?? 0,
      attributed: f.fingerprint?.attributed === true,
      name: f.name,
      confidence: f.confidence,
      first_seen: f.firstSeen,
      last_seen: f.lastSeen,
      occurrences: f.occurrences,
      cli: seen?.cli ?? "unknown",
      project: seen?.cwd ?? "unknown",
      mechanism: seen?.mechanism?.summary ?? "seen in a transcript",
      direction: seen?.mechanism?.direction ?? "result",
    });
  }
  // Most recently seen first: the digest's first row should be the one whose
  // key is most likely still in use.
  return out.sort((a, b) => (ts(b.last_seen) ?? 0) - (ts(a.last_seen) ?? 0));
}

export function buildHarmReport(
  result: AuditResult,
  lastReportedAt: string | undefined,
  intervalDays: number,
  leakFindings: LeakFinding[] = [],
): HarmReport {
  const to = new Date(Date.parse(result.scannedAt));
  const windowTo = Number.isFinite(to.getTime()) ? to : new Date();
  const watermark = ts(lastReportedAt);
  const isFirstReport = watermark === null;

  const oneInterval = Math.max(1, intervalDays) * 86_400_000;
  const fallbackFrom = windowTo.getTime() - oneInterval;

  // The watermark is the SERVER's clock; `windowTo` is this machine's. A
  // backwards jump between them — NTP correcting a fast RTC, a VM restored from
  // a snapshot, a dual-boot machine that wrote localtime to the hardware clock
  // — leaves `from` LATER than `to`, and `selectHarmful` then matches nothing
  // at all. That drops every finding silently and permanently: the watermark
  // only ever moves forward, so the window never re-opens, while the run's
  // outcome line still reads normal. The scheduling lane already repairs this
  // class of jump; the reporting half did not. One interval back is a digest
  // that is narrower than it should be, rather than one that is empty forever.
  const from = new Date(
    isFirstReport || watermark >= windowTo.getTime() ? fallbackFrom : watermark,
  );

  return {
    window_from: from.toISOString(),
    window_to: windowTo.toISOString(),
    harmful: selectHarmful(result, from, windowTo, { includeUnplaceable: isFirstReport }),
    // One email, one actionable credential. Sending every row turns a leak
    // alert into a backlog digest and obscures the event that just happened.
    leaks: selectLeaks(leakFindings, from, windowTo).slice(0, 1),
  };
}
