/**
 * The reminder and "invite a friend" CTAs share one AuthDialog. For an unauthed
 * user, the dialog content must differ by which CTA opened it — invite shows
 * "Oops! Login required", reminder keeps its default copy — while the auth flow
 * itself stays identical. These tests pin that behavior end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// Stable capture (see auth-dialog.test.tsx for why identity must not change).
const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock("@/contexts/PostHogContext", () => ({
  usePostHog: () => ({ capture: captureMock }),
}));

import { ComeBackBetterSection } from "@/app/audit/_components/come-back-better-section";

const noop = () => {};

beforeEach(() => {
  // The section probes /api/auth/status on mount; report an anonymous user.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: false, reminder: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  captureMock.mockClear();
});

describe("ComeBackBetterSection shared AuthDialog copy", () => {
  it("shows invite copy when an unauthed user clicks 'invite a friend'", async () => {
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    fireEvent.click(await screen.findByText("invite a friend"));
    expect(await screen.findByText("Oops! Login required")).toBeInTheDocument();
    expect(screen.getByText("What's your email?")).toBeInTheDocument();
    // Reminder copy must not appear in the invite variant.
    expect(screen.queryByText("where to route the reminder?")).toBeNull();
  });

  it("keeps the default reminder copy when an unauthed user picks a cadence", async () => {
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    // Cadence buttons unlock once the status probe resolves to anon.
    const sevenDay = await screen.findByRole("button", { name: "7d" });
    await waitFor(() => expect(sevenDay).not.toBeDisabled());
    fireEvent.click(sevenDay);
    expect(await screen.findByText("where to route the reminder?")).toBeInTheDocument();
    expect(screen.getByText("we'll send a one-time code to confirm.")).toBeInTheDocument();
    // Invite copy must not appear in the reminder variant.
    expect(screen.queryByText("Oops! Login required")).toBeNull();
  });
});
