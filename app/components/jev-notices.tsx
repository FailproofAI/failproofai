"use client";

/**
 * The activity view's rendering of what Jev (the two-tier evaluator) did on a
 * row.
 *
 * Only the rows where Jev changed or could have changed something get a pill:
 * a clear (a regex deny Jev overruled), a fallback (Jev's answer was not used —
 * unavailable, truncated or mismatched — and the regex policies decided alone),
 * and a shadow-mode row where Jev disagreed with what was enforced. A fallback
 * where Jev did answer (the call was truncated to fit the envelope) and its
 * unapplied verdict was stricter than what was enforced gets a louder fallback
 * pill; the collector ships that row on its own for the same reason.
 *
 * An ordinary Jev allow gets none — on a configured machine
 * that is nearly every row, and a pill on all of them marks nothing. Nor does a
 * hard deny Jev was never consulted on, or a call no semantic policy applied
 * to: the detail panel says so, but the row is an ordinary regex result.
 */
import { describeJevActivity, jevOutcome, sanitizeJevActivity, type JevActivityFields } from "@/src/hooks/jev-activity";

type JevRow = JevActivityFields & { decision?: string };

const SEVERITY: Record<string, number> = { allow: 0, instruct: 1, deny: 2 };

/** Which pill a row gets, if any. Exported for tests. */
export function jevPillKind(
  item: JevRow,
): "cleared" | "would-clear" | "fallback" | "fallback-stricter" | "shadow-stricter" | null {
  const e = sanitizeJevActivity(item);
  const outcome = jevOutcome(e);
  if (outcome === null || outcome === "not-consulted" || outcome === "no-request") return null;
  const jevWasStricter = () => (SEVERITY[e.jevDecision ?? "allow"] ?? 0) > (SEVERITY[item.decision ?? "allow"] ?? 0);
  if (outcome === "fallback") return e.jevDecision !== undefined && jevWasStricter() ? "fallback-stricter" : "fallback";
  const cleared = (e.jevCleared ?? []).length > 0;
  if (e.jevMode === "shadow") {
    if (cleared) return "would-clear";
    return jevWasStricter() ? "shadow-stricter" : null;
  }
  return cleared ? "cleared" : null;
}

const PILLS = {
  cleared: {
    label: "jev cleared",
    title: "Jev reviewed a reviewable policy's block and cleared it",
    className: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  "would-clear": {
    label: "jev shadow",
    title: "Shadow mode: Jev would have cleared a block here; the regex result was enforced",
    className: "border-sky-500/30 bg-sky-500/5 text-sky-600/80 dark:text-sky-400/80",
  },
  "shadow-stricter": {
    label: "jev shadow",
    title: "Shadow mode: Jev would have been stricter here; the regex result was enforced",
    className: "border-sky-500/30 bg-sky-500/5 text-sky-600/80 dark:text-sky-400/80",
  },
  "fallback-stricter": {
    label: "jev fallback",
    title: "Jev answered but its answer was not applied (e.g. the call was truncated); it would have been stricter than the regex result",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  fallback: {
    label: "jev fallback",
    title: "Jev's answer was not used for this call (unavailable, truncated or mismatched); the regex policies decided alone",
    className: "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
  },
} as const;

/** Marks a row where Jev cleared, fell back, or (in shadow mode) disagreed. */
export function JevPill({ item }: { item: JevRow }) {
  const kind = jevPillKind(item);
  if (!kind) return null;
  const pill = PILLS[kind];
  return (
    <span
      title={pill.title}
      className={`ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide border ${pill.className}`}
    >
      {pill.label}
    </span>
  );
}

/** The detail-panel line: what Jev said, cleared, or why it fell back. */
export function JevNote({ item }: { item: JevRow }) {
  const facts = describeJevActivity(item);
  if (!facts) return null;
  return (
    <div className="sm:col-span-2 lg:col-span-3">
      <span className="text-muted-foreground">Semantic review: </span>
      <span className="font-mono text-foreground">{facts.join(" · ")}</span>
    </div>
  );
}
