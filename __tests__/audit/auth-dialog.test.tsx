/**
 * AuthDialog copy is driven by the `headline` / `subhead` props so the shared
 * dialog can show reminder-context vs invite-context text without any change to
 * the auth flow. These tests pin that content wiring:
 *   • defaults  → the reminder copy (unchanged)
 *   • overrides → the invite copy ("Oops! Login required" / "What's your email?")
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// AuthDialog calls usePostHog(); stub it so the test needs no provider. The
// capture fn must be STABLE across renders — AuthDialog lists `capture` in a
// useEffect dep array, so a fresh fn each render would re-fire the effect and
// loop forever (the real usePostHog returns a useCallback-stable fn).
const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock("@/contexts/PostHogContext", () => ({
  usePostHog: () => ({ capture: captureMock }),
}));

import { AuthDialog } from "@/app/audit/_components/auth-dialog";

const noop = () => {};

afterEach(() => cleanup());

describe("AuthDialog copy", () => {
  it("uses the reminder defaults when no copy props are passed", () => {
    render(<AuthDialog open onClose={noop} onAuthed={noop} />);
    expect(screen.getByText("where to route the reminder?")).toBeInTheDocument();
    expect(screen.getByText("we'll send a one-time code to confirm.")).toBeInTheDocument();
  });

  it("shows the invite copy when headline/subhead are provided", () => {
    render(
      <AuthDialog
        open
        headline="Oops! Login required"
        subhead="What's your email?"
        onClose={noop}
        onAuthed={noop}
      />,
    );
    expect(screen.getByText("Oops! Login required")).toBeInTheDocument();
    expect(screen.getByText("What's your email?")).toBeInTheDocument();
    // The reminder defaults must not leak into the invite variant.
    expect(screen.queryByText("where to route the reminder?")).toBeNull();
    expect(screen.queryByText("we'll send a one-time code to confirm.")).toBeNull();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<AuthDialog open={false} onClose={noop} onAuthed={noop} />);
    expect(container.firstChild).toBeNull();
  });
});
