// @vitest-environment jsdom
/**
 * The report the score was replaced with.
 *
 * What is pinned here is the part a reader acts on: one row per distinct
 * credential (not per sighting), the masked value and never the value, the
 * mechanism sentence, and the difference between a key with a console to revoke
 * at and one without — which is the difference between a minute's work and an
 * investigation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { LeakRow } from "@/app/actions/get-leaks";

const h = vi.hoisted(() => ({
  getLeaksAction: vi.fn(),
  dismissLeakAction: vi.fn(),
  setLeakNotifyAction: vi.fn(),
}));
vi.mock("@/app/actions/get-leaks", () => ({
  getLeaksAction: h.getLeaksAction,
  dismissLeakAction: h.dismissLeakAction,
  setLeakNotifyAction: h.setLeakNotifyAction,
}));

import { LeakSection } from "@/app/audit/_components/leak-section";

function row(over: Partial<LeakRow> = {}): LeakRow {
  return {
    id: "id-1",
    display: "ghp_••••••••4f2a",
    label: "GitHub personal access token",
    length: 40,
    attributed: true,
    name: "GITHUB_TOKEN",
    cli: "claude",
    project: "~/…/acme",
    lastSeen: new Date(Date.now() - 86_400_000).toISOString(),
    firstSeen: "2026-09-01T00:00:00.000Z",
    mechanism: "read from ~/…/.env",
    direction: "result",
    occurrences: 7,
    sessions: 3,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dismissLeakAction.mockResolvedValue(true);
  h.setLeakNotifyAction.mockResolvedValue(true);
});

describe("what a row shows", () => {
  it("shows the mask and never anything else", async () => {
    h.getLeaksAction.mockResolvedValue({ rows: [row()], notify: true });
    render(<LeakSection />);
    expect(await screen.findByText("ghp_••••••••4f2a")).toBeTruthy();
    // The identifier name is not a secret and is often the only actionable
    // field, so it is shown alongside.
    expect(screen.getByText("GITHUB_TOKEN")).toBeTruthy();
  });

  it("answers where, who, how and when in one sentence", async () => {
    h.getLeaksAction.mockResolvedValue({ rows: [row()], notify: true });
    render(<LeakSection />);
    await screen.findByText("ghp_••••••••4f2a");
    expect(screen.getByText("read from ~/…/.env")).toBeTruthy();
    expect(screen.getByText("~/…/acme")).toBeTruthy();
    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.getByText("yesterday")).toBeTruthy();
  });

  it("shows distinct dates even when their short labels are identical", async () => {
    h.getLeaksAction.mockResolvedValue({
      rows: [
        row({
          firstSeen: "2024-09-08T12:00:00.000Z",
          lastSeen: "2025-09-08T12:00:00.000Z",
        }),
      ],
      notify: true,
    });
    render(<LeakSection />);
    await screen.findByText("ghp_••••••••4f2a");
    expect(screen.getAllByText("Sep 8")).toHaveLength(2);
  });

  it("counts exposures without implying that many keys", async () => {
    // A key pasted into forty commands is one thing to rotate. Showing forty
    // rows would be true about sightings and wrong about the work.
    h.getLeaksAction.mockResolvedValue({ rows: [row()], notify: true });
    render(<LeakSection />);
    expect(await screen.findByText(/7 exposures · 3 sessions/)).toBeTruthy();
    expect(screen.getByText(/1 credential in your transcripts/)).toBeTruthy();
  });

  it("says the key can be blocked next time only when it can", async () => {
    // A result came back INTO the transcript from a file or a command — no
    // PreToolUse hook can intercept that, and saying otherwise would be advice
    // that cannot be followed.
    h.getLeaksAction.mockResolvedValue({
      rows: [row({ id: "a", direction: "input" }), row({ id: "b", direction: "result" })],
      notify: true,
    });
    render(<LeakSection />);
    expect(await screen.findByText(/blockable at PreToolUse/)).toBeTruthy();
    expect(screen.getByText(/already in the transcript/)).toBeTruthy();
  });
});

describe("what to do about it", () => {
  it("sends an attributed key to its own console", async () => {
    h.getLeaksAction.mockResolvedValue({ rows: [row()], notify: true });
    render(<LeakSection />);
    expect(await screen.findByText(/rotate it in the GitHub personal access console/)).toBeTruthy();
  });

  it("gives an unattributed key the only advice that exists for it", async () => {
    // The majority case per the pattern census: no vendor, no console, and the
    // identifier name is the only clue to who issued it.
    h.getLeaksAction.mockResolvedValue({
      rows: [row({ attributed: false, display: "[32-char password]", name: "COMPOSIO_API_KEY" })],
      notify: true,
    });
    render(<LeakSection />);
    expect(await screen.findByText(/find what reads COMPOSIO_API_KEY/)).toBeTruthy();
  });

  it("falls back to tracing when there is not even a name", async () => {
    h.getLeaksAction.mockResolvedValue({
      rows: [row({ attributed: false, name: null, display: "[19-char password]" })],
      notify: true,
    });
    render(<LeakSection />);
    expect(await screen.findByText(/trace it to its owner/)).toBeTruthy();
  });
});

describe("dismissing", () => {
  it("removes the row only once the dismissal actually persisted", async () => {
    // Optimism would leave the user guessing which of two states is real when
    // the row reappears on the next load.
    h.getLeaksAction.mockResolvedValue({ rows: [row()], notify: true });
    render(<LeakSection />);
    await screen.findByText("ghp_••••••••4f2a");

    await userEvent.click(screen.getByRole("button", { name: "not a secret" }));

    await waitFor(() => expect(screen.queryByText("ghp_••••••••4f2a")).toBeNull());
    expect(h.dismissLeakAction).toHaveBeenCalledWith("id-1");
  });

  it("keeps the row when the dismissal failed", async () => {
    h.dismissLeakAction.mockResolvedValue(false);
    h.getLeaksAction.mockResolvedValue({ rows: [row()], notify: true });
    render(<LeakSection />);
    await screen.findByText("ghp_••••••••4f2a");

    await userEvent.click(screen.getByRole("button", { name: "not a secret" }));

    await waitFor(() => expect(h.dismissLeakAction).toHaveBeenCalled());
    expect(screen.getByText("ghp_••••••••4f2a")).toBeTruthy();
  });
});

describe("the notification switch", () => {
  it("writes the same setting the CLI and the daemon read", async () => {
    h.getLeaksAction.mockResolvedValue({ rows: [row()], notify: true });
    render(<LeakSection />);
    await screen.findByText("ghp_••••••••4f2a");

    await userEvent.click(screen.getByRole("button", { name: /turn desktop notifications off/ }));

    expect(h.setLeakNotifyAction).toHaveBeenCalledWith(false);
  });

  it("puts the switch back when the write failed", async () => {
    // A toggle that shows "off" over a config that still says on is worse than
    // one that refuses to move: the user believes they silenced it.
    h.setLeakNotifyAction.mockResolvedValue(false);
    h.getLeaksAction.mockResolvedValue({ rows: [row()], notify: true });
    render(<LeakSection />);
    await screen.findByText("ghp_••••••••4f2a");

    await userEvent.click(screen.getByRole("button", { name: /turn desktop notifications off/ }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /turn desktop notifications off/ })).toBeTruthy(),
    );
  });
});

describe("nothing found", () => {
  it("says so plainly rather than rendering an empty list", async () => {
    h.getLeaksAction.mockResolvedValue({ rows: [], notify: true });
    render(<LeakSection />);
    expect(await screen.findByText("no credentials found")).toBeTruthy();
  });

  it("draws nothing at all until the record has been read", () => {
    // A "no credentials found" flash before the data arrives is a false
    // all-clear, which is the one wrong thing this section can say.
    h.getLeaksAction.mockReturnValue(new Promise(() => {}));
    const { container } = render(<LeakSection />);
    expect(container.textContent).toBe("");
  });
});
