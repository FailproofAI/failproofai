/**
 * The reminder and "invite a friend" CTAs share one AuthDialog.
 *
 * Two things must differ by which CTA opened it: the dialog's COPY, and — the
 * part these tests were missing — what happens once auth SUCCEEDS. The copy
 * cases below were the whole of this file, and they passed happily while signing
 * in from the invite button set a reminder nobody asked for and never opened the
 * invite dialog at all. A test that pins the label and not the effect is exactly
 * as green on the broken version as on the fixed one.
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

// ── What happens AFTER the dialog succeeds ───────────────────────────────────

/** Drive the shared AuthDialog through email → code → verified. */
async function completeAuth(email = "sidd@exosphere.host") {
  fireEvent.change(await screen.findByPlaceholderText("you@yourdomain.com"), {
    target: { value: email },
  });
  fireEvent.click(screen.getByRole("button", { name: "send code" }));
  fireEvent.change(await screen.findByPlaceholderText("123456"), {
    target: { value: "123456" },
  });
  fireEvent.click(screen.getByRole("button", { name: "verify" }));
}

/**
 * A fetch double that records every call and answers the three routes this
 * component touches. Returns the recorder so a test can assert what was — and
 * crucially what was NOT — requested.
 */
function stubAuthFetch() {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/auth/status")) {
        return json({ authenticated: false, reminder: null });
      }
      if (url.includes("/api/auth/login-request")) {
        return json({ status: "code_sent", expires_in: 600, resend_available_in: 30 });
      }
      if (url.includes("/api/auth/login-verify")) {
        return json({
          authenticated: true,
          user: { id: "u1", email: "sidd@exosphere.host" },
        });
      }
      if (url.includes("/api/auth/reminder")) {
        return json({
          authenticated: true,
          reminder: { next_audit_at: 1, user_email: "sidd@exosphere.host", set_at: 0 },
        });
      }
      return json({});
    }),
  );
  return calls;
}

describe("ComeBackBetterSection resumes the CTA that opened the dialog", () => {
  it("signing in from 'invite a friend' opens the invite dialog and sets NO reminder", async () => {
    // The regression. `handleAuthed` was shared by both CTAs and unconditionally
    // called persistReminder, so this exact path scheduled a 7-day reminder the
    // user never asked for AND dropped the invite they did.
    const calls = stubAuthFetch();
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);

    fireEvent.click(await screen.findByText("invite a friend"));
    await screen.findByText("Oops! Login required");
    await completeAuth();

    // The intent is resumed: the invite dialog is now open. Asserted on its
    // recipients field rather than a heading, so the test proves the user can
    // actually get on with inviting rather than that some element appeared.
    expect(
      await screen.findByPlaceholderText(/alice@x\.com/, {}, { timeout: 3000 }),
    ).toBeInTheDocument();

    // And nothing wrote a reminder.
    expect(
      calls.some((c) => c.url.includes("/api/auth/reminder") && c.method === "POST"),
    ).toBe(false);
  });

  it("signing in from a cadence button sets that reminder and opens no invite dialog", async () => {
    // The other direction, so the fix cannot be "never persist a reminder".
    const calls = stubAuthFetch();
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);

    const fourteenDay = await screen.findByRole("button", { name: "14d" });
    await waitFor(() => expect(fourteenDay).not.toBeDisabled());
    fireEvent.click(fourteenDay);
    await screen.findByText("where to route the reminder?");
    await completeAuth();

    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes("/api/auth/reminder") && c.method === "POST"),
      ).toBe(true),
    );
  });

  it("dismissing the dialog abandons the intent rather than deferring it", async () => {
    // Otherwise the NEXT sign-in, from any CTA, resumes something the user
    // already walked away from.
    const calls = stubAuthFetch();
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);

    const sevenDay = await screen.findByRole("button", { name: "7d" });
    await waitFor(() => expect(sevenDay).not.toBeDisabled());
    fireEvent.click(sevenDay);
    await screen.findByText("where to route the reminder?");
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));

    // Reopen from the OTHER CTA and complete auth.
    fireEvent.click(screen.getByText("invite a friend"));
    await screen.findByText("Oops! Login required");
    await completeAuth();

    expect(
      calls.some((c) => c.url.includes("/api/auth/reminder") && c.method === "POST"),
    ).toBe(false);
  });
});
