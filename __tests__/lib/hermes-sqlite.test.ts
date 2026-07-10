// @vitest-environment node
//
// End-to-end integration for the Hermes audit path: builds a real state.db with
// the bundled sql.js driver, points HERMES_DB_PATH at it, and exercises
// enumeration + per-session parse + the adapter. Proves the driver + SQL +
// parser work together in our runtime (no `hermes` binary needed).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import initSqlJs from "sql.js/dist/sql-asm.js";

let dir: string;
let dbPath: string;
const prevEnv = process.env.HERMES_DB_PATH;

const PR_ID = "20260709_102452_abc";
const EMPTY_ID = "20260709_000000_empty";
// In-progress session: ended_at null and message_count a STALE 0, but it has a
// real message row. Must still surface (message_count can lag on live sessions).
const LIVE_ID = "20260709_120000_live";

async function buildFixtureDb(path: string): Promise<void> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, title TEXT, user_id TEXT, chat_id TEXT, chat_type TEXT, started_at REAL, ended_at REAL, message_count INTEGER);",
  );
  db.run(
    "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL);",
  );
  db.run("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)", [PR_ID, "slack", null, "PR session", "U094HN9AFL4", "C0BFWEGNURW", "group", 1_752_000_000, 1_752_000_100, 3]);
  db.run("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)", [EMPTY_ID, "slack", null, "empty", "U1", "C1", "dm", 1_752_000_000, 1_752_000_000, 0]);
  // ended_at null + stale message_count 0, but a real message row (added below).
  db.run("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)", [LIVE_ID, "slack", null, "live session", "U2", "C2", "dm", 1_752_000_200, null, 0]);

  const toolCalls = JSON.stringify([
    { id: "c1", type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: "gh pr create" }) } },
  ]);
  db.run("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)", [1, PR_ID, "user", "create pr", null, null, null, 1_752_000_001]);
  db.run("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)", [2, PR_ID, "assistant", "on it", null, toolCalls, null, 1_752_000_002]);
  db.run("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)", [3, PR_ID, "tool", "PR #287 created", "c1", null, "terminal", 1_752_000_003]);
  db.run("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)", [4, LIVE_ID, "user", "in progress", null, null, null, 1_752_000_201]);

  writeFileSync(path, Buffer.from(db.export()));
  db.close();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hermes-db-"));
  dbPath = join(dir, "state.db");
  await buildFixtureDb(dbPath);
  process.env.HERMES_DB_PATH = dbPath;
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.HERMES_DB_PATH;
  else process.env.HERMES_DB_PATH = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("hermes SQLite integration (real sql.js + temp state.db)", () => {
  it("enumerates sessions with source, message_count, and gateway user/channel metadata", async () => {
    const { getHermesSessions } = await import("@/lib/hermes-projects");
    const sessions = await getHermesSessions();
    expect(sessions.find((s) => s.sessionId === PR_ID)).toMatchObject({
      source: "slack",
      messageCount: 3,
      userId: "U094HN9AFL4",
      chatId: "C0BFWEGNURW",
      chatType: "group",
    });
    expect(sessions.some((s) => s.sessionId === EMPTY_ID)).toBe(true); // present; adapter filters it
  });

  it("uses the latest message timestamp as last-activity (advances while the session is open)", async () => {
    const { getHermesSessions } = await import("@/lib/hermes-projects");
    const pr = (await getHermesSessions()).find((s) => s.sessionId === PR_ID);
    // Latest message in the fixture is at epoch-seconds 1_752_000_003 — NOT the
    // session's started/ended time — so last-activity tracks new messages.
    expect(pr!.mtimeMs).toBe(1_752_000_003 * 1000);
  });

  it("carries user/channel metadata onto the project-detail session list (SessionFile)", async () => {
    const { getHermesSessionsByEncodedName } = await import("@/lib/hermes-projects");
    const { sessions } = await getHermesSessionsByEncodedName("hermes-slack");
    const pr = sessions.find((s) => s.sessionId === PR_ID);
    expect(pr).toMatchObject({
      cli: "hermes",
      userId: "U094HN9AFL4",
      channelId: "C0BFWEGNURW",
      channelType: "group",
    });
  });

  it("surfaces an in-progress session with real messages even when message_count is a stale 0", async () => {
    // Regression (hermes-exosphere review): filtering purely on the denormalized
    // message_count hides live sessions whose count Hermes writes lazily. We now
    // trust actual message rows (MAX(timestamp) non-null).
    const { getHermesSessionsByEncodedName } = await import("@/lib/hermes-projects");
    const { sessions } = await getHermesSessionsByEncodedName("hermes-slack");
    expect(sessions.some((s) => s.sessionId === LIVE_ID)).toBe(true); // count 0 but has a message → shown
    expect(sessions.some((s) => s.sessionId === EMPTY_ID)).toBe(false); // truly empty → still filtered
  });

  it("loads a session's messages and pairs the tool result", async () => {
    const { getHermesSessionLog } = await import("@/lib/hermes-sessions");
    const log = await getHermesSessionLog(PR_ID);
    expect(log).not.toBeNull();
    expect(log!.cwd).toBe("hermes:slack"); // no cwd → grouped by source
    const assistant = log!.entries.find((e) => e.type === "assistant");
    const toolUse =
      assistant?.type === "assistant"
        ? assistant.message.content.find((b) => b.type === "tool_use")
        : undefined;
    expect(toolUse).toMatchObject({ name: "terminal", input: { command: "gh pr create" } });
    expect(toolUse && "result" in toolUse ? toolUse.result?.content : "").toContain("PR #287");
  });

  it("adapter lists non-empty sessions with message_count as cache key + source grouping", async () => {
    const { listHermesTranscriptMetadata } = await import("@/src/audit/cli-adapters/hermes");
    const metas = await listHermesTranscriptMetadata();
    expect(metas.find((m) => m.sessionId === PR_ID)).toMatchObject({
      cli: "hermes",
      projectName: "hermes:slack",
      sizeBytes: 3,
    });
    expect(metas.some((m) => m.sessionId === EMPTY_ID)).toBe(false); // empty filtered out
  });

  it("streamEvents canonicalizes terminal→Bash end-to-end", async () => {
    const { streamHermesEvents } = await import("@/src/audit/cli-adapters/hermes");
    const events = await streamHermesEvents({
      cli: "hermes",
      projectName: "hermes:slack",
      sessionId: PR_ID,
      transcriptPath: `hermes://${PR_ID}`,
      mtimeMs: 0,
      sizeBytes: 3,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ toolName: "Bash", rawToolName: "terminal", cwd: "hermes:slack" });
  });

  it("returns null for a session that doesn't exist", async () => {
    const { getHermesSessionLog } = await import("@/lib/hermes-sessions");
    expect(await getHermesSessionLog("nope_nope_nope")).toBeNull();
  });
});
