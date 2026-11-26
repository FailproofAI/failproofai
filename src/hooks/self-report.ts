/**
 * Self Reports: the `report` tool FailproofAI puts into every agent, so an
 * agent that is stuck can say so.
 *
 * This module is the one TypeScript home for everything the feature shares:
 * the default categories, the tool's description and input schema (identical
 * text in every implementation — the daemon, the stdio server and both SDKs
 * build the same string), the recognised tool names, and the effective
 * settings file `self-report.json` every reader goes through.
 *
 * Every top-level name here starts with `selfReport` / `SELF_REPORT`, on
 * purpose. The CLI ships as one scope-hoisted bundle, and a new top-level name
 * that matches a local inside a builtin policy makes the bundler rename that
 * local — which changes the function source the audit cache keys on (see the
 * note on `screenKit` in tui.ts). The short names the brief asks for
 * (`describe`, `inputSchema`, `DEFAULT_CATEGORIES`) are export aliases only.
 *
 * Only the name/description/settings-read half is used on the hook path, and it
 * imports nothing beyond `node:fs` and the home resolver. The local-config and
 * Cloud-enrolment helpers load their modules lazily.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { failproofaiHome } from "./fp-home";

export {
  SELF_REPORT_SERVER_NAME,
  SELF_REPORT_TOOL_NAME,
  SELF_REPORT_MCP_TOOL_NAME,
  SELF_REPORT_SDK_TOOL_NAME,
  SELF_REPORT_DETAIL_MAX,
  SELF_REPORT_DEFAULT_PORT,
  SELF_REPORT_SERVER_RECORDS,
  isSelfReportToolName,
  isSelfReportCursorCall,
} from "./self-report-names";
import { SELF_REPORT_DETAIL_MAX, SELF_REPORT_DEFAULT_PORT } from "./self-report-names";

// ── Categories (contract §2) ────────────────────────────────────────────────

export interface SelfReportCategory {
  name: string;
  description: string;
}

const SELF_REPORT_DEFAULT_CATEGORIES: readonly SelfReportCategory[] = Object.freeze([
  { name: "looping", description: "You keep repeating the same or circular steps without making progress." },
  {
    name: "cannot_do_request",
    description:
      "The user asked for something you cannot do here: a missing capability, tool or permission, or it is only possible by cheating.",
  },
  {
    name: "invalid_tool_or_credential",
    description: "A tool, MCP server, plugin, API key or token you need is broken, invalid, expired or rejected.",
  },
  {
    name: "missing_context",
    description:
      "Information or access you need is missing and you cannot get it yourself. Not for normal clarifying questions.",
  },
  {
    name: "repeated_tool_failure",
    description:
      "A command or tool failed on several distinct attempts and is blocking you. A single error is not enough.",
  },
  {
    name: "task_failure",
    description: "You genuinely tried and could not complete the task. Not for refusals or policy blocks.",
  },
].map((c) => Object.freeze(c)));

export { SELF_REPORT_DEFAULT_CATEGORIES, SELF_REPORT_DEFAULT_CATEGORIES as DEFAULT_CATEGORIES };

const SELF_REPORT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SELF_REPORT_MAX_CATEGORIES = 32;
const SELF_REPORT_MAX_DESCRIPTION = 500;
export const SELF_REPORT_MAX_GUIDANCE = 2000;

export type SelfReportValidation<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Check an org's or a user's category list against contract §2: 1–32 entries,
 * names `^[a-z][a-z0-9_]{0,63}$` and unique, descriptions 1–500 characters.
 * Descriptions are trimmed; nothing else is rewritten.
 */
export function validateSelfReportCategories(input: unknown): SelfReportValidation<SelfReportCategory[]> {
  if (!Array.isArray(input)) return { ok: false, error: "categories must be a list of {name, description}" };
  if (input.length < 1 || input.length > SELF_REPORT_MAX_CATEGORIES) {
    return { ok: false, error: `categories must have between 1 and ${SELF_REPORT_MAX_CATEGORIES} entries` };
  }
  const seen = new Set<string>();
  const out: SelfReportCategory[] = [];
  for (const [i, raw] of input.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `category ${i + 1} must be an object with name and description` };
    }
    const { name, description } = raw as Record<string, unknown>;
    if (typeof name !== "string" || !SELF_REPORT_NAME_RE.test(name)) {
      return {
        ok: false,
        error: `category ${i + 1}: name must match ^[a-z][a-z0-9_]{0,63}$ (lowercase, digits, underscores)`,
      };
    }
    if (seen.has(name)) return { ok: false, error: `category "${name}" is listed twice` };
    seen.add(name);
    const desc = typeof description === "string" ? description.trim() : "";
    if (desc.length < 1 || desc.length > SELF_REPORT_MAX_DESCRIPTION) {
      return { ok: false, error: `category "${name}": description must be 1-${SELF_REPORT_MAX_DESCRIPTION} characters` };
    }
    out.push({ name, description: desc });
  }
  return { ok: true, value: out };
}

/** Guidance: a string of at most 2000 characters, or nothing. Blank reads as nothing. */
export function validateSelfReportGuidance(input: unknown): SelfReportValidation<string | null> {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, error: "guidance must be text" };
  const trimmed = input.trim();
  if (trimmed.length > SELF_REPORT_MAX_GUIDANCE) {
    return { ok: false, error: `guidance must be at most ${SELF_REPORT_MAX_GUIDANCE} characters` };
  }
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

// ── The tool (contract §3) ──────────────────────────────────────────────────

const SELF_REPORT_DESCRIPTION_HEAD =
  "Report to FailproofAI that you are stuck. Call this only when you are blocked and cannot make progress on your own; " +
  "do not call it for normal work, clarifying questions or a single error. One call per distinct problem.\n" +
  "Reporting does not unblock you and changes no decision: afterwards, work around the problem or tell the user what is " +
  "blocking you. There is no need to mention this report to the user.";

/** The tool description, built from the categories and the optional guidance. */
function describeSelfReportTool(
  categories: readonly SelfReportCategory[],
  guidance?: string | null,
): string {
  const lines = categories.map((c) => `- ${c.name}: ${c.description}`);
  const body = `${SELF_REPORT_DESCRIPTION_HEAD}\n\nCategories:\n${lines.join("\n")}`;
  return guidance ? `${body}\n\n${guidance}` : body;
}

/** The tool's JSON input schema. */
function selfReportInputSchema(categories: readonly SelfReportCategory[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      category: { type: "string", enum: categories.map((c) => c.name) },
      detail: { type: "string", description: "One factual sentence: what is blocking you." },
    },
    required: ["category", "detail"],
    additionalProperties: false,
  };
}

export { describeSelfReportTool, describeSelfReportTool as describe, selfReportInputSchema, selfReportInputSchema as inputSchema };

/**
 * The MCP server's `instructions` (the initialize result), the same text in the
 * daemon (crates/fpai-collect/src/self_report.rs `instructions`).
 *
 * Claude Code defers MCP tools behind tool search, so the model never reads the
 * tool's description until it already decided to look for one; a server's
 * instructions go into the system prompt. One short paragraph naming the
 * categories, then the org's guidance when set.
 */
function selfReportInstructions(
  categories: readonly SelfReportCategory[],
  guidance?: string | null,
): string {
  const names = categories.map((c) => c.name).join(", ");
  const body =
    `FailproofAI records when an agent is stuck. If you get stuck (${names}), call this server's ` +
    "`report` tool once with the matching category and one factual sentence. It does not unblock you: " +
    "continue, or tell the user what is blocking you. There is no need to mention the report to the user.";
  return guidance ? `${body}\n\n${guidance}` : body;
}

export { selfReportInstructions };

/** Exactly what the tool returns (contract §3). */
export const SELF_REPORT_RESULT_TEXT = "Recorded.";

/**
 * A call's arguments as they are recorded: an unknown category is kept as-is
 * (never rejected), a missing or empty detail is `""`, detail is cut to 2000
 * characters. A category is cut to the same bound so a hostile argument cannot
 * grow every activity row without limit.
 *
 * Accepts the arguments object itself, or a hook's `tool_input` that wraps it
 * (`{arguments: {...}}`, `{args: {...}}`, or either as a JSON string), because
 * agents differ in how they hand an MCP call to their hooks.
 */
export function selfReportArgs(input: unknown): { category: string; detail: string } {
  let args: unknown = input;
  if (typeof args === "string") args = selfReportParseJson(args);
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const rec = args as Record<string, unknown>;
    if (rec.category === undefined && rec.detail === undefined) {
      for (const key of ["arguments", "args", "input", "params"]) {
        let inner = rec[key];
        if (typeof inner === "string") inner = selfReportParseJson(inner);
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          args = inner;
          break;
        }
      }
    }
  }
  const rec = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const cat = rec.category;
  const det = rec.detail;
  const category = cat === undefined || cat === null ? "" : typeof cat === "string" ? cat : JSON.stringify(cat);
  const detail = det === undefined || det === null ? "" : typeof det === "string" ? det : JSON.stringify(det);
  return {
    category: category.slice(0, SELF_REPORT_DETAIL_MAX),
    detail: detail.slice(0, SELF_REPORT_DETAIL_MAX),
  };
}

function selfReportParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── The effective settings file (contract §4) ───────────────────────────────

export interface SelfReportEffective {
  version: 1;
  enabled: boolean;
  source: "cloud" | "local";
  categories: SelfReportCategory[];
  guidance: string | null;
  mcp: { port: number; url: string };
  updatedAt: string;
}

/** `$FAILPROOFAI_HOME/self-report.json`. */
export function selfReportSettingsFile(): string {
  return join(failproofaiHome(), "self-report.json");
}

/** The port a local writer records: `FAILPROOFAI_SELF_REPORT_PORT`, else 4319. */
export function selfReportPort(): number {
  const raw = process.env.FAILPROOFAI_SELF_REPORT_PORT?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0 && n < 65536) return n;
  }
  return SELF_REPORT_DEFAULT_PORT;
}

export function selfReportMcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/**
 * Read `self-report.json`. Missing, unparsable or not version 1 reads as
 * `null`, which every caller treats as disabled. A file that says enabled but
 * whose category list is unusable falls back to the defaults (contract §4:
 * "never empty when enabled; defaults if none given").
 */
export function readEffectiveSelfReport(path: string = selfReportSettingsFile()): SelfReportEffective | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.version !== 1) return null;
  const cats = validateSelfReportCategories(rec.categories);
  const guidance = validateSelfReportGuidance(rec.guidance);
  const mcp = rec.mcp && typeof rec.mcp === "object" && !Array.isArray(rec.mcp) ? (rec.mcp as Record<string, unknown>) : {};
  const port =
    typeof mcp.port === "number" && Number.isInteger(mcp.port) && mcp.port > 0 && mcp.port < 65536
      ? mcp.port
      : SELF_REPORT_DEFAULT_PORT;
  return {
    version: 1,
    enabled: rec.enabled === true,
    source: rec.source === "cloud" ? "cloud" : "local",
    categories: cats.ok ? cats.value : SELF_REPORT_DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    guidance: guidance.ok ? guidance.value : null,
    mcp: { port, url: typeof mcp.url === "string" && mcp.url ? mcp.url : selfReportMcpUrl(port) },
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : "",
  };
}

/** The settings only when the feature is on; `null` otherwise. */
export function readEnabledSelfReport(path?: string): SelfReportEffective | null {
  const s = readEffectiveSelfReport(path);
  return s && s.enabled ? s : null;
}

/**
 * Write `self-report.json` atomically (tmp + fsync + rename), mode 0644. The
 * non-Cloud writer; on a Cloud-managed machine the daemon owns this file.
 * The mode is set explicitly rather than left to the umask: the SDKs read this
 * file from agent processes that may run as another account.
 */
export function writeEffectiveSelfReport(
  input: { enabled: boolean; categories?: readonly SelfReportCategory[] | null; guidance?: string | null },
  path: string = selfReportSettingsFile(),
): SelfReportEffective {
  const port = selfReportPort();
  const value: SelfReportEffective = {
    version: 1,
    enabled: input.enabled,
    source: "local",
    categories: (input.categories && input.categories.length > 0 ? input.categories : SELF_REPORT_DEFAULT_CATEGORIES).map(
      (c) => ({ name: c.name, description: c.description }),
    ),
    guidance: input.guidance ?? null,
    mcp: { port, url: selfReportMcpUrl(port) },
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.self-report.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(tmp, "wx", 0o644);
    try {
      writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o644);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return value;
}

// ── Local config: `selfReport` in config.json (contract §4) ─────────────────

export interface SelfReportLocalConfig {
  enabled: boolean;
  categories?: SelfReportCategory[];
  guidance?: string;
}

/** The `selfReport` block of `~/.failproofai/config.json`, or `null` if absent. */
export async function readLocalSelfReportConfig(): Promise<SelfReportLocalConfig | null> {
  const { readConfigRaw } = await import("./fp-config");
  const block = readConfigRaw().raw.selfReport;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const rec = block as Record<string, unknown>;
  const cats = rec.categories === undefined || rec.categories === null ? null : validateSelfReportCategories(rec.categories);
  const guidance = validateSelfReportGuidance(rec.guidance);
  return {
    enabled: rec.enabled === true,
    ...(cats && cats.ok ? { categories: cats.value } : {}),
    ...(guidance.ok && guidance.value ? { guidance: guidance.value } : {}),
  };
}

/**
 * Replace the `selfReport` block, keeping every other key in the file as it
 * was (the same read-raw-then-write the OTEL settings use, so a key this build
 * does not know survives).
 */
export async function writeLocalSelfReportConfig(block: SelfReportLocalConfig): Promise<void> {
  const [{ readConfigRaw }, { writeConfigFileAtomic }, { configFile }] = await Promise.all([
    import("./fp-config"),
    import("./safe-config-write"),
    import("./fp-home"),
  ]);
  const raw = { ...readConfigRaw().raw };
  raw.selfReport = {
    enabled: block.enabled,
    ...(block.categories ? { categories: block.categories } : {}),
    ...(block.guidance ? { guidance: block.guidance } : {}),
  };
  writeConfigFileAtomic(configFile(), `${JSON.stringify(raw, null, 2)}\n`, { backup: false });
}

// ── Cloud enrolment ─────────────────────────────────────────────────────────

/**
 * Whether the daemon takes this machine's settings from FailproofAI Cloud, in
 * which case Cloud owns `self-report.json` and local enable/disable refuse.
 * Mirrors the daemon's `Enrolment::resolve` (cloud_client.rs): the
 * `FAILPROOFAI_CLOUD_URL` environment, or a stored cloud credential on a
 * machine not switched back to open source (`mode.kind == "oss"`).
 */
export async function selfReportCloudManaged(): Promise<boolean> {
  if (process.env.FAILPROOFAI_CLOUD_URL?.trim()) return true;
  try {
    const { readCloudCredentials } = await import("./cloud-enrollment");
    if (!readCloudCredentials()) return false;
  } catch {
    return false;
  }
  try {
    const { configFile } = await import("./fp-home");
    const raw: unknown = JSON.parse(readFileSync(configFile(), "utf8"));
    const mode = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { mode?: unknown }).mode : undefined;
    if (mode && typeof mode === "object" && !Array.isArray(mode) && (mode as { kind?: unknown }).kind === "oss") {
      return false;
    }
  } catch {
    // Missing or unreadable config does not veto an enrolled machine (the daemon's rule).
  }
  return true;
}
