import { describe, it, expect, vi } from "vitest";
import { selectOne, multiSelect, type TTYIn, type TTYOut } from "../../src/hooks/tui";

const mkStdin = (): TTYIn => ({ isTTY: false }) as unknown as TTYIn;
const mkStdout = (): TTYOut =>
  ({ isTTY: false, write: vi.fn(() => true), columns: 80 }) as unknown as TTYOut;

describe("tui non-TTY fallbacks", () => {
  it("selectOne returns the initial choice value when not a TTY", async () => {
    const value = await selectOne({
      message: "t",
      choices: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
      initialIndex: 1,
      stdin: mkStdin(),
      stdout: mkStdout(),
    });
    expect(value).toBe("b");
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
