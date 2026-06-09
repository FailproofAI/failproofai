"use client";

/**
 * Pixel sigil — renders an 8x8 grid from the SIGILS table.
 *
 * Each archetype has an 8x8 character grid where:
 *   . = empty cell    o = ink (foreground)
 *   p = pink accent   g = green accent    d = dim
 *
 * Two rendering modes:
 *
 *  • Default (used on the audit hero, identity-section): wraps the grid in
 *    a brutalist "instrument plate" — register crosshairs at the four
 *    corners, a header strip with the archetype index + an 8×8 coordinate
 *    label, the pixel grid mounted on a dashed inner frame with 20px cells,
 *    a footer strip naming the archetype, and a stacked pink + dim hard-
 *    offset shadow for depth. Cells fade in along a diagonal wave on
 *    mount (`--cx` / `--cy` custom properties), guarded by
 *    `prefers-reduced-motion`.
 *
 *  • hideLabel (used in the ShowOff CTA + html2canvas capture): a bare
 *    `.sigil` grid with no plate or labels, so the showoff card can scale
 *    the sigil down independently and html2canvas doesn't have to capture
 *    the new plate chrome.
 */
import React from "react";
import { ARCHETYPES, SIGILS, type ArchetypeKey } from "@/src/audit/archetypes";

interface Props {
  archetypeKey: ArchetypeKey;
  hideLabel?: boolean;
}

export function Sigil({ archetypeKey, hideLabel }: Props) {
  const grid = SIGILS[archetypeKey] ?? SIGILS.optimist;
  const archetype = ARCHETYPES[archetypeKey];
  const cells: React.ReactElement[] = [];

  for (let y = 0; y < 8; y++) {
    const row = grid[y] ?? "........";
    for (let x = 0; x < 8; x++) {
      const c = row[x] ?? ".";
      let cls = "px";
      if (c === "o") cls += " on";
      else if (c === "p") cls += " p";
      else if (c === "g") cls += " g";
      else if (c === "d") cls += " d";
      cells.push(
        <div
          key={`${y}-${x}`}
          className={cls}
          style={{
            ["--cx" as string]: x,
            ["--cy" as string]: y,
          } as React.CSSProperties}
        />,
      );
    }
  }

  if (hideLabel) {
    return (
      <div className="sigil-wrap" data-bare="true">
        <div className="sigil">{cells}</div>
      </div>
    );
  }

  const indexLabel = String(archetype.index).padStart(2, "0");

  return (
    <div className="sigil-wrap">
      <div className="sigil-plate">
        <span className="sigil-mark tl" aria-hidden="true" />
        <span className="sigil-mark tr" aria-hidden="true" />
        <span className="sigil-mark bl" aria-hidden="true" />
        <span className="sigil-mark br" aria-hidden="true" />

        <div className="sigil-strip sigil-strip--top">
          <span className="sigil-ix">№ {indexLabel}</span>
          <span className="sigil-coord">8×8</span>
        </div>

        <div className="sigil">{cells}</div>

        <div className="sigil-strip sigil-strip--bot">
          <span className="sigil-strip-key">sigil</span>
          <span className="sigil-strip-val">{archetypeKey}</span>
        </div>
      </div>
    </div>
  );
}
