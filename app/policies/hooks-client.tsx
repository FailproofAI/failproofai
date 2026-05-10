"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef, useTransition } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  ArrowLeft,
  ShieldCheck,
  ShieldX,
  ShieldAlert,
  Shield,
  ChevronDown,
  Copy,
  Check,
  Settings,
  Code,
  X,
} from "lucide-react";
import PaginationControls from "@/app/components/pagination-controls";
import { getHookActivityAction, searchHookActivityAction } from "@/app/actions/get-hook-activity";
import type { HookActivityPayload } from "@/app/actions/get-hook-activity";
import { getHooksConfigAction } from "@/app/actions/get-hooks-config";
import type { HooksConfigPayload, PolicyInfo, CustomPolicyInfo } from "@/app/actions/get-hooks-config";
import type { IntegrationType } from "@/src/hooks/types";
import { togglePolicyAction } from "@/app/actions/update-hooks-config";
import { installHooksWebAction, removeHooksWebAction } from "@/app/actions/install-hooks-web";
import { updatePolicyParamsAction } from "@/app/actions/update-policy-params";
import { useAutoRefresh } from "@/contexts/AutoRefreshContext";
import { useUrlParams } from "@/lib/use-url-params";
import { pageToParam, paramToPage } from "@/lib/url-filter-serializers";
import { getCliLabel, getCliBadgeClasses, KNOWN_CLI_IDS, isKnownCli, type CliId } from "@/lib/cli-registry";
import { formatRelativeTime } from "@/lib/format-duration";
import { Button } from "@/components/ui/button";

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


function shortenSession(sessionId: string | undefined): string {
  if (!sessionId) return "\u2014";
  return sessionId.slice(0, 8);
}

/**
 * Best-effort extraction of the Claude project folder name from a transcript path.
 */
function projectFromTranscriptPath(transcriptPath: string): string | null {
  const normalized = transcriptPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const folder = parts[parts.length - 2];
  if (!folder || folder.startsWith('.')) return null;
  return folder;
}

function encodeCwdForUrl(cwd: string): string {
  // Inverse of decodeFolderName, inlined here so this component file stays
  // client-side and doesn't pull lib/paths server imports.
  const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(cwd);
  if (driveMatch) return driveMatch[1] + "--" + driveMatch[2].replace(/[\\/]/g, "-");
  return cwd.replace(/[\\/]/g, "-");
}

function SessionCell({
  sessionId,
  transcriptPath,
  integration,
  cwd,
}: {
  sessionId?: string;
  transcriptPath?: string;
  integration?: string;
  cwd?: string;
}) {
  if (!sessionId) return <span className="text-muted-foreground">\u2014</span>;
  const short = shortenSession(sessionId);

  const isCodex = integration === "codex" || (transcriptPath?.includes("/.codex/") ?? false);
  const isCopilot =
    integration === "copilot" ||
    (transcriptPath?.includes("/.copilot/session-state/") ?? false);
  const isCursor =
    integration === "cursor" || (transcriptPath?.includes("/.cursor/") ?? false);
  const isOpenCode =
    integration === "opencode" ||
    (transcriptPath?.includes("/.local/share/opencode/") ?? false) ||
    (transcriptPath?.includes("/.opencode/") ?? false);
  const isPi =
    integration === "pi" || (transcriptPath?.includes("/.pi/") ?? false);
  const isGemini =
    integration === "gemini" || (transcriptPath?.includes("/.gemini/") ?? false);
  if (isCodex || isCopilot || isCursor || isOpenCode || isPi || isGemini) {
    // The session route auto-detects CLI by file location, so [name] only
    // affects the breadcrumb. Encode the cwd Claude-style when we have it.
    const fallbackSeg = isCodex ? "codex" : isCopilot ? "copilot" : isCursor ? "cursor" : isOpenCode ? "opencode" : isPi ? "pi" : "gemini";
    const projectSeg = cwd ? encodeCwdForUrl(cwd) : fallbackSeg;
    return (
      <Link
        href={`/project/${encodeURIComponent(projectSeg)}/session/${encodeURIComponent(sessionId)}`}
        className="text-primary hover:underline font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        {short}
      </Link>
    );
  }

  const project = transcriptPath ? projectFromTranscriptPath(transcriptPath) : null;
  if (project) {
    return (
      <Link
        href={`/project/${encodeURIComponent(project)}/session/${encodeURIComponent(sessionId)}`}
        className="text-primary hover:underline font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        {short}
      </Link>
    );
  }
  return <span className="text-muted-foreground font-mono">{short}</span>;
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

function IntegrationBadge({ integration }: { integration?: string }) {
  if (!integration) return null;
  const label = getCliLabel(integration);
  const classes = getCliBadgeClasses(integration);
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[0.6rem] font-medium border ${classes}`}
      title={`Agent CLI: ${label}`}
    >
      {label}
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

// -- Copy Button --

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
      title="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
    </button>
  );
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

// -- Stats Bar --

function StatsBar({ stats }: { stats: HookActivityPayload["stats"] }) {
  const denyRate = stats.totalEvents > 0 ? ((stats.denyCount / stats.totalEvents) * 100).toFixed(0) : "0";

  return (
    <div className="flex items-center gap-6 text-[0.7rem] text-muted-foreground">
      <div>
        <span className="text-foreground font-mono font-semibold">{stats.totalEvents}</span> total events
      </div>
      <div>
        <span className={`font-mono font-semibold ${stats.denyCount > 0 ? "text-red-400" : "text-foreground"}`}>
          {denyRate}%
        </span>{" "}
        deny rate
      </div>
      <div className="hidden sm:block">
        top policy:{" "}
        <span className="font-mono text-foreground">{stats.topPolicy ?? "\u2014"}</span>
      </div>
    </div>
  );
}

// -- Expandable Detail Panel --

function DetailPanel({
  item,
}: {
  item: HookActivityPayload["entries"][number];
}) {
  return (
    <tr>
      <td colSpan={10} className="px-0 py-0">
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

// -- Activity Tab --

function ActivityTab({
  hooksInstalled,
  onSwitchTab,
}: {
  hooksInstalled?: boolean;
  onSwitchTab?: (tab: "activity" | "policies") => void;
}) {
  const { intervalSec } = useAutoRefresh();
  const url = useUrlParams();
  const mountedRef = useRef(false);

  const [page, setPage] = useState(() => paramToPage(url.get("page")));
  const [data, setData] = useState<HookActivityPayload | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const [filterDecision, setFilterDecision] = useState<"" | "allow" | "deny" | "instruct">(() => {
    const v = url.get("decision");
    return v === "allow" || v === "deny" || v === "instruct" ? v : "";
  });
  const [filterEventType, setFilterEventType] = useState(() => url.get("event") ?? "");
  const [filterPolicy, setFilterPolicy] = useState(() => url.get("policy") ?? "");
  const [filterSessionId, setFilterSessionId] = useState(() => url.get("session") ?? "");
  const [filterCli, setFilterCli] = useState<"" | CliId>(() => {
    const v = url.get("cli");
    return isKnownCli(v) ? v : "";
  });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filtersRef = useRef({ filterDecision, filterEventType, filterPolicy, filterSessionId, filterCli });
  filtersRef.current = { filterDecision, filterEventType, filterPolicy, filterSessionId, filterCli };

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    url.setAll({
      decision: filterDecision || undefined,
      event: filterEventType || undefined,
      policy: filterPolicy || undefined,
      session: filterSessionId || undefined,
      cli: filterCli || undefined,
      page: pageToParam(page),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterDecision, filterEventType, filterPolicy, filterSessionId, filterCli, page]);

  const hasActiveFilters = filterDecision !== "" || filterEventType !== "" || filterPolicy !== "" || filterSessionId !== "" || filterCli !== "";

  const fetchData = useCallback(async (p: number) => {
    try {
      const { filterDecision: fd, filterEventType: fe, filterPolicy: fp, filterSessionId: fs, filterCli: fc } = filtersRef.current;
      const active = fd !== "" || fe !== "" || fp !== "" || fs !== "" || fc !== "";
      let result: HookActivityPayload;
      if (active) {
        result = await searchHookActivityAction(
          {
            decision: fd || undefined,
            eventType: fe || undefined,
            policyName: fp || undefined,
            sessionId: fs || undefined,
            integration: fc || undefined,
          },
          p,
        );
      } else {
        result = await getHookActivityAction(p);
      }
      setData(result);
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    fetchData(page);
    const ms = intervalSec > 0 ? intervalSec * 1000 : 5000;
    const id = setInterval(() => fetchData(page), ms);
    return () => clearInterval(id);
  }, [page, fetchData, intervalSec]);

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
  }, [filterDecision, filterEventType, filterPolicy, filterSessionId, filterCli]);

  const items = data?.entries ?? [];
  const totalPages = data?.totalPages ?? 1;

  const toggleRow = (idx: number) => {
    setExpandedRow((prev) => (prev === idx ? null : idx));
  };

  return (
    <>
      {data?.stats && data.stats.totalEvents > 0 && (
        <div className="mb-4">
          <StatsBar stats={data.stats} />
        </div>
      )}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
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
          <select
            value={filterCli}
            onChange={(e) => {
              const v = e.target.value;
              setFilterCli(v === "" || isKnownCli(v) ? v : "");
            }}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-shadow"
            aria-label="Filter by CLI"
          >
            <option value="">All CLIs</option>
            {KNOWN_CLI_IDS.map((id) => (
              <option key={id} value={id}>
                {getCliLabel(id)}
              </option>
            ))}
          </select>
          <div className="relative">
            <input
              type="text"
              value={filterPolicy}
              onChange={(e) => setFilterPolicy(e.target.value)}
              placeholder="Filter by policy\u2026"
              className="h-7 rounded-md border border-border bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground w-44 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-shadow"
            />
          </div>
          <div className="relative">
            <input
              type="text"
              value={filterSessionId}
              onChange={(e) => setFilterSessionId(e.target.value)}
              placeholder="Filter by session…"
              className="h-7 rounded-md border border-border bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground w-44 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-shadow"
            />
          </div>
        </div>

        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
            <Shield className="h-12 w-12 text-muted-foreground/30" />
            {hooksInstalled === false ? (
              <>
                <p className="text-sm text-muted-foreground mt-4 font-medium">Policies are not installed</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  Go to the{" "}
                  <button
                    className="underline hover:text-foreground transition-colors"
                    onClick={() => onSwitchTab?.("policies")}
                  >
                    Policies tab
                  </button>
                  {" "}and click <span className="font-mono bg-muted px-1 rounded">Install</span> to enable policy monitoring.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground mt-4">
                {hasActiveFilters
                  ? "No matching activity."
                  : "Waiting for hook events\u2026"}
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border bg-muted/30">
                  <th className="px-4 py-2.5 font-medium w-6" />
                  <th className="px-3 py-2.5 font-medium">Decision</th>
                  <th className="px-3 py-2.5 font-medium">Event</th>
                  <th className="px-3 py-2.5 font-medium">CLI</th>
                  <th className="px-3 py-2.5 font-medium">Tool</th>
                  <th className="px-3 py-2.5 font-medium">Policy</th>
                  <th className="px-3 py-2.5 font-medium">Reason</th>
                  <th className="px-3 py-2.5 font-medium">Duration</th>
                  <th className="px-3 py-2.5 font-medium">Session</th>
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
                        <td className="px-3 py-2">
                          <IntegrationBadge integration={item.integration} />
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
                        <td className="px-3 py-2" title={item.sessionId ?? ""}>
                          <SessionCell
                            sessionId={item.sessionId}
                            transcriptPath={item.transcriptPath}
                            integration={item.integration}
                            cwd={item.cwd}
                          />
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
                      {isExpanded && <DetailPanel item={item} />}
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
    </>
  );
}

// -- Policies Tab --

function PolicyToggle({
  enabled,
  onChange,
  disabled,
}: {
  enabled: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
        enabled ? "bg-emerald-500" : "bg-muted-foreground/30"
      }`}
      aria-label={enabled ? "Disable policy" : "Enable policy"}
    >
      <span
        className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${
          enabled ? "translate-x-3.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

// -- Policy Config Modal --

function PolicyConfigModal({
  policy,
  onClose,
  onSave,
}: {
  policy: PolicyInfo;
  onClose: () => void;
  onSave: (params: Record<string, unknown>) => void;
}) {
  const params = policy.params ?? {};
  const current = policy.currentParams ?? {};

  // Initialize state for each param
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(params)) {
      const stored = key in current ? current[key] : spec.default;
      init[key] = stored;
    }
    return init;
  });

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const updateValue = (key: string, val: unknown) => {
    setValues((prev) => ({ ...prev, [key]: val }));
  };

  const renderInput = (key: string, spec: { type: string; description: string; default: unknown }) => {
    const val = values[key];

    if (spec.type === "boolean") {
      return (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!val}
            onChange={(e) => updateValue(key, e.target.checked)}
            className="rounded border-border"
          />
          <span className="text-xs text-muted-foreground">{spec.description}</span>
        </label>
      );
    }

    if (spec.type === "number") {
      return (
        <input
          type="number"
          value={typeof val === "number" ? val : ""}
          onChange={(e) => updateValue(key, Number(e.target.value))}
          className="w-full h-7 rounded border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      );
    }

    if (spec.type === "string[]") {
      const lines = Array.isArray(val) ? (val as string[]).join("\n") : "";
      return (
        <textarea
          value={lines}
          onChange={(e) => updateValue(key, e.target.value.split("\n").filter((l) => l.trim() !== ""))}
          rows={4}
          placeholder={"One entry per line"}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/40 resize-y"
        />
      );
    }

    if (spec.type === "pattern[]") {
      const patterns = Array.isArray(val) ? (val as { regex: string; label: string }[]) : [];
      return (
        <div className="space-y-1.5">
          {patterns.map((p, i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <input
                type="text"
                value={p.regex}
                onChange={(e) => {
                  const next = [...patterns];
                  next[i] = { ...next[i], regex: e.target.value };
                  updateValue(key, next);
                }}
                placeholder="regex"
                className="flex-1 h-6 rounded border border-border bg-background px-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <input
                type="text"
                value={p.label}
                onChange={(e) => {
                  const next = [...patterns];
                  next[i] = { ...next[i], label: e.target.value };
                  updateValue(key, next);
                }}
                placeholder="label"
                className="flex-1 h-6 rounded border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <button
                onClick={() => updateValue(key, patterns.filter((_, j) => j !== i))}
                className="text-muted-foreground/50 hover:text-destructive transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            onClick={() => updateValue(key, [...patterns, { regex: "", label: "" }])}
            className="text-xs text-primary hover:underline"
          >
            + Add pattern
          </button>
        </div>
      );
    }

    // Default: string
    return (
      <input
        type="text"
        value={typeof val === "string" ? val : ""}
        onChange={(e) => updateValue(key, e.target.value)}
        className="w-full h-7 rounded border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <p className="text-sm font-mono font-semibold text-foreground">{policy.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{policy.description}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* Params */}
        <div className="overflow-y-auto flex-1 px-4 py-4 space-y-4">
          {Object.entries(params).map(([key, spec]) => (
            <div key={key}>
              <label className="block text-xs font-semibold text-foreground mb-1 font-mono">{key}</label>
              <p className="text-[0.65rem] text-muted-foreground mb-1.5">{spec.description}</p>
              {renderInput(key, spec)}
            </div>
          ))}
        </div>
        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <Button variant="outline" size="sm" onClick={onClose} className="h-7 text-xs">
            Cancel
          </Button>
          <Button size="sm" onClick={() => onSave(values)} className="h-7 text-xs">
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function formatParamValue(type: string, value: unknown): string {
  if (type === "string[]" || type === "pattern[]") {
    const arr = Array.isArray(value) ? value : [];
    if (arr.length === 0) return "none";
    if (type === "pattern[]") return `${arr.length} pattern${arr.length !== 1 ? "s" : ""}`;
    if (arr.length === 1) return String(arr[0]).slice(0, 24);
    return `${arr.length} values`;
  }
  if (type === "boolean") return value ? "on" : "off";
  if (value === null || value === undefined || value === "") return "—";
  return String(value).slice(0, 32);
}

function ErrorToast({
  message,
  onDismiss,
  onInstall,
  isPending,
}: {
  message: string;
  onDismiss: () => void;
  onInstall: () => void;
  isPending: boolean;
}) {
  return createPortal(
    <div
      className="fixed top-4 right-4 z-[9999] w-full max-w-sm"
      style={{ animation: "slideInFromRight 0.25s ease-out" }}
    >
      <style>{`
        @keyframes slideInFromRight {
          from { transform: translateX(calc(100% + 1rem)); opacity: 0; }
          to   { transform: translateX(0); opacity: 1; }
        }
      `}</style>
      <div className="rounded-lg border border-red-500/40 bg-red-950/95 shadow-2xl shadow-red-900/40 overflow-hidden backdrop-blur-sm">
        {/* Top accent bar */}
        <div className="h-0.5 w-full bg-gradient-to-r from-red-600 via-red-400 to-red-600" />
        <div className="p-4">
          <div className="flex items-start gap-3">
            {/* Error icon */}
            <div className="shrink-0 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 ring-2 ring-red-500/30">
              <X className="h-3 w-3 text-white" strokeWidth={3} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[0.65rem] font-bold uppercase tracking-widest text-red-400 mb-0.5">
                Error
              </p>
              <p className="text-sm text-red-100 leading-snug">{message}</p>
            </div>
            <button
              onClick={onDismiss}
              className="shrink-0 -mt-0.5 -mr-0.5 rounded p-0.5 text-red-400/60 transition-colors hover:bg-red-500/20 hover:text-red-200"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              onClick={() => { onDismiss(); onInstall(); }}
              disabled={isPending}
              className="h-7 flex-1 border-0 bg-red-500 px-3 text-xs font-semibold text-white hover:bg-red-400 disabled:opacity-50"
            >
              Install hooks
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDismiss}
              className="h-7 px-3 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-200"
            >
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PoliciesTab({ onHooksInstallChange }: { onHooksInstallChange?: (installed: boolean) => void }) {
  const [config, setConfig] = useState<HooksConfigPayload | null>(null);
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const [hooksWarning, setHooksWarning] = useState<string | null>(null);
  const [configuringPolicy, setConfiguringPolicy] = useState<PolicyInfo | null>(null);
  const [checkedClis, setCheckedClis] = useState<Set<IntegrationType>>(() => new Set());
  const cliCheckboxesInitializedRef = useRef(false);

  const reload = useCallback(async () => {
    try {
      const data = await getHooksConfigAction();
      setConfig(data);
      onHooksInstallChange?.(data.clis.some((c) => c.installed));
    } catch {
      // Non-critical
    }
  }, [onHooksInstallChange]);

  useEffect(() => { reload(); }, [reload]);

  // Sync the checkbox set with payload. On first load only, pre-check
  // detected-but-not-installed CLIs so a fresh user lands ready for one-click
  // install. After that, sync strictly to `installed` so unchecking a still-
  // detected CLI and clicking Apply doesn't re-tick the box on reload.
  useEffect(() => {
    if (!config) return;
    if (!cliCheckboxesInitializedRef.current) {
      cliCheckboxesInitializedRef.current = true;
      setCheckedClis(new Set(config.clis.filter((c) => c.installed || c.detected).map((c) => c.id)));
    } else {
      setCheckedClis(new Set(config.clis.filter((c) => c.installed).map((c) => c.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.clis]);

  const installedCliSet = useMemo(
    () => new Set((config?.clis ?? []).filter((c) => c.installed).map((c) => c.id)),
    [config?.clis],
  );

  const pendingChanges = useMemo(() => {
    const toInstall: IntegrationType[] = [];
    const toRemove: IntegrationType[] = [];
    for (const cli of config?.clis ?? []) {
      const isChecked = checkedClis.has(cli.id);
      if (isChecked && !installedCliSet.has(cli.id)) toInstall.push(cli.id);
      if (!isChecked && installedCliSet.has(cli.id)) toRemove.push(cli.id);
    }
    return { toInstall, toRemove };
  }, [config?.clis, checkedClis, installedCliSet]);

  const hasPendingChanges = pendingChanges.toInstall.length > 0 || pendingChanges.toRemove.length > 0;

  const toggleCli = (id: IntegrationType) => {
    setCheckedClis((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggle = (name: string, currentlyEnabled: boolean) => {
    if (!config) return;
    const installed = config.clis.some((c) => c.installed);
    if (!installed) {
      setHooksWarning("Policies are not installed. Install policies to continue.");
      return;
    }
    setHooksWarning(null);
    // Optimistic update
    setConfig((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        policies: prev.policies.map((p) =>
          p.name === name ? { ...p, enabled: !currentlyEnabled } : p,
        ),
        enabledPolicies: currentlyEnabled
          ? prev.enabledPolicies.filter((n) => n !== name)
          : [...prev.enabledPolicies, name],
      };
    });
    startTransition(async () => {
      try {
        await togglePolicyAction(name, !currentlyEnabled);
      } catch {
        setActionError("Failed to save policy change.");
        reload();
      }
    });
  };

  const handleApply = () => {
    const { toInstall, toRemove } = pendingChanges;
    if (toInstall.length === 0 && toRemove.length === 0) return;
    startTransition(async () => {
      try {
        setActionError(null);
        if (toInstall.length > 0) await installHooksWebAction("user", toInstall);
        if (toRemove.length > 0) await removeHooksWebAction("user", toRemove);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Failed to apply changes.");
      } finally {
        // Always resync so a partial-success batch (install OK, remove failed)
        // doesn't leave the UI showing stale install state on the next click.
        await reload();
      }
    });
  };

  const handleReinstall = () => {
    // Reinstall acts on the intersection of checked × installed. Detected-but-
    // not-installed CLIs are pre-checked as a one-click install hint, so a raw
    // Array.from(checkedClis) would silently install brand-new CLIs from the
    // Reinstall button. Use Apply for first-time installs.
    const targets = Array.from(installedCliSet).filter((id) => checkedClis.has(id));
    if (targets.length === 0) return;
    startTransition(async () => {
      try {
        setActionError(null);
        await installHooksWebAction("user", targets);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Failed to reinstall.");
      } finally {
        await reload();
      }
    });
  };

  const handleSaveParams = (params: Record<string, unknown>) => {
    if (!configuringPolicy) return;
    const policyName = configuringPolicy.name;
    setConfiguringPolicy(null);
    startTransition(async () => {
      try {
        setActionError(null);
        await updatePolicyParamsAction(policyName, params);
        await reload();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Failed to save configuration.");
      }
    });
  };

  if (!config) {
    return (
      <div className="flex items-center justify-center py-16">
        <span className="text-sm text-muted-foreground">Loading\u2026</span>
      </div>
    );
  }

  const installed = config.clis.some((c) => c.installed);
  const installedCount = installedCliSet.size;
  const checkedCount = checkedClis.size;

  // Group policies by category
  const categories = Array.from(new Set(config.policies.map((p) => p.category)));

  return (
    <>
    {configuringPolicy && (
      <PolicyConfigModal
        policy={configuringPolicy}
        onClose={() => setConfiguringPolicy(null)}
        onSave={handleSaveParams}
      />
    )}
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      {/* CLI control panel — header */}
      <div className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-border/60 bg-muted/10">
        <div className="flex items-center gap-3 min-w-0 flex-wrap">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full transition-shadow ${
                installed
                  ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                  : "bg-muted-foreground/40"
              }`}
              aria-hidden
            />
            <span className="text-[0.65rem] uppercase tracking-[0.2em] font-mono text-foreground/90">
              Integrations
            </span>
          </div>
          <span className="text-[0.65rem] font-mono text-muted-foreground/40">·</span>
          <div className="text-[0.65rem] uppercase tracking-[0.2em] font-mono text-muted-foreground">
            <span className="text-foreground tabular-nums">
              {installedCount.toString().padStart(2, "0")}
            </span>
            <span className="opacity-50"> / 0{config.clis.length} active</span>
          </div>
          {hasPendingChanges && (
            <>
              <span className="text-[0.65rem] font-mono text-muted-foreground/40">·</span>
              <span className="inline-flex items-center gap-1.5 text-[0.65rem] uppercase tracking-[0.2em] font-mono text-pink-400">
                <span className="h-1 w-1 rounded-full bg-pink-400 animate-pulse" />
                {pendingChanges.toInstall.length + pendingChanges.toRemove.length} pending
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReinstall}
            disabled={isPending || checkedCount === 0}
            className="text-xs h-7 px-3 font-mono"
          >
            Reinstall
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleApply}
            disabled={isPending || !hasPendingChanges}
            className="text-xs h-7 px-3 font-mono"
          >
            Apply changes
          </Button>
        </div>
      </div>

      {/* CLI rows */}
      <div className="divide-y divide-border/30 border-b border-border/60">
        {config.clis.map((cli, i) => {
          const isChecked = checkedClis.has(cli.id);
          const isInstalled = installedCliSet.has(cli.id);
          const willChange = isChecked !== isInstalled;
          const badge = getCliBadgeClasses(cli.id);
          const accentClass =
            badge.split(" ").find((c) => c.startsWith("text-")) ?? "text-foreground";

          return (
            <label
              key={cli.id}
              className={`group relative flex items-center gap-3 pl-6 pr-5 py-3 cursor-pointer transition-colors hover:bg-muted/15 ${
                willChange ? "bg-pink-500/[0.04]" : ""
              }`}
            >
              {/* Brand-colored accent rail */}
              <div
                className={`absolute left-0 top-0 bottom-0 w-[3px] ${accentClass} bg-current transition-opacity ${
                  isChecked ? "opacity-100" : "opacity-25 group-hover:opacity-60"
                }`}
                aria-hidden
              />

              {/* Slot index — 01..07 */}
              <div className="font-mono text-[0.65rem] text-muted-foreground/40 tabular-nums w-6 select-none">
                {(i + 1).toString().padStart(2, "0")}
              </div>

              {/* Custom checkbox */}
              <div className="relative shrink-0">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleCli(cli.id)}
                  disabled={isPending}
                  className="sr-only peer"
                  aria-label={`Toggle ${cli.label}`}
                />
                <div
                  className={`h-[18px] w-[18px] rounded-sm border transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 ${
                    isChecked
                      ? "bg-primary border-primary"
                      : "bg-background/50 border-border group-hover:border-foreground/40"
                  }`}
                >
                  {isChecked && (
                    <svg
                      viewBox="0 0 18 18"
                      className="h-full w-full text-primary-foreground"
                      fill="none"
                      aria-hidden
                    >
                      <path
                        d="M4 9.5L7.5 12.5L14 6"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </div>
              </div>

              {/* CLI label */}
              <div className="min-w-[150px] shrink-0">
                <div className="text-sm font-medium text-foreground">{cli.label}</div>
              </div>

              {/* Status + diff pills */}
              <div className="flex items-center gap-1.5 shrink-0">
                {isInstalled ? (
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[0.6rem] uppercase tracking-[0.15em] font-mono border ${badge}`}
                  >
                    <span className="h-1 w-1 rounded-full bg-current shadow-[0_0_4px_currentColor]" />
                    Active
                  </span>
                ) : cli.detected ? (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[0.6rem] uppercase tracking-[0.15em] font-mono border border-border/60 text-muted-foreground/80 bg-muted/20">
                    <span className="h-1 w-1 rounded-full bg-current opacity-60" />
                    Detected
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[0.6rem] uppercase tracking-[0.15em] font-mono border border-border/30 text-muted-foreground/40">
                    Inactive
                  </span>
                )}
                {willChange && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[0.6rem] uppercase tracking-[0.15em] font-mono border border-pink-500/40 text-pink-400 bg-pink-500/10">
                    {isChecked ? "+ install" : "− remove"}
                  </span>
                )}
              </div>

              {/* Settings path — right-aligned, monospace */}
              <div
                className="ml-auto hidden lg:block text-[0.7rem] font-mono text-muted-foreground/50 truncate max-w-[420px] group-hover:text-muted-foreground/80 transition-colors"
                title={cli.settingsPath}
              >
                {cli.settingsPath}
              </div>
            </label>
          );
        })}
      </div>

      {/* Policy summary */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 bg-muted/5">
        <span className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{config.enabledPolicies.length}</span>
          {" / "}
          {config.policies.length + (config.customPolicies?.length ?? 0)}{" "}
          policies enabled
        </span>
        {installed && (
          <span className="text-[0.65rem] text-muted-foreground/60">
            · shared across {installedCount} active CLI{installedCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {actionError && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-400">
          {actionError}
        </div>
      )}
      {hooksWarning && (
        <ErrorToast
          message={hooksWarning}
          onDismiss={() => setHooksWarning(null)}
          onInstall={handleApply}
          isPending={isPending}
        />
      )}

      {/* Policy categories */}
      {categories.map((category) => {
        const policies = config.policies.filter((p) => p.category === category);
        const enabledCount = policies.filter((p) => p.enabled).length;
        return (
          <div key={category}>
            {/* Category header */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-muted/20 border-b border-border/50">
              <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
                {category}
              </span>
              <span className="text-[0.7rem] text-muted-foreground">
                {enabledCount} / {policies.length} enabled
              </span>
            </div>
            {/* Policy rows */}
            {policies.map((policy) => (
              <div
                key={policy.name}
                className="flex items-start gap-3 px-4 py-3 border-b border-border/20 hover:bg-muted/20 transition-colors"
              >
                <div className="mt-0.5 shrink-0">
                  <PolicyToggle
                    enabled={policy.enabled}
                    onChange={() => handleToggle(policy.name, policy.enabled)}
                    disabled={isPending}
                  />
                </div>
                <div className="flex items-center gap-1.5 min-w-0 w-56 shrink-0 mt-0.5">
                  <span className="text-xs font-mono text-foreground truncate">{policy.name}</span>
                  {policy.beta && (
                    <span className="shrink-0 text-[0.6rem] px-1 py-0.5 rounded border bg-violet-500/10 text-violet-400 border-violet-500/20">
                      beta
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-muted-foreground leading-relaxed">
                    {policy.description}
                  </span>
                  {policy.eventScope && (
                    <span className="block text-[0.65rem] text-muted-foreground/40 font-mono mt-0.5 hidden lg:block">
                      {policy.eventScope}
                    </span>
                  )}
                  {policy.params && Object.keys(policy.params).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {Object.entries(policy.params).map(([key, spec]) => {
                        const currentVal = policy.currentParams?.[key] ?? spec.default;
                        const isCustomized = JSON.stringify(currentVal) !== JSON.stringify(spec.default);
                        return (
                          <span
                            key={key}
                            className={`inline-flex items-center gap-1 font-mono text-[0.6rem] px-1.5 py-0.5 rounded border ${
                              isCustomized
                                ? "bg-primary/10 text-primary/70 border-primary/20"
                                : "bg-muted/40 text-muted-foreground/55 border-border/40"
                            }`}
                          >
                            <span className="opacity-70">{key}:</span>
                            <span>{formatParamValue(spec.type, currentVal)}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                {policy.params && Object.keys(policy.params).length > 0 && (
                  <button
                    className="shrink-0 mt-0.5 text-muted-foreground hover:text-primary transition-colors"
                    onClick={() => setConfiguringPolicy(policy)}
                    title="Edit parameters"
                  >
                    <Settings className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        );
      })}

      {/* Custom policies section */}
      {config.customPoliciesPath && (
        <div>
          {/* Section header — matches category header style */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-muted/20 border-b border-border/50">
            <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Custom Policies
            </span>
            <span className="text-[0.7rem] text-muted-foreground">
              {config.customPolicies?.length ?? 0} detected
            </span>
          </div>
          {/* File path row */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border/20">
            <Code className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-mono text-muted-foreground truncate">{config.customPoliciesPath}</span>
          </div>
          {/* Reconfigure notice */}
          <div className="flex items-start gap-2 px-4 py-2.5 border-b border-border/20 bg-muted/10">
            <Shield className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0 mt-0.5" />
            <p className="text-[0.7rem] text-muted-foreground/70 leading-relaxed">
              Custom policies are always active. To add, remove, or reorder them, edit the JS file above.
            </p>
          </div>
          {/* Rich policy rows — mirrors built-in layout without toggle */}
          {config.customPolicies?.map((policy) => (
            <div
              key={policy.name}
              className="flex items-start gap-3 px-4 py-3 border-b border-border/20 hover:bg-muted/20 transition-colors"
            >
              {/* Invisible spacer matching PolicyToggle dimensions (h-4 w-7) */}
              <div className="h-4 w-7 shrink-0 mt-0.5" />
              <div className="flex items-center gap-1.5 min-w-0 w-56 shrink-0 mt-0.5">
                <span className="text-xs font-mono text-foreground truncate">{policy.name}</span>
              </div>
              <div className="flex-1 min-w-0">
                {policy.description && (
                  <span className="text-xs text-muted-foreground leading-relaxed">
                    {policy.description}
                  </span>
                )}
                {policy.eventScope && (
                  <span className="block text-[0.65rem] text-muted-foreground/40 font-mono mt-0.5 hidden lg:block">
                    {policy.eventScope}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
    </>
  );
}

// -- Tab Bar --

function TabBar({
  activeTab,
  onChange,
}: {
  activeTab: "activity" | "policies";
  onChange: (tab: "activity" | "policies") => void;
}) {
  const tabs: { id: "activity" | "policies"; label: string }[] = [
    { id: "activity", label: "Activity" },
    { id: "policies", label: "Configure" },
  ];
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-muted/30 p-0.5 mb-5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-3 py-1.5 text-xs font-medium rounded transition-all ${
            activeTab === tab.id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// -- Main Component --

export default function HooksClient({ initialTab = "activity" }: { initialTab?: "activity" | "policies" }) {
  const url = useUrlParams();
  const [activeTab, setActiveTab] = useState<"activity" | "policies">(initialTab);
  const [hooksInstalled, setHooksInstalled] = useState<boolean | undefined>(undefined);
  const [policyCounts, setPolicyCounts] = useState<{ enabled: number; total: number } | null>(null);

  useEffect(() => {
    getHooksConfigAction()
      .then((cfg) => {
        setHooksInstalled(cfg.clis.some((c) => c.installed));
        setPolicyCounts({
          enabled: cfg.enabledPolicies.length,
          total: cfg.policies.length + (cfg.customPolicies?.length ?? 0),
        });
      })
      .catch(() => setHooksInstalled(undefined));
  }, []);

  const handleTabChange = (tab: "activity" | "policies") => {
    setActiveTab(tab);
    url.setAll({ tab: tab === "activity" ? undefined : tab });
  };

  return (
    <div className="min-h-screen bg-background px-4 py-6 sm:px-6 lg:px-10">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/projects"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Link>
        <div className="flex items-center gap-3 mt-3">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            Policies
          </h1>
          {activeTab === "activity" && (
            <span className="relative flex h-2.5 w-2.5 mt-0.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {activeTab === "activity" ? (
            <>
              Policy evaluations for Claude
              {policyCounts && (
                <span className="text-muted-foreground/60">
                  {" · "}enabled policies{" "}
                  <span className="font-mono text-foreground/70">{policyCounts.enabled}/{policyCounts.total}</span>
                </span>
              )}
              <span className="block text-xs text-muted-foreground/50 mt-0.5">
                To configure policies,{" "}
                <button
                  className="underline underline-offset-2 hover:text-foreground transition-colors"
                  onClick={() => handleTabChange("policies")}
                >
                  go here
                </button>
              </span>
            </>
          ) : (
            "Configure Policies"
          )}
        </p>
      </div>

      <TabBar activeTab={activeTab} onChange={handleTabChange} />

      {activeTab === "activity" ? (
        <ActivityTab hooksInstalled={hooksInstalled} onSwitchTab={handleTabChange} />
      ) : (
        <PoliciesTab onHooksInstallChange={setHooksInstalled} />
      )}
    </div>
  );
}
