// @vitest-environment node
//
// Hermes sessions carry a real working directory, and the audit adapter used to
// throw them all away. `listHermesTranscriptMetadata` opened with
//
//     if (opts.projects && opts.projects.length > 0) return [];
//
// on the premise that "gateway sessions have no cwd" — so `failproofai audit
// --project <repo>` silently reported zero Hermes findings for a repo the user
// had actually driven Hermes in. Nothing failed; Hermes just was not there.
//
// Verified against hermes-agent 0.19.0: `sessions` has real `cwd`, `git_branch`
// and `git_repo_root` columns, and every `source='cli'` session populated them.
// Slack/Telegram gateway sessions genuinely have none, so both shapes are built
// here and each is asserted separately.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import initSqlJs from "sql.js/dist/sql-asm.js";

let root: string;
const prevHome = process.env.HERMES_HOME;
const prevDbPath = process.env.HERMES_DB_PATH;

const CLI_ID = "20260803_080402_a54231"; // real hermes id format: not a UUID
const CLI_ID_2 = "20260803_080544_ae362c";
const GATEWAY_ID = "20260803_081000_bb1122";
const REPO = "/home/u/work/repo";
const OTHER_REPO = "/home/u/work/other";

async function writeDb(path: string): Promise<void> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, title TEXT, " +
      "user_id TEXT, chat_id TEXT, chat_type TEXT, started_at REAL, ended_at REAL, message_count INTEGER);",
  );
  db.run(
    "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, " +
      "tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL);",
  );

  // Two CLI sessions in different repos, and one gateway session with no cwd —
  // gateway columns (chat_id/chat_type) are NULL on CLI rows, as observed live.
  const rows: Array<[string, string, string | null, string, string | null, string | null, number]> = [
    [CLI_ID, "cli", REPO, "cli session", null, null, 1_785_744_000],
    [CLI_ID_2, "cli", OTHER_REPO, "other repo session", null, null, 1_785_744_100],
    [GATEWAY_ID, "slack", null, "gateway session", "C1", "dm", 1_785_744_200],
  ];
  for (const [id, source, cwd, title, chatId, chatType, ts] of rows) {
    db.run("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)", [
      id, source, cwd, title, "U1", chatId, chatType, ts, ts + 10, 1,
    ]);
    db.run("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)", [
      null, id, "user", `hello from ${title}`, null, null, null, ts + 1,
    ]);
  }

  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.from(db.export()));
  db.close();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hermes-cwd-"));
  await writeDb(join(root, "state.db"));
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

describe("hermes audit adapter — cwd-scoped listing", () => {
  it("returns a session whose cwd matches the project filter", async () => {
    const { listHermesTranscriptMetadata } = await import("@/src/audit/cli-adapters/hermes");
    const out = await listHermesTranscriptMetadata({ projects: [REPO] });
    // Was [] unconditionally — this is the whole bug.
    expect(out.map((m) => m.sessionId)).toEqual([CLI_ID]);
  });

  it("excludes sessions from other repos", async () => {
    const { listHermesTranscriptMetadata } = await import("@/src/audit/cli-adapters/hermes");
    const out = await listHermesTranscriptMetadata({ projects: [OTHER_REPO] });
    expect(out.map((m) => m.sessionId)).toEqual([CLI_ID_2]);
  });

  it("excludes cwd-less gateway sessions from any cwd filter", async () => {
    const { listHermesTranscriptMetadata } = await import("@/src/audit/cli-adapters/hermes");
    const out = await listHermesTranscriptMetadata({ projects: [REPO, OTHER_REPO] });
    expect(out.map((m) => m.sessionId).sort()).toEqual([CLI_ID, CLI_ID_2].sort());
    expect(out.some((m) => m.sessionId === GATEWAY_ID)).toBe(false);
  });

  it("returns nothing for a project no Hermes session ran in", async () => {
    const { listHermesTranscriptMetadata } = await import("@/src/audit/cli-adapters/hermes");
    const out = await listHermesTranscriptMetadata({ projects: ["/nowhere"] });
    expect(out).toEqual([]);
  });

  it("still returns every session when no project filter is given", async () => {
    const { listHermesTranscriptMetadata } = await import("@/src/audit/cli-adapters/hermes");
    const out = await listHermesTranscriptMetadata();
    expect(out.map((m) => m.sessionId).sort()).toEqual([CLI_ID, CLI_ID_2, GATEWAY_ID].sort());
  });
});

describe("hermes audit adapter — project grouping", () => {
  it("groups a cwd-bearing session by its working directory", async () => {
    const { listHermesTranscriptMetadata } = await import("@/src/audit/cli-adapters/hermes");
    const { encodeFolderName } = await import("@/lib/paths");
    const out = await listHermesTranscriptMetadata();
    const cli = out.find((m) => m.sessionId === CLI_ID)!;
    expect(cli.projectName).toBe(encodeFolderName(REPO));
  });

  it("keeps the (profile, source) bucket for a gateway session", async () => {
    const { listHermesTranscriptMetadata } = await import("@/src/audit/cli-adapters/hermes");
    const out = await listHermesTranscriptMetadata();
    const gw = out.find((m) => m.sessionId === GATEWAY_ID)!;
    // Unchanged behaviour for the sessions that really are cwd-less.
    expect(gw.projectName).toBe("hermes:default:slack");
  });

  it("keeps the hermes:// transcript path form for every session", async () => {
    const { listHermesTranscriptMetadata } = await import("@/src/audit/cli-adapters/hermes");
    const out = await listHermesTranscriptMetadata();
    for (const m of out) expect(m.transcriptPath).toBe(`hermes://${m.sessionId}`);
  });
});
