/**
 * Self Reports: register failproofai's `report` MCP server in every agent that
 * has failproofai hooks, and take it out again.
 *
 * The server is named `failproofai_local` everywhere (CONTRACT §1), so it
 * never clashes with the FailproofAI Cloud gateway MCP server, which users
 * register as `failproofai`; the two coexist. Which transport
 * an agent gets depends on who records its reports (CONTRACT §7, §8):
 *
 * - Hook-recorded agents (claude, codex: not in `SELF_REPORT_SERVER_RECORDS`)
 *   are served by the daemon over Streamable HTTP at
 *   `http://127.0.0.1:<port>/mcp?agent=<id>` when the daemon behind this home's
 *   socket is serving that port (`selfReportDaemonLive`), else stdio. Their
 *   hook records the report against the exact session, so the server records
 *   nothing and needs no caller identity.
 * - Server-recorded agents (everything in `SELF_REPORT_SERVER_RECORDS`) always
 *   get `failproofai mcp --agent <id>` over stdio. The server records their
 *   report itself and must pick the session; one user-scope HTTP entry serves
 *   every project and carries only `?agent=`, so over HTTP it could not tell
 *   which project called, while a stdio server knows its real cwd.
 *
 * The daemon runs `self-report sync` once it is listening, so hook-recorded
 * agents move to HTTP when it comes up.
 *
 * ## Where each agent keeps user-scope MCP servers (checked 2026-11-25)
 *
 * Sources are each agent's current official docs (and source where the docs
 * are silent). "Hook sees MCP" is whether the hook failproofai installs fires
 * for an MCP tool call, and the name it carries for server `failproofai_local`,
 * tool `report`.
 *
 * | Agent       | File (profile/env)                                   | Key                        | HTTP entry                                   | stdio entry                         | Hook sees MCP / name |
 * |-------------|------------------------------------------------------|----------------------------|----------------------------------------------|-------------------------------------|----------------------|
 * | claude      | `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json` | `mcpServers`           | `{type:"http", url}`                         | `{type:"stdio", command, args}`     | yes, PreToolUse `mcp__failproofai_local__report` |
 * | codex       | `$CODEX_HOME/config.toml` (TOML)                     | `[mcp_servers.failproofai_local]`| `url = "…"`                                  | `command`, `args`                   | yes, PreToolUse `mcp__failproofai_local__report` |
 * | copilot     | `$COPILOT_HOME/mcp-config.json`, else `~/.copilot/`  | `mcpServers`               | `{type:"http", url, tools:["*"]}`            | `{type:"local", command, args, tools:["*"]}` | not documented; likely `failproofai_local-report` (exempt, with `failproofai_local/report`) |
 * | cursor      | `~/.cursor/mcp.json` (editor and cursor-agent)       | `mcpServers`               | `{url}`                                      | `{type:"stdio", command, args}`     | `beforeMCPExecution` (tool_name `report` + mcp_server_name; not installed) and preToolUse `MCP:report` with no server, so the server records |
 * | opencode    | `~/.config/opencode/opencode.json` (as the hooks)    | v1 `mcp.<n>`; v2 `mcp.servers.<n>` | `{type:"remote", url, enabled:true}` (v2: no `enabled`) | `{type:"local", command:[…]}` | yes, plugin `tool.execute.before` `failproofai_local_report` |
 * | pi          | `$PI_CODING_AGENT_DIR/mcp.json`, else `~/.pi/agent/` | `mcpServers`               | `{url, exposure:"direct"}`                   | `{command, args, exposure:"direct"}` | yes per docs, `tool_call` `mcp__failproofai_local__report` |
 * | hermes      | every profile's `config.yaml` (YAML, HERMES_HOME)    | `mcp_servers`              | `{url}`                                      | `{command, args}`                   | yes per source, `pre_tool_call` `mcp_failproofai_local_report` |
 * | openclaw    | every profile's `openclaw.json`                      | `mcp.servers`              | `{url, transport:"streamable-http"}`         | `{command, args}`                   | likely (source only), `before_tool_call` `failproofai_local__report` |
 * | factory     | `~/.factory/mcp.json`                                | `mcpServers`               | `{type:"http", url}`                         | `{type:"stdio", command, args}`     | yes, `mcp__failproofai_local__report` (regex sees `failproofai_local___report`) |
 * | devin       | `~/.config/devin/mcp_config.json`                    | `mcpServers`               | `{url, transport:"http"}`                    | `{command, args}`                   | yes, `mcp__failproofai_local__report` |
 * | antigravity | `~/.gemini/config/mcp_config.json`                   | `mcpServers`               | `{serverUrl}`                                | `{command, args}`                   | not documented; eager tools `mcp_failproofai_local_report`, lazy (default) via `call_mcp_tool` |
 * | goose       | `$GOOSE_PATH_ROOT/config/config.yaml`, else `~/.config/goose/config.yaml` (YAML) | `extensions` | `{type:"streamable_http", name, enabled, uri, …}` | `{type:"stdio", name, enabled, cmd, args, …}` | not documented; would be `failproofai_local__report` |
 *
 * Cursor approval (cursor-agent 2026.11): servers from a *project*
 * `.cursor/mcp.json` load only once approved; approvals live per project root
 * in `~/.cursor/projects/<root>/mcp-approvals.json`, keyed by a hash of the
 * root and the entry. `~/.cursor/mcp.json` is user scope and needs none, except
 * when cursor-agent runs with the home directory as its project, where it is
 * also the project file. That key changes with every project and transport, so
 * failproofai writes no approval; sync and status point at
 * `cursor-agent mcp enable failproofai_local` instead.
 *
 * Deferred tools: Pi's entry sets `exposure: "direct"` (its default `codemode`
 * shows the model only the server's name). Hermes (`tools.tool_search`) and
 * OpenClaw (`tools.toolSearch`) defer MCP tools with a global switch only;
 * neither has a per-server "always load" option, so their entries set none.
 *
 * Every agent supports Streamable HTTP; HTTP is still used only for the
 * hook-recorded ones (see above). Every path is the user-scope one: MCP servers are a per
 * user (per profile) setting even where failproofai's hooks are per project.
 * Codex: user scope only. Its system config (`/etc/codex/config.toml`, where
 * root installs put the hooks) is not documented to honour `[mcp_servers]`, so
 * a root install still registers the server in `$CODEX_HOME/config.toml`.
 *
 * ## Ownership
 *
 * An entry is ours when it is named `failproofai_local` AND has our shape: a URL
 * `http://127.0.0.1:<port>/mcp?agent=<id>`, or a command whose file name
 * contains `failproofai` run with `mcp --agent <id>`. That shape is the marker:
 * the JSON agents validate their server schema and an extra marker key could
 * make one reject the whole file. Codex's entry also sits between two marker
 * comments; Hermes' and Goose's carry a marker comment. A `failproofai_local`
 * entry of any other shape is the user's: it is never changed and is reported
 * as a conflict. An entry named `failproofai` (the Cloud MCP gateway, or
 * anything else) is not ours by name and is never read, changed or reported.
 */
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { isMap, type Document } from "yaml";
import { writeConfigFileAtomic } from "./safe-config-write";
import { codexHome } from "./codex-system-hooks";
import { claudeConfigDir, getIntegration, readYamlDoc, writeYamlDoc, UnreadableAgentConfigError } from "./integrations";

import { daemonSelfReportServer } from "./daemon-client";
import { flushSelfReportLogs, sendSelfReportLog } from "./self-report-log";
import { selfReportHookState } from "./self-report-hook-trust";
import { resolveSelfReport, selfReportPort, selfReportSettingsFile, SELF_REPORT_SERVER_NAME, SELF_REPORT_SERVER_RECORDS } from "./self-report";
import { listHermesProfiles } from "../../lib/hermes-profiles";
import { listOpenClawProfiles } from "../../lib/openclaw-profiles";
import { INTEGRATION_TYPES, type IntegrationType } from "./types";
import { mergeTomlManagedBlock, readTomlManagedBlock, tomlString, type TomlBlockMarkers } from "./toml-managed-block";

/**
 * Test-only guard: a test that forgot to isolate HOME must never write the
 * developer's real agent configs. `os.userInfo().homedir` ignores `$HOME`, so it
 * names the real home even when a test moved `$HOME`; under Vitest a write into
 * it throws. Production (no `VITEST` in the environment) is unaffected.
 */
function assertNotRealHomeUnderTest(path: string): void {
  if (!process.env.VITEST) return;
  let real = "";
  try {
    real = userInfo().homedir;
  } catch {
    return;
  }
  if (!real) return;
  const target = resolve(path);
  if (target === real || target.startsWith(real.endsWith(sep) ? real : real + sep)) {
    throw new Error(`refusing to write ${target} under test: set HOME to a temp dir`);
  }
}

function guardedWriteConfig(path: string, text: string): void {
  assertNotRealHomeUnderTest(path);
  writeConfigFileAtomic(path, text);
}

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
 * reader in ./self-report (`resolveSelfReport`). On by default: a missing file
 * is enabled off Cloud and disabled on a Cloud-enrolled machine until the
 * daemon writes it; an unparsable file is disabled. Disabled is reported on the
 * port a local writer would record.
 */
export function readSelfReportMcpSettings(path = selfReportSettingsPath()): SelfReportMcpSettings {
  const s = resolveSelfReport(path);
  if (!s) return { enabled: false, port: selfReportPort() };
  return { enabled: s.enabled, port: s.mcp.port };
}

// ── Transports ──────────────────────────────────────────────────────────────

/**
 * Whether an agent may be registered over HTTP at all: only when its hook,
 * not the server, records the report (see the header).
 */
export function selfReportHttpAllowed(agent: IntegrationType): boolean {
  return SELF_REPORT_MCP_TARGETS[agent]?.http === true && !SELF_REPORT_SERVER_RECORDS.includes(agent);
}

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

/** The URL (http) or command (stdio) an entry of ours points at, for status. */
function endpointOf(entry: unknown): string | null {
  if (!isOurMcpEntry(entry)) return null;
  const e = entry as Record<string, unknown>;
  for (const key of ["url", "serverUrl", "uri"]) if (typeof e[key] === "string") return e[key] as string;
  if (typeof e.command === "string") return e.command;
  if (typeof e.cmd === "string") return e.cmd;
  if (Array.isArray(e.command) && typeof e.command[0] === "string") return e.command[0];
  return null;
}

// ── Liveness ────────────────────────────────────────────────────────────────

/** How long the endpoint may take to answer an MCP initialize. */
const SELF_REPORT_PROBE_TIMEOUT_MS = 1500;

/**
 * The `serverInfo.instanceId` that `http://127.0.0.1:<port>/mcp` returns when
 * it answers an MCP `initialize` as failproofai's server within the timeout,
 * `""` when it answers as failproofai's server with no id (an older daemon),
 * or null for anything else (refused, timed out, another server on the port).
 */
export async function probeSelfReportHttpInstance(port: number, timeoutMs = SELF_REPORT_PROBE_TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "failproofai-probe", version: "1" } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { serverInfo?: { name?: unknown; instanceId?: unknown } } };
    const info = body?.result?.serverInfo;
    if (info?.name !== SELF_REPORT_SERVER_NAME) return null;
    return typeof info.instanceId === "string" ? info.instanceId : "";
  } catch {
    return null;
  }
}

/** Whether the endpoint answers an MCP `initialize` as failproofai's server. */
export async function probeSelfReportHttp(port: number, timeoutMs = SELF_REPORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  return (await probeSelfReportHttpInstance(port, timeoutMs)) !== null;
}

/**
 * Whether agents should be pointed at the daemon's HTTP server: the daemon
 * behind THIS home's socket answers a ping naming the MCP server it is
 * serving (its pong's `selfReport`: present only while its listener is bound,
 * on this port), AND the endpoint answers an initialize with that same
 * `instanceId`. A socket file alone is not enough (a hard-killed daemon leaves
 * one behind), and neither is a ping plus an answering port: the port may be
 * held by a different daemon (another user's, or another FAILPROOFAI_HOME's)
 * whose bind won while this one's failed, and a report sent there would be
 * recorded under that daemon's home and credentials. Anything short of a match
 * is stdio.
 */
export async function selfReportDaemonLive(port: number): Promise<boolean> {
  const [mine, served] = await Promise.all([daemonSelfReportServer(), probeSelfReportHttpInstance(port)]);
  return !!mine && mine.port === port && !!served && served === mine.instanceId;
}

/** Whether a stdio command can be run (exists and is executable). */
export function selfReportCommandRunnable(command: string): boolean {
  try {
    accessSync(command, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
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
  /**
   * The tool comes from failproofai's own extension for this agent, not from
   * an MCP entry (Pi): sync writes none, and takes out one an earlier version
   * wrote.
   */
  extension?: true;
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
    // Pi before 0.99 has no MCP at all, so an entry here reached no model on
    // the Pi this was verified against (0.85.1). failproofai's Pi extension,
    // which a hooked Pi already loads, registers the tool itself
    // (pi-extension/index.ts); this file only loses an entry an earlier
    // version wrote. The entry shape is kept so that one is recognised.
    entry: (t) => ({ ...plainEntry(t), exposure: "direct" }),
    extension: true,
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
      guardedWriteConfig(path, next);
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
      guardedWriteConfig(path, next);
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
      assertNotRealHomeUnderTest(path);
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
  /** A `failproofai_local` server that is not ours is there; left alone. */
  | "conflict"
  /** The file could not be read or written; left as it was. */
  | "error"
  /** The agent cannot take an MCP server this way. */
  | "unsupported";

export interface SelfReportMcpResult {
  agent: IntegrationType;
  path: string;
  action: SelfReportMcpAction;
  /** `extension`: the agent's tool comes from failproofai's own extension (Pi). */
  transport: "http" | "stdio" | "extension" | null;
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
    /** The live check (default `selfReportDaemonLive`); asked only when an agent wants the server. */
    daemonLive?: (port: number) => Promise<boolean>;
    hooksInstalled?: (agent: IntegrationType) => boolean;
    /**
     * Whether a hook-recorded agent's user-scope hook will run (default
     * `selfReportHookState`): only then may it be on the daemon's HTTP endpoint,
     * which records nothing for it.
     */
    hookRecords?: (agent: IntegrationType) => boolean;
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
  // A daemon's service has no login PATH (an nvm node is on no system PATH),
  // and it runs the CLI as `<node> …/failproofai/dist/cli.mjs`, whose name is
  // not one an entry can be recognised by. npm puts the `failproofai` link in
  // the same bin directory as the node that installed it, so look there, then
  // where the daemon looks for the CLI (`global_bin_dirs` in
  // crates/failproofaid/src/self_report.rs). Without this the daemon's sync
  // had no stdio command and failed every server-recorded agent.
  for (const dir of selfReportCliDirs()) {
    const candidate = resolve(dir, process.platform === "win32" ? "failproofai.cmd" : "failproofai");
    if (selfReportCommandRunnable(candidate)) return candidate;
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

/** Bin directories that hold an npm/bun global `failproofai` when PATH does not. */
export function selfReportCliDirs(env: Record<string, string | undefined> = process.env, execPath = process.execPath, home = homedir()): string[] {
  const dirs = [dirname(execPath)];
  const prefix = (env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix)?.trim();
  if (prefix) dirs.push(resolve(prefix, "bin"));
  dirs.push(resolve(home, ".npm-global", "bin"), "/usr/local/bin", resolve(home, ".bun", "bin"));
  return [...new Set(dirs)];
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
 * Add (enabled) or remove (disabled) our `failproofai_local` MCP server in every
 * agent. Enabled: only agents with failproofai hooks get it, and agents without
 * hooks are left as they are; HTTP for a hook-recorded agent when this home's
 * daemon is serving the port right now (see `selfReportDaemonLive`), stdio
 * otherwise and always for a server-recorded agent. Disabled: ours is removed from
 * every agent's file, hooked or not. Idempotent; never touches an entry that
 * is not ours; one agent's failure never stops the others.
 */
export async function syncSelfReportMcp(opts: SyncSelfReportMcpOptions = {}): Promise<SelfReportMcpResult[]> {
  const settings = opts.deps?.settings ?? readSelfReportMcpSettings();
  const enabled = opts.enabled ?? settings.enabled;
  const agents = opts.agents ?? INTEGRATION_TYPES;
  const seen = new Map<IntegrationType, boolean>();
  const isHooked = opts.deps?.hooksInstalled ?? defaultHooksInstalled;
  const hooked = (a: IntegrationType): boolean => {
    if (!seen.has(a)) seen.set(a, isHooked(a));
    return seen.get(a)!;
  };
  // The live check costs up to a couple of seconds against a wedged daemon, so
  // it runs only when some agent will get an HTTP-capable entry.
  const also = opts.alsoHooked ?? [];
  const wanted =
    enabled && agents.some((a) => selfReportHttpAllowed(a) && (also.includes(a) || hooked(a) || ownedRegistrationIn(a)));
  const daemonHere = wanted ? await (opts.deps?.daemonLive ?? selfReportDaemonLive)(settings.port) : false;
  const results = applySelfReportMcp({ ...opts, deps: { ...opts.deps, settings, hooksInstalled: hooked } }, enabled, daemonHere);
  logSelfReportSync(results);
  await flushSelfReportLogs();
  return results;
}

/**
 * The environment variable the daemon sets on the sync it runs itself: it
 * logs that sync's stdout, so the result is printed there (by bin's `sync`)
 * rather than sent back over its socket. Same name as `SYNC_LOG_ENV` in
 * crates/failproofaid/src/self_report.rs.
 */
export const SELF_REPORT_SYNC_LOG_ENV = "FAILPROOFAI_SELF_REPORT_SYNC_LOG";

/** A sync's result for the daemon's log, when it changed or failed anything. */
function logSelfReportSync(results: readonly SelfReportMcpResult[]): void {
  if (process.env[SELF_REPORT_SYNC_LOG_ENV] === "stdout") return;
  const summary = selfReportSyncLogLine(results);
  if (!summary) return;
  const failed = selfReportFailedAgents(results).length > 0;
  void sendSelfReportLog({ event: "sync", transport: "cli", outcome: failed ? "failed" : "ok", summary });
}

/**
 * Whether any of an agent's files already holds our entry. An agent whose
 * hooks are installed only at project/local scope is registered by the
 * install itself (`alsoHooked`), and later syncs do not see those hooks; its
 * existing entry is still kept and its transport repaired.
 */
function ownedRegistrationIn(agent: IntegrationType): boolean {
  const target = SELF_REPORT_MCP_TARGETS[agent];
  if (!target) return false;
  try {
    return target.paths().some((path) => {
      try {
        return existsSync(path) && opsFor(target, path).current().state === "ours";
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function applySelfReportMcp(opts: SyncSelfReportMcpOptions, enabled: boolean, daemonHere: boolean): SelfReportMcpResult[] {
  const settings = opts.deps?.settings ?? readSelfReportMcpSettings();
  const agents = opts.agents ?? INTEGRATION_TYPES;
  const hooked = opts.deps?.hooksInstalled ?? defaultHooksInstalled;
  const also = new Set(opts.alsoHooked ?? []);
  const hookRecords =
    opts.deps?.hookRecords ??
    ((a: IntegrationType) => selfReportHookState(a, { userHooksInstalled: (x) => hooked(x as IntegrationType) }).recorder === "hook");
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
    const agentHooked = enabled && (also.has(agent) || hooked(agent));

    if (target.extension) {
      for (const path of paths) {
        try {
          const ops = existsSync(path) ? opsFor(target, path) : null;
          const cur = ops?.current();
          if (ops && cur?.state === "ours") {
            ops.write(null);
            results.push({ agent, path, action: "removed", transport: transportOf(cur.entry), status: "ok" });
          }
        } catch (err) {
          results.push({ agent, path, action: "skipped", transport: null, status: "error", detail: errText(err) });
        }
      }
      results.push({
        agent, path: "", action: "unchanged", transport: agentHooked ? "extension" : null,
        status: enabled && !agentHooked ? "not-hooked" : "ok",
      });
      continue;
    }

    let chosen: SelfReportTransport | null | undefined;
    const transportFor = (): SelfReportTransport | null => {
      if (chosen !== undefined) return chosen;
      chosen = null;
      // HTTP only while the hook will record: an untrusted Codex, or a Claude
      // Code with hooks off, gets stdio, whose server records what the hook
      // did not.
      if (daemonHere && selfReportHttpAllowed(agent) && hookRecords(agent)) {
        chosen = { kind: "http", url: selfReportHttpUrl(settings.port, agent) };
      } else {
        if (cliPath === undefined) cliPath = (opts.deps?.resolveCliPath ?? resolveSelfReportCliPath)();
        if (cliPath) chosen = { kind: "stdio", command: cliPath, args: selfReportStdioArgs(agent) };
      }
      return chosen;
    };

    for (const path of paths) {
      // No hooks detected (user scope), but our entry is already in this file:
      // keep it and repair its transport. A file without ours is left alone.
      let wantIt = agentHooked;
      if (enabled && !wantIt) {
        let owned = false;
        try {
          owned = existsSync(path) && opsFor(target, path).current().state === "ours";
        } catch {
          owned = false;
        }
        if (!owned) {
          results.push({ agent, path, action: "skipped", transport: null, status: "not-hooked" });
          continue;
        }
        wantIt = true;
      }
      const transport = wantIt ? transportFor() : null;
      if (wantIt && !transport) {
        results.push({
          agent, path, action: "skipped", transport: null, status: "error",
          detail: "no daemon is answering here and the failproofai CLI was not found for stdio",
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

/** Remove our entries from every agent (or `agents`), whatever the settings say. Needs no live check. */
export function removeSelfReportMcp(opts: Omit<SyncSelfReportMcpOptions, "enabled"> = {}): SelfReportMcpResult[] {
  const results = applySelfReportMcp({ ...opts, enabled: false }, false, false);
  logSelfReportSync(results);
  return results;
}

/** Whether a sync changed any agent's file. */
export function selfReportSyncChanged(results: readonly SelfReportMcpResult[]): boolean {
  return results.some((r) => r.action === "added" || r.action === "updated" || r.action === "removed");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What to do when cursor-agent has not loaded the server yet. */
export const SELF_REPORT_CURSOR_APPROVAL_HINT =
  "cursor-agent: if `cursor-agent mcp list` shows failproofai_local as needing approval, run `cursor-agent mcp enable failproofai_local`";

/** One line per change, conflict or error; nothing for an agent left as it was. */
export function selfReportSyncLines(results: readonly SelfReportMcpResult[]): string[] {
  const out: string[] = [];
  for (const r of results) {
    const name = displayName(r.agent);
    if (r.action === "added" || r.action === "updated") {
      out.push(`✓ Self Reports MCP server ${r.action === "added" ? "added to" : "updated in"} ${name} (${r.transport}): ${r.path}`);
      if (r.agent === "cursor") out.push(`  ${SELF_REPORT_CURSOR_APPROVAL_HINT}`);
    } else if (r.action === "removed") {
      out.push(`✓ Self Reports MCP server removed from ${name}: ${r.path}`);
    } else if (r.status === "conflict" || r.status === "error") {
      out.push(`! ${name}: Self Reports MCP server not changed in ${r.path || "its config"}: ${r.detail ?? r.status}`);
    }
  }
  return out;
}

/** The distinct agents among `results` that match `pick`, in order. */
function agentsWhere(results: readonly SelfReportMcpResult[], pick: (r: SelfReportMcpResult) => boolean): IntegrationType[] {
  const out: IntegrationType[] = [];
  for (const r of results) if (pick(r) && !out.includes(r.agent)) out.push(r.agent);
  return out;
}

/** Agents a sync left registered (any transport, Pi's extension included). */
export function selfReportRegisteredAgents(results: readonly SelfReportMcpResult[]): IntegrationType[] {
  return agentsWhere(results, (r) => r.status === "ok" && r.action !== "removed" && r.transport !== null);
}

/** Agents a sync could not update (an error, or a `failproofai_local` that is not ours). */
export function selfReportFailedAgents(results: readonly SelfReportMcpResult[]): IntegrationType[] {
  return agentsWhere(results, (r) => r.status === "error" || r.status === "conflict");
}

/**
 * The one line every command but `sync` and `status` prints about Self
 * Reports, or null for nothing to say. `state` is the setting
 * (`selfReportSettingsState`), or `removed` for a command that took the
 * entries out of the agents it unhooked. A failure is named in the same line.
 */
export function selfReportSummaryLine(
  results: readonly SelfReportMcpResult[],
  state: "on" | "off" | "waiting" | "unreadable" | "removed",
): string | null {
  const s = selfReportSummary(results, state);
  if (!s) return null;
  return s.ok ? `✓ ${s.text}` : `▲ ${s.text}  ·  ${s.fix}`;
}

/** `selfReportSummaryLine` before it is drawn: for a caller with its own screen kit. */
export function selfReportSummary(
  results: readonly SelfReportMcpResult[],
  state: "on" | "off" | "waiting" | "unreadable" | "removed",
): { ok: boolean; text: string; fix?: string } | null {
  const failed = selfReportFailedAgents(results).map(displayName);
  const n = (k: number) => `${k} ${k === 1 ? "agent" : "agents"}`;
  let text: string | null;
  if (state === "on") {
    const on = selfReportRegisteredAgents(results).length;
    text = on > 0 ? `Self Reports: on for ${n(on)}` : null;
  } else if (state === "removed") {
    const removed = agentsWhere(results, (r) => r.action === "removed").length;
    text = removed > 0 ? `Self Reports: removed from ${n(removed)}` : null;
  } else {
    text = state === "waiting" ? "Self Reports: off until Cloud sends this machine's setting" : "Self Reports: off";
  }
  if (failed.length === 0) return text ? { ok: true, text } : null;
  const problem = `not updated for ${failed.join(", ")}`;
  return { ok: false, text: text ? `${text}; ${problem}` : `Self Reports: ${problem}`, fix: "failproofai self-report sync" };
}

/**
 * The daemon-log summary of one sync: `added claude (http), cursor (stdio);
 * removed pi; failed codex (reason)`, or null when nothing changed or failed.
 * Agents and transports only, never a path: the line can leave the machine as
 * part of its machine logs.
 */
export function selfReportSyncLogLine(results: readonly SelfReportMcpResult[]): string | null {
  const parts: string[] = [];
  const list = (action: SelfReportMcpAction) =>
    results
      .filter((r) => r.action === action)
      .map((r) => (r.transport && action !== "removed" ? `${r.agent} (${r.transport})` : r.agent))
      .filter((v, i, all) => all.indexOf(v) === i);
  for (const action of ["added", "updated", "removed"] as const) {
    const items = list(action);
    if (items.length > 0) parts.push(`${action} ${items.join(", ")}`);
  }
  const failed = results
    .filter((r) => r.status === "error" || r.status === "conflict")
    .map((r) => `${r.agent} (${r.status === "conflict" ? "another failproofai_local server is configured" : (r.detail ?? "error").slice(0, 120)})`);
  if (failed.length > 0) parts.push(`failed ${failed.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : null;
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
  /** Our entry is in this file (or, for Pi, its extension offers the tool). */
  registered: boolean;
  transport: "http" | "stdio" | "extension" | null;
  /** The URL (http) or command (stdio) our entry points at. */
  endpoint: string | null;
  /** A `failproofai_local` server that is not ours is there. */
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
    if (target.extension) {
      out.push({ agent, path: "", hooked: isHooked, registered: isHooked, transport: isHooked ? "extension" : null, endpoint: null, conflict: false });
      continue;
    }
    let paths: string[] = [];
    try {
      paths = target.paths();
    } catch (err) {
      out.push({ agent, path: "", hooked: isHooked, registered: false, transport: null, endpoint: null, conflict: false, error: errText(err) });
      continue;
    }
    for (const path of paths) {
      if (!existsSync(path)) {
        out.push({ agent, path, hooked: isHooked, registered: false, transport: null, endpoint: null, conflict: false });
        continue;
      }
      try {
        const cur = opsFor(target, path).current();
        out.push({
          agent, path, hooked: isHooked,
          registered: cur.state === "ours",
          transport: cur.state === "ours" ? transportOf(cur.entry) : null,
          endpoint: cur.state === "ours" ? endpointOf(cur.entry) : null,
          conflict: cur.state === "foreign",
        });
      } catch (err) {
        out.push({ agent, path, hooked: isHooked, registered: false, transport: null, endpoint: null, conflict: false, error: errText(err) });
      }
    }
  }
  return out;
}

