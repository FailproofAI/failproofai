/**
 * Output renderers for `failproofai audit`:
 *   • formatText      — ANSI table to stdout
 *   • formatMarkdown  — sectioned report written to a file
 *   • formatJson      — machine-readable
 *
 * Examples are already truncated to AUDIT_EXAMPLE_MAX_CHARS upstream — we
 * trust that here and only do display formatting.
 */
import type { AuditCount, AuditResult, RunAuditOptions } from "./types";

const ANSI = {
  reset: "\x1B[0m",
  dim: "\x1B[2m",
  bold: "\x1B[1m",
  red: "\x1B[31m",
  yellow: "\x1B[33m",
  green: "\x1B[32m",
  cyan: "\x1B[36m",
  magenta: "\x1B[35m",
};

function colorFor(row: AuditCount): string {
  if (row.severity === "deny" || row.severity === "warn") return ANSI.red;
  if (row.severity === "instruct" || row.severity === "info") return ANSI.yellow;
  return ANSI.dim;
}

function padRight(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  if (s.length >= n) return s;
  return " ".repeat(n - s.length) + s;
}

export function formatText(result: AuditResult, opts: RunAuditOptions = {}): string {
  const limit = opts.limit ?? 20;
  const rows = result.results.slice(0, limit);
  const showExamples = !!opts.showExamples;

  const lines: string[] = [];
  const scopeCli = result.scope.cli.length === 7 ? "all CLIs" : result.scope.cli.join(", ");
  const scopeProj = result.scope.projects === "all" ? "all projects" : `${result.scope.projects.length} project(s)`;
  const scopeSince = result.scope.since ?? "all time";

  lines.push(
    `${ANSI.bold}failproofai audit${ANSI.reset}  scope: ${scopeCli} · ${scopeProj} · since: ${scopeSince}`,
  );
  lines.push("");
  lines.push(
    `Scanned ${result.transcripts.scanned} transcripts in ${(result.transcripts.durationMs / 1000).toFixed(1)}s ` +
    `(${result.transcripts.skipped} skipped, ${result.transcripts.errors} errors)`,
  );
  lines.push("");

  if (rows.length === 0) {
    lines.push(`${ANSI.dim}No hits.${ANSI.reset}`);
    lines.push("");
    return lines.join("\n");
  }

  // Column widths
  const longestName = rows.reduce((m, r) => Math.max(m, r.name.length), 16);
  const nameW = Math.min(40, longestName);
  const hitsW = Math.max(4, ...rows.map((r) => String(r.hits).length));
  const projW = Math.max(8, ...rows.map((r) => String(r.projects).length));
  const sourceW = Math.max(6, ...rows.map((r) => r.source.length));

  // Header
  const header =
    `${ANSI.bold}${padRight("POLICY / DETECTOR", nameW)}  ${padLeft("HITS", hitsW)}  ${padLeft("PROJECTS", projW)}  ${padRight("SOURCE", sourceW)}` +
    (showExamples ? "  EXAMPLE" : "") +
    ANSI.reset;
  lines.push(header);

  for (const row of rows) {
    const color = colorFor(row);
    const name = row.name.length > nameW ? row.name.slice(0, nameW - 1) + "…" : row.name;
    let line =
      `${color}${padRight(name, nameW)}${ANSI.reset}  ` +
      `${padLeft(String(row.hits), hitsW)}  ` +
      `${padLeft(String(row.projects), projW)}  ` +
      `${ANSI.dim}${padRight(row.source, sourceW)}${ANSI.reset}`;
    if (showExamples && row.examples[0]) {
      line += `  ${ANSI.dim}${row.examples[0].example}${ANSI.reset}`;
    }
    lines.push(line);
  }

  lines.push("");
  lines.push(
    `${ANSI.bold}TOTAL${ANSI.reset} hits: ${result.totals.hits} across ${result.totals.projectsWithHits} project(s).`,
  );

  if (result.results.length > limit) {
    lines.push(`${ANSI.dim}… ${result.results.length - limit} more rows omitted (use --limit ${result.results.length})${ANSI.reset}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function formatJson(result: AuditResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatMarkdown(result: AuditResult): string {
  const out: string[] = [];
  out.push(`# failproofai audit report`);
  out.push("");
  out.push(`*Generated ${result.scannedAt}*`);
  out.push("");
  const scopeCli = result.scope.cli.length === 7 ? "all CLIs" : result.scope.cli.join(", ");
  const scopeProj = result.scope.projects === "all" ? "all projects" : `${result.scope.projects.length} project(s)`;
  out.push(`**Scope:** ${scopeCli} · ${scopeProj} · since ${result.scope.since ?? "all time"}`);
  out.push("");
  out.push(
    `**Scan:** ${result.transcripts.scanned} transcripts in ${(result.transcripts.durationMs / 1000).toFixed(1)}s ` +
    `(${result.transcripts.skipped} skipped, ${result.transcripts.errors} errors)`,
  );
  out.push("");
  out.push(`**Totals:** ${result.totals.hits} hits across ${result.totals.projectsWithHits} project(s).`);
  out.push("");

  if (result.results.length === 0) {
    out.push("No hits.");
    out.push("");
    return out.join("\n");
  }

  // Group by category.
  const byCategory = new Map<string, AuditCount[]>();
  for (const r of result.results) {
    const arr = byCategory.get(r.category) ?? [];
    arr.push(r);
    byCategory.set(r.category, arr);
  }
  for (const [category, rows] of byCategory) {
    out.push(`## ${category}`);
    out.push("");
    out.push("| Policy / Detector | Hits | Projects | Source | First seen | Last seen |");
    out.push("|---|---:|---:|---|---|---|");
    for (const r of rows) {
      out.push(
        `| \`${r.name}\` | ${r.hits} | ${r.projects} | ${r.source} | ${r.firstSeen ?? "—"} | ${r.lastSeen ?? "—"} |`,
      );
    }
    out.push("");
    // Examples sub-section
    for (const r of rows) {
      if (r.examples.length === 0) continue;
      out.push(`### \`${r.name}\` — examples`);
      out.push("");
      for (const e of r.examples) {
        out.push(`- \`${escapeBackticks(e.example)}\` _(${e.cwd || "?"}, ${e.timestamp})_`);
      }
      out.push("");
    }
  }

  out.push("---");
  out.push("");
  out.push(
    "_Tip: enable any of these in real time with " +
    "`failproofai policies --install <name>...`._",
  );
  out.push("");
  return out.join("\n");
}

function escapeBackticks(s: string): string {
  return s.replace(/`/g, "\\`");
}
