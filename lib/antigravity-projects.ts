/**
 * Antigravity (agy) project discovery + session enumeration — AUDIT-ONLY.
 *
 * Antigravity keeps a SQLite index of conversations at
 * `~/.gemini/antigravity-cli/conversation_summaries.db` (table
 * `conversation_summaries`: conversation_id, title, preview, step_count,
 * workspace_uris, project_id, last_modified_time, agent_name, …) and one
 * plain-JSONL transcript per conversation under `brain/<id>/…`. Verified live
 * against agy v1.1.2.
 *
 * The on-disk `brain/` transcripts are the source of truth for a conversation's
 * EXISTENCE (the summaries DB can lag / be checkpointed empty), so we enumerate
 * from disk (lib/antigravity-sessions.ts) and ENRICH each with title + cwd from
 * the SQLite index when a row is present. `workspace_uris` gives the project cwd
 * → per-project grouping; when absent we recover cwd from the transcript's first
 * `run_command` Cwd, else fall back to a synthetic "antigravity" project.
 *
 * DB / home override: set `ANTIGRAVITY_HOME` (used by tests).
 */
import { join } from "node:path";
import { openSqliteReadonly } from "./sqlite-reader";
import {
  antigravityHome,
  listAntigravityTranscripts,
  getAntigravitySessionLog,
} from "./antigravity-sessions";
import { runtimeCache } from "./runtime-cache";
import type { ProjectFolder, SessionFile } from "./projects";
import { encodeFolderName, decodeFolderName } from "./paths";
import { formatDate } from "./format-date";
import { logWarn } from "./logger";

/** Absolute path to the conversation-index SQLite DB. */
export function antigravitySummariesDbPath(): string {
  return join(antigravityHome(), "conversation_summaries.db");
}

interface SummaryRow {
  conversation_id: string;
  title: string | null;
  step_count: number | null;
  workspace_uris: string | null;
  last_modified_time: string | number | null;
}

export interface AntigravityIndexMeta {
  title?: string;
  cwd?: string;
  stepCount?: number;
  lastMs?: number;
}

/** Parse the first workspace URI (a JSON array, or a plain string) into a cwd,
 *  stripping any `file://` scheme. */
function parseWorkspaceCwd(raw: string | null): string | undefined {
  if (!raw) return undefined;
  let first: string | undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && typeof parsed[0] === "string") first = parsed[0];
    else if (typeof parsed === "string") first = parsed;
  } catch {
    first = raw;
  }
  if (!first) return undefined;
  const stripped = first.replace(/^file:\/\//, "");
  return stripped.length > 0 ? stripped : undefined;
}

function toMs(value: string | number | null): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

/** Read the conversation index → conversationId → metadata. Returns an empty
 *  map when the DB is missing/unreadable/empty (fail-open). */
export async function getAntigravityIndex(): Promise<Map<string, AntigravityIndexMeta>> {
  const out = new Map<string, AntigravityIndexMeta>();
  const db = await openSqliteReadonly(antigravitySummariesDbPath());
  if (!db) return out;
  try {
    const rows = db.query<SummaryRow>(
      "SELECT conversation_id, title, step_count, workspace_uris, last_modified_time FROM conversation_summaries",
    );
    for (const r of rows) {
      if (!r.conversation_id) continue;
      out.set(r.conversation_id, {
        title: r.title ?? undefined,
        cwd: parseWorkspaceCwd(r.workspace_uris),
        stepCount: typeof r.step_count === "number" ? r.step_count : undefined,
        lastMs: toMs(r.last_modified_time),
      });
    }
  } catch {
    // corrupt / unexpected schema — fall open with whatever we have
  } finally {
    db.close();
  }
  return out;
}

interface AntigravityConversation {
  conversationId: string;
  cwd: string | null;
  title?: string;
  mtimeMs: number;
}

/** Resolve every on-disk conversation to {cwd, title, mtime}, enriched from the
 *  SQLite index (cwd/title/lastMs) and, when the index lacks a cwd, from the
 *  transcript's first run_command Cwd. */
async function resolveConversations(): Promise<AntigravityConversation[]> {
  let transcripts;
  try {
    transcripts = listAntigravityTranscripts();
  } catch (error) {
    logWarn("Failed to scan Antigravity brain dir:", error);
    return [];
  }
  const index = await getAntigravityIndex();

  const out: AntigravityConversation[] = [];
  for (const t of transcripts) {
    const meta = index.get(t.conversationId);
    let cwd = meta?.cwd ?? null;
    if (!cwd) {
      // No index cwd — recover it from the transcript itself (best-effort).
      try {
        const log = await getAntigravitySessionLog(t.conversationId);
        cwd = log?.cwd ?? null;
      } catch {
        cwd = null;
      }
    }
    out.push({
      conversationId: t.conversationId,
      cwd,
      title: meta?.title,
      mtimeMs: meta?.lastMs ?? t.mtimeMs,
    });
  }
  return out;
}

/** Synthetic project name for conversations whose cwd could not be resolved. */
const ANTIGRAVITY_UNGROUPED = "antigravity";

/** Returns one ProjectFolder per resolved cwd (grouped), plus a synthetic
 *  "antigravity" project for conversations without a cwd. */
export async function getAntigravityProjects(): Promise<ProjectFolder[]> {
  const conversations = await resolveConversations();

  const byName = new Map<string, { latest: number; path: string }>();
  for (const c of conversations) {
    const name = c.cwd ? encodeFolderName(c.cwd) : ANTIGRAVITY_UNGROUPED;
    const path = c.cwd ?? "antigravity";
    const existing = byName.get(name);
    if (!existing || c.mtimeMs > existing.latest) {
      byName.set(name, { latest: c.mtimeMs, path });
    }
  }

  const folders: ProjectFolder[] = [];
  for (const [name, { latest, path }] of byName) {
    const lastModified = new Date(latest);
    folders.push({
      name,
      path,
      isDirectory: true,
      lastModified,
      lastModifiedFormatted: formatDate(lastModified),
      cli: ["antigravity"],
    });
  }
  folders.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return folders;
}

export interface AntigravityProjectByName {
  cwd: string | null;
  sessions: SessionFile[];
}

/** Resolve the Antigravity conversations for a project URL slug (an encoded-cwd
 *  folder name, or the synthetic "antigravity" bucket). */
export async function getAntigravitySessionsByEncodedName(
  name: string,
): Promise<AntigravityProjectByName> {
  const conversations = await resolveConversations();
  const matched = conversations.filter((c) => {
    const encoded = c.cwd ? encodeFolderName(c.cwd) : ANTIGRAVITY_UNGROUPED;
    return encoded === name;
  });
  if (matched.length === 0) return { cwd: null, sessions: [] };

  const sorted = [...matched].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cwd = sorted.find((c) => c.cwd)?.cwd ?? (name === ANTIGRAVITY_UNGROUPED ? null : decodeFolderName(name));

  const sessions: SessionFile[] = sorted.map((c) => {
    const lastModified = new Date(c.mtimeMs);
    return {
      name: c.title ?? c.conversationId,
      path: `antigravity://${c.conversationId}`,
      lastModified,
      lastModifiedFormatted: formatDate(lastModified),
      sessionId: c.conversationId,
      cli: "antigravity" as const,
    };
  });
  return { cwd, sessions };
}

export const getCachedAntigravityProjects = runtimeCache(getAntigravityProjects, 30);
export const getCachedAntigravitySessionsByEncodedName = runtimeCache(
  (name: string) => getAntigravitySessionsByEncodedName(name),
  30,
  { maxSize: 50 },
);
