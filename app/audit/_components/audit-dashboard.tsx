"use client";

/**
 * Top-level client wrapper for /audit.
 *
 * The old five-section personality report is SWITCHED OFF and being rebuilt
 * bottom-up around leak detection. What it used to compose:
 *
 *   01 AuditPoster — single-screen shareable poster
 *   02 StrengthsSection — what it's great at
 *   03 QuirksSection — what slipped through
 *   04 HowToImproveSection — install / configure
 *   05 ComeBackBetterSection — spread the audit (invite)
 *
 * Every one of those components, and the score / persona / strengths / findings
 * modules behind them, is intact and still unit-tested — only the renders and
 * the imports here are commented out, so restoring any of it is deleting a pair
 * of comment markers. See the header of `src/audit/scoring.ts` for why.
 *
 * What this page renders now is `AuditReportPlaceholder`: the scan's own
 * numbers. The scan, the 12-CLI transcript reader and the emailed digest all
 * still run.
 *
 * Empty / running states fall back to EmptyState and RunProgress.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAuditResultAction } from "@/app/actions/get-audit-result";
import type { AuditResult, RunAuditOptions } from "@/src/audit/types";
// import { classifyAgent } from "@/src/audit/archetypes";
// Score switched off — see the header of `src/audit/scoring.ts`.
// import { deriveScore, gradeFor, projectedScore } from "@/src/audit/scoring";
// import { deriveStrengths } from "@/src/audit/strengths";
// import { deriveFindings } from "@/src/audit/findings";
import { usePostHog } from "@/contexts/PostHogContext";

// The old report's five sections — switched off, not deleted. Each component
// file and its tests are untouched; only this render is commented out.
// import { AuditPoster } from "./audit-poster";
// import { StrengthsSection } from "./strengths-section";
// import { QuirksSection } from "./quirks-section";
// import { HowToImproveSection } from "./how-to-improve-section";
// import { ComeBackBetterSection } from "./come-back-better-section";
import { ReportFooter } from "./report-footer";
import { LeakSection } from "./leak-section";
import { EmptyState } from "./empty-state";
import { RunProgress } from "./run-progress";
import { AuditProgressStrip, type RerunStatus } from "./audit-progress-strip";
import { RerunError, triggerRun } from "./rerun-button";

// IMPORTANT: do NOT import BUILTIN_POLICIES or AUDIT_DETECTORS here.
// Both pull in node:fs and execSync (workflow policies), which Next.js
// refuses to bundle for the client. The total catalog size is computed
// server-side in page.tsx and passed in as a plain number prop.

type Initial =
  | { status: "cached"; cachedAt: string; params: RunAuditOptions; result: AuditResult }
  | { status: "empty"; expired: boolean; expiredAt: string | null };

/** Tag passed to the shared `startRerun()` handler so PostHog can tell
 *  whether the click came from the bottom return-section button or the
 *  empty-state CTA. */
export type RerunSource = "return_section" | "empty_state";

interface Props {
  initial: Initial;
  /** ?p=... URL param override for the project name in the leaderboard
   *  row. Defaults to whichever cwd has the most hits, falling back to
   *  "your agent". */
  projectFromUrl?: string;
  /** Total number of detectors + builtin policies. Computed server-side
   *  in page.tsx — the modules can't ship to the client. */
  totalCatalogSize: number;
}

/* Switched off with the persona layer — this named the project that seeded the
   archetype classifier and the leaderboard row. Restore alongside
   `classifyAgent` in this file.
function inferProjectName(result: AuditResult, override?: string): string {
  if (override && override.trim()) return override;
  // Pick the cwd that appears in the most examples — proxy for "your
  // most-active project". Falls back to "your agent".
  const counts = new Map<string, number>();
  for (const row of result.results) {
    for (const ex of row.examples) {
      if (!ex.cwd) continue;
      counts.set(ex.cwd, (counts.get(ex.cwd) ?? 0) + 1);
    }
  }
  let bestCwd = "";
  let bestCount = 0;
  for (const [cwd, n] of counts) {
    if (n > bestCount) { bestCwd = cwd; bestCount = n; }
  }
  if (!bestCwd) return "your agent";
  const segs = bestCwd.replace(/\/+$/, "").split(/[\\/]/);
  // Use last two path segments — like "blrnow / api-coder".
  if (segs.length >= 2) return `${segs[segs.length - 2]} / ${segs[segs.length - 1]}`;
  return segs[segs.length - 1] ?? "your agent";
}
*/

export function AuditDashboard({ initial, projectFromUrl, totalCatalogSize }: Props) {
  const [cache, setCache] = useState<Initial>(initial);
  const [running, setRunning] = useState(false);
  const [rerunStatus, setRerunStatus] = useState<RerunStatus>({ kind: "idle" });
  const { capture } = usePostHog();
  const pageViewStateRef = useRef<string | null>(null);
  const scrollTrackedRef = useRef(false);
  const transcriptsScanned = cache.status === "cached" ? cache.result.transcripts.scanned : 0;
  const resultsCount = cache.status === "cached" ? cache.result.results.length : 0;

  const refreshFromCache = useCallback(async () => {
    const payload = await getAuditResultAction();
    setCache(payload);
  }, []);

  /** Shared re-audit handler used by the top bar and the bottom button.
   *  Drives `rerunStatus` (which renders the sticky progress strip) and
   *  soft-refreshes the dashboard cache on success — no full page reload. */
  const startRerun = useCallback(async (source: RerunSource) => {
    if (running) return;
    capture("audit_rerun_clicked", { source, since: "all" });
    setRunning(true);
    const startedAt = Date.now();
    setRerunStatus({ kind: "running", startedAt });
    try {
      // noCache: an explicit re-audit bypasses the per-transcript cache and
      // re-scans from scratch — never a silent no-op that returns the identical
      // cached result. The fresh result overwrites the dashboard cache on
      // success; the prior cache survives a failed run so the report doesn't vanish.
      // The empty-state first-run (empty-state.tsx) deliberately stays on the
      // fast cached path — it's a first scan, not a re-audit.
      await triggerRun({ cli: [], since: "all", noCache: true });
      await refreshFromCache();
      capture("audit_rerun_succeeded", {
        source,
        since: "all",
        duration_ms: Date.now() - startedAt,
      });
      setRerunStatus({ kind: "idle" });
    } catch (err) {
      const kind = err instanceof RerunError ? err.kind : "network";
      capture("audit_rerun_failed", {
        kind,
        source,
        since: "all",
        cli_filter: "all",
        duration_ms: Date.now() - startedAt,
      });
      setRerunStatus({ kind: "failed", reason: kind, failedAt: Date.now() });
    } finally {
      setRunning(false);
    }
  }, [capture, refreshFromCache, running]);

  const dismissRerunStatus = useCallback(() => {
    setRerunStatus({ kind: "idle" });
  }, []);

  // Body class for audit-only background + grain texture. Applied once on
  // mount so the body bg switches from the global #0a0a0a to the audit
  // #131316 only on this route.
  useEffect(() => {
    document.body.classList.add("audit-body");
    return () => document.body.classList.remove("audit-body");
  }, []);

  useEffect(() => {
    const viewState =
      running
        ? "running"
        : cache.status === "empty"
          ? "empty"
          : transcriptsScanned === 0
            ? "zero_sessions"
            : "report";
    if (pageViewStateRef.current === viewState) return;
    pageViewStateRef.current = viewState;
    capture("audit_page_viewed", {
      state: viewState,
      has_cache: cache.status === "cached",
    });
  }, [cache.status, capture, running, transcriptsScanned]);

  useEffect(() => {
    scrollTrackedRef.current = false;
  }, [cache.status, running, transcriptsScanned]);

  useEffect(() => {
    if (running || cache.status !== "cached" || transcriptsScanned === 0) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      if (scrollTrackedRef.current) return;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      if (maxScroll <= 0) return;
      const reachedBottom = window.scrollY >= maxScroll - 24;
      if (!reachedBottom) return;
      scrollTrackedRef.current = true;
      capture("audit_page_scrolled_to_end", {
        results_count: resultsCount,
        transcripts_scanned: transcriptsScanned,
      });
    };
    // Coalesce scroll events to one rAF — reading scrollHeight forces a
    // layout reflow, which we don't want firing 60+ times per second.
    const onScroll = () => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [cache.status, capture, resultsCount, running, transcriptsScanned]);

  /* ---- empty / first-run ----------------------------------------- */
  if (cache.status === "empty" && !running) {
    return (
      <ShellEmpty
        running={false}
        rerunStatus={rerunStatus}
        onDismissRerun={dismissRerunStatus}
        onStarted={() => setRunning(true)}
        onCompleted={async () => { setRunning(false); await refreshFromCache(); }}
      />
    );
  }
  if (cache.status === "empty" && running) {
    return (
      <ShellEmpty
        running
        rerunStatus={rerunStatus}
        onDismissRerun={dismissRerunStatus}
        onStarted={() => {}}
        onCompleted={async () => { setRunning(false); await refreshFromCache(); }}
      />
    );
  }

  // cache.status === "cached"
  const result = cache.status === "cached" ? cache.result : null;
  if (!result) return null;
  const cachedAt = cache.status === "cached" ? cache.cachedAt : null;
  /* ---- scanned but zero sessions --------------------------------- */
  if (result.transcripts.scanned === 0) {
    return (
      <ShellEmpty
        running={running}
        mode="zero-sessions"
        rerunStatus={rerunStatus}
        onDismissRerun={dismissRerunStatus}
        onStarted={() => setRunning(true)}
        onCompleted={async () => { setRunning(false); await refreshFromCache(); }}
      />
    );
  }

  /* ---- main report ----------------------------------------------- */
  // Note: on re-audit from a cached state, we deliberately stay on the
  // MainReport instead of swapping to RunProgress. The sticky
  // AuditProgressStrip provides the in-flight indicator, and the soft
  // refresh on completion (via refreshFromCache) avoids a full reload.
  return (
    <MainReport
      result={result}
      cachedAt={cachedAt}
      projectFromUrl={projectFromUrl}
      isRunning={running}
      rerunStatus={rerunStatus}
      onRerun={(source) => startRerun(source)}
      onDismissRerun={dismissRerunStatus}
    />
  );
}

interface MainReportProps {
  result: AuditResult;
  cachedAt: string | null;
  projectFromUrl?: string;
  isRunning: boolean;
  rerunStatus: RerunStatus;
  onRerun: (source: RerunSource) => void;
  onDismissRerun: () => void;
}

function MainReport({
  result,
  cachedAt,
  projectFromUrl,
  isRunning,
  rerunStatus,
  onRerun,
  onDismissRerun,
}: MainReportProps) {
  const { capture } = usePostHog();
  // Only fed the persona classifier, which is switched off with it.
  // const project = useMemo(() => inferProjectName(result, projectFromUrl), [result, projectFromUrl]);
  // Seed classification with the project name so the behaviour fingerprint
  // (used for tie-breaks + copy variants) is stable per project.
  // Persona classification is switched off with the rest of the old report. Its
  // last live use was two telemetry properties describing a persona the product
  // no longer shows anyone.
  // const classification = useMemo(() => classifyAgent(result, project), [result, project]);
  // Score switched off — see the header of `src/audit/scoring.ts`. The four
  // functions are intact and still unit-tested; nothing calls them.
  // const score = useMemo(() => deriveScore(result), [result]);
  // const projected = useMemo(() => projectedScore(result, score), [result, score]);
  // const grade = gradeFor(score);
  // const projectedGrade = gradeFor(projected);
  // const strengths = useMemo(() => deriveStrengths(result), [result]);
  // const findings = useMemo(() => deriveFindings(result), [result]);

  // One pass over result.results: detectors triggered + missing prescribed
  // policies. Both feed PostHog instrumentation; `missing` also feeds the
  // poster's share-text template.
  const { detectorsTriggered, missing } = useMemo(() => {
    let detectorsTriggered = 0;
    let missing = 0;
    for (const r of result.results) {
      if (r.hits > 0) detectorsTriggered++;
      if (r.source === "builtin" && !r.enabledInConfig && r.hits > 0) missing++;
    }
    return { detectorsTriggered, missing };
  }, [result]);

  // Fire-once dashboard-rendered event so we can compute click-through
  // rates against the share/download/rerun click events we already track.
  const dashboardViewedRef = useRef(false);
  useEffect(() => {
    if (dashboardViewedRef.current) return;
    dashboardViewedRef.current = true;
    capture("audit_dashboard_viewed", {
      // Score switched off — see `src/audit/scoring.ts`. `missing` is the
      // prescription's denominator and is unaffected, so the copy→install
      // funnel keeps both of its ends.
      // score,
      // grade,
      // archetype: classification.archetype,
      // secondary: classification.secondary ?? null,
      missing,
      transcripts_scanned: result.transcripts.scanned,
      results_count: result.results.length,
      detectors_triggered: detectorsTriggered,
    });
  }, [
    capture,
    missing,
    result.transcripts.scanned,
    result.results.length,
    detectorsTriggered,
  ]);

  /** Poster ref — captured to PNG by the poster's share buttons. */
  // const posterRef = useRef<HTMLDivElement>(null);

  return (
    <div className="app">
      <AuditProgressStrip status={rerunStatus} onDismiss={onDismissRerun} />
      <div className="app-shell">
        <div className="report">
          <AuditReportPlaceholder
            transcripts={result.transcripts.scanned}
            events={result.eventsScanned ?? 0}
            projects={result.projectsScanned.length}
          />
          {/* The rebuilt report. It reads the leak record rather than this
              scan's result, deliberately: a credential found last month and
              not touched by today's transcripts is still a credential to
              rotate, and a report that showed only the current scan's findings
              would go quiet on exactly those. */}
          <LeakSection />
          {/* The whole old report is switched off — the persona poster, the
              strengths and quirks sections, the punch-list with its install-all
              funnel, and the invite section. It is being rebuilt bottom-up
              around leak detection; see the header of `src/audit/scoring.ts`
              for the reasoning and `~/Desktop/failproofai-leak-detection-
              verdict-2026-09-07.md` for the measurements behind it.

              Every component below is intact and still unit-tested — only the
              render is commented — so restoring any one of them is deleting a
              pair of comment markers.

          <AuditPoster
            ref={posterRef}
            archetypeKey={classification.archetype}
            seed={classification.variantSeed}
            // score={score}
            // grade={grade}
            missing={missing}
            auditedAt={cachedAt ?? new Date().toISOString()}
          />
          <StrengthsSection strengths={strengths} />
          <QuirksSection findings={findings} />
          <HowToImproveSection
            result={result}
          // projected={projected}
          // projectedGrade={projectedGrade}
          />
          <ComeBackBetterSection />
          */}
        </div>
        <ReportFooter cachedAt={cachedAt} />
      </div>
    </div>
  );
}

/**
 * What `/audit` shows while the report is being rebuilt.
 *
 * Deliberately states the scan's own numbers rather than nothing at all: the
 * scan still runs, still walks every transcript across all 12 CLIs, and still
 * feeds the emailed digest. Saying so is the difference between "this page is
 * under construction" and "this product is broken".
 */
function AuditReportPlaceholder(
  { transcripts, events, projects }: { transcripts: number; events: number; projects: number },
) {
  const n = (x: number) => x.toLocaleString();
  return (
    <section className="audit-sec" data-screen-label="01 Scan">
      <div className="audit-sec-head">
        <span className="audit-sec-eyebrow">
          <span className="ix">01</span>{"// scan"}
        </span>
      </div>
      <h2 className="audit-sec-title">scan complete</h2>
      <div className="audit-sec-sub">
        {n(events)} tool call{events === 1 ? "" : "s"} across {n(transcripts)}{" "}
        transcript{transcripts === 1 ? "" : "s"}
        {projects > 0 ? ` · ${n(projects)} project${projects === 1 ? "" : "s"}` : ""}
      </div>
      <div className="audit-sec-sub">
        {"// the report is being rebuilt around leak detection. the scan, the"}
        <br />
        {"// 12-CLI transcript reader and the emailed digest are unaffected."}
      </div>
    </section>
  );
}

interface ShellEmptyProps {
  running: boolean;
  mode?: "no-cache" | "zero-sessions";
  rerunStatus: RerunStatus;
  onDismissRerun: () => void;
  onStarted: () => void;
  onCompleted: () => Promise<void> | void;
}

function ShellEmpty({ running, mode = "no-cache", rerunStatus, onDismissRerun, onStarted, onCompleted }: ShellEmptyProps) {
  // Use the archetype "optimist" sigil for the empty-state visual so the
  // page doesn't render with a dead box. EmptyState itself is unchanged
  // from the previous build.
  return (
    <div className="app">
      <AuditProgressStrip status={rerunStatus} onDismiss={onDismissRerun} />
      <div className="app-shell">
        <div className="report">
          {running ? (
            <RunProgress />
          ) : (
            <EmptyState
              mode={mode}
              running={running}
              onStarted={onStarted}
              onCompleted={onCompleted}
            />
          )}
        </div>
        <ReportFooter cachedAt={null} fixed />
      </div>
    </div>
  );
}
