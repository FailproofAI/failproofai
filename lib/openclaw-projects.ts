/**
 * OpenClaw (openclaw gateway) session enumeration — AUDIT-ONLY.
 *
 * Surfaces the on-disk transcripts (agents/<agentId>/sessions/<uuid>.jsonl) as
 * synthetic dashboard "projects" grouped by agentId. The per-agent
 * `sessions.json` index maps sessionKey → {sessionId, timestamps}; we read it to
 * recover the sessionKey (which encodes the channel for gateway sessions) and a
 * reliable last-activity time. Verified live against openclaw v2026.7.1.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeCache } from "./runtime-cache";
import { listOpenClawTranscripts, openclawHome } from "./openclaw-sessions";
import type { ProjectFolder, SessionFile } from "./projects";
import { formatDate } from "./format-date";

export interface OpenClawSessionRef {
  sessionId: string;
  agentId: string;
  sessionKey?: string;
  title?: string;
  /** Channel the session ran in (parsed from the sessionKey), e.g. telegram. */
  channel?: string;
  /** Chat id + type parsed from the sessionKey when present. */
  chatId?: string;
  chatType?: string;
  mtimeMs: number;
  sizeBytes: number;
}

/** Read the per-agent sessions.json index → sessionId → {sessionKey, lastMs}. */
function readSessionsIndex(agentId: string): Map<string, { sessionKey: string; lastMs?: number }> {
  const out = new Map<string, { sessionKey: string; lastMs?: number }>();
  const indexPath = join(openclawHome(), "agents", agentId, "sessions", "sessions.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(indexPath, "utf-8"));
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  for (const [sessionKey, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const entry = v as Record<string, unknown>;
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : undefined;
    if (!sessionId) continue;
    const lastMs =
      typeof entry.lastInteractionAt === "number"
        ? entry.lastInteractionAt
        : typeof entry.updatedAt === "number"
          ? entry.updatedAt
          : undefined;
    out.set(sessionId, { sessionKey, lastMs });
  }
  return out;
}

/** Parse an OpenClaw sessionKey into channel metadata. Keys look like
 *  `agent:<agentId>:<channel>:<account>:<chatType>:<chatId>` for gateway
 *  sessions; the local/CLI key is `agent:main:main` (no real channel). */
function parseSessionKey(sessionKey: string | undefined): {
  channel?: string;
  chatType?: string;
  chatId?: string;
} {
  if (!sessionKey) return {};
  const seg = sessionKey.split(":");
  // seg: [agent, agentId, channel, account, chatType, chatId]
  if (seg.length < 3) return {};
  const channel = seg[2];
  if (channel === "main") return {}; // local/CLI session — no channel
  return { channel, chatType: seg[4], chatId: seg[5] };
}

/** List every OpenClaw session across all agents. Fail-open ([] on any error). */
export async function getOpenClawSessions(): Promise<OpenClawSessionRef[]> {
  const transcripts = listOpenClawTranscripts();
  const indexByAgent = new Map<string, Map<string, { sessionKey: string; lastMs?: number }>>();
  const refs: OpenClawSessionRef[] = [];
  for (const t of transcripts) {
    let idx = indexByAgent.get(t.agentId);
    if (!idx) {
      idx = readSessionsIndex(t.agentId);
      indexByAgent.set(t.agentId, idx);
    }
    const meta = idx.get(t.sessionId);
    const parsed = parseSessionKey(meta?.sessionKey);
    refs.push({
      sessionId: t.sessionId,
      agentId: t.agentId,
      sessionKey: meta?.sessionKey,
      channel: parsed.channel,
      chatType: parsed.chatType,
      chatId: parsed.chatId,
      mtimeMs: meta?.lastMs ?? t.mtimeMs,
      sizeBytes: t.sizeBytes,
    });
  }
  refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return refs;
}

export const getCachedOpenClawSessions = runtimeCache(getOpenClawSessions, 2);

// ── Dashboard history browser (projects list + project-detail sessions) ──

/**
 * Surface OpenClaw sessions as synthetic "projects" grouped by agentId — gateway
 * sessions run in the container workspace, not a host repo. One ProjectFolder
 * per agentId; its `name` is `openclaw-<agentId>`, reversed in
 * `getOpenClawSessionsByEncodedName`.
 */
export async function getOpenClawProjects(): Promise<ProjectFolder[]> {
  const sessions = await getOpenClawSessions();
  const latestByAgent = new Map<string, number>();
  for (const s of sessions) {
    latestByAgent.set(s.agentId, Math.max(latestByAgent.get(s.agentId) ?? 0, s.mtimeMs));
  }
  const out: ProjectFolder[] = [];
  for (const [agentId, latest] of latestByAgent) {
    const lastModified = new Date(latest);
    out.push({
      name: `openclaw-${agentId}`,
      path: `openclaw:${agentId}`,
      isDirectory: true,
      lastModified,
      lastModifiedFormatted: formatDate(lastModified),
      cli: ["openclaw"],
    });
  }
  out.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return out;
}

export interface OpenClawProjectByName {
  cwd: string | null;
  sessions: SessionFile[];
}

/** Resolve the OpenClaw sessions for a synthetic project name
 *  (`openclaw-<agentId>`), for the project-detail page. */
export async function getOpenClawSessionsByEncodedName(
  name: string,
): Promise<OpenClawProjectByName> {
  if (!name.startsWith("openclaw-")) return { cwd: null, sessions: [] };
  const agentId = name.slice("openclaw-".length);
  const sessions = await getOpenClawSessions();
  const matched = sessions.filter((s) => s.agentId === agentId);
  return {
    cwd: `openclaw:${agentId}`,
    sessions: matched.map((s) => {
      const lastModified = new Date(s.mtimeMs);
      return {
        name: s.sessionKey ?? s.sessionId,
        path: s.sessionId,
        lastModified,
        lastModifiedFormatted: formatDate(lastModified),
        sessionId: s.sessionId,
        cli: "openclaw" as const,
        channelId: s.chatId,
        channelType: s.chatType,
      };
    }),
  };
}

export const getCachedOpenClawProjects = runtimeCache(getOpenClawProjects, 2);
export const getCachedOpenClawSessionsByEncodedName = runtimeCache(
  (name: string) => getOpenClawSessionsByEncodedName(name),
  2,
  { maxSize: 50 },
);
