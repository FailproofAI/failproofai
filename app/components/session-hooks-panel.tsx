"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  ShieldCheck,
  ShieldX,
  ShieldAlert,
  Shield,
  ChevronDown,
} from "lucide-react";
import PaginationControls from "@/app/components/pagination-controls";
import { searchHookActivityAction } from "@/app/actions/get-hook-activity";
import type { HookActivityPayload } from "@/app/actions/get-hook-activity";
import { useAutoRefresh } from "@/contexts/AutoRefreshContext";
import { formatRelativeTime } from "@/lib/format-duration";
import { CopyButton } from "@/app/components/copy-button";

function formatAbsoluteTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// -- Badge Components --

function DecisionBadge({ decision }: { decision: "allow" | "deny" | "instruct" }) {
  if (decision === "deny") {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase bg-red-500/10 text-red-400 border border-red-500/20">
        <ShieldX className="h-3 w-3" />
        Deny
      </span>
    );
  }
  if (decision === "instruct") {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase bg-amber-500/10 text-amber-400 border border-amber-500/20">
        <ShieldAlert className="h-3 w-3" />
        Instruct
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
      <ShieldCheck className="h-3 w-3" />
      Allow
    </span>
  );
}

function EventTypeBadge({ eventType }: { eventType: string }) {
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[0.6rem] font-medium bg-muted text-muted-foreground border border-border/50">
      {eventType}
    </span>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  const isDefault = mode === "default";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[0.6rem] font-medium border ${
        isDefault
          ? "bg-sky-500/10 text-sky-400 border-sky-500/20"
          : "bg-amber-500/10 text-amber-400 border-amber-500/20"
      }`}
    >
      {mode}
    </span>
  );
}

function DurationDisplay({ ms }: { ms: number }) {
  const color =
    ms > 500
      ? "text-red-400"
      : ms > 100
        ? "text-amber-400"
        : "text-muted-foreground";
  return <span className={`font-mono text-[0.7rem] ${color}`}>{formatDuration(ms)}</span>;
}

// -- Decision Pill Toggle --

function DecisionPills({
  value,
  onChange,
}: {
  value: "" | "allow" | "deny" | "instruct";
  onChange: (v: "" | "allow" | "deny" | "instruct") => void;
}) {
  const opts: { label: string; value: "" | "allow" | "deny" | "instruct" }[] = [
    { label: "All", value: "" },
    { label: "Allow", value: "allow" },
    { label: "Instruct", value: "instruct" },
    { label: "Deny", value: "deny" },
  ];
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-muted/30 p-0.5">
      {opts.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-1 text-[0.65rem] font-medium rounded transition-all ${
            value === opt.value
              ? opt.value === "deny"
                ? "bg-red-500/15 text-red-400 shadow-sm"
                : opt.value === "allow"
                  ? "bg-emerald-500/15 text-emerald-400 shadow-sm"
                  : opt.value === "instruct"
                    ? "bg-amber-500/15 text-amber-400 shadow-sm"
                    : "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// -- Expandable Detail Panel --

function SessionHooksDetailPanel({
  item,
}: {
  item: HookActivityPayload["entries"][number];
}) {
  return (
    <tr>
      <td colSpan={9} className="px-0 py-0">
        <div className="px-6 py-3 bg-muted/20 border-t border-border/30 space-y-2 text-xs animate-expand">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-1.5">
            <div>
              <span className="text-muted-foreground">Session ID: </span>
              <span className="font-mono text-foreground">
                {item.sessionId ?? "\u2014"}
              </span>
              {item.sessionId && <CopyButton text={item.sessionId} />}
            </div>
            <div>
              <span className="text-muted-foreground">CWD: </span>
              <span className="font-mono text-foreground">{item.cwd ?? "\u2014"}</span>
              {item.cwd && <CopyButton text={item.cwd} />}
            </div>
            <div>
              <span className="text-muted-foreground">Transcript: </span>
              <span className="font-mono text-foreground break-all">
                {item.transcriptPath ?? "\u2014"}
              </span>
              {item.transcriptPath?.startsWith("opencode-db://") && (
                <span className="text-muted-foreground ml-1">(stored in opencode DB)</span>
              )}
            </div>
          </div>
          {item.policyNames && item.policyNames.length > 1 && (
            <div>
              <span className="text-muted-foreground">Policies: </span>
              <span className="font-mono text-foreground">{item.policyNames.join(", ")}</span>
            </div>
          )}
          {item.reason && (
            <div>
              <span className="text-muted-foreground">Full reason: </span>
              <span className="text-foreground">{item.reason}</span>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

// -- Main Component --

interface SessionHooksPanelProps {
  sessionId: string;
  initialData: HookActivityPayload;
}

export default function SessionHooksPanel({ sessionId, initialData }: SessionHooksPanelProps) {
  const { intervalSec } = useAutoRefresh();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<HookActivityPayload>(initialData);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  // Filter state (no URL sync — local to this panel)
  const [filterDecision, setFilterDecision] = useState<"" | "allow" | "deny" | "instruct">("");
  const [filterEventType, setFilterEventType] = useState("");
  const [filterPolicy, setFilterPolicy] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filtersRef = useRef({ filterDecision, filterEventType, filterPolicy });
  filtersRef.current = { filterDecision, filterEventType, filterPolicy };

  const hasActiveFilters = filterDecision !== "" || filterEventType !== "" || filterPolicy !== "";

  const fetchData = useCallback(async (p: number) => {
    try {
      const { filterDecision: fd, filterEventType: fe, filterPolicy: fp } = filtersRef.current;
      const result = await searchHookActivityAction(
        {
          sessionId,
          decision: fd || undefined,
          eventType: fe || undefined,
          policyName: fp || undefined,
        },
        p,
      );
      setData(result);
    } catch {
      // Non-critical
    }
  }, [sessionId]);

  // Fetch on mount and poll
  useEffect(() => {
    fetchData(page);
    const ms = intervalSec > 0 ? intervalSec * 1000 : 5000;
    const id = setInterval(() => fetchData(page), ms);
    return () => clearInterval(id);
  }, [page, fetchData, intervalSec]);

  // Reset to page 1 when filters change (debounced)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      setExpandedRow(null);
      fetchData(1);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterDecision, filterEventType, filterPolicy]);

  const items = data.entries;
  const totalPages = data.totalPages;

  const toggleRow = (idx: number) => {
    setExpandedRow((prev) => (prev === idx ? null : idx));
  };

  return (
    <div>
      <button
        onClick={() => setIsCollapsed((prev) => !prev)}
        className="flex items-center gap-2 hover:opacity-80 transition-opacity"
      >
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
        />
        <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Hook Logs
        </span>
      </button>
      {!isCollapsed && (
      <div className="mt-2 bg-card border border-border rounded-lg overflow-hidden shadow-sm">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-border bg-muted/20">
        <DecisionPills value={filterDecision} onChange={setFilterDecision} />
        <select
          value={filterEventType}
          onChange={(e) => setFilterEventType(e.target.value)}
          className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-shadow"
        >
          <option value="">All Events</option>
          <option value="PreToolUse">PreToolUse</option>
          <option value="PostToolUse">PostToolUse</option>
          <option value="SessionStart">SessionStart</option>
          <option value="SessionEnd">SessionEnd</option>
          <option value="UserPromptSubmit">UserPromptSubmit</option>
          <option value="PermissionRequest">PermissionRequest</option>
        </select>
        <div className="relative">
          <input
            type="text"
            value={filterPolicy}
            onChange={(e) => setFilterPolicy(e.target.value)}
            placeholder="Filter by policy…"
            className="h-7 rounded-md border border-border bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground w-44 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-shadow"
          />
        </div>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 px-4">
          <Shield className="h-10 w-10 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground mt-3">
            {hasActiveFilters ? "No matching hook events." : "No hook events found."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border bg-muted/30">
                <th className="px-4 py-2.5 font-medium w-6" />
                <th className="px-3 py-2.5 font-medium">Decision</th>
                <th className="px-3 py-2.5 font-medium">Event</th>
                <th className="px-3 py-2.5 font-medium">Tool</th>
                <th className="px-3 py-2.5 font-medium">Policy</th>
                <th className="px-3 py-2.5 font-medium">Reason</th>
                <th className="px-3 py-2.5 font-medium">Duration</th>
                <th className="px-3 py-2.5 font-medium">Mode</th>
                <th className="px-3 py-2.5 font-medium text-right">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {items.map((item, i) => {
                const isDeny = item.decision === "deny";
                const isExpanded = expandedRow === i;
                const isInstruct = item.decision === "instruct";
                return (
                  <React.Fragment key={`${item.timestamp}-${i}`}>
                    <tr
                      onClick={() => toggleRow(i)}
                      className={`cursor-pointer transition-colors ${
                        isDeny
                          ? "bg-red-500/[0.03] hover:bg-red-500/[0.07] border-l-2 border-l-red-500/40"
                          : isInstruct
                            ? "bg-amber-500/[0.03] hover:bg-amber-500/[0.07] border-l-2 border-l-amber-500/40"
                            : i % 2 === 0
                              ? "hover:bg-muted/30"
                              : "bg-muted/[0.04] hover:bg-muted/30"
                      } ${isExpanded ? "bg-muted/20" : ""}`}
                    >
                      <td className="px-4 py-2">
                        <ChevronDown
                          className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-150 ${
                            isExpanded ? "rotate-0" : "-rotate-90"
                          }`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <DecisionBadge decision={item.decision} />
                      </td>
                      <td className="px-3 py-2">
                        <EventTypeBadge eventType={item.eventType} />
                      </td>
                      <td className="px-3 py-2 font-mono text-foreground">
                        {item.toolName ?? "\u2014"}
                      </td>
                      <td className="px-3 py-2 font-mono text-foreground">
                        {item.policyNames && item.policyNames.length > 1 ? (
                          <span title={item.policyNames.join(", ")}>
                            {item.policyNames[0]}
                            <span className="text-muted-foreground text-[0.6rem]"> +{item.policyNames.length - 1}</span>
                          </span>
                        ) : (
                          item.policyName ?? "\u2014"
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-muted-foreground truncate max-w-[240px]"
                        title={item.reason ?? ""}
                      >
                        {item.reason ?? "\u2014"}
                      </td>
                      <td className="px-3 py-2">
                        <DurationDisplay ms={item.durationMs} />
                      </td>
                      <td className="px-3 py-2">
                        {item.permissionMode ? (
                          <ModeBadge mode={item.permissionMode} />
                        ) : (
                          "\u2014"
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-right text-muted-foreground whitespace-nowrap"
                        title={formatAbsoluteTime(item.timestamp)}
                      >
                        {formatRelativeTime(item.timestamp)}
                      </td>
                    </tr>
                    {isExpanded && <SessionHooksDetailPanel item={item} />}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <PaginationControls
        currentPage={page}
        totalPages={totalPages}
        onPageChange={(p) => {
          setPage(p);
          setExpandedRow(null);
        }}
      />
      </div>
      )}
    </div>
  );
}
