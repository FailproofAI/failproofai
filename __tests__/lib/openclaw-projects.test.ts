// @vitest-environment node
//
// Covers OpenClaw dashboard enumeration: reads the on-disk transcripts +
// per-agent sessions.json index, groups by **(agent, channel)** (channel comes
// from metadata fields — OpenClaw routes gateway sessions through the default
// key and records the channel in `lastChannel`/`origin`, verified live
// v2026.7.1), and names sessions from the human-readable `origin.label`.
// OPENCLAW_HOME fixture.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOpenClawSessions,
  getOpenClawProjects,
  getOpenClawSessionsByEncodedName,
  parseOpenClawProjectName,
} from "@/lib/openclaw-projects";

const UUID_TG = "aa111111-2222-3333-4444-555555555555";
const UUID_CLI = "f9e8516e-fed2-4e54-acbe-7a20aefc6cfa";
// A SECOND agent, also on telegram — the case that collapsed into one mixed
// project row when grouping was channel-only. Its id contains a hyphen, which
// is why the name parser can't just split the slug.
const UUID_WEATHER = "bb222222-3333-4444-5555-666666666666";
const UUID_SQLITE = "cc333333-4444-5555-6666-777777777777";

let home: string | undefined;
const prev = process.env.OPENCLAW_HOME;

function writeSession(dir: string, uuid: string): void {
  writeFileSync(
    join(dir, `${uuid}.jsonl`),
    JSON.stringify({ type: "session", cwd: "/x" }) + "\n",
  );
}

async function writeSqliteSession(
  root: string,
  agentId: string,
  uuid: string,
  updatedAt: number,
  channel: string | null = null,
): Promise<boolean> {
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): void };
        close(): void;
      };
    };
    const dir = join(root, "agents", agentId, "agent");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "openclaw-agent.sqlite"));
    db.exec(`
      CREATE TABLE session_windows (
        session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL, transcript_updated_at INTEGER,
        ended_at INTEGER, channel TEXT, chat_type TEXT, display_name TEXT
      );
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        event_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, seq)
      );
      CREATE TABLE session_nodes (
        current_session_id TEXT NOT NULL, entry_json TEXT NOT NULL,
        label TEXT, display_name TEXT
      );
      CREATE TABLE session_conversations (
        session_id TEXT, conversation_id TEXT, role TEXT, last_seen_at INTEGER
      );
      CREATE TABLE conversations (
        conversation_id TEXT, channel TEXT, kind TEXT, peer_id TEXT,
        delivery_target TEXT, label TEXT
      );
    `);
    db.prepare(
      "INSERT INTO session_windows VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL)",
    ).run(uuid, `agent:${agentId}:main`, updatedAt, updatedAt, channel);
    db.prepare("INSERT INTO transcript_events VALUES (?, 0, ?, ?)").run(
      uuid,
      JSON.stringify({ type: "session", id: uuid, cwd: `/work/${agentId}` }),
      updatedAt,
    );
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seed(): string {
  const h = mkdtempSync(join(tmpdir(), "openclaw-proj-"));
  const sessions = join(h, "agents", "main", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeSession(sessions, UUID_TG);
  writeSession(sessions, UUID_CLI);
  writeFileSync(
    join(sessions, "sessions.json"),
    JSON.stringify({
      // A Telegram gateway session — channel lives in metadata, not the key.
      "agent:main:main": {
        sessionId: UUID_TG,
        lastInteractionAt: 5000,
        lastChannel: "telegram",
        lastTo: "telegram:1234567890",
        chatType: "direct",
        origin: {
          label: "Example User (@example) id:1234567890",
          provider: "telegram",
          from: "telegram:1234567890",
          chatType: "direct",
        },
      },
      // A pure CLI/local session — no channel metadata.
      "agent:main:cli": { sessionId: UUID_CLI, lastInteractionAt: 2000 },
    }),
  );

  const weather = join(h, "agents", "weather-bot", "sessions");
  mkdirSync(weather, { recursive: true });
  writeSession(weather, UUID_WEATHER);
  writeFileSync(
    join(weather, "sessions.json"),
    JSON.stringify({
      "agent:weather-bot:main": {
        sessionId: UUID_WEATHER,
        lastInteractionAt: 9000,
        lastChannel: "telegram",
        origin: { label: "Weather Bot", provider: "telegram" },
      },
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
    // Sorted by mtime desc, ACROSS agents → weather-bot (9000), telegram
    // (5000), cli (2000).
    expect(sessions.map((s) => s.sessionId)).toEqual([
      UUID_WEATHER,
      UUID_TG,
      UUID_CLI,
    ]);

    const tg = sessions.find((s) => s.sessionId === UUID_TG)!;
    expect(tg.channel).toBe("telegram");
    expect(tg.label).toBe("Example User (@example) id:1234567890");
    expect(tg.chatType).toBe("direct");
    expect(tg.chatId).toBe("telegram:1234567890");

    const cli = sessions.find((s) => s.sessionId === UUID_CLI)!;
    expect(cli.channel).toBe("local"); // no channel metadata → local
    expect(cli.label).toBeUndefined();
  });

  it("discovers SQLite-only agents, defaults their channel, and keeps profiles separate", async () => {
    home = mkdtempSync(join(tmpdir(), "openclaw-sqlite-proj-"));
    if (!(await writeSqliteSession(home, "main", UUID_SQLITE, 12_000))) return;
    await writeSqliteSession(
      home,
      "research",
      UUID_WEATHER,
      11_000,
      "telegram",
    );
    process.env.OPENCLAW_HOME = home;

    const sessions = await getOpenClawSessions();
    expect(sessions.map((s) => [s.agentId, s.sessionId, s.channel])).toEqual([
      ["main", UUID_SQLITE, "local"],
      ["research", UUID_WEATHER, "telegram"],
    ]);

    const projects = await getOpenClawProjects();
    expect(projects.map((p) => p.name)).toEqual([
      "openclaw-main-local",
      "openclaw-research-telegram",
    ]);
  });

  it("prefers a live SQLite row over an archived JSONL copy of the same session", async () => {
    home = mkdtempSync(join(tmpdir(), "openclaw-sqlite-dedup-"));
    const legacyDir = join(home, "agents", "main", "sessions");
    mkdirSync(legacyDir, { recursive: true });
    writeSession(legacyDir, UUID_SQLITE);
    writeFileSync(
      join(legacyDir, "sessions.json"),
      JSON.stringify({
        old: {
          sessionId: UUID_SQLITE,
          lastInteractionAt: 1000,
          lastChannel: "slack",
        },
      }),
    );
    if (
      !(await writeSqliteSession(home, "main", UUID_SQLITE, 15_000, "telegram"))
    )
      return;
    process.env.OPENCLAW_HOME = home;

    const sessions = await getOpenClawSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ channel: "telegram", mtimeMs: 15_000 });
    expect(sessions[0].transcriptPath).toBe(
      `openclaw-sqlite://main/${UUID_SQLITE}`,
    );
  });
});

describe("getOpenClawProjects / getOpenClawSessionsByEncodedName", () => {
  it("groups sessions into one project per (agent, channel), newest first", async () => {
    home = seed();
    const projects = await getOpenClawProjects();
    // weather-bot/telegram (9000), main/telegram (5000), main/local (2000).
    expect(projects.map((p) => p.name)).toEqual([
      "openclaw-weather-bot-telegram",
      "openclaw-main-telegram",
      "openclaw-main-local",
    ]);
    expect(projects[0].path).toBe("openclaw:weather-bot:telegram");
    expect(projects[0].cli).toEqual(["openclaw"]);
  });

  it("keeps two agents on the SAME channel in separate projects", async () => {
    // Regression: grouping by channel alone collapsed every agent on Telegram
    // into one row with one mixed session list.
    home = seed();
    const mainTg = await getOpenClawSessionsByEncodedName(
      "openclaw-main-telegram",
    );
    const weatherTg = await getOpenClawSessionsByEncodedName(
      "openclaw-weather-bot-telegram",
    );
    expect(mainTg.sessions.map((s) => s.sessionId)).toEqual([UUID_TG]);
    expect(weatherTg.sessions.map((s) => s.sessionId)).toEqual([UUID_WEATHER]);
  });

  it("reports a session count per project", async () => {
    home = seed();
    const projects = await getOpenClawProjects();
    expect(projects.map((p) => p.sessionCount)).toEqual([1, 1, 1]);
  });

  it("parses an agent id containing a hyphen without splitting the slug", async () => {
    home = seed();
    expect(parseOpenClawProjectName("openclaw-weather-bot-telegram")).toEqual({
      agentId: "weather-bot",
      channel: "telegram",
    });
    expect(parseOpenClawProjectName("openclaw-main-local")).toEqual({
      agentId: "main",
      channel: "local",
    });
    expect(parseOpenClawProjectName("claude-foo")).toBeNull();
  });

  it("resolves the right agent when one agent id is a hyphen-prefix of another", async () => {
    // Regression: `openclaw-main-bot-telegram` can split as main-bot+telegram OR
    // main+bot-telegram. Longest-match alone always picks the former, which is
    // wrong when the shorter agent owns the session — so candidates are
    // validated against real sessions.
    home = mkdtempSync(join(tmpdir(), "openclaw-ambig-"));
    const mainSessions = join(home, "agents", "main", "sessions");
    const botSessions = join(home, "agents", "main-bot", "sessions");
    mkdirSync(mainSessions, { recursive: true });
    mkdirSync(botSessions, { recursive: true });
    writeSession(mainSessions, UUID_TG);
    writeFileSync(
      join(mainSessions, "sessions.json"),
      JSON.stringify({
        "agent:main:main": {
          sessionId: UUID_TG,
          lastInteractionAt: 5000,
          lastChannel: "bot-telegram",
        },
      }),
    );
    process.env.OPENCLAW_HOME = home;

    // `main-bot` exists on disk, so it wins the longest-match — but owns nothing.
    expect(parseOpenClawProjectName("openclaw-main-bot-telegram")).toEqual({
      agentId: "main-bot",
      channel: "telegram",
    });
    // Resolution still finds the real owner.
    const resolved = await getOpenClawSessionsByEncodedName(
      "openclaw-main-bot-telegram",
    );
    expect(resolved.sessions.map((s) => s.sessionId)).toEqual([UUID_TG]);
    expect(resolved.cwd).toBe("openclaw:main:bot-telegram");
  });

  it("still resolves the legacy channel-only name across every agent", async () => {
    // Links shared before the agent segment existed meant "this channel, all
    // agents" — keep them meaning exactly that instead of 404ing.
    home = seed();
    const legacy = await getOpenClawSessionsByEncodedName("openclaw-telegram");
    expect(legacy.cwd).toBe("openclaw:telegram");
    expect(legacy.sessions.map((s) => s.sessionId).sort()).toEqual(
      [UUID_TG, UUID_WEATHER].sort(),
    );
  });

  it("names sessions by origin.label and carries channel metadata; non-openclaw names return empty", async () => {
    home = seed();
    const tg = await getOpenClawSessionsByEncodedName("openclaw-main-telegram");
    expect(tg.sessions).toHaveLength(1);
    const s = tg.sessions[0];
    expect(s.name).toBe("Example User (@example) id:1234567890"); // readable, not the raw key
    expect(s.path).toBe(UUID_TG); // real transcript → download streams the file
    expect(s.cli).toBe("openclaw");
    expect(s.channelId).toBe("telegram:1234567890");
    expect(s.channelType).toBe("direct");

    const local = await getOpenClawSessionsByEncodedName("openclaw-main-local");
    expect(local.sessions).toHaveLength(1);
    expect(local.sessions[0].name).toBe(UUID_CLI); // no label → falls back to id

    const none = await getOpenClawSessionsByEncodedName("claude-foo");
    expect(none.sessions).toEqual([]);
  });
});
