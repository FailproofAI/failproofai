import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PausedBanner, PausedNote, PausedPill, formatRemaining } from "@/app/components/pause-notices";

vi.mock("lucide-react", () => ({
  ShieldAlert: (props: Record<string, unknown>) => <span data-testid="shield-alert" {...props} />,
  TriangleAlert: (props: Record<string, unknown>) => <span data-testid="triangle-alert" {...props} />,
}));

const NOW = 1_700_000_000_000;
const pause = (
  over: Partial<{
    sessionId: string;
    expiresAt: number;
    pausedAt: number;
    firstPausedAt: number;
    setBy: string;
  }> = {},
) => ({
  sessionId: "s1",
  pausedAt: NOW,
  // Equal to `pausedAt` for a pause that was never renewed. The two differ
  // only across a renewal, which is what the 8h ceiling is measured from.
  firstPausedAt: NOW,
  expiresAt: NOW + 20 * 60_000,
  setBy: "cli",
  ...over,
});

describe("formatRemaining", () => {
  it("renders minutes and hours, and never a negative", () => {
    expect(formatRemaining(20 * 60_000)).toBe("20m");
    expect(formatRemaining(90 * 60_000)).toBe("1h30m");
    expect(formatRemaining(2 * 3_600_000)).toBe("2h");
    expect(formatRemaining(30_000)).toBe("under a minute");
    expect(formatRemaining(0)).toBe("expiring now");
    expect(formatRemaining(-5000)).toBe("expiring now");
  });
});

describe("PausedBanner", () => {
  it("renders nothing when nothing is paused — absence must mean enforcing", () => {
    const { container } = render(<PausedBanner pauses={[]} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when every pause has already expired", () => {
    // A short pause can lapse between polls; the banner must not outlive it and
    // claim the machine is unguarded when it is not.
    const { container } = render(<PausedBanner pauses={[pause({ expiresAt: NOW - 1 })]} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces an active pause with the time left", () => {
    render(<PausedBanner pauses={[pause()]} now={NOW} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Enforcement is paused for 1 session/);
    expect(screen.getByRole("status")).toHaveTextContent(/20m left/);
  });

  it("counts only live pauses and reports the soonest to expire", () => {
    render(
      <PausedBanner
        pauses={[
          pause({ sessionId: "a", expiresAt: NOW + 45 * 60_000 }),
          pause({ sessionId: "b", expiresAt: NOW + 5 * 60_000 }),
          pause({ sessionId: "expired", expiresAt: NOW - 1 }),
        ]}
        now={NOW}
      />,
    );
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/paused for 2 sessions/);
    expect(banner).toHaveTextContent(/5m left on the next to expire/);
  });

  it("says cloud policies keep enforcing, and how to end it early", () => {
    // Both facts are load-bearing: without the first the banner overstates how
    // exposed the machine is, and without the second the only visible exit is
    // waiting.
    render(<PausedBanner pauses={[pause()]} now={NOW} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/cloud-managed policies keep enforcing/i);
    expect(banner).toHaveTextContent(/failproofai config --resume/);
  });
});

describe("PausedNote", () => {
  it("renders nothing for an ordinary row", () => {
    const { container } = render(<PausedNote item={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("explains that the row was not enforced", () => {
    render(<PausedNote item={{ pausedBy: "cli", pauseExpiresAt: NOW }} />);
    expect(screen.getByText(/Not enforced — paused\./)).toBeInTheDocument();
  });

  it("tolerates a row with no expiry recorded", () => {
    render(<PausedNote item={{ pausedBy: "cli" }} />);
    expect(screen.getByText(/Not enforced — paused\./)).toBeInTheDocument();
  });
});

describe("PausedPill", () => {
  it("labels the row and explains itself on hover", () => {
    render(<PausedPill />);
    const pill = screen.getByText("paused");
    expect(pill).toHaveAttribute("title", expect.stringMatching(/local policies did not run/));
  });
});
