/**
 * `runAudit` — entry point for the `failproofai audit` command.
 *
 * Drives the pipeline: per-CLI adapters → tool events → (replay + audit
 * detectors) → per-transcript results → aggregated `AuditResult`.
 *
 * Parallelizes transcript scans via `lib/concurrency.ts` `batchAll` (8 at a
 * time — bounds disk I/O without overwhelming the policy engine).
 */
import { batchAll } from "../../lib/concurrency";
import { BUILTIN_POLICIES } from "../hooks/builtin-policies";
import { readMergedHooksConfig } from "../hooks/hooks-config";
import { normalizePolicyName } from "../hooks/policy-registry";
import { INTEGRATION_TYPES, type IntegrationType } from "../hooks/types";
import { ADAPTERS } from "./cli-adapters";
import { AUDIT_DETECTORS } from "./detectors";
import { severityForBuiltin } from "./features";
import { readCachedTranscript, writeCachedTranscriptResult } from "./cache";
import { initReplay, replayEvent, restoreReplay } from "./replay";
import {
  AUDIT_EXAMPLE_MAX_CHARS,
  AUDIT_MAX_EXAMPLES_PER_NAME,
  type AuditCount,
  type AuditResult,
  type DetectorSessionState,
  type NormalizedToolEvent,
  type RunAuditOptions,
  type TranscriptAuditResult,
  type TranscriptMetadata,
} from "./types";

const TRANSCRIPT_CONCURRENCY = 8;

/** Canonicalize a policy name to its short, qualified form for display
 *  (`failproofai/foo` → `foo`). */
function shortPolicyName(name: string): string {
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/** Look up a builtin policy definition by canonical name; null when the name
 *  doesn't match a builtin (e.g. user custom policy). */
function findBuiltin(name: string) {
  const short = shortPolicyName(name);
  for (const p of BUILTIN_POLICIES) {
    if (p.name === name || shortPolicyName(p.name) === short) return p;
  }
  return null;
}

/** Build the per-row install hint shown in the report:
 *  - Already enabled builtin: a check phrase ("Already enforced — currently blocking these in real time")
 *  - Unenabled builtin:       `failproofai policies --install <short-name>`
 *  - Audit-only detector:     soft notice ("Audit-only — `failproofai audit` will keep tracking these")
 *  - Unknown / custom:        empty string
 */
function buildInstallHint(
  name: string,
  source: "builtin" | "audit-detector",
  enabled: boolean,
): string {
  if (source === "audit-detector") {
    return "Audit-only — `failproofai audit` will keep tracking these.";
  }
  if (enabled) {
    return "Already enforced — failproofai is blocking these in real time.";
  }
  return `Enable in one command:  failproofai policies --install ${shortPolicyName(name)}`;
}

function truncateExample(s: string): string {
  if (s.length <= AUDIT_EXAMPLE_MAX_CHARS) return s;
  return s.slice(0, AUDIT_EXAMPLE_MAX_CHARS - 1) + "…";
}

function parseSinceOpt(since: string | undefined): number | undefined {
  if (!since) return undefined;
  const m = /^(\d+)\s*([dhm])$/i.exec(since.trim());
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const ms = unit === "d" ? 86400000 : unit === "h" ? 3600000 : 60000;
    return Date.now() - n * ms;
  }
  const t = Date.parse(since);
  if (!Number.isNaN(t)) return t;
  throw new Error(`Invalid --since value: "${since}" (expected e.g. "7d", "30d", or "2026-04-01")`);
}

/**
 * What a scan covered, alongside the result — so the caller can record a resume
 * point without re-deriving it.
 *
 * `bytesScanned` is 0 when the source cannot be resumed at all (a database, or
 * an adapter with no `streamEventsFrom`), which is what stops a resume point
 * being written for something that has no bytes to resume from.
 */
interface ScanOutcome {
  result: TranscriptAuditResult;
  bytesScanned: number;
  detectorState: DetectorSessionState;
}

async function scanOneTranscript(
  meta: TranscriptMetadata,
  resume?: { fromByte: number; detectorState: DetectorSessionState },
): Promise<ScanOutcome> {
  const empty: TranscriptAuditResult = {
    transcriptPath: meta.transcriptPath,
    cli: meta.cli,
    projectName: meta.projectName,
    sessionId: meta.sessionId,
    mtimeMs: meta.mtimeMs,
    sizeBytes: meta.sizeBytes,
    cwd: "",
    eventsScanned: 0,
    hitsByName: {},
    examplesByName: {},
    rangeByName: {},
  };

  const adapter = ADAPTERS[meta.cli];
  // Stream failures must propagate so the orchestrator counts them in
  // `errors` rather than silently returning an empty hits map.
  let events: NormalizedToolEvent[];
  let bytesScanned = 0;
  // A resumed scan carries the stateful detectors' state forward across the
  // boundary. Starting them empty would silently change what they find — the
  // re-read detector's countdown spans tool calls, so an edit before the offset
  // and its wasteful re-read after it would stop being a pair.
  const sessionState: DetectorSessionState = resume?.detectorState ?? {};

  if (adapter.streamEventsFrom) {
    // A full scan is a resume from zero, deliberately — not a separate branch.
    //
    // The separate branch is what got this wrong: it recorded `meta.sizeBytes`
    // as scanned, which is the whole FILE, including a trailing partial line
    // that was never parsed. Transcripts are appended to while the audit reads
    // them, so that tail is routinely half a line — and the next run then
    // resumed past an event nobody had read. Only the reader knows where the
    // last complete line ended, so only the reader gets to say.
    const scan = await adapter.streamEventsFrom(meta, resume?.fromByte ?? 0);
    // Null means it could not be read from there after all — truncated,
    // unreadable, unparseable. A thrown error would count as a scan failure,
    // so fall back to a full read instead and keep the transcript scannable.
    if (!scan) {
      events = await adapter.streamEvents(meta);
      bytesScanned = 0;
    } else {
      events = scan.events;
      bytesScanned = scan.bytesConsumed;
      empty.cwd = scan.cwd ?? "";
    }
  } else {
    // A source with no byte offsets to speak of — a database. Scanned whole,
    // every time, and given no resume point to mislead the next run with.
    events = await adapter.streamEvents(meta);
    bytesScanned = 0;
  }

  if (events.length === 0) {
    return { result: empty, bytesScanned, detectorState: sessionState };
  }

  const result = empty;
  result.eventsScanned = events.length;
  // Capture the session's cwd from the first event that carried one — every
  // event in a single transcript shares the same cwd by construction.
  result.cwd = result.cwd || events[0].cwd || "";

  for (const event of events) {
    // Run audit detectors first (stateful, must see every event).
    for (const detector of AUDIT_DETECTORS) {
      const hit = detector.detect(event, sessionState);
      if (!hit) continue;
      recordHit(
        result,
        detector.name,
        event.timestamp,
        event.cwd,
        truncateExample(hit.example),
      );
    }
    // Then replay through every builtin policy.
    let replayHits;
    try {
      replayHits = await replayEvent(event);
    } catch {
      continue;
    }
    for (const hit of replayHits) {
      const example = formatPolicyExample(hit.policyName, event);
      recordHit(
        result,
        hit.policyName,
        event.timestamp,
        event.cwd,
        truncateExample(example),
      );
    }
  }

  return { result, bytesScanned, detectorState: sessionState };
}

function formatPolicyExample(_policyName: string, event: NormalizedToolEvent): string {
  if (event.toolName === "Bash") {
    const command = (event.toolInput as { command?: unknown }).command;
    if (typeof command === "string") return command.replace(/\s+/g, " ");
  }
  const filePath = (event.toolInput as { file_path?: unknown }).file_path;
  if (typeof filePath === "string") return `${event.toolName} ${filePath}`;
  return `${event.toolName}`;
}

/**
 * Fold a tail-scan into the result the cache already held for the same
 * transcript.
 *
 * Mirrors `recordHit` exactly, and has to: counts add, examples stay capped at
 * the same limit, ranges widen. The one asymmetry is `cwd` — the cached value
 * came from the FIRST event in the file and the tail's came from the first
 * event after the offset, so the older one wins.
 */
function mergeIncremental(
  cached: TranscriptAuditResult,
  tail: TranscriptAuditResult,
): TranscriptAuditResult {
  const out: TranscriptAuditResult = {
    ...cached,
    mtimeMs: tail.mtimeMs,
    sizeBytes: tail.sizeBytes,
    cwd: cached.cwd || tail.cwd || "",
    eventsScanned: (cached.eventsScanned ?? 0) + (tail.eventsScanned ?? 0),
    hitsByName: { ...cached.hitsByName },
    examplesByName: {},
    rangeByName: { ...cached.rangeByName },
  };
  for (const [name, list] of Object.entries(cached.examplesByName)) {
    out.examplesByName[name] = [...list];
  }
  for (const [name, count] of Object.entries(tail.hitsByName)) {
    out.hitsByName[name] = (out.hitsByName[name] ?? 0) + count;
  }
  for (const [name, list] of Object.entries(tail.examplesByName)) {
    const exs = out.examplesByName[name] ?? [];
    for (const ex of list) {
      if (exs.length >= AUDIT_MAX_EXAMPLES_PER_NAME) break;
      exs.push(ex);
    }
    out.examplesByName[name] = exs;
  }
  for (const [name, range] of Object.entries(tail.rangeByName)) {
    const existing = out.rangeByName[name];
    if (!existing) {
      out.rangeByName[name] = { ...range };
    } else {
      if (range.first < existing.first) existing.first = range.first;
      if (range.last > existing.last) existing.last = range.last;
    }
  }
  return out;
}

function recordHit(
  result: TranscriptAuditResult,
  name: string,
  timestamp: string,
  cwd: string,
  example: string,
): void {
  result.hitsByName[name] = (result.hitsByName[name] ?? 0) + 1;
  const exs = result.examplesByName[name] ?? [];
  if (exs.length < AUDIT_MAX_EXAMPLES_PER_NAME) {
    exs.push({ timestamp, cwd, example });
    result.examplesByName[name] = exs;
  }
  const range = result.rangeByName[name];
  if (!range) {
    result.rangeByName[name] = { first: timestamp, last: timestamp };
  } else {
    if (timestamp < range.first) range.first = timestamp;
    if (timestamp > range.last) range.last = timestamp;
  }
}

function aggregateResults(
  perTranscript: TranscriptAuditResult[],
  enabledBuiltins: Set<string>,
): AuditCount[] {
  // For each name: sum hits, count distinct projects, merge ranges + examples.
  const byName = new Map<string, {
    hits: number;
    projects: Set<string>;
    examples: { sessionId: string; cwd: string; timestamp: string; example: string }[];
    first?: string;
    last?: string;
  }>();

  for (const t of perTranscript) {
    for (const [name, count] of Object.entries(t.hitsByName)) {
      const bucket = byName.get(name) ?? {
        hits: 0,
        projects: new Set<string>(),
        examples: [],
      };
      bucket.hits += count;
      bucket.projects.add(t.projectName);
      const tExs = t.examplesByName[name] ?? [];
      for (const e of tExs) {
        if (bucket.examples.length < AUDIT_MAX_EXAMPLES_PER_NAME) {
          bucket.examples.push({ ...e, sessionId: t.sessionId });
        }
      }
      const range = t.rangeByName[name];
      if (range) {
        if (!bucket.first || range.first < bucket.first) bucket.first = range.first;
        if (!bucket.last || range.last > bucket.last) bucket.last = range.last;
      }
      byName.set(name, bucket);
    }
  }

  const detectorByName = new Map(AUDIT_DETECTORS.map((d) => [d.name, d]));
  const out: AuditCount[] = [];
  for (const [name, bucket] of byName) {
    const detector = detectorByName.get(name);
    const isDetector = !!detector;
    const builtin = isDetector ? null : findBuiltin(name);
    const source: "builtin" | "audit-detector" = isDetector ? "audit-detector" : "builtin";
    const enabled = isDetector ? false : enabledBuiltins.has(normalizePolicyName(name));

    const displayTitle =
      detector?.displayTitle
      ?? builtin?.displayTitle
      ?? detector?.description
      ?? builtin?.description
      ?? shortPolicyName(name);
    const impact = detector?.impact ?? builtin?.impact ?? "";

    out.push({
      name,
      source,
      category: detector?.category ?? builtin?.category ?? "Custom",
      // Builtins carry no static severity field — derive it from the policy
      // name prefix (sanitize-/warn-/block-/…) so the score's gentle/medium
      // buckets actually populate instead of everything collapsing to "deny".
      severity: isDetector ? (detector?.severity ?? "info") : severityForBuiltin(name),
      hits: bucket.hits,
      projects: bucket.projects.size,
      firstSeen: bucket.first,
      lastSeen: bucket.last,
      examples: bucket.examples,
      displayTitle,
      impact,
      enabledInConfig: enabled,
      installHint: buildInstallHint(name, source, enabled),
    });
  }

  out.sort((a, b) => b.hits - a.hits);
  return out;
}

export async function runAudit(opts: RunAuditOptions = {}): Promise<AuditResult> {
  const startedAt = Date.now();
  await initReplay();
  try {
    return await runAuditInner(opts, startedAt);
  } finally {
    // Always restore the caller's policy registry, even on error. Without
    // this, embedding runAudit() in a long-running process (e.g. the Next.js
    // dashboard) would clobber any pre-existing policy registrations.
    restoreReplay();
  }
}

async function runAuditInner(opts: RunAuditOptions, startedAt: number): Promise<AuditResult> {
  const clis = (opts.clis ?? Array.from(INTEGRATION_TYPES)) as IntegrationType[];
  const sinceMs = parseSinceOpt(opts.since);

  // Snapshot which builtin policies the user currently has enabled — drives
  // the "already protected" vs "slipping through" split in the report.
  const userConfig = readMergedHooksConfig();
  const enabledBuiltins = new Set(
    (userConfig.enabledPolicies ?? []).map((n) => normalizePolicyName(n)),
  );

  // 1. Discover transcripts across all selected CLIs.
  const allTranscripts: TranscriptMetadata[] = [];
  for (const cli of clis) {
    const adapter = ADAPTERS[cli];
    let list: TranscriptMetadata[];
    try {
      list = await adapter.listTranscripts({ projects: opts.projects, sinceMs });
    } catch {
      continue; // adapter failures shouldn't kill the whole audit
    }
    allTranscripts.push(...list);
  }

  // 2. Scan each transcript (cache-aware), 8 in parallel.
  let skipped = 0;
  let errors = 0;
  const tasks = allTranscripts.map((meta) => async (): Promise<TranscriptAuditResult> => {
    let resume: { fromByte: number; detectorState: DetectorSessionState } | undefined;
    let cachedPrefix: TranscriptAuditResult | null = null;
    if (!opts.noCache) {
      const found = readCachedTranscript(meta.transcriptPath, meta.mtimeMs, meta.sizeBytes);
      if (found?.kind === "hit") return found.result;
      resume = found?.kind === "resume"
        ? { fromByte: found.fromByte, detectorState: found.detectorState }
        : undefined;
      cachedPrefix = found?.kind === "resume" ? found.result : null;
    }
    try {
      const scan = await scanOneTranscript(meta, resume);
      // A resumed scan produced hits for the TAIL only; the cached result holds
      // everything before it. Merging is what makes the two halves one answer.
      const fresh = cachedPrefix ? mergeIncremental(cachedPrefix, scan.result) : scan.result;
      if (!opts.noCache) {
        writeCachedTranscriptResult(
          meta.transcriptPath,
          meta.mtimeMs,
          meta.sizeBytes,
          fresh,
          scan.bytesScanned > 0
            ? { bytesScanned: scan.bytesScanned, detectorState: scan.detectorState }
            : undefined,
        );
      }
      return fresh;
    } catch {
      errors++;
      // Match the empty/full result shape — `cwd` is unknowable here (we
      // never got to scan the events that carry it), but `eventsScanned: 0`
      // is right and keeps the aggregator's `t.eventsScanned ?? 0` shape
      // explicit. cwd defaults to "" so `if (t.cwd)` skips it cleanly.
      return {
        transcriptPath: meta.transcriptPath,
        cli: meta.cli,
        projectName: meta.projectName,
        cwd: "",
        sessionId: meta.sessionId,
        mtimeMs: meta.mtimeMs,
        sizeBytes: meta.sizeBytes,
        eventsScanned: 0,
        hitsByName: {},
        examplesByName: {},
        rangeByName: {},
      };
    }
  });

  const settled = await batchAll(tasks, TRANSCRIPT_CONCURRENCY);
  const perTranscript: TranscriptAuditResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") perTranscript.push(s.value);
    else skipped++;
  }

  // 3. Aggregate.
  let results = aggregateResults(perTranscript, enabledBuiltins);
  if (opts.policies?.length) {
    const wanted = new Set(opts.policies.map(shortPolicyName));
    results = results.filter((r) => wanted.has(shortPolicyName(r.name)));
  }

  const totalsHits = results.reduce((sum, r) => sum + r.hits, 0);
  const projectsWithHits = new Set<string>();
  const projectsScannedSet = new Set<string>();
  let eventsScanned = 0;
  for (const t of perTranscript) {
    if (Object.keys(t.hitsByName).length > 0) projectsWithHits.add(t.projectName);
    if (t.cwd) projectsScannedSet.add(t.cwd);
    eventsScanned += t.eventsScanned ?? 0;
  }

  const auditResult: AuditResult = {
    version: 2,
    scannedAt: new Date(startedAt).toISOString(),
    scope: {
      cli: clis,
      projects: opts.projects ?? "all",
      since: opts.since ?? null,
    },
    transcripts: {
      scanned: allTranscripts.length,
      skipped,
      errors,
      durationMs: Date.now() - startedAt,
    },
    results,
    totals: {
      hits: totalsHits,
      projectsWithHits: projectsWithHits.size,
    },
    projectsScanned: [...projectsScannedSet].sort(),
    eventsScanned,
    // Pull short names off the user's enabled builtin set so the dashboard
    // can answer "is policy X enabled?" without iterating result rows.
    enabledBuiltinNames: [...enabledBuiltins]
      .map((n) => (n.includes("/") ? n.slice(n.indexOf("/") + 1) : n)),
  };

  return auditResult;
}
