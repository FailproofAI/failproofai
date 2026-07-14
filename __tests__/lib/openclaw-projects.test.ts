// @vitest-environment node
//
// Covers OpenClaw dashboard enumeration: reads the on-disk transcripts +
// per-agent sessions.json index, groups by **channel** (from metadata fields —
// OpenClaw routes gateway sessions through the default key and records the
// channel in `lastChannel`/`origin`, verified live v2026.7.1), and names
// sessions from the human-readable `origin.label`. OPENCLAW_HOME fixture.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOpenClawSessions,
  getOpenClawProjects,
  getOpenClawSessionsByEncodedName,
} from "@/lib/openclaw-projects";

const UUID_TG = "aa111111-2222-3333-4444-555555555555";
const UUID_CLI = "f9e8516e-fed2-4e54-acbe-7a20aefc6cfa";

let home: string | undefined;
const prev = process.env.OPENCLAW_HOME;

function seed(): string {
  const h = mkdtempSync(join(tmpdir(), "openclaw-proj-"));
  const sessions = join(h, "agents", "main", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `${UUID_TG}.jsonl`), JSON.stringify({ type: "session", cwd: "/x" }) + "\n");
  writeFileSync(join(sessions, `${UUID_CLI}.jsonl`), JSON.stringify({ type: "session", cwd: "/x" }) + "\n");
  writeFileSync(
    join(sessions, "sessions.json"),
    JSON.stringify({
      // A Telegram gateway session — channel lives in metadata, not the key.
      "agent:main:main": {
        sessionId: UUID_TG,
        lastInteractionAt: 5000,
        lastChannel: "telegram",
        lastTo: "telegram:8674922496",
        chatType: "direct",
        origin: { label: "Chetan (@chhhee10) id:8674922496", provider: "telegram", from: "telegram:8674922496", chatType: "direct" },
      },
      // A pure CLI/local session — no channel metadata.
      "agent:main:cli": { sessionId: UUID_CLI, lastInteractionAt: 2000 },
    }),
  );
  process.env.OPENCLAW_HOME = h;
  return h;
}

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
  if (prev === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = prev;
});

describe("getOpenClawSessions", () => {
  it("derives channel + label + chat metadata from sessions.json (not the key)", async () => {
    home = seed();
    const sessions = await getOpenClawSessions();
    // Sorted by mtime desc → telegram (5000) before cli (2000).
    expect(sessions.map((s) => s.sessionId)).toEqual([UUID_TG, UUID_CLI]);

    const tg = sessions.find((s) => s.sessionId === UUID_TG)!;
    expect(tg.channel).toBe("telegram");
    expect(tg.label).toBe("Chetan (@chhhee10) id:8674922496");
    expect(tg.chatType).toBe("direct");
    expect(tg.chatId).toBe("telegram:8674922496");

    const cli = sessions.find((s) => s.sessionId === UUID_CLI)!;
    expect(cli.channel).toBe("local"); // no channel metadata → local
    expect(cli.label).toBeUndefined();
  });
});

describe("getOpenClawProjects / getOpenClawSessionsByEncodedName", () => {
  it("groups sessions into one project per channel", async () => {
    home = seed();
    const projects = await getOpenClawProjects();
    // telegram (newest) first, then local.
    expect(projects.map((p) => p.name)).toEqual(["openclaw-telegram", "openclaw-local"]);
    expect(projects[0].path).toBe("openclaw:telegram");
    expect(projects[0].cli).toEqual(["openclaw"]);
  });

  it("names sessions by origin.label and carries channel metadata; non-openclaw names return empty", async () => {
    home = seed();
    const tg = await getOpenClawSessionsByEncodedName("openclaw-telegram");
    expect(tg.sessions).toHaveLength(1);
    const s = tg.sessions[0];
    expect(s.name).toBe("Chetan (@chhhee10) id:8674922496"); // readable, not the raw key
    expect(s.path).toBe(UUID_TG); // real transcript → download streams the file
    expect(s.cli).toBe("openclaw");
    expect(s.channelId).toBe("telegram:8674922496");
    expect(s.channelType).toBe("direct");

    const local = await getOpenClawSessionsByEncodedName("openclaw-local");
    expect(local.sessions).toHaveLength(1);
    expect(local.sessions[0].name).toBe(UUID_CLI); // no label → falls back to id

    const none = await getOpenClawSessionsByEncodedName("claude-foo");
    expect(none.sessions).toEqual([]);
  });
});
