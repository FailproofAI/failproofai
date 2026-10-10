import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

vi.mock("../../src/hooks/daemon-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/daemon-service")>();
  return {
    ...actual,
    isDaemonSupportedPlatform: vi.fn(() => true),
    daemonServiceStatus: vi.fn(() => "running"),
    daemonVersionSkew: vi.fn(() => null),
  };
});

import { runBackfillCommand } from "../../src/hooks/backfill-cli";
import { backfillRequestPath } from "../../src/hooks/backfill-request";
import { writeCollectorSettings, writeIngestCredential } from "../../src/hooks/collector-config";
import { updateConfig } from "../../src/hooks/fp-config";
import { daemonServiceStatus, daemonVersionSkew } from "../../src/hooks/daemon-service";
import type { IntegrationType } from "../../src/hooks/types";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const SINCE = NOW - 30 * DAY;

let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-backfill-cli-"));
  process.env.FAILPROOFAI_HOME = home;
  writeIngestCredential({ url: "https://app.befailproof.ai/v1/events", key: "k".repeat(20) });
  writeCollectorSettings({ sessions: true, hooks: true });
  vi.mocked(daemonServiceStatus).mockReturnValue("running");
  vi.mocked(daemonVersionSkew).mockReturnValue(null);
});
afterEach(() => {
  if (prev === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

const sessions: Partial<Record<IntegrationType, number>> = { claude: 412, codex: 96, opencode: 31, goose: 7, hermes: 3 };
const countSessions = vi.fn(async (cli: IntegrationType) => sessions[cli] ?? 0);
const run = (opts: Parameters<typeof runBackfillCommand>[0] = {}) =>
  runBackfillCommand({ now: NOW, sinceMs: SINCE, countSessions, ...opts });
const pending = () => JSON.parse(readFileSync(backfillRequestPath(), "utf8"));

describe("failproofai backfill — traced agents only", () => {
  it("dry run: counts the traced agents and names the ones skipped", async () => {
    updateConfig({ agents: { selected: ["claude", "codex", "opencode"], seen: [] } });
    const { exitCode, lines } = await run({ dryRun: true });
    const text = lines.join("\n");
    expect(exitCode).toBe(0);
    expect(lines[0]).toMatch(/^failproof ai {2}v\S+ {2}· {2}Backfill$/);
    expect(text).toContain("WOULD RE-SEND  since 2026-09-10, traced agents only");
    expect(text).toMatch(/Claude Code +412 sessions/);
    expect(text).toMatch(/OpenAI Codex +96 sessions/);
    // A database-backed agent has no window: it is all of it, and says so.
    expect(text).toMatch(/OpenCode +all 31 sessions, whatever the window/);
    expect(text).toContain("Not traced, skipped: GitHub Copilot, Cursor Agent, Pi, Hermes, OpenClaw, Factory Droid, Devin CLI, Antigravity CLI, Goose");
    expect(text).toContain("Run it for real with failproofai backfill");
    expect(existsSync(backfillRequestPath())).toBe(false);
  });

  it("says Hermes is not re-sent rather than counting what will not move", async () => {
    updateConfig({ agents: { selected: ["hermes"], seen: [] } });
    const text = (await run({ dryRun: true })).lines.join("\n");
    expect(text).toMatch(/Hermes +not re-sent: its sessions have no time window yet/);
  });

  it("asks the daemon for every traced agent without naming them", async () => {
    updateConfig({ agents: { selected: ["claude", "codex"], seen: [] } });
    const { exitCode, lines } = await run();
    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("✓ Asked the daemon to re-send 508 sessions from 2 traced agents since 2026-09-10.");
    expect(lines.join("\n")).toContain("They reach the dashboard over the next few minutes.");
    expect(pending()).toEqual({ kind: "user", sinceMs: SINCE, requestedAtMs: NOW });
  });

  it("names the agents when --agents narrows it", async () => {
    updateConfig({ agents: { selected: ["claude", "codex"], seen: [] } });
    await run({ agents: ["codex"] });
    expect(pending()).toEqual({ kind: "user", sinceMs: SINCE, requestedAtMs: NOW, agents: ["codex"] });
  });

  it("refuses an untraced agent and writes nothing", async () => {
    updateConfig({ agents: { selected: ["claude", "codex"], seen: [] } });
    const { exitCode, lines } = await run({ agents: ["goose"] });
    expect(exitCode).toBe(1);
    expect(lines[0]).toBe("✕ Goose isn't traced, so it can't be backfilled.");
    expect(lines[1]).toBe("  Trace it first with  failproofai config  or  failproofai config --agents claude,codex,goose");
    expect(existsSync(backfillRequestPath())).toBe(false);
  });

  it("refuses a name that is not an agent", async () => {
    const { exitCode, lines } = await run({ agents: ["claud"] });
    expect(exitCode).toBe(1);
    expect(lines[0]).toBe("✕ Not an agent: claud.");
    expect(existsSync(backfillRequestPath())).toBe(false);
  });

  it("refuses to name agents to a daemon of another version, which would re-send them all", async () => {
    vi.mocked(daemonVersionSkew).mockReturnValue({ installed: "1.0.9", expected: "1.0.11" });
    const { exitCode, lines } = await run({ agents: ["claude"] });
    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("failproofai update");
    expect(existsSync(backfillRequestPath())).toBe(false);
    // A plain backfill proceeds: it means "everything" on both versions.
    expect((await run()).exitCode).toBe(0);
  });

  it("traces every agent when there is no saved selection", async () => {
    const text = (await run({ dryRun: true })).lines.join("\n");
    expect(text).not.toContain("Not traced, skipped");
    expect(text).toMatch(/Goose +all 7 sessions/);
  });

  it("says a stopped daemon holds the request, instead of when it lands", async () => {
    vi.mocked(daemonServiceStatus).mockReturnValue("stopped");
    const text = (await run()).lines.join("\n");
    expect(text).toContain("▲ failproofaid is stopped, so nothing moves until it starts. The request waits for it.");
    expect(text).not.toContain("over the next few minutes");
  });

  it("re-sends only hook decisions when session collection is off, and says so", async () => {
    writeCollectorSettings({ sessions: false, hooks: true });
    const text = (await run()).lines.join("\n");
    expect(text).toContain("✓ Asked the daemon to re-send hook decisions since 2026-09-10.");
    expect(text).toContain("Session transcripts are not sent: session collection is off.");
  });

  it("points an unconnected machine at config, never at a key on the command line", async () => {
    rmSync(home, { recursive: true, force: true });
    home = mkdtempSync(resolve(tmpdir(), "fpai-backfill-cli-"));
    process.env.FAILPROOFAI_HOME = home;
    const { exitCode, lines } = await run();
    expect(exitCode).toBe(1);
    expect(lines).toEqual([
      "✕ This machine isn't connected, so there is nowhere to send history.",
      "  Connect it:  failproofai config",
    ]);
  });
});
