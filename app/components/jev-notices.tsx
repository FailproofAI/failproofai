"use client";

/**
 * The activity view's rendering of what Jev (the two-tier evaluator) did on a
 * row.
 *
 * Only the rows where Jev changed or could have changed something get a pill:
 * a clear (a regex deny Jev overruled), a fallback (Jev was unavailable and the
 * regex policies decided alone), and a shadow-mode row where Jev disagreed with
 * what was enforced. An ordinary Jev allow gets none — on a configured machine
 * that is nearly every row, and a pill on all of them marks nothing. Nor does a
 * hard deny Jev was never consulted on, or a call no semantic policy applied
 * to: the detail panel says so, but the row is an ordinary regex result.
 */
import { describeJevActivity, jevOutcome, sanitizeJevActivity, type JevActivityFields } from "@/src/hooks/jev-activity";

type JevRow = JevActivityFields & { decision?: string };

const SEVERITY: Record<string, number> = { allow: 0, instruct: 1, deny: 2 };

/** Which pill a row gets, if any. Exported for tests. */
export function jevPillKind(item: JevRow): "cleared" | "would-clear" | "fallback" | "shadow-stricter" | null {
  const e = sanitizeJevActivity(item);
  const outcome = jevOutcome(e);
  if (outcome === null || outcome === "not-consulted" || outcome === "no-request") return null;
  if (outcome === "fallback") return "fallback";
  const cleared = (e.jevCleared ?? []).length > 0;
  if (e.jevMode === "shadow") {
    if (cleared) return "would-clear";
    const jev = SEVERITY[e.jevDecision ?? "allow"] ?? 0;
    const enforced = SEVERITY[item.decision ?? "allow"] ?? 0;
    return jev > enforced ? "shadow-stricter" : null;
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
  fallback: {
    label: "jev fallback",
    title: "Jev was unavailable for this call; the regex policies decided alone",
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
