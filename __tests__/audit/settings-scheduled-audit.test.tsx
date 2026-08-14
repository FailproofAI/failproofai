/**
 * /settings — the scheduled-audit panel.
 *
 * These moved here with the controls. The properties worth pinning are the ones
 * that decide whether a person can tell what their machine is actually doing:
 * that "on" is distinguishable from "on but nothing will run", that a signed-out
 * machine says so instead of quietly not mailing, and that turning it on cannot
 * be done without somewhere to send the report.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { getViewMock, setAutoMock, setIntervalMock, triggerRunMock, toastMock, captureMock } =
  vi.hoisted(() => ({
    getViewMock: vi.fn(),
    setAutoMock: vi.fn(),
    setIntervalMock: vi.fn(),
    triggerRunMock: vi.fn(),
    toastMock: vi.fn(),
    // HOISTED, so `capture` keeps ONE identity across renders. AuthDialog lists
    // it in a useEffect dep array, so returning a fresh `vi.fn()` from the hook
    // re-fires that effect on every render and loops until the worker dies of a
    // heap exhaustion 4GB later — which is exactly how this file first failed.
    // The real `usePostHog` returns a useCallback-stable fn.
    captureMock: vi.fn(),
  }));

vi.mock("@/app/actions/get-scheduled-audit", () => ({ getScheduledAuditAction: getViewMock }));
vi.mock("@/app/actions/update-scheduled-audit", () => ({
  setAutoAuditAction: setAutoMock,
  setAuditIntervalAction: setIntervalMock,
}));
vi.mock("@/app/audit/_components/rerun-button", () => ({
  triggerRun: triggerRunMock,
  RerunError: class RerunError extends Error {
    kind = "failed";
  },
}));
vi.mock("@/app/components/toast", () => ({ toast: toastMock }));
vi.mock("@/contexts/PostHogContext", () => ({ usePostHog: () => ({ capture: captureMock }) }));

import SettingsClient from "@/app/settings/settings-client";

const DAY = 86_400_000;

function view(over: Record<string, unknown> = {}) {
  return {
    auto: false,
    intervalDays: 7,
    signedInAs: null,
    daemon: "running",
    schedule: null,
    lastResultAt: null,
    lastScan: null,
    daemonStartedAtMs: null,
    ...over,
  };
}

/**
 * Render the way the real page does: the SERVER seeds `initial`, and the client
 * refreshes from the same action on mount. Passing `initial` here is what makes
 * these tests exercise the shipped path — a client-only render would test a
 * first frame that no user ever sees.
 */
function renderSettings(initial: ReturnType<typeof view> | null = null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<SettingsClient initial={(initial ?? lastView) as any} />);
}

/** Whatever `getScheduledAuditAction` was last told to resolve with. */
let lastView: ReturnType<typeof view> | null = null;

beforeEach(() => {
  lastView = view();
  getViewMock.mockReset().mockResolvedValue(view());
  setAutoMock.mockReset().mockResolvedValue({ auto: true });
  setIntervalMock.mockReset().mockResolvedValue({ intervalDays: 7 });
  triggerRunMock.mockReset().mockResolvedValue(undefined);
  toastMock.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("daemon state", () => {
  it("shows the service as running", async () => {
    renderSettings();
    expect(await screen.findByText("running")).toBeInTheDocument();
  });

  it("shows how long it has been up, counted from the start time", async () => {
    // An ABSOLUTE start time is what the action returns, so the page keeps
    // counting without re-fetching. Three days back reads as "up 3d".
    lastView = view({ daemonStartedAtMs: Date.now() - 3 * DAY });
    getViewMock.mockResolvedValue(lastView);
    renderSettings();
    expect(await screen.findByText("up 3d")).toBeInTheDocument();
  });

  it("says nothing about uptime when the platform cannot answer", async () => {
    // macOS returns null rather than a guess. The cell still reports the state.
    lastView = view({ daemon: "running", daemonStartedAtMs: null });
    getViewMock.mockResolvedValue(lastView);
    renderSettings();
    expect(await screen.findByText("running")).toBeInTheDocument();
    expect(screen.queryByText(/^up /)).not.toBeInTheDocument();
  });

  it("says plainly when scanning is on but nothing will run", async () => {
    // "On but silent" is the state a panel that hid the service would produce,
    // and to the user it just looks like the feature does not work.
    lastView = view({ auto: true, daemon: "not-installed", signedInAs: { id: "u", email: "a@b.c" } });
    getViewMock.mockResolvedValue(lastView);
    renderSettings();
    expect(await screen.findByText(/isn't installed/)).toBeInTheDocument();
    expect(screen.getByText("not installed")).toBeInTheDocument();
  });

  it("explains an unsupported platform rather than blaming the service", async () => {
    lastView = view({ auto: true, daemon: "unsupported-platform", signedInAs: { id: "u", email: "a@b.c" } });
    getViewMock.mockResolvedValue(lastView);
    renderSettings();
    expect(await screen.findByText(/isn't available on this platform/)).toBeInTheDocument();
  });
});

describe("the switch", () => {
  it("asks for an email before turning on, because there must be somewhere to send", async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole("switch", { name: "turn on scheduled audits" }));
    expect(await screen.findByText("where should the report go?")).toBeInTheDocument();
    expect(setAutoMock).not.toHaveBeenCalled();
  });

  it("turns on directly when already signed in", async () => {
    lastView = view({ signedInAs: { id: "u", email: "sidd@exosphere.host" } });
    getViewMock.mockResolvedValue(lastView);
    renderSettings();
    fireEvent.click(await screen.findByRole("switch", { name: "turn on scheduled audits" }));
    await waitFor(() => expect(setAutoMock).toHaveBeenCalledWith(true));
    expect(screen.queryByText("where should the report go?")).toBeNull();
  });

  it("turns OFF without asking anything", async () => {
    // An expired session must never trap somebody into keeping a feature they
    // are trying to disable.
    lastView = view({ auto: true, signedInAs: null });
    getViewMock.mockResolvedValue(lastView);
    setAutoMock.mockResolvedValue({ auto: false });
    renderSettings();
    fireEvent.click(await screen.findByRole("switch", { name: "turn off scheduled audits" }));
    await waitFor(() => expect(setAutoMock).toHaveBeenCalledWith(false));
  });

  it("reverts the toggle when the write fails", async () => {
    lastView = view({ signedInAs: { id: "u", email: "a@b.c" } });
    getViewMock.mockResolvedValue(lastView);
    setAutoMock.mockRejectedValue(new Error("nope"));
    renderSettings();
    const sw = await screen.findByRole("switch", { name: "turn on scheduled audits" });
    fireEvent.click(sw);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("could not turn that on."));
    expect(await screen.findByRole("switch", { name: "turn on scheduled audits" })).toBeInTheDocument();
  });
});

describe("signed-out with the timer on", () => {
  it("names the state instead of quietly not mailing", async () => {
    // The whole point of separating "auth gates setup" from "auth gates
    // operation": the scans keep running, so the panel has to say why no
    // digest is arriving.
    lastView = view({ auto: true, signedInAs: null });
    getViewMock.mockResolvedValue(lastView);
    renderSettings();
    expect(await screen.findByText(/signed out — scans continue, digests are paused/)).toBeInTheDocument();
  });

  it("shows the destination when signed in", async () => {
    getViewMock.mockResolvedValue(
      view({ auto: true, signedInAs: { id: "u", email: "sidd@exosphere.host" } }),
    );
    renderSettings();
    expect(await screen.findByText("sidd@exosphere.host")).toBeInTheDocument();
  });
});

describe("the interval", () => {
  it("reflects what the config stored, not what was typed", async () => {
    // The 1..90 clamp lives in readIntervalDays and is deliberately not
    // duplicated in the UI — so a hand-typed 3650 must come back as 90.
    lastView = view({ signedInAs: { id: "u", email: "a@b.c" } });
    getViewMock.mockResolvedValue(lastView);
    setIntervalMock.mockResolvedValue({ intervalDays: 90 });
    renderSettings();
    const input = await screen.findByLabelText("days between scheduled scans");
    fireEvent.change(input, { target: { value: "3650" } });
    fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveValue(90));
  });
});

describe("the schedule tape", () => {
  it("draws only when there are two real ends to sit between", async () => {
    // A machine that has never run a scheduled scan is not inside an interval,
    // and a rail claiming otherwise would be decoration.
    getViewMock.mockResolvedValue(
      view({ auto: true, signedInAs: { id: "u", email: "a@b.c" }, schedule: null }),
    );
    const { container } = renderSettings();
    await screen.findByRole("switch");
    expect(container.querySelector(".tape")).toBeNull();
  });

  it("draws between the last scan and the next", async () => {
    const now = Date.now();
    getViewMock.mockResolvedValue(
      view({
        auto: true,
        signedInAs: { id: "u", email: "a@b.c" },
        schedule: {
          lastRunAtMs: now - DAY,
          nextDueAtMs: now + 6 * DAY,
          lastAttemptAtMs: now - DAY,
          lastExitCode: 0,
          schemaAhead: false,
        },
      }),
    );
    const { container } = renderSettings();
    await screen.findByRole("switch");
    await waitFor(() => expect(container.querySelector(".tape")).not.toBeNull());
    // Asserted as a POSITION, not a string. The label is `next · {value}` —
    // two text nodes in one span, so a plain text matcher never sees it whole —
    // and `now` is stamped a moment AFTER the fixture's timestamps, so a
    // 6-day gap legitimately renders "5d 23h". Pinning the exact wording would
    // be pinning a clock race; what the tape has to get right is where the
    // marker sits, which is one day into a seven-day span.
    expect(container.querySelector(".tape-next")?.textContent).toMatch(/next · \d+d/);
    const fill = container.querySelector<HTMLElement>(".tape-fill");
    const pct = Number.parseFloat(fill?.style.width ?? "0");
    expect(pct).toBeGreaterThan(10);
    expect(pct).toBeLessThan(20);
  });
});

describe("run a scan now", () => {
  it("runs regardless of whether scheduling is on", async () => {
    // Running one by hand is not the same decision as putting one on a timer,
    // and needs no account.
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: /run a scan now/ }));
    await waitFor(() => expect(triggerRunMock).toHaveBeenCalled());
  });
});

describe("the stat row", () => {
  it("reports the last scan and what it found, from one read", async () => {
    // Both cells come from the SAME action call, so they cannot disagree about
    // whether a result exists — the bug this shape prevents is a fresh
    // timestamp beside a blank count.
    lastView = view({
      lastResultAt: new Date(Date.now() - 2 * DAY).toISOString(),
      lastScan: {
        finishedAt: new Date(Date.now() - 2 * DAY).toISOString(),
        findings: 17,
        sessionsScanned: 230,
        eventsScanned: 22_074,
      },
    });
    getViewMock.mockResolvedValue(lastView);
    renderSettings();

    expect(await screen.findByText("17")).toBeInTheDocument();
    expect(screen.getByText("230 sessions")).toBeInTheDocument();
    expect(screen.getByText("this scan")).toBeInTheDocument();
  });

  it("tells apart a clean scan from a result it could not read", async () => {
    // 0 means "scanned, found nothing". "—" means "we do not know". Collapsing
    // them would report a clean machine on a file that failed to parse.
    lastView = view({
      lastScan: {
        finishedAt: new Date(Date.now() - DAY).toISOString(),
        findings: 0,
        sessionsScanned: 12,
        eventsScanned: 40,
      },
    });
    getViewMock.mockResolvedValue(lastView);
    const { unmount } = renderSettings();
    expect(await screen.findByText("0")).toBeInTheDocument();
    unmount();
    cleanup();

    lastView = view({
      lastScan: {
        finishedAt: new Date(Date.now() - DAY).toISOString(),
        findings: null,
        sessionsScanned: null,
        eventsScanned: null,
      },
    });
    getViewMock.mockResolvedValue(lastView);
    renderSettings();
    expect(await screen.findByText("unreadable")).toBeInTheDocument();
  });

  it("says a scan has never run rather than showing a zero", async () => {
    renderSettings();
    expect(await screen.findByText("none yet")).toBeInTheDocument();
    expect(screen.getByText("no scan yet")).toBeInTheDocument();
  });

  it("shows the next scan as off when scheduling is off", async () => {
    // A countdown on a machine that is not scheduled would be fiction.
    renderSettings();
    expect(await screen.findByText("off")).toBeInTheDocument();
    expect(screen.getByText("nothing scheduled")).toBeInTheDocument();
  });

  it("counts down to the daemon's own next-due time, not one it recomputes", async () => {
    // The daemon writes next_due_at_ms; deriving it from last-run + interval
    // drifts the moment somebody changes the interval mid-cycle.
    lastView = view({
      auto: true,
      signedInAs: { id: "u", email: "a@b.c" },
      schedule: {
        // A minute of slack: the page stamps its own `now` a few ms after this
        // fixture is built, and the readout floors — without it the assertion
        // races between "3d 4h" and "3d 3h".
        nextDueAtMs: Date.now() + 3 * DAY + 4 * 3_600_000 + 60_000,
        lastAttemptAtMs: null,
        lastRunAtMs: Date.now() - 4 * DAY,
        lastExitCode: 0,
        schemaAhead: false,
      },
    });
    getViewMock.mockResolvedValue(lastView);
    renderSettings();
    expect(await screen.findByText("3d 4h")).toBeInTheDocument();
  });

  it("says the next run is pending when the daemon has not scheduled one yet", async () => {
    lastView = view({ auto: true, signedInAs: { id: "u", email: "a@b.c" }, schedule: null });
    getViewMock.mockResolvedValue(lastView);
    renderSettings();
    expect(await screen.findByText("pending")).toBeInTheDocument();
  });
});

describe("how it works", () => {
  it("states what the scan reads, where it runs, and what leaves the machine", async () => {
    renderSettings();
    expect(await screen.findByText("reads")).toBeInTheDocument();
    expect(screen.getByText("runs")).toBeInTheDocument();
    expect(screen.getByText("sends")).toBeInTheDocument();
    expect(screen.getByText(/never leave/)).toBeInTheDocument();
    expect(screen.getByText(/redacted examples/)).toBeInTheDocument();
  });
});
