/**
 * Self Reports: the tool an agent calls to say it is stuck.
 *
 * Offer the tool to a model, and when the model calls it, record a
 * `self_report` event in the current session and answer `Recorded.`:
 *
 *     const tools = [failproofai.openaiTool()];               // or anthropicTool()
 *     ...
 *     const answer = failproofai.handleToolCall(call.name, call.arguments, { toolCallId: call.id });
 *     if (answer !== null) { ...send `answer` back as the tool result... }
 *
 * The categories, and an optional paragraph of guidance appended to the
 * description, come from `$FAILPROOFAI_HOME/self-report.json` — the one local
 * settings file the daemon (Cloud-managed machines) or `failproofai
 * self-report enable` writes. When the file is missing, unreadable or says the
 * feature is off, the default categories are used: a developer who put the
 * tool in their own agent's tool list has already decided to offer it.
 *
 * Framework tools built on these live on the adapter subpaths:
 * `selfReportTool()` from `@failproofai/sdk/ai`, `/langchain`, `/mastra` and
 * `/llamaindex`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { logger } from "./logger.js";
import { failproofaiHome } from "./resolver.js";
import { runtime } from "./runtime.js";
import {
  SELF_REPORT_RESULT,
  buildSelfReportSpec,
  defaultCategories,
  isSelfReportTool,
  normalizeSelfReportArgs,
  toAnthropicTool,
  toOpenAITool,
  validCategories,
  validGuidance,
  type AnthropicTool,
  type OpenAITool,
  type SelfReportCategory,
  type SelfReportSpec,
} from "./self-report-spec.js";
import type { SelfReportOptions } from "./events.js";

export {
  DEFAULT_SELF_REPORT_CATEGORIES,
  SELF_REPORT_RESULT,
  SELF_REPORT_TOOL_NAME,
  describeSelfReport,
  isSelfReportTool,
} from "./self-report-spec.js";
export type { AnthropicTool, OpenAITool, SelfReportCategory, SelfReportSpec } from "./self-report-spec.js";
export type { SelfReportOptions } from "./events.js";

/** What `self-report.json` says, with the defaults filled in. */
export interface SelfReportSettings {
  /** False when the file is missing, unreadable, or says so. */
  enabled: boolean;
  /** Who wrote the file: `"cloud"` (the daemon) or `"local"` (the CLI); null without one. */
  source: "cloud" | "local" | null;
  /** Never empty: the configured list when enabled and valid, else the defaults. */
  categories: SelfReportCategory[];
  guidance: string | null;
  /** The local MCP server, when the file names one. */
  mcp: { port: number; url: string } | null;
  updatedAt: string | null;
}

/** `$FAILPROOFAI_HOME/self-report.json` (default `~/.failproofai/self-report.json`). */
export function selfReportSettingsPath(): string {
  return join(failproofaiHome(), "self-report.json");
}

/**
 * Read the settings file. Never throws; read fresh on every call, so a change
 * the daemon makes reaches the next spec without a restart.
 */
export function selfReportSettings(): SelfReportSettings {
  const disabled: SelfReportSettings = {
    enabled: false,
    source: null,
    categories: defaultCategories(),
    guidance: null,
    mcp: null,
    updatedAt: null,
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(selfReportSettingsPath(), "utf8")) as unknown;
  } catch {
    return disabled;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return disabled;
  const file = raw as Record<string, unknown>;
  const source = file.source === "cloud" || file.source === "local" ? file.source : null;
  const mcp = mcpOf(file.mcp);
  const updatedAt = typeof file.updatedAt === "string" ? file.updatedAt : null;
  if (file.enabled !== true) return { ...disabled, source, mcp, updatedAt };
  return {
    enabled: true,
    source,
    categories: validCategories(file.categories) ?? defaultCategories(),
    guidance: validGuidance(file.guidance),
    mcp,
    updatedAt,
  };
}

function mcpOf(value: unknown): { port: number; url: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const { port, url } = value as Record<string, unknown>;
  if (typeof port !== "number" || !Number.isInteger(port) || typeof url !== "string") return null;
  return { port, url };
}

/** `{ name, description, inputSchema }` for the report tool, from the current settings. */
export function selfReportSpec(): SelfReportSpec {
  const settings = selfReportSettings();
  return buildSelfReportSpec(settings.categories, settings.guidance);
}

/** The report tool as an OpenAI Chat Completions `tools[]` entry. */
export function openaiTool(): OpenAITool {
  return toOpenAITool(selfReportSpec());
}

/** The report tool as an Anthropic Messages `tools[]` entry. */
export function anthropicTool(): AnthropicTool {
  return toAnthropicTool(selfReportSpec());
}

/**
 * Record a report: a `self_report` event with `source: "sdk"`, in the current
 * session and agent. See `event.selfReport` for how the session is found when
 * none is bound — this never throws for want of one.
 */
export function selfReport(category: string, detail?: string | null, fields: SelfReportOptions = {}): void {
  runtime.event.selfReport(category, detail, fields);
}

/**
 * Handle a model's tool call if it is the report tool.
 *
 * Returns `"Recorded."` after recording it, or null when `name` is some other
 * tool, so it chains: `handleToolCall(name, args) ?? runMyTool(name, args)`.
 * `args` may be the parsed object or the JSON string a provider sent.
 *
 * Never throws: whatever goes wrong while recording is logged and the call
 * still answers `Recorded.`, because a report must never break the loop it
 * reports on.
 */
export function handleToolCall(name: string, args: unknown, fields: SelfReportOptions = {}): string | null {
  if (!isSelfReportTool(name)) return null;
  recordToolCall(args, fields);
  return SELF_REPORT_RESULT;
}

/** The shared body of every report tool: record, swallow, answer. */
export function recordToolCall(args: unknown, fields: SelfReportOptions = {}): string {
  try {
    const { category, detail } = normalizeSelfReportArgs(args);
    runtime.event.selfReport(category, detail, fields);
  } catch (error) {
    logger.warn(`self report was not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
  return SELF_REPORT_RESULT;
}
