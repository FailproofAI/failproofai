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
import { readInstalledPacks } from "../hooks/pack-manifest";
import { normalizePolicyName } from "../hooks/policy-registry";
import { INTEGRATION_TYPES, type IntegrationType } from "../hooks/types";
import { ADAPTERS } from "./cli-adapters";
import { AUDIT_DETECTORS } from "./detectors";
import { severityForBuiltin } from "./features";
import { findSecrets, flattenToolInput } from "./leak-scan";
import { fingerprintSecret, fingerprintId } from "./leak-fingerprint";
import { readLeakIdentity, readLeakRecord, writeLeakRecord } from "./leak-store";
import { upsertFinding, describeMechanism } from "./leak-record";
import { shortenPaths } from "./redact-example";
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
  /**
   * Whether this result covers the TAIL only, or the whole transcript.
   *
   * The caller merges a cached prefix onto the result, which is right for a
   * resumed scan and wrong for a full one — and a resume that could not be
   * honoured falls back to a full read RIGHT HERE, several returns away from
   * the merge. Without this the fallback merged a whole-file result onto a
   * prefix that already contained it, and every finding before the resume point
   * was counted twice.
   */
  resumed: boolean;
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
  let resumed = false;
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
      resumed = true;
    }
  } else {
    // A source with no byte offsets to speak of — a database. Scanned whole,
    // every time, and given no resume point to mislead the next run with.
    events = await adapter.streamEvents(meta);
    bytesScanned = 0;
  }

  if (events.length === 0) {
    return { result: empty, bytesScanned, detectorState: sessionState, resumed };
  }

  const result = empty;
  result.eventsScanned = events.length;
  // Capture the session's cwd from the first event that carried one — every
  // event in a single transcript shares the same cwd by construction.
  result.cwd = result.cwd || events[0].cwd || "";

  for (const event of events) {
    // The 8 behavioural detectors are switched off with the rest of the old
    // audit — see the header of `src/audit/scoring.ts`. The modules and their
    // unit tests are untouched; nothing calls them. `sessionState` is still
    // threaded through so a resumed scan keeps its shape and restoring this
    // loop needs no plumbing.
    // for (const detector of AUDIT_DETECTORS) {
    //   const hit = detector.detect(event, sessionState);
    //   if (!hit) continue;
    //   recordHit(
    //     result,
    //     detector.name,
    //     event.timestamp,
    //     event.cwd,
    //     truncateExample(hit.example),
    //   );
    // }
    // Replay through every builtin policy.
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

    // Credential VALUES, which the replay above cannot report: it returns a
    // decision per policy, never the text that matched. Scanned separately so
    // the leak report can name WHICH key, and so detection can be tuned for
    // precision without dragging the redactor's recall down with it.
    recordLeaks(result, event);
  }

  return { result, bytesScanned, detectorState: sessionState, resumed };
}

/**
 * Fingerprint every credential in one event and attach the sightings.
 *
 * The raw value exists only inside this function. It is read out of the event,
 * hashed into a salted id, rendered into a mask, and dropped — nothing that
 * leaves here can reconstruct it.
 *
 * Input and result are scanned separately and tagged, because they are
 * different exposures: an input is what the agent SENT (deniable at PreToolUse
 * on 12/12 CLIs, and 39.5% of measured appearances) while a result is what it
 * RECEIVED (blockable on 2/12, and only after the fact).
 */
function recordLeaks(result: TranscriptAuditResult, event: NormalizedToolEvent): void {
  const salt = leakSalt();
  if (!salt) return;

  const filePath = (event.toolInput as { file_path?: unknown }).file_path;
  const shortPath = typeof filePath === "string" ? shortenPaths(filePath) : null;

  const scan = (text: string, direction: "input" | "result"): void => {
    for (const match of findSecrets(text)) {
      (result.leaks ??= []).push({
        id: fingerprintId(match.value, salt),
        fingerprint: fingerprintSecret(match.value, match.rule),
        name: match.name,
        rule: match.rule,
        shaped: match.shaped,
        timestamp: event.timestamp,
        cwd: event.cwd,
        toolName: event.toolName,
        direction,
        path: shortPath,
      });
    }
  };

  scan(flattenToolInput(event.toolInput), "input");
  if (event.toolResultText !== undefined) scan(event.toolResultText, "result");
}

/**
 * The machine's HMAC salt, read once per process.
 *
 * Cached because `scanOneTranscript` runs this per EVENT — 340,918 of them on
 * the measured corpus — and re-reading a file that many times would dominate
 * the scan. `null` when the store is unreadable, which disables leak recording
 * rather than failing the audit: a scan that cannot fingerprint is still a scan
 * that can count.
 */
let cachedSalt: string | null | undefined;
function leakSalt(): string | null {
  if (cachedSalt === undefined) {
    try {
      cachedSalt = readLeakIdentity().salt;
    } catch {
      cachedSalt = null;
    }
  }
  return cachedSalt;
}

/**
 * Merge this scan's sightings into `~/.failproofai/audit/leaks.json`.
 *
 * Returns the ids seen for the FIRST time, which is the set worth telling a
 * human about. Never throws: a scan that finds leaks it cannot write down has
 * still found them, and the caller reports on the in-memory result either way.
 */
function persistLeaks(perTranscript: TranscriptAuditResult[]): string[] {
  const fresh: string[] = [];
  try {
    const record = readLeakRecord();
    for (const t of perTranscript) {
      for (const leak of t.leaks ?? []) {
        const { isNew } = upsertFinding(record, {
          id: leak.id,
          fingerprint: leak.fingerprint,
          name: leak.name,
          rule: leak.rule,
          // A vendor shape is what licenses an alert to name a console; a
          // name-only match knows something leaked, not who issued it.
          confidence: leak.shaped ? "doc-verified" : "name-only",
          sighting: {
            cli: t.cli,
            sessionId: t.sessionId,
            cwd: shortenPaths(leak.cwd),
            at: leak.timestamp,
            mechanism: describeMechanism(leak.toolName, leak.direction, leak.path),
          },
        });
        if (isNew) fresh.push(leak.id);
      }
    }
    writeLeakRecord(record);
  } catch {
    // Bookkeeping failure must not fail the audit — see leak-store.ts.
  }
  return fresh;
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

  // What the user actually has switched on — drives the "already protected"
  // vs "slipping through" split.
  //
  // Read from BOTH places it can live, because it moved and this only followed
  // it half way. `enabledPolicies` is the pre-packs key, still written by
  // `policies add <name>` and still true on a machine running the migration
  // shim. Everything installed as a PACK records its selection in
  // `installed.json` instead, and `pack-store` never writes `enabledPolicies`
  // at all — so reading that key alone meant installing a pack could not move
  // this split. Every policy read as slipping through no matter what was
  // enforcing, and the number the audit leads with never changed however many
  // policies you installed. Verified: same 302 hits, same 17 findings, before
  // and after installing all 38.
  //
  // The split, not the REPLAY. What gets replayed stays the compiled builtins
  // on purpose — see `initReplay`: an audit is a fixed yardstick, and one that
  // changed shape with whatever pack a machine happened to have could not be
  // compared against its own history. A pack policy sharing a builtin's name
  // marks that builtin protected, which is exactly right: the same rule is
  // enforcing, whichever artifact carries it.
  const userConfig = readMergedHooksConfig();
  const enabledBuiltins = new Set(
    (userConfig.enabledPolicies ?? []).map((n) => normalizePolicyName(n)),
  );
  try {
    for (const pack of readInstalledPacks().packs) {
      // `enabled: null` means the whole pack was taken, so every policy in its
      // catalog counts — the field records a SELECTION, and its absence is not
      // an empty one.
      const taken = pack.enabled ?? pack.policies.map((entry) => entry.name);
      for (const name of taken) enabledBuiltins.add(normalizePolicyName(name));
    }
  } catch {
    // An unreadable manifest must not fail the audit. It costs the split its
    // pack half, which is the same answer this gave for every machine before.
  }

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
      // everything before it. Merging is what makes the two halves one answer —
      // and `scan.resumed`, not `cachedPrefix`, is what says there are two
      // halves. A resume the reader could not honour (truncated, unparseable
      // from that offset, rewritten under us) falls back to reading the WHOLE
      // file, and merging the prefix onto that counted everything before the
      // resume point twice.
      const fresh = cachedPrefix && scan.resumed
        ? mergeIncremental(cachedPrefix, scan.result)
        : scan.result;
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

  // Fold every sighting into the persistent record. This is the ONLY place the
  // leak record is written: `scanOneTranscript` runs 8-way concurrent and a
  // per-transcript write would be eight processes racing one file — the exact
  // shape that lost updates when it was measured (2 concurrent writers, 5/5
  // trials, the loser's entry gone permanently).
  //
  // `newFindingIds` is what a notice keys on: an id already in the record must
  // not alert again however many fresh sightings it accumulates, and a
  // credential seen for the first time must alert even though its rule has
  // fired a thousand times before.
  const newFindingIds = persistLeaks(perTranscript);

  const auditResult: AuditResult = {
    version: 2,
    newLeakIds: newFindingIds,
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
