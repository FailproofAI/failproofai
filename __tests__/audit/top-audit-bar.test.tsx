// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  TopAuditBar,
  relativeTimeAgo,
  timeUntilExpiry,
  freshnessRemainingLong,
  freshnessLitCells,
  GAUGE_SEGMENTS,
} from "@/app/audit/_components/top-audit-bar";
import type { RerunStatus } from "@/app/audit/_components/audit-progress-strip";

const IDLE: RerunStatus = { kind: "idle" };
const noop = () => {};

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

describe("freshnessRemainingLong", () => {
  const now = 1_750_000_000_000;
  it("renders days + zero-padded hours when over a day remains", () => {
    const cachedAt = now - 3 * 24 * 60 * 60_000; // 3 days ago → 4 days left
    expect(freshnessRemainingLong(now, cachedAt)).toBe("4d 00h");
  });
  it("renders hours + zero-padded minutes when under a day remains", () => {
    const cachedAt = now - (7 * 24 - 5) * 60 * 60_000 - 40 * 60_000; // ~4h 20m left
    expect(freshnessRemainingLong(now, cachedAt)).toBe("4h 20m");
  });
  it("clamps to 0h 00m once past expiry", () => {
    const cachedAt = now - 9 * 24 * 60 * 60_000;
    expect(freshnessRemainingLong(now, cachedAt)).toBe("0h 00m");
  });
});

describe("freshnessLitCells", () => {
  const TTL = 7 * 24 * 60 * 60_000;
  it("is full when freshly cached", () => {
    expect(freshnessLitCells(TTL)).toBe(GAUGE_SEGMENTS);
  });
  it("is zero when null or non-positive (expired/empty)", () => {
    expect(freshnessLitCells(null)).toBe(0);
    expect(freshnessLitCells(0)).toBe(0);
    expect(freshnessLitCells(-5)).toBe(0);
  });
  it("keeps at least one cell lit while any time remains", () => {
    expect(freshnessLitCells(60_000)).toBe(1); // 1 minute left → still 1 lit
  });
  it("scales proportionally to remaining TTL", () => {
    expect(freshnessLitCells(TTL / 2)).toBe(GAUGE_SEGMENTS / 2);
  });
});

describe("<TopAuditBar />", () => {
  it("renders cached mode with last-audit timestamp, gauge meter + re-audit button", () => {
    const onRerun = vi.fn();
    const cachedAt = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={cachedAt}
        isRunning={false}
        rerunStatus={IDLE}
        onRerun={onRerun}
        onDismiss={noop}
      />,
    );
    expect(screen.getByText(/last audit/i)).toBeTruthy();
    expect(screen.getByText(/3d ago/i)).toBeTruthy();
    // the decay gauge exposes a meter role with a freshness percentage
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBeTruthy();
    expect(screen.getByRole("button", { name: /re-audit/i })).toBeTruthy();
  });

  it("surfaces the cache-clearing behaviour on the re-audit button", () => {
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString()}
        isRunning={false}
        rerunStatus={IDLE}
        onRerun={noop}
        onDismiss={noop}
      />,
    );
    expect(screen.getByText(/clears cache · fresh scan/i)).toBeTruthy();
  });

  it("renders 'scanning' label while running and disables the button", () => {
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={new Date().toISOString()}
        isRunning
        rerunStatus={IDLE}
        onRerun={noop}
        onDismiss={noop}
      />,
    );
    const btn = screen.getByRole("button");
    expect(btn.textContent).toMatch(/scanning…/i);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an elapsed clock + the inline scanning copy when a run is in flight", () => {
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={new Date().toISOString()}
        isRunning
        rerunStatus={{ kind: "running", startedAt: Date.now() - 7_000 }}
        onRerun={noop}
        onDismiss={noop}
      />,
    );
    expect(screen.getByText(/re-auditing your sessions/i)).toBeTruthy();
    expect(screen.getByText(/00:0\d/)).toBeTruthy();
  });

  it("shows the amber 'expires in' copy within 24h of the TTL boundary", () => {
    // 6.5 days ago → ~12h to expiry, inside the 24h banner threshold
    const cachedAt = new Date(Date.now() - 6.5 * 24 * 60 * 60_000).toISOString();
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={cachedAt}
        isRunning={false}
        rerunStatus={IDLE}
        onRerun={noop}
        onDismiss={noop}
      />,
    );
    expect(screen.getByText(/expires in/i)).toBeTruthy();
  });

  it("hides the 'expires in' copy when there's still room", () => {
    const cachedAt = new Date(Date.now() - 1 * 24 * 60 * 60_000).toISOString();
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={cachedAt}
        isRunning={false}
        rerunStatus={IDLE}
        onRerun={noop}
        onDismiss={noop}
      />,
    );
    expect(screen.queryByText(/expires in/i)).toBeNull();
    expect(screen.getByText(/valid/i)).toBeTruthy();
  });

  it("renders expired-mode banner copy", () => {
    render(
      <TopAuditBar
        mode="expired"
        cachedAt={new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString()}
        isRunning={false}
        rerunStatus={IDLE}
        onRerun={noop}
        onDismiss={noop}
      />,
    );
    expect(screen.getByText(/audit expired/i)).toBeTruthy();
    expect(screen.getByText(/aged past 7d/i)).toBeTruthy();
  });

  it("renders empty-mode banner copy and a 'run audit' button", () => {
    render(
      <TopAuditBar
        mode="empty"
        cachedAt={null}
        isRunning={false}
        rerunStatus={IDLE}
        onRerun={noop}
        onDismiss={noop}
      />,
    );
    expect(screen.getByText(/no audit yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /run audit/i })).toBeTruthy();
  });

  it("folds the failed state inline with error copy + a dismiss button", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString()}
        isRunning={false}
        rerunStatus={{ kind: "failed", reason: "timeout", failedAt: Date.now() }}
        onRerun={noop}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByText(/scan failed/i)).toBeTruthy();
    expect(screen.getByText(/took too long/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("fires onRerun when the button is clicked", async () => {
    const user = userEvent.setup();
    const onRerun = vi.fn();
    render(
      <TopAuditBar
        mode="cached"
        cachedAt={new Date().toISOString()}
        isRunning={false}
        rerunStatus={IDLE}
        onRerun={onRerun}
        onDismiss={noop}
      />,
    );
    await user.click(screen.getByRole("button", { name: /re-audit/i }));
    expect(onRerun).toHaveBeenCalledTimes(1);
  });
});
