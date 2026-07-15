/**
 * Sessions List — displays session log files for a project with date
 * preset / custom-range filtering, session ID search, and pagination.
 *
 * Chrome matches the calm aesthetic on /audit: sharp 1px borders, dim
 * small-caps labels, mono throughout, pink-outlined active filter chip.
 */
"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { SessionFile } from "@/lib/projects";
import { formatDate } from "@/lib/format-date";
import {
  FILTER_PRESETS,
  ITEMS_PER_PAGE,
  filterByDate,
  rehydrateDates,
} from "@/lib/date-filters";
import { useFilterState } from "@/lib/use-filter-state";
import { useUrlParams } from "@/lib/use-url-params";
import {
  presetToParam, paramToPreset,
  dateRangeToParams, paramsToDateRange,
  pageToParam, paramToPage,
} from "@/lib/url-filter-serializers";
import { File, Search } from "lucide-react";
import Link from "next/link";
import PaginationControls from "./pagination-controls";
import DatePickerInput from "./date-picker-input";
import { CopyButton } from "./copy-button";
import { CliBadge } from "./cli-badge";


interface SessionsListProps {
  files: SessionFile[];
  projectName: string;
}

function filterBySessionId(files: SessionFile[], query: string): SessionFile[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return files;
  return files.filter((f) => f.sessionId?.toLowerCase().includes(trimmed));
}

export default function SessionsList({ files, projectName }: SessionsListProps) {
  const url = useUrlParams();
  const mountedRef = useRef(false);

  // Read initial state from URL
  const [sessionIdFilter, setSessionIdFilter] = useState(() => url.get("sid") ?? "");

  const {
    filterPreset, dateRange, currentPage, setCurrentPage,
    handlePresetChange, handleDateRangeChange, clearFilters: clearDateFilters,
  } = useFilterState([sessionIdFilter], {
    filterPreset: paramToPreset(url.get("preset")),
    dateRange: paramsToDateRange(url.get("from"), url.get("to")),
    currentPage: paramToPage(url.get("page")),
  });

  // Write state changes back to URL
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    url.setAll({
      preset: presetToParam(filterPreset),
      ...dateRangeToParams(dateRange),
      sid: sessionIdFilter || undefined,
      page: pageToParam(currentPage),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterPreset, dateRange, sessionIdFilter, currentPage]);

  const clearFilters = () => {
    clearDateFilters();
    setSessionIdFilter("");
  };

  const normalizedFiles = useMemo(() => rehydrateDates(files), [files]);

  const filteredFiles = useMemo(() => {
    const byDate = filterByDate(normalizedFiles, filterPreset, dateRange);
    const byId = filterBySessionId(byDate, sessionIdFilter);
    return byId.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  }, [normalizedFiles, sessionIdFilter, filterPreset, dateRange]);

  const totalPages = Math.max(1, Math.ceil(filteredFiles.length / ITEMS_PER_PAGE));
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages, setCurrentPage]);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, filteredFiles.length);
  const paginatedFiles = filteredFiles.slice(startIndex, endIndex);

  const hasActiveFilters =
    filterPreset !== "all" || dateRange.from !== null || dateRange.to !== null || sessionIdFilter !== "";

  return (
    <div className="sessions-list">
      {/* Filters */}
      <div className="sessions-filter-bar">
        {/* Preset Filters */}
        <div className="sessions-filter-row">
          <span className="sessions-filter-label">filter by</span>
          {FILTER_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => handlePresetChange(preset.value)}
              className={`sessions-chip${filterPreset === preset.value ? " on" : ""}`}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {/* Custom Date Range */}
        <div className="sessions-filter-row">
          <span className="sessions-filter-label">range</span>
          <DatePickerInput id="date-from" value={dateRange.from} onChange={(v) => handleDateRangeChange("from", v)} aria-label="Filter from date" />
          <span className="sessions-range-sep">to</span>
          <DatePickerInput id="date-to" value={dateRange.to} onChange={(v) => handleDateRangeChange("to", v)} aria-label="Filter to date" />
        </div>

        {/* Session ID Search */}
        <div className="sessions-filter-row">
          <span className="sessions-filter-label">
            <Search className="sessions-filter-icon" aria-hidden="true" />
            session id
          </span>
          <input
            type="text"
            value={sessionIdFilter}
            onChange={(e) => setSessionIdFilter(e.target.value)}
            placeholder="paste a session uuid"
            className="sessions-input"
            aria-label="Filter by session ID"
          />
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="sessions-chip"
              style={{ marginLeft: "auto" }}
            >
              clear
            </button>
          )}
        </div>

        {/* Results Count */}
        <div className="sessions-results-count">
          {filteredFiles.length === 0 ? (
            <>{"// no sessions found"}</>
          ) : (
            <>
              {"// showing"} {startIndex + 1}–{endIndex} of {filteredFiles.length} sessions
              {filteredFiles.length !== normalizedFiles.length && (
                <span> · filtered from {normalizedFiles.length}</span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Sessions Table */}
      <div className="sessions-table-wrap">
        <table className="sessions-table">
          <thead>
            <tr>
              <th scope="col" className="sessions-th sessions-th-icon">
                <span className="sr-only">Icon</span>
              </th>
              <th scope="col" className="sessions-th">session id</th>
              <th scope="col" className="sessions-th">modified</th>
            </tr>
          </thead>
          <tbody>
            {paginatedFiles.length === 0 ? (
              <tr>
                <td colSpan={3} className="sessions-td sessions-empty">
                  {"// no sessions match the filter."}
                </td>
              </tr>
            ) : (
              paginatedFiles.map((file) => (
                <tr key={file.path} className="sessions-row">
                  <td className="sessions-td sessions-td-icon">
                    <File className="sessions-file-icon" aria-hidden="true" />
                  </td>
                  <td className="sessions-td sessions-td-name">
                    {file.sessionId ? (
                      <>
                        <Link
                          href={`/project/${encodeURIComponent(projectName)}/session/${encodeURIComponent(file.sessionId)}`}
                          className="sessions-link"
                        >
                          {file.name.replace(/\.jsonl$/, "")}
                        </Link>
                        <CopyButton text={file.sessionId} />
                      </>
                    ) : (
                      <span className="sessions-link" aria-disabled="true">
                        {file.name.replace(/\.jsonl$/, "")}
                      </span>
                    )}
                    {file.cli && <CliBadge cli={file.cli} />}
                    {(file.userId || file.channelId) && (
                      <div
                        style={{
                          fontSize: "0.7rem",
                          opacity: 0.6,
                          marginTop: "0.15rem",
                          display: "flex",
                          gap: "0.6rem",
                          flexWrap: "wrap",
                        }}
                      >
                        {file.userId && <span title="Gateway user">user {file.userId}</span>}
                        {file.channelId && (
                          <span title="Channel">
                            {file.channelType ?? "channel"} {file.channelId}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="sessions-td sessions-td-date">
                    {file.lastModifiedFormatted || formatDate(file.lastModified)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {filteredFiles.length > 0 && (
          <PaginationControls currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
        )}
      </div>
    </div>
  );
}
