"use client";

/**
 * The dashboard's rendering of a paused machine.
 *
 * Split out of `hooks-client.tsx` because these are the pieces that keep the
 * activity view honest: a row evaluated during a pause looks identical to one
 * where every policy ran and allowed, and without saying so the log asserts a
 * clean window over exactly the window that was not enforced.
 */
import React, { useEffect, useState } from "react";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import type { ActivePause } from "@/src/hooks/session-pause";

/** Compact "time left" for a future timestamp. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "expiring now";
  // Sub-minute is checked before rounding: Math.round(30s) is "1m", which tells
  // someone they have more time than they do. On a countdown to enforcement
  // coming back, never round up.
  if (ms < 60_000) return "under a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

/**
 * Live state, not history: enforcement is paused RIGHT NOW.
 *
 * The rows below cannot carry this on their own — a pause set seconds ago has
 * produced none yet, and that is precisely when someone needs telling that the
 * machine is unguarded. An absent banner has to mean "enforcing", so this is fed
 * from live pause state rather than inferred from whatever is on screen.
 */
export function PausedBanner({ pauses, now: nowProp }: { pauses: ActivePause[]; now?: number }) {
  const [tick, setTick] = useState(() => Date.now());
  // Re-render on a timer so "22m left" does not sit frozen while the pause
  // silently drains away.
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const now = nowProp ?? tick;

  // Filter again here rather than trusting the fetch: the list was accurate
  // when it arrived, and a short pause can expire between polls.
  const live = pauses.filter((p) => p.expiresAt > now);
  if (live.length === 0) return null;
  const soonest = live.reduce((a, b) => (a.expiresAt < b.expiresAt ? a : b));

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2.5 rounded border border-amber-500/40 bg-amber-500/[0.07] px-3 py-2.5"
    >
      <ShieldAlert className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" aria-hidden="true" />
      <div className="text-xs leading-relaxed">
        <p className="font-medium text-foreground">
          Enforcement is paused for {live.length} session{live.length === 1 ? "" : "s"} —{" "}
          {formatRemaining(soonest.expiresAt - now)} left
          {live.length > 1 ? " on the next to expire" : ""}.
        </p>
        <p className="text-muted-foreground mt-0.5">
          Builtin, custom and convention policies are suspended for{" "}
          {live.length === 1 ? "that session" : "those sessions"}; cloud-managed policies keep
          enforcing. It lifts on its own — or run{" "}
          <span className="font-mono text-foreground">failproofai config --resume</span>.
        </p>
      </div>
    </div>
  );
}

/** Marks a row that was evaluated while enforcement was paused. */
export function PausedPill() {
  return (
    <span
      title="Enforcement was paused for this session — local policies did not run"
      className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-500"
    >
      paused
    </span>
  );
}

/** Why an `allow` on this row proves nothing. */
export function PausedNote({
  item,
}: {
  item: { pausedBy?: string; pauseExpiresAt?: number };
}) {
  if (!item.pausedBy) return null;
  const lifted =
    typeof item.pauseExpiresAt === "number"
      ? new Date(item.pauseExpiresAt).toLocaleTimeString()
      : null;
  return (
    <div className="sm:col-span-2 lg:col-span-3 mt-1 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
      <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-500/80 mt-0.5" aria-hidden="true" />
      <p className="text-[0.7rem] leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Not enforced — paused.</span> Enforcement was
        suspended for this session
        {item.pausedBy === "cli" ? " from the CLI" : ` by ${item.pausedBy}`}
        {lifted ? `, lifting at ${lifted}` : ""}. Builtin, custom and convention policies did not
        run for this event; cloud-managed policies did.
      </p>
    </div>
  );
}
