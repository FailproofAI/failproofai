"use client";

/**
 * Enforcement over time.
 *
 * The stats bar answers "how much, in total". This answers the question totals
 * structurally cannot: *when* — a deny spike at 14:00 and a steady trickle all
 * day produce identical totals and mean very different things.
 *
 * Form is EMPHASIS, not categorical: denies are the subject and total volume is
 * context, so one accent carries the story and everything else recedes. That is
 * also the only form available here — the design system allows exactly two
 * accent hues, so a categorical palette over four policy sources could not have
 * been made colourblind-safe. Deny keeps the red the decision badges already
 * use, so the same fact has one colour everywhere on this page.
 *
 * Raw SVG, no charting dependency — matching the house style.
 */
import React, { useCallback, useMemo, useRef, useState } from "react";
import type { ActivityBucket } from "@/src/hooks/activity-timeline";
import { peakTotal } from "@/src/hooks/activity-timeline";

const HEIGHT = 132;
const PAD_L = 34;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 20;
const VIEW_W = 720;

/** Deny red — the same hue as DecisionBadge's `text-red-400`. */
const DENY = "rgb(248 113 113)";

function formatClock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function EnforcementTimeline({ buckets }: { buckets: ActivityBucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const max = useMemo(() => peakTotal(buckets), [buckets]);
  const plotW = VIEW_W - PAD_L - PAD_R;
  const plotH = HEIGHT - PAD_T - PAD_B;

  const x = useCallback(
    (i: number) => PAD_L + (buckets.length <= 1 ? plotW / 2 : (i / (buckets.length - 1)) * plotW),
    [buckets.length, plotW],
  );
  const y = useCallback((v: number) => PAD_T + plotH - (v / max) * plotH, [max, plotH]);

  const totalArea = useMemo(() => {
    if (buckets.length === 0) return "";
    const top = buckets.map((b, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(b.total)}`).join("");
    return `${top}L${x(buckets.length - 1)},${PAD_T + plotH}L${x(0)},${PAD_T + plotH}Z`;
  }, [buckets, x, y, plotH]);

  const denyLine = useMemo(
    () => buckets.map((b, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(b.deny)}`).join(""),
    [buckets, x, y],
  );

  const totals = buckets.reduce((n, b) => n + b.total, 0);
  const denies = buckets.reduce((n, b) => n + b.deny, 0);

  const onMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg || buckets.length === 0) return;
      const rect = svg.getBoundingClientRect();
      // The SVG scales to its container, so client px must be mapped back into
      // viewBox units before they mean anything.
      const vx = ((event.clientX - rect.left) / rect.width) * VIEW_W;
      const ratio = (vx - PAD_L) / plotW;
      const index = Math.round(ratio * (buckets.length - 1));
      setHover(Math.max(0, Math.min(buckets.length - 1, index)));
    },
    [buckets.length, plotW],
  );

  const active = hover === null ? null : buckets[hover];

  return (
    <figure className="mb-4 rounded border border-border/40 bg-muted/[0.03] px-3 pt-2.5 pb-1">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-[0.7rem] font-medium text-foreground">enforcement over time</span>
        {/* Legend: two series, so identity is never colour alone. Text keeps
            text tokens; the swatch beside it carries the identity. */}
        <span className="flex items-center gap-3 text-[0.65rem] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-2 w-2 rounded-[1px] bg-muted-foreground/30" />
            all events ({totals.toLocaleString()})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-2 w-2 rounded-[1px]" style={{ background: DENY }} />
            denied ({denies.toLocaleString()})
          </span>
        </span>
      </figcaption>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${HEIGHT}`}
        className="w-full"
        style={{ height: HEIGHT }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Enforcement activity over the last 24 hours: ${totals} events, ${denies} denied. The table below lists every event.`}
      >
        {/* Recessive axis: one baseline and one peak guide, nothing more. */}
        <line x1={PAD_L} y1={PAD_T + plotH} x2={VIEW_W - PAD_R} y2={PAD_T + plotH}
          stroke="currentColor" strokeOpacity={0.18} strokeWidth={1} />
        <line x1={PAD_L} y1={PAD_T} x2={VIEW_W - PAD_R} y2={PAD_T}
          stroke="currentColor" strokeOpacity={0.07} strokeWidth={1} strokeDasharray="2 4" />
        <text x={PAD_L - 6} y={PAD_T + 4} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.45}>
          {max}
        </text>
        <text x={PAD_L - 6} y={PAD_T + plotH + 3} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.45}>
          0
        </text>

        {/* Context first, so the emphasised series is never occluded. */}
        <path d={totalArea} fill="currentColor" fillOpacity={0.07} />
        <path d={denyLine} fill="none" stroke={DENY} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {buckets.map((b, i) =>
          b.deny > 0 ? (
            // 2px surface ring so a marker over the area stays readable.
            <circle key={i} cx={x(i)} cy={y(b.deny)} r={hover === i ? 4 : 3}
              fill={DENY} stroke="var(--background, #0a0a0a)" strokeWidth={2} />
          ) : null,
        )}

        {hover !== null && (
          <line x1={x(hover)} y1={PAD_T} x2={x(hover)} y2={PAD_T + plotH}
            stroke="currentColor" strokeOpacity={0.25} strokeWidth={1} />
        )}

        {buckets.length > 0 && (
          <>
            <text x={PAD_L} y={HEIGHT - 6} fontSize={9} fill="currentColor" fillOpacity={0.45}>
              {formatClock(buckets[0].t)}
            </text>
            <text x={VIEW_W - PAD_R} y={HEIGHT - 6} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.45}>
              now
            </text>
          </>
        )}
      </svg>

      {/* Tooltip as HTML rather than SVG text: it wraps, inherits type tokens,
          and never needs manual glyph measurement. */}
      <div className="h-4 text-[0.65rem] text-muted-foreground" aria-live="polite">
        {active && (
          <span>
            {formatClock(active.t)} · {active.total} event{active.total === 1 ? "" : "s"}
            {active.deny > 0 && <span style={{ color: DENY }}> · {active.deny} denied</span>}
            {active.instruct > 0 && <span> · {active.instruct} instructed</span>}
          </span>
        )}
      </div>
    </figure>
  );
}
