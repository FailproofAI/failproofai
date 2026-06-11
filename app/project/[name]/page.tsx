/** Project page — shows metadata and a filterable sessions list for a single project. */
import { Suspense } from "react";
import { resolveProjectPath, getCachedSessionFiles, type SessionFile } from "@/lib/projects";
import { getCachedCodexSessionsByEncodedName } from "@/lib/codex-projects";
import { getCachedCopilotSessionsByEncodedName } from "@/lib/copilot-projects";
import { getCachedCursorSessionsByEncodedName } from "@/lib/cursor-projects";
import { getCachedOpenCodeSessionsByEncodedName } from "@/lib/opencode-projects";
import { getCachedPiSessionsByEncodedName } from "@/lib/pi-projects";
import { getCachedGeminiSessionsByEncodedName } from "@/lib/gemini-projects";
import { logWarn } from "@/lib/logger";
import { decodeFolderName } from "@/lib/paths";
import { notFound } from "next/navigation";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import Link from "next/link";
import { formatDate } from "@/lib/format-date";
import SessionsList from "@/app/components/sessions-list";

export const dynamic = "force-dynamic";

interface ProjectPageProps {
  params: Promise<{
    name: string;
  }>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { name } = await params;
  // Resolve under ~/.claude/projects/. Validation may throw RangeError; on bad input
  // we still want to try the external CLIs, since a non-Claude-only cwd never
  // escapes this check.
  let claudeProjectPath: string | null = null;
  try {
    claudeProjectPath = resolveProjectPath(name);
  } catch {
    claudeProjectPath = null;
  }
  const decodedName = decodeFolderName(name);

  const claudeExists = claudeProjectPath ? existsSync(claudeProjectPath) : false;

  let claudeSessions: SessionFile[] = [];
  if (claudeExists && claudeProjectPath) {
    claudeSessions = await getCachedSessionFiles(claudeProjectPath);
  }
  // Note: decodeFolderName is lossy when cwds contain `-` (every `-` becomes `/`),
  // so each external CLI looks up sessions by re-encoding cwd and matching the slug.
  const [codex, copilot, cursor, opencode, pi, gemini] = await Promise.all([
    getCachedCodexSessionsByEncodedName(name),
    getCachedCopilotSessionsByEncodedName(name),
    getCachedCursorSessionsByEncodedName(name),
    getCachedOpenCodeSessionsByEncodedName(name),
    getCachedPiSessionsByEncodedName(name),
    getCachedGeminiSessionsByEncodedName(name),
  ]);
  const codexSessions = codex.sessions;
  const copilotSessions = copilot.sessions;
  const cursorSessions = cursor.sessions;
  const opencodeSessions = opencode.sessions;
  const piSessions = pi.sessions;
  const geminiSessions = gemini.sessions;

  if (
    !claudeExists &&
    codexSessions.length === 0 &&
    copilotSessions.length === 0 &&
    cursorSessions.length === 0 &&
    opencodeSessions.length === 0 &&
    piSessions.length === 0 &&
    geminiSessions.length === 0
  ) {
    notFound();
  }

  // Prefer a canonical cwd recovered from any external store when available —
  // `decodeFolderName(name)` is ambiguous for cwds containing `-` (every `-`
  // becomes `/`). Each external transcript records the literal cwd, so they
  // round-trip correctly. First non-null wins (Codex → Copilot → Cursor → OpenCode → Pi → Gemini).
  const canonicalRoot = codex.cwd ?? copilot.cwd ?? cursor.cwd ?? opencode.cwd ?? pi.cwd ?? gemini.cwd ?? decodedName;

  // Project header metadata
  let lastModified: Date | null = null;
  let lastModifiedFormatted: string | null = null;
  if (claudeExists && claudeProjectPath) {
    try {
      const stats = await stat(claudeProjectPath);
      lastModified = stats.mtime;
      lastModifiedFormatted = formatDate(stats.mtime);
    } catch (error) {
      logWarn(`Failed to get stats for project ${decodedName}:`, error);
    }
  }
  const newestExternal = [codexSessions[0], copilotSessions[0], cursorSessions[0], opencodeSessions[0], piSessions[0], geminiSessions[0]]
    .filter((s): s is SessionFile => !!s)
    .map((s) => s.lastModified)
    .reduce<Date | null>((acc, d) => (!acc || d.getTime() > acc.getTime() ? d : acc), null);
  if (newestExternal && (!lastModified || newestExternal.getTime() > lastModified.getTime())) {
    lastModified = newestExternal;
    lastModifiedFormatted = formatDate(newestExternal);
  }

  const sessionFiles: SessionFile[] = [
    ...claudeSessions,
    ...codexSessions,
    ...copilotSessions,
    ...cursorSessions,
    ...opencodeSessions,
    ...piSessions,
    ...geminiSessions,
  ].sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  // Path line: prefer the Claude storage dir if present (matches existing UX);
  // otherwise show the canonical cwd recovered from the first external store.
  const displayPath = claudeExists && claudeProjectPath ? claudeProjectPath : canonicalRoot;

  return (
    <main className="report">
      <section className="section" data-screen-label="project">
        <Link
          href="/projects"
          className="project-page-back"
          aria-label="Back to projects"
        >
          <span className="arrow">←</span>
          back to projects
        </Link>

        <h1 className="project-page-title">{canonicalRoot}</h1>

        <div className="project-page-meta">
          <span className="label">path</span>
          <span className="path">{displayPath}</span>
          {lastModifiedFormatted && (
            <>
              <span className="sep">·</span>
              <span className="label">modified</span>
              {lastModifiedFormatted}
            </>
          )}
          <span className="sep">·</span>
          <span className="label">sessions</span>
          {sessionFiles.length}
        </div>

        {sessionFiles.length === 0 ? (
          <div className="project-page-empty">
            no .jsonl files found in this project.
            <div className="hint">
              session files will appear here once they are created.
            </div>
          </div>
        ) : (
          <Suspense><SessionsList files={sessionFiles} projectName={name} /></Suspense>
        )}
      </section>
    </main>
  );
}
