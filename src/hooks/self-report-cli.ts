/**
 * `failproofai self-report status | enable | disable | test`.
 *
 * `sync` (registering the MCP server in every agent) lives in
 * self-report-install.ts; enable/disable call it in process, and bin keeps the
 * `failproofai self-report sync --quiet` subcommand the daemon runs (contract §6).
 *
 * Returns lines and an exit code like the other `*-cli.ts` modules; bin prints
 * them.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { customAgentsEventsDir, hookActivityDir } from "./fp-home";
import {
  SELF_REPORT_DEFAULT_CATEGORIES,
  SELF_REPORT_MCP_TOOL_NAME,
  SELF_REPORT_RESULT_TEXT,
  SELF_REPORT_SERVER_RECORDS,
  readEffectiveSelfReport,
  readLocalSelfReportConfig,
  selfReportCloudManaged,
  selfReportSettingsFile,
  validateSelfReportCategories,
  validateSelfReportGuidance,
  writeEffectiveSelfReport,
  writeLocalSelfReportConfig,
  type SelfReportCategory,
} from "./self-report";
import { INTEGRATION_TYPES } from "./types";
import {
  probeSelfReportHttp,
  selfReportCommandRunnable,
  selfReportRegistrationStatus,
  selfReportSyncChanged,
  selfReportSyncLines,
  syncSelfReportMcp,
  type SelfReportRegistration,
} from "./self-report-install";

export interface SelfReportCliResult {
  exitCode: number;
  lines: string[];
}

export interface SelfReportCliDeps {
  /** argv prefix that runs this CLI: `[node, dist/cli.mjs]`. */
  cliCommand?: string[];
  /** Health probe override (tests): does the HTTP endpoint on this port answer? */
  probeEndpoint?: (url: string, port: number) => Promise<boolean>;
  /** Registration rows override (tests). */
  registrations?: () => SelfReportRegistration[];
  /** Sync override (tests). */
  sync?: () => Promise<import("./self-report-install").SelfReportMcpResult[]>;
  /** Skip the agent sync after enable/disable (tests). */
  skipSync?: boolean;
  cwd?: string;
}

const SELF_REPORT_CLOUD_REFUSAL = [
  "This machine is managed by FailproofAI Cloud, so Self Reports is set there.",
  "Turn it on or off in the dashboard: Settings > Self Reports.",
];

function selfReportCliCommand(deps: SelfReportCliDeps): string[] {
  return deps.cliCommand ?? [process.execPath, process.argv[1]];
}

/** Run the CLI as a child, feeding `stdin`; resolves with its output. */
function selfReportRunChild(
  argv: string[],
  stdin: string,
  timeoutMs: number,
  cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const [cmd, ...rest] = argv;
    const child = spawn(cmd, rest, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

/** The port of one of our endpoint URLs, or null. */
function selfReportUrlPort(url: string | null): number | null {
  if (!url) return null;
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** Probe each distinct HTTP port among the rows once. */
async function selfReportHttpHealth(rows: readonly SelfReportRegistration[], deps: SelfReportCliDeps): Promise<Map<number, boolean>> {
  const probe = deps.probeEndpoint ?? ((_url: string, port: number) => probeSelfReportHttp(port));
  const ports = new Set<number>();
  for (const r of rows) {
    const port = r.registered && r.transport === "http" ? selfReportUrlPort(r.endpoint) : null;
    if (port !== null) ports.add(port);
  }
  const health = new Map<number, boolean>();
  await Promise.all(
    [...ports].map(async (port) => health.set(port, await probe(`http://127.0.0.1:${port}/mcp`, port))),
  );
  return health;
}

/** Per-agent registration state: transport, endpoint and whether it answers. */
function selfReportRegistrationLines(rows: readonly SelfReportRegistration[], health: ReadonlyMap<number, boolean>): string[] {
  const hooked = rows.filter((r) => r.hooked || r.registered || r.conflict || r.error);
  if (hooked.length === 0) return ["Agents:     none with failproofai hooks"];
  return [
    "Agents:",
    ...hooked.map((r) => {
      let state: string;
      if (r.error) state = `unreadable (${r.error})`;
      else if (r.conflict) state = "another failproofai MCP server is configured; left alone";
      else if (r.registered && r.transport === "http") {
        const port = selfReportUrlPort(r.endpoint);
        const ok = port !== null && health.get(port) === true;
        state = `http   ${r.endpoint ?? "?"} ${ok ? "(answering)" : "(NOT answering)"}`;
      } else if (r.registered) {
        const ok = !!r.endpoint && selfReportCommandRunnable(r.endpoint);
        state = `stdio  ${r.endpoint ?? "?"} ${ok ? "(runnable)" : "(NOT runnable)"}`;
      } else state = r.hooked ? "not registered" : "registered, no hooks";
      if (r.registered && !r.hooked) state += ", no hooks";
      return `  ${r.agent.padEnd(12)} ${state}`;
    }),
  ];
}

/** Whether a row is registered over HTTP at an endpoint that is not answering. */
function selfReportStranded(r: SelfReportRegistration, health: ReadonlyMap<number, boolean>): boolean {
  if (!r.registered || r.transport !== "http") return false;
  const port = selfReportUrlPort(r.endpoint);
  return port === null || health.get(port) !== true;
}

async function selfReportStatus(deps: SelfReportCliDeps): Promise<SelfReportCliResult> {
  const settings = readEffectiveSelfReport();
  const cloud = await selfReportCloudManaged();
  const lines: string[] = [];
  if (!settings) {
    lines.push("Self Reports: off (no settings file)");
    lines.push(`Settings:   ${selfReportSettingsFile()}`);
    lines.push(cloud ? "Managed by: FailproofAI Cloud" : "Turn on:    `failproofai self-report enable`");
    return { exitCode: 0, lines };
  }
  lines.push(`Self Reports: ${settings.enabled ? "on" : "off"}`);
  lines.push(`Source:     ${settings.source === "cloud" ? "FailproofAI Cloud" : "this machine (config.json)"}`);
  lines.push(`Settings:   ${selfReportSettingsFile()}`);
  if (settings.updatedAt) lines.push(`Updated:    ${settings.updatedAt}`);
  lines.push(`Categories: ${settings.categories.map((c) => c.name).join(", ")}`);
  if (settings.guidance) lines.push(`Guidance:   ${settings.guidance.length > 60 ? `${settings.guidance.slice(0, 57)}...` : settings.guidance}`);
  const readRows = deps.registrations ?? (() => selfReportRegistrationStatus());
  let rows = readRows();
  let health = await selfReportHttpHealth(rows, deps);
  // An agent left on the daemon's HTTP endpoint after the daemon died would
  // have no report tool. Move it (live check: stdio unless a daemon answers).
  if (settings.enabled && !deps.skipSync && rows.some((r) => selfReportStranded(r, health))) {
    try {
      const results = await (deps.sync ?? (() => syncSelfReportMcp({ quiet: true })))();
      if (selfReportSyncChanged(results)) {
        lines.push("Repaired:   agents pointed at an HTTP endpoint that is not answering were re-synced:");
        lines.push(...selfReportSyncLines(results).map((l) => `  ${l}`));
        rows = readRows();
        health = await selfReportHttpHealth(rows, deps);
      }
    } catch {
      lines.push("▲ Could not re-sync agents whose HTTP endpoint is not answering. Run `failproofai self-report sync`.");
    }
  }
  if (!health.has(settings.mcp.port)) {
    const probe = deps.probeEndpoint ?? ((_url: string, port: number) => probeSelfReportHttp(port));
    health.set(settings.mcp.port, await probe(settings.mcp.url, settings.mcp.port));
  }
  lines.push(`Daemon MCP: ${settings.mcp.url} (${health.get(settings.mcp.port) ? "answering" : "not answering"})`);
  lines.push(...selfReportRegistrationLines(rows, health));
  return { exitCode: 0, lines };
}

/** Update every hooked agent's MCP entry to match the settings just written. */
async function selfReportSync(deps: SelfReportCliDeps): Promise<string[]> {
  if (deps.skipSync) return [];
  try {
    const results = await (deps.sync ?? (() => syncSelfReportMcp({ quiet: true })))();
    if (results.some((r) => r.status === "error")) {
      return ["▲ Could not update every agent's MCP settings. Run `failproofai self-report sync` to see why."];
    }
    return selfReportSyncChanged(results) ? ["Agents updated."] : [];
  } catch {
    return ["▲ Could not update your agents' MCP settings. Run `failproofai self-report sync` to see why."];
  }
}

function selfReportFlag(args: string[], name: string): { value?: string; error?: string } {
  const i = args.indexOf(name);
  if (i < 0) return {};
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return { error: `Missing value after ${name}.` };
  return { value: v };
}

async function selfReportEnable(args: string[], deps: SelfReportCliDeps): Promise<SelfReportCliResult> {
  const known = new Set(["--categories-file", "--guidance"]);
  const unknown = args.find((a, i) => a.startsWith("-") && !known.has(a) && !known.has(args[i - 1]));
  if (unknown) return { exitCode: 1, lines: [`Unexpected argument: ${unknown}.`] };
  const stray = args.find((a, i) => !a.startsWith("-") && !known.has(args[i - 1]));
  if (stray) return { exitCode: 1, lines: [`Unexpected argument: ${stray}.`] };
  if (await selfReportCloudManaged()) return { exitCode: 1, lines: SELF_REPORT_CLOUD_REFUSAL };

  const file = selfReportFlag(args, "--categories-file");
  const guid = selfReportFlag(args, "--guidance");
  if (file.error) return { exitCode: 1, lines: [file.error] };
  if (guid.error) return { exitCode: 1, lines: [guid.error] };

  const previous = await readLocalSelfReportConfig();
  let categories: SelfReportCategory[] | undefined = previous?.categories;
  if (file.value) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file.value, "utf8"));
    } catch (err) {
      return { exitCode: 1, lines: [`Could not read ${file.value}: ${err instanceof Error ? err.message : String(err)}`] };
    }
    // A bare list, or `{ "categories": [...] }` (the shape of the org setting).
    const list = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).categories : parsed;
    const checked = validateSelfReportCategories(list);
    if (!checked.ok) return { exitCode: 1, lines: [`${file.value}: ${checked.error}`] };
    categories = checked.value;
  }
  let guidance: string | undefined = previous?.guidance;
  if (guid.value !== undefined) {
    const checked = validateSelfReportGuidance(guid.value);
    if (!checked.ok) return { exitCode: 1, lines: [checked.error] };
    guidance = checked.value ?? undefined;
  }

  await writeLocalSelfReportConfig({ enabled: true, categories, guidance });
  const written = writeEffectiveSelfReport({ enabled: true, categories, guidance });
  const lines = [
    "✓ Self Reports is on.",
    `  Categories: ${written.categories.map((c) => c.name).join(", ")}${categories ? "" : " (defaults)"}`,
    `  Settings:   ${selfReportSettingsFile()}`,
    ...(await selfReportSync(deps)).map((l) => (l.startsWith("▲") ? l : `  ${l}`)),
  ];
  return { exitCode: 0, lines };
}

async function selfReportDisable(args: string[], deps: SelfReportCliDeps): Promise<SelfReportCliResult> {
  if (args.length > 0) return { exitCode: 1, lines: [`Unexpected argument: ${args[0]}.`] };
  if (await selfReportCloudManaged()) return { exitCode: 1, lines: SELF_REPORT_CLOUD_REFUSAL };
  const previous = await readLocalSelfReportConfig();
  // The category list and guidance are kept, so turning it back on restores them.
  await writeLocalSelfReportConfig({ enabled: false, categories: previous?.categories, guidance: previous?.guidance });
  writeEffectiveSelfReport({ enabled: false, categories: previous?.categories, guidance: previous?.guidance });
  return {
    exitCode: 0,
    lines: ["✓ Self Reports is off.", ...(await selfReportSync(deps)).map((l) => (l.startsWith("▲") ? l : `  ${l}`))],
  };
}

const SELF_REPORT_TEST_DETAIL = "failproofai self-report test: this is a test report, not a real problem.";

async function selfReportTest(args: string[], deps: SelfReportCliDeps): Promise<SelfReportCliResult> {
  const agentFlag = selfReportFlag(args, "--agent");
  if (agentFlag.error || !agentFlag.value) {
    return { exitCode: 1, lines: ["Missing --agent <agent>.", `Agents: ${INTEGRATION_TYPES.join(", ")}`] };
  }
  const agent = agentFlag.value;
  if (!(INTEGRATION_TYPES as readonly string[]).includes(agent)) {
    return { exitCode: 1, lines: [`Not an agent: ${agent}.`, `Agents: ${INTEGRATION_TYPES.join(", ")}`] };
  }
  const settings = readEffectiveSelfReport();
  if (!settings?.enabled) {
    return { exitCode: 1, lines: ["Self Reports is off, so there is nothing to test.", "Turn it on with `failproofai self-report enable`."] };
  }
  const category = settings.categories[0]?.name ?? SELF_REPORT_DEFAULT_CATEGORIES[0].name;
  const cwd = deps.cwd ?? process.cwd();
  const cli = selfReportCliCommand(deps);

  if (SELF_REPORT_SERVER_RECORDS.includes(agent)) {
    // This agent's hooks do not see MCP calls: the MCP server records. Drive
    // the stdio server exactly as the agent would.
    const dir = customAgentsEventsDir();
    const before = new Set(selfReportListDir(dir));
    const stdin = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "failproofai-self-report-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "report", arguments: { category, detail: SELF_REPORT_TEST_DETAIL } } },
    ]
      .map((m) => JSON.stringify(m))
      .join("\n");
    const run = await selfReportRunChild([...cli, "mcp", "--agent", agent], `${stdin}\n`, 20_000, cwd);
    const answered = run.stdout.includes(SELF_REPORT_RESULT_TEXT);
    const landed = selfReportListDir(dir).filter((f) => !before.has(f) && f.endsWith(".jsonl"));
    const hit = landed.find((f) => {
      try {
        return readFileSync(join(dir, f), "utf8").includes(SELF_REPORT_TEST_DETAIL);
      } catch {
        return false;
      }
    });
    if (!answered || !hit) {
      return {
        exitCode: 1,
        lines: [
          `✕ The test report for ${agent} did not land.`,
          `  MCP server ${answered ? "answered Recorded." : "did not answer"}${run.stderr.trim() ? `: ${run.stderr.trim().split("\n").pop()}` : ""}`,
        ],
      };
    }
    // Possibly consumed by a running collector between write and read; the
    // name is what we report.
    return {
      exitCode: 0,
      lines: [
        `✓ Test report from ${agent} recorded by the MCP server.`,
        `  Event file: ${join(dir, hit)}`,
        "  The collector uploads it to FailproofAI Cloud when this machine is connected.",
      ],
    };
  }

  // Hook-recorded agent: send the PreToolUse hook the agent would send, through
  // the same `--hook` entry point (and so the daemon, when it is configured).
  const sessionId = `failproofai-self-report-test-${Date.now()}`;
  const payload = {
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: SELF_REPORT_MCP_TOOL_NAME,
    tool_input: { category, detail: SELF_REPORT_TEST_DETAIL },
    cwd,
  };
  const run = await selfReportRunChild([...cli, "--hook", "PreToolUse", "--cli", agent], JSON.stringify(payload), 30_000, cwd);
  const file = join(hookActivityDir(), "current.jsonl");
  let row: Record<string, unknown> | undefined;
  try {
    row = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.includes(sessionId))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .pop();
  } catch {
    row = undefined;
  }
  if (run.code !== 0 || !row || !row.selfReport || row.decision !== "allow") {
    return {
      exitCode: 1,
      lines: [
        `✕ The test report for ${agent} did not land.`,
        `  Hook exit code: ${run.code ?? "none"}${row ? `, decision: ${String(row.decision)}` : ", no activity row"}`,
        ...(run.stderr.trim() ? [`  ${run.stderr.trim().split("\n").pop()}`] : []),
      ],
    };
  }
  return {
    exitCode: 0,
    lines: [
      `✓ Test report from ${agent} allowed and recorded by the hook.`,
      `  Activity row: ${file} (session ${sessionId})`,
      "  The collector uploads it to FailproofAI Cloud as a self_report event when this machine is connected.",
    ],
  };
}

function selfReportListDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export async function runSelfReportCommand(args: string[], deps: SelfReportCliDeps = {}): Promise<SelfReportCliResult> {
  const [verb, ...rest] = args;
  try {
    switch (verb) {
      case "status":
        if (rest.length > 0) return { exitCode: 1, lines: [`Unexpected argument: ${rest[0]}.`] };
        return await selfReportStatus(deps);
      case "enable":
        return await selfReportEnable(rest, deps);
      case "disable":
        return await selfReportDisable(rest, deps);
      case "test":
        return await selfReportTest(rest, deps);
      default:
        return { exitCode: 1, lines: [verb ? `Unknown self-report command: ${verb}.` : "Missing self-report command.", "Use status, enable, disable or test."] };
    }
  } catch (err) {
    return { exitCode: 1, lines: [`✕ ${err instanceof Error ? err.message : String(err)}`] };
  }
}
