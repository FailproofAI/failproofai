/**
 * Self Reports: register failproofai's `report` MCP server in every agent that
 * has failproofai hooks, and take it out again.
 *
 * The server is named `failproofai` everywhere (CONTRACT §1). It is served by
 * the daemon over Streamable HTTP at `http://127.0.0.1:<port>/mcp` when a
 * daemon socket is present, and otherwise by `failproofai mcp` over stdio
 * (CONTRACT §7). Both carry the agent, `?agent=<id>` / `--agent <id>`, so the
 * server can record a report itself for agents whose hooks do not see MCP
 * calls (CONTRACT §8).
 *
 * ## Where each agent keeps user-scope MCP servers (checked 2026-11-25)
 *
 * Sources are each agent's current official docs (and source where the docs
 * are silent). "Hook sees MCP" is whether the hook failproofai installs fires
 * for an MCP tool call, and the name it carries for server `failproofai`,
 * tool `report`.
 *
 * | Agent       | File (profile/env)                                   | Key                        | HTTP entry                                   | stdio entry                         | Hook sees MCP / name |
 * |-------------|------------------------------------------------------|----------------------------|----------------------------------------------|-------------------------------------|----------------------|
 * | claude      | `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json` | `mcpServers`           | `{type:"http", url}`                         | `{type:"stdio", command, args}`     | yes, PreToolUse `mcp__failproofai__report` |
 * | codex       | `$CODEX_HOME/config.toml` (TOML)                     | `[mcp_servers.failproofai]`| `url = "…"`                                  | `command`, `args`                   | yes, PreToolUse `mcp__failproofai__report` |
 * | copilot     | `$COPILOT_HOME/mcp-config.json`, else `~/.copilot/`  | `mcpServers`               | `{type:"http", url, tools:["*"]}`            | `{type:"local", command, args, tools:["*"]}` | not documented |
 * | cursor      | `~/.cursor/mcp.json` (editor and cursor-agent)       | `mcpServers`               | `{url}`                                      | `{type:"stdio", command, args}`     | yes, `beforeMCPExecution` (tool_name `report` + mcp_server_name) and preToolUse `MCP:report` |
 * | opencode    | `~/.config/opencode/opencode.json` (as the hooks)    | v1 `mcp.<n>`; v2 `mcp.servers.<n>` | `{type:"remote", url, enabled:true}` (v2: no `enabled`) | `{type:"local", command:[…]}` | yes, plugin `tool.execute.before` `failproofai_report` |
 * | pi          | `$PI_CODING_AGENT_DIR/mcp.json`, else `~/.pi/agent/` | `mcpServers`               | `{url}`                                      | `{command, args}`                   | yes per docs, `tool_call` `mcp__failproofai__report` |
 * | hermes      | every profile's `config.yaml` (YAML, HERMES_HOME)    | `mcp_servers`              | `{url}`                                      | `{command, args}`                   | yes per source, `pre_tool_call` `mcp_failproofai_report` |
 * | openclaw    | every profile's `openclaw.json`                      | `mcp.servers`              | `{url, transport:"streamable-http"}`         | `{command, args}`                   | likely (source only), `before_tool_call` `failproofai__report` |
 * | factory     | `~/.factory/mcp.json`                                | `mcpServers`               | `{type:"http", url}`                         | `{type:"stdio", command, args}`     | yes, `mcp__failproofai__report` (regex sees `failproofai___report`) |
 * | devin       | `~/.config/devin/mcp_config.json`                    | `mcpServers`               | `{url, transport:"http"}`                    | `{command, args}`                   | yes, `mcp__failproofai__report` |
 * | antigravity | `~/.gemini/config/mcp_config.json`                   | `mcpServers`               | `{serverUrl}`                                | `{command, args}`                   | not documented; eager tools `mcp_failproofai_report`, lazy (default) via `call_mcp_tool` |
 * | goose       | `$GOOSE_PATH_ROOT/config/config.yaml`, else `~/.config/goose/config.yaml` (YAML) | `extensions` | `{type:"streamable_http", name, enabled, uri, …}` | `{type:"stdio", name, enabled, cmd, args, …}` | not documented; would be `failproofai__report` |
 *
 * Every agent supports Streamable HTTP, so the transport choice is purely
 * "is a daemon here". Every path is the user-scope one: MCP servers are a per
 * user (per profile) setting even where failproofai's hooks are per project.
 * Codex: user scope only. Its system config (`/etc/codex/config.toml`, where
 * root installs put the hooks) is not documented to honour `[mcp_servers]`, so
 * a root install still registers the server in `$CODEX_HOME/config.toml`.
 *
 * ## Ownership
 *
 * An entry is ours when it is named `failproofai` AND has our shape: a URL
 * `http://127.0.0.1:<port>/mcp?agent=<id>`, or a command whose file name
 * contains `failproofai` run with `mcp --agent <id>`. That shape is the marker:
 * the JSON agents validate their server schema and an extra marker key could
 * make one reject the whole file. Codex's entry also sits between two marker
 * comments; Hermes' and Goose's carry a marker comment. A `failproofai` entry of
 * any other shape (for example the Cloud MCP gateway) is the user's: it is never
 * changed and is reported as a conflict.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { isMap, type Document } from "yaml";
import { writeConfigFileAtomic } from "./safe-config-write";
import { codexHome } from "./codex-system-hooks";
import { claudeConfigDir, getIntegration, readYamlDoc, writeYamlDoc, UnreadableAgentConfigError } from "./integrations";
import { daemonSocketPresent } from "./daemon-client";
import { readEffectiveSelfReport, selfReportPort, selfReportSettingsFile, SELF_REPORT_SERVER_NAME } from "./self-report";
import { listHermesProfiles } from "../../lib/hermes-profiles";
import { listOpenClawProfiles } from "../../lib/openclaw-profiles";
import { INTEGRATION_TYPES, type IntegrationType } from "./types";
import { mergeTomlManagedBlock, readTomlManagedBlock, tomlString, type TomlBlockMarkers } from "./toml-managed-block";

// ── Settings (CONTRACT §4) ──────────────────────────────────────────────────

/** The MCP server's name in every agent. */
export { SELF_REPORT_SERVER_NAME as SELF_REPORT_MCP_SERVER_NAME, SELF_REPORT_DEFAULT_PORT } from "./self-report";

/** `$FAILPROOFAI_HOME/self-report.json`. */
export function selfReportSettingsPath(): string {
  return selfReportSettingsFile();
}

export interface SelfReportMcpSettings {
  enabled: boolean;
  port: number;
}

/**
 * The bits of self-report.json this module needs, through the one settings
 * reader in ./self-report. Missing or unparsable file ⇒ disabled, on the port
 * a local writer would record.
 */
export function readSelfReportMcpSettings(path = selfReportSettingsPath()): SelfReportMcpSettings {
  const s = readEffectiveSelfReport(path);
  if (!s) return { enabled: false, port: selfReportPort() };
  return { enabled: s.enabled, port: s.mcp.port };
}

// ── Transports ──────────────────────────────────────────────────────────────

export type SelfReportTransport =
  | { kind: "http"; url: string }
  | { kind: "stdio"; command: string; args: string[] };

export function selfReportHttpUrl(port: number, agent: IntegrationType): string {
  return `http://127.0.0.1:${port}/mcp?agent=${agent}`;
}

export function selfReportStdioArgs(agent: IntegrationType): string[] {
  return ["mcp", "--agent", agent];
}

const OUR_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/mcp\?agent=[a-z][a-z0-9_-]*$/;

function isOurCommand(command: unknown, args: unknown): boolean {
  if (typeof command !== "string" || !basename(command).toLowerCase().includes("failproofai")) return false;
  return Array.isArray(args) && args[0] === "mcp" && args[1] === "--agent" && typeof args[2] === "string";
}

/** Whether a server entry (any agent's shape) is one failproofai wrote. */
export function isOurMcpEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  for (const key of ["url", "serverUrl", "uri"]) {
    if (typeof e[key] === "string" && OUR_URL_RE.test(e[key] as string)) return true;
  }
  if (isOurCommand(e.command, e.args) || isOurCommand(e.cmd, e.args)) return true;
  // OpenCode's local form: command is one array.
  if (Array.isArray(e.command) && isOurCommand(e.command[0], e.command.slice(1))) return true;
  return false;
}

/** Which transport an entry of ours uses (for status), or null. */
function transportOf(entry: unknown): "http" | "stdio" | null {
  if (!isOurMcpEntry(entry)) return null;
  const e = entry as Record<string, unknown>;
  return ["url", "serverUrl", "uri"].some((k) => typeof e[k] === "string") ? "http" : "stdio";
}

// ── Per-agent targets ───────────────────────────────────────────────────────

type Format = "json" | "toml" | "yaml";

interface McpTarget {
  agent: IntegrationType;
  format: Format;
  /** Every file to write (one per profile for Hermes/OpenClaw). */
  paths(): string[];
  /** Whether the agent can reach a Streamable HTTP server. */
  http: boolean;
  /** JSON/YAML key path of the servers map, given the parsed document. */
  container(parsed: Record<string, unknown>): string[];
  /** The entry to write, given the container path chosen above. */
  entry(t: SelfReportTransport, container: string[]): Record<string, unknown>;
}

const plainEntry = (t: SelfReportTransport, urlKey = "url"): Record<string, unknown> =>
  t.kind === "http" ? { [urlKey]: t.url } : { command: t.command, args: t.args };

function xdgConfigHome(): string {
  const x = process.env.XDG_CONFIG_HOME?.trim();
  return x ? resolve(x) : resolve(homedir(), ".config");
}

function claudeUserConfigPath(): string {
  // Claude Code keeps `.claude.json` inside CLAUDE_CONFIG_DIR when it is set,
  // and beside `~/.claude` otherwise.
  return process.env.CLAUDE_CONFIG_DIR?.trim()
    ? resolve(claudeConfigDir(), ".claude.json")
    : resolve(homedir(), ".claude.json");
}

function gooseConfigPath(): string {
  const root = process.env.GOOSE_PATH_ROOT?.trim();
  if (root) return resolve(root, "config", "config.yaml");
  if (process.platform === "win32" && process.env.APPDATA) {
    return resolve(process.env.APPDATA, "Block", "goose", "config", "config.yaml");
  }
  return resolve(xdgConfigHome(), "goose", "config.yaml");
}

function opencodeUserConfigPath(): string {
  // Same directory the hooks are written to (integrations.ts `opencode`).
  const dir = resolve(homedir(), ".config", "opencode");
  const json = resolve(dir, "opencode.json");
  const jsonc = resolve(dir, "opencode.jsonc");
  return !existsSync(json) && existsSync(jsonc) ? jsonc : json;
}

/** OpenCode v2 nests servers under `mcp.servers`; v1 puts them directly under `mcp`. */
function opencodeIsV2(parsed: Record<string, unknown>): boolean {
  const mcp = parsed.mcp as Record<string, unknown> | undefined;
  const servers = mcp?.servers as Record<string, unknown> | undefined;
  return !!servers && typeof servers === "object" && !Array.isArray(servers) && !("type" in servers);
}

export const SELF_REPORT_MCP_TARGETS: Record<IntegrationType, McpTarget> = {
  claude: {
    agent: "claude", format: "json", http: true,
    paths: () => [claudeUserConfigPath()],
    container: () => ["mcpServers"],
    entry: (t) => (t.kind === "http" ? { type: "http", url: t.url } : { type: "stdio", command: t.command, args: t.args }),
  },
  codex: {
    agent: "codex", format: "toml", http: true,
    paths: () => [resolve(codexHome(), "config.toml")],
    container: () => ["mcp_servers"],
    entry: (t) => plainEntry(t),
  },
  copilot: {
    agent: "copilot", format: "json", http: true,
    paths: () => [resolve(process.env.COPILOT_HOME?.trim() || resolve(homedir(), ".copilot"), "mcp-config.json")],
    container: () => ["mcpServers"],
    entry: (t) =>
      t.kind === "http"
        ? { type: "http", url: t.url, tools: ["*"] }
        : { type: "local", command: t.command, args: t.args, tools: ["*"] },
  },
  cursor: {
    agent: "cursor", format: "json", http: true,
    paths: () => [resolve(homedir(), ".cursor", "mcp.json")],
    container: () => ["mcpServers"],
    entry: (t) => (t.kind === "http" ? { url: t.url } : { type: "stdio", command: t.command, args: t.args }),
  },
  opencode: {
    agent: "opencode", format: "json", http: true,
    paths: () => [opencodeUserConfigPath()],
    container: (parsed) => (opencodeIsV2(parsed) ? ["mcp", "servers"] : ["mcp"]),
    entry: (t, container) => {
      const v2 = container.length === 2;
      const base = t.kind === "http" ? { type: "remote", url: t.url } : { type: "local", command: [t.command, ...t.args] };
      return v2 ? base : { ...base, enabled: true };
    },
  },
  pi: {
    agent: "pi", format: "json", http: true,
    paths: () => [resolve(process.env.PI_CODING_AGENT_DIR?.trim() || resolve(homedir(), ".pi", "agent"), "mcp.json")],
    container: () => ["mcpServers"],
    entry: (t) => plainEntry(t),
  },
  hermes: {
    agent: "hermes", format: "yaml", http: true,
    paths: () => listHermesProfiles().map((p) => resolve(p.home, "config.yaml")),
    container: () => ["mcp_servers"],
    entry: (t) => plainEntry(t),
  },
  openclaw: {
    agent: "openclaw", format: "json", http: true,
    paths: () => listOpenClawProfiles().map((p) => resolve(p.home, "openclaw.json")),
    container: () => ["mcp", "servers"],
    entry: (t) => (t.kind === "http" ? { url: t.url, transport: "streamable-http" } : { command: t.command, args: t.args }),
  },
  factory: {
    agent: "factory", format: "json", http: true,
    paths: () => [resolve(homedir(), ".factory", "mcp.json")],
    container: () => ["mcpServers"],
    entry: (t) => (t.kind === "http" ? { type: "http", url: t.url } : { type: "stdio", command: t.command, args: t.args }),
  },
  devin: {
    agent: "devin", format: "json", http: true,
    paths: () => [
      process.platform === "win32" && process.env.APPDATA
        ? resolve(process.env.APPDATA, "devin", "mcp_config.json")
        : resolve(homedir(), ".config", "devin", "mcp_config.json"),
    ],
    container: () => ["mcpServers"],
    entry: (t) => (t.kind === "http" ? { url: t.url, transport: "http" } : { command: t.command, args: t.args }),
  },
  antigravity: {
    agent: "antigravity", format: "json", http: true,
    paths: () => [resolve(homedir(), ".gemini", "config", "mcp_config.json")],
    container: () => ["mcpServers"],
    entry: (t) => plainEntry(t, "serverUrl"),
  },
  goose: {
    agent: "goose", format: "yaml", http: true,
    paths: () => [gooseConfigPath()],
    container: () => ["extensions"],
    entry: (t) =>
      t.kind === "http"
        ? { name: SELF_REPORT_SERVER_NAME, type: "streamable_http", enabled: true, uri: t.url, envs: {}, env_keys: [], timeout: 300 }
        : { name: SELF_REPORT_SERVER_NAME, type: "stdio", enabled: true, cmd: t.command, args: t.args, envs: {}, env_keys: [], timeout: 300 },
  },
};

// ── Reading and writing one file ────────────────────────────────────────────

const TOML_MARKERS: TomlBlockMarkers = {
  begin: "# >>> failproofai self-report mcp >>>",
  end: "# <<< failproofai self-report mcp <<<",
};
const YAML_MARKER_COMMENT = " failproofai self-report MCP server (managed by failproofai; removed by `failproofai self-report disable`)";

type Current =
  | { state: "absent" }
  | { state: "ours"; entry: Record<string, unknown> }
  | { state: "foreign" };

interface FileOps {
  current(): Current;
  /** Desired entry → new file text; null entry removes ours. */
  write(entry: Record<string, unknown> | null): void;
  /** The container path the entry goes in (json/yaml only). */
  container: string[];
}

function readText(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new UnreadableAgentConfigError(path, `it could not be read (${err instanceof Error ? err.message : String(err)})`);
  }
}

function getIn(obj: unknown, path: string[]): unknown {
  let v: unknown = obj;
  for (const k of path) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

function classify(value: unknown): Current {
  if (value === undefined) return { state: "absent" };
  return isOurMcpEntry(value) ? { state: "ours", entry: value as Record<string, unknown> } : { state: "foreign" };
}

function jsonOps(target: McpTarget, path: string): FileOps {
  const text = readText(path);
  let parsed: Record<string, unknown> = {};
  if (text.trim() !== "") {
    const errors: ParseError[] = [];
    const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) throw new UnreadableAgentConfigError(path, "it is not valid JSON");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new UnreadableAgentConfigError(path, "its top level is not a JSON object");
    }
    parsed = value as Record<string, unknown>;
  }
  const container = target.container(parsed);
  // A container that exists but is not an object cannot take our key.
  const holder = getIn(parsed, container);
  if (holder !== undefined && (typeof holder !== "object" || holder === null || Array.isArray(holder))) {
    return {
      container,
      current: () => ({ state: "foreign" }),
      write: () => {
        throw new Error(`${container.join(".")} is not an object`);
      },
    };
  }
  const keyPath = [...container, SELF_REPORT_SERVER_NAME];
  return {
    container,
    current: () => classify(getIn(parsed, keyPath)),
    write(entry) {
      const base = text.trim() === "" ? "{}\n" : text;
      const edits = modify(base, keyPath, entry ?? undefined, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      });
      let next = applyEdits(base, edits);
      if (!next.endsWith("\n")) next += "\n";
      writeConfigFileAtomic(path, next);
    },
  };
}

function renderTomlBlock(entry: Record<string, unknown>): string {
  const lines = [
    TOML_MARKERS.begin,
    "# Written by failproofai (Self Reports). `failproofai self-report disable` or",
    "# `failproofai uninstall` removes it. Everything between the markers is replaced.",
    `[mcp_servers.${SELF_REPORT_SERVER_NAME}]`,
  ];
  for (const [k, v] of Object.entries(entry)) {
    if (typeof v === "string") lines.push(`${k} = ${tomlString(v)}`);
    else if (Array.isArray(v)) lines.push(`${k} = [${v.map((x) => tomlString(String(x))).join(", ")}]`);
  }
  lines.push(TOML_MARKERS.end);
  return `${lines.join("\n")}\n`;
}

function tomlOps(path: string): FileOps {
  const text = readText(path);
  let outside: string;
  let ourBlock: string | null;
  try {
    ourBlock = readTomlManagedBlock(text, TOML_MARKERS);
    outside = mergeTomlManagedBlock(text, null, TOML_MARKERS);
  } catch (err) {
    throw new UnreadableAgentConfigError(path, err instanceof Error ? err.message : String(err));
  }
  let parsedOutside: Record<string, unknown>;
  let parsedAll: Record<string, unknown>;
  try {
    parsedOutside = parseToml(outside) as Record<string, unknown>;
    parsedAll = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    throw new UnreadableAgentConfigError(path, `it does not parse as TOML (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
  }
  const keyPath = ["mcp_servers", SELF_REPORT_SERVER_NAME];
  return {
    container: ["mcp_servers"],
    current() {
      if (getIn(parsedOutside, keyPath) !== undefined) return { state: "foreign" };
      if (!ourBlock) return { state: "absent" };
      const entry = getIn(parsedAll, keyPath);
      return entry && typeof entry === "object" ? { state: "ours", entry: entry as Record<string, unknown> } : { state: "absent" };
    },
    write(entry) {
      const next = mergeTomlManagedBlock(text, entry ? renderTomlBlock(entry) : null, TOML_MARKERS);
      // Never hand Codex a file it cannot start with: an inline `mcp_servers = {…}`
      // elsewhere would collide with our table header.
      let check: Record<string, unknown>;
      try {
        check = parseToml(next) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`the result would not be valid TOML (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
      }
      if (entry && getIn(check, keyPath) === undefined) throw new Error("the written entry did not read back");
      writeConfigFileAtomic(path, next);
    },
  };
}

function yamlOps(target: McpTarget, path: string): FileOps {
  const doc: Document = readYamlDoc(path);
  const js = (doc.toJS() ?? {}) as Record<string, unknown>;
  if (typeof js !== "object" || Array.isArray(js)) throw new UnreadableAgentConfigError(path, "its top level is not a mapping");
  const container = target.container(js);
  const holder = doc.getIn(container);
  const keyPath = [...container, SELF_REPORT_SERVER_NAME];
  if (holder !== undefined && holder !== null && !isMap(holder)) {
    return {
      container,
      current: () => ({ state: "foreign" }),
      write: () => {
        throw new Error(`${container.join(".")} is not a mapping`);
      },
    };
  }
  return {
    container,
    current: () => classify(getIn(js, keyPath)),
    write(entry) {
      if (entry) {
        const node = doc.createNode(entry);
        node.commentBefore = YAML_MARKER_COMMENT;
        if (holder === undefined || holder === null) doc.setIn(container, doc.createNode({}));
        doc.setIn(keyPath, node);
      } else {
        doc.deleteIn(keyPath);
      }
      writeYamlDoc(path, doc);
    },
  };
}

function opsFor(target: McpTarget, path: string): FileOps {
  if (target.format === "toml") return tomlOps(path);
  if (target.format === "yaml") return yamlOps(target, path);
  return jsonOps(target, path);
}

function sameEntry(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Sync ────────────────────────────────────────────────────────────────────

export type SelfReportMcpAction = "added" | "updated" | "removed" | "unchanged" | "skipped";
export type SelfReportMcpStatus =
  /** The file now matches what was wanted. */
  | "ok"
  /** Enabled, but this agent has no failproofai hooks; nothing written. */
  | "not-hooked"
  /** A `failproofai` server that is not ours is there; left alone. */
  | "conflict"
  /** The file could not be read or written; left as it was. */
  | "error"
  /** The agent cannot take an MCP server this way. */
  | "unsupported";

export interface SelfReportMcpResult {
  agent: IntegrationType;
  path: string;
  action: SelfReportMcpAction;
  transport: "http" | "stdio" | null;
  status: SelfReportMcpStatus;
  detail?: string;
}

export interface SyncSelfReportMcpOptions {
  /** Override the settings file's `enabled`. `false` removes our entries everywhere. */
  enabled?: boolean;
  /** Print one line per change (default: print nothing; callers print results). */
  quiet?: boolean;
  /** Only these agents (default: every integration). */
  agents?: readonly IntegrationType[];
  /**
   * When enabling, register in these agents even if their user-scope hooks are
   * not detected (installHooks passes the agents it just wrote, at any scope).
   */
  alsoHooked?: readonly IntegrationType[];
  /** The failproofai CLI the hooks use (stdio command). Default: resolved like the installer does. */
  binaryPath?: string;
  /** Test seams. */
  deps?: {
    daemonSocketPresent?: () => boolean;
    hooksInstalled?: (agent: IntegrationType) => boolean;
    settings?: SelfReportMcpSettings;
    resolveCliPath?: () => string | null;
  };
}

/** The failproofai CLI the hooks run: the installer's override, PATH, then this process's own bin. */
export function resolveSelfReportCliPath(): string | null {
  const override = process.env.FAILPROOFAI_BINARY_OVERRIDE?.trim();
  if (override) return override;
  try {
    const cmd = process.platform === "win32" ? "where failproofai" : "which failproofai";
    const found = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0]?.trim();
    if (found) return found;
  } catch {
    // not on PATH (a daemon's service environment, say)
  }
  const self = process.argv[1];
  if (self && basename(self).toLowerCase().includes("failproofai")) {
    try {
      return realpathSync(self);
    } catch {
      return resolve(self);
    }
  }
  return null;
}

function defaultHooksInstalled(agent: IntegrationType): boolean {
  try {
    const integration = getIntegration(agent);
    return integration.scopes.includes("user") && integration.hooksInstalledInSettings("user");
  } catch {
    return false;
  }
}

/**
 * Add (enabled) or remove (disabled) our `failproofai` MCP server in every
 * agent. Enabled: only agents with failproofai hooks get it, and agents without
 * hooks are left as they are. Disabled: ours is removed from every agent's
 * file, hooked or not. Idempotent; never touches an entry that is not ours;
 * one agent's failure never stops the others.
 */
export function syncSelfReportMcp(opts: SyncSelfReportMcpOptions = {}): SelfReportMcpResult[] {
  const settings = opts.deps?.settings ?? readSelfReportMcpSettings();
  const enabled = opts.enabled ?? settings.enabled;
  const agents = opts.agents ?? INTEGRATION_TYPES;
  const daemonHere = (opts.deps?.daemonSocketPresent ?? daemonSocketPresent)();
  const hooked = opts.deps?.hooksInstalled ?? defaultHooksInstalled;
  const also = new Set(opts.alsoHooked ?? []);
  let cliPath: string | null | undefined = opts.binaryPath;
  const results: SelfReportMcpResult[] = [];

  for (const agent of agents) {
    const target = SELF_REPORT_MCP_TARGETS[agent];
    if (!target) {
      results.push({ agent, path: "", action: "skipped", transport: null, status: "unsupported" });
      continue;
    }
    let paths: string[];
    try {
      paths = target.paths();
    } catch (err) {
      results.push({ agent, path: "", action: "skipped", transport: null, status: "error", detail: errText(err) });
      continue;
    }
    const wantIt = enabled && (also.has(agent) || hooked(agent));

    let transport: SelfReportTransport | null = null;
    if (wantIt) {
      if (daemonHere && target.http) {
        transport = { kind: "http", url: selfReportHttpUrl(settings.port, agent) };
      } else {
        if (cliPath === undefined) cliPath = (opts.deps?.resolveCliPath ?? resolveSelfReportCliPath)();
        if (cliPath) transport = { kind: "stdio", command: cliPath, args: selfReportStdioArgs(agent) };
      }
    }

    for (const path of paths) {
      if (enabled && !wantIt) {
        results.push({ agent, path, action: "skipped", transport: null, status: "not-hooked" });
        continue;
      }
      if (wantIt && !transport) {
        results.push({
          agent, path, action: "skipped", transport: null, status: "error",
          detail: "no daemon is running here and the failproofai CLI was not found for stdio",
        });
        continue;
      }
      try {
        if (!wantIt && !existsSync(path)) {
          results.push({ agent, path, action: "unchanged", transport: null, status: "ok" });
          continue;
        }
        const ops = opsFor(target, path);
        const cur = ops.current();
        if (cur.state === "foreign") {
          results.push({
            agent, path, action: "skipped", transport: null, status: "conflict",
            detail: `a "${SELF_REPORT_SERVER_NAME}" MCP server that failproofai did not write is already configured`,
          });
          continue;
        }
        if (!wantIt) {
          if (cur.state === "absent") {
            results.push({ agent, path, action: "unchanged", transport: null, status: "ok" });
          } else {
            ops.write(null);
            results.push({ agent, path, action: "removed", transport: transportOf(cur.entry), status: "ok" });
          }
          continue;
        }
        const desired = target.entry(transport!, ops.container);
        if (cur.state === "ours" && sameEntry(cur.entry, desired)) {
          results.push({ agent, path, action: "unchanged", transport: transport!.kind, status: "ok" });
          continue;
        }
        ops.write(desired);
        results.push({ agent, path, action: cur.state === "ours" ? "updated" : "added", transport: transport!.kind, status: "ok" });
      } catch (err) {
        results.push({ agent, path, action: "skipped", transport: null, status: "error", detail: errText(err) });
      }
    }
  }

  if (!opts.quiet) for (const line of selfReportSyncLines(results)) console.log(line);
  return results;
}

/** Remove our entries from every agent (or `agents`), whatever the settings say. */
export function removeSelfReportMcp(opts: Omit<SyncSelfReportMcpOptions, "enabled"> = {}): SelfReportMcpResult[] {
  return syncSelfReportMcp({ ...opts, enabled: false });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One line per change, conflict or error; nothing for an agent left as it was. */
export function selfReportSyncLines(results: readonly SelfReportMcpResult[]): string[] {
  const out: string[] = [];
  for (const r of results) {
    const name = displayName(r.agent);
    if (r.action === "added" || r.action === "updated") {
      out.push(`✓ Self Reports MCP server ${r.action === "added" ? "added to" : "updated in"} ${name} (${r.transport}): ${r.path}`);
    } else if (r.action === "removed") {
      out.push(`✓ Self Reports MCP server removed from ${name}: ${r.path}`);
    } else if (r.status === "conflict" || r.status === "error") {
      out.push(`! ${name}: Self Reports MCP server not changed in ${r.path || "its config"}: ${r.detail ?? r.status}`);
    }
  }
  return out;
}

function displayName(agent: IntegrationType): string {
  try {
    return getIntegration(agent).displayName;
  } catch {
    return agent;
  }
}

// ── Status ──────────────────────────────────────────────────────────────────

export interface SelfReportRegistration {
  agent: IntegrationType;
  path: string;
  /** failproofai hooks are installed for this agent (user scope). */
  hooked: boolean;
  /** Our entry is in this file. */
  registered: boolean;
  transport: "http" | "stdio" | null;
  /** A `failproofai` server that is not ours is there. */
  conflict: boolean;
  /** The file could not be read. */
  error?: string;
}

/** Per-agent, per-file registration state, for `failproofai self-report status`. Writes nothing. */
export function selfReportRegistrationStatus(
  opts: { agents?: readonly IntegrationType[]; hooksInstalled?: (agent: IntegrationType) => boolean } = {},
): SelfReportRegistration[] {
  const hooked = opts.hooksInstalled ?? defaultHooksInstalled;
  const out: SelfReportRegistration[] = [];
  for (const agent of opts.agents ?? INTEGRATION_TYPES) {
    const target = SELF_REPORT_MCP_TARGETS[agent];
    if (!target) continue;
    const isHooked = hooked(agent);
    let paths: string[] = [];
    try {
      paths = target.paths();
    } catch (err) {
      out.push({ agent, path: "", hooked: isHooked, registered: false, transport: null, conflict: false, error: errText(err) });
      continue;
    }
    for (const path of paths) {
      if (!existsSync(path)) {
        out.push({ agent, path, hooked: isHooked, registered: false, transport: null, conflict: false });
        continue;
      }
      try {
        const cur = opsFor(target, path).current();
        out.push({
          agent, path, hooked: isHooked,
          registered: cur.state === "ours",
          transport: cur.state === "ours" ? transportOf(cur.entry) : null,
          conflict: cur.state === "foreign",
        });
      } catch (err) {
        out.push({ agent, path, hooked: isHooked, registered: false, transport: null, conflict: false, error: errText(err) });
      }
    }
  }
  return out;
}

