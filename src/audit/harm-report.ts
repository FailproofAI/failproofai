/**
 * Turning an audit result into a harm report the api-server can act on.
 *
 * Runs only after a SCHEDULED scan (`failproofai audit --scheduled`), only when
 * the user has switched emailed reports on, and only ever from the audit child —
 * never the daemon, which holds no human credential precisely so that refresh
 * rotation stays inside the audit lock. See `crates/failproofaid/src/audit_lane.rs`.
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

export interface HarmReport {
  window_from?: string;
  window_to: string;
  harmful: ReportedPolicy[];
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
 * `from` undefined means "everything up to `to`" — a machine's first report,
 * the only time it legitimately has no watermark.
 *
 * A policy with NO usable timestamps is included when there is no lower bound
 * and excluded when there is. It cannot be placed, and the two failure
 * directions are not equal: on a first report, dropping it loses a real finding;
 * on a later one, including it re-reports something already covered. Silence
 * about something new is the worse of the two, and repetition is the more
 * annoying, so each window gets the answer that fails the way it can afford to.
 */
export function selectHarmful(
  result: AuditResult,
  from: Date | undefined,
  to: Date,
): ReportedPolicy[] {
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
      if (at === null) return fromMs === null;
      if (fromMs !== null && at <= fromMs) return false;
      return at <= toMs;
    });

    if (last === null && first === null && fromMs !== null) continue;

    // Wholly inside the window → the real total. Straddling it → the examples
    // that actually fall inside, which undercounts but never invents.
    const wholly = fromMs === null || (first !== null && first > fromMs);
    const hits = wholly ? count.hits : inWindow.length;
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
 */
export function buildHarmReport(
  result: AuditResult,
  lastReportedAt: string | undefined,
): HarmReport {
  const to = new Date(Date.parse(result.scannedAt));
  const windowTo = Number.isFinite(to.getTime()) ? to : new Date();
  const fromMs = ts(lastReportedAt);
  const from = fromMs === null ? undefined : new Date(fromMs);

  return {
    window_from: from?.toISOString(),
    window_to: windowTo.toISOString(),
    harmful: selectHarmful(result, from, windowTo),
  };
}
