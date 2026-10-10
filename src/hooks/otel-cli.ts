/** Opt-in agent setup; no OTLP translation or changes to the events uploader. */
import {
  chmodSync, existsSync, mkdirSync, readFileSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { connect } from "node:net";
import { readConfig, readCredentials } from "./fp-config";
import { configFile, otelAgentStateFile, otlpHealthFile } from "./fp-home";
import { writeConfigFileAtomic } from "./safe-config-write";
import { agentSessionsEnabled } from "./collector-config";
import { introspectKey } from "./cloud-introspect";
import { readJsonFile } from "./integrations";
import { selectOne } from "./tui";
import {
  AGENT_LABELS, OTEL_AGENTS, agentConfigPath, agentOtelWrites, editAgentConfig,
  getSetting, parseAgentConfig, vscodeInstalled,
  type JsonObject, type OtelAgent, type SettingWrite,
} from "./otel-writers";

export const OTEL_ORG_OFF = "OTEL ingest is off for your org. An admin can turn it on in Settings → OpenTelemetry.";
export const OTEL_WIZARD_QUESTION = "Also send OpenTelemetry from agents? (Gemini CLI, Copilot, or switch Claude Code / Codex)";
export interface OtelResult {
  lines: string[];
  exitCode: number;
  events?: { name: "otel_enabled" | "otel_disabled"; agent: OtelAgent; local: boolean; content: boolean }[];
}
interface AgentRecord {
  file: string;
  local: boolean;
  content: boolean;
  destination: string;
  keys: { path: string[]; hadPrevious: boolean; previous?: unknown; private?: boolean }[];
  previousSessions?: boolean;
  switchedSessions: boolean;
}
interface PrivateState {
  original: string | null;
  originalMode?: number;
  writtenHash: string;
  previous: SettingWrite[];
}
export interface OtelOptions {
  home?: string;
  fetchImpl?: typeof fetch;
  confirm?: (question: string) => Promise<boolean>;
  onEvent?: (name: string, properties: { agent: OtelAgent; local: boolean; content: boolean }) => void | Promise<void>;
}

function rawConfig(): JsonObject {
  return readJsonFile(configFile());
}
function object(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OTEL configuration object.");
  return value as JsonObject;
}
function records(raw: JsonObject): Partial<Record<OtelAgent, AgentRecord>> {
  return object(object(raw.otel).agents) as Partial<Record<OtelAgent, AgentRecord>>;
}
function saveConfig(raw: JsonObject): void {
  writeConfigFileAtomic(configFile(), `${JSON.stringify(raw, null, 2)}\n`, { backup: false });
}
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function privateState(agent: OtelAgent): PrivateState {
  return JSON.parse(readFileSync(otelAgentStateFile(agent), "utf8")) as PrivateState;
}
function credential(): { key: string; origin: string } {
  const ingest = readCredentials().ingest;
  const key = process.env.FAILPROOFAI_INGEST_KEY || ingest?.key;
  if (!key) throw new Error("No Cloud API key configured. Run `failproofai config` first.");
  const url = new URL(process.env.FAILPROOFAI_INGEST_URL || ingest?.url || "https://app.befailproof.ai");
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Cloud ingest URL.");
  return { key, origin: url.origin };
}
function backupOnce(path: string, original: string | null): void {
  if (existsSync(`${path}.failproofai-bak`)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.failproofai-bak`, original ?? "", { flag: "wx", mode: 0o600 });
  chmodSync(`${path}.failproofai-bak`, 0o600);
}
function savePrivate(agent: OtelAgent, state: PrivateState): void {
  const path = otelAgentStateFile(agent);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeConfigFileAtomic(path, JSON.stringify(state), { backup: false, mode: 0o600 });
  chmodSync(path, 0o600);
}
function configureRelay(raw: JsonObject): void {
  const collector = object(raw.collector);
  raw.collector = collector;
  const local = Object.values(records(raw)).some(record => record?.local);
  if (local) collector.otlp = { ...object(collector.otlp), enabled: true };
  else if (collector.otlp) collector.otlp = { ...object(collector.otlp), enabled: false };
}
function hasExternalOtel(agent: OtelAgent, config: JsonObject): boolean {
  if (agent === "claude") return getSetting(config, ["env", "CLAUDE_CODE_ENABLE_TELEMETRY"]) === "1";
  if (agent === "codex") {
    return ["exporter", "trace_exporter", "metrics_exporter"].some(k => {
      const value = getSetting(config, ["otel", k]);
      return value !== undefined && value !== "none" && value !== "statsig";
    });
  }
  return getSetting(config, agent === "gemini" ? ["telemetry", "enabled"] : ["github.copilot.chat.otel.enabled"]) === true;
}
async function defaultConfirm(question: string): Promise<boolean> {
  return await selectOne({
    message: question,
    choices: [
      { label: "No", value: false, hint: "keep transcript upload" },
      { label: "Yes", value: true, hint: "switch this agent to OTEL" },
    ],
  }) === true;
}
export async function chooseWizardOtel(
  choose: (question: string) => Promise<boolean> = defaultConfirm,
): Promise<boolean> {
  return choose(OTEL_WIZARD_QUESTION);
}
function restoreAgent(agent: OtelAgent, raw: JsonObject): void {
  const all = records(raw);
  const record = all[agent];
  if (!record) return;
  const state = privateState(agent);
  if (existsSync(record.file)) {
    const current = readFileSync(record.file, "utf8");
    if (digest(current) === state.writtenHash) {
      if (state.original === null) unlinkSync(record.file);
      else writeConfigFileAtomic(record.file, state.original, { backup: false, mode: state.originalMode });
    } else {
      const restored = editAgentConfig(current, agent, state.previous);
      writeConfigFileAtomic(record.file, restored, { backup: false, mode: state.originalMode });
    }
  }
  if (record.switchedSessions) {
    const collector = object(raw.collector);
    const agents = object(collector.agents);
    const settings = object(agents[agent]);
    if (record.previousSessions === undefined) delete settings.sessions;
    else settings.sessions = record.previousSessions;
    if (Object.keys(settings).length) agents[agent] = settings;
    else delete agents[agent];
    if (Object.keys(agents).length) collector.agents = agents;
    else delete collector.agents;
  }
  delete all[agent];
  object(raw.otel).agents = all;
}
async function enableAgent(agent: OtelAgent, yes: boolean, localFlag: boolean, content: boolean, options: OtelOptions): Promise<OtelResult> {
  const { key, origin } = credential();
  const raw = rawConfig();
  const previousConfig = structuredClone(raw);
  const file = agentConfigPath(agent, options.home ?? homedir());
  if (agent === "copilot" && !vscodeInstalled(options.home ?? homedir())) {
    return { lines: ["VS Code not found — skipping copilot"], exitCode: 0 };
  }
  const existing = records(raw)[agent];
  // Gemini has no transcript source in this collector.
  const transcriptsEnabled = agent !== "gemini" && agentSessionsEnabled(agent);
  if (!existing && transcriptsEnabled && !yes) {
    const question = `failproofai already sends ${AGENT_LABELS[agent]} sessions to Cloud. Send them with OTEL instead? Transcript upload for ${AGENT_LABELS[agent]} stops.`;
    if (!await (options.confirm ?? defaultConfirm)(question)) return { lines: [`${AGENT_LABELS[agent]} unchanged (default No).`], exitCode: 0 };
  }
  const local = localFlag || agent === "gemini" || agent === "copilot";
  const port = readConfig().collector.otlp?.port ?? 4318;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("collector.otlp.port must be between 1 and 65535.");
  const destination = local ? `http://127.0.0.1:${port}` : origin;
  const original = existsSync(file) ? readFileSync(file, "utf8") : null;
  const parsed = parseAgentConfig(original ?? "", agent);
  const writes = agentOtelWrites(agent, destination, key, local, content);
  // Switching from Cloud to local stops owning header keys. Restore any keys
  // from an earlier enable before applying the new (header-free) write set.
  const oldState = existing ? privateState(agent) : null;
  const released = oldState?.previous.filter(previous =>
    !writes.some(write => JSON.stringify(write.path) === JSON.stringify(previous.path))) ?? [];
  const next = editAgentConfig(original ?? "", agent, [...released, ...writes]);
  // On repeated enable keep the ORIGINAL previous values, not our last write.
  const state = oldState ?? {
    original,
    originalMode: original === null ? undefined : statSync(file).mode & 0o777,
    writtenHash: "",
    previous: writes.map(w => ({ path: w.path, value: getSetting(parsed, w.path) })),
  };
  if (existing && original !== null && digest(original) !== state.writtenHash) {
    // Re-enabling must not turn the fast byte-restore path into permission to
    // discard changes made after the previous enable.
    state.original = editAgentConfig(original, agent, state.previous);
  }
  if (existing) {
    state.previous = writes.map(write => state.previous.find(previous =>
      JSON.stringify(previous.path) === JSON.stringify(write.path)) ??
      { path: write.path, value: getSetting(parsed, write.path) });
  }
  const collector = object(raw.collector);
  const agents = object(collector.agents);
  const previousSessions = object(agents[agent]).sessions as boolean | undefined;
  const record: AgentRecord = {
    file, local, content, destination,
    keys: state.previous.map(w => ({
      path: w.path,
      hadPrevious: w.value !== undefined,
      // Prior agent credentials belong in owner-only state, never config.json.
      ...(w.path.some(k => /headers|exporter/i.test(k)) ? { private: true } : { previous: w.value }),
    })),
    previousSessions: existing ? existing.previousSessions : previousSessions,
    switchedSessions: existing ? existing.switchedSessions : transcriptsEnabled,
  };
  if (record.switchedSessions) {
    agents[agent] = { ...object(agents[agent]), sessions: false };
    collector.agents = agents;
  }
  raw.collector = collector;
  const otel = object(raw.otel);
  otel.agents = { ...records(raw), [agent]: record };
  raw.otel = otel;
  configureRelay(raw);
  // Recovery state and one-time backup precede the first agent-file write.
  backupOnce(file, original);
  savePrivate(agent, { ...state, writtenHash: digest(next) });
  try {
    // Publish ownership BEFORE the agent settings so a killed CLI can always
    // disable/restore what it wrote, including the one-path transcript choice.
    saveConfig(raw);
    writeConfigFileAtomic(file, next, { backup: false, mode: 0o600 });
    // Agent files now contain a credential, even if previously world-readable.
    chmodSync(file, 0o600);
  } catch (err) {
    if (original !== null) writeConfigFileAtomic(file, original, { backup: false, mode: state.originalMode });
    else if (existsSync(file)) unlinkSync(file);
    saveConfig(previousConfig);
    throw err;
  }
  const lines = [`${AGENT_LABELS[agent]} OTEL enabled → ${local ? "local relay" : "Cloud"} (${content ? "text capture on" : "no content"}).`];
  if (local && !localFlag) lines.push(`${AGENT_LABELS[agent]} settings cannot carry an auth header; using the local relay automatically.`);
  if (local) lines.push("The daemon picks this up within seconds — no restart. Use `failproofai otel status` to check the relay.");
  const result = await introspectKey(origin, key, options.fetchImpl, 3000);
  if (result.kind === "ok" && result.identity.otelIngest === false) lines.push(OTEL_ORG_OFF);
  await options.onEvent?.("otel_enabled", { agent, local, content });
  return { lines, exitCode: 0, events: [{ name: "otel_enabled", agent, local, content }] };
}
function relayListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(200);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}
async function status(options: OtelOptions): Promise<OtelResult> {
  let org = "unknown";
  try {
    const { origin, key } = credential();
    const result = await introspectKey(origin, key, options.fetchImpl, 3000);
    if (result.kind === "ok" && result.identity.otelIngest !== undefined) org = result.identity.otelIngest ? "on" : "off";
  } catch { /* Status works on an unconfigured machine too. */ }
  const all = records(rawConfig());
  const lines = [`Org OTEL ingest: ${org}`];
  for (const agent of OTEL_AGENTS) {
    const record = all[agent];
    let parsed: JsonObject = {};
    let unreadable = false;
    try {
      const file = record?.file ?? agentConfigPath(agent, options.home ?? homedir());
      if (existsSync(file)) parsed = parseAgentConfig(readFileSync(file, "utf8"), agent);
    } catch { unreadable = true; }
    const on = hasExternalOtel(agent, parsed);
    let managed = false;
    if (record && on) {
      try {
        const state = privateState(agent);
        const expected = parseAgentConfig(editAgentConfig(state.original ?? "", agent,
          agentOtelWrites(agent, record.destination, credential().key, record.local, record.content)), agent);
        managed = record.keys.every(k => JSON.stringify(getSetting(parsed, k.path)) === JSON.stringify(getSetting(expected, k.path)));
      } catch { /* Missing recovery state or key. */ }
    }
    const dest = record?.destination ?? getSetting(parsed, agent === "claude" ? ["env", "OTEL_EXPORTER_OTLP_ENDPOINT"] :
      agent === "gemini" ? ["telemetry", "otlpEndpoint"] :
      agent === "copilot" ? ["github.copilot.chat.otel.otlpEndpoint"] : ["otel", "exporter", "otlp-http", "endpoint"]);
    const destination = dest ? `${record?.local || String(dest).startsWith("http://127.0.0.1:") ? "local relay" : "Cloud"} (${dest})` : "none";
    lines.push(`${AGENT_LABELS[agent]}: ${unreadable ? "unreadable settings" : on ? managed ? "on by failproofai" : "on, not managed" : "off"} · destination: ${destination} · org: ${org}`);
  }
  let health: JsonObject = {};
  try { health = JSON.parse(readFileSync(otlpHealthFile(), "utf8")) as JsonObject; } catch { /* No relay yet. */ }
  const requested = readConfig().collector.otlp?.enabled === true;
  const live = requested && health.relay === "listening" && await relayListening(readConfig().collector.otlp?.port ?? 4318);
  lines.push(`Relay: ${live ? "listening on 127.0.0.1" : requested ? health.relay === "port_busy" ? "off (port busy)" : "off (daemon not listening)" : "off"} · last upload: ${health.last_upload ?? "none"}`);
  return { lines, exitCode: 0 };
}

export async function runOtelCommand(args: string[], options: OtelOptions = {}): Promise<OtelResult> {
  try {
    const [verb, ...rest] = args;
    const flags = new Set(verb === "enable" ? ["--local", "--no-content", "--yes"] : verb === "env" ? ["--local", "--service"] : []);
    const unexpected = rest.find((arg, i) => arg.startsWith("-") && !flags.has(arg) && rest[i - 1] !== "--service");
    if (unexpected) throw new Error(`Unexpected argument: ${unexpected}`);
    if (verb === "status") {
      if (rest.length) throw new Error("status takes no arguments.");
      return await status(options);
    }
    if (verb === "env") {
      const { origin, key } = credential();
      const index = rest.indexOf("--service");
      const service = index >= 0 ? rest[index + 1] : "my-agent";
      if (!service || service.startsWith("-")) throw new Error("Missing value after --service.");
      const consumed = rest.filter((_, i) => i !== index && i !== index + 1 || index < 0).filter(x => x !== "--local");
      if (consumed.length) throw new Error("env takes only --service <name> and --local.");
      const local = rest.includes("--local");
      const endpoint = local ? `http://127.0.0.1:${readConfig().collector.otlp?.port ?? 4318}` : origin;
      const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const values = {
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        ...(!local ? { OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${encodeURIComponent(key)}` } : {}),
        OTEL_SERVICE_NAME: service,
      };
      return { lines: Object.entries(values).map(([k, v]) => `export ${k}=${quote(v)}`), exitCode: 0 };
    }
    if (verb !== "enable" && verb !== "disable") throw new Error("Expected status, enable, disable or env. Run `failproofai otel --help`.");
    const target = rest[0];
    if (!target || (target !== "all" && !OTEL_AGENTS.includes(target as OtelAgent))) throw new Error(`Choose an agent: ${OTEL_AGENTS.join(", ")}, all.`);
    if (rest.slice(1).some(x => !flags.has(x))) throw new Error("Unexpected positional argument.");
    const agents = target === "all" ? [...OTEL_AGENTS] : [target as OtelAgent];
    const result: OtelResult = { lines: [], exitCode: 0, events: [] };
    for (const agent of agents) {
      if (verb === "enable") {
        const enabled = await enableAgent(agent, rest.includes("--yes"), rest.includes("--local"), !rest.includes("--no-content"), options);
        result.lines.push(...enabled.lines);
        result.events?.push(...enabled.events ?? []);
      } else {
        const raw = rawConfig();
        const record = records(raw)[agent];
        if (!record) { result.lines.push(`${AGENT_LABELS[agent]}: no managed OTEL settings.`); continue; }
        restoreAgent(agent, raw);
        configureRelay(raw);
        saveConfig(raw);
        unlinkSync(otelAgentStateFile(agent));
        result.lines.push(`${AGENT_LABELS[agent]} OTEL disabled; previous settings restored.`);
        await options.onEvent?.("otel_disabled", { agent, local: record.local, content: record.content });
        result.events?.push({ name: "otel_disabled", agent, local: record.local, content: record.content });
      }
    }
    return result;
  } catch (err) {
    return { lines: [err instanceof Error ? err.message : String(err)], exitCode: 1 };
  }
}
