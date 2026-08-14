/**
 * Section 05 — the scheduled-audit panel and the invite, which share one
 * AuthDialog.
 *
 * Two things must differ by which control opened it: the dialog's COPY, and —
 * the part this file was originally missing — what happens once auth SUCCEEDS.
 * The copy cases were the whole of it, and they passed happily while signing in
 * from the invite button set a reminder nobody asked for and never opened the
 * invite dialog. A test that pins the label and not the effect is exactly as
 * green on the broken version as on the fixed one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { captureMock, getViewMock, setAutoMock, setIntervalMock, setEmailMock } = vi.hoisted(() => ({
  captureMock: vi.fn(),
  getViewMock: vi.fn(),
  setAutoMock: vi.fn(),
  setIntervalMock: vi.fn(),
  setEmailMock: vi.fn(),
}));

vi.mock("@/contexts/PostHogContext", () => ({
  usePostHog: () => ({ capture: captureMock }),
}));
vi.mock("@/app/actions/get-scheduled-audit", () => ({
  getScheduledAuditAction: getViewMock,
}));
vi.mock("@/app/actions/update-scheduled-audit", () => ({
  setAutoAuditAction: setAutoMock,
  setAuditIntervalAction: setIntervalMock,
  setAuditEmailAction: setEmailMock,
}));
vi.mock("@/app/components/toast", () => ({ toast: vi.fn() }));

import { ComeBackBetterSection } from "@/app/audit/_components/come-back-better-section";

const noop = () => {};

/** The scheduled-audit view, signed out and idle unless overridden. */
function view(over: Record<string, unknown> = {}) {
  return {
    auto: false,
    intervalDays: 7,
    emailEnabled: false,
    signedInAs: null,
    daemon: "running",
    schedule: null,
    lastResultAt: null,
    ...over,
  };
}

/** Records every fetch and answers the auth routes the dialog drives. */
function stubFetch() {
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

/** Drive the shared AuthDialog through email → code → verified. */
async function completeAuth() {
  fireEvent.change(await screen.findByPlaceholderText("you@yourdomain.com"), {
    target: { value: "sidd@exosphere.host" },
  });
  fireEvent.click(screen.getByRole("button", { name: "send code" }));
  fireEvent.change(await screen.findByPlaceholderText("123456"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "verify" }));
}

beforeEach(() => {
  getViewMock.mockReset().mockResolvedValue(view());
  setAutoMock.mockReset().mockResolvedValue({ auto: true });
  setIntervalMock.mockReset().mockResolvedValue({ intervalDays: 7 });
  setEmailMock.mockReset().mockResolvedValue({ emailEnabled: true });
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  captureMock.mockClear();
});

describe("scheduled audit panel", () => {
  it("shows the daemon state, because 'on' without a daemon runs nothing", async () => {
    getViewMock.mockResolvedValue(view({ daemon: "running" }));
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    expect(await screen.findByText("DAEMON RUNNING")).toBeInTheDocument();
  });

  it("warns when scanning is on but the daemon is not running", async () => {
    // "on but silent" is the state a panel that hid this would produce, and it
    // presents to the user as the feature simply not working.
    getViewMock.mockResolvedValue(view({ auto: true, daemon: "not-installed" }));
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    expect(await screen.findByText(/isn't installed/)).toBeInTheDocument();
  });

  it("toggles scheduled scanning without asking anyone to sign in", async () => {
    // The offline promise: `auto` scans locally and needs no account.
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    const toggle = await screen.findByRole("switch", { name: "turn on scheduled scanning" });
    fireEvent.click(toggle);
    await waitFor(() => expect(setAutoMock).toHaveBeenCalledWith(true));
    // No dialog, because nothing here needs an identity.
    expect(screen.queryByPlaceholderText("you@yourdomain.com")).toBeNull();
  });

  it("warns when emailed reports are on but the machine is signed out", async () => {
    // Scans keep running and nothing can be sent — the exact state the reporter
    // surfaces as "signed-out", made visible where it can be fixed.
    getViewMock.mockResolvedValue(view({ emailEnabled: true, signedInAs: null }));
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    expect(await screen.findByText(/signed out — sign in to resume/)).toBeInTheDocument();
  });

  it("shows who a digest would go to when signed in", async () => {
    getViewMock.mockResolvedValue(
      view({ emailEnabled: true, signedInAs: { id: "u1", email: "sidd@exosphere.host" } }),
    );
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    expect(await screen.findByText("sidd@exosphere.host")).toBeInTheDocument();
  });
});

describe("the shared AuthDialog — copy", () => {
  it("shows invite copy when an unauthed user clicks 'invite a friend'", async () => {
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    fireEvent.click(await screen.findByText("invite a friend"));
    expect(await screen.findByText("Oops! Login required")).toBeInTheDocument();
    expect(screen.queryByText("where should the report go?")).toBeNull();
  });

  it("shows report copy when an unauthed user turns emailed reports on", async () => {
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    fireEvent.click(await screen.findByRole("switch", { name: "turn on emailed reports" }));
    expect(await screen.findByText("where should the report go?")).toBeInTheDocument();
    expect(screen.queryByText("Oops! Login required")).toBeNull();
  });
});

describe("the shared AuthDialog — effect", () => {
  it("signing in from 'invite a friend' opens the invite dialog and enables no email", async () => {
    // The regression this file exists for. `handleAuthed` was shared by both
    // controls and always did the other one's work.
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    fireEvent.click(await screen.findByText("invite a friend"));
    await screen.findByText("Oops! Login required");
    await completeAuth();

    expect(
      await screen.findByPlaceholderText(/alice@x\.com/, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(setEmailMock).not.toHaveBeenCalled();
  });

  it("signing in from the email switch enables reports and opens no invite dialog", async () => {
    // The other direction, so the fix cannot be "never enable anything".
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    fireEvent.click(await screen.findByRole("switch", { name: "turn on emailed reports" }));
    await screen.findByText("where should the report go?");
    await completeAuth();

    await waitFor(() => expect(setEmailMock).toHaveBeenCalledWith(true));
    expect(screen.queryByPlaceholderText(/alice@x\.com/)).toBeNull();
  });

  it("dismissing abandons the intent rather than deferring it", async () => {
    // Otherwise the NEXT sign-in, from any control, resumes something the user
    // already walked away from.
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    fireEvent.click(await screen.findByRole("switch", { name: "turn on emailed reports" }));
    await screen.findByText("where should the report go?");
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));

    fireEvent.click(screen.getByText("invite a friend"));
    await screen.findByText("Oops! Login required");
    await completeAuth();

    expect(
      await screen.findByPlaceholderText(/alice@x\.com/, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(setEmailMock).not.toHaveBeenCalled();
  });

  it("an already-signed-in user goes straight to the invite dialog", async () => {
    getViewMock.mockResolvedValue(
      view({ signedInAs: { id: "u1", email: "sidd@exosphere.host" } }),
    );
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    fireEvent.click(await screen.findByText("invite a friend"));
    expect(await screen.findByPlaceholderText(/alice@x\.com/)).toBeInTheDocument();
    expect(screen.queryByText("Oops! Login required")).toBeNull();
  });
});

describe("signing out", () => {
  it("turns emailed reports off with it", async () => {
    // Leaving the switch on would leave a machine that scans, finds something,
    // and has nothing to send it with — visible only by noticing no email ever
    // arrives.
    getViewMock.mockResolvedValue(
      view({ emailEnabled: true, signedInAs: { id: "u1", email: "sidd@exosphere.host" } }),
    );
    setEmailMock.mockResolvedValue({ emailEnabled: false });
    render(<ComeBackBetterSection isRunning={false} onRerun={noop} />);
    fireEvent.click(await screen.findByRole("button", { name: "sign out" }));
    await waitFor(() => expect(setEmailMock).toHaveBeenCalledWith(false));
  });
});
