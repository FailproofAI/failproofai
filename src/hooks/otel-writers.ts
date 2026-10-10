/**
 * Agent-owned OTEL configuration. JSONC edits preserve comments; the TOML
 * scanner identifies tables without mistaking a multiline string for one.
 * smol-toml validates the complete document before any modification.
 */
import { parse as parseToml } from "smol-toml";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

export const OTEL_AGENTS = ["claude", "codex", "gemini", "copilot"] as const;
export type OtelAgent = typeof OTEL_AGENTS[number];
export const AGENT_LABELS: Record<OtelAgent, string> = {
  claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", copilot: "Copilot",
};
export type JsonObject = Record<string, unknown>;
export interface SettingWrite { path: string[]; value?: unknown }

export function vscodeSettingsPath(home = homedir(), platform = process.platform): string {
  if (platform === "darwin") return resolve(home, "Library/Application Support/Code/User/settings.json");
  if (platform === "win32") return resolve(process.env.APPDATA ?? resolve(home, "AppData/Roaming"), "Code/User/settings.json");
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(home, ".config"), "Code/User/settings.json");
}

export function agentConfigPath(agent: OtelAgent, home = homedir()): string {
  return agent === "copilot" ? vscodeSettingsPath(home) :
    resolve(home, `.${agent}`, agent === "codex" ? "config.toml" : "settings.json");
}

export function vscodeInstalled(path: string): boolean {
  return existsSync(resolve(path, ".."));
}

export function parseAgentConfig(text: string, agent: OtelAgent): JsonObject {
  if (agent === "codex") return parseToml(text) as JsonObject;
  if (!text.trim()) return {};
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Refusing to modify an invalid agent settings object.");
  }
  return value as JsonObject;
}

export function getSetting(object: JsonObject, path: string[]): unknown {
  let value: unknown = object;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as JsonObject)[key];
  }
  return value;
}

function setSetting(object: JsonObject, path: string[], value: unknown): void {
  const [key, ...rest] = path;
  if (!rest.length) {
    if (value === undefined) delete object[key];
    else object[key] = value;
    return;
  }
  const child = object[key];
  if (child !== undefined && (!child || typeof child !== "object" || Array.isArray(child))) {
    throw new Error(`Refusing to replace a non-object ${key} setting.`);
  }
  const nested = (child ?? {}) as JsonObject;
  setSetting(nested, rest, value);
  if (Object.keys(nested).length) object[key] = nested;
  else delete object[key];
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${tomlValue(v)}`).join(", ")} }`;
  throw new Error("Unsupported TOML value.");
}

function tables(text: string): { start: number; otel: boolean }[] {
  const result: { start: number; otel: boolean }[] = [];
  let multiline: string | null = null;
  let offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (!multiline) {
      const header = /^\s*(\[\[?.*?\]\]?)\s*(?:#.*)?(?:\r?\n)?$/.exec(line);
      if (header) {
        const sample = parseToml(`${header[1]}\n__failproofai_probe = true\n`);
        result.push({ start: offset, otel: Object.hasOwn(sample, "otel") });
      }
    }
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      if (multiline) {
        if (line.startsWith(multiline, i) && (multiline === "'''" || line[i - 1] !== "\\")) {
          i += 2; multiline = null;
        }
      } else if (quote) {
        if (quote === '"' && line[i] === "\\") i++;
        else if (line[i] === quote) quote = null;
      } else if (line[i] === "#") break;
      else if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        multiline = line.slice(i, i + 3); i += 2;
      } else if (line[i] === '"' || line[i] === "'") quote = line[i];
    }
    offset += line.length;
  }
  return result;
}

export function editAgentConfig(text: string, agent: OtelAgent, writes: SettingWrite[]): string {
  const parsed = parseAgentConfig(text, agent);
  if (agent !== "codex") {
    let next = text.trim() ? text : "{}\n";
    for (const write of writes) {
      setSetting(parsed, write.path, write.value);
      next = applyEdits(next, modify(next, write.path, write.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }));
    }
    for (const root of ["env", "telemetry"]) {
      if (getSetting(parsed, [root]) === undefined) {
        next = applyEdits(next, modify(next, [root], undefined, {}));
      }
    }
    return next;
  }
  for (const write of writes) setSetting(parsed, write.path, write.value);
  const headers = tables(text);
  if (Object.hasOwn(parseToml(text.slice(0, headers[0]?.start ?? text.length)), "otel")) {
    throw new Error("Codex OTEL must use an [otel] table, not a root dotted or inline assignment.");
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const otel = parsed.otel as JsonObject | undefined;
  const replacement = otel ? `[otel]${newline}${Object.entries(otel).map(([k, v]) => `${JSON.stringify(k)} = ${tomlValue(v)}${newline}`).join("")}` : "";
  let next = text;
  const ranges = headers.map((h, i) => {
    const end = headers[i + 1]?.start ?? text.length;
    // Comments introducing the NEXT table are not part of the table we own.
    const tail = /(?<=\n)(?:[ \t]*(?:#[^\r\n]*)?\r?\n)+$/.exec(text.slice(h.start, end));
    return { ...h, end: tail ? h.start + tail.index : end };
  }).filter(h => h.otel);
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i];
    next = next.slice(0, range.start) + (i === 0 ? replacement : "") + next.slice(range.end);
  }
  if (!ranges.length && replacement) next += `${next && !next.endsWith("\n") ? newline : ""}${replacement}`;
  parseToml(next);
  return next;
}

export function agentOtelWrites(agent: OtelAgent, endpoint: string, key: string, local: boolean, content: boolean): SettingWrite[] {
  const auth = local ? {} : { Authorization: `Bearer ${key}` };
  const env: JsonObject = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_HEADERS: local ? "" : `Authorization=Bearer%20${encodeURIComponent(key)}`,
    OTEL_LOG_USER_PROMPTS: content ? "1" : "0",
    OTEL_LOG_TOOL_DETAILS: content ? "1" : "0",
    OTEL_LOG_ASSISTANT_RESPONSES: content ? "1" : "0",
    OTEL_LOG_TOOL_CONTENT: content ? "1" : "0",
  };
  if (agent === "claude") {
    for (const signal of ["LOGS", "METRICS"]) {
      env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`] = `${endpoint}/v1/${signal.toLowerCase()}`;
      env[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`] = "http/protobuf";
      env[`OTEL_EXPORTER_OTLP_${signal}_HEADERS`] = env.OTEL_EXPORTER_OTLP_HEADERS;
    }
    return Object.entries(env).map(([k, value]) => ({ path: ["env", k], value }));
  }
  if (agent === "codex") {
    const exporter = (signal: string) => ({ "otlp-http": { endpoint: `${endpoint}/v1/${signal}`, protocol: "json", headers: auth } });
    return Object.entries({
      exporter: exporter("logs"), trace_exporter: exporter("traces"), metrics_exporter: exporter("metrics"),
      log_user_prompt: content,
      log_agent_responses: content,
    }).map(([k, value]) => ({ path: ["otel", k], value }));
  }
  if (agent === "gemini") return Object.entries({
    enabled: true, target: "local", otlpEndpoint: endpoint, otlpProtocol: "http", logPrompts: content, useCollector: true, outfile: undefined,
  }).map(([k, value]) => ({ path: ["telemetry", k], value }));
  return Object.entries({
    enabled: true, exporterType: "otlp-http", otlpEndpoint: endpoint, captureContent: content,
  }).map(([k, value]) => ({ path: [`github.copilot.chat.otel.${k}`], value }));
}
