"use client";

/**
 * Pixel sigil — 8×8 grid for the archetype. Bare implementation: no plate,
 * no crosshairs, no reveal animation. The poster owns whatever framing it
 * wants around the sigil.
 *
 * Cell letters: `.` empty · `o` ink · `p` pink accent · `g` green accent ·
 * `d` dim.
 */
import React from "react";
import { SIGILS, type ArchetypeKey } from "@/src/audit/archetypes";

interface Props {
  archetypeKey: ArchetypeKey;
}

export function Sigil({ archetypeKey }: Props) {
  const grid = SIGILS[archetypeKey] ?? SIGILS.optimist;
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
      cells.push(<div key={`${y}-${x}`} className={cls} />);
    }
  }

  return <div className="sigil">{cells}</div>;
}
