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
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="bg-card border border-border rounded-lg p-4">
        <div className="flex flex-col gap-4">
          {/* Preset Filters + CLI filter */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">Filter by:</span>
            {FILTER_PRESETS.map((preset) => (
              <button
                key={preset.value}
                onClick={() => handlePresetChange(preset.value)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  filterPreset === preset.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {preset.label}
              </button>
            ))}

            <span className="ml-2 text-sm font-medium text-foreground">CLI:</span>
            <select
              aria-label="Filter by CLI"
              value={filterCli}
              onChange={(e) => {
                const v = e.target.value;
                setFilterCli(v === "" || isKnownCli(v) ? v : "");
              }}
              className="px-2 py-1.5 text-sm bg-input border border-border rounded-md text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            >
              <option value="">All CLIs</option>
              {KNOWN_CLI_IDS.map((id) => (
                <option key={id} value={id}>
                  {getCliLabel(id)}
                </option>
              ))}
            </select>
          </div>

          {/* Keyword Search */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium text-foreground">Search Keywords:</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* Keyword Input */}
              <div className="flex items-center gap-2">
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
                  placeholder="Enter keyword and press Enter"
                  className="px-3 py-2 text-sm bg-input border border-border rounded-md text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all hover:border-primary/50 w-[250px]"
                  aria-label="Add keyword"
                />
                <button
                  onClick={() => addKeyword(keywordInput)}
                  className="px-3 py-2 text-sm bg-muted text-muted-foreground hover:bg-muted/80 rounded-md transition-colors"
                  aria-label="Add keyword"
                >
                  Add
                </button>
              </div>
              {/* Keyword Chips */}
              {keywords.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {keywords.map((keyword, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-muted text-muted-foreground rounded-md text-sm"
                    >
                      <span>{keyword}</span>
                      <button
                        onClick={() => removeKeyword(index)}
                        className="hover:text-foreground transition-colors p-0.5 rounded hover:bg-muted/80"
                        aria-label={`Remove keyword ${keyword}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={clearKeywords}
                    className="px-2 py-1.5 text-xs bg-muted text-muted-foreground hover:bg-muted/80 rounded-md transition-colors"
                    aria-label="Clear all keywords"
                  >
                    Clear all
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Custom Date Range */}
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-sm font-medium text-foreground">Custom Range:</span>
            <div className="flex items-center gap-2">
              <DatePickerInput
                id="date-from"
                value={dateRange.from}
                onChange={(v) => handleDateRangeChange("from", v)}
                aria-label="Filter from date"
              />
              <span className="text-muted-foreground">to</span>
              <DatePickerInput
                id="date-to"
                value={dateRange.to}
                onChange={(v) => handleDateRangeChange("to", v)}
                aria-label="Filter to date"
              />
            </div>
            {(filterPreset !== "all" || dateRange.from !== null || dateRange.to !== null || keywords.length > 0 || filterCli !== "") && (
              <button
                onClick={clearFilters}
                className="px-3 py-2 text-sm bg-muted text-muted-foreground hover:bg-muted/80 rounded-md transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {/* Results Count */}
          <div className="text-sm text-muted-foreground">
            {filteredFolders.length === 0 ? (
              <>No projects found</>
            ) : (
              <>
                Showing {startIndex + 1}-{endIndex} of {filteredFolders.length} projects
                {filteredFolders.length !== normalizedFolders.length && (
                  <span className="ml-1">
                    (filtered from {normalizedFolders.length} total)
                  </span>
                )}
                {keywords.length > 0 && (
                  <span className="ml-1">
                    with {keywords.length} keyword{keywords.length !== 1 ? "s" : ""}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Project Table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th scope="col" className="px-4 py-3 text-left text-sm font-semibold text-foreground w-12">
                  <span className="sr-only">Icon</span>
                </th>
                <th scope="col" className="px-4 py-3 text-left text-sm font-semibold text-foreground max-w-md">
                  Agent Root
                </th>
                <th scope="col" className="px-4 py-3 text-left text-sm font-semibold text-foreground hidden md:table-cell">
                  Path
                </th>
                <th scope="col" className="px-4 py-3 text-left text-sm font-semibold text-foreground">
                  Last Modified
                </th>
              </tr>
            </thead>
            <tbody>
              {paginatedFolders.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    No projects found matching the selected filter.
                  </td>
                </tr>
              ) : (
                paginatedFolders.map((folder) => (
                  <tr
                    key={folder.name}
                    className="border-b border-border hover:bg-muted/50 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Folder className="w-5 h-5 text-primary" />
                    </td>
                    <td className="px-4 py-3 max-w-md">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/project/${encodeURIComponent(folder.name)}`}
                          className="font-semibold text-foreground hover:text-primary transition-colors break-words break-all inline-block max-w-full"
                        >
                          {decodeFolderName(folder.name)}
                        </Link>
                        {folder.cli.map((c) => (
                          <CliBadge key={c} cli={c} />
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground hidden md:table-cell truncate max-w-md">
                      {folder.path}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
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
        </div>

        {/* Pagination Controls */}
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
