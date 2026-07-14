// @vitest-environment node
//
// Covers OpenClaw dashboard enumeration: reads the on-disk transcripts +
// per-agent sessions.json index, groups by agentId, and parses channel metadata
// from the sessionKey. Uses an OPENCLAW_HOME fixture (no real gateway).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOpenClawSessions,
  getOpenClawProjects,
  getOpenClawSessionsByEncodedName,
} from "@/lib/openclaw-projects";

const UUID_CLI = "f9e8516e-fed2-4e54-acbe-7a20aefc6cfa";
const UUID_TG = "aa111111-2222-3333-4444-555555555555";

let home: string | undefined;
const prev = process.env.OPENCLAW_HOME;

function seed(): string {
  const h = mkdtempSync(join(tmpdir(), "openclaw-proj-"));
  const sessions = join(h, "agents", "main", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `${UUID_CLI}.jsonl`), JSON.stringify({ type: "session", cwd: "/x" }) + "\n");
  writeFileSync(join(sessions, `${UUID_TG}.jsonl`), JSON.stringify({ type: "session", cwd: "/x" }) + "\n");
  writeFileSync(
    join(sessions, "sessions.json"),
    JSON.stringify({
      "agent:main:main": { sessionId: UUID_CLI, lastInteractionAt: 2000 },
      "agent:main:telegram:default:direct:99887766": { sessionId: UUID_TG, lastInteractionAt: 5000 },
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
  it("enriches sessions from sessions.json (sessionKey + last-activity) and parses channel", async () => {
    home = seed();
    const sessions = await getOpenClawSessions();
    // Sorted by mtime desc → telegram (5000) before cli (2000).
    expect(sessions.map((s) => s.sessionId)).toEqual([UUID_TG, UUID_CLI]);

    const tg = sessions.find((s) => s.sessionId === UUID_TG)!;
    expect(tg.agentId).toBe("main");
    expect(tg.sessionKey).toBe("agent:main:telegram:default:direct:99887766");
    expect(tg.channel).toBe("telegram");
    expect(tg.chatType).toBe("direct");
    expect(tg.chatId).toBe("99887766");

    const cli = sessions.find((s) => s.sessionId === UUID_CLI)!;
    // agent:main:main is the local/CLI session — no real channel.
    expect(cli.channel).toBeUndefined();
  });
});

describe("getOpenClawProjects / getOpenClawSessionsByEncodedName", () => {
  it("groups sessions into one project per agentId", async () => {
    home = seed();
    const projects = await getOpenClawProjects();
    expect(projects.map((p) => p.name)).toEqual(["openclaw-main"]);
    expect(projects[0].path).toBe("openclaw:main");
    expect(projects[0].cli).toEqual(["openclaw"]);
  });

  it("resolves sessions for openclaw-<agentId>; non-openclaw names return empty", async () => {
    home = seed();
    const byName = await getOpenClawSessionsByEncodedName("openclaw-main");
    expect(byName.sessions).toHaveLength(2);
    expect(byName.sessions.every((s) => s.cli === "openclaw")).toBe(true);
    // Real transcript path is the sessionId (download streams the file).
    expect(byName.sessions.map((s) => s.path)).toEqual(expect.arrayContaining([UUID_CLI, UUID_TG]));

    const none = await getOpenClawSessionsByEncodedName("claude-foo");
    expect(none.sessions).toEqual([]);
  });
});
