/**
 * OpenClaw (openclaw gateway) session enumeration — AUDIT-ONLY.
 *
 * Surfaces the on-disk transcripts (agents/<agentId>/sessions/<uuid>.jsonl) as
 * synthetic dashboard "projects" grouped by (agentId, channel). The per-agent
 * `sessions.json` index maps sessionKey → {sessionId, timestamps}; we read it to
 * recover the sessionKey (which encodes the channel for gateway sessions) and a
 * reliable last-activity time. Verified live against openclaw v2026.7.1.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeCache } from "./runtime-cache";
import { listOpenClawAgents, listOpenClawTranscripts, openclawHome } from "./openclaw-sessions";
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
  /** Absolute path to the `<uuid>.jsonl` transcript this ref came from. */
  transcriptPath: string;
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
      transcriptPath: t.transcriptPath,
      mtimeMs: meta?.lastMs ?? t.mtimeMs,
      sizeBytes: t.sizeBytes,
    });
  }
  refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return refs;
}

export const getCachedOpenClawSessions = runtimeCache(getOpenClawSessions, 2);

// ── Dashboard history browser (projects list + project-detail sessions) ──

/** Encoded project name for an (agent, channel) pair. */
export function openClawProjectName(agentId: string, channel: string): string {
  return `openclaw-${agentId}-${channel}`;
}

/** Machine-readable grouping key, shown under the project name. */
export function openClawProjectPath(agentId: string, channel: string): string {
  return `openclaw:${agentId}:${channel}`;
}

export interface OpenClawNameSplit {
  agentId: string | null;
  channel: string;
}

/**
 * Every way `openclaw-<agentId>-<channel>` could split, best guess first.
 *
 * Both an agentId and a channel may contain `-`, so the slug is never split
 * blindly: each candidate is an agent id that actually exists on disk, tried
 * longest-first. That alone is not sufficient — with agents `main` and
 * `main-bot` on disk, `openclaw-main-bot-telegram` could be `main-bot`+`telegram`
 * OR `main`+`bot-telegram`, and length alone picks the wrong one whenever the
 * shorter agent owns it. So callers walk the candidates and take the first that
 * matches real sessions.
 *
 * The last candidate is always the legacy channel-only `openclaw-<channel>`
 * form (`agentId: null`), so links shared before agents became part of the name
 * keep resolving — to every agent on that channel, which is what they meant.
 */
export function openClawProjectNameCandidates(name: string): OpenClawNameSplit[] {
  if (!name.startsWith("openclaw-")) return [];
  const rest = name.slice("openclaw-".length);
  if (!rest) return [];

  const out: OpenClawNameSplit[] = [];
  const agents = listOpenClawAgents().sort((a, b) => b.length - a.length);
  for (const agentId of agents) {
    const prefix = `${agentId}-`;
    if (rest.startsWith(prefix) && rest.length > prefix.length) {
      out.push({ agentId, channel: rest.slice(prefix.length) });
    }
  }
  out.push({ agentId: null, channel: rest });
  return out;
}

/** The best-guess split for a project name — `null` if it isn't an OpenClaw one. */
export function parseOpenClawProjectName(name: string): OpenClawNameSplit | null {
  return openClawProjectNameCandidates(name)[0] ?? null;
}

/**
 * Surface OpenClaw sessions as synthetic "projects" grouped by **(agent,
 * channel)** — gateway sessions have no host repo to group by.
 *
 * Agent is the OUTER axis because it is the stable one: `agentId` is a
 * directory name, whereas `channel` is derived from the LAST channel a session
 * used. Grouping by channel alone (as this did before) also collapsed two
 * different agents that both talk on Telegram into one row with one mixed
 * session list — and disagreed with the audit adapter, which grouped by agent.
 */
export async function getOpenClawProjects(): Promise<ProjectFolder[]> {
  const sessions = await getOpenClawSessions();
  const groups = new Map<
    string,
    { agentId: string; channel: string; latest: number; count: number }
  >();
  for (const s of sessions) {
    const key = JSON.stringify([s.agentId, s.channel]);
    const prev = groups.get(key);
    if (prev) {
      prev.latest = Math.max(prev.latest, s.mtimeMs);
      prev.count += 1;
    } else {
      groups.set(key, { agentId: s.agentId, channel: s.channel, latest: s.mtimeMs, count: 1 });
    }
  }
  const out: ProjectFolder[] = [];
  for (const { agentId, channel, latest, count } of groups.values()) {
    const lastModified = new Date(latest);
    out.push({
      name: openClawProjectName(agentId, channel),
      path: openClawProjectPath(agentId, channel),
      isDirectory: true,
      lastModified,
      lastModifiedFormatted: formatDate(lastModified),
      cli: ["openclaw"],
      sessionCount: count,
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
 *  (`openclaw-<agentId>-<channel>`), for the project-detail page. Session names
 *  use the human-readable `origin.label` (e.g. "Chetan (@chhhee10) id:…")
 *  rather than the raw session key. */
export async function getOpenClawSessionsByEncodedName(
  name: string,
): Promise<OpenClawProjectByName> {
  const candidates = openClawProjectNameCandidates(name);
  if (candidates.length === 0) return { cwd: null, sessions: [] };

  const sessions = await getOpenClawSessions();
  const matching = (split: OpenClawNameSplit) =>
    sessions.filter(
      (s) => s.channel === split.channel && (split.agentId === null || s.agentId === split.agentId),
    );

  // Take the first split that actually owns sessions — length alone picks the
  // wrong agent when one id is a hyphen-prefix of another. Falling back to the
  // best guess keeps the page's labelling sensible when nothing matches.
  let chosen = candidates[0];
  let matched = matching(chosen);
  if (matched.length === 0) {
    for (const candidate of candidates.slice(1)) {
      const hits = matching(candidate);
      if (hits.length > 0) {
        chosen = candidate;
        matched = hits;
        break;
      }
    }
  }
  const { agentId, channel } = chosen;
  return {
    // Legacy channel-only names keep their old cwd label, since they really do
    // span every agent on that channel.
    cwd: agentId === null ? `openclaw:${channel}` : openClawProjectPath(agentId, channel),
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
