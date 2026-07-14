/**
 * Output renderers for `failproofai audit`:
 *   • formatText      — ANSI table to stdout (GTM-oriented "moment of truth")
 *   • formatMarkdown  — shareable sectioned report written to a file
 *   • formatJson      — machine-readable
 *
 * The text renderer is the user's first impression of the audit. It leads
 * with a headline-box, splits findings into "already protected" vs "slipping
 * through" so the conversion ask is obvious, and ends with a copy-pasteable
 * install command + report path + star link.
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

/** Honor https://no-color.org / NO_COLOR=1 and FORCE_COLOR=0 by stripping all
 *  ANSI sequences from the final output. Detected once per renderer call. */
function noColorEnabled(): boolean {
  if (process.env.NO_COLOR && process.env.NO_COLOR !== "") return true;
  if (process.env.FORCE_COLOR === "0") return true;
  return false;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

/** Human-readable "time ago" — "30m ago", "2h ago", "3d ago", "2w ago".
 *  Returns "just now" for <1 minute. */
function formatTimeAgo(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 8) return `${w}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/** Width of the headline box and section dividers. Adapts to narrow terminals
 *  down to a 60-char floor. */
function getWidth(): number {
  const cols = process.stdout.columns ?? 80;
  return Math.max(60, Math.min(78, cols));
}

/** Box-drawing helpers using unicode round-corner glyphs. */
function topBorder(w: number): string { return `╭${"─".repeat(w - 2)}╮`; }
function bottomBorder(w: number): string { return `╰${"─".repeat(w - 2)}╯`; }
function boxLine(text: string, w: number): string {
  const inner = w - 4; // 2 chars of border + 1 char padding each side
  const visible = stripAnsi(text);
  const pad = Math.max(0, inner - visible.length);
  return `│ ${text}${" ".repeat(pad)} │`;
}
function divider(w: number): string { return "─".repeat(w); }

/** Short, qualified policy slug — `failproofai/foo` → `foo` for display. */
function shortName(name: string): string {
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/** Sum hits across an AuditCount[] subset. */
function sumHits(rows: AuditCount[]): number {
  return rows.reduce((acc, r) => acc + r.hits, 0);
}

/** Render one row in the table-of-findings form:
 *      31× Tried to read files outside your project
 *           Stops the agent from peeking at neighboring repos…
 *           Last seen 2h ago · 6 projects
 *           › Already enforced — failproofai is blocking these in real time.
 *           Example: grep -n …
 */
function renderRow(r: AuditCount, opts: { showExamples?: boolean }): string[] {
  const out: string[] = [];
  const sev = r.severity;
  const titleColor =
    sev === "deny" ? ANSI.red
      : sev === "warn" ? ANSI.red
        : sev === "info" || sev === "instruct" ? ANSI.yellow
          : ANSI.cyan;
  const countStr = String(r.hits).padStart(4);
  out.push(`  ${titleColor}${ANSI.bold}${countStr}×${ANSI.reset}  ${r.displayTitle}`);
  if (r.impact) {
    out.push(`        ${ANSI.dim}${r.impact}${ANSI.reset}`);
  }
  out.push(
    `        ${ANSI.dim}Last seen ${formatTimeAgo(r.lastSeen)} · ${r.projects} project${r.projects === 1 ? "" : "s"}${ANSI.reset}`,
  );
  if (opts.showExamples && r.examples[0]) {
    out.push(`        ${ANSI.dim}Example: ${r.examples[0].example}${ANSI.reset}`);
  }
  if (r.installHint) {
    const arrowColor = r.enabledInConfig ? ANSI.green : ANSI.cyan;
    out.push(`        ${arrowColor}›${ANSI.reset} ${r.installHint}`);
  }
  out.push("");
  return out;
}

export function formatText(result: AuditResult, opts: RunAuditOptions = {}): string {
  const w = getWidth();
  const limit = opts.limit ?? 20;
  const showExamples = !!opts.showExamples;

  // Split rows by enforcement state.
  const enabledRows = result.results.filter((r) => r.source === "builtin" && r.enabledInConfig);
  const unenabledBuiltinRows = result.results.filter((r) => r.source === "builtin" && !r.enabledInConfig);
  const detectorRows = result.results.filter((r) => r.source === "audit-detector");
  // "Slipping through" combines unenabled-builtins + audit-detectors, ranked by hits.
  const slippingRows = [...unenabledBuiltinRows, ...detectorRows].sort((a, b) => b.hits - a.hits);

  const totalProtected = sumHits(enabledRows);
  const totalSlipping = sumHits(slippingRows);
  const totalHits = totalProtected + totalSlipping;
  const sinceLabel = result.scope.since ? `the last ${result.scope.since}` : "all time";

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────
  lines.push(`${ANSI.cyan}🛡  failproofai audit${ANSI.reset} ${ANSI.dim}[beta]${ANSI.reset}  ·  ${sinceLabel}`);
  lines.push(
    `   ${ANSI.dim}${result.transcripts.scanned} sessions · ${result.totals.projectsWithHits} project${result.totals.projectsWithHits === 1 ? "" : "s"} with hits · scanned in ${(result.transcripts.durationMs / 1000).toFixed(1)}s${ANSI.reset}`,
  );
  lines.push("");

  // ── Headline box ────────────────────────────────────────────────
  if (totalHits === 0) {
    lines.push(topBorder(w));
    lines.push(boxLine(`${ANSI.green}🎉 Clean run!${ANSI.reset}  Nothing matched your policies in this window.`, w));
    lines.push(bottomBorder(w));
    lines.push("");
    return noColorEnabled() ? stripAnsi(lines.join("\n")) : lines.join("\n");
  }
  lines.push(topBorder(w));
  lines.push(boxLine(
    `${ANSI.bold}Your agent did ${totalHits} wasteful or risky things in ${sinceLabel}.${ANSI.reset}`,
    w,
  ));
  if (totalSlipping > 0) {
    lines.push(boxLine(
      `${totalSlipping} of those would've been caught if more policies were on.`,
      w,
    ));
  }
  lines.push(bottomBorder(w));
  lines.push("");

  // ── Section: ALREADY PROTECTED ──────────────────────────────────
  if (enabledRows.length > 0) {
    lines.push(
      `${ANSI.green}✓ ALREADY PROTECTED${ANSI.reset}  ${ANSI.dim}(${totalProtected} action${totalProtected === 1 ? "" : "s"} stopped by your current policies)${ANSI.reset}`,
    );
    lines.push("");
    for (const row of enabledRows.slice(0, limit)) {
      lines.push(...renderRow(row, { showExamples }));
    }
    if (enabledRows.length > limit) {
      lines.push(`  ${ANSI.dim}… ${enabledRows.length - limit} more (use --limit ${enabledRows.length})${ANSI.reset}`);
      lines.push("");
    }
  }

  // ── Section: SLIPPING THROUGH ───────────────────────────────────
  if (slippingRows.length > 0) {
    lines.push(
      `${ANSI.yellow}○ SLIPPING THROUGH${ANSI.reset}  ${ANSI.dim}(${totalSlipping} action${totalSlipping === 1 ? "" : "s"} caught by audit, not blocked in real time)${ANSI.reset}`,
    );
    lines.push("");
    for (const row of slippingRows.slice(0, limit)) {
      lines.push(...renderRow(row, { showExamples }));
    }
    if (slippingRows.length > limit) {
      lines.push(`  ${ANSI.dim}… ${slippingRows.length - limit} more (use --limit ${slippingRows.length})${ANSI.reset}`);
      lines.push("");
    }
  }

  // ── Footer / NEXT step ──────────────────────────────────────────
  lines.push(divider(w));
  if (unenabledBuiltinRows.length > 0) {
    const installNames = unenabledBuiltinRows.map((r) => shortName(r.name));
    lines.push(
      `${ANSI.bold}NEXT${ANSI.reset}  Enable the ${installNames.length} unenabled real-time polic${installNames.length === 1 ? "y" : "ies"} in one command:`,
    );
    lines.push("");
    lines.push(`      ${ANSI.cyan}failproofai policies --install ${installNames.join(" ")}${ANSI.reset}`);
    lines.push("");
  } else if (slippingRows.length > 0) {
    lines.push(
      `${ANSI.bold}NEXT${ANSI.reset}  Everything blockable is already enabled. Audit-only findings will show up in your next ${ANSI.cyan}failproofai audit${ANSI.reset}.`,
    );
    lines.push("");
  } else {
    lines.push(`${ANSI.bold}NEXT${ANSI.reset}  ${ANSI.green}You have the relevant policies enabled. failproofai is blocking these in real time.${ANSI.reset}`);
    lines.push("");
  }

  // Mirror the actual --report path so the printed footer matches what was
  // (or will be) written. Suppressed entirely with --no-report.
  if (!opts.noReport) {
    const reportPath = opts.reportPath ?? "./failproofai-audit.md";
    lines.push(`      📄 Shareable report:  ${ANSI.cyan}${reportPath}${ANSI.reset}`);
  }
  lines.push(`      ⭐ Star us:           ${ANSI.cyan}https://github.com/FailproofAI/failproofai${ANSI.reset}`);
  lines.push("");

  return noColorEnabled() ? stripAnsi(lines.join("\n")) : lines.join("\n");
}

export function formatJson(result: AuditResult): string {
  return JSON.stringify(result, null, 2);
}

/** Escape characters that would break a markdown table row. Pipes split
 *  columns; backslashes escape the next char; leading newlines end the row. */
function escapeTableCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function escapeBackticks(s: string): string {
  return s.replace(/`/g, "\\`");
}

export function formatMarkdown(result: AuditResult): string {
  const out: string[] = [];

  const enabledRows = result.results.filter((r) => r.source === "builtin" && r.enabledInConfig);
  const unenabledBuiltinRows = result.results.filter((r) => r.source === "builtin" && !r.enabledInConfig);
  const detectorRows = result.results.filter((r) => r.source === "audit-detector");
  const slippingRows = [...unenabledBuiltinRows, ...detectorRows].sort((a, b) => b.hits - a.hits);

  const totalProtected = sumHits(enabledRows);
  const totalSlipping = sumHits(slippingRows);
  const totalHits = totalProtected + totalSlipping;
  const sinceLabel = result.scope.since ? `last ${result.scope.since}` : "all time";

  out.push(`# Agent behavior audit · ${sinceLabel}`);
  out.push("");
  out.push("> _Generated by `failproofai audit` (**beta**) — flags and output may change between releases. Going live shortly._");
  out.push("");
  out.push(`*Generated ${result.scannedAt} — scanned ${result.transcripts.scanned} sessions across ${result.totals.projectsWithHits} project(s) in ${(result.transcripts.durationMs / 1000).toFixed(1)}s.*`);
  out.push("");

  // TL;DR — readable to someone who doesn't know failproofai.
  out.push("## TL;DR");
  out.push("");
  if (totalHits === 0) {
    out.push("Clean run — the AI coding agent didn't do anything `failproofai` catches in this window.");
  } else {
    out.push(
      `Over ${result.transcripts.scanned} sessions, my AI coding agent did **${totalHits} things \`failproofai\` would have stopped**: ` +
      `${totalProtected} were already blocked in real time by my current config; ` +
      `**${totalSlipping} slipped through** (would've been caught if more policies were on).`,
    );
  }
  out.push("");
  out.push("> [failproofai](https://github.com/FailproofAI/failproofai) is a hook-based policy engine for Claude Code, Codex, Copilot, Cursor, OpenCode, and Pi. The `audit` command replays past agent sessions through every builtin policy to surface patterns that were (or could've been) stopped.");
  out.push("");

  if (totalHits === 0) return out.join("\n");

  // What was blocked
  if (enabledRows.length > 0) {
    out.push(`## ✓ Already protected (${totalProtected} action${totalProtected === 1 ? "" : "s"} stopped)`);
    out.push("");
    out.push("These are real-time policies you have on — `failproofai` blocked the agent before each action took effect.");
    out.push("");
    out.push("| Issue | Hits | Projects | Last seen | Policy |");
    out.push("|---|---:|---:|---|---|");
    for (const r of enabledRows) {
      out.push(
        `| ${escapeTableCell(r.displayTitle)} | ${r.hits} | ${r.projects} | ${formatTimeAgo(r.lastSeen)} | \`${escapeTableCell(shortName(r.name))}\` |`,
      );
    }
    out.push("");
  }

  // What's slipping through
  if (slippingRows.length > 0) {
    out.push(`## ○ Slipping through (${totalSlipping} action${totalSlipping === 1 ? "" : "s"} caught by audit, not yet blocked)`);
    out.push("");
    out.push("Patterns the audit detected but real-time enforcement isn't on for. The CTA column shows how to fix each.");
    out.push("");
    out.push("| Issue | Hits | Projects | Last seen | Fix |");
    out.push("|---|---:|---:|---|---|");
    for (const r of slippingRows) {
      const fix = r.source === "builtin"
        ? `\`failproofai policies --install ${shortName(r.name)}\``
        : "_audit-only_";
      out.push(
        `| ${escapeTableCell(r.displayTitle)} | ${r.hits} | ${r.projects} | ${formatTimeAgo(r.lastSeen)} | ${fix} |`,
      );
    }
    out.push("");

    if (unenabledBuiltinRows.length > 0) {
      out.push(`### Enable everything in one command`);
      out.push("");
      out.push("```bash");
      out.push(`failproofai policies --install ${unenabledBuiltinRows.map((r) => shortName(r.name)).join(" ")}`);
      out.push("```");
      out.push("");
    }
  }

  // Examples appendix (only if non-trivial)
  const rowsWithExamples = [...enabledRows, ...slippingRows].filter((r) => r.examples.length > 0);
  if (rowsWithExamples.length > 0) {
    out.push("## Examples");
    out.push("");
    for (const r of rowsWithExamples) {
      out.push(`### ${escapeBackticks(r.displayTitle)} (\`${escapeBackticks(shortName(r.name))}\`)`);
      out.push("");
      if (r.impact) {
        out.push(`> ${r.impact}`);
        out.push("");
      }
      for (const e of r.examples) {
        out.push(`- \`${escapeBackticks(e.example)}\` _(${e.cwd || "?"}, ${formatTimeAgo(e.timestamp)})_`);
      }
      out.push("");
    }
  }

  out.push("---");
  out.push("");
  out.push("⭐ Star failproofai on GitHub: <https://github.com/FailproofAI/failproofai>");
  out.push("");
  return out.join("\n");
}
