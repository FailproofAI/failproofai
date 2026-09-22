import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { JevNote, JevPill, jevPillKind } from "@/app/components/jev-notices";
import { JEV_NOT_CONSULTED_FACT } from "@/src/hooks/jev-activity";

// Exactly what the two-tier combine rules record for a hard deny: Jev was
// aborted and its answer never read.
const HARD_DENY = { decision: "deny", evaluator: "jev" as const, jevMode: "enforce" as const };
const HARD_DENY_SHADOW = { decision: "deny", evaluator: "jev" as const, jevMode: "shadow" as const };

describe("a hard deny Jev was not consulted on", () => {
  it("gets no pill: it is an ordinary regex deny", () => {
    expect(jevPillKind(HARD_DENY)).toBeNull();
    expect(jevPillKind(HARD_DENY_SHADOW)).toBeNull();
    const { container } = render(<JevPill item={HARD_DENY} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says so in the detail panel instead of a bare label", () => {
    const { container } = render(<JevNote item={HARD_DENY} />);
    expect(screen.getByText(JEV_NOT_CONSULTED_FACT)).toBeInTheDocument();
    expect(container.textContent).toBe(`Semantic review: ${JEV_NOT_CONSULTED_FACT}`);
  });
});
