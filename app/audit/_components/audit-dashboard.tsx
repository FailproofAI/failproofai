"use client";

/**
 * Top-level client wrapper for /audit.
 *
 * Composes the personality report: classify the agent into one of 8
 * archetypes, derive a score + tier, render the IdentitySection +
 * ShowOff + Strengths + Score (with leaderboard) + Findings + Policies
 * + Return-loop CTA.
 *
 * Empty / running states fall back to the existing EmptyState and
 * RunProgress components.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAuditResultAction } from "@/app/actions/get-audit-result";
import type { AuditResult, RunAuditOptions } from "@/src/audit/types";
import { classifyAgent } from "@/src/audit/archetypes";
import { COHORT_SIZE, deriveScore, gradeFor, projectedScore, type Grade } from "@/src/audit/scoring";
import { deriveStrengths } from "@/src/audit/strengths";
import { deriveFindings } from "@/src/audit/findings";
import { usePostHog } from "@/contexts/PostHogContext";

import { IdentitySection } from "./identity-section";
import { ShareDock } from "./share-dock";
import { StrengthsSection } from "./strengths-section";
import { ScoreSection } from "./score-section";
import { FindingsSection } from "./findings-section";
import { PoliciesSection } from "./policies-section";
import { ReturnSection } from "./return-section";
import { ReportFooter } from "./report-footer";
import { EmptyState } from "./empty-state";
import { RunProgress } from "./run-progress";

// IMPORTANT: do NOT import BUILTIN_POLICIES or AUDIT_DETECTORS here.
// Both pull in node:fs and execSync (workflow policies), which Next.js
// refuses to bundle for the client. The total catalog size is computed
// server-side in page.tsx and passed in as a plain number prop.

type Initial =
  | { status: "cached"; cachedAt: string; params: RunAuditOptions; result: AuditResult }
  | { status: "empty" };

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

function inferWindow(params: RunAuditOptions | undefined): string {
  if (!params?.since) return "all time";
  return params.since;
}

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

export function AuditDashboard({ initial, projectFromUrl, totalCatalogSize }: Props) {
  const [cache, setCache] = useState<Initial>(initial);
  const [running, setRunning] = useState(false);
  const { capture } = usePostHog();
  const pageViewStateRef = useRef<string | null>(null);
  const scrollTrackedRef = useRef(false);
  const transcriptsScanned = cache.status === "cached" ? cache.result.transcripts.scanned : 0;
  const resultsCount = cache.status === "cached" ? cache.result.results.length : 0;

  const refreshFromCache = useCallback(async () => {
    const payload = await getAuditResultAction();
    if (payload.status === "cached") setCache(payload);
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
        onStarted={() => setRunning(true)}
        onCompleted={async () => { setRunning(false); await refreshFromCache(); }}
      />
    );
  }
  if (cache.status === "empty" && running) {
    return (
      <ShellEmpty
        running
        onStarted={() => {}}
        onCompleted={async () => { setRunning(false); await refreshFromCache(); }}
      />
    );
  }

  // cache.status === "cached"
  const result = cache.status === "cached" ? cache.result : null;
  if (!result) return null;
  const cachedAt = cache.status === "cached" ? cache.cachedAt : null;
  const params = cache.status === "cached" ? cache.params : undefined;

  /* ---- scanned but zero sessions --------------------------------- */
  if (result.transcripts.scanned === 0) {
    return (
      <ShellEmpty
        running={running}
        mode="zero-sessions"
        onStarted={() => setRunning(true)}
        onCompleted={async () => { setRunning(false); await refreshFromCache(); }}
      />
    );
  }

  /* ---- in-flight re-run ------------------------------------------ */
  if (running) {
    return (
      <div className="app">
        <div className="scanline-overlay" />
        <div className="app-shell">
          <div className="report">
            <RunProgress />
          </div>
          <ReportFooter cachedAt={cachedAt} />
        </div>
      </div>
    );
  }

  /* ---- main report ----------------------------------------------- */
  return (
    <MainReport
      result={result}
      cachedAt={cachedAt}
      params={params}
      projectFromUrl={projectFromUrl}
      totalCatalogSize={totalCatalogSize}
    />
  );
}

interface MainReportProps {
  result: AuditResult;
  cachedAt: string | null;
  params: RunAuditOptions | undefined;
  projectFromUrl?: string;
  totalCatalogSize: number;
}

function MainReport({ result, cachedAt, params, projectFromUrl, totalCatalogSize }: MainReportProps) {
  const { capture } = usePostHog();
  const classification = useMemo(() => classifyAgent(result), [result]);
  const score = useMemo(() => deriveScore(result), [result]);
  const projected = useMemo(() => projectedScore(result, score), [result, score]);
  const grade = gradeFor(score);
  const projectedGrade = gradeFor(projected);
  const strengths = useMemo(() => deriveStrengths(result), [result]);
  const findings = useMemo(() => deriveFindings(result), [result]);
  const project = useMemo(() => inferProjectName(result, projectFromUrl), [result, projectFromUrl]);
  // Renamed from `window` to avoid shadowing the browser global — any
  // future `window.*` reference added inside MainReport would silently
  // bind to a string and crash at runtime.
  const scopeWindow = inferWindow(params);

  // One pass over result.results derives both counts; score-section and
  // return-section also need `missing` but they take it from us via props
  // / `result` shape, so deduplicate the scan here.
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
      score,
      grade,
      archetype: classification.archetype,
      secondary: classification.secondary ?? null,
      missing,
      transcripts_scanned: result.transcripts.scanned,
      results_count: result.results.length,
      detectors_triggered: detectorsTriggered,
    });
  }, [
    capture,
    score,
    grade,
    classification.archetype,
    classification.secondary,
    missing,
    result.transcripts.scanned,
    result.results.length,
    detectorsTriggered,
  ]);

  /** Identity hero ref — captured to PNG by the share buttons. */
  const identityFrameRef = useRef<HTMLDivElement>(null);

  return (
    <div className="app">
      <div className="scanline-overlay" />
      <div className="app-shell">
        <div className="report">
          <IdentitySection
            ref={identityFrameRef}
            archetypeKey={classification.archetype}
            secondaryKey={classification.secondary}
            toolCalls={result.eventsScanned ?? 0}
            sessions={result.transcripts.scanned}
            window={scopeWindow}
            seed={project}
          />
          <StrengthsSection
            strengths={strengths}
            totalDetectorsTriggered={detectorsTriggered}
            totalDetectorsAvailable={totalCatalogSize}
          />
          <ScoreSection
            result={result}
            score={score}
            grade={grade}
            archetypeKey={classification.archetype}
            project={project}
          />
          <ReturnSection result={result} />
          <FindingsSection findings={findings} />
          <PoliciesSection result={result} projected={projected} projectedGrade={projectedGrade} />
        </div>
        <ReportFooter cachedAt={cachedAt} />
      </div>
      <ShareDock
        frameRef={identityFrameRef}
        archetypeKey={classification.archetype}
        seed={project}
        score={score}
        grade={grade}
        missing={missing}
      />
    </div>
  );
}

interface ShellEmptyProps {
  running: boolean;
  mode?: "no-cache" | "zero-sessions";
  onStarted: () => void;
  onCompleted: () => Promise<void> | void;
}

function ShellEmpty({ running, mode = "no-cache", onStarted, onCompleted }: ShellEmptyProps) {
  // Use the archetype "optimist" sigil for the empty-state visual so the
  // page doesn't render with a dead box. EmptyState itself is unchanged
  // from the previous build.
  return (
    <div className="app">
      <div className="scanline-overlay" />
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
