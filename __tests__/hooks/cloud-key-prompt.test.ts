import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { collapseAfter, promptCloudKey, OPEN_SOURCE, type KeyVerdict, type TTYIn, type TTYOut } from "../../src/hooks/tui";

// Driven through a real PassThrough so Node's own keypress parser runs: the
// paste guard depends on the `paste-start` / `paste-end` keys it emits.
function terminal(columns = 80) {
  const written: string[] = [];
  const stdout = {
    isTTY: true,
    columns,
    write: (chunk: string) => {
      written.push(String(chunk));
      return true;
    },
  } as unknown as TTYOut;
  const stdin = new PassThrough() as unknown as TTYIn & PassThrough;
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
  const raw = () => written.join("");
  const plain = () => raw().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return { stdin, stdout, written, raw, plain, type: (s: string) => stdin.write(s) };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const KEY = "fpk_live_0123456789abcdef";

function ask(t: ReturnType<typeof terminal>, extra: Partial<Parameters<typeof promptCloudKey>[0]> = {}) {
  const check = vi.fn(async (): Promise<KeyVerdict> => ({ ok: true }));
  const pending = promptCloudKey({
    message: "Connect to cloud",
    meta: "app.befailproof.ai",
    tabHint: "use open source instead",
    emptyError: "Paste a key, or press tab to use open source.",
    check,
    collapsed: (answer) => ["CONNECT TO CLOUD", answer === OPEN_SOURCE ? "open source" : `answered ${answer.kind}`],
    stdin: t.stdin,
    stdout: t.stdout,
    ...extra,
  });
  return { pending, check: (extra.check as typeof check | undefined) ?? check };
}

afterEach(() => {
  delete process.env.NO_COLOR;
});

describe("promptCloudKey", () => {
  it("draws the heading with the host, the field and the hints, as designed", async () => {
    const t = terminal();
    const { pending } = ask(t);
    await tick();
    expect(t.plain()).toContain("CONNECT TO CLOUD  app.befailproof.ai");
    expect(t.plain()).toContain("  API key   › ");
    expect(t.plain()).toContain("enter connect  ·  tab use open source instead  ·  esc cancel");
    t.type("\u001b");
    expect(await pending).toBeNull();
  });

  it("checks a typed key and resolves it, never printing the key itself", async () => {
    const t = terminal();
    const { pending, check } = ask(t);
    t.type(KEY);
    t.type("\r");
    const answer = await pending;
    expect(check).toHaveBeenCalledWith(KEY);
    expect(answer).toEqual({ kind: "typed", key: KEY, note: undefined });
    expect(t.raw()).not.toContain(KEY);
    expect(t.plain()).toContain("•".repeat(KEY.length));
  });

  it("carries a partial key's note through to the answer", async () => {
    const t = terminal();
    const check = vi.fn(async (): Promise<KeyVerdict> => ({ ok: true, line: "This key can send events but not pull policies." }));
    const { pending } = ask(t, { check });
    t.type(KEY + "\r");
    expect(await pending).toEqual({ kind: "typed", key: KEY, note: "This key can send events but not pull policies." });
  });

  it("resolves open source on tab", async () => {
    const t = terminal();
    const { pending, check } = ask(t);
    t.type("\t");
    expect(await pending).toBe(OPEN_SOURCE);
    expect(check).not.toHaveBeenCalled();
  });

  it("treats a tab or newline inside a paste as part of the paste", async () => {
    const t = terminal();
    const { pending, check } = ask(t);
    // A key copied with a stray tab and a trailing newline: neither may switch
    // to open source or submit halfway through the paste.
    t.type(`\u001b[200~fpk_live_\t0123456789abcdef\r\u001b[201~`);
    await tick(20);
    expect(check).not.toHaveBeenCalled();
    t.type("\r");
    expect(await pending).toEqual({ kind: "typed", key: KEY, note: undefined });
  });

  it("refuses a short key inline without asking the server", async () => {
    const t = terminal();
    const { pending, check } = ask(t);
    t.type("abc\r");
    await tick(20);
    expect(check).not.toHaveBeenCalled();
    expect(t.plain()).toContain("✕ That looks too short to be a key.");
    t.type("\u001b");
    await pending;
  });

  it("asks for a key or tab on an empty enter with no saved key", async () => {
    const t = terminal();
    const { pending, check } = ask(t);
    t.type("\r");
    await tick(20);
    expect(check).not.toHaveBeenCalled();
    expect(t.plain()).toContain("✕ Paste a key, or press tab to use open source.");
    t.type("\u001b");
    await pending;
  });

  it("keeps a refused key in the field, says why, and retries on enter", async () => {
    const t = terminal();
    const check = vi
      .fn<(key: string) => Promise<KeyVerdict>>()
      .mockResolvedValueOnce({ ok: false, line: "That key was refused: the server rejected that key (401)." })
      .mockResolvedValueOnce({ ok: true });
    const { pending } = ask(t, { check });
    t.type(KEY + "\r");
    await tick(20);
    const screen = t.plain();
    expect(screen).toContain("✕ That key was refused: the server rejected that key (401).");
    expect(screen).toContain("enter try again  ·  tab use open source instead  ·  esc cancel");
    t.type("\r");
    expect(await pending).toEqual({ kind: "typed", key: KEY, note: undefined });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("ignores keys while a typed key is being checked, but esc still leaves", async () => {
    const t = terminal();
    let release: (v: KeyVerdict) => void = () => {};
    const check = vi.fn(() => new Promise<KeyVerdict>((r) => (release = r)));
    const { pending } = ask(t, { check });
    t.type(KEY + "\r");
    await tick(20);
    t.type("\t"); // would be open source if it were not ignored
    await tick(20);
    t.type("\u001b");
    expect(await pending).toBeNull();
    release({ ok: true });
  });

  it("spins only once a check has taken longer than 150 ms", async () => {
    const t = terminal();
    let release: (v: KeyVerdict) => void = () => {};
    const check = vi.fn(() => new Promise<KeyVerdict>((r) => (release = r)));
    const { pending } = ask(t, { check });
    t.type(KEY + "\r");
    await tick(60);
    expect(t.plain()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Checking the key…/);
    await tick(300);
    expect(t.plain()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Checking the key…/);
    release({ ok: true });
    await pending;
  });

  describe("with a saved key", () => {
    it("shows a working saved key and keeps it on an empty enter", async () => {
      const t = terminal();
      const saved = { masked: "****3f2a", check: vi.fn(async (): Promise<KeyVerdict> => ({ ok: true })) };
      const { pending, check } = ask(t, { saved });
      await tick(20);
      expect(t.plain()).toContain("✓ Your saved key works: ****3f2a");
      expect(t.plain()).toContain("enter use saved key  ·  type to replace it  ·  tab use open source instead");
      t.type("\r");
      expect(await pending).toEqual({ kind: "saved", verified: true });
      expect(check).not.toHaveBeenCalled();
    });

    it("waits for a check still in flight before keeping the saved key", async () => {
      const t = terminal();
      let release: (v: KeyVerdict) => void = () => {};
      const saved = { masked: "****3f2a", check: () => new Promise<KeyVerdict>((r) => (release = r)) };
      const { pending } = ask(t, { saved });
      await tick(10);
      expect(t.plain()).toContain("Checking your saved key ****3f2a…");
      t.type("\r");
      await tick(20);
      let settled = false;
      void pending.then(() => (settled = true));
      await tick(20);
      expect(settled).toBe(false);
      release({ ok: true });
      expect(await pending).toEqual({ kind: "saved", verified: true });
    });

    it("treats a refused saved key as no saved key at all", async () => {
      const t = terminal();
      const saved = {
        masked: "****3f2a",
        check: async (): Promise<KeyVerdict> => ({ ok: false, line: "Your saved key no longer works: the server rejected that key (401)" }),
      };
      const { pending } = ask(t, { saved });
      await tick(20);
      expect(t.plain()).toContain("▲ Your saved key no longer works: the server rejected that key (401)");
      t.type("\r");
      await tick(20);
      expect(t.plain()).toContain("✕ Paste a key, or press tab to use open source.");
      t.type("\u001b");
      expect(await pending).toBeNull();
    });

    it("still offers a saved key that could not be checked, unverified", async () => {
      const t = terminal();
      const saved = {
        masked: "****3f2a",
        check: async (): Promise<KeyVerdict> => ({ ok: false, usable: true, line: "Couldn't check your saved key: could not reach the server" }),
      };
      const { pending } = ask(t, { saved });
      await tick(20);
      expect(t.plain()).toContain("▲ Couldn't check your saved key: could not reach the server");
      t.type("\r");
      expect(await pending).toEqual({ kind: "saved", verified: false });
    });

    it("replaces the saved key when a new one is typed", async () => {
      const t = terminal();
      const saved = { masked: "****3f2a", check: async (): Promise<KeyVerdict> => ({ ok: true }) };
      const { pending, check } = ask(t, { saved });
      await tick(20);
      t.type(KEY + "\r");
      expect(await pending).toEqual({ kind: "typed", key: KEY, note: undefined });
      expect(check).toHaveBeenCalledWith(KEY);
    });
  });

  it("puts the terminal back: paste mode off and the cursor shown", async () => {
    const t = terminal();
    const { pending } = ask(t);
    await tick();
    expect(t.raw()).toContain("\u001b[?2004h");
    t.type("\u001b");
    await pending;
    const tail = t.written.slice(-3).join("");
    expect(tail).toContain("\u001b[?2004l");
    expect(tail).toContain("\u001b[?25h");
  });

  it("collapses to the caller's lines", async () => {
    const t = terminal();
    const { pending } = ask(t);
    t.type("\t");
    await pending;
    const lastFrame = t.written.filter((w) => w.includes("\u001b[?2026h")).pop() ?? "";
    expect(lastFrame).toContain("CONNECT TO CLOUD");
    expect(lastFrame).toContain("open source");
    expect(lastFrame).not.toContain("API key");
  });

  it("answers null without a terminal instead of waiting on a pipe", async () => {
    const t = terminal();
    (t.stdin as unknown as { isTTY: boolean }).isTTY = false;
    expect(await promptCloudKey({ message: "x", tabHint: "skip", emptyError: "e", check: async () => ({ ok: true }), stdin: t.stdin, stdout: t.stdout })).toBeNull();
    expect(t.written).toEqual([]);
  });

  it.each([true, false])("prints colour only when colour is on (color=%s)", async (color) => {
    if (!color) process.env.NO_COLOR = "1";
    else process.env.FORCE_COLOR = "3";
    try {
      const t = terminal();
      const { pending } = ask(t);
      t.type("ab\r");
      await tick(20);
      t.type("\u001b");
      await pending;
      const sgr = /\x1b\[[0-9;]*m/.test(t.raw());
      expect(sgr).toBe(color);
    } finally {
      delete process.env.FORCE_COLOR;
    }
  });
});

describe("collapseAfter", () => {
  it("reserves rows before the child writes, then erases back to where it started", () => {
    const t = terminal();
    const result = collapseAfter(t.stdout, 10, () => {
      t.stdout.write("[sudo] password for someone: \n");
      return 42;
    });
    expect(result).toBe(42);
    const all = t.raw();
    // Reserved and saved before the child's output...
    expect(all.indexOf("\n".repeat(10) + "\u001b[10A\u001b7")).toBe(0);
    // ...restored and cleared after it, even when the child throws.
    expect(all.endsWith("\u001b8\u001b[J")).toBe(true);
    expect(() => collapseAfter(t.stdout, 10, () => { throw new Error("boom"); })).toThrow("boom");
    expect(t.raw().endsWith("\u001b8\u001b[J")).toBe(true);
  });

  it("just runs without a terminal", () => {
    const t = terminal();
    (t.stdout as unknown as { isTTY: boolean }).isTTY = false;
    expect(collapseAfter(t.stdout, 10, () => "ran")).toBe("ran");
    expect(t.written).toEqual([]);
  });
});
