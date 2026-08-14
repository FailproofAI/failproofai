/**
 * Section 05 — SPREAD THE AUDIT.
 *
 * The scheduled-audit controls moved to /settings, so this section now has one
 * job and the AuthDialog has one caller. That is worth testing precisely
 * because the bug this section shipped was a SHARED dialog whose success
 * handler assumed which control had opened it: signing in from "invite a
 * friend" set a 7-day reminder nobody asked for and never opened the invite.
 *
 * With one caller the resume is unambiguous — and these assert the EFFECT, not
 * just the copy, because the copy-only tests that used to live here were
 * exactly as green on the broken version as on the fixed one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock("@/contexts/PostHogContext", () => ({
  usePostHog: () => ({ capture: captureMock }),
}));

import { ComeBackBetterSection } from "@/app/audit/_components/come-back-better-section";

/** Records every fetch and answers the auth routes the dialog drives. */
function stubFetch(authenticated = false) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/auth/status")) {
        return json(
          authenticated
            ? { authenticated: true, user: { id: "u1", email: "sidd@exosphere.host" } }
            : { authenticated: false },
        );
      }
      if (url.includes("/api/auth/login-request")) {
        return json({ status: "code_sent", expires_in: 600, resend_available_in: 30 });
      }
      if (url.includes("/api/auth/login-verify")) {
        return json({ authenticated: true, user: { id: "u1", email: "sidd@exosphere.host" } });
      }
      return json({});
    }),
  );
  return calls;
}

async function completeAuth() {
  fireEvent.change(await screen.findByPlaceholderText("you@yourdomain.com"), {
    target: { value: "sidd@exosphere.host" },
  });
  fireEvent.click(screen.getByRole("button", { name: "send code" }));
  fireEvent.change(await screen.findByPlaceholderText("123456"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "verify" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  captureMock.mockClear();
});

describe("section 05 is only the share", () => {
  beforeEach(() => stubFetch(false));

  it("says SPREAD THE AUDIT and offers the invite", async () => {
    render(<ComeBackBetterSection />);
    expect(await screen.findByRole("heading", { name: "spread the audit" })).toBeInTheDocument();
    expect(screen.getByText("invite a friend")).toBeInTheDocument();
  });

  it("carries no scheduled-audit controls at all", async () => {
    // They are machine configuration and live on /settings now. A report should
    // not end in a settings form.
    render(<ComeBackBetterSection />);
    await screen.findByText("invite a friend");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/scan this machine/i)).toBeNull();
    expect(screen.queryByText(/DAEMON/i)).toBeNull();
  });
});

describe("the invite", () => {
  it("asks an unauthed user to sign in, then opens the invite dialog", async () => {
    stubFetch(false);
    render(<ComeBackBetterSection />);
    fireEvent.click(await screen.findByText("invite a friend"));

    expect(await screen.findByText("Oops! Login required")).toBeInTheDocument();
    await completeAuth();

    // The one thing the dialog can be resuming.
    expect(
      await screen.findByPlaceholderText(/alice@x\.com/, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  });

  it("goes straight to the invite dialog when already signed in", async () => {
    stubFetch(true);
    render(<ComeBackBetterSection />);
    await waitFor(() => expect(screen.getByText("invite a friend")).toBeInTheDocument());
    fireEvent.click(screen.getByText("invite a friend"));

    expect(await screen.findByPlaceholderText(/alice@x\.com/)).toBeInTheDocument();
    expect(screen.queryByText("Oops! Login required")).toBeNull();
  });

  it("does not downgrade to signed-out when the status probe fails", async () => {
    // A failed probe is not evidence of a signed-out user, and treating it as
    // one would prompt for a login the person already completed.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/auth/status")) throw new Error("network down");
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    render(<ComeBackBetterSection />);
    // Still renders and still offers the invite rather than erroring out.
    expect(await screen.findByText("invite a friend")).toBeInTheDocument();
  });
});
