/** Session page — parses and displays a single session's JSONL log via the Raw Log Viewer. */
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { notFound } from "next/navigation";
import { getCachedSessionLog, type LogEntry } from "@/lib/log-entries";
import { getCachedCodexSessionLog } from "@/lib/codex-sessions";
import { getCachedCopilotSessionLog } from "@/lib/copilot-sessions";
import { getCachedCursorSessionLog } from "@/lib/cursor-sessions";
import { getCachedOpenCodeSessionLog } from "@/lib/opencode-sessions";
import { getCachedPiSessionLog } from "@/lib/pi-sessions";
import { getCachedGeminiSessionLog } from "@/lib/gemini-sessions";
import { decodeFolderName } from "@/lib/paths";
import { baseSessionId } from "@/lib/utils/session-id";
import { resolveProjectPath, UUID_RE } from "@/lib/projects";
import LazyLogViewer from "@/app/components/lazy-log-viewer";
import { CopyButton } from "@/app/components/copy-button";
import { CliBadge } from "@/app/components/cli-badge";

export const dynamic = "force-dynamic";

interface SessionPageProps {
  params: Promise<{
    name: string;
    sessionId: string;
  }>;
}

export default async function SessionPage({ params }: SessionPageProps) {
  const { name, sessionId } = await params;
  // Validate project path — throws RangeError if it escapes the projects root.
  try {
    resolveProjectPath(name);
  } catch {
    notFound();
  }
  const decodedName = decodeFolderName(name);
  const decodedSessionId = baseSessionId(sessionId);
  // OpenCode session IDs are not UUIDs — they use `ses_*` prefixes (e.g.
  // `ses_21ad60d14ffewMeRRKMLdS7vOI`). The other four CLIs use UUIDs. Accept
  // either; the per-CLI loader returns null for unknown IDs anyway.
  const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9]+$/;
  if (!UUID_RE.test(decodedSessionId) && !OPENCODE_SESSION_RE.test(decodedSessionId)) notFound();

  let entries: LogEntry[] | null = null;
  let rawLines: Record<string, unknown>[] | null = null;
  let error: string | null = null;
  let cli: "claude" | "codex" | "copilot" | "cursor" | "opencode" | "pi" | "gemini" = "claude";
  let externalCwd: string | undefined;

  try {
    // Use raw folder name for file operations — decodedName is for display only
    const result = await getCachedSessionLog(name, decodedSessionId);
    entries = result.entries;
    rawLines = result.rawLines;
  } catch (e) {
    const isNotFound = (e as NodeJS.ErrnoException).code === "ENOENT";
    if (isNotFound) {
      // Fall back through external stores in order: Codex → Copilot → Cursor → OpenCode → Pi.
      // Each store keys by sessionId rather than the project slug, so the
      // [name] segment is irrelevant on these branches.
      const codex = await getCachedCodexSessionLog(decodedSessionId);
      if (codex) {
        entries = codex.entries;
        rawLines = codex.rawLines;
        externalCwd = codex.cwd;
        cli = "codex";
      } else {
        const copilot = await getCachedCopilotSessionLog(decodedSessionId);
        if (copilot) {
          entries = copilot.entries;
          rawLines = copilot.rawLines;
          externalCwd = copilot.cwd;
          cli = "copilot";
        } else {
          const cursor = await getCachedCursorSessionLog(decodedSessionId);
          if (cursor) {
            entries = cursor.entries;
            rawLines = cursor.rawLines;
            externalCwd = cursor.cwd;
            cli = "cursor";
          } else {
            const opencode = await getCachedOpenCodeSessionLog(decodedSessionId);
            if (opencode) {
              entries = opencode.entries;
              rawLines = opencode.rawLines;
              externalCwd = opencode.cwd;
              cli = "opencode";
            } else {
              const pi = await getCachedPiSessionLog(decodedSessionId);
              if (pi) {
                entries = pi.entries;
                rawLines = pi.rawLines;
                externalCwd = pi.cwd;
                cli = "pi";
              } else {
                const gemini = await getCachedGeminiSessionLog(decodedSessionId);
                if (gemini) {
                  entries = gemini.entries;
                  rawLines = gemini.rawLines;
                  externalCwd = gemini.cwd;
                  cli = "gemini";
                } else {
                  error = "Session log file not found.";
                }
              }
            }
          }
        }
      }
    } else {
      error = "Failed to read session log.";
    }
  }

  const isExternal = cli !== "claude";
  const headerLabel = isExternal ? "CLI" : "Project";
  const headerValue =
    cli === "codex"
      ? `OpenAI Codex${externalCwd ? ` · ${externalCwd}` : ""}`
      : cli === "copilot"
        ? `GitHub Copilot${externalCwd ? ` · ${externalCwd}` : ""}`
        : cli === "cursor"
          ? `Cursor Agent${externalCwd ? ` · ${externalCwd}` : ""}`
          : cli === "opencode"
            ? `OpenCode${externalCwd ? ` · ${externalCwd}` : ""}`
            : cli === "pi"
              ? `Pi${externalCwd ? ` · ${externalCwd}` : ""}`
              : cli === "gemini"
                ? `Gemini CLI${externalCwd ? ` · ${externalCwd}` : ""}`
                : decodedName;

  return (
    <main className="min-h-screen bg-background">
      <div className="container mx-auto p-8">
        <Link
          href={isExternal ? "/policies?tab=activity" : `/project/${encodeURIComponent(name)}`}
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{isExternal ? "Back to Activity" : "Back to Sessions"}</span>
        </Link>

        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <h1 className="text-4xl font-bold text-foreground">
              Session Log
            </h1>
            <CliBadge cli={cli} />
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground">
              <span className="font-medium">{headerLabel}:</span>{" "}
              {headerValue}
            </p>
            <p className="text-muted-foreground break-words break-all inline-flex items-center gap-1">
              <span className="font-medium">Session:</span> {decodedSessionId}
              <CopyButton text={decodedSessionId} />
            </p>
            {entries && rawLines && (
              <div className="flex items-center gap-4">
                <p className="text-muted-foreground">
                  <span className="font-medium">{rawLines.length}</span> log lines
                </p>
                <a
                  href={`/api/download/${encodeURIComponent(name)}/${encodeURIComponent(decodedSessionId)}?cli=${cli}`}
                  download
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download Logs
                </a>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="bg-card text-card-foreground rounded-lg border border-destructive/50 p-6 shadow-sm">
            <p className="text-destructive text-center py-8">{error}</p>
          </div>
        )}
        {!error && entries && (
          <LazyLogViewer
            entries={entries}
            projectName={
              isExternal
                ? (externalCwd ??
                    (cli === "codex"
                      ? "OpenAI Codex"
                      : cli === "copilot"
                        ? "GitHub Copilot"
                        : cli === "cursor"
                          ? "Cursor Agent"
                          : cli === "opencode"
                            ? "OpenCode"
                            : cli === "pi"
                              ? "Pi"
                              : "Gemini CLI"))
                : decodedName
            }
            sessionId={decodedSessionId}
          />
        )}
      </div>
    </main>
  );
}
