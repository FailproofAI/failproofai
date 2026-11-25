/**
 * The Self Reports tool's names (contract §1), in a module that imports
 * NOTHING. `tool-name-canonicalize.ts` needs `isSelfReportToolName` and is
 * bundled ahead of the builtin policies; a module with imports placed there
 * (self-report.ts pulls node:fs and lazily fp-config/safe-config-write) moves
 * other modules ahead of builtin-policies.ts in the scope-hoisted CLI bundle
 * and renames bindings inside the policy functions, which changes the audit
 * cache's `engineVersion` and rescans every user's history at upgrade. Every
 * name here is prefixed so it cannot collide with a local in a policy either.
 *
 * Re-exported from self-report.ts; import from there everywhere else.
 */

/** MCP server name every installer registers. */
export const SELF_REPORT_SERVER_NAME = "failproofai";
/** The MCP tool's own name. */
export const SELF_REPORT_TOOL_NAME = "report";
/** How Claude Code and Codex spell it: `mcp__<server>__<tool>`. */
export const SELF_REPORT_MCP_TOOL_NAME = "mcp__failproofai__report";
/** The SDK tool's name. */
export const SELF_REPORT_SDK_TOOL_NAME = "failproofai_report";
/** Detail is truncated to this many characters (contract §3). */
export const SELF_REPORT_DETAIL_MAX = 2000;
/** Default loopback port of the daemon's HTTP MCP server (contract §4, D5). */
export const SELF_REPORT_DEFAULT_PORT = 4319;

/**
 * Every spelling of the report tool an agent's hook can deliver. Exact matches
 * only: a prefix or substring match would let any tool whose name merely
 * contains `failproofai` and `report` past every policy, and this name is the
 * one thing that skips them all.
 *
 * Per agent (installer research, 2026-11-25; see self-report-install.ts):
 * - `mcp__failproofai__report`: Claude Code, Codex, Pi, Factory, Devin.
 * - `failproofai___report`: Factory's matcher-regex form of the same name.
 * - `mcp_failproofai_report`: Hermes, and Antigravity's eager tools.
 * - `failproofai_report`: OpenCode (and the SDK tool).
 * - `failproofai__report`: OpenClaw and Goose (`<server>__<tool>`).
 * - Cursor: see `isSelfReportCursorCall`; its preToolUse name `MCP:report`
 *   carries no server, so it is never matched by name alone.
 * - `failproofai.report`, `failproofai/report`, `failproofai:report`,
 *   `mcp__failproofai_report`, `mcp:failproofai:report`,
 *   `mcp:failproofai/report`: other server-qualified forms, kept so a
 *   spelling change in an agent cannot route a report through the policies.
 */
const SELF_REPORT_TOOL_SPELLINGS: ReadonlySet<string> = new Set([
  SELF_REPORT_MCP_TOOL_NAME,
  "failproofai___report",
  "failproofai__report",
  SELF_REPORT_SDK_TOOL_NAME,
  "failproofai.report",
  "failproofai/report",
  "failproofai:report",
  "mcp_failproofai_report",
  "mcp__failproofai_report",
  "mcp:failproofai:report",
  "mcp:failproofai/report",
]);

/** True for the report tool under any agent's spelling of it (contract §1). */
export function isSelfReportToolName(name: unknown): boolean {
  return typeof name === "string" && SELF_REPORT_TOOL_SPELLINGS.has(name.toLowerCase());
}

/**
 * Cursor's MCP hook (`beforeMCPExecution`) names the tool bare (`report`) and
 * the server separately, as `mcp_server_name` (its key in mcp.json). Only that
 * pair identifies our tool: a bare `report`, or preToolUse's `MCP:report`
 * without a server name, could be any server's tool and is NOT matched.
 */
export function isSelfReportCursorCall(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  const server = p.mcp_server_name;
  if (typeof server !== "string" || server.toLowerCase() !== SELF_REPORT_SERVER_NAME) return false;
  const tool = typeof p.tool_name === "string" ? p.tool_name.toLowerCase() : "";
  return tool === SELF_REPORT_TOOL_NAME || tool === `mcp:${SELF_REPORT_TOOL_NAME}` || isSelfReportToolName(tool);
}

/**
 * Integrations whose hooks do not see MCP tool calls, so the MCP server itself
 * records a report (contract §8). Claude Code, Codex and Cursor are recorded by
 * the hook. Kept identical to the Rust list.
 */
export const SELF_REPORT_SERVER_RECORDS: readonly string[] = [
  "openclaw",
  "pi",
  "devin",
  "hermes",
  "goose",
  "factory",
  "antigravity",
  "copilot",
  "opencode",
];

