import React, { useState, useCallback, useEffect, useMemo } from "react";
import { Workflow, ChevronRight } from "lucide-react";
import type { LogEntry, ToolUseBlock } from "@/lib/log-entries";
import { buildEntryKeys } from "@/lib/entry-keys";
import { cn } from "@/lib/utils";
import { ENTRY_BORDER_COLORS } from "./constants";
import { TypeBadge } from "./type-badge";
import { ToolInputOutput } from "./tool-input-output";
import { StatsBar } from "./stats-bar";
import { QueueDivider } from "./queue-divider";
import { UserContent, AssistantContent, GenericContent } from "./content-block-view";
import { formatLocalTimestamp, getEntryTextContent } from "@/lib/log-format";
import { CopyButton } from "@/app/components/copy-button";
import { EntryLinkButton } from "./entry-link-button";

// ── Subagent Tool Card ──

interface SubagentToolCardProps {
  block: ToolUseBlock;
  subagentEntries?: LogEntry[];
  projectName: string;
  sessionId: string;
  highlightedUuid?: string | null;
  autoExpandForUuid?: string | null;
}

export function SubagentToolCard({ block, subagentEntries, projectName, sessionId, highlightedUuid, autoExpandForUuid }: SubagentToolCardProps) {
  const shouldAutoExpand = !!(autoExpandForUuid && subagentEntries?.some(e => e.uuid === autoExpandForUuid));
  const [expanded, setExpanded] = useState(shouldAutoExpand);

  useEffect(() => {
    if (!shouldAutoExpand) return;
    const raf = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(raf);
  }, [shouldAutoExpand]);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const hasEntries = subagentEntries && subagentEntries.length > 0;

  // Same stable-key treatment as the top-level list — subagent transcripts from
  // uuid-less CLIs collide on timestamp just as readily.
  const subagentKeys = useMemo(() => buildEntryKeys(subagentEntries ?? []), [subagentEntries]);

  return (
    <div className="border border-border/50 rounded-lg p-3 bg-muted/10">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <Workflow className="w-4 h-4 text-[color:var(--chart-5)]" />
        <span className="font-mono text-sm text-[color:var(--chart-5)]">Subagent</span>
        {block.subagentType && (
          <span className="inline-flex items-center px-2 py-0.5 text-xs font-mono rounded border bg-[color:var(--chart-5)]/20 text-[color:var(--chart-5)] border-[color:var(--chart-5)]/30">
            {block.subagentType}
          </span>
        )}
        {block.result && (
          <span className="text-xs text-muted-foreground ml-auto">
            {block.result.durationFormatted}
          </span>
        )}
      </div>

      {/* Description */}
      {block.subagentDescription && (
        <p className="text-sm text-muted-foreground mb-2">
          {block.subagentDescription}
        </p>
      )}

      {/* Expand button */}
      {block.subagentId && subagentEntries && (
        <button
          onClick={handleToggle}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 transition-colors mb-2"
        >
          <ChevronRight
            className={cn("w-3 h-3 transition-transform", expanded && "rotate-90")}
          />
          <span>agent-{block.subagentId}</span>
          <span className="text-muted-foreground">
            {expanded ? "Collapse" : "View subagent log"}
          </span>
        </button>
      )}

      {/* Nested subagent log */}
      {expanded && (
        <div className="ml-4 pl-3 border-l-2 border-primary/30 mt-2 space-y-2">
          {subagentEntries && subagentEntries.length === 0 && (
            <div className="text-xs text-muted-foreground py-2">No entries found in subagent log.</div>
          )}
          {hasEntries && (
            <>
              <StatsBar entries={subagentEntries} compact />
            </>
          )}
          {subagentEntries && subagentEntries.map((entry) =>
            entry.type === "queue-operation" ? (
              <QueueDivider
                key={subagentKeys.get(entry)}
                entry={entry}
              />
            ) : (
              <EntryRow
                key={subagentKeys.get(entry)}
                entry={entry}
                projectName={projectName}
                sessionId={sessionId}
                isHighlighted={!!highlightedUuid && entry.uuid === highlightedUuid}
              />
            )
          )}
        </div>
      )}

      {/* Raw input/output */}
      <ToolInputOutput block={block} />
    </div>
  );
}

// ── Entry Row ──

interface EntryRowProps {
  entry: LogEntry;
  entriesBySource?: Map<string, LogEntry[]>;
  projectName: string;
  sessionId: string;
  isHighlighted?: boolean;
  highlightedUuid?: string | null;
  autoExpandForUuid?: string | null;
}

function EntryContent({ entry, entriesBySource, projectName, sessionId, highlightedUuid, autoExpandForUuid }: EntryRowProps): React.ReactNode {
  switch (entry.type) {
    case "user":
      return <UserContent entry={entry} />;
    case "assistant":
      return <AssistantContent entry={entry} entriesBySource={entriesBySource} projectName={projectName} sessionId={sessionId} highlightedUuid={highlightedUuid} autoExpandForUuid={autoExpandForUuid} />;
    case "file-history-snapshot":
    case "progress":
    case "system":
      return <GenericContent entry={entry} />;
  }
}

export const EntryRow = React.memo(function EntryRow({ entry, entriesBySource, projectName, sessionId, isHighlighted, highlightedUuid, autoExpandForUuid }: EntryRowProps) {
  return (
    <div
      id={entry.uuid ? `entry-${entry.uuid}` : undefined}
      className={cn(
        `group border-l-4 ${ENTRY_BORDER_COLORS[entry.type]} bg-card/50 rounded-r-lg mb-2 hover:bg-muted/30 transition-colors`,
        isHighlighted && "entry-highlighted"
      )}
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/30">
        <TypeBadge type={entry.type} />
        <div className="flex items-center gap-1 ml-auto">
          {entry.uuid && <EntryLinkButton uuid={entry.uuid} />}
          <CopyButton text={getEntryTextContent(entry)} />
          <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
            {formatLocalTimestamp(entry.timestampMs)}
          </span>
        </div>
      </div>
      <div className="px-4 py-3">
        <EntryContent entry={entry} entriesBySource={entriesBySource} projectName={projectName} sessionId={sessionId} highlightedUuid={highlightedUuid} autoExpandForUuid={autoExpandForUuid} />
      </div>
    </div>
  );
}, (prev, next) =>
  prev.entry === next.entry &&
  prev.entriesBySource === next.entriesBySource &&
  prev.projectName === next.projectName &&
  prev.sessionId === next.sessionId &&
  prev.isHighlighted === next.isHighlighted &&
  prev.highlightedUuid === next.highlightedUuid &&
  prev.autoExpandForUuid === next.autoExpandForUuid
);
