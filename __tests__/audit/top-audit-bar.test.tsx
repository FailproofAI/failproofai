// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  TopAuditBar,
  relativeTimeAgo,
  timeUntilExpiry,
} from "@/app/audit/_components/top-audit-bar";

describe("relativeTimeAgo", () => {
  const now = 1_750_000_000_000;
  it("returns 'just now' for sub-90s ages", () => {
    expect(relativeTimeAgo(now, now - 30_000)).toBe("just now");
    expect(relativeTimeAgo(now, now)).toBe("just now");
  });
  it("returns minutes for sub-hour ages", () => {
    expect(relativeTimeAgo(now, now - 15 * 60_000)).toBe("15m ago");
  });
  it("returns hours for sub-day ages", () => {
    expect(relativeTimeAgo(now, now - 5 * 60 * 60_000)).toBe("5h ago");
  });
  it("returns days for older ages", () => {
    expect(relativeTimeAgo(now, now - 3 * 24 * 60 * 60_000)).toBe("3d ago");
  });
  it("never goes negative when the timestamp is in the future", () => {
    expect(relativeTimeAgo(now, now + 1_000_000)).toBe("just now");
  });
});

describe("timeUntilExpiry", () => {
  const now = 1_750_000_000_000;
  it("counts down in hours when under a day remains", () => {
    const cachedAt = now - 6.5 * 24 * 60 * 60_000; // 6.5 days ago → ~12h left
    expect(timeUntilExpiry(now, cachedAt)).toBe("12h");
  });
  it("counts down in days when more than a day remains", () => {
    const cachedAt = now - 4 * 24 * 60 * 60_000; // 4 days ago → 3 days left
    expect(timeUntilExpiry(now, cachedAt)).toBe("3d");
  });
  it("clamps to 0 once past expiry", () => {
    const cachedAt = now - 8 * 24 * 60 * 60_000;
    expect(timeUntilExpiry(now, cachedAt)).toBe("<1m");
  });
});

describe("<TopAuditBar />", () => {
  it("renders cached mode with last-audit timestamp + button", () => {
    const onRerun = vi.fn();
    const cachedAt = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={cachedAt}
        isRunning={false}
        onRerun={onRerun}
      />,
    );
    expect(screen.getByText(/last audit/i)).toBeTruthy();
    expect(screen.getByText(/audited 3d ago/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "[ re-audit ]" })).toBeTruthy();
  });

  it("renders 'scanning' label while running and disables the button", () => {
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={new Date().toISOString()}
        isRunning
        onRerun={() => {}}
      />,
    );
    const btn = screen.getByRole("button");
    expect(btn.textContent).toBe("[ scanning… ]");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the amber 'expires soon' note within 24h of the TTL boundary", () => {
    // 6.5 days ago → ~12h to expiry, inside the 24h banner threshold
    const cachedAt = new Date(Date.now() - 6.5 * 24 * 60 * 60_000).toISOString();
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={cachedAt}
        isRunning={false}
        onRerun={() => {}}
      />,
    );
    expect(screen.getByText(/expires in/i)).toBeTruthy();
  });

  it("hides the expires-soon note when there's still room", () => {
    const cachedAt = new Date(Date.now() - 1 * 24 * 60 * 60_000).toISOString();
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={cachedAt}
        isRunning={false}
        onRerun={() => {}}
      />,
    );
    expect(screen.queryByText(/expires in/i)).toBeNull();
  });

  it("renders expired-mode banner copy", () => {
    render(
      <TopAuditBar
        mode="expired"
        cachedAt={new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString()}
        isRunning={false}
        onRerun={() => {}}
      />,
    );
    expect(screen.getByText(/audit expired/i)).toBeTruthy();
    expect(screen.getByText(/your audit aged past 7d/i)).toBeTruthy();
  });

  it("renders empty-mode banner copy and the same button", () => {
    render(
      <TopAuditBar
        mode="empty"
        cachedAt={null}
        isRunning={false}
        onRerun={() => {}}
      />,
    );
    expect(screen.getByText(/no audit yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "[ re-audit ]" })).toBeTruthy();
  });

  it("fires onRerun when the button is clicked", async () => {
    const user = userEvent.setup();
    const onRerun = vi.fn();
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={new Date().toISOString()}
        isRunning={false}
        onRerun={onRerun}
      />,
    );
    await user.click(screen.getByRole("button"));
    expect(onRerun).toHaveBeenCalledTimes(1);
  });
});
