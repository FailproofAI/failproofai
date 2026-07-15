import { describe, it, expect, vi } from "vitest";
import {
  selectOne,
  multiSelect,
  ellipsize,
  summarize,
  type TTYIn,
  type TTYOut,
} from "../../src/hooks/tui";

const mkStdin = (): TTYIn => ({ isTTY: false }) as unknown as TTYIn;
const mkStdout = (): TTYOut =>
  ({ isTTY: false, write: vi.fn(() => true), columns: 80 }) as unknown as TTYOut;

describe("tui non-TTY fallbacks", () => {
  it("selectOne returns the first choice value when not a TTY", async () => {
    const value = await selectOne({
      message: "t",
      choices: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
      stdin: mkStdin(),
      stdout: mkStdout(),
    });
    expect(value).toBe("a");
  });

  it("selectOne returns null with no choices and no TTY", async () => {
    const value = await selectOne({
      message: "t",
      choices: [],
      stdin: mkStdin(),
      stdout: mkStdout(),
    });
    expect(value).toBeNull();
  });

  it("multiSelect returns the pre-checked values when not a TTY", async () => {
    const value = await multiSelect({
      message: "t",
      choices: [
        { label: "X", value: "x", checked: true },
        { label: "Y", value: "y" },
        { label: "Z", value: "z", checked: true },
      ],
      stdin: mkStdin(),
      stdout: mkStdout(),
    });
    expect(value).toEqual(["x", "z"]);
  });

  it("multiSelect returns [] when nothing pre-checked and no TTY", async () => {
    const value = await multiSelect({
      message: "t",
      choices: [
        { label: "X", value: "x" },
        { label: "Y", value: "y" },
      ],
      stdin: mkStdin(),
      stdout: mkStdout(),
    });
    expect(value).toEqual([]);
  });
});

describe("tui text helpers", () => {
  it("ellipsize leaves short text untouched", () => {
    expect(ellipsize("hello", 10)).toBe("hello");
    expect(ellipsize("hello", 5)).toBe("hello");
  });

  it("ellipsize ends on a single ellipsis instead of a mid-word cut", () => {
    const out = ellipsize("Redact secrets in tool output", 12);
    expect(out).toHaveLength(12);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("……");
  });

  it("ellipsize handles degenerate widths", () => {
    expect(ellipsize("anything", 0)).toBe("");
    expect(ellipsize("anything", 1)).toBe("…");
  });

  it("summarize joins a few labels verbatim", () => {
    expect(summarize([], "assistants")).toBe("none");
    expect(summarize(["Claude Code"], "assistants")).toBe("Claude Code");
    expect(summarize(["A", "B", "C"], "assistants")).toBe("A, B, C");
  });

  it("summarize collapses many labels to a count plus a head", () => {
    const out = summarize(["A", "B", "C", "D", "E"], "assistants");
    expect(out).toBe("5 assistants · A, B, C +2");
  });
});
