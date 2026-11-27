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
 * `text` cut to `max` Unicode code points, the unit the daemon
 * (`truncate_chars`) and the Python SDK count in, so all of them keep the same
 * prefix. Never cuts through a surrogate pair, and a lone surrogate already in
 * the input becomes U+FFFD: either one would be written as an unpaired `\ud8xx`
 * escape, which the Rust collector rejects together with the whole activity
 * row (its hook event too). test-fixtures/self-report/truncation.golden.json
 * holds the cases every implementation is tested against.
 */
export function selfReportClip(text: string, max: number = SELF_REPORT_DETAIL_MAX): string {
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (n === max) break;
    const code = ch.charCodeAt(0);
    out += ch.length === 1 && code >= 0xd800 && code <= 0xdfff ? "\uFFFD" : ch;
    n++;
  }
  return out;
}

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
 * - Antigravity's lazy path, `call_mcp_tool`: see
 *   `selfReportAntigravityWrappedArgs`; matched only on its server and tool.
 * - `failproofai-report` (`<server>-<tool>`) and `failproofai/report`: Copilot
 *   CLI's likely forms. Its hook spelling of an MCP tool is not documented and
 *   could not be observed without a signed-in run, so both are exempt.
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
  "failproofai-report",
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
 * Antigravity's lazy (default) MCP path: the model calls the built-in
 * `call_mcp_tool` wrapper with `{ServerName, ToolName, Arguments}` (agy 1.5's
 * own description says to judge it by ServerName + ToolName). Returns the
 * wrapped call's arguments when, and only when, the wrapper names server
 * `failproofai` and tool `report`; `undefined` for any other server or tool,
 * whose calls keep going through the policies.
 */
export function selfReportAntigravityWrappedArgs(toolName: unknown, toolInput: unknown): { args: unknown } | undefined {
  if (typeof toolName !== "string" || toolName.toLowerCase() !== "call_mcp_tool") return undefined;
  let input: unknown = toolInput;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const i = input as Record<string, unknown>;
  const pick = (...keys: string[]): unknown => keys.map((k) => i[k]).find((v) => v !== undefined);
  const server = pick("ServerName", "serverName", "server_name");
  const tool = pick("ToolName", "toolName", "tool_name");
  if (typeof server !== "string" || server.toLowerCase() !== SELF_REPORT_SERVER_NAME) return undefined;
  if (typeof tool !== "string") return undefined;
  const t = tool.toLowerCase();
  if (t !== SELF_REPORT_TOOL_NAME && !isSelfReportToolName(t)) return undefined;
  return { args: pick("Arguments", "arguments", "args") ?? {} };
}

/**
 * Integrations whose hooks do not see MCP tool calls, or do not see which
 * server a call is for, so the MCP server itself records a report (contract
 * §8). Claude Code and Codex are recorded by the hook. Cursor is here because
 * the hook failproofai installs (preToolUse) names an MCP call `MCP:<tool>`
 * with no server, and its MCP hook (beforeMCPExecution) is not installed.
 * Kept identical to the Rust list.
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
  "cursor",
];

