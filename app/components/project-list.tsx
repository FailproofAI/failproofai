/**
 * Project List — displays all Claude Agent SDK project folders with
 * date preset / custom-range filtering, keyword search, and pagination.
 */
"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { ProjectFolder } from "@/lib/projects";
import { CliBadge } from "./cli-badge";
import { decodeFolderName } from "@/lib/paths";
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
  keywordsToParam, paramToKeywords,
  pageToParam, paramToPage,
} from "@/lib/url-filter-serializers";
import { KNOWN_CLI_IDS, getCliLabel, isKnownCli, type CliId } from "@/lib/cli-registry";
import { Folder, Search, X } from "lucide-react";
import Link from "next/link";
import PaginationControls from "./pagination-controls";
import DatePickerInput from "./date-picker-input";


interface ProjectListProps {
  folders: ProjectFolder[];
}

function DateDisplay({ date, formatted }: { date: Date; formatted?: string }) {
  return <span>{formatted || formatDate(date)}</span>;
}

// Replace `/` with `-` so users can search by filesystem path (e.g. "/home/user")
// and still match the encoded folder name (e.g. "-home-user").
function normalizeKeywordForSearch(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/\//g, "-");
}

export default function ProjectList({ folders }: ProjectListProps) {
  const url = useUrlParams();
  const mountedRef = useRef(false);

  // Read initial state from URL
  const [keywords, setKeywords] = useState<string[]>(() => paramToKeywords(url.get("q")));
  const [keywordInput, setKeywordInput] = useState("");
  const [filterCli, setFilterCli] = useState<"" | CliId>(() => {
    const v = url.get("cli");
    return isKnownCli(v) ? v : "";
  });

  const {
    filterPreset, dateRange, currentPage, setCurrentPage,
    handlePresetChange, handleDateRangeChange, clearFilters: clearDateFilters,
  } = useFilterState(keywords, {
    filterPreset: paramToPreset(url.get("preset")),
    dateRange: paramsToDateRange(url.get("from"), url.get("to")),
    currentPage: paramToPage(url.get("page")),
  });

  // Write state changes back to URL
  useEffect(() => {
    // Skip the first render (mount) to avoid writing back what we just read
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    url.setAll({
      preset: presetToParam(filterPreset),
      ...dateRangeToParams(dateRange),
      q: keywordsToParam(keywords),
      page: pageToParam(currentPage),
      cli: filterCli || undefined,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterPreset, dateRange, keywords, currentPage, filterCli]);

  const addKeyword = (keyword: string) => {
    const trimmed = keyword.trim();
    if (trimmed && !keywords.includes(trimmed)) {
      setKeywords([...keywords, trimmed]);
      setKeywordInput("");
    }
  };

  const removeKeyword = (index: number) => {
    setKeywords(keywords.filter((_, i) => i !== index));
  };

  const clearKeywords = () => {
    setKeywords([]);
    setKeywordInput("");
  };

  const clearFilters = () => {
    clearDateFilters();
    clearKeywords();
    setFilterCli("");
  };

  const normalizedFolders = useMemo(() => rehydrateDates(folders), [folders]);

  const filteredFolders = useMemo(() => {
    let filtered = filterByDate(normalizedFolders, filterPreset, dateRange);

    if (keywords.length > 0) {
      filtered = filtered.filter((folder) => {
        const folderNameLower = folder.name.toLowerCase();
        return keywords.every((keyword) => {
          const normalized = normalizeKeywordForSearch(keyword);
          return normalized.length === 0 ? true : folderNameLower.includes(normalized);
        });
      });
    }

    if (filterCli) {
      filtered = filtered.filter((folder) => folder.cli.includes(filterCli));
    }

    return filtered.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  }, [normalizedFolders, filterPreset, dateRange, keywords, filterCli]);

  const totalPages = Math.max(1, Math.ceil(filteredFolders.length / ITEMS_PER_PAGE));
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages, setCurrentPage]);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, filteredFolders.length);
  const paginatedFolders = filteredFolders.slice(startIndex, endIndex);

  return (
    <div className="project-list">
      {/* Filter Bar */}
      <div className="project-filter-bar">
        {/* Preset Filters + CLI filter */}
        <div className="project-filter-row">
          <span className="project-filter-label">filter by</span>
          {FILTER_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => handlePresetChange(preset.value)}
              className={`project-chip${filterPreset === preset.value ? " on" : ""}`}
            >
              {preset.label}
            </button>
          ))}

          <span className="project-filter-label" style={{ marginLeft: 12 }}>cli</span>
          <select
            aria-label="Filter by CLI"
            value={filterCli}
            onChange={(e) => {
              const v = e.target.value;
              setFilterCli(v === "" || isKnownCli(v) ? v : "");
            }}
            className="project-select"
          >
            <option value="">all clis</option>
            {KNOWN_CLI_IDS.map((id) => (
              <option key={id} value={id}>
                {getCliLabel(id)}
              </option>
            ))}
          </select>
        </div>

        {/* Keyword Search */}
        <div className="project-filter-row">
          <span className="project-filter-label">
            <Search className="project-filter-icon" aria-hidden="true" />
            search
          </span>
          <input
            type="text"
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addKeyword(keywordInput);
              }
            }}
            placeholder="type a keyword and press Enter"
            className="project-input"
            aria-label="Add keyword"
          />
          <button
            type="button"
            onClick={() => addKeyword(keywordInput)}
            className="project-chip"
            aria-label="Add keyword"
          >
            add
          </button>
          {keywords.length > 0 && (
            <>
              {keywords.map((keyword, index) => (
                <span key={index} className="project-keyword-chip">
                  {keyword}
                  <button
                    type="button"
                    onClick={() => removeKeyword(index)}
                    className="project-keyword-x"
                    aria-label={`Remove keyword ${keyword}`}
                  >
                    <X className="project-filter-icon" aria-hidden="true" />
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={clearKeywords}
                className="project-chip"
                aria-label="Clear all keywords"
              >
                clear all
              </button>
            </>
          )}
        </div>

        {/* Custom Date Range */}
        <div className="project-filter-row">
          <span className="project-filter-label">range</span>
          <DatePickerInput
            id="date-from"
            value={dateRange.from}
            onChange={(v) => handleDateRangeChange("from", v)}
            aria-label="Filter from date"
          />
          <span className="project-range-sep">to</span>
          <DatePickerInput
            id="date-to"
            value={dateRange.to}
            onChange={(v) => handleDateRangeChange("to", v)}
            aria-label="Filter to date"
          />
          {(filterPreset !== "all" || dateRange.from !== null || dateRange.to !== null || keywords.length > 0 || filterCli !== "") && (
            <button
              type="button"
              onClick={clearFilters}
              className="project-chip"
              style={{ marginLeft: "auto" }}
            >
              clear
            </button>
          )}
        </div>

        {/* Results Count */}
        <div className="project-results-count">
          {filteredFolders.length === 0 ? (
            <>{"// no projects found"}</>
          ) : (
            <>
              {"// showing"} {startIndex + 1}–{endIndex} of {filteredFolders.length} projects
              {filteredFolders.length !== normalizedFolders.length && (
                <span> · filtered from {normalizedFolders.length}</span>
              )}
              {keywords.length > 0 && (
                <span> · {keywords.length} keyword{keywords.length !== 1 ? "s" : ""}</span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Project Table */}
      <div className="project-table-wrap">
        <table className="project-table">
          <thead>
            <tr>
              <th scope="col" className="project-th project-th-icon">
                <span className="sr-only">Icon</span>
              </th>
              <th scope="col" className="project-th">agent root</th>
              <th scope="col" className="project-th project-th-path">path</th>
              <th scope="col" className="project-th">last modified</th>
            </tr>
          </thead>
          <tbody>
            {paginatedFolders.length === 0 ? (
              <tr>
                <td colSpan={4} className="project-td project-empty">
                  {"// no projects match the selected filter."}
                </td>
              </tr>
            ) : (
              paginatedFolders.map((folder) => (
                <tr key={folder.name} className="project-row">
                  <td className="project-td project-td-icon">
                    <Folder className="project-folder-icon" aria-hidden="true" />
                  </td>
                  <td className="project-td project-td-name">
                    <Link
                      href={`/project/${encodeURIComponent(folder.name)}`}
                      className="project-link"
                    >
                      {decodeFolderName(folder.name)}
                    </Link>
                    {folder.cli.map((c) => (
                      <CliBadge key={c} cli={c} />
                    ))}
                  </td>
                  <td className="project-td project-td-path">{folder.path}</td>
                  <td className="project-td project-td-date">
                    <DateDisplay
                      date={folder.lastModified}
                      formatted={folder.lastModifiedFormatted}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {filteredFolders.length > 0 && (
          <PaginationControls
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setCurrentPage}
          />
        )}
      </div>
    </div>
  );
}
