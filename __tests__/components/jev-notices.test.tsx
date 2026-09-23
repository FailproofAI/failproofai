import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { JevNote, JevPill, jevPillKind } from "@/app/components/jev-notices";

describe("jevPillKind", () => {
  it("marks nothing when Jev was not involved", () => {
    expect(jevPillKind({ decision: "deny" })).toBeNull();
  });

  it("marks nothing on an ordinary Jev allow — that is nearly every row", () => {
    expect(jevPillKind({ decision: "allow", evaluator: "jev", jevDecision: "allow", jevCleared: [], jevMode: "enforce" })).toBeNull();
  });

  it("marks a clear, a fallback and a shadow disagreement", () => {
    expect(jevPillKind({ decision: "allow", evaluator: "jev", jevCleared: ["block-env-files"], jevMode: "enforce" })).toBe(
      "cleared",
    );
    expect(jevPillKind({ decision: "deny", evaluator: "jev-fallback", jevFallbackReason: "timeout" })).toBe("fallback");
    expect(
      jevPillKind({ decision: "deny", evaluator: "jev", jevCleared: ["block-env-files"], jevMode: "shadow" }),
    ).toBe("would-clear");
    expect(jevPillKind({ decision: "allow", evaluator: "jev", jevDecision: "deny", jevMode: "shadow" })).toBe(
      "shadow-stricter",
    );
    expect(jevPillKind({ decision: "deny", evaluator: "jev", jevDecision: "deny", jevMode: "shadow" })).toBeNull();
  });
});

describe("JevPill", () => {
  it("renders nothing for a row Jev was not part of", () => {
    const { container } = render(<JevPill item={{ decision: "allow" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels a clear", () => {
    render(<JevPill item={{ decision: "allow", evaluator: "jev", jevCleared: ["protect-env-vars"], jevMode: "enforce" }} />);
    expect(screen.getByText("jev cleared")).toBeInTheDocument();
  });

  it("labels a fallback", () => {
    render(<JevPill item={{ decision: "deny", evaluator: "jev-fallback", jevFallbackReason: "http-429" }} />);
    expect(screen.getByText("jev fallback")).toBeInTheDocument();
  });
});

describe("JevNote", () => {
  it("renders nothing for a row Jev was not part of", () => {
    const { container } = render(<JevNote item={{ decision: "allow" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says what Jev decided and cleared", () => {
    render(
      <JevNote
        item={{
          decision: "allow",
          evaluator: "jev",
          jevDecision: "allow",
          jevCleared: ["block-read-outside-cwd"],
          jevLatencyMs: 38,
          jevModel: "jev-1.13.0",
          jevMode: "enforce",
        }}
      />,
    );
    expect(screen.getByText("Semantic review:", { exact: false })).toBeInTheDocument();
    expect(
      screen.getByText("Jev verdict: allow · cleared block-read-outside-cwd · 38 ms · jev-1.13.0"),
    ).toBeInTheDocument();
  });

  it("says why Jev fell back, as a code", () => {
    render(<JevNote item={{ decision: "deny", evaluator: "jev-fallback", jevFallbackReason: "error: boom while running a command" }} />);
    expect(screen.getByText("Jev unavailable: error · the regex policies decided alone")).toBeInTheDocument();
  });
});
