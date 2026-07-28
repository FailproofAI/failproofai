// @vitest-environment node
//
// Multi-profile Hermes audit path. Builds a REAL profile tree — <root>/state.db
// plus <root>/profiles/<name>/state.db — with the bundled sql.js driver, points
// HERMES_HOME at it, and proves the whole chain: enumeration tags each session
// with its profile, projects group by (profile, source), and a session in a
// NON-default profile still resolves through the unchanged `hermes://<id>` form.
//
// Before profile support, every one of these sessions except the default
// profile's was invisible to both the dashboard and `failproofai audit`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import initSqlJs from "sql.js/dist/sql-asm.js";

let root: string;
const prevHome = process.env.HERMES_HOME;
const prevDbPath = process.env.HERMES_DB_PATH;

const DEFAULT_ID = "20260709_102452_def";
const WORK_ID = "20260710_090000_work";
const HYPHEN_ID = "20260711_090000_hyph";

async function writeDb(
  path: string,
  session: { id: string; source: string; title: string; ts: number },
): Promise<void> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, title TEXT, user_id TEXT, chat_id TEXT, chat_type TEXT, started_at REAL, ended_at REAL, message_count INTEGER);",
  );
  db.run(
    "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL);",
  );
  db.run("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)", [
    session.id, session.source, null, session.title, "U1", "C1", "dm", session.ts, session.ts + 10, 1,
  ]);
  db.run("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)", [
    1, session.id, "user", `hello from ${session.title}`, null, null, null, session.ts + 1,
  ]);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.from(db.export()));
  db.close();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hermes-multi-"));
  await writeDb(join(root, "state.db"), {
    id: DEFAULT_ID, source: "slack", title: "default session", ts: 1_752_000_000,
  });
  await writeDb(join(root, "profiles", "work", "state.db"), {
    id: WORK_ID, source: "telegram", title: "work session", ts: 1_752_100_000,
  });
  // A profile name containing "-" is the case a naive split on the project name
  // would corrupt.
  await writeDb(join(root, "profiles", "my-bot", "state.db"), {
    id: HYPHEN_ID, source: "cron", title: "my-bot session", ts: 1_752_200_000,
  });
  // A profile with no state.db at all must be skipped, not throw.
  mkdirSync(join(root, "profiles", "empty"), { recursive: true });

  delete process.env.HERMES_DB_PATH;
  process.env.HERMES_HOME = root;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = prevHome;
  if (prevDbPath === undefined) delete process.env.HERMES_DB_PATH;
  else process.env.HERMES_DB_PATH = prevDbPath;
  rmSync(root, { recursive: true, force: true });
});

describe("hermes multi-profile enumeration", () => {
  it("reads every profile's state.db and tags each session with its profile", async () => {
    const { getHermesSessions } = await import("@/lib/hermes-projects");
    const sessions = await getHermesSessions();
    expect(sessions.find((s) => s.sessionId === DEFAULT_ID)?.profile).toBe("default");
    expect(sessions.find((s) => s.sessionId === WORK_ID)?.profile).toBe("work");
    expect(sessions.find((s) => s.sessionId === HYPHEN_ID)?.profile).toBe("my-bot");
  });

  it("sorts merged sessions by last activity across profiles", async () => {
    const { getHermesSessions } = await import("@/lib/hermes-projects");
    const ids = (await getHermesSessions()).map((s) => s.sessionId);
    expect(ids).toEqual([HYPHEN_ID, WORK_ID, DEFAULT_ID]); // newest first
  });

  it("groups projects by (profile, source)", async () => {
    const { getHermesProjects } = await import("@/lib/hermes-projects");
    const projects = await getHermesProjects();
    expect(projects.map((p) => p.name).sort()).toEqual([
      "hermes-default-slack",
      "hermes-my-bot-cron",
      "hermes-work-telegram",
    ]);
    expect(projects.find((p) => p.name === "hermes-work-telegram")?.path).toBe(
      "hermes:work:telegram",
    );
  });

  it("resolves a project name whose profile contains a hyphen", async () => {
    const { getHermesSessionsByEncodedName } = await import("@/lib/hermes-projects");
    const { cwd, sessions } = await getHermesSessionsByEncodedName("hermes-my-bot-cron");
    expect(cwd).toBe("hermes:my-bot:cron");
    expect(sessions.map((s) => s.sessionId)).toEqual([HYPHEN_ID]);
  });

  it("does not leak one profile's sessions into another's project", async () => {
    const { getHermesSessionsByEncodedName } = await import("@/lib/hermes-projects");
    const { sessions } = await getHermesSessionsByEncodedName("hermes-default-slack");
    expect(sessions.map((s) => s.sessionId)).toEqual([DEFAULT_ID]);
  });

  it("still resolves the legacy `hermes-<source>` name against the default profile", async () => {
    // Links made before profile support must keep working.
    const { getHermesSessionsByEncodedName } = await import("@/lib/hermes-projects");
    const { sessions } = await getHermesSessionsByEncodedName("hermes-slack");
    expect(sessions.map((s) => s.sessionId)).toEqual([DEFAULT_ID]);
  });

  it("loads a NON-default profile's session through the unchanged hermes://<id> form", async () => {
    // The identifier deliberately carries no profile: getHermesSessionLog
    // searches every profile DB, so transcript paths already stored in audit
    // history keep resolving.
    const { getHermesSessionLog } = await import("@/lib/hermes-sessions");
    const log = await getHermesSessionLog(WORK_ID);
    expect(log).not.toBeNull();
    expect(log!.profile).toBe("work");
    expect(log!.filePath).toBe(`hermes://${WORK_ID}`);
    expect(log!.cwd).toBe("hermes:work:telegram"); // cwd fallback matches the grouping key
    expect(log!.entries[0]).toMatchObject({ type: "user" });
  });

  it("adapter groups transcripts by profile and channel", async () => {
    const { listHermesTranscriptMetadata } = await import("@/src/audit/cli-adapters/hermes");
    const metas = await listHermesTranscriptMetadata();
    expect(metas.find((m) => m.sessionId === WORK_ID)).toMatchObject({
      cli: "hermes",
      projectName: "hermes:work:telegram",
      transcriptPath: `hermes://${WORK_ID}`,
    });
    expect(metas.find((m) => m.sessionId === DEFAULT_ID)?.projectName).toBe("hermes:default:slack");
  });
});
