import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { JevNote, JevPill, jevPillKind } from "@/app/components/jev-notices";
import { JEV_NO_REQUEST_FACT } from "@/src/hooks/jev-activity";

// Exactly what the two-tier path records when no semantic policy applies to the
// call (TodoWrite, Task, …): nothing was asked, no request was sent.
const NO_REQUEST = { decision: "allow", evaluator: "jev" as const, jevDecision: "allow" as const, jevMode: "enforce" as const };

describe("a call Jev sent no request for", () => {
  it("gets no pill", () => {
    expect(jevPillKind(NO_REQUEST)).toBeNull();
    expect(jevPillKind({ ...NO_REQUEST, jevMode: "shadow" })).toBeNull();
    const { container } = render(<JevPill item={NO_REQUEST} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says so in the detail panel instead of a verdict", () => {
    const { container } = render(<JevNote item={NO_REQUEST} />);
    expect(screen.getByText(JEV_NO_REQUEST_FACT)).toBeInTheDocument();
    expect(container.textContent).toBe(`Semantic review: ${JEV_NO_REQUEST_FACT}`);
  });
});

describe("a clear of a user's own policy whose name has spaces", () => {
  // The handler registers a loaded hook as `${prefix}/${hook.name}`, and a
  // user's hook name is whatever they typed.
  const CLEARED = {
    decision: "allow",
    evaluator: "jev" as const,
    jevDecision: "allow" as const,
    jevCleared: ["custom/No secrets in logs"],
    jevLatencyMs: 41,
    jevModel: "jev-1.13.0",
    jevMode: "enforce" as const,
  };

  it("still gets the cleared pill", () => {
    expect(jevPillKind(CLEARED)).toBe("cleared");
    render(<JevPill item={CLEARED} />);
    expect(screen.getByText("jev cleared")).toBeInTheDocument();
  });

  it("names the policy in the detail panel", () => {
    const { container } = render(<JevNote item={CLEARED} />);
    expect(container.textContent).toContain("cleared custom/No secrets in logs");
  });
});
