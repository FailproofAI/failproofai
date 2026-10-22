import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  BACK,
  promptBrowserLogin,
  type BrowserLoginOptions,
  type BrowserLoginPoll,
  type BrowserLoginStart,
  type TTYIn,
  type TTYOut,
} from "../../src/hooks/tui";

// Driven through a real PassThrough so Node's own keypress parser runs, like
// cloud-key-prompt.test.ts.
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
  const plain = () => written.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return { stdin, stdout, plain, type: (s: string) => stdin.write(s) };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await tick(5);
  }
};

const LINK = `https://app.befailproof.ai/cli/authorize?r=${"a".repeat(64)}`;
// A tiny interval keeps polling fast; the widget takes the server's number.
const started = (url = LINK): BrowserLoginStart => ({ ok: true, url, expiresIn: 600, interval: 0.01 });

function ask(
  t: ReturnType<typeof terminal>,
  polls: BrowserLoginPoll<string>[],
  extra: Partial<BrowserLoginOptions<string>> = {},
) {
  const start = vi.fn(async (): Promise<BrowserLoginStart> => started());
  const queue = [...polls];
  const poll = vi.fn(async (): Promise<BrowserLoginPoll<string>> => queue.shift() ?? { state: "pending" });
  const open = vi.fn(() => true);
  const pending = promptBrowserLogin<string>({
    message: "Connect to cloud",
    meta: "app.befailproof.ai",
    machineLabel: "sidd-laptop",
    start,
    poll,
    open,
    collapsed: (v) => ["CONNECT TO CLOUD", `logged in: ${v}`],
    stdin: t.stdin,
    stdout: t.stdout,
    ...extra,
  });
  return { pending, start: (extra.start as typeof start) ?? start, poll: (extra.poll as typeof poll) ?? poll, open: (extra.open as typeof open) ?? open };
}

describe("promptBrowserLogin", () => {
  it("prints the whole link above the live region, even when it is wider than the terminal", async () => {
    const t = terminal(40);
    const { pending, open } = ask(t, [{ state: "approved", value: "acme" }]);
    expect(await pending).toEqual({ value: "acme" });
    expect(open).toHaveBeenCalledWith(LINK);
    const out = t.plain();
    expect(out).toContain("CONNECT TO CLOUD  app.befailproof.ai");
    expect(out).toContain(LINK);
    expect(out).toContain("Opening your browser to connect sidd-laptop.");
    expect(out).toContain("logged in: acme");
  });

  it("says to open the link anywhere when it cannot open a browser here", async () => {
    const t = terminal();
    const { pending } = ask(t, [{ state: "approved", value: "x" }], { open: vi.fn(() => false) });
    await pending;
    expect(t.plain()).toContain("Open this link in any browser to connect sidd-laptop:");
  });

  it("keeps polling while pending, then resolves the approval", async () => {
    const t = terminal();
    const { pending, poll } = ask(t, [{ state: "pending" }, { state: "pending" }, { state: "approved", value: "acme" }]);
    expect(await pending).toEqual({ value: "acme" });
    expect(poll).toHaveBeenCalledTimes(3);
    expect(t.plain()).toContain("Waiting for you to authorize in the browser");
  });

  it("goes back on esc and cancels on ctrl-c, and stops polling either way", async () => {
    for (const [key, want] of [
      ["\u001b", BACK],
      ["\u0003", null],
    ] as const) {
      const t = terminal();
      const { pending, poll } = ask(t, []);
      await until(() => t.plain().includes("Waiting for you"));
      t.type(key);
      expect(await pending).toBe(want);
      const calls = poll.mock.calls.length;
      await tick(60);
      expect(poll.mock.calls.length).toBe(calls);
    }
  });

  it("offers a new link on enter once one expires", async () => {
    const t = terminal();
    const urls = [LINK, `${LINK}-second`];
    const start = vi.fn(async (): Promise<BrowserLoginStart> => started(urls.shift()));
    const { pending } = ask(t, [{ state: "expired" }, { state: "approved", value: "after-retry" }], { start });
    await until(() => t.plain().includes("That link expired."));
    expect(t.plain()).toContain("enter new link");
    t.type("\r");
    expect(await pending).toEqual({ value: "after-retry" });
    expect(start).toHaveBeenCalledTimes(2);
    expect(t.plain()).toContain(`${LINK}-second`);
  });

  it("calls a link expired by its own clock without waiting for the server to say so", async () => {
    const t = terminal();
    let clock = 1_000_000;
    const { pending } = ask(t, [], { now: () => clock });
    await until(() => t.plain().includes("Waiting for you"));
    clock += 11 * 60 * 1000;
    await until(() => t.plain().includes("That link expired."));
    t.type("\u001b");
    expect(await pending).toBe(BACK);
  });

  it("lets a refusal in the browser be retried", async () => {
    const t = terminal();
    const { pending, start } = ask(t, [{ state: "denied" }, { state: "approved", value: "second-go" }]);
    await until(() => t.plain().includes("Not authorized in the browser."));
    t.type("\r");
    expect(await pending).toEqual({ value: "second-go" });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not retry what cannot work, like an older server", async () => {
    const t = terminal();
    const start = vi.fn(
      async (): Promise<BrowserLoginStart> => ({ ok: false, retryable: false, line: "this server doesn't support it" }),
    );
    const { pending, poll } = ask(t, [], { start });
    await until(() => t.plain().includes("this server doesn't support it"));
    expect(t.plain()).toContain("CONNECT TO CLOUD");
    t.type("\r");
    await tick(30);
    expect(start).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
    t.type("\u001b");
    expect(await pending).toBe(BACK);
  });

  it("keeps going through a dropped connection, and says so", async () => {
    const t = terminal();
    const { pending } = ask(t, [
      { state: "unreachable", line: "offline" },
      { state: "pending" },
      { state: "approved", value: "back-online" },
    ]);
    expect(await pending).toEqual({ value: "back-online" });
    expect(t.plain()).toContain("Can't reach the server right now (offline) — still trying.");
  });

  it("answers null without a terminal instead of hanging on a pipe", async () => {
    const t = terminal();
    (t.stdin as unknown as { isTTY: boolean }).isTTY = false;
    const { pending, start } = ask(t, []);
    expect(await pending).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
});
