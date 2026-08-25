/**
 * Read-only access to OpenCode's SQLite database.
 *
 * This used to shell out: `opencode db --format json "<sql>"`, on the reasoning
 * that going through the CLI avoided coupling us to opencode's internal schema.
 * It did not — the SQL was ours either way, naming opencode's own tables and
 * columns, so the schema coupling was identical and the subprocess bought
 * nothing but its own cost.
 *
 * And that cost was the single largest component of `failproofai audit` on any
 * machine with opencode installed. Each spawn is a full CLI start: ~1.5s
 * measured. `getOpenCodeSessionExport` issues three queries, so a 30-session
 * history spent ~135 seconds launching 90 processes — against a total audit
 * time of ~140s. The audit sat at ~0% CPU throughout, which is why it read as
 * "slow scanning" rather than as what it was: waiting on `execFileSync`.
 *
 * Reading the file directly is the same thing every other SQLite-backed
 * integration already does through `openSqliteReadonly` — goose, devin, hermes,
 * openclaw and antigravity. Opening the database costs microseconds, and one
 * open now serves every query a caller needs instead of one process per query.
 *
 * Fail-open contract is unchanged: a missing file, an unreadable database or a
 * query error yields `null`, and callers degrade to an empty result exactly as
 * they did when the binary was absent from PATH.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { openSqliteReadonly, type SqliteReader } from "./sqlite-reader";

/**
 * Where the database lives.
 *
 * `OPENCODE_DB_PATH` names the file outright and `OPENCODE_HOME` the directory
 * holding it — the same override shape `GOOSE_DB_PATH`/`GOOSE_HOME` and
 * `DEVIN_DB_PATH`/`DEVIN_HOME` use, so tests point at a fixture the same way
 * for every one of them.
 */
export function opencodeDbPath(): string {
  if (process.env.OPENCODE_DB_PATH) return process.env.OPENCODE_DB_PATH;
  const home = process.env.OPENCODE_HOME ?? join(homedir(), ".local", "share", "opencode");
  return join(home, "opencode.db");
}

/**
 * Open the database, hand it to `fn`, and always close it.
 *
 * Callers that need several queries take ONE of these and run them all inside
 * it. That is the whole point: the shape being replaced ran a separate process
 * per query, so three related reads cost three CLI starts.
 */
export async function withOpenCodeDb<T>(
  fn: (db: SqliteReader) => T,
): Promise<T | null> {
  const db = await openSqliteReadonly(opencodeDbPath());
  if (!db) return null;
  try {
    return fn(db);
  } catch {
    // A query error is indistinguishable from a missing database to every
    // caller, and both mean "no opencode data" rather than "audit failed".
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* closing a read-only handle cannot fail in a way that matters here */
    }
  }
}

/** One query, for callers that genuinely need only one. */
export async function queryOpenCodeDb<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[] | null> {
  return withOpenCodeDb((db) => db.query<T>(sql, params));
}
