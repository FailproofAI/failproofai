import { describe, it, expect } from "vitest";
import { formatDate } from "@/lib/format-date";

describe("formatDate", () => {
  it("formats a standard date: Jan 15, 2024, 3:45 PM", () => {
    const date = new Date(2024, 0, 15, 15, 45);
    expect(formatDate(date)).toBe("Jan 15, 2024, 3:45 PM");
  });

  it("formats start of month: Mar 1, 2024, 9:30 AM", () => {
    const date = new Date(2024, 2, 1, 9, 30);
    expect(formatDate(date)).toBe("Mar 1, 2024, 9:30 AM");
  });

  it("formats midnight: Feb 10, 2024, 12:00 AM", () => {
    const date = new Date(2024, 1, 10, 0, 0);
    expect(formatDate(date)).toBe("Feb 10, 2024, 12:00 AM");
  });

  it("formats single-digit day: Jul 5, 2024, 2:15 PM", () => {
    const date = new Date(2024, 6, 5, 14, 15);
    expect(formatDate(date)).toBe("Jul 5, 2024, 2:15 PM");
  });

  it("formats end of year: Dec 31, 2024, 11:59 PM", () => {
    const date = new Date(2024, 11, 31, 23, 59);
    expect(formatDate(date)).toBe("Dec 31, 2024, 11:59 PM");
  });
});
