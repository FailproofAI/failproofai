// @vitest-environment node
/**
 * The last frame a prompt draws stays in scrollback, so it is never cut.
 *
 * Every live frame is cut to the terminal width so the next cursor-up lands
 * where it should, and the collapse used the same default. On an 80-column
 * terminal an unticked agent's summary (≈88 columns) was left behind as
 * `…no longer hooked or coll`, and a long org or host in the connect summary
 * lost the end of the hostname.
 *
 * Also: Enter pressed while the saved key is still being checked, when that
 * check comes back refused, says what to do — as an empty Enter with no saved
 * key does — instead of redrawing as if nothing was pressed.
 */
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { multiSelect, promptCloudKey, OPEN_SOURCE, type KeyVerdict, type TTYIn, type TTYOut } from "../../src/hooks/tui";

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
  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const lastFrame = () => strip(written.filter((w) => w.includes("\u001b[?2026h")).pop() ?? "");
  const plain = () => strip(written.join(""));
  return { stdin, stdout, lastFrame, plain, type: (s: string) => stdin.write(s) };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const REMOVED =
  "  Removed Claude Code, OpenAI Codex and GitHub Copilot: no longer hooked or collected. Sessions already collected are kept.";
const ACCEPTED = "✓ Key accepted for acme-corp-production-org on cloud.befailproof.example.internal.company.com";

describe("a prompt's last frame is never cut", () => {
  it("multiSelect leaves a summary wider than the terminal whole", async () => {
    const t = terminal(80);
    const pending = multiSelect({
      message: "Which agents should failproofai trace?",
      choices: [
        { label: "Claude Code", value: "claude", checked: true },
        { label: "OpenAI Codex", value: "codex" },
      ],
      collapsed: () => ["AGENTS", REMOVED, ""],
      stdin: t.stdin,
      stdout: t.stdout,
    });
    await tick();
    t.type("\r");
    await pending;
    expect(REMOVED.length).toBeGreaterThan(80);
    expect(t.lastFrame()).toContain(REMOVED);
  });

  it("promptCloudKey leaves the org and host whole", async () => {
    const t = terminal(80);
    const pending = promptCloudKey({
      message: "Connect to cloud",
      meta: "cloud.befailproof.example.internal.company.com",
      tabHint: "use open source instead",
      emptyError: "Paste a key, or press tab to use open source.",
      check: vi.fn(async (): Promise<KeyVerdict> => ({ ok: true })),
      collapsed: (answer) => ["CONNECT TO CLOUD", answer === OPEN_SOURCE ? "open source" : ACCEPTED],
      stdin: t.stdin,
      stdout: t.stdout,
    });
    t.type("fpk_live_0123456789abcdef\r");
    await pending;
    expect(t.lastFrame()).toContain(ACCEPTED);
  });

  it("still cuts the live frames, which are repainted", async () => {
    const t = terminal(40);
    const pending = promptCloudKey({
      message: "Connect to cloud",
      meta: "cloud.befailproof.example.internal.company.com",
      tabHint: "use open source instead",
      emptyError: "Paste a key, or press tab to use open source.",
      check: vi.fn(async (): Promise<KeyVerdict> => ({ ok: true })),
      collapsed: () => ["CONNECT TO CLOUD"],
      stdin: t.stdin,
      stdout: t.stdout,
    });
    await tick();
    const live = t.lastFrame();
    for (const line of live.split("\n")) expect(line.length).toBeLessThanOrEqual(40);
    t.type("\u001b");
    await pending;
  });
});

describe("Enter waiting on a saved key that comes back refused", () => {
  it("says to paste a key or press tab, as an empty Enter does", async () => {
    const t = terminal();
    let release: (v: KeyVerdict) => void = () => {};
    const pending = promptCloudKey({
      message: "Connect to cloud",
      meta: "app.befailproof.ai",
      tabHint: "skip",
      emptyError: "Paste a key, or press tab to skip.",
      saved: { masked: "****3f2a", check: () => new Promise<KeyVerdict>((r) => (release = r)) },
      check: vi.fn(async (): Promise<KeyVerdict> => ({ ok: true })),
      collapsed: () => ["CONNECT TO CLOUD"],
      stdin: t.stdin,
      stdout: t.stdout,
    });
    await tick(10);
    t.type("\r");
    await tick(10);
    release({ ok: false, line: "Your saved key no longer works: the server rejected that key (401)" });
    await tick(20);
    expect(t.lastFrame()).toContain("▲ Your saved key no longer works");
    expect(t.lastFrame()).toContain("✕ Paste a key, or press tab to skip.");
    // Not the "enter try again" hints a refused TYPED key gets.
    expect(t.lastFrame()).not.toContain("enter try again");
    t.type("\u001b");
    expect(await pending).toBeNull();
  });
});
