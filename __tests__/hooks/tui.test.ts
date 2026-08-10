import { describe, it, expect, vi } from "vitest";
import {
  selectOne,
  multiSelect,
  ellipsize,
  summarize,
  renderBrandLogo,
  promptText,
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

describe("brand logomark", () => {
  // The logo lines are the ones before the blank separator that precedes the
  // wordmark. Colours are off here (not a TTY), so each cell is a bare block
  // glyph and a run of them measures the mark's width in columns.
  const logoRows = (cols = 80): string[][] => {
    const lines = renderBrandLogo({
      isTTY: false,
      write: vi.fn(() => true),
      columns: cols,
    } as unknown as TTYOut);
    const art = lines.slice(0, lines.indexOf(""));
    return art.map((l) => l.match(/[█▀▄]+/g) ?? []);
  };

  // Regression: the right-hand bar once shipped a column narrower than the
  // left, which read as a drawing mistake at every terminal size. In the source
  // artwork both bars are the same width, so the narrowest left-hand run (the
  // upright, excluding the wider cross) must equal the right-hand run.
  it("draws both uprights the same width", () => {
    const twoRun = logoRows().filter((runs) => runs.length === 2);
    expect(twoRun.length).toBeGreaterThan(0);

    const rightWidths = new Set(twoRun.map((r) => r[1].length));
    expect(rightWidths.size).toBe(1); // the tall bar is a constant width

    const leftUpright = Math.min(...twoRun.map((r) => r[0].length));
    expect(leftUpright).toBe([...rightWidths][0]);
  });

  it("draws the cross wider than the upright it sits on", () => {
    const twoRun = logoRows().filter((runs) => runs.length === 2);
    const lefts = twoRun.map((r) => r[0].length);
    expect(Math.max(...lefts)).toBeGreaterThan(Math.min(...lefts));
  });

  it("collapses to a single line on a narrow terminal", () => {
    const lines = renderBrandLogo({
      isTTY: false,
      write: vi.fn(() => true),
      columns: 21,
    } as unknown as TTYOut);
    expect(lines).toHaveLength(1);
  });
});

describe("promptText redraw stays on one physical row", () => {
  // Regression: `\r\x1b[2K` erases only the row the cursor is on. A composed
  // line wider than the terminal WRAPS, so the erase misses the earlier rows
  // and every keystroke leaves one behind — pasting a 40-character API key
  // printed 40 stacked copies of the prompt.
  const drawnRows = (cols: number, message: string, hint: string, typed: number) => {
    const writes: string[] = [];
    const stdout = {
      isTTY: true,
      columns: cols,
      write: vi.fn((s: string) => { writes.push(s); return true; }),
    } as unknown as TTYOut;
    let onKey: ((s: string | undefined, k: unknown) => void) | undefined;
    const stdin = {
      isTTY: true,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      on: vi.fn((ev: string, fn: never) => { if (ev === "keypress") onKey = fn; }),
      removeListener: vi.fn(),
      // `readline.emitKeypressEvents` calls these on the stream it is given.
      // Without them the promise rejects, and because this test deliberately
      // does not await it (`void promptText(...)`), the rejection surfaces as an
      // UNHANDLED error — tests all green, job red, which is exactly how it
      // reached CI.
      listenerCount: vi.fn(() => 0),
      once: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      addListener: vi.fn(),
    } as unknown as TTYIn;

    void promptText({ message, hint, mask: true, stdin, stdout });
    for (let i = 0; i < typed; i++) onKey?.("x", { name: "x" });

    // Widest single write, measured without ANSI, is the widest row rendered.
    const widest = Math.max(
      ...writes.map((w) => w.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").length),
    );
    return widest;
  };

  it("never renders wider than the terminal, even with a long hint and a long value", () => {
    const widest = drawnRows(
      80,
      "API key for localhost:3000",
      "needs events:add · policies:pull enables managed policy too",
      40,
    );
    expect(widest).toBeLessThanOrEqual(80);
  });

  it("holds at a narrow width too", () => {
    expect(drawnRows(40, "API key for localhost:3000", "needs events:add", 40)).toBeLessThanOrEqual(40);
  });
});

// ── back navigation, and the two ways it was broken ──────────────────────────
//
// `BACK` is a symbol the shared key handler injects when ← is pressed on a
// prompt that opted into `allowBack`. It is NOT a value of the prompt's own
// result type, so every `summaryFor` callback received something it was never
// written to handle — and the two existing callers failed differently:
//
//   multiSelect  `values.includes(BACK)` → TypeError, thrown INSIDE `finish`
//                before `resolve()`, so the promise never settled and the
//                wizard stopped responding to input entirely.
//   selectOne    fell through to `String(value)` and rendered the literal
//                text `Symbol(failproofai.back)` as the user's answer.
describe("back navigation", () => {
  const harness = () => {
    const writes: string[] = [];
    const stdout = {
      isTTY: true,
      columns: 80,
      write: vi.fn((s: string) => { writes.push(s); return true; }),
    } as unknown as TTYOut;
    let onKey: ((s: string | undefined, k: unknown) => void) | undefined;
    const stdin = {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      on: vi.fn((ev: string, fn: never) => { if (ev === "keypress") onKey = fn; }),
      removeListener: vi.fn(),
      listenerCount: vi.fn(() => 0),
      once: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      addListener: vi.fn(),
    } as unknown as TTYIn;
    return { stdin, stdout, writes, press: (name: string) => onKey?.(undefined, { name }) };
  };

  const rendered = (writes: string[]) =>
    writes.join("").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

  // The hang. Without the fix this test does not fail — it never finishes.
  it("multiSelect resolves when ← is pressed instead of throwing", async () => {
    const h = harness();
    const p = multiSelect({
      message: "pick",
      choices: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
      allowBack: true,
      stdin: h.stdin,
      stdout: h.stdout,
    });
    h.press("left");
    const result = await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error("← never settled the promise")), 2000)),
    ]);
    expect(typeof result).toBe("symbol");
    expect(rendered(h.writes)).not.toContain("Symbol(");
    expect(rendered(h.writes)).toContain("back");
  });

  it("selectOne renders 'back' rather than the raw symbol", async () => {
    const h = harness();
    const p = selectOne({
      message: "pick",
      choices: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
      allowBack: true,
      stdin: h.stdin,
      stdout: h.stdout,
    });
    h.press("left");
    const result = await p;
    expect(typeof result).toBe("symbol");
    expect(rendered(h.writes)).not.toContain("Symbol(failproofai.back)");
    expect(rendered(h.writes)).toContain("back");
  });

  // A prompt that did not opt in must not appear to offer back navigation.
  it("← is inert when allowBack was not requested", async () => {
    const h = harness();
    const p = selectOne({
      message: "pick",
      choices: [{ label: "A", value: "a" }],
      stdin: h.stdin,
      stdout: h.stdout,
    });
    h.press("left");
    h.press("return");
    await expect(p).resolves.toBe("a");
  });
});

// The validation-error row was never measured. `draw()` emits the prompt and
// the error as ONE write containing a newline (`${line}${err}`), so a helper
// that measures each write whole sees `prompt + "\n  error"` as a single long
// string — it overstates every row and, more importantly, never checks the
// error row against the terminal width at all. Rows are split here.
describe("promptText validation errors stay within the terminal", () => {
  const rowsFor = (cols: number, message: string, error: string) => {
    const writes: string[] = [];
    const stdout = {
      isTTY: true,
      columns: cols,
      write: vi.fn((s: string) => { writes.push(s); return true; }),
    } as unknown as TTYOut;
    let onKey: ((s: string | undefined, k: unknown) => void) | undefined;
    const stdin = {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      on: vi.fn((ev: string, fn: never) => { if (ev === "keypress") onKey = fn; }),
      removeListener: vi.fn(),
      listenerCount: vi.fn(() => 0),
      once: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      addListener: vi.fn(),
    } as unknown as TTYIn;

    void promptText({ message, mask: true, validate: () => error, stdin, stdout });
    for (let i = 0; i < 40; i++) onKey?.("x", { name: "x" });
    onKey?.(undefined, { name: "return" }); // fails validation -> draws the error

    // Each WRITE is one redraw (it begins with `\r\x1b[2K`, which returns to
    // column 0 and erases), and a single redraw may itself contain a newline
    // when an error row is appended. So rows are per-write AND per-newline —
    // joining the writes first would concatenate 40 independent redraws into
    // one 2000-character "row" and measure nothing real.
    return writes.flatMap((w) =>
      w
        .split("\n")
        .map((row) => row.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").length),
    );
  };

  it("wraps neither the prompt nor a long error at 80 columns", () => {
    const rows = rowsFor(
      80,
      "API key for localhost:3000",
      "that key is not valid for this organisation — check you copied the whole value, including the prefix",
    );
    expect(Math.max(...rows)).toBeLessThanOrEqual(80);
  });

  it("holds at a narrow width, where the error has least room", () => {
    const rows = rowsFor(40, "API key for localhost:3000", "invalid key, please check and try again");
    expect(Math.max(...rows)).toBeLessThanOrEqual(40);
  });

  it("actually rendered an error row (the test would pass vacuously otherwise)", () => {
    const rows = rowsFor(80, "API key", "nope");
    expect(rows.length).toBeGreaterThan(1);
  });
});
