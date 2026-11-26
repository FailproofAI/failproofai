/**
 * Self Reports: the tool an agent calls to say it is stuck — the pure half.
 *
 * Everything here is data and string-building, and the module imports NOTHING,
 * so the Edge build (`src/edge/`) can hand out the very same spec, the same
 * OpenAI / Anthropic tool definitions and the same name check as the Node
 * build. The Node half (`self-report.ts`) adds the two things that need a
 * filesystem: reading `$FAILPROOFAI_HOME/self-report.json`, and recording.
 *
 * The tool name, the description text, the input schema and the result text
 * are one contract across every implementation — the MCP servers (daemon and
 * `failproofai mcp`), the Python SDK and this one — so a model sees the same
 * tool whichever way it was offered. Change them in all of them or none.
 */

/** The tool's name when an SDK offers it to a model. */
export const SELF_REPORT_TOOL_NAME = "failproofai_report";

/** What the tool answers, always. Reporting never fails the agent's call. */
export const SELF_REPORT_RESULT = "Recorded.";

/** `detail` beyond this many characters is cut. */
export const SELF_REPORT_DETAIL_LIMIT = 2000;

export interface SelfReportCategory {
  name: string;
  description: string;
}

/**
 * The categories used when nothing configures any. An organisation's own list
 * REPLACES these entirely; it is never merged with them.
 */
export const DEFAULT_SELF_REPORT_CATEGORIES: ReadonlyArray<Readonly<SelfReportCategory>> = Object.freeze([
  Object.freeze({
    name: "looping",
    description: "You keep repeating the same or circular steps without making progress.",
  }),
  Object.freeze({
    name: "cannot_do_request",
    description:
      "The user asked for something you cannot do here: a missing capability, tool or permission, or it is only possible by cheating.",
  }),
  Object.freeze({
    name: "invalid_tool_or_credential",
    description: "A tool, MCP server, plugin, API key or token you need is broken, invalid, expired or rejected.",
  }),
  Object.freeze({
    name: "missing_context",
    description:
      "Information or access you need is missing and you cannot get it yourself. Not for normal clarifying questions.",
  }),
  Object.freeze({
    name: "repeated_tool_failure",
    description:
      "A command or tool failed on several distinct attempts and is blocking you. A single error is not enough.",
  }),
  Object.freeze({
    name: "task_failure",
    description: "You genuinely tried and could not complete the task. Not for refusals or policy blocks.",
  }),
]);

/** The bounds a configured list must keep to; outside them the defaults are used. */
export const CATEGORY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_CATEGORIES = 32;
export const MAX_CATEGORY_DESCRIPTION = 500;
export const MAX_GUIDANCE = 2000;

const PREAMBLE =
  "Report to FailproofAI that you are stuck. Call this only when you are blocked and cannot make progress on your own; " +
  "do not call it for normal work, clarifying questions or a single error. One call per distinct problem.\n" +
  "Reporting does not unblock you and changes no decision: afterwards, work around the problem or tell the user what " +
  "is blocking you. There is no need to mention this report to the user.";

/** The tool description, built the same way in every implementation. */
export function describeSelfReport(
  categories: ReadonlyArray<SelfReportCategory>,
  guidance?: string | null,
): string {
  const lines = categories.map((category) => `- ${category.name}: ${category.description}`);
  let text = `${PREAMBLE}\n\nCategories:\n${lines.join("\n")}`;
  if (typeof guidance === "string" && guidance !== "") text += `\n\n${guidance}`;
  return text;
}

/** A JSON Schema object, as the tool definitions carry it. */
export type JsonSchemaObject = Record<string, unknown>;

/** The input schema: `category` from the list, and a one-sentence `detail`. */
export function selfReportInputSchema(categories: ReadonlyArray<SelfReportCategory>): JsonSchemaObject {
  return {
    type: "object",
    properties: {
      category: { type: "string", enum: categories.map((category) => category.name) },
      detail: { type: "string", description: "One factual sentence: what is blocking you." },
    },
    required: ["category", "detail"],
    additionalProperties: false,
  };
}

export interface SelfReportSpec {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

export function buildSelfReportSpec(
  categories: ReadonlyArray<SelfReportCategory>,
  guidance?: string | null,
): SelfReportSpec {
  return {
    name: SELF_REPORT_TOOL_NAME,
    description: describeSelfReport(categories, guidance),
    inputSchema: selfReportInputSchema(categories),
  };
}

/** The OpenAI Chat Completions `tools[]` entry. */
export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchemaObject };
}

export function toOpenAITool(spec: SelfReportSpec): OpenAITool {
  return {
    type: "function",
    function: { name: spec.name, description: spec.description, parameters: spec.inputSchema },
  };
}

/** The Anthropic Messages `tools[]` entry. */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonSchemaObject;
}

export function toAnthropicTool(spec: SelfReportSpec): AnthropicTool {
  return { name: spec.name, description: spec.description, input_schema: spec.inputSchema };
}

/**
 * Every spelling an agent gives the report tool (case-insensitive, exact):
 * `failproofai_report` (the SDKs, OpenCode), `mcp__failproofai__report`
 * (Claude Code, Codex, Pi, Factory, Devin), `failproofai___report` (Factory's
 * matcher form), `mcp_failproofai_report` (Hermes, Antigravity),
 * `failproofai__report` (OpenClaw, Goose), and other server-qualified forms.
 *
 * Mirrors `isSelfReportToolName` in the CLI's `src/hooks/self-report-names.ts`;
 * this package cannot import that, so both are tested against the same golden
 * list (`test-fixtures/self-report/tool-names.golden.txt` in the repo).
 */
export const SELF_REPORT_TOOL_SPELLINGS: ReadonlyArray<string> = Object.freeze([
  "mcp__failproofai__report",
  "failproofai___report",
  "failproofai__report",
  "failproofai_report",
  "failproofai.report",
  "failproofai/report",
  "failproofai:report",
  "mcp_failproofai_report",
  "mcp__failproofai_report",
  "mcp:failproofai:report",
  "mcp:failproofai/report",
]);

const SPELLINGS = new Set(SELF_REPORT_TOOL_SPELLINGS);

/**
 * Whether a tool is the report tool. `server` is for hosts that name an MCP
 * tool and its server separately (Cursor's `tool_name` + `mcp_server_name`):
 * a bare `report` matches only when the server is `failproofai`.
 */
export function isSelfReportTool(name: unknown, server?: unknown): boolean {
  if (typeof name !== "string") return false;
  const lower = name.toLowerCase();
  if (SPELLINGS.has(lower)) return true;
  return (
    typeof server === "string" && server.toLowerCase() === "failproofai" && (lower === "report" || lower === "mcp:report")
  );
}

/**
 * The call's arguments as the event records them.
 *
 * Never rejects: a model that names an unknown category is still recorded
 * under that name, a missing or empty argument falls back to its first
 * non-empty alias (`SELF_REPORT_ARG_ALIASES`) else `""`, and arguments that
 * arrive as the JSON string a provider sent (OpenAI's `function.arguments`)
 * are parsed first. Anything unreadable becomes the empty strings — the call
 * itself always answers `Recorded.`.
 */
export function normalizeSelfReportArgs(args: unknown): { category: string; detail: string } {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = {};
    }
  }
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    category: firstText(record, "category", SELF_REPORT_ARG_ALIASES.category),
    detail: clipDetail(firstText(record, "detail", SELF_REPORT_ARG_ALIASES.detail)),
  };
}

/**
 * Other names a model uses for an argument when it calls the tool without
 * loading its schema (seen live: `summary` and `sentence` for `detail`). The
 * first non-empty one is used when the real argument is missing or empty;
 * unknown keys are ignored. The same list as the CLI and the daemon:
 * test-fixtures/self-report/arg-aliases.json.
 */
export const SELF_REPORT_ARG_ALIASES = Object.freeze({
  category: Object.freeze(["type", "kind"]),
  detail: Object.freeze(["summary", "sentence", "message", "description", "reason", "text", "details"]),
});

function firstText(record: Record<string, unknown>, key: string, aliases: readonly string[]): string {
  for (const name of [key, ...aliases]) {
    const text = asText(record[name]);
    if (text) return text;
  }
  return "";
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** `detail` cut to `SELF_REPORT_DETAIL_LIMIT`, never through a surrogate pair. */
export function clipDetail(detail: string): string {
  if (detail.length <= SELF_REPORT_DETAIL_LIMIT) return detail;
  let cut = detail.slice(0, SELF_REPORT_DETAIL_LIMIT);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * A configured category list, or null when it is not one the contract allows
 * (1–32 entries, names `^[a-z][a-z0-9_]{0,63}$` and unique, descriptions
 * 1–500 characters). Null means "use the defaults" — a list that is half
 * valid is not trimmed into a different list the organisation never wrote.
 */
export function validCategories(value: unknown): SelfReportCategory[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CATEGORIES) return null;
  const seen = new Set<string>();
  const out: SelfReportCategory[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { name, description } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !CATEGORY_NAME_PATTERN.test(name) || seen.has(name)) return null;
    if (typeof description !== "string" || description.length === 0 || description.length > MAX_CATEGORY_DESCRIPTION) {
      return null;
    }
    seen.add(name);
    out.push({ name, description });
  }
  return out;
}

/** Guidance as configured, or null when absent, empty, not a string or too long. */
export function validGuidance(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_GUIDANCE) return null;
  return value;
}

export function defaultCategories(): SelfReportCategory[] {
  return DEFAULT_SELF_REPORT_CATEGORIES.map((category) => ({ ...category }));
}
