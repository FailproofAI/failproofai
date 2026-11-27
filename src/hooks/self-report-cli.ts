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
import { basename, dirname, join } from "node:path";
import { customAgentsEventsDir, hookActivityDir } from "./fp-home";
import {
  SELF_REPORT_DEFAULT_CATEGORIES,
  SELF_REPORT_MCP_TOOL_NAME,
  SELF_REPORT_RESULT_TEXT,
  SELF_REPORT_SERVER_NAME,
  SELF_REPORT_SERVER_RECORDS,
  SELF_REPORT_TOOL_NAME,
  readEffectiveSelfReport,
  readLocalSelfReportConfig,
  resolveSelfReport,
  selfReportCloudEnrolled,
  selfReportCloudManaged,
  selfReportSettingsFile,
  validateSelfReportCategories,
  validateSelfReportGuidance,
  writeEffectiveSelfReport,
  writeLocalSelfReportConfig,
  type SelfReportCategory,
} from "./self-report";
import { INTEGRATION_TYPES } from "./types";
import { daemonSocketPresent, isDaemonConfigured } from "./daemon-client";
import { SELF_REPORT_RECEIPT_ENV, SELF_REPORT_RECEIPT_PREFIX } from "./self-report-mcp";
import {
  SELF_REPORT_HOOK_RECORDED_AGENTS,
  claudeHooksBlockedReason,
  codexReportHookRuns,
  selfReportHookState,
  type SelfReportHookState,
} from "./self-report-hook-trust";
import {
  SELF_REPORT_CURSOR_APPROVAL_HINT,
  probeSelfReportHttp,
  selfReportDaemonLive,
  selfReportHttpAllowed,
  selfReportCommandRunnable,
  selfReportRegistrationStatus,
  selfReportSyncChanged,
  selfReportSummaryLine,
  selfReportSyncLines,
  syncSelfReportMcp,
  type SelfReportRegistration,
} from "./self-report-install";

export interface SelfReportCliResult {
  exitCode: number;
  lines: string[];
  /** `status --json`: printed as JSON instead of the lines. */
  json?: unknown;
}

export interface SelfReportCliDeps {
  /** argv prefix that runs this CLI: `[node, dist/cli.mjs]`. */
  cliCommand?: string[];
  /** Health probe override (tests): does the HTTP endpoint on this port answer? */
  probeEndpoint?: (url: string, port: number) => Promise<boolean>;
  /** Ownership override (tests): is the endpoint on this port this home's daemon? (`selfReportDaemonLive`) */
  daemonLive?: (port: number) => Promise<boolean>;
  /** Registration rows override (tests). */
  registrations?: () => SelfReportRegistration[];
  /** Sync override (tests). */
  sync?: () => Promise<import("./self-report-install").SelfReportMcpResult[]>;
  /** Override (tests): is a daemon configured here, or its socket file present? */
  daemonExpected?: () => boolean;
  /** Who records a hook-recorded agent's reports (tests; default `selfReportHookState`). */
  hookState?: (agent: string) => SelfReportHookState;
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
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const [cmd, ...rest] = argv;
    const child = spawn(cmd, rest, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...extraEnv } });
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

/**
 * For each answering port, whether it is THIS home's daemon that answers
 * (`selfReportDaemonLive`): a name-only answer may be another user's or
 * another FAILPROOFAI_HOME's daemon, which would record reports under its
 * own home and credentials.
 */
async function selfReportHttpOwnership(health: ReadonlyMap<number, boolean>, deps: SelfReportCliDeps): Promise<Map<number, boolean>> {
  const live = deps.daemonLive ?? selfReportDaemonLive;
  const owned = new Map<number, boolean>();
  await Promise.all(
    [...health].filter(([, answering]) => answering).map(async ([port]) => owned.set(port, await live(port))),
  );
  return owned;
}

/** Per-agent registration state: transport, endpoint and whether it answers. */
function selfReportRegistrationLines(
  rows: readonly SelfReportRegistration[],
  health: ReadonlyMap<number, boolean>,
  owned: ReadonlyMap<number, boolean>,
  recorders: ReadonlyMap<string, SelfReportHookState> = new Map(),
): string[] {
  const hooked = rows.filter((r) => r.hooked || r.registered || r.conflict || r.error);
  if (hooked.length === 0) return ["Agents:     none with failproofai hooks"];
  return [
    "Agents:",
    ...hooked.map((r) => {
      let state: string;
      if (r.error) state = `unreadable (${r.error})`;
      else if (r.conflict) state = `another "${SELF_REPORT_SERVER_NAME}" MCP server is configured; left alone`;
      else if (r.registered && r.transport === "http") {
        const port = selfReportUrlPort(r.endpoint);
        const ok = port !== null && health.get(port) === true;
        const mine = ok && owned.get(port!) === true;
        state = `http   ${r.endpoint ?? "?"} ${mine ? "(answering)" : ok ? "(answering, but NOT this home's daemon)" : "(NOT answering)"}`;
      } else if (r.registered && r.transport === "extension") {
        state = "tool offered by failproofai's Pi extension (loaded with its hooks)";
      } else if (r.registered) {
        const ok = !!r.endpoint && selfReportCommandRunnable(r.endpoint);
        state = `stdio  ${r.endpoint ?? "?"} ${ok ? "(runnable)" : "(NOT runnable)"}`;
      } else state = r.hooked ? "not registered" : "registered, no hooks";
      if (r.registered && !r.hooked) state += ", no hooks";
      const line = `  ${r.agent.padEnd(12)} ${state}`;
      const pad = `  ${"".padEnd(12)} `;
      if (r.agent === "cursor" && r.registered) return [line, `${pad}${SELF_REPORT_CURSOR_APPROVAL_HINT}`];
      const recorder = recorders.get(r.agent);
      if (recorder && r.registered) {
        return recorder.recorder === "hook"
          ? [line, `${pad}reports recorded by its hook`]
          : [line, `${pad}reports recorded by the MCP server: ${recorder.reason}.`, `${pad}${recorder.fix}`];
      }
      return [line];
    }).flat(),
  ];
}

/**
 * Whether a row is registered over HTTP where it should not be: an endpoint
 * that is not answering, or that answers as some other home's daemon, or an
 * agent whose reports the server records (those belong on stdio, where the
 * server knows the caller's cwd; an older version registered them over HTTP).
 */
function selfReportStranded(
  r: SelfReportRegistration,
  health: ReadonlyMap<number, boolean>,
  owned: ReadonlyMap<number, boolean>,
  recorders: ReadonlyMap<string, SelfReportHookState> = new Map(),
): boolean {
  if (!r.registered || r.transport !== "http") return false;
  if (!selfReportHttpAllowed(r.agent)) return true;
  // The daemon's endpoint records nothing for Claude Code or Codex, so one
  // whose hook will not run (an untrusted Codex) would lose every report there.
  if (recorders.get(r.agent)?.recorder === "server") return true;
  const port = selfReportUrlPort(r.endpoint);
  return port === null || health.get(port) !== true || owned.get(port) !== true;
}

/** One agent's state, for every view of `status`. */
interface SelfReportAgentView {
  agent: string;
  path: string;
  hooked: boolean;
  registered: boolean;
  transport: SelfReportRegistration["transport"];
  endpoint: string | null;
  /** Registered and working: its endpoint answers as this home's daemon, or its command runs. */
  healthy: boolean;
  /** What is wrong, when something is, and the command that fixes it. */
  problem?: string;
  fix?: string;
  /** Claude Code / Codex: who records its reports, and why when it is the server. */
  recorder?: SelfReportHookState;
}

const SELF_REPORT_SYNC_FIX = "failproofai self-report sync";

function selfReportAgentViews(
  rows: readonly SelfReportRegistration[],
  health: ReadonlyMap<number, boolean>,
  owned: ReadonlyMap<number, boolean>,
  recorders: ReadonlyMap<string, SelfReportHookState>,
): SelfReportAgentView[] {
  const out: SelfReportAgentView[] = [];
  for (const r of rows.filter((x) => x.hooked || x.registered || x.conflict || x.error)) {
    const recorder = r.registered ? recorders.get(r.agent) : undefined;
    const view: SelfReportAgentView = {
      agent: r.agent, path: r.path, hooked: r.hooked, registered: r.registered,
      transport: r.transport, endpoint: r.endpoint, healthy: false,
      ...(recorder ? { recorder } : {}),
    };
    if (r.error) view.problem = `config unreadable (${r.error})`;
    else if (r.conflict) view.problem = `another "${SELF_REPORT_SERVER_NAME}" MCP server is configured; left alone`;
    else if (!r.registered) Object.assign(view, { problem: "not registered", fix: SELF_REPORT_SYNC_FIX });
    else if (r.transport === "http") {
      const port = selfReportUrlPort(r.endpoint);
      const ok = port !== null && health.get(port) === true;
      if (ok && owned.get(port!) === true) view.healthy = true;
      else Object.assign(view, { problem: ok ? "endpoint is another home's daemon" : "endpoint not answering", fix: SELF_REPORT_SYNC_FIX });
    } else if (r.transport === "extension") view.healthy = true;
    else if (r.endpoint && selfReportCommandRunnable(r.endpoint)) view.healthy = true;
    else Object.assign(view, { problem: "command not runnable", fix: SELF_REPORT_SYNC_FIX });
    out.push(view);
  }
  return out;
}

/** The lean view: a header, the healthy agents in one line, a line per problem. */
function selfReportLeanLines(header: string, views: readonly SelfReportAgentView[], repaired: string | null): string[] {
  const lines = [header];
  if (repaired) lines.push(repaired);
  const healthy = views.filter((v) => v.healthy).map((v) => v.agent).filter((a, i, all) => all.indexOf(a) === i);
  const problems = views.filter((v) => !v.healthy && v.problem);
  if (healthy.length > 0) lines.push(`Agents: ${healthy.join(", ")}`);
  else if (problems.length === 0) lines.push("Agents: none with failproofai hooks");
  for (const v of problems) lines.push(`▲ ${v.agent}: ${v.problem}${v.fix ? `  ·  \`${v.fix}\`` : ""}`);
  return lines;
}

async function selfReportStatus(args: string[], deps: SelfReportCliDeps): Promise<SelfReportCliResult> {
  const unknown = args.find((a) => a !== "--verbose" && a !== "-v" && a !== "--json");
  if (unknown) return { exitCode: 1, lines: [`Unexpected argument: ${unknown}.`] };
  const verbose = args.includes("--verbose") || args.includes("-v");
  const asJson = args.includes("--json");
  const file = readEffectiveSelfReport();
  const settings = resolveSelfReport();
  const cloud = await selfReportCloudManaged();
  const lines: string[] = [];
  if (!settings) {
    const missing = !file && !selfReportFileExists();
    // This machine's own file, set aside while the org's setting is awaited.
    const awaitingCloud = !!file && file.source !== "cloud" && selfReportCloudEnrolled();
    const why = awaitingCloud || (missing && selfReportCloudEnrolled()) ? "waiting" : missing ? "config" : "unreadable";
    if (asJson) {
      return {
        exitCode: 0,
        lines: [],
        json: {
          enabled: false,
          reason: why === "waiting" ? "waiting for Cloud" : why === "unreadable" ? "settings unreadable" : "off in config.json",
          settingsPath: selfReportSettingsFile(),
          managedByCloud: cloud,
        },
      };
    }
    if (!verbose) {
      lines.push(
        why === "waiting"
          ? "Self Reports: off · waiting for Cloud"
          : why === "unreadable"
            ? "Self Reports: off · settings file unreadable  ·  `failproofai self-report enable`"
            : "Self Reports: off · turned off in config.json",
      );
      return { exitCode: 0, lines };
    }
    lines.push(
      awaitingCloud
        ? "Self Reports: off (waiting for FailproofAI Cloud to send this machine's setting; this machine's own setting no longer applies)"
        : missing
        ? selfReportCloudEnrolled()
          ? "Self Reports: off (waiting for FailproofAI Cloud to send this machine's setting)"
          : "Self Reports: off (turned off in config.json)"
        : "Self Reports: off (the settings file cannot be read)",
    );
    lines.push(`Settings:   ${selfReportSettingsFile()}`);
    lines.push(cloud ? "Managed by: FailproofAI Cloud (Settings > Self Reports)" : "Turn on:    `failproofai self-report enable`");
    return { exitCode: 0, lines };
  }
  const source = settings.source === "cloud" ? "cloud" : file ? "local" : "default";
  const readRows = deps.registrations ?? (() => selfReportRegistrationStatus());
  let rows = readRows();
  let health = await selfReportHttpHealth(rows, deps);
  let owned = await selfReportHttpOwnership(health, deps);
  const recorders = new Map<string, SelfReportHookState>();
  for (const agent of SELF_REPORT_HOOK_RECORDED_AGENTS) {
    if (!rows.some((r) => r.agent === agent && (r.registered || r.hooked))) continue;
    try {
      const hooked = (a: string) => rows.some((r) => r.agent === a && r.hooked);
      recorders.set(agent, deps.hookState ? deps.hookState(agent) : selfReportHookState(agent, { userHooksInstalled: hooked }));
    } catch {
      // unknown: show nothing for it
    }
  }
  // An agent left on the daemon's HTTP endpoint after the daemon died would
  // have no report tool, and one on a port another home's daemon holds would
  // report into that home. Move it (live check: stdio unless this home's
  // daemon serves the endpoint).
  let repairedLines: string[] = [];
  let repaired: string | null = null;
  let repairedAgents: string[] = [];
  if (settings.enabled && !deps.skipSync && rows.some((r) => selfReportStranded(r, health, owned, recorders))) {
    try {
      const results = await (deps.sync ?? (() => syncSelfReportMcp({ quiet: true })))();
      if (selfReportSyncChanged(results)) {
        repairedAgents = results
          .filter((r) => r.action === "added" || r.action === "updated" || r.action === "removed")
          .map((r) => r.agent)
          .filter((a, i, all) => all.indexOf(a) === i);
        repaired = `✓ Re-synced ${repairedAgents.join(", ")}`;
        repairedLines = [
          "Repaired:   agents on an HTTP endpoint that is not this home's answering daemon, or that belong on stdio, were re-synced:",
          ...selfReportSyncLines(results).map((l) => `  ${l}`),
        ];
        rows = readRows();
        health = await selfReportHttpHealth(rows, deps);
        owned = await selfReportHttpOwnership(health, deps);
      }
    } catch {
      repaired = `▲ Could not re-sync agents whose HTTP endpoint is not answering  ·  \`${SELF_REPORT_SYNC_FIX}\``;
      repairedLines = [`▲ Could not re-sync agents whose HTTP endpoint is not answering. Run \`${SELF_REPORT_SYNC_FIX}\`.`];
    }
  }
  if (!health.has(settings.mcp.port)) {
    const probe = deps.probeEndpoint ?? ((_url: string, port: number) => probeSelfReportHttp(port));
    health.set(settings.mcp.port, await probe(settings.mcp.url, settings.mcp.port));
  }
  const daemonAnswering = health.get(settings.mcp.port) === true;
  const views = selfReportAgentViews(rows, health, owned, recorders);

  if (asJson) {
    return {
      exitCode: 0,
      lines: [],
      json: {
        enabled: settings.enabled,
        source,
        settingsPath: selfReportSettingsFile(),
        updatedAt: settings.updatedAt || null,
        categories: settings.categories.map((c) => c.name),
        guidance: settings.guidance,
        server: SELF_REPORT_SERVER_NAME,
        tool: SELF_REPORT_TOOL_NAME,
        daemon: { url: settings.mcp.url, answering: daemonAnswering },
        repaired: repairedAgents,
        agents: views.map((v) => ({
          agent: v.agent,
          path: v.path,
          hooked: v.hooked,
          registered: v.registered,
          transport: v.transport,
          endpoint: v.endpoint,
          healthy: v.healthy,
          problem: v.problem ?? null,
          fix: v.fix ?? null,
          recordedBy: v.recorder ? v.recorder.recorder : null,
        })),
      },
    };
  }

  if (!verbose) {
    const from = source === "cloud" ? "from Cloud" : source === "local" ? "this machine" : "default";
    const header = `Self Reports: ${settings.enabled ? "on" : "off"} · ${from}`;
    if (!settings.enabled) return { exitCode: 0, lines: [header] };
    return { exitCode: 0, lines: selfReportLeanLines(header, views, repaired) };
  }

  lines.push(`Self Reports: ${settings.enabled ? "on" : "off"}`);
  lines.push(
    `Source:     ${
      source === "cloud" ? "FailproofAI Cloud" : source === "local" ? "this machine (config.json)" : "the default (no settings file yet)"
    }`,
  );
  lines.push(`Settings:   ${selfReportSettingsFile()}`);
  lines.push(
    settings.source === "cloud"
      ? "Turn off:   in the dashboard, Settings > Self Reports"
      : settings.enabled
        ? "Turn off:   `failproofai self-report disable`"
        : "Turn on:    `failproofai self-report enable`",
  );
  if (settings.updatedAt) lines.push(`Updated:    ${settings.updatedAt}`);
  lines.push(`Categories: ${settings.categories.map((c) => c.name).join(", ")}`);
  lines.push(`MCP server: ${SELF_REPORT_SERVER_NAME} (tool \`${SELF_REPORT_TOOL_NAME}\`)`);
  if (settings.guidance) lines.push(`Guidance:   ${settings.guidance.length > 60 ? `${settings.guidance.slice(0, 57)}...` : settings.guidance}`);
  lines.push(...repairedLines);
  lines.push(selfReportDaemonLine(settings.mcp.url, daemonAnswering, deps));
  lines.push(...selfReportRegistrationLines(rows, health, owned, recorders));
  return { exitCode: 0, lines };
}

/**
 * The daemon's MCP endpoint, for `status`. "not answering" reads as a fault, so
 * it is shown only where a daemon is expected: one is configured (setup ran) or
 * its socket file is there. With neither, there is no daemon and agents use
 * stdio, which is a normal setup.
 */
function selfReportDaemonLine(url: string, answering: boolean, deps: SelfReportCliDeps): string {
  if (answering) return `Daemon MCP: ${url} (answering)`;
  const expected = deps.daemonExpected ?? (() => isDaemonConfigured() || daemonSocketPresent());
  if (expected()) return `Daemon MCP: ${url} (not answering)`;
  return "Daemon MCP: not running (agents use stdio)";
}

/**
 * Update every hooked agent's MCP entry to match the settings just written,
 * and say it in the one line enable and disable print.
 */
async function selfReportSyncLine(deps: SelfReportCliDeps, enabled: boolean): Promise<string> {
  const plain = enabled ? "✓ Self Reports: on" : "✓ Self Reports: off";
  if (deps.skipSync) return plain;
  try {
    const results = await (deps.sync ?? (() => syncSelfReportMcp({ quiet: true })))();
    const line = selfReportSummaryLine(results, enabled ? "on" : "off");
    return (line ?? plain).replace(/  ·  (failproofai .+)$/, "  ·  `$1`");
  } catch {
    return `▲ Self Reports: ${enabled ? "on" : "off"}; agents not updated  ·  \`${SELF_REPORT_SYNC_FIX}\``;
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
  writeEffectiveSelfReport({ enabled: true, categories, guidance });
  return { exitCode: 0, lines: [await selfReportSyncLine(deps, true)] };
}

async function selfReportDisable(args: string[], deps: SelfReportCliDeps): Promise<SelfReportCliResult> {
  if (args.length > 0) return { exitCode: 1, lines: [`Unexpected argument: ${args[0]}.`] };
  if (await selfReportCloudManaged()) return { exitCode: 1, lines: SELF_REPORT_CLOUD_REFUSAL };
  const previous = await readLocalSelfReportConfig();
  // The category list and guidance are kept, so turning it back on restores them.
  await writeLocalSelfReportConfig({ enabled: false, categories: previous?.categories, guidance: previous?.guidance });
  writeEffectiveSelfReport({ enabled: false, categories: previous?.categories, guidance: previous?.guidance });
  return { exitCode: 0, lines: [await selfReportSyncLine(deps, false)] };
}

const SELF_REPORT_TEST_DETAIL = "failproofai self-report test: this is a test report, not a real problem.";

/**
 * Whether a Claude Code or Codex session started in `cwd` would skip
 * failproofai's hook, so its report is the server's to record: Codex has not
 * trusted the hook (or has none of ours to run), or Claude Code has hooks off.
 * A Claude Code without user-scope hooks may still have them in the project,
 * so that alone does not count.
 */
function selfReportTestHookSkipped(agent: string, cwd: string, deps: SelfReportCliDeps): boolean {
  if (deps.hookState) return deps.hookState(agent).recorder === "server";
  return agent === "codex" ? !codexReportHookRuns(cwd) : claudeHooksBlockedReason(cwd) !== null;
}

async function selfReportTest(args: string[], deps: SelfReportCliDeps): Promise<SelfReportCliResult> {
  const agentFlag = selfReportFlag(args, "--agent");
  if (agentFlag.error || !agentFlag.value) {
    return { exitCode: 1, lines: ["Missing --agent <agent>.", `Agents: ${INTEGRATION_TYPES.join(", ")}`] };
  }
  const agent = agentFlag.value;
  if (!(INTEGRATION_TYPES as readonly string[]).includes(agent)) {
    return { exitCode: 1, lines: [`Not an agent: ${agent}.`, `Agents: ${INTEGRATION_TYPES.join(", ")}`] };
  }
  const settings = resolveSelfReport();
  if (!settings?.enabled) {
    return { exitCode: 1, lines: ["Self Reports is off, so there is nothing to test.", "Turn it on with `failproofai self-report enable`."] };
  }
  const category = settings.categories[0]?.name ?? SELF_REPORT_DEFAULT_CATEGORIES[0].name;
  const cwd = deps.cwd ?? process.cwd();
  const cli = selfReportCliCommand(deps);

  if (
    SELF_REPORT_SERVER_RECORDS.includes(agent) ||
    (SELF_REPORT_HOOK_RECORDED_AGENTS.includes(agent) && selfReportTestHookSkipped(agent, cwd, deps))
  ) {
    // This agent's hooks do not see MCP calls, or will not run (an untrusted
    // Codex): the MCP server records. Drive the stdio server as the agent would.
    const dir = customAgentsEventsDir();
    const stdin = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "failproofai-self-report-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "report", arguments: { category, detail: SELF_REPORT_TEST_DETAIL } } },
    ]
      .map((m) => JSON.stringify(m))
      .join("\n");
    const run = await selfReportRunChild([...cli, "mcp", "--agent", agent], `${stdin}\n`, 20_000, cwd, {
      [SELF_REPORT_RECEIPT_ENV]: "1",
    });
    const answered = run.stdout.includes(SELF_REPORT_RESULT_TEXT);
    // The server's receipt names the batch it published. The batch itself may
    // already be gone: a running collector uploads and deletes it, often
    // before this child has exited, so its absence proves nothing.
    const receipt = run.stderr
      .split("\n")
      .filter((l) => l.startsWith(SELF_REPORT_RECEIPT_PREFIX))
      .map((l) => l.slice(SELF_REPORT_RECEIPT_PREFIX.length).trim())
      .find((p) => dirname(p) === dir && p.endsWith(".jsonl"));
    if (!answered || !receipt) {
      const diagnostic = run.stderr
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith(SELF_REPORT_RECEIPT_PREFIX))
        .pop();
      return {
        exitCode: 1,
        lines: [
          `✕ The test report for ${agent} did not land.`,
          `  MCP server ${answered ? "answered Recorded., but recorded nothing" : "did not answer"}${diagnostic ? `: ${diagnostic.trim()}` : ""}`,
        ],
      };
    }
    const stillThere = selfReportListDir(dir).includes(basename(receipt));
    return {
      exitCode: 0,
      lines: [
        `✓ Test report from ${agent} recorded by the MCP server.`,
        stillThere
          ? `  Event file: ${receipt}`
          : `  Event file: ${receipt} (already picked up by the collector)`,
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

function selfReportFileExists(): boolean {
  try {
    readFileSync(selfReportSettingsFile());
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
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
        return await selfReportStatus(rest, deps);
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
