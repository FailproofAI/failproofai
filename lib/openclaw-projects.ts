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
  /** Channel/source the session last ran in (from sessions.json metadata) —
   *  e.g. "telegram", "slack", or "local" for a CLI session. Drives grouping. */
  channel: string;
  /** Human-readable label from `origin.label` (e.g. "Chetan (@chhhee10) id:…"). */
  label?: string;
  /** Chat id (e.g. "telegram:8674922496") + type ("direct"/"group") for the
   *  gateway-metadata columns. */
  chatId?: string;
  chatType?: string;
  mtimeMs: number;
  sizeBytes: number;
}

interface SessionIndexMeta {
  lastMs?: number;
  channel?: string;
  chatType?: string;
  label?: string;
  chatId?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Read the per-agent sessions.json index → sessionId → routing metadata.
 *  OpenClaw routes gateway sessions through the agent's default key
 *  (`agent:<id>:main`) and records the channel in metadata fields
 *  (`lastChannel`, `chatType`, `origin.{label,provider,from}`, `lastTo`) rather
 *  than in the key — verified live against v2026.7.1. */
function readSessionsIndex(agentId: string): Map<string, SessionIndexMeta> {
  const out = new Map<string, SessionIndexMeta>();
  const indexPath = join(openclawHome(), "agents", agentId, "sessions", "sessions.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(indexPath, "utf-8"));
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  for (const v of Object.values(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    const sessionId = str(e.sessionId);
    if (!sessionId) continue;
    const origin = (e.origin && typeof e.origin === "object" ? e.origin : {}) as Record<string, unknown>;
    const lastMs =
      typeof e.lastInteractionAt === "number"
        ? e.lastInteractionAt
        : typeof e.updatedAt === "number"
          ? (e.updatedAt as number)
          : undefined;
    out.set(sessionId, {
      lastMs,
      channel: str(e.lastChannel) ?? str(origin.provider) ?? str(origin.surface),
      chatType: str(e.chatType) ?? str(origin.chatType),
      label: str(origin.label),
      chatId: str(e.lastTo) ?? str(origin.from),
    });
  }
  return out;
}

/** List every OpenClaw session across all agents. Fail-open ([] on any error). */
export async function getOpenClawSessions(): Promise<OpenClawSessionRef[]> {
  const transcripts = listOpenClawTranscripts();
  const indexByAgent = new Map<string, Map<string, SessionIndexMeta>>();
  const refs: OpenClawSessionRef[] = [];
  for (const t of transcripts) {
    let idx = indexByAgent.get(t.agentId);
    if (!idx) {
      idx = readSessionsIndex(t.agentId);
      indexByAgent.set(t.agentId, idx);
    }
    const meta = idx.get(t.sessionId);
    refs.push({
      sessionId: t.sessionId,
      agentId: t.agentId,
      // Gateway sessions group by channel; CLI/local runs have none.
      channel: meta?.channel ?? "local",
      label: meta?.label,
      chatType: meta?.chatType,
      chatId: meta?.chatId,
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
 * Surface OpenClaw sessions as synthetic "projects" grouped by **channel**
 * (telegram/slack/…/local) — gateway sessions run per channel, not in a host
 * repo. Mirrors Hermes's group-by-source. One ProjectFolder per channel; its
 * `name` is `openclaw-<channel>`, reversed in `getOpenClawSessionsByEncodedName`.
 */
export async function getOpenClawProjects(): Promise<ProjectFolder[]> {
  const sessions = await getOpenClawSessions();
  const latestByChannel = new Map<string, number>();
  for (const s of sessions) {
    latestByChannel.set(s.channel, Math.max(latestByChannel.get(s.channel) ?? 0, s.mtimeMs));
  }
  const out: ProjectFolder[] = [];
  for (const [channel, latest] of latestByChannel) {
    const lastModified = new Date(latest);
    out.push({
      name: `openclaw-${channel}`,
      path: `openclaw:${channel}`,
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
 *  (`openclaw-<channel>`), for the project-detail page. Session names use the
 *  human-readable `origin.label` (e.g. "Chetan (@chhhee10) id:…") rather than
 *  the raw session key. */
export async function getOpenClawSessionsByEncodedName(
  name: string,
): Promise<OpenClawProjectByName> {
  if (!name.startsWith("openclaw-")) return { cwd: null, sessions: [] };
  const channel = name.slice("openclaw-".length);
  const sessions = await getOpenClawSessions();
  const matched = sessions.filter((s) => s.channel === channel);
  return {
    cwd: `openclaw:${channel}`,
    sessions: matched.map((s) => {
      const lastModified = new Date(s.mtimeMs);
      return {
        name: s.label ?? s.chatId ?? s.sessionId,
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
