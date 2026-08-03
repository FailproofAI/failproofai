import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EnforcementTimeline } from "@/app/components/enforcement-timeline";
import type { ActivityBucket } from "@/src/hooks/activity-timeline";

vi.mock("lucide-react", () => ({}));

const NOW = 1_700_000_000_000;
const bucket = (i: number, total: number, deny = 0, instruct = 0): ActivityBucket => ({
  t: NOW + i * 3_600_000, total, deny, instruct,
});

describe("EnforcementTimeline", () => {
  it("states both totals in the legend, so identity is never colour alone", () => {
    render(<EnforcementTimeline buckets={[bucket(0, 10, 2), bucket(1, 6, 1)]} />);
    expect(screen.getByText(/all events \(16\)/)).toBeInTheDocument();
    expect(screen.getByText(/denied \(3\)/)).toBeInTheDocument();
  });

  it("carries an accessible description that points at the table for detail", () => {
    render(<EnforcementTimeline buckets={[bucket(0, 4, 1)]} />);
    const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toMatch(/4 events, 1 denied/);
    expect(label).toMatch(/table below/);
  });

  it("renders with every bucket empty rather than collapsing", () => {
    // An all-zero window is a real answer — "nothing happened" — and must draw
    // an axis rather than vanish or divide by zero.
    const { container } = render(<EnforcementTimeline buckets={[bucket(0, 0), bucket(1, 0)]} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByText(/all events \(0\)/)).toBeInTheDocument();
  });

  it("draws a marker only where denies actually occurred", () => {
    const { container } = render(
      <EnforcementTimeline buckets={[bucket(0, 5, 0), bucket(1, 5, 2), bucket(2, 5, 1)]} />,
    );
    // A dot on every point would imply a deny in the quiet buckets too.
    expect(container.querySelectorAll("circle")).toHaveLength(2);
  });

  it("survives a single bucket without dividing by zero", () => {
    const { container } = render(<EnforcementTimeline buckets={[bucket(0, 3, 1)]} />);
    const paths = [...container.querySelectorAll("path")].map((p) => p.getAttribute("d") ?? "");
    expect(paths.every((d) => !d.includes("NaN"))).toBe(true);
  });

  it("scales the y axis to the peak bucket", () => {
    render(<EnforcementTimeline buckets={[bucket(0, 3), bucket(1, 17)]} />);
    expect(screen.getByText("17")).toBeInTheDocument();
  });
});

describe("geometry", () => {
  it("keeps every drawn coordinate inside the viewBox", () => {
    // The validator checks colour, not layout. This is the layout equivalent:
    // a point outside the box is clipped silently and reads as missing data.
    const VIEW_W = 720;
    const HEIGHT = 132;
    const buckets = Array.from({ length: 24 }, (_, i) => bucket(i, (i % 7) * 3, i % 5));
    const { container } = render(<EnforcementTimeline buckets={buckets} />);

    const coords: number[][] = [];
    for (const path of container.querySelectorAll("path")) {
      const d = path.getAttribute("d") ?? "";
      for (const m of d.matchAll(/([\d.]+),([\d.]+)/g)) coords.push([Number(m[1]), Number(m[2])]);
    }
    for (const circle of container.querySelectorAll("circle")) {
      coords.push([Number(circle.getAttribute("cx")), Number(circle.getAttribute("cy"))]);
    }

    expect(coords.length).toBeGreaterThan(20);
    for (const [x, y] of coords) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(VIEW_W);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(HEIGHT);
    }
  });
});
